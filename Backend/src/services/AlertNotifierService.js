"use strict";

/**
 * @fileoverview Server Email Notifications — state machine, poller, and
 * critical-log tap subscriber. Owns ALL dedup/throttle/hysteresis logic so
 * `ServerNotificationService` (the sender) stays a dumb template renderer.
 *
 * WHAT THIS FILE DOES
 * -------------------
 * Two independent trigger paths feed the same four email channels:
 *
 *   1. METRICS POLL (dependencies / red-metrics / system channels) — a plain
 *      `setInterval` (never node-cron — PKG builds have silently missed cron
 *      ticks before; see the 15-min sweep precedent in `server.js`) calls
 *      `MetricsService.evaluateAlerts()` every `ALERT_POLL_INTERVAL_MS` and
 *      diffs the result against the last known state per alert identity
 *      (`rule + (route ?? pool ?? "global")`). Emails fire only on state
 *      TRANSITIONS — escalation is immediate, re-notify-while-still-firing
 *      is cooldown-gated, and recovery requires
 *      `ALERT_RECOVERY_CONFIRM_POLLS` consecutive clear polls (R4 anti-flap
 *      hysteresis) before a single "resolved" digest fires.
 *
 *   2. CRITICAL LOG TAP (critical channel) — subscribes to
 *      `logger.onLevel(2, ...)` (emerg/alert/crit). Events are buffered for
 *      `CRITICAL_DIGEST_WINDOW_MS` so a DB-outage log storm collapses into
 *      ONE email, with an hourly ceiling (`CRITICAL_MAX_EMAILS_PER_HOUR`, R3)
 *      past which further windows are silently counted (not sent) and the
 *      next successful digest reports "N further events suppressed".
 *
 * PHASE 4 — ALERT ACKNOWLEDGEMENT (server-email-notifications-plan.md
 * "Phase 4 — Alert Acknowledgement"): a PagerDuty-style `acknowledge()` /
 * `unacknowledge()` pair silences the cooldown re-notify nag for a
 * genuinely persistent condition, with two mandatory safety nets so an ack
 * can never silently swallow a real emergency:
 *   1. Escalation override — the moment an alert's live severity ranks
 *      HIGHER than the severity recorded at ack time, the ack is cleared
 *      automatically and the notification fires anyway.
 *   2. TTL expiry — an ack lapses on its own after `ALERT_ACK_TTL_HOURS`
 *      (default 24), checked live in the same guard every poll tick — no
 *      separate sweep job.
 * Recovery (`->OK`) also clears any ack — a later re-fire of the same
 * identity is a new incident and needs a fresh decision. State lives in an
 * in-memory Map (`this._acks`), hydrated from `SERVER_ALERT_ACK` at
 * `start()` (mirrors `RecipientResolver`'s DB-hydrate-at-boot pattern) so a
 * routine restart never loses an active ack and resumes the nag
 * immediately after a deploy.
 *
 * LOOP GUARD (R1b) — every `logger.*` call in this file carries meta
 * `{ _noNotify: true }` so nothing this service logs can re-enter the
 * critical tap it itself subscribes to. The ONE deliberate exception is the
 * Phase 4 escalation-clear `logger.notice` — a normal operational event,
 * safe to see in logs, and not itself part of the notification send path.
 *
 * DOUBLE-NOTIFY GUARD (R2) — `MetricsService.evaluateAlerts()` tags its own
 * `ALERT_TRIGGERED` logs with `_noNotify: true` for the same reason: every
 * alert is already delivered here via its mapped channel, so the tap must
 * never re-email it via the critical channel too.
 *
 * CLUSTER GUARD (R5) — this class is cluster-agnostic by design; the caller
 * (`server.js`) only calls `start()` on the elected cron-leader worker
 * (same `ClusterRole` gate as WalletSeeder), so exactly one worker polls and
 * subscribes to the tap in a clustered deployment.
 *
 * EXAMPLE
 * -------
 *   const AlertNotifierService = require("./AlertNotifierService");
 *   AlertNotifierService.start();     // after pools init, cron-leader only
 *   // ...
 *   await AlertNotifierService.stop(); // graceful shutdown
 */

const { logger } = require("../utils/logger");
const { notificationMessages } = require("../constants/messages");
const { AppError, NOTIFICATION_ERRORS } = require("../constants/errors");
const { metricsStore } = require("../middleware/metrics");
const MetricsService = require("./MetricsService");
const ServerNotificationService = require("./email/ServerNotificationService");
const ServerAlertLogModel = require("../models/serverAlertLog.model");
const ServerAlertAckModel = require("../models/serverAlertAck.model");
const AdminModel = require("../models/admin.model");

/**
 * Static rule → channel mapping (server-email-notifications-plan.md
 * "Channels" table). A rule with no entry here falls back to
 * `FALLBACK_CHANNEL` — new alert rules are never dropped silently.
 * @type {Readonly<Record<string, string>>}
 */
const RULE_CHANNEL_MAP = Object.freeze({
    ORACLE_POOL_SATURATION: "server-dependencies-notification",
    EMAIL_DELIVERY_FAILING: "server-dependencies-notification",
    HIGH_ERROR_RATE: "server-red-metrics-notification",
    HIGH_LATENCY: "server-red-metrics-notification",
    HIGH_HEAP: "server-system-notification",
    EVENT_LOOP_LAG: "server-system-notification",
    HIGH_GC_OVERHEAD: "server-system-notification",
    MEMORY_LEAK_SUSPECTED: "server-system-notification",
});

/** Channel an unmapped rule falls back to (never dropped silently). */
const FALLBACK_CHANNEL = "server-system-notification";

/**
 * Best-effort timeout for `notifyCriticalNow()`, called from `server.js`
 * process-crash handlers where we cannot block exit indefinitely waiting on
 * SMTP. Not env-configurable — deliberately out of scope of the documented
 * env var list (server-email-notifications-plan.md).
 */
const NOTIFY_NOW_TIMEOUT_MS = 5000;

// ─── Phase 3: SERVER_ALERT_LOG persistence constants ─────────────────────────

/** Max in-memory alert-log rows queued while the DB is unreachable (drop-oldest past this). */
const ALERT_LOG_QUEUE_MAX = 500;

/** DETAILS object keys matching this pattern are redacted before persistence (CWE-532). */
const SENSITIVE_KEY_PATTERN = /password|token|secret|authorization|cookie/i;

/** Max serialized DETAILS payload size, in bytes, before it is replaced with a truncated envelope. */
const MAX_DETAILS_BYTES = 64 * 1024;

/** Max characters kept from an embedded stack trace (same cap as FE error ingestion). */
const MAX_STACK_CHARS = 2000;

/**
 * Retention-purge sweep check interval — mirrors the 15-min PKG-resilience
 * sweep precedent in server.js (plain setInterval, never node-cron, R6).
 */
const RETENTION_SWEEP_CHECK_MS = 15 * 60 * 1000;

