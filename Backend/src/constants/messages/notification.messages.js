"use strict";

/**
 * @fileoverview Log message templates for the Server Email Notifications feature
 * (ServerNotificationService + AlertNotifierService + the logger critical tap).
 * Used ONLY in logger.* calls — never thrown or sent to clients.
 *
 * LOOP-GUARD NOTE: every log site that
 * uses one of these templates from inside ServerNotificationService or
 * AlertNotifierService MUST also pass meta `{ _noNotify: true }` so the
 * `logger.onLevel` critical tap never re-triggers a notification from the
 * notification path itself. See src/utils/logger.js `onLevel`.
 */

const notificationMessages = {
    /**
     * Logged once when AlertNotifierService successfully arms the metrics
     * poller and subscribes to the critical logger tap.
     * @param {number} pollIntervalMs - Metrics poll interval in milliseconds
     * @returns {string}
     */
    NOTIFIER_STARTED: (pollIntervalMs) =>
        `AlertNotifierService started — polling metrics every ${pollIntervalMs}ms for dependency/red/system alerts and subscribed to the critical logger tap.`,

    /**
     * Logged once when AlertNotifierService.stop() tears down the poll timer
     * and unsubscribes the critical logger tap (graceful shutdown).
     * @returns {string}
     */
    NOTIFIER_STOPPED: () =>
        "AlertNotifierService stopped — poll timer cleared and critical logger tap unsubscribed.",

    /**
     * beginShutdown() ran: poll + retention sweep stopped, critical tap stays live.
     * @returns {string}
     */
    /**
     * Daily alert-log retention purge removed rows. MUST be logged with
     * `{ _noNotify: true }` (loop guard R1b).
     * @param {number} deleted Rows removed.
     * @param {number} days    Retention window in days.
     * @returns {string}
     */
    RETENTION_PURGED: (deleted, days) =>
        `AlertNotifierService: purged ${deleted} SERVER_ALERT_LOG row(s) older than ${days} days.`,

    NOTIFIER_SHUTDOWN_BEGUN: () =>
        "AlertNotifierService shutdown begun — metrics poll and retention sweep stopped; critical logger tap stays live until the final flush.",

    /**
     * Shutdown critical-digest flush finished (phase 1 or final).
     * @param {number} events Buffered critical events at flush start.
     * @param {string} outcome "done" | "timeout" | "error".
     * @returns {string}
     */
    NOTIFIER_SHUTDOWN_FLUSH: (events, outcome) =>
        `AlertNotifierService shutdown flush — ${events} buffered critical event(s), outcome: ${outcome}.`,

    /**
     * Final flush skipped because no time was left before the forced exit.
     * @param {number} events Buffered critical events left unsent.
     * @returns {string}
     */
    NOTIFIER_FINAL_FLUSH_SKIPPED: (events) =>
        `AlertNotifierService final flush skipped — no time left before the forced exit; ${events} buffered critical event(s) not emailed yet.`,

    /**
     * stop() hard-stopped with buffered criticals still unsent.
     * @param {number} n Discarded critical event count.
     * @returns {string}
     */
    NOTIFIER_STOP_DISCARDED: (n) =>
        `AlertNotifierService.stop() discarded ${n} buffered critical event(s) without emailing — graceful shutdown must use drainAndStop().`,

    /**
     * Digest emailed without SERVER_ALERT_LOG rows (Oracle pools already closed).
     * @param {number} n Rows not persisted.
     * @returns {string}
     */
    /**
     * Shutdown phase 1 saved the buffered criticals' rows before the pools closed;
     * their email follows after the stop is marked clean.
     * @param {number} n Rows saved.
     * @returns {string}
     */
    SHUTDOWN_ROWS_SAVED_EMAIL_DEFERRED: (n) =>
        `AlertNotifierService shutdown — ${n} buffered critical row(s) saved before the pools close; the email follows after the stop is marked clean.`,

    /**
     * EMAIL_ERROR stored on a critical row saved at shutdown before its email was
     * sent (EMAIL_STATUS 'SKIPPED'; the allowed statuses have no "pending").
     */
    SHUTDOWN_ROW_EMAIL_NOTE: "emailed during shutdown, after this row was saved; delivery not recorded",

    ALERT_LOG_ROWS_SKIPPED_SHUTDOWN: (n) =>
        `${n} SERVER_ALERT_LOG row(s) not persisted — the final shutdown flush runs after the Oracle pools closed.`,

    /**
     * Logged once at boot when start() is called but server email notifications
     * are disabled (master switch off, or no recipients configured).
     * @param {string} reason - Human-readable reason (e.g. "ENABLE_SERVER_NOTIFICATIONS is not 'true'")
     * @returns {string}
     */
    NOTIFIER_DISABLED: (reason) =>
        `AlertNotifierService not started — server email notifications are disabled (${reason}).`,

    /**
     * Logged after a channel digest email is dispatched successfully.
     * @param {string} channel        - Channel key (e.g. "server-system-notification")
     * @param {string} notificationId - Snowflake-based digest id stamped on the email
     * @returns {string}
     */
    EMAIL_SENT: (channel, notificationId) =>
        `Server notification email sent on channel '${channel}' (${notificationId}).`,

    /**
     * Logged when a channel digest email fails to send (SMTP error, no
     * recipients, etc.). Never thrown — fire-and-forget per R1a.
     * @param {string} channel - Channel key
     * @param {string} cause   - Failure reason (SMTP error message, or a
     *                           short synthetic reason like "no resolvable recipients")
     * @returns {string}
     */
    EMAIL_FAILED: (channel, cause) =>
        `Server notification email failed on channel '${channel}': ${cause}`,

    /**
     * Logged when the Access Control opt-in lookup does not answer within
     * the wait budget — the send proceeds with the last known recipients.
     * @param {number} ms - Wait budget in milliseconds
     * @returns {string}
     */
    RECIPIENT_REFRESH_WAIT_EXCEEDED: (ms) =>
        `Server notification recipients: the Access Control opt-in lookup did not answer within ${ms} ms; sending to the last known list and SERVER_NOTIFY_TO (the lookup continues in the background)`,

    /**
     * Logged whenever an alert identity transitions state and a digest email
     * is queued for its mapped channel (escalation, cooldown re-notify, or
     * recovery).
     * @param {string} rule       - Alert rule identifier (e.g. "HIGH_HEAP")
     * @param {string} scope      - "global" | route | pool name
     * @param {string} fromStatus - Previous state ("OK" | "WARNING" | "CRITICAL")
     * @param {string} toStatus   - New state ("OK" | "WARNING" | "CRITICAL")
     * @param {string} channel    - Mapped channel key
     * @returns {string}
     */
    ALERT_TRANSITION: (rule, scope, fromStatus, toStatus, channel) =>
        `Alert transition: ${rule} (${scope}) ${fromStatus} -> ${toStatus} on channel '${channel}'.`,

    /**
     * Logged when the critical channel's hourly email ceiling is hit and a
     * digest window is dropped instead of sent (R3 storm control).
     * @param {number} count           - Events dropped in this window
     * @param {number} totalSuppressed - Running suppressed count since the last successful send
     * @returns {string}
     */
    STORM_SUPPRESSED: (count, totalSuppressed) =>
        `Critical digest suppressed by the hourly ceiling — ${count} event(s) dropped this window (${totalSuppressed} suppressed since the last successful send).`,

    /**
     * Logged when evaluateAlerts() returns a rule with no static channel
     * mapping — the alert still gets emailed via the fallback channel so it
     * is never silently dropped.
     * @param {string} rule - Unmapped alert rule identifier
     * @returns {string}
     */
    UNMAPPED_RULE: (rule) =>
        `Alert rule '${rule}' has no channel mapping — falling back to server-system-notification.`,

    /**
     * Logged when the notification status endpoint is read.
     * @returns {string}
     */
    STATUS_FETCHED: () => "Server notification status fetched",

    /**
     * Logged when an admin manually requests a test send.
     * @param {string} channel  - Requested channel key
     * @param {string} testedBy - Requesting admin's user id
     * @returns {string}
     */
    TEST_SEND_REQUESTED: (channel, testedBy) =>
        `Test notification requested on channel '${channel}' by ${testedBy}.`,

    // ── Phase 4: Alert Acknowledgement ─────────────────────────────────────────

    /**
     * Logged by the controller when an acknowledge request is received,
     * before the service validates/persists it.
     * @param {string} alertKey
     * @param {string|number} ackedBy - Admin ID of the requesting admin
     * @returns {string}
     */
    ALERT_ACK_REQUESTED: (alertKey, ackedBy) =>
        `Alert acknowledgement requested for '${alertKey}' by ADMIN_ID ${ackedBy}.`,

    /**
     * Logged once an acknowledgement is successfully persisted (map + row).
     * @param {string} alertKey
     * @param {string|number} ackedBy   - Admin ID of the acknowledging admin
     * @param {string} expiresAtIso     - ISO timestamp the ack lapses at
     * @returns {string}
     */
    ALERT_ACKNOWLEDGED: (alertKey, ackedBy, expiresAtIso) =>
        `Alert '${alertKey}' acknowledged by ADMIN_ID ${ackedBy}, expires ${expiresAtIso}.`,

    /**
     * Logged by the controller when an unacknowledge request is received.
     * @param {string} alertKey
     * @returns {string}
     */
    ALERT_UNACK_REQUESTED: (alertKey) =>
        `Alert unacknowledge requested for '${alertKey}'.`,

    /**
     * Logged once an acknowledgement is successfully cleared by an explicit
     * admin "never mind" (unacknowledge()).
     * @param {string} alertKey
     * @returns {string}
     */
    ALERT_UNACKNOWLEDGED: (alertKey) =>
        `Alert '${alertKey}' acknowledgement cleared.`,

    /**
     * Logged when the escalation-override safety net auto-clears an ack
     * because the alert's live severity ranks higher than the severity
     * recorded at ack time. Deliberately NOT `_noNotify` — a normal operational event, safe to
     * see in logs, and not itself part of the notification send path (does
     * not re-trigger anything).
     * @param {string} alertKey
     * @param {string} fromSeverity - Severity recorded at ack time
     * @param {string} toSeverity   - Current (higher) severity
     * @returns {string}
     */
    ALERT_ACK_ESCALATION_CLEARED: (alertKey, fromSeverity, toSeverity) =>
        `Alert '${alertKey}' escalated past its acknowledgement (${fromSeverity} -> ${toSeverity}) — acknowledgement cleared, notification will send.`,

    /**
     * Logged when the TTL-expiry safety net lapses an ack on its own (live
     * check, no separate sweep job).
     * @param {string} alertKey
     * @returns {string}
     */
    ALERT_ACK_EXPIRED: (alertKey) =>
        `Alert '${alertKey}' acknowledgement TTL expired — resuming normal cooldown re-notify.`,

    /**
     * Logged when a cooldown-triggered resend is silenced by a still-valid,
     * non-expired, non-escalated acknowledgement.
     * @param {string} alertKey
     * @returns {string}
     */
    ALERT_ACK_SUPPRESSED: (alertKey) =>
        `Alert '${alertKey}' cooldown re-notify suppressed by an active acknowledgement.`,

    /**
     * Logged when an alert re-fires on the first tick after a restart or
     * leader respawn (in-memory state lost, OK -> WARNING/CRITICAL) but a
     * still-valid acknowledgement was hydrated from SERVER_ALERT_ACK, so the
     * FIRED email is withheld. Distinct from ALERT_ACK_SUPPRESSED, which is
     * the cooldown re-notify path.
     * @param {string} alertKey
     * @returns {string}
     */
    ALERT_ACK_SUPPRESSED_AFTER_RESTART: (alertKey) =>
        `Alert '${alertKey}' re-fired after a restart; email suppressed by an active acknowledgement.`,

    /**
     * Warning when the SERVER_ALERT_LOG write-behind queue overflowed and
     * older rows were dropped (DB outage longer than the queue can absorb).
     * @param {number} dropped - Rows dropped during this write
     * @returns {string}
     */
    ALERT_LOG_QUEUE_DROPPED: (dropped) =>
        `Alert-log queue full — dropped ${dropped} oldest queued row(s) (not persisted to SERVER_ALERT_LOG).`,

    /**
     * Logged once at start() after the in-memory ack Map is hydrated from
     * SERVER_ALERT_ACK.
     * @param {number} count - Number of active (non-expired) acks loaded
     * @returns {string}
     */
    ACK_HYDRATED: (count) =>
        `AlertNotifierService hydrated ${count} active acknowledgement(s) from SERVER_ALERT_ACK.`,

    /**
     * Logged once per digest window when the critical buffer hits its cap.
     * @param {number} cap - CRITICAL_BUFFER_MAX
     * @returns {string}
     */
    CRITICAL_BUFFER_CAPPED: (cap) =>
        `Critical digest buffer reached its cap of ${cap} records this window — further events are counted but not itemised.`,

    /**
     * Logged (debug) when a poll tick is skipped because the previous tick is still running.
     * @returns {string}
     */
    POLL_TICK_OVERLAP_SKIPPED: () =>
        "Alert poll tick skipped — the previous tick is still in flight.",
};

module.exports = { notificationMessages };
