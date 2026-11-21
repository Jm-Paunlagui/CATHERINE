"use strict";

/**
 * @fileoverview Routes for the /api/v1/client resource.
 *
 * Route map:
 *   POST /api/v1/client/errors     Client-side error report      (auth: any authenticated user)
 *   POST /api/v1/client/help-miss  Help-search zero-result event (auth: any authenticated user)
 *
 * Both endpoints are auth-gated so anonymous traffic cannot pollute the server
 * log stream. Render errors that occur pre-auth (login page, etc.) are
 * intentionally not forwarded — the dev-only `console.error` in
 * `clientLogger.js` still surfaces them locally.
 */

const express = require("express");
const router = express.Router();

const AuthMiddleware = require("../middleware/authentication/AuthMiddleware");
const ClientController = require("../controllers/ClientController");
const { RateLimiterMiddleware } = require("../middleware/security/RateLimiterMiddleware");

// Any authenticated user may report their own ErrorBoundary triggers.
router.post(
    "/errors",
    AuthMiddleware.authenticate,
    ClientController.logError,
);

// Help-search misses are user-driven telemetry (one per zero-result search),
// so they arrive far more often than render errors. A per-user limiter caps a
// single session's write rate to the log pipeline (CWE-400) — 20/min is well
// above any human's real search cadence but blocks a scripted flood. The
// frontend already debounces the send and only fires on a genuine zero-result,
// so this ceiling is never reached in normal use.
const helpMissLimiter = new RateLimiterMiddleware({
    max: 20,
    windowMs: 60_000,
    label: "RateLimit:help-miss",
});

router.post(
    "/help-miss",
    AuthMiddleware.authenticate,
    helpMissLimiter.handle,
    ClientController.logHelpMiss,
);

module.exports = router;