class AlertNotifierService {
    constructor() {
        /**
         * Per-alert-identity state. Key = `rule::scope`.
         * @type {Map<string, { status: "OK"|"WARNING"|"CRITICAL", clearPollCount: number, lastNotifiedAt: number|null, channel: string, rule: string, scope: string, lastAlert: object|null }>}
         */
        this._alertStates = new Map();

        /** @type {NodeJS.Timeout|null} */
        this._pollTimer = null;
        /** @type {(() => void)|null} */
        this._unsubscribeTap = null;
        /** @type {boolean} */
        this._running = false;

        /** Buffered crit/alert/emerg log records awaiting the next digest flush. */
        this._criticalBuffer = [];
        /** @type {NodeJS.Timeout|null} */
        this._criticalWindowTimer = null;
        /** Rolling list of ms timestamps for emails sent in the last hour (storm ceiling, R3). */
        this._criticalSentTimestamps = [];
        /** Events dropped by the hourly ceiling since the last successful critical send. */
        this._criticalSuppressedSinceLastSend = 0;

        /** Phase 3 — SERVER_ALERT_LOG write-behind queue (best-effort, cap ALERT_LOG_QUEUE_MAX). */
        this._alertLogQueue = [];
        /** @type {NodeJS.Timeout|null} */
        this._retentionSweepTimer = null;
        /** @type {string|null} toDateString() of the last day the retention purge ran. */
        this._lastPurgeDay = null;

        /**
         * Phase 4 — in-memory acknowledgement map. Key = alertKey
         * (`rule::scope`, same identity as `_alertStates`). Hydrated from
         * SERVER_ALERT_ACK at start().
         * @type {Map<string, { ackedBy: number, ackedAt: number, expiresAt: number, severityAtAck: "WARNING"|"CRITICAL", note: string|null }>}
         */
        this._acks = new Map();
    }

    // ─── Lifecycle ────────────────────────────────────────────────────────────

    /**
     * Arms the metrics poller and subscribes to the critical logger tap.
     * No-op (logs one notice) when server email notifications are disabled.
     * Idempotent — calling twice while already running is a no-op.
     *
     * @returns {{ started: boolean, reason?: string }}
     */
    start() {
        if (this._running) return { started: false, reason: "already-started" };

        if (!ServerNotificationService.isEnabled()) {
            logger.notice(
                notificationMessages.NOTIFIER_DISABLED("ENABLE_SERVER_NOTIFICATIONS is not 'true'"),
                { _noNotify: true }, // R1b loop guard
            );
            return { started: false, reason: "disabled" };
        }

        const pollIntervalMs = this._pollIntervalMs();
        this._pollTimer = setInterval(() => {
            this._pollTick().catch((err) => {
                logger.warning(
                    notificationMessages.EMAIL_FAILED("poll", err?.message ?? String(err)),
                    { _noNotify: true }, // R1b loop guard
                );
            });
        }, pollIntervalMs);
        if (typeof this._pollTimer.unref === "function") this._pollTimer.unref();

        this._unsubscribeTap = logger.onLevel(2, (record) => this._onCriticalLog(record));
        this._armRetentionSweep();
        this._running = true;

        // Phase 4 — hydrate the ack Map from SERVER_ALERT_ACK. Fire-and-forget
        // (never awaited here) so a slow/not-yet-initialized Oracle pool can
        // never delay tap subscription above — server.js deliberately starts
        // this service BEFORE db.initializePools() so the critical tap is
        // live before a pool-init failure. Tests call _hydrateAcks() directly
        // for deterministic, awaited assertions instead of racing this call.
        this._hydrateAcks().catch(() => {
            /* _hydrateAcks never throws — defensive only */
        });

        logger.notice(notificationMessages.NOTIFIER_STARTED(pollIntervalMs), {
            _noNotify: true, // R1b loop guard
        });
        return { started: true };
    }

    /**
     * Tears down the poll timer and unsubscribes the critical logger tap.
     * Called from graceful shutdown. Does not await any in-flight send —
     * each send already carries its own SMTP timeout via `SharedTransporter`.
     */
    stop() {
        if (this._pollTimer) {
            clearInterval(this._pollTimer);
            this._pollTimer = null;
        }
        if (this._criticalWindowTimer) {
            clearTimeout(this._criticalWindowTimer);
            this._criticalWindowTimer = null;
        }
        if (this._retentionSweepTimer) {
            clearInterval(this._retentionSweepTimer);
            this._retentionSweepTimer = null;
        }
        if (this._unsubscribeTap) {
            this._unsubscribeTap();
            this._unsubscribeTap = null;
        }
        const wasRunning = this._running;
        this._running = false;
        if (wasRunning) {
            logger.notice(notificationMessages.NOTIFIER_STOPPED(), {
                _noNotify: true, // R1b loop guard
            });
        }
    }

    // ─── Env-driven configuration (read live, not frozen at construction —
    // keeps this instance testable across process.env mutations per test) ────

    _pollIntervalMs() {
        return Number(process.env.ALERT_POLL_INTERVAL_MS) || 60_000;
    }

    _cooldownMs() {
        return (Number(process.env.ALERT_EMAIL_COOLDOWN_MIN) || 30) * 60_000;
    }

    _notifyRecovery() {
        return String(process.env.ALERT_NOTIFY_RECOVERY ?? "true").toLowerCase() !== "false";
    }

    _recoveryConfirmPolls() {
        return Number(process.env.ALERT_RECOVERY_CONFIRM_POLLS) || 3;
    }

    _digestWindowMs() {
        return Number(process.env.CRITICAL_DIGEST_WINDOW_MS) || 30_000;
    }

    _maxEmailsPerHour() {
        return Number(process.env.CRITICAL_MAX_EMAILS_PER_HOUR) || 10;
    }

    /**
     * Phase 4 — hours an acknowledgement stays valid before it lapses on its
     * own (safety net #2, TTL expiry). Read live from env (not frozen at
     * construction) so tests can change it per-case.
     * @returns {number}
     */
    _ackTtlHours() {
        return Number(process.env.ALERT_ACK_TTL_HOURS) || 24;
    }

    // ─── Rule → channel mapping ───────────────────────────────────────────────

    /**
     * Maps an alert rule to its notification channel. Unmapped rules fall
     * back to `server-system-notification` with a warning log — a new rule
     * added to `evaluateAlerts` without a mapping here is never silently
     * dropped.
     *
     * @param {string} rule - Alert rule identifier (e.g. "HIGH_HEAP")
     * @returns {string} Channel key
     */
    static mapRuleToChannel(rule) {
        const channel = RULE_CHANNEL_MAP[rule];
        if (channel) return channel;
        logger.warning(notificationMessages.UNMAPPED_RULE(rule), {
            _noNotify: true, // R1b loop guard
        });
        return FALLBACK_CHANNEL;
    }

    // ─── Metrics poll path ────────────────────────────────────────────────────

