"use strict";

/**
 * @fileoverview Primary-side owner of the cluster shared state: rate-limit
 * counters, security-filter strikes/blocks, login lockout, session revocations
 * and the scheduler snapshot copy. `attach(hub)` registers the RPC handlers and
 * the sync-on-listening / release-on-exit hooks.
 *
 * Holds state, so a class. Pure data structures live in their own classes
 * (`SlidingWindowCounter`, `SuspiciousIpTracker`).
 *
 * @author senior-nodejs-engineer
 */

const {
    CLUSTER_RPC_METHODS,
    CLUSTER_TOPICS,
    CLUSTER_RPC_LIMITS,
} = require("../../constants/clusterIpc");
const { clusterMessages } = require("../../constants/messages/cluster.messages");
const { SlidingWindowCounter } = require("../../middleware/security/SlidingWindowCounter");
const { SuspiciousIpTracker } = require("../../middleware/security/SuspiciousIpTracker");
const { LoginLockoutPolicy } = require("../../middleware/authentication/LoginLockoutPolicy");
const { LoginLockoutState } = require("../../middleware/authentication/LoginLockoutState");
const { middlewareMessages } = require("../../constants/messages/middleware.messages");
const { RevokedSessionSet } = require("../auth/RevokedSessionSet");
const { ACCESS_REVOCATION_LIMITS } = require("../../constants/authTokens");

const M = CLUSTER_RPC_METHODS;
const TOPIC = CLUSTER_TOPICS;

/**
 * @class PrimaryStateServices
 */
class PrimaryStateServices {
    /**
     * @param {object} deps
     * @param {object} deps.logger
     * @param {() => number} [deps.now=Date.now]
     * @param {LoginLockoutPolicy} [deps.lockoutPolicy] - default `LoginLockoutPolicy.fromEnv()`
     */
    constructor({ logger, now = Date.now, lockoutPolicy = LoginLockoutPolicy.fromEnv() }) {
        this._logger = logger;
        this._now = now;
        this._lastStoreFullLog = -Infinity;
        /** @type {Map<string, object>} job -> latest outcome (`at` as ISO string) */
        this._sched = new Map();
        this._ipTracker = new SuspiciousIpTracker();
        this._lockout = new LoginLockoutState({
            policy: lockoutPolicy,
            maxKeys: CLUSTER_RPC_LIMITS.MAX_LOCKOUT_KEYS,
        });
        /** @type {Map<string, SlidingWindowCounter>} `${label}|${windowMs}` -> counter */
        this._counters = new Map();
        /** Ended session families, replayed to a worker that starts later. */
        this._revoked = new RevokedSessionSet({ now });
    }

    /**
     * Registers every primary-side method and hook on the hub.
     *
     * @param {import("./ClusterRpcHub").ClusterRpcHub} hub
     */
    attach(hub) {
        this._hub = hub;
        this.#attachScheduler(hub);
        this.#attachSecurityFilter(hub);
        this.#attachRateLimiter(hub);
        this.#attachLoginLockout(hub);
        this.#attachRecipients(hub);
        this.#attachAccessRevocation(hub);
    }

    // ── Access-token revocation ──────────────────────────────────────────────

