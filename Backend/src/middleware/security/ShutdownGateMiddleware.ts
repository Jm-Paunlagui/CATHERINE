"use strict";

/**
 * @fileoverview Shutdown gate - refuses new work while the process drains.
 *
 * Mounted at app.js step 3b: after Traceability (3) + AuditLog (3a), so the 503
 * keeps a request id and an audit row, and before body parsing (4), so a
 * draining server never wastes a parse. CORS headers are added by
 * ErrorHandlerMiddleware (the gate runs above the CORS step).
 *
 * Reads the existing `InFlightTaskRegistry.isShuttingDown()` flag (set
 * synchronously at the start of the shutdown sequence) - no second flag.
 *
 * Passes: OPTIONS (preflight) and `/api/v<n>/health*` (so /live and /ready can
 * still report the drain). Everything else gets 503 `ServerShuttingDown` with
 * `Retry-After: 5` and `Connection: close`. A browser on a kept-alive socket
 * would otherwise still reach a route of a server that is stopping; the UI turns
 * this answer into its "server is restarting" banner.
 */

const { AppError, GENERAL_ERRORS } = require("../../constants/errors");
const InFlightTaskRegistry = require("../../utils/InFlightTaskRegistry");

/** Seconds a client should wait before retrying while the server drains. */
const { SHUTDOWN_RETRY_AFTER_SEC } = require("../../constants/shutdownGate");
const HEALTH_PATH_RE = /^\/api\/v\d+\/health(\/|$)/;

class ShutdownGateMiddleware {
    /**
     * @param {{ isShuttingDown?: () => boolean }} [deps] - injectable for tests
     */
    constructor({ isShuttingDown = () => InFlightTaskRegistry.isShuttingDown() } = {}) {
        this._isShuttingDown = isShuttingDown;
        this.handle = this.handle.bind(this);
    }

    /**
     * Express middleware.
     * @param {import("express").Request} req
     * @param {import("express").Response} res
     * @param {import("express").NextFunction} next
     */
    handle(req, res, next) {
        if (!this._isShuttingDown()) return next();
        if (req.method === "OPTIONS") return next();
        const path = req.originalUrl ?? req.url ?? "";
        if (HEALTH_PATH_RE.test(path.split("?")[0])) return next();

        res.setHeader("Connection", "close");
        return next(
            new AppError(GENERAL_ERRORS.SERVER_SHUTTING_DOWN, 503, {
                type: "ServerShuttingDown",
                retryAfterSec: SHUTDOWN_RETRY_AFTER_SEC,
            }),
        );
    }
}

const defaultShutdownGate = new ShutdownGateMiddleware();

module.exports = { ShutdownGateMiddleware, defaultShutdownGate, SHUTDOWN_RETRY_AFTER_SEC };