    /**
     * One poll iteration: evaluates alerts, diffs against the last known
     * state per identity, and dispatches at most one digest email per
     * channel for this tick (transitions) plus at most one recovery digest
     * per channel (a channel with BOTH an escalation and a recovery in the
     * same tick sends two emails — a rare edge case, still far below one
     * email per alert). Exposed (not env-gated) so tests can drive it
     * directly without waiting on the real interval.
     *
     * @returns {Promise<void>}
     */
    async _pollTick() {
        // Retry any alert-log rows queued during a prior DB outage before
        // doing anything else this tick (Phase 3 "flush on pool recovery" —
        // piggybacks on the poll cadence rather than a dedicated timer).
        this._flushAlertLogQueue().catch(() => {
            /* _flushAlertLogQueue never throws — defensive only */
        });

        let snapshot;
        let alerts;
        try {
            snapshot = MetricsService.getSnapshot();
            alerts = MetricsService.evaluateAlerts(snapshot);
        } catch (err) {
            logger.warning(
                notificationMessages.EMAIL_FAILED("poll", err?.message ?? String(err)),
                { _noNotify: true }, // R1b loop guard
            );
            return;
        }

        const seenKeys = new Set();
        const activeByChannel = new Map();
        const recoveryByChannel = new Map();

        for (const alert of alerts) {
            const scope = alert.route ?? alert.pool ?? "global";
            const key = `${alert.rule}::${scope}`;
            seenKeys.add(key);
            const channel = AlertNotifierService.mapRuleToChannel(alert.rule);

            let state = this._alertStates.get(key);
            if (!state) {
                state = {
                    status: "OK",
                    clearPollCount: 0,
                    lastNotifiedAt: null,
                    channel,
                    rule: alert.rule,
                    scope,
                    lastAlert: null,
                };
                this._alertStates.set(key, state);
            }

            const prevStatus = state.status;
            const newStatus = String(alert.severity || "warning").toUpperCase();
            state.clearPollCount = 0;
            state.channel = channel;
            state.lastAlert = alert;

            // Phase 4 — ack guard, evaluated every tick (not just at cooldown
            // time) so a stale ack never lingers past the instant an incident
            // genuinely worsens or its TTL lapses. Side effects only (clears
            // the ack when TTL-expired or escalated past its baseline); the
            // returned `suppress` flag is consulted ONLY by the RENOTIFIED
            // branch below — FIRED/ESCALATED already send unconditionally and
            // de-escalation never sends, so an ack can never block them.
            const ackInfo = this._checkAndUpdateAck(key, newStatus);

            let shouldSend = false;
            let transitionType = null;
            if (prevStatus === "OK" && newStatus !== "OK") {
                shouldSend = true; // OK -> WARNING | OK -> CRITICAL
                transitionType = "FIRED";
            } else if (prevStatus === "WARNING" && newStatus === "CRITICAL") {
                shouldSend = true; // escalation
                transitionType = "ESCALATED";
            } else if (prevStatus === "CRITICAL" && newStatus === "WARNING") {
                shouldSend = false; // de-escalation — no email, recovery covers the eventual OK
            } else if (newStatus === prevStatus) {
                const lastNotifiedAt = state.lastNotifiedAt;
                const cooldownElapsed = !lastNotifiedAt || Date.now() - lastNotifiedAt >= this._cooldownMs();
                transitionType = "RENOTIFIED";
                if (cooldownElapsed && ackInfo.suppress) {
                    logger.info(notificationMessages.ALERT_ACK_SUPPRESSED(key), {
                        _noNotify: true, // R1b loop guard
                    });
                }
                shouldSend = cooldownElapsed && !ackInfo.suppress;
            }

            if (shouldSend) {
                logger.info(
                    notificationMessages.ALERT_TRANSITION(alert.rule, scope, prevStatus, newStatus, channel),
                    { _noNotify: true }, // R1b loop guard
                );
                if (!activeByChannel.has(channel)) activeByChannel.set(channel, []);
                activeByChannel.get(channel).push({ alert, key, transitionType });
            }

            state.status = newStatus;
        }

        // Recovery scan — anything previously tracked but absent this tick.
        const notifyRecovery = this._notifyRecovery();
        const confirmPolls = this._recoveryConfirmPolls();
        for (const [key, state] of this._alertStates) {
            if (seenKeys.has(key)) continue;
            if (state.status === "OK") continue;

            state.clearPollCount = (state.clearPollCount || 0) + 1;
            if (notifyRecovery && state.clearPollCount >= confirmPolls) {
                logger.info(
                    notificationMessages.ALERT_TRANSITION(state.rule, state.scope, state.status, "OK", state.channel),
                    { _noNotify: true }, // R1b loop guard
                );
                if (!recoveryByChannel.has(state.channel)) recoveryByChannel.set(state.channel, []);
                recoveryByChannel.get(state.channel).push({ state, key });
                state.status = "OK";
                state.clearPollCount = 0;
                // Phase 4 — recovery always clears any ack: a later re-fire of
                // the same identity is a new incident and needs a fresh
                // acknowledgement decision, not a stale leftover one.
                this._clearAck(key);
            }
            // else: still counting down before confirming recovery — no email yet (R4).
        }

        for (const [channel, events] of activeByChannel) {
            await this._dispatchMetricDigest(channel, events, snapshot, false);
            const now = Date.now();
            for (const { key } of events) {
                const st = this._alertStates.get(key);
                if (st) st.lastNotifiedAt = now;
            }
        }
        for (const [channel, events] of recoveryByChannel) {
            await this._dispatchMetricDigest(channel, events, snapshot, true);
        }
    }

    /**
     * Builds and sends ONE digest email for `channel` covering every event
     * gathered this tick (transitions OR recoveries — never mixed in a
     * single call).
     *
     * @param {string} channel
     * @param {Array<{ alert?: object, state?: object, key: string }>} events
     * @param {object} snapshot - The metrics snapshot this tick evaluated against
     * @param {boolean} isRecovery
     * @returns {Promise<void>}
     */
    async _dispatchMetricDigest(channel, events, snapshot, isRecovery) {
        const rows = events.map(({ alert, state }) => {
            const source = alert || state?.lastAlert || {};
            return {
                rule: source.rule ?? state?.rule ?? "UNKNOWN_RULE",
                scope: source.route ?? source.pool ?? state?.scope ?? "global",
                description: isRecovery
                    ? "Recovered — no longer firing."
                    : source.description ?? "",
                severity: isRecovery ? "resolved" : source.severity ?? "warning",
            };
        });

        const severity = isRecovery
            ? "RESOLVED"
            : events.some((e) => (e.alert?.severity || "").toLowerCase() === "critical")
              ? "CRITICAL"
              : "WARNING";

        const headline = isRecovery
            ? this._buildRecoveryHeadline(events)
            : this._buildActiveHeadline(events);

        const summary = isRecovery
            ? `${events.length} alert(s) on this channel cleared for ${this._recoveryConfirmPolls()} consecutive poll(s).`
            : `${events.length} alert(s) are active against the current metrics snapshot.`;

        const result = await ServerNotificationService.sendChannelDigest(channel, {
            severity,
            headline,
            summary,
            rows,
            throttleNote: "",
            kv: this._buildChannelKv(channel, snapshot),
        });

        // Phase 3 — write one history row per event covered by this digest
        // (never per poll tick; only on an actual transition/send attempt).
        // Fire-and-forget: the writer buffers/retries internally and must
        // never block or delay the notification path itself.
        this._writeAlertLogRows(
            events.map(({ alert, state, key, transitionType }) => {
                const source = alert || state?.lastAlert || {};
                const scope = source.route ?? source.pool ?? state?.scope ?? key?.split("::")[1] ?? "global";
                return {
                    alertKey: key,
                    rule: source.rule ?? state?.rule ?? "UNKNOWN_RULE",
                    severity,
                    transition: isRecovery ? "RECOVERED" : transitionType ?? "RENOTIFIED",
                    valueNum: typeof source.value === "number" ? source.value : null,
                    description: isRecovery ? "Recovered — no longer firing." : (source.description ?? null),
                    channel,
                    notificationId: result.notificationId ?? null,
                    emailStatus: this._emailStatusFor(result),
                    emailError: result.cause ?? null,
                    details: this._buildMetricAlertDetails(source, scope, snapshot, result),
                };
            }),
        ).catch(() => {
            /* _writeAlertLogRows never throws — defensive only */
        });
    }

    /**
     * Maps a `ServerNotificationService.sendChannelDigest` result to the
     * SERVER_ALERT_LOG EMAIL_STATUS enum.
     * @param {{ sent: boolean, reason?: string }} result
     * @returns {"SENT"|"DISABLED"|"FAILED"}
     */
    _emailStatusFor(result) {
        if (result.sent) return "SENT";
        if (result.reason === "disabled") return "DISABLED";
        return "FAILED";
    }

