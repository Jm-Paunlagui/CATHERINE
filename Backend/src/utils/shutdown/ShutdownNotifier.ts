"use strict";

/**
 * @fileoverview The three shutdown alert emails — shutdown started, in-flight
 * requests cut, forced exit — built here and sent through
 * `AlertNotifierService.notifyLifecycleNow` (system channel, bounded by its
 * own timeout, gated by ENABLE_SERVER_NOTIFICATIONS).
 *
 * Sends are fire-and-forget for the caller but remembered, so the shutdown
 * sequence can `await settled()` before the SMTP transporter is closed —
 * otherwise a fast stop would close the transporter under its own email.
 * Nothing here throws.
 *
 * @author senior-nodejs-engineer
 */

const os = require("os");
const { serverMessages } = require("../../constants/messages/server.messages");

const SIGNAL_LABEL = Object.freeze({
    SIGTERM: "service stop (SIGTERM)",
    SIGINT: "Ctrl+C / service stop (SIGINT)",
    SIGBREAK: "Windows service stop (SIGBREAK)",
});

class ShutdownNotifier {
    /** @type {Set<Promise<any>>} */
    #pending = new Set();

    /**
     * @param {object} deps
     * @param {{notifyLifecycleNow: (opts: object) => Promise<any>}} deps.alertNotifier
     * @param {{warning: Function}} deps.logger
     * @param {boolean} [deps.announce=true] - Whether this process sends the
     *   process-wide `started` email. In a cluster only the cron-leader worker
     *   announces (one email, not one per worker). Every worker still sends
     *   `requestsCut` for the requests it cut itself and `forcedExit` when its
     *   OWN failsafe fires (otherwise a hung non-leader worker would be
     *   force-exited with no email at all).
     */
    constructor({ alertNotifier, logger, announce = true }) {
        this._alertNotifier = alertNotifier;
        this._logger = logger;
        this._announce = announce !== false;
    }

    /**
     * @param {{signal: string, inFlight: number, graceMs: number, pendingTasks: number, idleLimits?: {defaultMs: number, longMs: number}}} p
     *   `idleLimits` switches the summary to the progress-aware wording.
     * @returns {Promise<any>}
     */
    started({ signal, inFlight, graceMs, pendingTasks, idleLimits }) {
        if (!this._announce) return Promise.resolve({ sent: false, reason: "not-announcer" });
        const how = SIGNAL_LABEL[signal] ?? signal;
        const sec = (ms) => Math.round(ms / 1000);
        const summary = idleLimits
            ? `A graceful shutdown began (${how}). New requests are refused. ` +
              `${inFlight} request(s) in progress may finish while they keep making progress; ` +
              `a request idle longer than its limit (${sec(idleLimits.defaultMs)}s, long operations ${sec(idleLimits.longMs)}s) is cut. ` +
              `Absolute cap ${graceMs >= 120_000 ? `${Math.round(graceMs / 60000)} min` : `${sec(graceMs)} s`}.`
            : `A graceful shutdown began (${how}). New requests are refused; ` +
              `${inFlight} request(s) in progress may finish for up to ${sec(graceMs)} s.`;
        return this.#send("started", {
            severity: "WARNING",
            headline: `Server shutting down on ${os.hostname()}`,
            summary,
            rows: [
                {
                    rule: "SERVER_SHUTDOWN_STARTED",
                    scope: "process",
                    description: `${inFlight} in-flight request(s), ${pendingTasks} background task(s) pending, grace ${Math.round(graceMs / 1000)} s.`,
                    severity: "warning",
                },
            ],
        });
    }

    /**
     * @param {Array<{method: string, path: string, ageMs: number, idleMs?: number|null}>} summary - Oldest first, capped
     * @param {number} graceMs
     * @param {number} [total=summary.length] - How many were cut (the summary may be capped)
     * @param {{reason?: "cap"|"idle"}} [opts] - `idle`: cut by the idle watchdog; `cap` (default): grace ran out.
     * @returns {Promise<any>}
     */
    requestsCut(summary, graceMs, total = summary.length, { reason = "cap" } = {}) {
        const idle = reason === "idle";
        const rows = summary.map((r) => ({
            rule: "SHUTDOWN_REQUEST_CUT",
            scope: `${r.method} ${r.path}`,
            description: idle
                ? `Stopped making progress (idle ${Math.round((r.idleMs ?? r.ageMs) / 1000)} s, age ${Math.round(r.ageMs / 1000)} s) — the work was aborted; the client got a 504, or the connection was closed if the response had already started.`
                : `Still running after ${Math.round(r.ageMs / 1000)} s — connection force-closed; the client got no response.`,
            severity: "critical",
        }));
        return this.#send("requests-cut", {
            severity: "CRITICAL",
            headline: idle
                ? `${total} request(s) cut during shutdown — stopped making progress`
                : `${total} request(s) cut during shutdown`,
            summary: idle
                ? "The idle watchdog cut these requests during the shutdown because they stopped making progress. " +
                  "Their work was aborted and may be incomplete; check the listed routes."
                : `The ${Math.round(graceMs / 1000)} s shutdown grace ran out while requests were still running. ` +
                  "Their work may be incomplete; check the listed routes.",
            rows,
        });
    }

    /**
     * @param {number} forcedExitMs
     * @returns {Promise<any>}
     */
    forcedExit(forcedExitMs) {
        // Sent by every process whose own failsafe fired; a cluster worker
        // that is not the cron leader names itself, so the email says which one hung.
        const who = this._announce ? "" : ` (cluster worker PID ${process.pid}, not the cron leader)`;
        return this.#send("forced-exit", {
            severity: "CRITICAL",
            headline: `Shutdown hung — forced exit after ${Math.round(forcedExitMs / 1000)} s${who}`,
            summary:
                "The graceful shutdown did not finish in time and the process was force-exited with code 1. " +
                "Pool close, audit flush or a background task may have hung; check the server logs.",
            rows: [
                {
                    rule: "SERVER_SHUTDOWN_FORCED",
                    scope: "process",
                    description: `Failsafe fired at ${Math.round(forcedExitMs / 1000)} s; exit code 1.`,
                    severity: "critical",
                },
            ],
        });
    }

    /**
     * Resolves once every email sent so far has settled (each is already
     * bounded by notifyLifecycleNow's timeout).
     *
     * @returns {Promise<void>}
     */
    async settled() {
        await Promise.allSettled([...this.#pending]);
    }

    /**
     * @param {string} event
     * @param {object} payload
     * @returns {Promise<any>}
     */
    #send(event, payload) {
        let p;
        try {
            p = Promise.resolve(this._alertNotifier.notifyLifecycleNow(payload));
        } catch (err) {
            p = Promise.reject(err);
        }
        const tracked = p
            .then((result) => {
                if (result && result.sent === false && result.reason !== "disabled") {
                    this._logger.warning(
                        serverMessages.SHUTDOWN_NOTIFY_FAILED(event, result.cause ?? result.reason),
                        { _noNotify: true },
                    );
                }
                return result;
            })
            .catch((err) => {
                this._logger.warning(serverMessages.SHUTDOWN_NOTIFY_FAILED(event, err?.message ?? String(err)), {
                    _noNotify: true,
                });
                return { sent: false, reason: "error" };
            })
            .finally(() => this.#pending.delete(tracked));
        this.#pending.add(tracked);
        return tracked;
    }
}

module.exports = ShutdownNotifier;
