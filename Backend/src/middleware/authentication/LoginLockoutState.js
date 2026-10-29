"use strict";

/**
 * @fileoverview Primary-side, cluster-wide login-lockout store.
 *
 * Lives on the cluster primary (wired by `PrimaryStateServices`) so a failed
 * login counted by ANY worker counts for the whole cluster: the threshold is
 * `LOGIN_MAX_ATTEMPTS` per user, not `workers x LOGIN_MAX_ATTEMPTS`. Pure
 * Map + the shared `LoginLockoutPolicy` rules; no logger (the WORKER logs the
 * lines, so they keep the worker's [PID]), no I/O.
 *
 * Bounded (CWE-400): entries expire 24 h after their last write. At `maxKeys` a
 * NEW key first evicts expired entries, then the OLDEST entry that is not
 * currently locked (so a flood of bogus ids cannot freeze the store and push
 * everyone onto per-worker counting). Only when every entry is locked does
 * `fail` answer `{ fallback: true }` so the asking worker counts locally.
 *
 * Complexity: O(1) per call; at the cap the sweep/eviction scan is O(n) and runs
 * at most once per SWEEP_MIN_GAP_MS when it finds nothing evictable.
 *
 * @author senior-nodejs-engineer
 */

const { LoginLockoutPolicy } = require("./LoginLockoutPolicy");

const ENTRY_TTL_MS = 24 * 60 * 60 * 1000;
const SWEEP_MIN_GAP_MS = 1000;

class LoginLockoutState {
    /** @type {Map<string, {state: object, expiresAt: number}>} */
    #entries = new Map();
    #policy;
    #maxKeys;
    #lastSweep = -Infinity;

    /**
     * @param {object} [options]
     * @param {LoginLockoutPolicy} [options.policy] - default `LoginLockoutPolicy.fromEnv()`
     * @param {number} [options.maxKeys=100000]
     */
    constructor({ policy = LoginLockoutPolicy.fromEnv(), maxKeys = 100_000 } = {}) {
        this.#policy = policy;
        this.#maxKeys = maxKeys;
    }

    /** @returns {number} tracked users (diagnostics/tests) */
    get size() {
        return this.#entries.size;
    }

    /**
     * Read-only evaluation (an expired lock window is cleared as a side effect).
     *
     * @param {string} key - canonical user key
     * @param {number} now - epoch ms
     * @returns {{locked: boolean, retryAfter?: number, hrReset?: boolean}}
     */
    check(key, now) {
        const entry = this.#live(key, now);
        if (!entry) return { locked: false };
        const r = this.#policy.evaluate(entry.state, now);
        if (r.changed) this.#write(key, r.state, now);
        const out = { locked: r.locked };
        if (r.retryAfter !== undefined) out.retryAfter = r.retryAfter;
        if (r.hrReset) out.hrReset = true;
        return out;
    }

    /**
     * Counts one failed attempt.
     *
     * @param {string} key
     * @param {number} now
     * @returns {{failCount: number, currentMax: number, cycles: number, engaged: boolean, ignored: boolean, lockDurationMs: number|null}|{fallback: true}}
     *   `{fallback: true}` only when the store is full of locked entries
     */
    fail(key, now) {
        const entry = this.#live(key, now);
        if (!entry && this.#entries.size >= this.#maxKeys && !this.#makeRoom(now)) {
            return { fallback: true };
        }
        const base = entry ? entry.state : this.#policy.initial();
        const r = this.#policy.fail(base, now);
        if (!r.ignored) this.#write(key, r.state, now);
        return {
            failCount: r.failCount,
            currentMax: r.currentMax,
            cycles: r.cycles,
            engaged: r.engaged,
            ignored: r.ignored,
            lockDurationMs: r.lockDurationMs,
        };
    }

    /**
     * Clean slate after a successful login.
     *
     * @param {string} key
     */
    clear(key) {
        this.#entries.delete(key);
    }

    // ── Internals ────────────────────────────────────────────────────────────

    #live(key, now) {
        const entry = this.#entries.get(key);
        if (!entry) return null;
        if (entry.expiresAt <= now) {
            this.#entries.delete(key);
            return null;
        }
        return entry;
    }

    #write(key, state, now) {
        // delete first so Map order tracks last write (oldest-first eviction).
        this.#entries.delete(key);
        this.#entries.set(key, { state, expiresAt: now + ENTRY_TTL_MS });
    }

    /**
     * Frees one slot: expired entries first, else the oldest not-locked entry.
     * A scan that found everything locked is not repeated within SWEEP_MIN_GAP_MS.
     *
     * @returns {boolean} true when a slot is free
     */
    #makeRoom(now) {
        if (now - this.#lastSweep < SWEEP_MIN_GAP_MS) return false;
        for (const [k, e] of this.#entries) {
            if (e.expiresAt <= now) this.#entries.delete(k);
        }
        if (this.#entries.size < this.#maxKeys) return true;
        for (const [k, e] of this.#entries) {
            const r = this.#policy.evaluate(e.state, now);
            if (!r.locked && !r.hrReset) {
                this.#entries.delete(k);
                return true;
            }
        }
        this.#lastSweep = now; // everything locked: do not rescan every call
        return false;
    }
}

module.exports = { LoginLockoutState };