    /**
     * Builds the DETAILS payload for a metrics-poll alert-log row (see the
     * DETAILS contract in server-email-notifications-plan.md — "Metrics
     * alerts"). Pulls a small relevant slice of the snapshot per rule
     * family so the audit row is self-contained without duplicating the
     * whole snapshot.
     *
     * @param {object} alert - The alert object (or {} for a recovery row with no lastAlert)
     * @param {string} scope
     * @param {object} snapshot
     * @param {{ sent: boolean, cause?: string }} sendResult
     * @returns {object}
     */
    _buildMetricAlertDetails(alert, scope, snapshot, sendResult) {
        const details = {
            value: typeof alert.value === "number" ? alert.value : null,
            description: alert.description ?? null,
            uptime: snapshot?.uptime ?? null,
        };
        if (alert.route) details.route = alert.route;
        if (alert.pool) details.pool = alert.pool;

        if (alert.pool && snapshot?.dependencies?.oracle?.[alert.pool]) {
            const dep = snapshot.dependencies.oracle[alert.pool];
            details.snapshot = {
                connectionsInUse: dep.connectionsInUse,
                connectionsOpen: dep.connectionsOpen,
                queueLength: dep.queueLength,
            };
        } else if (alert.route && snapshot?.red?.[alert.route]) {
            const m = snapshot.red[alert.route];
            details.snapshot = { p99: m.p99, count: m.count };
        } else if (scope === "global" && snapshot?.system) {
            details.snapshot = {
                heapUsedMb: Math.round((snapshot.system.memory?.heapUsed ?? 0) / 1024 / 1024),
                heapLimitMb: Math.round((snapshot.system.memory?.heapSizeLimit ?? 0) / 1024 / 1024),
                eventLoopLagMs: snapshot.system.eventLoopLag ?? null,
                gcOverheadPct: snapshot.system.gc?.overheadPct ?? null,
            };
        }

        details.email = {
            smtpCause: sendResult.cause ?? null,
            recipientCount: sendResult.recipientCount ?? 0,
            attempt: 1,
        };

        return details;
    }

    _buildActiveHeadline(events) {
        if (events.length === 1) {
            return events[0].alert.description || events[0].alert.rule;
        }
        const worst = events.reduce((best, e) =>
            this._severityRank(e.alert.severity) > this._severityRank(best.alert.severity) ? e : best,
        );
        return `${events.length} alerts active — most severe: ${worst.alert.rule} (${(worst.alert.severity || "").toUpperCase()})`;
    }

    _buildRecoveryHeadline(events) {
        if (events.length === 1) return `${events[0].state.rule} back to normal`;
        return `${events.length} alert(s) recovered`;
    }

    _severityRank(severity) {
        return severity === "critical" ? 2 : severity === "warning" ? 1 : 0;
    }

    /**
     * Computes the channel-specific KV placeholder values from the metrics
     * snapshot this tick evaluated against.
     *
     * @param {string} channel
     * @param {object} snapshot
     * @returns {Record<string, string|number>}
     */
    _buildChannelKv(channel, snapshot) {
        if (channel === "server-dependencies-notification") {
            const pools = Object.values(snapshot?.dependencies?.oracle ?? {});
            const alertingPoolCount = pools.filter(
                (p) => typeof p.poolUtilization === "number" && p.poolUtilization > 0.8,
            ).length;
            const maxUtilization = pools.length
                ? `${Math.round(Math.max(...pools.map((p) => p.poolUtilization ?? 0)) * 100)}%`
                : "n/a";
            return { poolCount: pools.length, alertingPoolCount, maxUtilization };
        }

        if (channel === "server-red-metrics-notification") {
            const totals = snapshot?.totals ?? {};
            const entries = Object.entries(snapshot?.red ?? {});
            let topRoute = "n/a";
            let topRouteP95 = "n/a";
            if (entries.length) {
                const [route, m] = entries.reduce((best, cur) => (cur[1].p95 > best[1].p95 ? cur : best));
                topRoute = route;
                topRouteP95 = `${m.p95}ms`;
            }
            return {
                requestsTotal: totals.requestsTotal ?? 0,
                errorRatePct: `${((totals.errorRate ?? 0) * 100).toFixed(2)}%`,
                topRoute,
                topRouteP95,
            };
        }

        if (channel === "server-system-notification") {
            const mem = snapshot?.system?.memory ?? {};
            const heapUsedMb = Math.round((mem.heapUsed ?? 0) / 1024 / 1024);
            const heapLimitMb = Math.round((mem.heapSizeLimit ?? 0) / 1024 / 1024);
            const heapPct = heapLimitMb ? `${((heapUsedMb / heapLimitMb) * 100).toFixed(1)}%` : "n/a";
            return {
                heapUsedMb,
                heapLimitMb,
                heapPct,
                eventLoopLagMs: snapshot?.system?.eventLoopLag ?? 0,
                gcOverheadPct: `${snapshot?.system?.gc?.overheadPct ?? 0}%`,
            };
        }

        return {};
    }

    // ─── Critical log-tap path ────────────────────────────────────────────────

    /**
     * Critical logger tap handler — buffers one record and arms the digest
     * window timer on the first event of a new window. Exposed (not
     * private) so tests can drive it directly instead of subscribing a real
     * tap and waiting on real timers.
     *
     * @param {{ level: string, message: string, meta: object, requestId: string|null, timestamp: string }} record
     */
    _onCriticalLog(record) {
        this._criticalBuffer.push(record);
        if (!this._criticalWindowTimer) {
            const windowMs = this._digestWindowMs();
            this._criticalWindowTimer = setTimeout(() => {
                this._criticalWindowTimer = null;
                this._flushCriticalDigest().catch((err) => {
                    logger.warning(
                        notificationMessages.EMAIL_FAILED("server-critical-notification", err?.message ?? String(err)),
                        { _noNotify: true }, // R1b loop guard
                    );
                });
            }, windowMs);
            if (typeof this._criticalWindowTimer.unref === "function") this._criticalWindowTimer.unref();
        }
    }

    /**
     * Flushes the current critical-event buffer into one digest email,
     * subject to the hourly storm ceiling (R3). Exposed so tests can force a
     * flush without waiting on the real digest-window timer.
     *
     * @returns {Promise<void>}
     */
    async _flushCriticalDigest() {
        if (!this._criticalBuffer.length) return;
        const events = this._criticalBuffer;
        this._criticalBuffer = [];

        const now = Date.now();
        this._pruneHourly(now);

        if (this._criticalSentTimestamps.length >= this._maxEmailsPerHour()) {
            this._criticalSuppressedSinceLastSend += events.length;
            metricsStore.recordNotificationSuppressed("server-critical-notification", events.length);
            logger.warning(
                notificationMessages.STORM_SUPPRESSED(events.length, this._criticalSuppressedSinceLastSend),
                { _noNotify: true }, // R1b loop guard
            );
            // Phase 3 — ONE audit row per suppressed window (not one per
            // suppressed event, which would defeat the point of storm control).
            this._writeAlertLogRows([
                {
                    alertKey: "critical-log",
                    rule: "CRITICAL_LOG",
                    severity: "CRITICAL",
                    transition: "SUPPRESSED",
                    valueNum: events.length,
                    description: `${events.length} critical event(s) suppressed by the hourly ceiling.`,
                    channel: "server-critical-notification",
                    notificationId: null,
                    emailStatus: "SKIPPED",
                    emailError: null,
                    details: { suppressedCount: events.length, totalSuppressedSinceLastSend: this._criticalSuppressedSinceLastSend },
                },
            ]).catch(() => {
                /* _writeAlertLogRows never throws — defensive only */
            });
            return;
        }

        const suppressedNote =
            this._criticalSuppressedSinceLastSend > 0
                ? `${this._criticalSuppressedSinceLastSend} further event(s) were suppressed by the hourly ceiling before this digest.`
                : "";
        this._criticalSuppressedSinceLastSend = 0;
        this._criticalSentTimestamps.push(now);

        await this._dispatchCriticalDigest(events, suppressedNote);
    }

