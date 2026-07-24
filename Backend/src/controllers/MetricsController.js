"use strict";

/**
 * @fileoverview HTTP controller for the /api/v1/metrics resource.
 * Thin layer: validates nothing beyond HTTP concerns, delegates all logic to MetricsService.
 * Every async method is wrapped in catchAsync — unhandled rejections route to ErrorHandlerMiddleware.
 */

const { catchAsync } = require("../utils/catchAsync");
const { sendSuccess, RESPONSE_MESSAGES } = require("../constants/responses");
const { AppError, NOTIFICATION_ERRORS, HTTP_STATUS } = require("../constants");
const { logger } = require("../utils/logger");
const {
  metricsMessages,
  notificationMessages,
} = require("../constants/messages");
const MetricsService = require("../services/MetricsService");
const AlertNotifierService = require("../services/AlertNotifierService");

/** Accepted SEVERITY values for the alert-history filter (schema CK_SAL_SEVERITY). */
const VALID_HISTORY_SEVERITIES = ["WARNING", "CRITICAL", "RESOLVED"];

/**
 * Parses an ISO date query value. Returns null when absent; throws a 400
 * AppError when present but unparseable — a silently-dropped bad filter would
 * return a wider result set than the caller asked for.
 *
 * @param {string|undefined} raw
 * @param {string} field - Query param name, echoed in the validation detail
 * @returns {Date|null}
 */
function parseHistoryDate(raw, field) {
  if (raw == null || raw === "") return null;
  const d = new Date(raw);
  if (isNaN(d.getTime())) {
    throw new AppError(
      NOTIFICATION_ERRORS.INVALID_DATE_RANGE,
      HTTP_STATUS.BAD_REQUEST,
      {
        type: "ValidationError",
        details: [{ field, issue: "Must be an ISO 8601 date." }],
      },
    );
  }
  return d;
}

/**
 * Resolves the acting admin's numeric id from the JWT claims. The template's
 * token carries `id`; `userId` is accepted as a fallback for deployments that
 * renamed the claim.
 *
 * @param {import('express').Request} req
 * @returns {number|string|undefined}
 */
function actorId(req) {
  return req.user?.id ?? req.user?.userId;
}

class MetricsController {
  /**
   * GET /api/v1/metrics
   * Returns the full in-process metrics snapshot.
   * Requires userLevel >= 2.
   */
  static getSnapshot = catchAsync(async (_req, res) => {
    const snapshot = MetricsService.getSnapshot();
    logger.info(metricsMessages.SNAPSHOT_FETCHED());
    res.json(sendSuccess(RESPONSE_MESSAGES.METRICS_FETCHED, snapshot));
  });

  /**
   * GET /api/v1/metrics/summary
   * Returns an abbreviated summary: totals, top-5 slow routes, alert count.
   * Requires userLevel >= 1.
   */
  static getSummary = catchAsync(async (_req, res) => {
    const summary = MetricsService.getSummary();
    logger.info(metricsMessages.SUMMARY_FETCHED());
    res.json(sendSuccess(RESPONSE_MESSAGES.METRICS_SUMMARY_FETCHED, summary));
  });

  /**
   * GET /api/v1/metrics/alerts
   * Evaluates all alert rules and returns triggered alerts, decorated with
   * acknowledgement state (acknowledged / ackedBy / ackedByName / ackedAt /
   * ackExpiresAt) so the frontend can render ack state without a second
   * round-trip.
   * Requires userLevel >= 2.
   */
  static getAlerts = catchAsync(async (_req, res) => {
    const alerts = MetricsService.evaluateAlerts();
    const decorated = await AlertNotifierService.decorateAlertsWithAckState(alerts);
    logger.info(metricsMessages.ALERTS_FETCHED());
    res.json(
      sendSuccess(RESPONSE_MESSAGES.METRICS_ALERTS_FETCHED, {
        alerts: decorated,
        count: decorated.length,
      }),
    );
  });

  /**
   * POST /api/v1/metrics/frontend
   * Ingests an array of frontend metric events (web vitals + JS errors).
   * No auth required — pre-auth telemetry.
   */
  static ingestFrontend = catchAsync(async (req, res) => {
    await MetricsService.ingestFrontendMetrics(req.body);
    res.json(sendSuccess(RESPONSE_MESSAGES.METRICS_FRONTEND_INGESTED, null));
  });

