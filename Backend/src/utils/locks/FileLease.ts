"use strict";

/**
 * @fileoverview FileLease — cross-process exclusive lease backed by one file.
 *
 * WHAT IT DOES
 *   Lets several Node worker processes on ONE host (cluster workers sharing a
 *   directory) run a critical section one at a time. Used by
 *   BackupStoreService to stop two workers forking the backup chain.
 *
 * HOW IT WORKS
 *   - acquire: `open(path, "wx")` (atomic create-exclusive) and write
 *     `{ pid, hostname, token, acquiredAt }`.
 *   - heartbeat (holder): every `heartbeatMs` (unref'd) the file mtime is
 *     bumped ONLY if the holder's ProgressScope progressed since the last
 *     bump. mtime therefore means "holder is making progress", not "holder
 *     process is alive" — a hung holder stops bumping and becomes stealable.
 *   - waiter: polls every `pollMs`. Whenever the holder's mtime advances it
 *     touches its OWN scope ("lease-wait"), so a request waiting behind a
 *     progressing holder is not cut by its own watchdog (follower semantics).
 *   - stale = (same hostname AND holder pid is dead, ESRCH) OR (mtime older
 *     than `staleMs`). `staleMs` must exceed the holder's idle limit so a
 *     live, progressing holder is never stolen from — its own watchdog
 *     cancels it first.
 *   - steal: `rename(lease -> lease.stale-<rand>)` then retry `wx`. The loser
 *     of a steal race gets ENOENT/EEXIST and keeps polling. If the moved
 *     file's token is not the stale one we observed (a racing stealer had
 *     already replaced it) it is linked back.
 *   - release: reads the file and unlinks it ONLY if the token matches.
 *
 * LIMITS
 *   Single host only (pid liveness and shared dir assumptions). Not a
 *   network-filesystem lock. A steal race can, in a vanishingly small window,
 *   take a fresh lease, so two PROCESSES can briefly both believe they hold
 *   it. The in-process mutex in BackupStoreService does NOT help here - it
 *   only serialises callers inside one process and is invisible to a sibling
 *   worker. What limits the damage: the victim's release is token-checked (it
 *   never unlinks the new holder's file), `_beat` re-reads the token before
 *   bumping mtime (a losing holder never keeps the new holder's lease
 *   "fresh"), and the holder forces an index reload inside the lease. The
 *   residual window (steal -> next read) is accepted, not eliminated.
 *
 * Security: CWE-22 (name must be a plain filename; dir is supplied by the
 * caller already resolved), CWE-367 (atomic wx / rename instead of
 * check-then-create). Complexity: O(1) per poll.
 */

const fsPromises = require("fs").promises;
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const { logger } = require("../logger");
const { dataBackupMessages } = require("../../constants/messages");
const { currentScope } = require("../progress/progress");

const DEFAULT_POLL_MS = 1000;
const DEFAULT_HEARTBEAT_MS = 10_000;
const NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

class FileLease {
    /**
     * @param {object} options
     * @param {string} options.dir - Already-resolved directory that holds the lease file.
     * @param {string} options.name - Plain lease filename (no path separators).
     * @param {number} options.staleMs - mtime age after which a lease is stale.
     * @param {import("../progress/ProgressScope").ProgressScope|null} [options.scope] - Scope whose progress is advertised / that is touched while waiting (default: ambient scope).
     * @param {number} [options.pollMs=1000]
     * @param {number} [options.heartbeatMs=10000]
     */
    constructor({
        dir,
        name,
        staleMs,
        scope = null,
        pollMs = DEFAULT_POLL_MS,
        heartbeatMs = DEFAULT_HEARTBEAT_MS,
    }) {
        if (
            typeof name !== "string" ||
            !NAME_PATTERN.test(name) ||
            name.includes("..")
        ) {
            throw new Error("FileLease: name must be a plain filename.");
        }
        if (typeof dir !== "string" || dir.length === 0) {
            throw new Error("FileLease: dir is required.");
        }
        this._dir = dir;
        this._name = name;
        this._path = path.join(dir, name);
        this._staleMs = staleMs;
        this._scope = scope;
        this._pollMs = pollMs;
        this._heartbeatMs = heartbeatMs;
        this._token = null;
        this._timer = null;
        this._lastBeatProgressAt = 0;
    }

    /** @returns {string} Absolute lease file path. */
    get path() {
        return this._path;
    }

    /** @returns {boolean} True while this instance holds the lease. */
    get held() {
        return this._token !== null;
    }

    /**
     * Point the heartbeat / waiter-touch at a different scope (the guarded
     * work scope is created after the lease is taken).
     * @param {import("../progress/ProgressScope").ProgressScope|null} scope
     */
    bindScope(scope) {
        this._scope = scope;
        this._lastBeatProgressAt = 0;
    }