    _pruneHourly(now) {
        const cutoff = now - 3_600_000;
        this._criticalSentTimestamps = this._criticalSentTimestamps.filter((t) => t > cutoff);
    }

    /**
     * Sends the critical-channel digest for one flushed batch of events.
     *
     * @param {Array<{ level: string, message: string, meta: object, requestId: string|null, timestamp: string }>} events
     * @param {string} suppressedNote - "" or an "N further events suppressed" sentence
     * @returns {Promise<{ sent: boolean, notificationId?: string, reason?: string, cause?: string, recipientCount?: number }>}
     */
    async _dispatchCriticalDigest(events, suppressedNote) {
        const windowLabel = `${Math.round(this._digestWindowMs() / 1000)}s`;
        const firstEventAt = events[0]?.timestamp ?? new Date().toISOString();
        const rows = events.map((e) => ({
            level: e.level,
            module: e.meta?.function || e.meta?.file || "unknown",
            message: e.message,
            requestId: e.requestId,
            time: this._formatTimeOnly(e.timestamp),
        }));

        const headline =
            events.length === 1
                ? `${events[0].level}: ${this._truncate(events[0].message, 90)}`
                : `${events.length} critical events in ${windowLabel}`;

        const result = await ServerNotificationService.sendChannelDigest("server-critical-notification", {
            severity: "CRITICAL",
            headline,
            summary: `${events.length} crit/alert/emerg log event(s) were captured on this server instance.`,
            rows,
            throttleNote: suppressedNote,
            kv: { eventCount: events.length, windowLabel, firstEventAt },
        });

        // Phase 3 — one FIRED audit row per captured event, sharing this
        // digest's notificationId/emailStatus. Fire-and-forget (never blocks).
        this._writeAlertLogRows(
            events.map((e) => ({
                alertKey: "critical-log",
                rule: e.level,
                severity: "CRITICAL",
                transition: "FIRED",
                valueNum: null,
                description: this._truncate(e.message, 1000),
                channel: "server-critical-notification",
                notificationId: result.notificationId ?? null,
                emailStatus: this._emailStatusFor(result),
                emailError: result.cause ?? null,
                details: this._buildCriticalLogDetails(e, result),
            })),
        ).catch(() => {
            /* _writeAlertLogRows never throws — defensive only */
        });

        return result;
    }

    /**
     * Builds the DETAILS payload for a critical-tap alert-log row (DETAILS
     * contract — "Critical (logger-tap) events").
     *
     * @param {{ level: string, message: string, meta: object, requestId: string|null }} record
     * @param {{ sent: boolean, cause?: string, recipientCount?: number }} sendResult
     * @returns {object}
     */
    _buildCriticalLogDetails(record, sendResult) {
        const meta = record.meta ?? {};
        const callsite =
            meta.function && meta.file ? `${meta.function} @ ${meta.file}:${meta.line ?? "?"}` : null;
        return {
            level: record.level,
            message: record.message,
            meta,
            callsite,
            requestId: record.requestId ?? null,
            stack: meta.stack ?? null,
            email: {
                smtpCause: sendResult.cause ?? null,
                recipientCount: sendResult.recipientCount ?? 0,
                attempt: 1,
            },
        };
    }

    _formatTimeOnly(iso) {
        try {
            const d = new Date(iso);
            const hh = String(d.getHours()).padStart(2, "0");
            const mm = String(d.getMinutes()).padStart(2, "0");
            const ss = String(d.getSeconds()).padStart(2, "0");
            const ms = String(d.getMilliseconds()).padStart(3, "0");
            return `${hh}:${mm}:${ss}.${ms}`;
        } catch {
            return "00:00:00.000";
        }
    }

    _truncate(str, n) {
        const s = String(str ?? "");
        return s.length > n ? `${s.slice(0, n - 1)}…` : s;
    }

    /**
     * Best-effort, immediate (non-buffered) critical notification for
     * `server.js` process-crash handlers (`unhandledRejection` /
     * `uncaughtException`) — the process may be about to exit, so this
     * bypasses the normal digest-window buffering and races the send
     * against a short timeout rather than risking a hung shutdown.
     *
     * @param {{ level?: string, message: string, meta?: object }} opts
     * @returns {Promise<{ sent: boolean, notificationId?: string, reason?: string, cause?: string, recipientCount?: number }>}
     */
    async notifyCriticalNow({ level = "EMERGENCY", message, meta = {} } = {}) {
        if (!ServerNotificationService.isEnabled()) return { sent: false, reason: "disabled" };

        const record = {
            level,
            message: String(message ?? ""),
            meta,
            requestId: null,
            timestamp: new Date().toISOString(),
        };

        const sendPromise = this._dispatchCriticalDigest([record], "");
        const timeoutPromise = new Promise((resolve) => {
            const t = setTimeout(() => resolve({ sent: false, reason: "timeout" }), NOTIFY_NOW_TIMEOUT_MS);
            if (typeof t.unref === "function") t.unref();
        });

        return Promise.race([sendPromise, timeoutPromise]);
    }

    // ─── Phase 3: SERVER_ALERT_LOG persistence ───────────────────────────────
    // Writer fires on transitions + email outcomes ONLY (never per poll tick —
    // see call sites in _dispatchMetricDigest / _dispatchCriticalDigest /
    // _flushCriticalDigest's suppression branch). Best-effort: buffered in an
    // in-memory queue (cap ALERT_LOG_QUEUE_MAX) when the DB is down, retried
    // opportunistically (flush attempted at the top of every poll tick and
    // after every new write) — never blocks the notification path, never throws.

    /**
     * Queues `rows` for persistence and immediately attempts a flush.
     * Never throws — failures are logged at `warning` with `_noNotify: true`
     * and the rows stay queued for the next flush attempt.
     *
     * @param {object[]} rows - Pre-built SERVER_ALERT_LOG row objects (unsanitized DETAILS)
     * @returns {Promise<void>}
     */
    async _writeAlertLogRows(rows) {
        for (const row of rows) {
            this._alertLogQueue.push({ ...row, details: this._sanitizeDetails(row.details) });
            if (this._alertLogQueue.length > ALERT_LOG_QUEUE_MAX) this._alertLogQueue.shift(); // drop-oldest
        }
        await this._flushAlertLogQueue();
    }

    /**
     * Attempts to persist every queued row, in order, stopping at the first
     * failure (leaves the remainder queued — likely a DB outage, retried on
     * the next opportunity). Never throws.
     *
     * @returns {Promise<void>}
     */
    async _flushAlertLogQueue() {
        while (this._alertLogQueue.length) {
            const row = this._alertLogQueue[0];
            try {
                await ServerAlertLogModel.insertOne(row);
                this._alertLogQueue.shift();
            } catch (err) {
                logger.warning(
                    notificationMessages.EMAIL_FAILED("alert-log-write", err?.message ?? String(err)),
                    { _noNotify: true }, // R1b loop guard
                );
                break; // stop — preserve order, retry from here next time
            }
        }
    }

