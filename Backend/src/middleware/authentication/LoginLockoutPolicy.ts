"use strict";

/**
 * @fileoverview Pure login-lockout arithmetic.
 *
 * The decision logic of the per-user lockout, separated from WHERE the state
 * lives so the SAME rules run in two places:
 *   - `LoginLockoutMiddleware` (per-worker CacheStore; single-process mode and
 *     the cluster fallback), and
 *   - `LoginLockoutState` on the cluster primary (the shared, cluster-wide
 *     counters - the fix for "effective threshold = workers x max").
 *
 * Holds the resolved configuration, hence a class. No I/O, no logger, no clock
 * of its own: `now` is always passed in. Every method is O(1).
 *
 * State shape:
 *   { cycles: number, currentMax: number, failCount: number, lockUntil: number|null }
 *
 * Race fix (CWE-307): `fail()` ignores a failure that arrives while the account
 * is ALREADY locked. Concurrent in-flight attempts that passed `check()` before
 * the lock engaged used to push `failCount` past the threshold and, worse,
 * engage a SECOND lock cycle (burning a retry cycle toward the permanent HR
 * reset). They are now refused/ignored with the state left unchanged.
 *
 * @author senior-nodejs-engineer
 */

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_LOCKOUT_MODE = "incremental"; // 'fixed' | 'incremental'
const DEFAULT_LOCKOUT_DURATION_MS = 30_000; // 30 s
const DEFAULT_LOCKOUT_MULTIPLIER = 2;
const DEFAULT_MAX_LOCKOUT_CYCLES = 3;
const DEFAULT_RETRY_DECREMENT = 1;

class LoginLockoutPolicy {
    /**
     * Each option falls back to its LOGIN_* environment variable, then to the
     * default (read once, at construction).
     *
     * @param {object} [options]
     * @param {number} [options.maxAttempts]       - LOGIN_MAX_ATTEMPTS. Default 3.
     * @param {string} [options.lockoutMode]       - LOGIN_LOCKOUT_MODE 'fixed' | 'incremental'. Default 'incremental'.
     * @param {number} [options.lockoutDurationMs] - LOGIN_LOCKOUT_DURATION_MS. Default 30000.
     * @param {number} [options.lockoutMultiplier] - LOGIN_LOCKOUT_MULTIPLIER. Default 2.
     * @param {number} [options.maxLockoutCycles]  - LOGIN_MAX_LOCKOUT_CYCLES. Default 3.
     * @param {number} [options.retryDecrement]    - LOGIN_RETRY_DECREMENT. Default 1.
     */
    constructor(options = {}) {
        this.maxAttempts =
            options.maxAttempts ??
            parseInt(process.env.LOGIN_MAX_ATTEMPTS || String(DEFAULT_MAX_ATTEMPTS), 10);
        this.lockoutMode =
            options.lockoutMode ?? (process.env.LOGIN_LOCKOUT_MODE || DEFAULT_LOCKOUT_MODE);
        this.lockoutDurationMs =
            options.lockoutDurationMs ??
            parseInt(process.env.LOGIN_LOCKOUT_DURATION_MS || String(DEFAULT_LOCKOUT_DURATION_MS), 10);
        this.lockoutMultiplier =
            options.lockoutMultiplier ??
            parseFloat(process.env.LOGIN_LOCKOUT_MULTIPLIER || String(DEFAULT_LOCKOUT_MULTIPLIER));
        this.maxLockoutCycles =
            options.maxLockoutCycles ??
            parseInt(process.env.LOGIN_MAX_LOCKOUT_CYCLES || String(DEFAULT_MAX_LOCKOUT_CYCLES), 10);
        this.retryDecrement =
            options.retryDecrement ??
            parseInt(process.env.LOGIN_RETRY_DECREMENT || String(DEFAULT_RETRY_DECREMENT), 10);
    }

    /**
     * Policy read purely from the environment (what every worker and the
     * primary resolve identically).
     *
     * @returns {LoginLockoutPolicy}
     */
    static fromEnv() {
        return new LoginLockoutPolicy();
    }

    /**
     * A fresh, never-failed state.
     *
     * @returns {{cycles: number, currentMax: number, failCount: number, lockUntil: number|null}}
     */
    initial() {
        return {
            cycles: 0,
            currentMax: this.maxAttempts,
            failCount: 0,
            lockUntil: null,
        };
    }

    /**
     * Evaluates `state` at `now` WITHOUT counting anything. An expired lock
     * window is cleared on the returned state (`changed: true` tells the caller
     * to persist it).
     *
     * @param {object} state
     * @param {number} now - epoch ms
     * @returns {{state: object, changed: boolean, locked: boolean, retryAfter?: number, hrReset?: boolean}}
     */
    evaluate(state, now) {
        if (state.lockUntil && now < state.lockUntil) {
            return {
                state,
                changed: false,
                locked: true,
                retryAfter: Math.ceil((state.lockUntil - now) / 1000),
            };
        }

        let next = state;
        let changed = false;
        if (state.lockUntil && now >= state.lockUntil) {
            next = { ...state, lockUntil: null, failCount: 0 };
            changed = true;
        }

        if (next.cycles >= this.maxLockoutCycles) {
            return { state: next, changed, locked: false, hrReset: true };
        }
        return { state: next, changed, locked: false };
    }

    /**
     * Counts one failed attempt at `now`; engages a lockout when `failCount`
     * reaches `currentMax`. A failure arriving while the account is already
     * locked is IGNORED and the state is returned unchanged (race fix).
     *
     * `failCount` / `currentMax` in the result are the values AT THE MOMENT OF
     * the failure (before an engaged lock resets/decrements them) - what the
     * "Failed login attempt (n/max)" log line shows.
     *
     * @param {object} state
     * @param {number} now - epoch ms
     * @returns {{state: object, failCount: number, currentMax: number, cycles: number, engaged: boolean, ignored: boolean, lockDurationMs: number|null}}
     */
    fail(state, now) {
        if (state.lockUntil && now < state.lockUntil) {
            return {
                state,
                failCount: state.failCount,
                currentMax: state.currentMax,
                cycles: state.cycles,
                engaged: false,
                ignored: true,
                lockDurationMs: null,
            };
        }

        const next = { ...state };
        // Clear any expired lockout first
        if (next.lockUntil && now >= next.lockUntil) {
            next.lockUntil = null;
            next.failCount = 0;
        }

        next.failCount += 1;
        const failCount = next.failCount;
        const currentMax = next.currentMax;

        let engaged = false;
        let lockDurationMs = null;
        if (next.failCount >= next.currentMax) {
            next.cycles += 1;
            lockDurationMs =
                this.lockoutMode === "fixed"
                    ? this.lockoutDurationMs
                    : this.lockoutDurationMs * Math.pow(this.lockoutMultiplier, next.cycles - 1);
            next.lockUntil = now + lockDurationMs;
            next.currentMax = Math.max(1, next.currentMax - this.retryDecrement);
            next.failCount = 0;
            engaged = true;
        }

        return {
            state: next,
            failCount,
            currentMax,
            cycles: next.cycles,
            engaged,
            ignored: false,
            lockDurationMs,
        };
    }
}

module.exports = { LoginLockoutPolicy };