    /**
     * Block until the lease is held. Throws the scope's abort error if the
     * waiting scope is aborted.
     * @returns {Promise<void>}
     */
    async acquire() {
        const waitScope = this._scope ?? currentScope() ?? null;
        let lastMtime = null;
        let announced = false;

        for (;;) {
            waitScope?.throwIfAborted();
            if (await this._tryCreate()) {
                this._startHeartbeat();
                return;
            }

            let stat;
            try {
                stat = await fsPromises.stat(this._path);
            } catch (err) {
                if (err.code === "ENOENT") continue; // freed between create and stat
                throw err;
            }

            const info = await this._readInfo();
            if (this._isStale(stat, info)) {
                if (await this._steal(info)) continue;
            } else {
                if (lastMtime !== null && stat.mtimeMs > lastMtime) {
                    waitScope?.touch("lease-wait");
                }
                if (!announced) {
                    announced = true;
                    logger.info(
                        dataBackupMessages.BACKUP_LEASE_WAITING(
                            this._name,
                            info?.pid ?? null,
                        ),
                    );
                }
            }
            lastMtime = stat.mtimeMs;
            await new Promise((r) => setTimeout(r, this._pollMs));
        }
    }

    /**
     * Release the lease. Unlinks the file only if it still carries OUR token.
     * Idempotent.
     * @returns {Promise<void>}
     */
    async release() {
        this._stopHeartbeat();
        const token = this._token;
        this._token = null;
        if (!token) return;
        const info = await this._readInfo();
        if (info?.token !== token) return;
        try {
            await fsPromises.unlink(this._path);
        } catch (err) {
            if (err.code !== "ENOENT") throw err;
        }
    }

    /**
     * acquire -> fn(lease) -> release (always).
     * @template T
     * @param {ConstructorParameters<typeof FileLease>[0]} options
     * @param {(lease: FileLease) => Promise<T>} fn
     * @returns {Promise<T>}
     */
    static async withLease(options, fn) {
        const lease = new FileLease(options);
        await lease.acquire();
        try {
            return await fn(lease);
        } finally {
            await lease.release();
        }
    }

    // ── internals ────────────────────────────────────────────────────────────

    /** @returns {Promise<boolean>} true if we created the file. */
    async _tryCreate() {
        const token = crypto.randomBytes(16).toString("hex");
        let handle;
        try {
            handle = await fsPromises.open(this._path, "wx");
        } catch (err) {
            if (err.code === "EEXIST") return false;
            throw err;
        }
        try {
            await handle.writeFile(
                JSON.stringify({
                    pid: process.pid,
                    hostname: os.hostname(),
                    token,
                    acquiredAt: new Date().toISOString(),
                }),
            );
        } catch (err) {
            await handle.close().catch(() => {});
            await fsPromises.unlink(this._path).catch(() => {});
            throw err;
        }
        await handle.close();
        this._token = token;
        return true;
    }

    /** @returns {Promise<object|null>} Parsed lease body, null if missing/unreadable. */
    async _readInfo() {
        try {
            return JSON.parse(await fsPromises.readFile(this._path, "utf8"));
        } catch {
            return null;
        }
    }

    /**
     * @param {import("fs").Stats} stat
     * @param {object|null} info
     * @returns {boolean}
     */
    _isStale(stat, info) {
        if (Date.now() - stat.mtimeMs > this._staleMs) return true;
        if (
            info &&
            info.hostname === os.hostname() &&
            Number.isInteger(info.pid) &&
            info.pid !== process.pid
        ) {
            try {
                process.kill(info.pid, 0);
            } catch (err) {
                if (err.code === "ESRCH") return true;
            }
        }
        return false;
    }

    /**
     * rename-then-retry steal.
     * @param {object|null} observed - Lease body seen when judged stale.
     * @returns {Promise<boolean>} true if WE removed the stale lease.
     */
    async _steal(observed) {
        const graveyard = `${this._path}.stale-${crypto.randomBytes(4).toString("hex")}`;
        try {
            await fsPromises.rename(this._path, graveyard);
        } catch (err) {
            if (err.code === "ENOENT") return false; // someone else stole first
            throw err;
        }
        const moved = await fsPromises
            .readFile(graveyard, "utf8")
            .then(JSON.parse)
            .catch(() => null);
        if (observed?.token && moved?.token && moved.token !== observed.token) {
            // Took a fresh lease a racing stealer had just created — put it back.
            try {
                await fsPromises.link(graveyard, this._path);
            } catch {
                /* path already re-taken; the victim's release is token-checked */
            }
            await fsPromises.unlink(graveyard).catch(() => {});
            return false;
        }
        await fsPromises.unlink(graveyard).catch(() => {});
        logger.warning(
            dataBackupMessages.BACKUP_LEASE_STOLEN(
                this._name,
                observed?.pid ?? null,
                observed?.hostname ?? null,
            ),
        );
        return true;
    }

    _startHeartbeat() {
        this._stopHeartbeat();
        this._timer = setInterval(() => {
            this._beat().catch(() => {});
        }, this._heartbeatMs);
        this._timer.unref?.();
    }

    _stopHeartbeat() {
        if (this._timer) clearInterval(this._timer);
        this._timer = null;
    }

    /** Bump mtime only if the bound scope progressed since the last bump. */
    async _beat() {
        if (!this._token) return;
        const scope = this._scope;
        if (scope) {
            const at = scope.lastProgressAt;
            if (at <= this._lastBeatProgressAt) return;
            this._lastBeatProgressAt = at;
        }
        // The lease may have been stolen from us (stale judgement raced our
        // heartbeat): never bump a file that now carries someone else's token.
        const info = await this._readInfo();
        if (!this._token || info?.token !== this._token) return;
        const now = new Date();
        await fsPromises.utimes(this._path, now, now);
    }
}

module.exports = { FileLease };
