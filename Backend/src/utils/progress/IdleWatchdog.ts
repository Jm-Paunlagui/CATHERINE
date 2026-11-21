"use strict";

/**
 * @fileoverview IdleWatchdog — one timer that sweeps registered ProgressScopes.
 *
 * WHAT IT DOES
 *   Each sweep walks the registered scopes and calls `onIdle(scope, idleMs)`
 *   once for every scope idle past its `idleLimitMs`. Owners (RequestWatchdog,
 *   `runGuarded`) decide what "cut" means and dispose their registration.
 *
 * EVENT-LOOP STALL GUARD
 *   A big synchronous section (e.g. an xlsx build) blocks the loop, so no I/O
 *   callback could run and no `touch()` could happen — through no fault of the
 *   request. If a sweep fires more than `stallFactor` x `sweepMs` after the
 *   previous one, EVERY scope is touched "event-loop-stall" and nothing is
 *   enforced that tick; the next tick measures idleness afresh.
 *
 * IN-FLIGHT DB CALLS
 *   A scope with a call in flight (`scope.markBusy()`, set by the oracle
 *   adapter) is touched "db-inflight" each sweep while the OLDEST such call is
 *   younger than the cap (`DB_CALL_PROGRESS_CAP_MS`, default 30 min). Past the
 *   cap the call is treated as hung: no touch, so the normal idle cut (and
 *   `conn.break()` via the abort hook) applies.
 *
 * One unref'd interval (never keeps the process alive). Sweep is
 * O(active scopes).
 */

const { logger } = require("../logger");
const { watchdogMessages } = require("../../constants/messages");
const { resolveDbCallProgressCap } = require("../../constants/requestWatchdog");

/** Default sweep period. */
const SWEEP_MS = 5000;
/** A tick later than this many sweep periods is an event-loop stall. */
const STALL_FACTOR = 3;

class IdleWatchdog {
    /**
     * @param {object} [options]
     * @param {number} [options.sweepMs=SWEEP_MS]
     * @param {number} [options.stallFactor=STALL_FACTOR]
     * @param {() => number} [options.now=Date.now]
     * @param {number} [options.dbCallCapMs] - Ceiling for counting an in-flight DB call as progress (default: env via `resolveDbCallProgressCap`, resolved lazily at first sweep).
     */
    constructor({
        sweepMs = SWEEP_MS,
        stallFactor = STALL_FACTOR,
        now = Date.now,
        dbCallCapMs,
    } = {}) {
        this._dbCallCapMs = dbCallCapMs;
        this._sweepMs = sweepMs;
        this._stallFactor = stallFactor;
        this._now = now;
        /** @type {Map<object, { scope: import("./ProgressScope").ProgressScope, onIdle: Function, probe: Function|null, fired: boolean }>} */
        this._entries = new Map();
        this._timer = null;
        this._lastSweepAt = null;
    }

    /** @returns {number} Active registrations. */
    get size() {
        return this._entries.size;
    }

    /**
     * Watch a scope.
     * @param {import("./ProgressScope").ProgressScope} scope
     * @param {(scope: import("./ProgressScope").ProgressScope, idleMs: number) => void} onIdle - Called once when idle past `scope.idleLimitMs`.
     * @param {object} [options]
     * @param {(scope: import("./ProgressScope").ProgressScope) => void} [options.probe] - Called before each enforcement check (RequestWatchdog uses it for socket-I/O progress).
     * @returns {() => void} dispose (idempotent)
     */
    register(scope, onIdle, { probe = null } = {}) {
        const key = {};
        this._entries.set(key, { scope, onIdle, probe, fired: false });
        return () => {
            this._entries.delete(key);
        };
    }

    /**
     * Resolve (once) the in-flight DB call cap.
     * @returns {number}
     */
    _callCap() {
        if (this._dbCallCapMs === undefined) {
            const r = resolveDbCallProgressCap(process.env);
            for (const w of r.warnings) {
                logger.warning(
                    watchdogMessages.WATCHDOG_LIMIT_CLAMPED(w.name, w.raw, w.applied),
                );
            }
            this._dbCallCapMs = r.capMs;
        }
        return this._dbCallCapMs;
    }

    /** Start the sweep timer (idempotent). */
    start() {
        if (this._timer) return;
        this._lastSweepAt = this._now();
        this._timer = setInterval(() => this.sweep(), this._sweepMs);
        this._timer.unref?.();
    }

    /** Stop the sweep timer (idempotent). Registrations are kept. */
    stop() {
        if (this._timer) clearInterval(this._timer);
        this._timer = null;
        this._lastSweepAt = null;
    }

    /**
     * Run one sweep.
     * @param {number} [now] - epoch ms; defaults to the watchdog clock.
     */
    sweep(now = this._now()) {
        const prev = this._lastSweepAt;
        this._lastSweepAt = now;

        if (prev !== null && now - prev > this._stallFactor * this._sweepMs) {
            for (const { scope } of this._entries.values()) {
                scope.touch("event-loop-stall");
            }
            logger.warning(
                watchdogMessages.WATCHDOG_EVENT_LOOP_STALL(
                    now - prev - this._sweepMs,
                    this._entries.size,
                ),
            );
            return;
        }

        for (const entry of [...this._entries.values()]) {
            const { scope } = entry;
            if (entry.fired || scope.aborted) continue;
            const busyAt = scope.oldestBusyAt?.();
            if (busyAt !== null && busyAt !== undefined && now - busyAt < this._callCap()) {
                scope.touch("db-inflight");
            }
            if (entry.probe) {
                try {
                    entry.probe(scope);
                } catch {
                    /* a probe error must not stop enforcement of others */
                }
            }
            if (!Number.isFinite(scope.idleLimitMs)) continue;
            const idle = scope.idleMs(now);
            if (idle > scope.idleLimitMs) {
                entry.fired = true;
                try {
                    entry.onIdle(scope, idle);
                } catch (err) {
                    logger.error(watchdogMessages.WATCHDOG_ONIDLE_FAILED(err.message));
                }
            }
        }
    }
}

/** Process-wide watchdog. Started in server.js (`defaultIdleWatchdog.start()`). */
const defaultIdleWatchdog = new IdleWatchdog();

module.exports = { IdleWatchdog, defaultIdleWatchdog, SWEEP_MS, STALL_FACTOR };
