"use strict";

/**
 * @fileoverview Log message templates for the progress / request watchdog
 * (`src/utils/progress/`). Used ONLY in logger.* calls — never thrown or sent
 * to clients.
 *
 * Keys carry the `WATCHDOG_` prefix by convention (greppable in logs).
 */

const watchdogMessages = {
    /**
     * A request made no progress for longer than its idle limit and was cut
     * with a 504 (logger.error — deliberately not critical, no email storm).
     * @param {string} method - HTTP verb.
     * @param {string} routeLabel - Bounded route label (no raw ids).
     * @param {number} idleMs - Time since the last progress event.
     * @param {number} limitMs - The idle limit that applied.
     * @param {string} lastSource - Source of the last progress event.
     * @param {number} ageMs - Total request age.
     * @returns {string}
     */
    WATCHDOG_REQUEST_STALLED: (method, routeLabel, idleMs, limitMs, lastSource, ageMs) =>
        `WATCHDOG_REQUEST_STALLED — ${method} ${routeLabel} made no progress for ${idleMs}ms (limit ${limitMs}ms, last progress: ${lastSource}, age ${ageMs}ms); terminated with 504.`,

    /**
     * An env idle limit was out of range / not numeric and was replaced.
     * @param {string} name - Env var name.
     * @param {string} raw - The configured value.
     * @param {number} applied - The value actually used.
     * @returns {string}
     */
    WATCHDOG_LIMIT_CLAMPED: (name, raw, applied) =>
        `WATCHDOG_LIMIT_CLAMPED — ${name}="${raw}" is out of range or not a number; using ${applied}ms.`,

    /**
     * The sweep tick ran far later than scheduled (a long synchronous section
     * blocked the loop), so every scope was credited as progressing and
     * nothing was enforced on that tick.
     * @param {number} lateMs - How late the tick fired beyond its interval.
     * @param {number} scopes - Scopes credited.
     * @returns {string}
     */
    WATCHDOG_EVENT_LOOP_STALL: (lateMs, scopes) =>
        `WATCHDOG_EVENT_LOOP_STALL — idle sweep ran ${lateMs}ms late; credited ${scopes} active scope(s) as progressing and skipped enforcement this tick.`,

    /**
     * An `onIdle` callback registered with the IdleWatchdog threw.
     * @param {string} cause - `err.message`.
     * @returns {string}
     */
    WATCHDOG_ONIDLE_FAILED: (cause) =>
        `WATCHDOG_ONIDLE_FAILED — idle callback threw: ${cause}`,

    /**
     * Burst alert (logger.critical -> one critical-channel email): at least
     * `WATCHDOG_ALERT_BURST` cuts inside the window on one process.
     * @param {number} count - Cuts inside the window.
     * @param {number} windowMs - Window length.
     * @param {Array<[string, number]>} topRoutes - [route template, cuts], most cut first.
     * @param {Array<[string, number]>} topSources - [last progress source, cuts].
     * @param {number} more - Cuts since the previous alert (cooldown-suppressed).
     * @returns {string}
     */
    WATCHDOG_BURST_ALERT: (count, windowMs, topRoutes, topSources, more) => {
        const fmt = (list) => list.map(([k, n]) => `${k} x${n}`).join(", ") || "none";
        return (
            `WATCHDOG_BURST_ALERT — ${count} request(s) cut by the watchdog in the last ${Math.round(windowMs / 1000)}s on pid ${process.pid}. ` +
            `Top routes: ${fmt(topRoutes)}. Last progress sources: ${fmt(topSources)}.` +
            (more > 0 ? ` ${more} more cut(s) since the previous alert.` : "")
        );
    },
};

module.exports = { watchdogMessages };