    /**
     * A worker ended some session families: keep a copy (for workers that start
     * later) and fan the entries out to every other live worker.
     */
    #attachAccessRevocation(hub) {
        hub.register(M.AUTH_REVOKE, ({ entries }, { worker }) => {
            for (const { fid, untilMs } of entries) this._revoked.revoke(fid, untilMs);
            hub.broadcast(TOPIC.AUTH_REVOKED, { entries }, { exceptId: worker.id });
            return null;
        });
        hub.addListeningHook((worker) => {
            const entries = this._revoked.snapshot(this._now(), ACCESS_REVOCATION_LIMITS.MAX_SYNC_ENTRIES);
            if (entries.length > 0) hub.sendTo(worker, TOPIC.AUTH_SYNC, { entries });
        });
    }

    // ── Recipient cache ──────────────────────────────────────────────────────

    #attachRecipients(hub) {
        hub.register(M.RECIPIENTS_INVALIDATE, (_args, { worker }) => {
            hub.broadcast(TOPIC.RECIPIENTS_INVALIDATE, {}, { exceptId: worker.id });
            return null;
        });
    }

    // ── Rate limiter ─────────────────────────────────────────────────────────

    #attachRateLimiter(hub) {
        hub.register(M.RL_HIT, ({ label, key, max, windowMs }) => {
            const id = `${label}|${windowMs}`;
            let counter = this._counters.get(id);
            if (!counter) {
                // At the counter cap the worker counts locally instead (fallback).
                if (this._counters.size >= CLUSTER_RPC_LIMITS.MAX_RL_COUNTERS) return { fallback: true };
                counter = new SlidingWindowCounter({ maxKeys: CLUSTER_RPC_LIMITS.MAX_RL_KEYS_PER_COUNTER });
                this._counters.set(id, counter);
            }
            try {
                return counter.hit(key, max, windowMs, this._now());
            } catch {
                // Key cap reached: fail open to the worker's local count.
                return { fallback: true };
            }
        });
        hub.register(M.RL_REFUND, ({ label, key, windowMs, bucket }) => {
            const counter = this._counters.get(`${label}|${windowMs}`);
            if (counter) counter.refund(key, bucket, windowMs, this._now());
            return null;
        });
        hub.register(M.RL_CLEAR, ({ label, key }) => {
            for (const [id, counter] of this._counters) {
                if (!id.startsWith(`${label}|`)) continue;
                if (key === null) counter.flushAll();
                else counter.del(key);
            }
            return null;
        });
    }

    // ── Login lockout ────────────────────────────────────────────────────────

    /**
     * Cluster-wide per-user login lockout. The primary is the single
     * writer, so a failure counted by any worker counts for all of them. At the
     * key cap the call answers `{ fallback: true }` and the asking worker counts
     * locally (fail open to today's per-worker behaviour, never a refusal).
     */
    #attachLoginLockout(hub) {
        hub.register(M.LOCKOUT_CHECK, ({ key }) => {
            try {
                return this._lockout.check(key, this._now());
            } catch {
                return { fallback: true };
            }
        });
        hub.register(M.LOCKOUT_FAIL, ({ key }) => {
            try {
                const r = this._lockout.fail(key, this._now());
                if (r.fallback === true) this.#logStoreFull();
                return r;
            } catch {
                return { fallback: true };
            }
        });
        hub.register(M.LOCKOUT_CLEAR, ({ key }) => {
            this._lockout.clear(key);
            return null;
        });
    }

    /** Store full of LOCKED entries: error-level CLUSTER_LOCKOUT_FALLBACK, throttled. */
    #logStoreFull() {
        const now = this._now();
        if (now - this._lastStoreFullLog < CLUSTER_RPC_LIMITS.REJECT_LOG_GAP_MS) return;
        this._lastStoreFullLog = now;
        this._logger.error(clusterMessages.CLUSTER_LOCKOUT_FALLBACK("store-full"));
    }

    // ── Security filter ──────────────────────────────────────────────────────

    #attachSecurityFilter(hub) {
        hub.register(M.SF_STRIKE, ({ ip }) => {
            const r = this._ipTracker.strike(ip, this._now());
            if (r.justBlocked) hub.broadcast(TOPIC.SF_BLOCK, { ip, blockedUntil: r.blockedUntil });
            return null;
        });
        hub.register(M.SF_UNBLOCK, ({ ip, actor }) => {
            const cleared = this._ipTracker.unblock(ip);
            if (cleared) this._logger.notice(middlewareMessages.SUSPICIOUS_IP_UNBLOCKED(ip, actor ?? "system"));
            hub.broadcast(TOPIC.SF_UNBLOCKED, { ip });
            return { cleared };
        });
        hub.addListeningHook((worker) => {
            const blocks = this._ipTracker.blocksSnapshot(this._now(), CLUSTER_RPC_LIMITS.SF_SYNC_MAX_ENTRIES);
            if (blocks.length > 0) hub.sendTo(worker, TOPIC.SF_SYNC, { blocks });
        });
    }

    // ── Scheduler state ──────────────────────────────────────────────────────

    #attachScheduler(hub) {
        hub.register(M.SCHED_RECORD, ({ job, outcome }, { worker }) => {
            this._sched.set(job, outcome);
            hub.broadcast(TOPIC.SCHED_STATE, { job, outcome }, { exceptId: worker.id });
            return null;
        });
        hub.addListeningHook((worker) => {
            if (this._sched.size === 0) return;
            hub.sendTo(worker, TOPIC.SCHED_SYNC, { state: Object.fromEntries(this._sched) });
        });
    }
}

module.exports = { PrimaryStateServices };
