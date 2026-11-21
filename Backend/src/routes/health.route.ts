"use strict";

/**
 * @fileoverview Health check routes.
 *
 * Route map:
 *   GET /api/v1/health        Legacy combined check — backward compatible
 *   GET /api/v1/health/live   Liveness: is the process alive? Never checks DB.
 *   GET /api/v1/health/ready  Readiness: are all dependencies healthy?
 *   GET /api/v1/health/stream Readiness push (SSE): status on change + heartbeat
 *
 * The /live endpoint is safe for Kubernetes/PM2 liveness probes — it never
 * contacts the DB and therefore never causes false restarts due to DB flakiness.
 *
 * The /ready endpoint pings every Oracle pool (appDb, appDbBulk) and
 * returns 503 unless every pool answers AND every circuit breaker is closed
 * (appDbBulk saturation still counts as up). See
 * services/ReadinessService.js. This allows load-balancers to stop sending
 * traffic during pool recovery or cold start, and keeps the UI's "Back online"
 * from appearing while sign-in would still fail fast.
 *
 * The /stream endpoint (services/HealthStreamHub.js) pushes the same verdict to
 * the UI the moment it changes, so the status banner is proactive.
 */

const express = require("express");
const router = express.Router();

const db = require("../config");
const { POOL_NAMES } = require("../config/database");
const InFlightTaskRegistry = require("../utils/InFlightTaskRegistry");
const ReadinessService = require("../services/ReadinessService");
const HealthStreamHub = require("../services/HealthStreamHub");
const { catchAsync } = require("../utils/catchAsync");
const { sendSuccess, sendError } = require("../constants/responses");
const { GENERAL_ERRORS } = require("../constants/errors");
const { sendSsePreflightError } = require("../utils/sse/ssePreflight");
const { SHUTDOWN_RETRY_AFTER_SEC } = require("../constants/shutdownGate");

// Probing + the readiness rule live in services/ReadinessService.js (shared with /stream).

// ─── GET /health/live → mounted at /api/v1/health/live ───────────────────────

/**
 * Liveness probe — is the Node.js process alive and able to handle requests?
 * Always returns 200 as long as the process is running.
 * Used by Kubernetes/PM2: a non-200 response triggers a process restart.
 * Never performs any DB check so it cannot false-positive due to DB flakiness.
 */
router.get("/live", (_req, res) => {
    res.json(
        sendSuccess("OK", {
            alive: true,
            pid: process.pid,
            uptime: process.uptime(),
            timestamp: new Date().toISOString(),
        }),
    );
});

// ─── GET /health/ready → mounted at /api/v1/health/ready ────────────────────

/**
 * Readiness probe — are all dependencies connected and the app ready to serve?
 * Probes all named Oracle pools in parallel.
 * Returns 200 when every pool answers and every breaker is closed, else 503.
 * Load-balancers should stop routing traffic on 503.
 */
router.get(
    "/ready",
    catchAsync(async (_req, res) => {
        // Draining: report not-ready at once and do NOT probe the pools -
        // the load-balancer and the UI's "server is restarting" banner only need the 503.
        if (InFlightTaskRegistry.isShuttingDown()) {
            res.set("Retry-After", String(SHUTDOWN_RETRY_AFTER_SEC));
            return res.status(503).json({
                ...sendError("Service Unavailable", 503, {
                    type: "ServerShuttingDown",
                }),
                data: { ready: false, draining: true },
            });
        }

        // One rule for /ready and /stream: every pool answers AND every breaker
        // is closed (services/ReadinessService.js). Concurrent calls share one probe.
        const payload = await ReadinessService.evaluate();
        const { ready } = payload;

        if (ready) {
            res.json(sendSuccess("Ready", payload));
        } else {
            // Return error status (consistent with sendError contract) but include
            // data.ready + data.checks so monitoring can identify which pool is down.
            res.status(503).json({
                ...sendError("Service Unavailable", 503, {
                    type: "ServiceUnavailableError",
                }),
                data: payload,
            });
        }
    }),
);

// ─── GET /health/stream → mounted at /api/v1/health/stream ──────────────────

/**
 * Readiness push stream (SSE). Unauthenticated like /ready; exempt from the
 * rate limiter and the shutdown gate (HEALTH_PATH_RE) and from the request
 * watchdog (EXEMPT_RULES). Events: `status` {ready, cause} on open and on every
 * change, `heartbeat` every 15 s, `shutdown` when the server drains.
 * NOT wrapped in catchAsync: refusals happen before the upgrade.
 */
router.get("/stream", (req, res) => {
    if (InFlightTaskRegistry.isShuttingDown()) {
        res.set("Retry-After", String(SHUTDOWN_RETRY_AFTER_SEC));
        return sendSsePreflightError(req, res, GENERAL_ERRORS.SERVER_SHUTTING_DOWN, 503, {
            type: "ServerShuttingDown",
        });
    }
    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    if (!HealthStreamHub.canAccept(ip)) {
        return sendSsePreflightError(req, res, GENERAL_ERRORS.TOO_MANY_HEALTH_STREAMS, 429, {
            type: "RateLimitError",
        });
    }
    HealthStreamHub.open(req, res, ip);
});

// ─── GET / → mounted at /api/v1/health (legacy combined) ────────────────────

/**
 * Legacy combined health check — kept for backward compatibility with existing
 * monitoring integrations that hit this endpoint. Returns 200 regardless of
 * DB status (database field reflects actual connectivity; "draining" while shutting down, no pool call).
 */
router.get(
    "/",
    catchAsync(async (_req, res) => {
        // Draining: answer 200 from memory with database:"draining" - no pool borrow per monitor poll,
        // and the 200 stays compatible with legacy monitors (shutdownGate.integration pin).
        if (InFlightTaskRegistry.isShuttingDown()) {
            return res.json(
                sendSuccess("OK", {
                    uptime: process.uptime(),
                    timestamp: new Date().toISOString(),
                    database: "draining",
                }),
            );
        }

        // L3: Do not expose host, pid, or environment to unauthenticated callers.
        const data = {
            uptime: process.uptime(),
            timestamp: new Date().toISOString(),
            database: "unknown",
        };

        try {
            await db.withConnection(POOL_NAMES[0], async (conn) => {
                await conn.execute("SELECT 1 FROM DUAL");
            });
            data.database = "connected";
        } catch {
            data.database = "disconnected";
        }

        res.json(sendSuccess("OK", data));
    }),
);

module.exports = router;