    /**
     * Sanitizes a DETAILS payload before it is persisted (mandatory —
     * server-email-notifications-plan.md DETAILS contract):
     *   - redacts any object key matching /password|token|secret|authorization|cookie/i
     *     (CWE-532 — sensitive data in log files)
     *   - caps a `stack` string at `MAX_STACK_CHARS` (2000, same cap as FE
     *     error ingestion)
     *   - caps the total serialized payload at `MAX_DETAILS_BYTES` (64 KB),
     *     replacing an oversized payload with a small `{ truncated: true, preview }` envelope
     *
     * @param {object|null} details
     * @returns {object|null}
     */
    _sanitizeDetails(details) {
        if (details == null) return null;

        const redact = (value) => {
            if (Array.isArray(value)) return value.map(redact);
            if (value && typeof value === "object") {
                const out = {};
                for (const [k, v] of Object.entries(value)) {
                    if (SENSITIVE_KEY_PATTERN.test(k)) {
                        out[k] = "[REDACTED]";
                    } else if (k === "stack" && typeof v === "string") {
                        out[k] = v.length > MAX_STACK_CHARS ? `${v.slice(0, MAX_STACK_CHARS)}…` : v;
                    } else {
                        out[k] = redact(v);
                    }
                }
                return out;
            }
            return value;
        };

        const redacted = redact(details);
        const json = JSON.stringify(redacted);
        if (Buffer.byteLength(json, "utf8") <= MAX_DETAILS_BYTES) return redacted;

        return {
            truncated: true,
            preview: json.slice(0, MAX_DETAILS_BYTES - 200),
        };
    }

    /**
     * Arms the daily retention-purge sweep. Mirrors the plain-`setInterval`,
     * once-per-day-check pattern already established for the wallet seeder's
     * PKG-resilience sweep in server.js (never node-cron, R6) — a
     * self-contained sweep here rather than hooking into that unrelated job
     * keeps the two concerns independently testable and avoids running a
     * purge when server email notifications are disabled.
     */
    _armRetentionSweep() {
        if (this._retentionSweepTimer) return;
        this._retentionSweepTimer = setInterval(() => {
            const today = new Date().toDateString();
            if (this._lastPurgeDay === today) return;
            this._lastPurgeDay = today;
            this._runRetentionPurge().catch((err) => {
                logger.warning(
                    notificationMessages.EMAIL_FAILED("alert-log-purge", err?.message ?? String(err)),
                    { _noNotify: true }, // R1b loop guard
                );
            });
        }, RETENTION_SWEEP_CHECK_MS);
        if (typeof this._retentionSweepTimer.unref === "function") this._retentionSweepTimer.unref();
    }

    /**
     * Deletes SERVER_ALERT_LOG rows older than `ALERT_LOG_RETENTION_DAYS`
     * (default 180). Never throws — failures log a warning and are retried
     * on the next daily check.
     * @returns {Promise<void>}
     */
    async _runRetentionPurge() {
        const days = Number(process.env.ALERT_LOG_RETENTION_DAYS) || 180;
        const deleted = await ServerAlertLogModel.purgeOlderThan(days);
        if (deleted > 0) {
            logger.notice(`AlertNotifierService: purged ${deleted} SERVER_ALERT_LOG row(s) older than ${days} days.`, {
                _noNotify: true, // R1b loop guard
            });
        }
    }

    // ─── Phase 4: Alert Acknowledgement ───────────────────────────────────────
    // server-email-notifications-plan.md "Phase 4 — Alert Acknowledgement".
    // acknowledge()/unacknowledge() are the public mutation surface (called
    // from MetricsController); _checkAndUpdateAck()/_clearAck() are the
    // poll-tick guard internals; _hydrateAcks() is the boot-time DB->Map
    // load; decorateAlertsWithAckState() is the GET /alerts read-side
    // enrichment (acknowledged/ackedBy/ackedByName/ackedAt/ackExpiresAt).

    /**
     * Numeric rank for the two ack-relevant severities — used ONLY to
     * compare "did this alert escalate past its acknowledgement baseline".
     * WARNING=1, CRITICAL=2, anything else (defensive) = 0.
     *
     * @param {string} status
     * @returns {number}
     */
    _ackSeverityRank(status) {
        const s = String(status || "").toUpperCase();
        return s === "CRITICAL" ? 2 : s === "WARNING" ? 1 : 0;
    }

    /**
     * Evaluates the Phase 4 ack guard for `alertKey` at the current tick's
     * `currentStatus`. Both safety nets are enforced HERE, live, every tick
     * — no separate sweep job:
     *   - TTL expiry: `now >= expiresAt` -> the ack lapses on its own.
     *   - Escalation override: `currentStatus` ranks higher than the
     *     severity recorded at ack time -> the ack is cleared immediately so
     *     a genuinely worsening incident is never silently muted.
     * Clearing removes both the in-memory entry and the persisted row
     * (best-effort — a delete failure only logs a warning; the in-memory
     * clear alone already makes the guard behave correctly for this process
     * going forward).
     *
     * @param {string} alertKey
     * @param {string} currentStatus - "WARNING" | "CRITICAL" (never called with "OK")
     * @returns {{ suppress: boolean }} `suppress: true` only when a still-
     *   valid, non-expired, non-escalated ack should silence a cooldown resend.
     */
    _checkAndUpdateAck(alertKey, currentStatus) {
        const entry = this._acks.get(alertKey);
        if (!entry) return { suppress: false };

        if (Date.now() >= entry.expiresAt) {
            this._clearAck(alertKey);
            logger.info(notificationMessages.ALERT_ACK_EXPIRED(alertKey), {
                _noNotify: true, // R1b loop guard
            });
            return { suppress: false };
        }

        if (this._ackSeverityRank(currentStatus) > this._ackSeverityRank(entry.severityAtAck)) {
            this._clearAck(alertKey);
            // Deliberately NOT _noNotify (server-email-notifications-plan.md
            // Phase 4) — a normal operational event, safe to see in logs,
            // and not itself part of the notification send path.
            logger.notice(
                notificationMessages.ALERT_ACK_ESCALATION_CLEARED(alertKey, entry.severityAtAck, currentStatus),
            );
            return { suppress: false };
        }

        return { suppress: true };
    }

    /**
     * Clears an ack's in-memory entry and best-effort deletes its persisted
     * row. Never throws — a delete failure only logs a warning; in the
     * (rare) case the delete never lands, the row would simply re-hydrate
     * as "still acked" on the next restart, which is the fail-safe
     * direction (an ack surviving one extra restart, never an escalation
     * silently muted forever — TTL still bounds it either way).
     *
     * @param {string} alertKey
     */
    _clearAck(alertKey) {
        if (!this._acks.delete(alertKey)) return;
        ServerAlertAckModel.remove(alertKey).catch((err) => {
            logger.warning(
                notificationMessages.EMAIL_FAILED("ack-clear", err?.message ?? String(err)),
                { _noNotify: true }, // R1b loop guard
            );
        });
    }

