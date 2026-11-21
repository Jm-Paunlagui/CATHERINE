"use strict";

/**
 * @fileoverview The two boot emails, built here and sent through
 * `AlertNotifierService.notifyLifecycleNow` (system channel, bounded by its own
 * timeout, gated by ENABLE_SERVER_NOTIFICATIONS) - the same path and the same
 * `#send` / `settled()` shape as `ShutdownNotifier`:
 *
 *   - "Server restarted without a clean shutdown"  CRITICAL, never throttled
 *   - "Server started"                              NOTICE / WARNING, throttled
 *                                                   to one per 15 minutes - except
 *                                                   after a stop that emailed since
 *                                                   the last one
 *
 * The verdict comes from `ServerRunMarker.readPrevious()`. Email copy stays
 * inline (the ShutdownNotifier precedent: it is neither a log line, an AppError
 * nor an API response). Nothing here throws, and no identifiers beyond
 * pid/host/version ever appear in the copy. Every send asks for `persist`, so a
 * WARNING/CRITICAL boot email is also written to SERVER_ALERT_LOG.
 *
 * Security: CWE-209 (no stack traces / env values in mail), CWE-532.
 */

const os = require("os");
const { dbTimezoneOffsetMinutes } = require("../dbTimezone");
const { SERVER_RUN_MARKER } = require("../../constants/serverRunMarker");
const { serverMessages } = require("../../constants/messages/server.messages");

const { VERDICTS, STATES, STOP_REASONS } = SERVER_RUN_MARKER;
const { pendingKey, pendingList } = require("./ServerRunMarker");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * True when a lifecycle send result means "nothing is owed": the email went out, or notifications
 * are switched off (nothing should be sent late when mail is re-enabled). Pure.
 * @param {{sent?: boolean, reason?: string}|null|undefined} res
 * @returns {boolean}
 */
function isReportedSend(res) {
    return res?.sent === true || res?.reason === "disabled";
}

/** Stop reasons whose stop sent its own email at the time (shutdown started / crash / forced exit). */
const ANNOUNCED_STOP_REASONS = new Set([STOP_REASONS.SIGNAL, STOP_REASONS.CRASH, STOP_REASONS.FORCED_EXIT]);

/**
 * True when the previous run's stop emailed AFTER the last "Server started" notice, so the
 * recipients' latest message says the server went down and the new start must answer it. Pure.
 * @param {object|null|undefined} previous - the previous marker record
 * @param {number} lastStartNoticeAt - epoch ms
 * @returns {boolean}
 */
function announcedStopSince(previous, lastStartNoticeAt) {
    if (!previous || !ANNOUNCED_STOP_REASONS.has(previous.stopReason)) return false;
    const stopAt = Number.isFinite(previous.stoppingAt) ? previous.stoppingAt : previous.stoppedAt;
    return Number.isFinite(stopAt) && stopAt >= lastStartNoticeAt;
}

class StartupNotifier {
    /** @type {Set<Promise<any>>} */
    #pending = new Set();

    /**
     * @param {object} deps
     * @param {{notifyLifecycleNow: (opts: object) => Promise<any>}} deps.alertNotifier
     * @param {{warning: Function, info: Function}} deps.logger
     * @param {() => number} [deps.tzOffsetMinutes] - the DB zone offset reader
     */
    constructor({ alertNotifier, logger, tzOffsetMinutes = dbTimezoneOffsetMinutes }) {
        this._alertNotifier = alertNotifier;
        this._logger = logger;
        this._tzOffsetMinutes = tzOffsetMinutes;
    }

