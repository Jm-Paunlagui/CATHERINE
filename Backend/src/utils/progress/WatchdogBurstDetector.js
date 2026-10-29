"use strict";

/**
 * @fileoverview WatchdogBurstDetector — turns a burst of request-watchdog cuts
 * on THIS process into ONE critical log (and so one critical-channel email).
 *
 * WHY A CRITICAL LOG AND NOT A MetricsService RULE
 *   The metrics store is per worker under clustering, and `AlertNotifierService`
 *   only runs on the cron leader, so a rule would never see a stall burst on a
 *   sibling worker. A critical log is already carried to the leader by the
 *   critical relay (`critRelay.js` -> `ingestRelayedCritical`), so the burst
 *   alert works from any worker with no new IPC, and inherits the digest window
 *   and the hourly storm ceiling. Channel: CRITICAL (not system) — a burst of
 *   hung requests means users are being failed now; the system channel is for
 *   resource trends. The per-cut `WATCHDOG_REQUEST_STALLED` log stays at error.
 *
 * COOLDOWN
 *   After an alert, further cuts only increment a counter until `windowMs` has
 *   passed; the next alert (needs `burst` cuts inside the window again) carries
 *   "N more cut(s) since the previous alert". A sustained hang therefore emails
 *   at most once per window.
 *
 * Security: CWE-209/CWE-532 — only route templates / first-segment masks and
 * progress-source names are reported, never ids, bodies or user data.
 * CWE-770 — entries are capped at MAX_ENTRIES.
 * Complexity: record() is O(k) for k entries inside the window (k <= MAX_ENTRIES).
 *
 * Class: holds a sliding window + cooldown state.
 */

const { logger } = require("../logger");
const { watchdogMessages } = require("../../constants/messages");

/** Defaults and bounds for the env settings. */
const DEFAULT_BURST = 3;
const DEFAULT_WINDOW_MS = 600_000;
const MIN_WINDOW_MS = 1_000;
const MAX_WINDOW_MS = 3_600_000;
/** Max cut records kept in the window (bounds memory during a storm). */
const MAX_ENTRIES = 1000;
/** Max items listed per breakdown in the alert body. */
const TOP_N = 5;

class WatchdogBurstDetector {
    /**
     * @param {object} [options]
     * @param {number} [options.burst] - Cuts that trigger an alert; 0 disables. Default: env `WATCHDOG_ALERT_BURST` (3).
     * @param {number} [options.windowMs] - Sliding window and cooldown. Default: env `WATCHDOG_ALERT_WINDOW_MS` (600000).
     * @param {() => number} [options.now=Date.now]
     * @param {(message: string, meta: object) => void} [options.emit] - Default: `logger.critical`.
     */
    constructor({ burst, windowMs, now = Date.now, emit } = {}) {
        const cfg = WatchdogBurstDetector.resolveConfig(process.env);
        this._burst = burst ?? cfg.burst;
        this._windowMs = windowMs ?? cfg.windowMs;
        this._now = now;
        this._emit = emit ?? ((message, meta) => logger.critical(message, meta));
        /** @type {Array<{t: number, route: string, source: string}>} */
        this._entries = [];
        this._lastAlertAt = null;
        this._sinceAlert = 0;
    }

    /**
     * Parse the env settings; invalid values fall back to the defaults.
     * @param {NodeJS.ProcessEnv} env
     * @returns {{ burst: number, windowMs: number }}
     */
    static resolveConfig(env) {
        const b = Number.parseInt(env?.WATCHDOG_ALERT_BURST, 10);
        const w = Number.parseInt(env?.WATCHDOG_ALERT_WINDOW_MS, 10);
        return {
            burst: Number.isFinite(b) && b >= 0 ? b : DEFAULT_BURST,
            windowMs:
                Number.isFinite(w) && w >= MIN_WINDOW_MS && w <= MAX_WINDOW_MS ? w : DEFAULT_WINDOW_MS,
        };
    }

    /**
     * Register one cut. Never throws.
     * @param {{ method: string, path: string, lastSource: string }} cut - `path` is a route template / masked label.
     * @returns {boolean} true when this cut raised the burst alert
     */
    record({ method, path, lastSource }) {
        try {
            if (!(this._burst > 0)) return false;
            const now = this._now();
            const cutoff = now - this._windowMs;
            while (this._entries.length && this._entries[0].t <= cutoff) this._entries.shift();
            if (this._entries.length >= MAX_ENTRIES) this._entries.shift();
            this._entries.push({
                t: now,
                route: `${method} ${path}`,
                source: String(lastSource ?? "none"),
            });

            if (this._lastAlertAt !== null && now - this._lastAlertAt < this._windowMs) {
                this._sinceAlert++;
                return false;
            }
            if (this._entries.length < this._burst) return false;

            const top = (key) => {
                const counts = new Map();
                for (const e of this._entries) counts.set(e[key], (counts.get(e[key]) ?? 0) + 1);
                return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_N);
            };
            const topRoutes = top("route");
            const topSources = top("source");
            const count = this._entries.length;
            const more = this._sinceAlert;
            this._lastAlertAt = now;
            this._sinceAlert = 0;
            this._emit(
                watchdogMessages.WATCHDOG_BURST_ALERT(count, this._windowMs, topRoutes, topSources, more),
                { watchdogBurst: { count, windowMs: this._windowMs, topRoutes, topSources, more } },
            );
            return true;
        } catch {
            return false;
        }
    }

    /** Forget all state (tests). */
    reset() {
        this._entries = [];
        this._lastAlertAt = null;
        this._sinceAlert = 0;
    }
}

const defaultBurstDetector = new WatchdogBurstDetector();

module.exports = { WatchdogBurstDetector, defaultBurstDetector };
