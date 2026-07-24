"use strict";

/**
 * @fileoverview Routes for the /api/v1/metrics resource.
 *
 * Route map:
 *   GET    /api/v1/metrics                      Full snapshot  (auth: userLevel >= 2)
 *   GET    /api/v1/metrics/summary              Summary        (auth: userLevel >= 1)
 *   GET    /api/v1/metrics/alerts               Alert evals    (auth: userLevel >= 2)
 *   POST   /api/v1/metrics/frontend             FE ingestion   (no auth — pre-auth telemetry)
 *   GET    /api/v1/metrics/notifications/status Notification status (auth: userLevel >= 2)
 *   POST   /api/v1/metrics/notifications/test   Test send      (auth: SUPER_ADMIN, strict rate limit)
 *   GET    /api/v1/metrics/alerts/history       Alert/notification history (auth: userLevel >= 2)
 *   POST   /api/v1/metrics/alerts/ack           Acknowledge an alert (auth: userLevel >= 2)
 *   DELETE /api/v1/metrics/alerts/ack           Clear an acknowledgement (auth: userLevel >= 2)
 *
 * The frontend ingestion endpoint has a tighter rate limit (30 req/min) to
 * prevent abuse without requiring authentication. The notification test-send
 * endpoint has an even stricter limit (3 req/min) — it triggers a real SMTP
 * send and is SUPER_ADMIN-only.
 */

const express = require("express");
const router = express.Router();

const MetricsController = require("../controllers/MetricsController");
const AuthMiddleware = require("../middleware/authentication/AuthMiddleware");
const { RateLimiterMiddleware } = require("../middleware/security/RateLimiterMiddleware");

// Dedicated stricter limiter for the unauthenticated frontend ingestion endpoint
const frontendIngestLimiter = new RateLimiterMiddleware({
  max: 30,
  windowMs: 60_000,
  label: "FrontendMetricsIngest",
});

// Strict limiter for the manual test-send endpoint — each call is a real SMTP send.
const notificationTestLimiter = new RateLimiterMiddleware({
  max: 3,
  windowMs: 60_000,
  label: "NotificationTestSend",
});

// ─── Authenticated read routes ────────────────────────────────────────────────

// Full snapshot — senior admin level
router.get(
  "/",
  AuthMiddleware.authenticate,
  AuthMiddleware.requireAccess((user) => user.userLevel >= 2),
  MetricsController.getSnapshot,
);

// Summary — standard user level (useful for sidebar dashlets)
router.get(
  "/summary",
  AuthMiddleware.authenticate,
  AuthMiddleware.requireAccess((user) => user.userLevel >= 1),
  MetricsController.getSummary,
);

// Alert evaluations — senior admin level
router.get(
  "/alerts",
  AuthMiddleware.authenticate,
  AuthMiddleware.requireAccess((user) => user.userLevel >= 2),
  MetricsController.getAlerts,
);

// ─── Unauthenticated frontend ingestion ──────────────────────────────────────
// No auth: this endpoint is called before the user logs in (pre-auth telemetry).
// The tighter rate limiter mitigates abuse.

router.post(
  "/frontend",
  frontendIngestLimiter.handle.bind(frontendIngestLimiter),
  MetricsController.ingestFrontend,
);

// ─── Server email notifications (admin visibility) ───────────────────────────

// Status — enabled flag, masked recipients, active alert states, recent sends.
// Same access tier as the other senior-admin metrics reads (userLevel >= 2).
router.get(
  "/notifications/status",
  AuthMiddleware.authenticate,
  AuthMiddleware.requireAccess((user) => user.userLevel >= 2),
  MetricsController.getNotificationStatus,
);

// Test send — triggers a real SMTP send, so SUPER_ADMIN-only plus a strict
// per-IP rate limit on top of the normal auth gate. Field validation runs after
// auth and rate-limit, before the controller — reject bad input early, but
// never let an unauthenticated caller burn the SMTP budget probing for it.
router.post(
  "/notifications/test",
  AuthMiddleware.authenticate,
  AuthMiddleware.requireAccess((user) => user.role === "SUPER_ADMIN"),
  notificationTestLimiter.handle.bind(notificationTestLimiter),
  AuthMiddleware.validateRequiredFields(["channel"]),
  MetricsController.testSendNotification,
);

// ─── Alert history ───────────────────────────────────────────────────────────
// Offset-paginated read of the alert-log table. Registered AFTER /alerts — it
// is a distinct exact path ("/alerts/history"), so there is no route-order
// collision with the alert-evaluation endpoint above.
router.get(
  "/alerts/history",
  AuthMiddleware.authenticate,
  AuthMiddleware.requireAccess((user) => user.userLevel >= 2),
  MetricsController.getAlertHistory,
);

// ─── Alert acknowledgement ───────────────────────────────────────────────────
// alertKey travels in the BODY, not a URL path param: it contains "::" and "/"
// (e.g. "HIGH_LATENCY::POST /api/v1/auth/login"), which does not path-encode
// cleanly. Same access tier as GET /alerts (userLevel >= 2) — whoever can
// already see an alert should be able to quiet it.
router.post(
  "/alerts/ack",
  AuthMiddleware.authenticate,
  AuthMiddleware.requireAccess((user) => user.userLevel >= 2),
  AuthMiddleware.validateRequiredFields(["alertKey"]),
  MetricsController.acknowledgeAlert,
);

router.delete(
  "/alerts/ack",
  AuthMiddleware.authenticate,
  AuthMiddleware.requireAccess((user) => user.userLevel >= 2),
  AuthMiddleware.validateRequiredFields(["alertKey"]),
  MetricsController.unacknowledgeAlert,
);

module.exports = router;
// Exposed for tests: limiters are module-level state that persists across a
// full test run, so suites must be able to reset them for deterministic results
// (same per-route rate-limiter pattern used by other mutating routes).
module.exports.frontendIngestLimiter = frontendIngestLimiter;
module.exports.notificationTestLimiter = notificationTestLimiter;