    /**
     * Sends whichever boot email the verdict calls for.
     *
     * @param {object} p
     * @param {string} p.verdict - a ServerRunMarker verdict
     * @param {object|null} p.previous - the previous record
     * @param {{pid: number, version: string, bootedAtMs: number}} p.current
     * @param {number|null} p.lastStartNoticeAt - epoch ms of the last started notice
     * @param {number} p.nowMs
     * @returns {Promise<{sent: boolean, reason?: string, event?: string}>}
     */
    async announce({ verdict, previous, current, lastStartNoticeAt, nowMs }) {
        // `uncleanReported`: every unclean restart known to this boot was emailed;
        // `reportedKeys`: the pendingKey of each one that was, so the caller clears
        // only those. Notifications switched off counts
        // as reported: nothing should be sent "late" when mail is re-enabled (L-c).
        let uncleanReported = true;
        const reportedKeys = [];
        // Same for cron-leader losses: `reportedLeaderLostKeys` are the ones now emailed.
        let leaderLostReported = true;
        const reportedLeaderLostKeys = [];
        const done = isReportedSend;
        const tag = (res) => ({ ...res, uncleanReported, reportedKeys, leaderLostReported, reportedLeaderLostKeys });
        try {
            // Unclean restarts from EARLIER boots whose email failed at the time
            // (always older than this boot's own verdict, so always sent first).
            for (const entry of pendingList(previous?.pendingUnclean)) {
                const late = await this.#send("unclean-restart", this.#uncleanPayload(entry, current, { late: true }));
                if (done(late)) reportedKeys.push(pendingKey(entry));
                else uncleanReported = false;
            }
            // Cron-leader losses from EARLIER boots whose WARNING email failed.
            for (const entry of pendingList(previous?.pendingLeaderLost)) {
                const late = await this.#send("leader-lost", this.#leaderLostPayload(entry, current, { late: true }));
                if (done(late)) reportedLeaderLostKeys.push(pendingKey(entry));
                else leaderLostReported = false;
            }
            if (verdict === VERDICTS.HANDOVER) {
                // A cron-leader worker that died while RUNNING (killed, out of memory,
                // native crash) ran no exit hook and no crash handler; nothing else
                // emails it. A STOPPING one was cut by the cluster's
                // forced kill, which the primary already emailed.
                if (previous?.state === STATES.RUNNING) {
                    const res = await this.#send("leader-lost", this.#leaderLostPayload(previous, current));
                    if (done(res)) reportedLeaderLostKeys.push(pendingKey(previous));
                    else leaderLostReported = false;
                    return tag(res);
                }
                return tag({ sent: false, reason: "handover" });
            }
            if (verdict === VERDICTS.UNCLEAN) {
                const res = await this.#send("unclean-restart", this.#uncleanPayload(previous, current));
                if (done(res)) reportedKeys.push(pendingKey(previous));
                else uncleanReported = false;
                return tag(res);
            }
            // Throttle only a notice that carries nothing new: never a stop that sent no
            // email at the time, never against a timestamp in the future
            // (the clock went back).
            // Never against a stop that emailed AFTER the last started notice: recipients'
            // last word would be "shutting down" / "crashed" while the server is back up.
            const sinceLast = nowMs - lastStartNoticeAt;
            if (
                Number.isFinite(lastStartNoticeAt) &&
                !previous?.unreported &&
                !announcedStopSince(previous, lastStartNoticeAt) &&
                sinceLast >= 0 &&
                sinceLast < SERVER_RUN_MARKER.STARTUP_NOTICE_MIN_INTERVAL_MS
            ) {
                this._logger.info(serverMessages.STARTUP_NOTICE_THROTTLED(new Date(lastStartNoticeAt).toISOString()));
                return tag({ sent: false, reason: "throttled", event: "started" });
            }
            return tag(await this.#send("started", this.#startedPayload(verdict, previous, current)));
        } catch (err) {
            this.#warn("announce", err);
            return { sent: false, reason: "error", uncleanReported: false, reportedKeys, leaderLostReported: false, reportedLeaderLostKeys };
        }
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
     * "Oct 16, 2026, 4:05:57 PM UTC+08:00" in the DB zone. Hand-formatted:
     * Intl output varies across ICU versions (narrow no-break space before PM).
     *
     * @param {number} ms
     * @returns {string}
     */
    #fmt(ms) {
        if (!Number.isFinite(ms)) return "an unknown time";
        const off = this._tzOffsetMinutes();
        const d = new Date(ms + off * 60_000);
        const h24 = d.getUTCHours();
        const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
        const pad = (n) => String(n).padStart(2, "0");
        const sign = off < 0 ? "-" : "+";
        const abs = Math.abs(off);
        return (
            `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}, ` +
            `${h12}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${h24 < 12 ? "AM" : "PM"} ` +
            `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
        );
    }

    #uncleanPayload(previous, current, { late = false } = {}) {
        const p = previous ?? {};
        const lastAlive = p.lastHeartbeatAt;
        // A late report (email failed at the time) cannot know when that run came back;
        // a negative gap means the clock changed. Neither claims a downtime.
        const downMs = !late && Number.isFinite(lastAlive) ? current.bootedAtMs - lastAlive : NaN;
        const down = !Number.isFinite(downMs) || downMs < 0
            ? "an unknown time"
            : downMs < 60_000
              ? "under a minute"
              : `about ${Math.round(downMs / 60_000)} min`;
        const clockMoved = !late && Number.isFinite(downMs) && downMs < 0;
        const aliveText = !Number.isFinite(lastAlive)
            ? "Its last-alive time is unknown"
            : clockMoved
              ? `Its recorded last-alive time (${this.#fmt(lastAlive)}) is later than this start, so the system clock changed`
              : `It was last alive at ${this.#fmt(lastAlive)}, so it stopped between then and 30 s later`;
        let summary =
            (late
                ? "This restart was not emailed when it happened (the email could not be sent then). "
                : "") +
            `The previous backend process (PID ${p.pid ?? "?"}, version ${p.version ?? "?"}, started ${this.#fmt(p.bootedAt)}) ` +
            `ended without running its shutdown sequence. ${aliveText}` +
            (late ? ". " : `; this process started at ${this.#fmt(current.bootedAtMs)} (down ${down}). `) +
            `Typical causes: a forced host restart or power loss, ` +
            `the service process being killed, or Windows ending the service during a host shutdown. ` +
            `Work in progress at that moment may be incomplete.`;
        if (p.state === STATES.STOPPING) {
            summary +=
                ` A graceful shutdown had begun at ${this.#fmt(p.stoppingAt)} (${p.stopSignal ?? "signal"}) ` +
                `but did not finish before the process was killed.`;
        }
        return {
            severity: "CRITICAL",
            headline: `Server restarted without a clean shutdown on ${os.hostname()}`,
            summary,
            rows: [
                {
                    rule: "SERVER_UNCLEAN_RESTART",
                    scope: "process",
                    description:
                        `Last heartbeat ${this.#fmt(lastAlive)}; previous state ${p.state ?? "unknown"}. ` +
                        `Check Windows Event Viewer (System log 41, 6008, 1074) and dist\\service-logs.`,
                    severity: "critical",
                },
            ],
        };
    }

    #leaderLostPayload(previous, current, { late = false } = {}) {
        const p = previous ?? {};
        return {
            severity: "WARNING",
            headline: `Cron-leader worker restarted unexpectedly on ${os.hostname()}`,
            summary:
                (late ? "This was not emailed when it happened (the email could not be sent then). " : "") +
                `The cron-leader worker (PID ${p.pid ?? "?"}) ended without running its shutdown sequence ` +
                `(for example killed, out of memory, or a native crash). Its last heartbeat was at ${this.#fmt(p.lastHeartbeatAt)}. ` +
                (late
                    ? "A replacement worker took over then. "
                    : `The cluster started a replacement (PID ${current.pid}, ${this.#fmt(current.bootedAtMs)}); scheduled jobs continue there. `) +
                `Check the server logs around that time.`,
            rows: [
                {
                    rule: "SERVER_LEADER_LOST",
                    scope: "process",
                    description: late
                        ? `Worker PID ${p.pid ?? "?"} lost (reported late).`
                        : `Worker PID ${p.pid ?? "?"} lost, replacement PID ${current.pid}.`,
                    severity: "warning",
                },
            ],
        };
    }

    #startedPayload(verdict, previous, current) {
        const p = previous ?? {};
        let desc;
        let severity = "NOTICE";
        if (verdict === VERDICTS.FIRST_BOOT) {
            desc = "unknown, first start with restart tracking";
        } else if (verdict === VERDICTS.UNREADABLE) {
            desc = "state unreadable";
            severity = "WARNING";
        } else if (p.unreported && p.stopReason !== STOP_REASONS.CRASH && p.stopReason !== STOP_REASONS.FORCED_EXIT) {
            desc = "the previous run stopped because the cluster primary disappeared; this was not emailed at the time";
            severity = "WARNING";
        } else if (p.exitCode !== undefined && p.exitCode !== 0) {
            const how = p.stopReason === STOP_REASONS.FORCED_EXIT ? "forced exit" : "crash";
            desc = `ended with exit code ${p.exitCode} at ${this.#fmt(p.stoppedAt)} after ${how}, ${
                p.stopEmailUnsent === true ? `the ${how} email could not be sent at the time` : "reported when it happened"
            }`;
            severity = "WARNING";
        } else {
            const why = p.stopReason === STOP_REASONS.SIGNAL ? "service stop" : "process exit";
            desc = `stopped cleanly at ${this.#fmt(p.stoppedAt)} (${why})`;
        }
        return {
            severity,
            headline: `Server started on ${os.hostname()}`,
            summary:
                `CATHERINE backend ${current.version} is running (PID ${current.pid}, started ${this.#fmt(current.bootedAtMs)}). ` +
                `Previous run: ${desc}.`,
            rows: [
                {
                    rule: "SERVER_STARTED",
                    scope: "process",
                    description: `PID ${current.pid}, version ${current.version}. Previous run: ${desc}.`,
                    severity: severity === "WARNING" ? "warning" : "info",
                },
            ],
        };
    }

    #warn(event, err) {
        try {
            this._logger.warning(serverMessages.STARTUP_NOTIFY_FAILED(event, err?.message ?? String(err)), {
                _noNotify: true,
            });
        } catch {
            /* logging must never break boot */
        }
    }

    /**
     * @param {string} event
     * @param {object} payload
     * @returns {Promise<{sent: boolean, reason?: string, event: string}>}
     */
    #send(event, payload) {
        let p;
        try {
            // Boot emails also land in the alert History tab: the pools are up here.
            p = Promise.resolve(this._alertNotifier.notifyLifecycleNow({ ...payload, persist: true }));
        } catch (err) {
            p = Promise.reject(err);
        }
        const tracked = p
            .then((result) => {
                if (result && result.sent === false && result.reason !== "disabled") {
                    this.#warn(event, new Error(result.cause ?? result.reason));
                }
                return { ...(result ?? { sent: false }), event };
            })
            .catch((err) => {
                this.#warn(event, err);
                return { sent: false, reason: "error", event };
            })
            .finally(() => this.#pending.delete(tracked));
        this.#pending.add(tracked);
        return tracked;
    }
}

module.exports = StartupNotifier;
module.exports.isReportedSend = isReportedSend;
