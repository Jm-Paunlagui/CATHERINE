"use strict";

/**
 * @fileoverview ClusterCacheSync — cross-worker cache invalidation over the
 * Node.js cluster IPC channel.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every CacheStore wraps an in-process NodeCache instance. With
 * ENABLE_CLUSTERING=true each worker holds its OWN copy of every store, so an
 * invalidation triggered by a write handled on worker 1 (e.g. a feature save
 * wiping its cache namespace) would leave workers 2..N serving STALE data
 * until the TTL expired — up to 30 minutes for long-TTL stores. For a
 * financial system that is a correctness bug, not a performance trade-off.
 *
 * HOW IT WORKS
 * ------------
 *   1. Worker performs a local invalidation (del / delByPattern / flush).
 *      CacheStore calls ClusterCacheSync.broadcast() after applying it locally.
 *   2. broadcast() sends { ch, store, op, arg } to the primary process via
 *      process.send(). No-op when clustering is off (process.send undefined
 *      or not a worker) — zero overhead in single-process mode.
 *   3. The primary (initPrimary(), wired in server.js) relays the message to
 *      every OTHER worker.
 *   4. Each worker (initWorker(), wired in app.js) applies the operation to
 *      its local store with the `_applyingRemote` re-entrancy guard set, so
 *      the remote application never re-broadcasts (no message storms).
 *
 * WHAT IS SYNCED — invalidations only
 * -----------------------------------
 *   del            → replayed as-is (exact keys)
 *   delByPattern   → replayed as-is (substring pattern)
 *   flush          → replayed as-is
 *   delWhere       → replayed as a FLUSH of the store. Predicates cannot
 *                    cross process boundaries; over-invalidation is safe
 *                    (a cold read), under-invalidation is not (stale data).
 *
 * Cache POPULATION (set / getOrSet) is intentionally NOT synced — each worker
 * fills its own cache from its own reads. Only staleness is dangerous.
 */

const cluster = require("cluster");
const { logger } = require("../../utils/logger");
const { cacheMessages } = require("../../constants/messages");

/** IPC envelope discriminator — namespaced to avoid colliding with other IPC users. */
const CHANNEL = "app:cache-sync";

/**
 * @class ClusterCacheSync
 * @description Static coordinator for cross-worker cache invalidation.
 * Holds one piece of state: the re-entrancy guard used while applying a
 * remote operation. The `_cluster` / `_send` indirections exist so unit tests
 * can substitute fakes without touching the real cluster module.
 */
class ClusterCacheSync {
    /** Injectable cluster module reference (substituted in unit tests). */
    static _cluster = cluster;

    /** Injectable sender (defaults to process.send when available). */
    static _send = (msg) => process.send(msg);

    /**
     * Injectable IPC-availability predicate (substituted in unit tests).
     * In production an IPC channel exists only in forked cluster workers,
     * where process.send is a function.
     */
    static _canSend = () => typeof process.send === "function";

    /** True while a remote operation is being applied locally — suppresses re-broadcast. */
    static _applyingRemote = false;

    /** The IPC channel discriminator (exposed for tests). */
    static get CHANNEL() {
        return CHANNEL;
    }

    /** True when running as a cluster worker with an IPC channel. */
    static get isWorker() {
        return (
            ClusterCacheSync._cluster.isWorker === true &&
            ClusterCacheSync._canSend()
        );
    }

    /**
     * Broadcasts a local invalidation to the other workers (via the primary).
     * Called by CacheStore after every local del / delByPattern / flush.
     * No-op outside cluster workers and while applying a remote operation.
     *
     * Fire-and-forget: IPC failures are swallowed (the worst case is one
     * worker serving stale data until TTL — the same as without sync).
     *
     * @param {string} storeName - Registry name of the store
     * @param {'del'|'delByPattern'|'flush'} op
     * @param {string|string[]} [arg] - Keys (del) or pattern (delByPattern)
     * @returns {void}
     */
    static broadcast(storeName, op, arg) {
        if (!ClusterCacheSync.isWorker) return;
        if (ClusterCacheSync._applyingRemote) return;
        try {
            ClusterCacheSync._send({
                ch: CHANNEL,
                store: storeName,
                op,
                arg: arg ?? null,
            });
        } catch {
            // IPC channel closed (e.g. mid-shutdown) — stale-until-TTL fallback.
        }
    }

    /**
     * Applies a relayed invalidation to the local registry. Exposed separately
     * from initWorker so it is directly unit-testable.
     *
     * @param {import('./CacheRegistry').CacheRegistry} registry
     * @param {{ ch: string, store: string, op: string, arg: * }} msg
     * @returns {boolean} true when the message was a cache-sync op and applied
     */
    static applyRemote(registry, msg) {
        if (!msg || msg.ch !== CHANNEL) return false;

        let store;
        try {
            store = registry.resolve(msg.store);
        } catch {
            // Store not registered in this worker (should not happen — all
            // workers run the same app.js) — ignore rather than crash.
            return false;
        }

        ClusterCacheSync._applyingRemote = true;
        try {
            if (msg.op === "flush") {
                store.flush();
            } else if (msg.op === "del") {
                store.del(msg.arg);
            } else if (msg.op === "delByPattern") {
                store.delByPattern(msg.arg);
            } else {
                return false;
            }
            logger.debug(
                cacheMessages.CACHE_CLUSTER_SYNC_APPLIED(
                    msg.store,
                    msg.op,
                    msg.arg,
                ),
            );
            return true;
        } finally {
            ClusterCacheSync._applyingRemote = false;
        }
    }

    /**
     * Worker-side wiring: listens for relayed invalidations from the primary
     * and applies them locally. Call once at startup (app.js) after the cache
     * registry is populated. No-op when clustering is off.
     *
     * @param {import('./CacheRegistry').CacheRegistry} registry
     * @returns {boolean} true when the listener was installed
     */
    static initWorker(registry) {
        if (!ClusterCacheSync.isWorker) return false;
        process.on("message", (msg) =>
            ClusterCacheSync.applyRemote(registry, msg),
        );
        logger.notice(cacheMessages.CACHE_CLUSTER_SYNC_WORKER_READY());
        return true;
    }

    /**
     * Primary-side wiring: relays every cache-sync message from one worker to
     * all OTHER workers. Call once in the primary branch of server.js.
     *
     * @returns {void}
     */
    static initPrimary() {
        const c = ClusterCacheSync._cluster;
        c.on("message", (worker, msg) => {
            if (!msg || msg.ch !== CHANNEL) return;
            for (const id of Object.keys(c.workers ?? {})) {
                const w = c.workers[id];
                if (!w || w.id === worker.id) continue;
                try {
                    w.send(msg);
                } catch {
                    // Worker died mid-relay — its replacement starts cold.
                }
            }
        });
        logger.notice(cacheMessages.CACHE_CLUSTER_SYNC_PRIMARY_READY());
    }
}

module.exports = { ClusterCacheSync };