    /**
     * Hydrates the in-memory ack Map from SERVER_ALERT_ACK. Called
     * fire-and-forget from start() (never awaited there — see the comment
     * at that call site) and directly/awaited from tests for deterministic
     * assertions. Rows whose TTL already lapsed while the process was down
     * are skipped (never resurrected) and opportunistically deleted. Never
     * throws.
     *
     * @returns {Promise<void>}
     */
    async _hydrateAcks() {
        try {
            const rows = await ServerAlertAckModel.findAll();
            const now = Date.now();
            let loaded = 0;
            for (const row of rows) {
                const expiresAt = row.EXPIRES_AT instanceof Date
                    ? row.EXPIRES_AT.getTime()
                    : new Date(row.EXPIRES_AT).getTime();
                const ackedAt = row.ACKED_AT instanceof Date
                    ? row.ACKED_AT.getTime()
                    : new Date(row.ACKED_AT).getTime();

                if (Number.isFinite(expiresAt) && expiresAt <= now) {
                    // Lapsed during the outage window — never resurrect it.
                    ServerAlertAckModel.remove(row.ALERT_KEY).catch(() => {
                        /* best-effort cleanup only */
                    });
                    continue;
                }

                this._acks.set(row.ALERT_KEY, {
                    ackedBy: Number(row.ACKED_BY),
                    ackedAt,
                    expiresAt,
                    severityAtAck: row.SEVERITY_AT_ACK,
                    note: row.NOTE ?? null,
                });
                loaded++;
            }
            logger.notice(notificationMessages.ACK_HYDRATED(loaded), {
                _noNotify: true, // R1b loop guard
            });
        } catch (err) {
            logger.warning(
                notificationMessages.EMAIL_FAILED("ack-hydrate", err?.message ?? String(err)),
                { _noNotify: true }, // R1b loop guard
            );
        }
    }

    /**
     * Acknowledges an alert — silences cooldown re-notify emails while the
     * ack is active (not expired, not escalated past `severityAtAck`). Both
     * safety nets are enforced in `_checkAndUpdateAck`, not here.
     *
     * @param {string} alertKey - Identity key: rule + "::" + (route ?? pool ?? "global")
     * @param {string|number} ackedBy - EMP_ID of the acknowledging admin
     * @param {string} [note]
     * @returns {Promise<{ alertKey: string, acknowledged: true, ackedBy: number, ackedAt: string, ackExpiresAt: string, severityAtAck: string, note: string|null }>}
     * @throws {AppError} 400 ALERT_KEY_REQUIRED | 404 ALERT_NOT_FOUND | 400 ALERT_NOT_ACTIVE | 502 ACK_WRITE_FAILED
     */
    async acknowledge(alertKey, ackedBy, note) {
        if (!alertKey || typeof alertKey !== "string") {
            throw new AppError(NOTIFICATION_ERRORS.ALERT_KEY_REQUIRED, 400, {
                type: "ValidationError",
            });
        }

        const state = this._alertStates.get(alertKey);
        if (!state) {
            throw new AppError(NOTIFICATION_ERRORS.ALERT_NOT_FOUND, 404, {
                type: "NotFoundError",
            });
        }
        if (state.status === "OK") {
            throw new AppError(NOTIFICATION_ERRORS.ALERT_NOT_ACTIVE, 400, {
                type: "ValidationError",
            });
        }

        const ackedAtMs = Date.now();
        const expiresAtMs = ackedAtMs + this._ackTtlHours() * 3_600_000;
        const severityAtAck = state.status; // "WARNING" | "CRITICAL"
        const normalizedNote = note != null && note !== "" ? String(note).slice(0, 500) : null;

        try {
            await ServerAlertAckModel.upsert({
                alertKey,
                ackedBy: Number(ackedBy),
                expiresAt: new Date(expiresAtMs),
                severityAtAck,
                note: normalizedNote,
            });
        } catch (err) {
            logger.warning(
                notificationMessages.EMAIL_FAILED("ack-write", err?.message ?? String(err)),
                { _noNotify: true }, // R1b loop guard
            );
            throw new AppError(NOTIFICATION_ERRORS.ACK_WRITE_FAILED, 502, {
                type: "NotificationError",
                hint: err?.message,
            });
        }

        this._acks.set(alertKey, {
            ackedBy: Number(ackedBy),
            ackedAt: ackedAtMs,
            expiresAt: expiresAtMs,
            severityAtAck,
            note: normalizedNote,
        });

        logger.info(
            notificationMessages.ALERT_ACKNOWLEDGED(alertKey, Number(ackedBy), new Date(expiresAtMs).toISOString()),
            { _noNotify: true }, // R1b loop guard
        );

        return {
            alertKey,
            acknowledged: true,
            ackedBy: Number(ackedBy),
            ackedAt: new Date(ackedAtMs).toISOString(),
            ackExpiresAt: new Date(expiresAtMs).toISOString(),
            severityAtAck,
            note: normalizedNote,
        };
    }

    /**
     * Clears an acknowledgement — explicit admin "never mind".
     *
     * @param {string} alertKey
     * @returns {Promise<{ alertKey: string, acknowledged: false }>}
     * @throws {AppError} 400 ALERT_KEY_REQUIRED | 404 ACK_NOT_FOUND | 502 ACK_WRITE_FAILED
     */
    async unacknowledge(alertKey) {
        if (!alertKey || typeof alertKey !== "string") {
            throw new AppError(NOTIFICATION_ERRORS.ALERT_KEY_REQUIRED, 400, {
                type: "ValidationError",
            });
        }
        if (!this._acks.has(alertKey)) {
            throw new AppError(NOTIFICATION_ERRORS.ACK_NOT_FOUND, 404, {
                type: "NotFoundError",
            });
        }

        try {
            await ServerAlertAckModel.remove(alertKey);
        } catch (err) {
            logger.warning(
                notificationMessages.EMAIL_FAILED("ack-write", err?.message ?? String(err)),
                { _noNotify: true }, // R1b loop guard
            );
            throw new AppError(NOTIFICATION_ERRORS.ACK_WRITE_FAILED, 502, {
                type: "NotificationError",
                hint: err?.message,
            });
        }

        this._acks.delete(alertKey);
        logger.info(notificationMessages.ALERT_UNACKNOWLEDGED(alertKey), {
            _noNotify: true, // R1b loop guard
        });

        return { alertKey, acknowledged: false };
    }

    /**
     * Decorates raw `MetricsService.evaluateAlerts()` alerts with Phase 4 ack
     * state for `GET /api/v1/metrics/alerts` (server-email-notifications-
     * plan.md "Routes" — each active alert row gains `alertKey`,
     * `acknowledged`, `ackedBy`, `ackedByName`, `ackedAt`, `ackExpiresAt` so
     * the FE can render ack state without a second round-trip). `ackedByName`
     * is resolved via ONE batched `AdminModel.getNamesByIds` call regardless of
     * how many acked alerts are present — O(n) alerts + O(1) name-resolution
     * round-trip, not O(n) round-trips.
     *
     * @param {Array<object>} alerts - Raw alert objects from evaluateAlerts()
     * @returns {Promise<Array<object>>}
     */
    async decorateAlertsWithAckState(alerts) {
        if (!alerts || alerts.length === 0) return alerts ?? [];

        const keyFor = (alert) => `${alert.rule}::${alert.route ?? alert.pool ?? "global"}`;

        const ackedAdminIds = [];
        for (const alert of alerts) {
            const entry = this._acks.get(keyFor(alert));
            if (entry) ackedAdminIds.push(entry.ackedBy);
        }
        const nameMap = ackedAdminIds.length
            ? await AdminModel.getNamesByIds(ackedAdminIds)
            : new Map();

        return alerts.map((alert) => {
            const alertKey = keyFor(alert);
            const entry = this._acks.get(alertKey);
            if (!entry) {
                return {
                    ...alert,
                    alertKey,
                    acknowledged: false,
                    ackedBy: null,
                    ackedByName: null,
                    ackedAt: null,
                    ackExpiresAt: null,
                    ackNote: null,
                };
            }
            return {
                ...alert,
                alertKey,
                acknowledged: true,
                ackedBy: entry.ackedBy,
                ackedByName: nameMap.get(Number(entry.ackedBy)) ?? null,
                ackedAt: new Date(entry.ackedAt).toISOString(),
                ackExpiresAt: new Date(entry.expiresAt).toISOString(),
                ackNote: entry.note ?? null,
            };
        });
    }

