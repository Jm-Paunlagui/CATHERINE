"use strict";

/**
 * @fileoverview ProgressScope — "is this unit of work still making progress?"
 *
 * WHAT IT DOES
 *   One scope per watched unit of work (an HTTP request, a backup run). Code
 *   on the hot path calls `touch(source)` whenever something observable
 *   happened (a DB call finished, bytes moved, an e-mail step ended). A
 *   watchdog compares `idleMs()` against the scope's `idleLimitMs` and calls
 *   `abort(err)` when the work has gone quiet for too long.
 *
 * HOW IT WORKS
 *   - `touch` stamps `lastProgressAt` and forwards to the parent scope, so a
 *     child (e.g. a guarded backup inside a request) keeps its parent alive.
 *   - `follow(other)` makes `lastProgressAt` the max of own and `other`'s
 *     effective value: a coalesced cache follower is not idle while the
 *     leader it waits on is progressing. Waiting alone never counts.
 *   - `abort(err)` is idempotent. It stores the error, aborts `signal`, runs
 *     `onAbort` hooks (adapter registers `conn.break()` there) and aborts
 *     every child. A child created under an already-aborted parent is born
 *     aborted.
 *
 * Complexity: touch O(depth), idleMs O(follow chain), abort O(children+hooks).
 */

class ProgressScope {
    /**
     * @param {object} options
     * @param {string} options.label - Human label for logs.
     * @param {number} options.idleLimitMs - Max idle window; `Infinity` = never idle.
     * @param {ProgressScope|null} [options.parent=null] - Parent scope (receives touches, propagates aborts down).
     * @param {() => number} [options.now=Date.now] - Clock (injectable for tests).
     */
    constructor({ label, idleLimitMs, parent = null, now = Date.now } = {}) {
        this.label = label ?? "scope";
        this.idleLimitMs = idleLimitMs ?? Infinity;
        this._parent = parent;
        this._now = now;
        this._ownAt = now();
        this._lastSource = "start";
        this._followed = null;
        /** @type {Map<object, number>} in-flight call token -> start time */
        this._busy = new Map();
        this._children = new Set();
        this._hooks = new Set();
        this._controller = new AbortController();
        this._abortError = null;
        this.createdAt = this._ownAt;

        if (parent) {
            parent._children.add(this);
            if (parent.aborted) this.abort(parent.abortError);
        }
    }

    /** @returns {AbortSignal} Aborted when `abort()` is called. */
    get signal() {
        return this._controller.signal;
    }

    /** @returns {boolean} */
    get aborted() {
        return this._abortError !== null;
    }

    /** @returns {Error|null} The error passed to `abort()`. */
    get abortError() {
        return this._abortError;
    }

    /** @returns {string} Source of the most recent own `touch()`. */
    get lastSource() {
        return this._lastSource;
    }

    /**
     * Effective last-progress time: max(own, followed scope's effective).
     * @returns {number} epoch ms
     */
    get lastProgressAt() {
        const followed = this._followed;
        return followed
            ? Math.max(this._ownAt, followed.lastProgressAt)
            : this._ownAt;
    }

    /**
     * Record that progress happened. Forwards to the parent. No-op once aborted.
     * @param {string} [source="unknown"] - What made progress (for the stall log).
     */
    touch(source = "unknown") {
        if (this._abortError) return;
        this._ownAt = this._now();
        this._lastSource = source;
        if (this._parent) this._parent.touch(source);
    }

    /**
     * Treat `scope`'s progress as our own until `unfollow()`.
     * @param {ProgressScope} scope
     */
    follow(scope) {
        this._followed = scope && scope !== this ? scope : null;
    }

    /**
     * Mark one long-running call (a DB statement) as in flight. While marked,
     * the IdleWatchdog treats the scope as progressing (up to its call cap).
     * Propagates to the parent so a guarded child keeps its request alive.
     * @returns {() => void} release (idempotent)
     */
    markBusy() {
        const key = {};
        this._busy.set(key, this._now());
        const releaseParent = this._parent ? this._parent.markBusy() : null;
        return () => {
            this._busy.delete(key);
            if (releaseParent) releaseParent();
        };
    }

    /**
     * Start time of the oldest in-flight call, or null when none.
     * @returns {number|null} epoch ms
     */
    oldestBusyAt() {
        let oldest = null;
        for (const t of this._busy.values()) {
            if (oldest === null || t < oldest) oldest = t;
        }
        return oldest;
    }

    /** Stop following. */
    unfollow() {
        this._followed = null;
    }

    /**
     * Milliseconds since the last effective progress.
     * @param {number} [now] - epoch ms; defaults to the scope clock.
     * @returns {number}
     */
    idleMs(now = this._now()) {
        return Math.max(0, now - this.lastProgressAt);
    }

    /**
     * Abort the scope (idempotent — only the first error sticks).
     * @param {Error} err
     */
    abort(err) {
        if (this._abortError) return;
        this._abortError = err ?? new Error("ProgressScope aborted");
        try {
            this._controller.abort(this._abortError);
        } catch {
            /* signal listeners must never break the abort path */
        }
        const hooks = [...this._hooks];
        this._hooks.clear();
        for (const fn of hooks) {
            try {
                fn(this._abortError);
            } catch {
                /* a failing hook must not stop the others */
            }
        }
        for (const child of [...this._children]) child.abort(this._abortError);
    }

    /**
     * Throw the abort error if the scope was aborted.
     * @throws {Error} `abortError`
     */
    throwIfAborted() {
        if (this._abortError) throw this._abortError;
    }

    /**
     * Register a hook to run on abort (runs immediately if already aborted).
     * @param {(err: Error) => void} fn
     * @returns {() => void} dispose — unregisters the hook.
     */
    onAbort(fn) {
        if (this._abortError) {
            try {
                fn(this._abortError);
            } catch {
                /* see abort() */
            }
            return () => {};
        }
        this._hooks.add(fn);
        return () => {
            this._hooks.delete(fn);
        };
    }

    /**
     * Detach from the parent (call when the unit of work ends) so a long-lived
     * parent does not accumulate dead children.
     */
    dispose() {
        if (this._parent) this._parent._children.delete(this);
        this._hooks.clear();
    }
}

module.exports = { ProgressScope };