  /**
   * GET /api/v1/metrics/notifications/status
   * Returns the server-email-notifications enabled flag, MASKED recipients per
   * channel (CWE-200 — the page shows who is subscribed without exposing full
   * addresses), active alert states, and the recent-sends ring buffer.
   * Requires userLevel >= 2.
   */
  static getNotificationStatus = catchAsync(async (_req, res) => {
    const status = await AlertNotifierService.getStatus();
    logger.info(notificationMessages.STATUS_FETCHED());
    res.json(sendSuccess(RESPONSE_MESSAGES.NOTIFICATION_STATUS_FETCHED, status));
  });

  /**
   * POST /api/v1/metrics/notifications/test
   * Sends a test digest email on the requested channel. SUPER_ADMIN only,
   * behind a strict rate limit — every call is a real SMTP send.
   * Body: { channel: string }.
   */
  static testSendNotification = catchAsync(async (req, res) => {
    const { channel } = req.body || {};
    const testedBy = actorId(req) ?? req.user?.username ?? "unknown";
    logger.info(notificationMessages.TEST_SEND_REQUESTED(channel, testedBy));
    const result = await AlertNotifierService.sendTestNotification(channel, req.user);
    res.json(sendSuccess(RESPONSE_MESSAGES.NOTIFICATION_TEST_SENT, result));
  });

  /**
   * GET /api/v1/metrics/alerts/history
   * Offset-paginated alert/notification history.
   * Query: rule, severity (WARNING|CRITICAL|RESOLVED), from, to (ISO dates),
   * page, limit (capped at 200 by the model). Requires userLevel >= 2.
   */
  static getAlertHistory = catchAsync(async (req, res) => {
    const { rule, severity, from, to, page, limit } = req.query;

    if (
      severity != null &&
      severity !== "" &&
      !VALID_HISTORY_SEVERITIES.includes(String(severity).toUpperCase())
    ) {
      throw new AppError(
        NOTIFICATION_ERRORS.INVALID_SEVERITY,
        HTTP_STATUS.BAD_REQUEST,
        {
          type: "ValidationError",
          details: [
            {
              field: "severity",
              issue: `Accepted values: ${VALID_HISTORY_SEVERITIES.join(", ")}.`,
            },
          ],
        },
      );
    }

    const fromDate = parseHistoryDate(from, "from");
    const toDate = parseHistoryDate(to, "to");
    if (fromDate && toDate && fromDate.getTime() > toDate.getTime()) {
      throw new AppError(
        NOTIFICATION_ERRORS.INVALID_DATE_RANGE,
        HTTP_STATUS.BAD_REQUEST,
        {
          type: "ValidationError",
          details: [{ field: "from", issue: "'from' must be on or before 'to'." }],
        },
      );
    }

    const result = await AlertNotifierService.getAlertHistory(
      {
        rule: rule || undefined,
        severity: severity ? String(severity).toUpperCase() : undefined,
        from: fromDate,
        to: toDate,
      },
      { page, limit },
    );

    res.json(sendSuccess(RESPONSE_MESSAGES.NOTIFICATION_HISTORY_FETCHED, result));
  });

  /**
   * POST /api/v1/metrics/alerts/ack
   * Acknowledges an active alert. Body: { alertKey: string, note?: string }.
   *
   * Same access tier as GET /alerts (userLevel >= 2) — whoever can already see
   * an alert can quiet it; no new permission tier is invented for this.
   */
  static acknowledgeAlert = catchAsync(async (req, res) => {
    const { alertKey, note } = req.body || {};
    const ackedBy = actorId(req);
    logger.info(notificationMessages.ALERT_ACK_REQUESTED(alertKey, ackedBy));
    const result = await AlertNotifierService.acknowledge(alertKey, ackedBy, note);
    res.json(sendSuccess(RESPONSE_MESSAGES.ALERT_ACKNOWLEDGED, result));
  });

  /**
   * DELETE /api/v1/metrics/alerts/ack
   * Clears an alert's acknowledgement (explicit admin "never mind").
   * Body: { alertKey: string }. Same access tier as GET /alerts.
   */
  static unacknowledgeAlert = catchAsync(async (req, res) => {
    const { alertKey } = req.body || {};
    logger.info(notificationMessages.ALERT_UNACK_REQUESTED(alertKey));
    const result = await AlertNotifierService.unacknowledge(alertKey);
    res.json(sendSuccess(RESPONSE_MESSAGES.ALERT_UNACKNOWLEDGED, result));
  });
}

module.exports = MetricsController;
