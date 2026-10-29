"use strict";

/**
 * @fileoverview Process-level registry of detached ("fire-and-forget")
 * promises (e.g. a post-commit notification send).
 * Its ONE job is to give `gracefulShutdown` a bounded, mechanism-agnostic
 * drain point: before the Oracle pools and SMTP transporter are torn down,
 * wait a short budget for whatever is still tracked, then abandon the rest
 * and let shutdown continue. Without this, a detached promise racing the
 * server's own teardown can lose work silently mid-batch (D4) — the same
 * dependency-starvation hazard `SseConnectionRegistry` exists to solve for
 * SSE sockets, applied to detached async work instead of live connections.
 *
 * DELIBERATELY DEPENDENCY-STARVED: it imports ONLY the logger and its own
 * message template — no models, services, db, or controllers.
 * Services already require this registry for `track()`, and the
 * shutdown flag rides that same import rather than a second singleton or an
 * argument threaded through the call — requiring anything heavier here would
 * invite a require cycle the same way it would for `SseConnectionRegistry`.
 *
 * @author senior-nodejs-engineer
 */

const { logger } = require("./logger");
const { inFlightMessages } = require("../constants/messages");

let nextId = 1;

class InFlightTaskRegistry {
    /** @type {Map<number, { label: string, promise: Promise<any> }>} */
    #tasks = new Map();

    /** @type {boolean} */
    #shuttingDown = false;

    /**
     * Track a detached promise so `drain()` can wait on it during shutdown.
     * Returns the SAME promise object so the caller's existing `.catch()` /
     * `.then()` chain attaches unchanged — this method only OBSERVES the
     * promise, it never wraps or replaces it.
     *
     * ⚠ Settlement is registered via `promise.then(clear, clear)`, NEVER
     * `.finally()`: `.finally(clear)` would return a NEW promise that
     * re-rejects, leaving that new chain unhandled (the caller's `.catch()`
     * is on the ORIGINAL promise) and producing an `unhandledRejection` this
     * codebase does not otherwise have — which itself triggers
     * `gracefulShutdown`.
     *
     * @param {string} label - Forensic label (e.g. `notify:job:20`),
     *   surfaced verbatim in `TASK_DRAIN_ABANDONED` if the task outlives the budget.
     * @param {Promise<any>} promise - The detached promise to observe.
     * @returns {Promise<any>} The same `promise`, untouched.
     */
    track(label, promise) {
        if (!promise || typeof promise.then !== "function") {
            return promise;
        }

        const id = nextId++;
        this.#tasks.set(id, { label, promise });

        const clear = () => {
            this.#tasks.delete(id);
        };
        promise.then(clear, clear);

        return promise;
    }

    /**
     * @returns {number} Count of currently tracked tasks.
     */
    size() {
        return this.#tasks.size;
    }

    /**
     * Sets the cooperative shutdown flag consumers poll via
     * `isShuttingDown()`. Idempotent, synchronous, and never throws — same
     * posture as `SseConnectionRegistry.endAll`.
     * @returns {void}
     */
    beginShutdown() {
        this.#shuttingDown = true;
    }

    /**
     * Hot-path cheap — a field read, no allocation. Polled cooperatively by
     * long-running loops (e.g. a per-recipient email loop)
     * so they can stop early once shutdown has begun.
     * @returns {boolean}
     */
    isShuttingDown() {
        return this.#shuttingDown;
    }

    /**
     * Wait up to `ms` for every currently-tracked task to settle. Defensively
     * sets the shutdown flag (so a caller that drains without having called
     * `beginShutdown()` still stops new work being tracked as "safe").
     *
     * ⚠ Returns `{ drained: 0, abandoned: 0, labels: [] }` IMMEDIATELY,
     * WITHOUT arming a timer, when nothing is tracked — the overwhelmingly
     * common case (every restart that is not mid-batch). Otherwise races
     * `Promise.allSettled([...tasks])` against a timer that is BOTH
     * `.unref()`'d (so it can never itself hold the event loop open) AND
     * `clearTimeout`'d on the settled path (so it cannot fire later, during
     * pool close, on a fast drain).
     *
     * NEVER throws — same posture as `SseConnectionRegistry.endAll`.
     *
     * @param {number} ms - Bounded wait, in milliseconds.
     * @returns {Promise<{drained: number, abandoned: number, labels: string[]}>}
     */
    async drain(ms) {
        this.#shuttingDown = true;

        const entries = [...this.#tasks.entries()];
        if (entries.length === 0) {
            return { drained: 0, abandoned: 0, labels: [] };
        }

        const total = entries.length;
        logger.notice(inFlightMessages.TASK_DRAIN_START(total, ms));

        const startedAt = Date.now();
        let timer;
        const timeout = new Promise((resolve) => {
            timer = setTimeout(() => resolve("TIMED_OUT"), ms);
            if (typeof timer.unref === "function") timer.unref();
        });

        const settleAll = Promise.allSettled(
            entries.map(([, task]) => task.promise),
        );

        const result = await Promise.race([settleAll, timeout]);
        clearTimeout(timer);

        const elapsedMs = Date.now() - startedAt;

        if (result === "TIMED_OUT") {
            const remaining = [...this.#tasks.values()].map((t) => t.label);
            const abandoned = remaining.length;
            const drained = total - abandoned;

            if (abandoned > 0) {
                logger.warning(
                    inFlightMessages.TASK_DRAIN_ABANDONED(abandoned, ms, remaining),
                );
            }

            return { drained, abandoned, labels: remaining };
        }

        logger.notice(inFlightMessages.TASK_DRAIN_COMPLETE(total, elapsedMs));
        return { drained: total, abandoned: 0, labels: [] };
    }
}

module.exports = new InFlightTaskRegistry();