    // ─── Admin visibility (routes) ────────────────────────────────────────────

    /**
     * Snapshot for `GET /api/v1/metrics/notifications/status` — enabled
     * flag, masked recipients per channel, active alert states, and the
     * recent-sends ring buffer.
     *
     * @returns {Promise<{
     *   enabled: boolean,
     *   recipients: Record<string, string[]>,
     *   pollIntervalMs: number,
     *   cooldownMin: number,
     *   recoveryEnabled: boolean,
     *   recoveryConfirmPolls: number,
     *   criticalDigestWindowMs: number,
     *   criticalMaxEmailsPerHour: number,
     *   ackTtlHours: number,
     *   running: boolean,
     *   activeAlerts: Array<{ rule: string, scope: string, channel: string, status: string, lastNotifiedAt: string|null }>,
     *   recentSends: Array<object>,
     * }>}
     */
    async getStatus() {
        const recipients = {};
        for (const channel of ServerNotificationService.CHANNELS) {
            const emails = await ServerNotificationService.resolveRecipients(channel);
            recipients[channel] = emails.map(ServerNotificationService.maskEmail);
        }

        const activeAlerts = [...this._alertStates.values()]
            .filter((s) => s.status !== "OK")
            .map((s) => ({
                rule: s.rule,
                scope: s.scope,
                channel: s.channel,
                status: s.status,
                lastNotifiedAt: s.lastNotifiedAt ? new Date(s.lastNotifiedAt).toISOString() : null,
            }));

        return {
            enabled: ServerNotificationService.isEnabled(),
            recipients,
            pollIntervalMs: this._pollIntervalMs(),
            cooldownMin: Number(process.env.ALERT_EMAIL_COOLDOWN_MIN) || 30,
            recoveryEnabled: this._notifyRecovery(),
            recoveryConfirmPolls: this._recoveryConfirmPolls(),
            criticalDigestWindowMs: this._digestWindowMs(),
            criticalMaxEmailsPerHour: this._maxEmailsPerHour(),
            ackTtlHours: this._ackTtlHours(),
            running: this._running,
            activeAlerts,
            recentSends: await this._getRecentSends(),
        };
    }

    /**
     * Phase 3: table-backed "recent sends" for the status endpoint, reading
     * the last 20 SERVER_ALERT_LOG rows. Falls back to
     * `ServerNotificationService`'s small in-memory ring buffer (v1 behavior)
     * when the DB read fails — the status endpoint must never break just
     * because the audit table is unreachable.
     *
     * @returns {Promise<Array<{ channel: string, notificationId: string|null, sent: boolean, headline: string, reason: string|null, at: string }>>}
     */
    async _getRecentSends() {
        try {
            const rows = await ServerAlertLogModel.findRecent(20);
            return rows.map((r) => ({
                channel: r.CHANNEL,
                notificationId: r.NOTIFICATION_ID ?? null,
                sent: r.EMAIL_STATUS === "SENT",
                headline: r.DESCRIPTION ?? "",
                reason: r.EMAIL_ERROR ?? null,
                at: r.CREATED_AT instanceof Date ? r.CREATED_AT.toISOString() : r.CREATED_AT,
            }));
        } catch (err) {
            logger.warning(
                notificationMessages.EMAIL_FAILED("alert-log-read", err?.message ?? String(err)),
                { _noNotify: true }, // R1b loop guard
            );
            return ServerNotificationService.getRecentSends();
        }
    }

    /**
     * Offset-paginated alert/notification history for
     * `GET /api/v1/metrics/alerts/history` (Phase 3). Thin passthrough to
     * `ServerAlertLogModel.findPage` — kept on this service (not the
     * controller) since AlertNotifierService already owns the whole Phase 3
     * domain (the writer that populates this table).
     *
     * @param {{ rule?: string, severity?: string, from?: Date, to?: Date }} [filters]
     * @param {{ page?: number, limit?: number }} [opts]
     * @returns {Promise<{ rows: object[], total: number, page: number, limit: number }>}
     */
    async getAlertHistory(filters = {}, opts = {}) {
        return ServerAlertLogModel.findPage(filters, opts);
    }

    /**
     * Sends a manually triggered test email on `channel` for
     * `POST /api/v1/metrics/notifications/test`. Throws `AppError` (never
     * silently no-ops) so the requesting admin sees a real failure —
     * different from the internal fire-and-forget contract, since a human
     * explicitly asked for this send.
     *
     * @param {string} channel - One of `ServerNotificationService.CHANNELS`
     * @param {{ userId?: string, sub?: string }} [user] - Decoded JWT payload of the requester
     * @returns {Promise<{ sent: boolean, notificationId?: string }>}
     * @throws {AppError} 400 CHANNEL_UNKNOWN | 502 TEST_SEND_FAILED
     */
    async sendTestNotification(channel, user) {
        if (!ServerNotificationService.CHANNELS.includes(channel)) {
            throw new AppError(NOTIFICATION_ERRORS.CHANNEL_UNKNOWN, 400, {
                type: "ValidationError",
                hint: `channel must be one of: ${ServerNotificationService.CHANNELS.join(", ")}`,
            });
        }

        const testedBy = user?.userId ?? user?.sub ?? "an admin";
        const result = await ServerNotificationService.sendChannelDigest(channel, {
            severity: "WARNING",
            headline: "Test notification",
            summary: `This is a test email triggered manually by ${testedBy} to verify the ${channel} channel is configured correctly.`,
            rows: [this._buildTestRow(channel)],
            throttleNote: "",
            kv: this._buildTestKv(channel),
        });

        if (!result.sent) {
            throw new AppError(NOTIFICATION_ERRORS.TEST_SEND_FAILED, 502, {
                type: "NotificationError",
                hint: result.reason,
            });
        }
        return result;
    }

    _buildTestRow(channel) {
        if (channel === "server-critical-notification") {
            return {
                level: "CRITICAL",
                module: "AlertNotifierService",
                message: "Test critical event — no action needed.",
                requestId: null,
                time: this._formatTimeOnly(new Date().toISOString()),
            };
        }
        return {
            rule: "TEST_NOTIFICATION",
            scope: "global",
            description: "This is a manually triggered test alert — no action needed.",
            severity: "warning",
        };
    }

    _buildTestKv(channel) {
        switch (channel) {
            case "server-critical-notification":
                return { eventCount: 1, windowLabel: "test", firstEventAt: new Date().toISOString() };
            case "server-dependencies-notification":
                return { poolCount: 0, alertingPoolCount: 0, maxUtilization: "n/a" };
            case "server-red-metrics-notification":
                return { requestsTotal: 0, errorRatePct: "0.00%", topRoute: "n/a", topRouteP95: "n/a" };
            case "server-system-notification":
                return { heapUsedMb: 0, heapLimitMb: 0, heapPct: "n/a", eventLoopLagMs: 0, gcOverheadPct: "0%" };
            default:
                return {};
        }
    }
}

const instance = new AlertNotifierService();
module.exports = instance;
module.exports.AlertNotifierService = AlertNotifierService;
