"use strict";

/**
 * @fileoverview Centralized error handling middleware.
 *
 * All errors funnel through here. The classifier identifies error types
 * (AppError, Oracle ORA-XXXXX, JWT, parse, payload) and returns an accurate,
 * sanitised response in all environments — never leaking SQL, bind variables,
 * or stack traces to clients in production.
 */

const { logger } = require("../../utils/logger");
const ORA_MAP = require("./OraCode");
const { NJS_MAP, TRANSIENT_STRING_PATTERNS, POOL_OVERLOADED_TYPE } = require("./NjsCode");
const { getStatusTitle } = require("../../constants/responses");

/** AppError type of the shutdown-drain 503 (ShutdownGateMiddleware). */
const SHUTTING_DOWN_TYPE = "ServerShuttingDown";

class ErrorHandlerMiddleware {
    /**
     * @param {object} [options]
     * @param {{ applyToErrorResponse: Function }} [options.cors] - CORS policy
     *   for errors raised before the CORS middleware ran; defaults to the one
     *   `app.js` mounts.
     */
    constructor(options = {}) {
        this._cors = options.cors ?? require("../security/CorsMiddleware").defaultCors;
        this.handle = this.handle.bind(this);
        this.notFoundHandler = this.notFoundHandler.bind(this);
        this.captureResponseBody = this.captureResponseBody.bind(this);
    }

    // ─── Main handler ──────────────────────────────────────────────────────────

    handle(err, req, res, _next) {
        // The request watchdog already answered (504) or destroyed this
        // response. The handler's late error (ERR_HTTP_HEADERS_SENT, or the
        // RequestStalledError thrown by a later DB call) must not be logged as
        // a fresh 5xx nor written to a finished response.
        if (res.locals?.__watchdogTerminated) return;

        const classified = this._classify(err);
        const { statusCode, message, type, details, hint, reasons, rawMessage, retryAfterSec } =
            classified;

        if (type === SHUTTING_DOWN_TYPE) {
            // A drain is expected and can last seconds under load: log at notice
            // so it cannot flood the error log or trip error alerts.
            logger.notice(rawMessage ?? err.message, {
                statusCode,
                path: req.originalUrl,
                method: req.method,
                requestId: req.id,
            });
        } else if (statusCode >= 500) {
            logger.error(rawMessage ?? err.message, {
                statusCode,
                stack: err.stack,
                path: req.originalUrl,
                method: req.method,
                ip: req.ip,
                requestId: req.id,
            });
        } else {
            logger.warning(rawMessage ?? err.message, {
                statusCode,
                path: req.originalUrl,
                method: req.method,
                requestId: req.id,
            });
        }

        const isDev = process.env.NODE_ENV === "development";
        const response = {
            status: "error",
            code: statusCode,
            title: getStatusTitle(statusCode),
            message,
            requestId: req.id ?? null,
            error: {
                type,
                ...(details ? { details } : {}),
                ...(hint ? { hint } : {}),
                ...(reasons ? { reasons } : {}),
                ...(isDev ? { stack: err.stack } : {}),
            },
        };

        // Headers already out (error mid-stream): a JSON envelope can no longer
        // be sent — `res.status().json()` would throw ERR_HTTP_HEADERS_SENT.
        // Do what Express' default handler does: drop the socket if the
        // response is still open, otherwise there is nothing left to do.
        if (res.headersSent) {
            if (!res.writableEnded) res.destroy();
            return;
        }

        // A pool load-shed 429 (NJS-076, queue full) is deliberate back-pressure:
        // tell clients and proxies when to retry (RFC 9110 §10.2.3) so a shed
        // request is not retried immediately into the same full queue.
        if (
            statusCode === 429 &&
            type === POOL_OVERLOADED_TYPE &&
            !res.getHeader("Retry-After")
        ) {
            res.setHeader("Retry-After", "1");
        }

        // Explicit back-off from the thrower (AppError.retryAfterSec, e.g. the
        // shutdown gate); never overrides a header a deeper layer already set.
        if (retryAfterSec && !res.getHeader("Retry-After")) {
            res.setHeader("Retry-After", String(retryAfterSec));
        }

        // An error raised before the CORS middleware (a malformed or oversized
        // body at step 4) would otherwise leave without CORS headers, and the
        // browser would hide it from the UI entirely.
        this._cors.applyToErrorResponse(req, res, () => {
            res.status(statusCode).json(response);
        });
    }

    // ─── Error classifier ──────────────────────────────────────────────────────

    /**
     * Classifies any error into a normalised shape:
     *   { statusCode, message, type, details?, hint?, rawMessage? }
     *
     * Priority order:
     *   1. AppError (already operational + classified)
     *   2. Oracle DB errors (ORA-XXXXX anywhere in message)
     *   2a. node-oracledb driver errors (NJS-XXX anywhere in message)
     *   2b. Adapter-level transient string patterns (e.g. connection acquire timeout)
     *   3. JWT errors
     *   4. HTTP-level framework errors (body-parser, multer)
     *   5. Fallback generic 500
     */
    _classify(err) {
        // 1. AppError — already operational and classified
        if (err.isOperational) {
            return {
                statusCode: err.statusCode || err.status || 500,
                message: err.message,
                type: err.name || "AppError",
                details: err.details,
                hint: err.hint,
                reasons: err.reasons,
                retryAfterSec: err.retryAfterSec,
            };
        }

        // 2. Oracle DB errors
        if (err.message && /ORA-\d+/.test(err.message)) {
            return this._classifyOracle(err);
        }

        // 2a. node-oracledb driver errors — pool exhaustion / connection lost
        // at the client side, before ever reaching the database engine, so
        // they never carry an ORA-XXXXX code.
        if (err.message && /NJS-\d+/.test(err.message)) {
            return this._classifyNjs(err);
        }

        // 2b. Adapter-level transient failures with no ORA-/NJS- code at all
        // (e.g. the connection acquire-timeout Error race in withConnection()).
        // The adapter's DB_OP_FAILED(...) wrapper embeds the original message,
        // so the pattern matches without unwrapping err.originalError.
        if (err.message) {
            const stringMatch = TRANSIENT_STRING_PATTERNS.find(({ pattern }) =>
                pattern.test(err.message),
            );
            if (stringMatch) {
                return {
                    statusCode: stringMatch.status,
                    message: stringMatch.msg,
                    type: stringMatch.type,
                    hint: "Transient database failure — the operation may be retried.",
                    rawMessage: err.message,
                };
            }
        }

        // 3. JWT errors
        if (err.name === "JsonWebTokenError") {
            return {
                statusCode: 401,
                message: "Invalid or malformed token.",
                type: "AuthenticationError",
            };
        }
        if (err.name === "TokenExpiredError") {
            return {
                statusCode: 401,
                message: "Token has expired. Please sign in again.",
                type: "AuthenticationError",
            };
        }
        if (err.name === "NotBeforeError") {
            return {
                statusCode: 401,
                message: "Token is not yet valid.",
                type: "AuthenticationError",
            };
        }

        // 4. Body-parser / framework errors
        if (err.type === "entity.parse.failed") {
            return {
                statusCode: 400,
                message: "Malformed JSON in request body.",
                type: "ParseError",
            };
        }
        if (err.type === "entity.too.large") {
            return {
                statusCode: 413,
                message: "Request body exceeds the size limit.",
                type: "PayloadTooLargeError",
            };
        }
        if (err.type === "encoding.unsupported") {
            return {
                statusCode: 415,
                message: "Request body encoding is not supported.",
                type: "UnsupportedMediaTypeError",
            };
        }
        if (
            err.status === 400 &&
            err.message?.toLowerCase().includes("invalid")
        ) {
            return {
                statusCode: 400,
                message: err.message,
                type: "BadRequestError",
            };
        }

        // 4a. Multer upload errors
        if (err.name === "MulterError") {
            if (err.code === "LIMIT_FILE_SIZE") {
                return {
                    statusCode: 413,
                    message: "Uploaded file exceeds the maximum allowed size.",
                    type: "PayloadTooLargeError",
                };
            }
            if (err.code === "LIMIT_FILE_COUNT") {
                return {
                    statusCode: 400,
                    message: "Too many files uploaded.",
                    type: "ValidationError",
                };
            }
            return {
                statusCode: 400,
                message: err.message,
                type: "ValidationError",
            };
        }

        // 5. Fallback — preserve any explicit status code from the error
        const isProduction = process.env.NODE_ENV === "production";
        return {
            statusCode: err.statusCode || err.status || 500,
            message: "Internal server error",
            type: isProduction ? "InternalError" : err.name || "Error",
            rawMessage: err.message,
        };
    }

    /**
     * Extracts the ORA code from the error message and returns a clean, safe
     * client message. The raw DB message (with SQL / binds) is stored in
     * rawMessage for the logger — it is never sent to the client.
     */
    _classifyOracle(err) {
        const match = err.message.match(/ORA-(\d+)/);
        const code = match ? parseInt(match[1], 10) : 0;
        const known = ORA_MAP[code];

        return {
            statusCode: known?.status ?? 500,
            message: known?.msg ?? "A database error occurred.",
            type: "DatabaseError",
            hint: `ORA-${String(code).padStart(5, "0")}`,
            rawMessage: err.message,
        };
    }

    /**
     * Extracts the NJS code from the error message and returns a clean, safe
     * client message. The raw driver message is stored in rawMessage for the
     * logger — it is never sent to the client.
     */
    _classifyNjs(err) {
        const match = err.message.match(/NJS-(\d+)/);
        const code = match ? parseInt(match[1], 10) : 0;
        const known = NJS_MAP[code];

        return {
            statusCode: known?.status ?? 503,
            message: known?.msg ?? "A database connection error occurred.",
            // Per-entry type/hint override the generic transient-failure
            // defaults so a deliberate load-shed (NJS-076) can present as a
            // distinct 429 PoolOverloadedError with back-off guidance, while
            // every other NJS code keeps its original 503 semantics.
            type: known?.type ?? "DatabaseUnavailableError",
            hint:
                known?.hint ??
                "Transient database failure — the operation may be retried.",
            rawMessage: err.message,
        };
    }

    // ─── 404 handler ──────────────────────────────────────────────────────────

    notFoundHandler(req, res, _next) {
        res.status(404).json({
            status: "error",
            code: 404,
            title: getStatusTitle(404),
            message: `Route ${req.method} ${req.originalUrl} not found`,
            error: {
                type: "NotFoundError",
                hint: "Check the URL and HTTP method.",
            },
        });
    }

    // ─── Response body capture ────────────────────────────────────────────────

    /**
     * Captures the response body for downstream audit logging.
     *
     * Exemptions (M2 — memory safety):
     *   - SSE streams (Accept: text/event-stream) — unbounded, never terminates
     *   - Binary downloads (Content-Disposition: attachment) — large, not loggable
     *   - Captured body is capped at 64 KiB to prevent memory exhaustion from
     *     unexpectedly large JSON responses.
     */
    captureResponseBody(req, res, next) {
        // Skip SSE streams — they never end, so buffering would leak memory.
        const accept = req.headers.accept || "";
        if (accept.includes("text/event-stream")) {
            return next();
        }

        const MAX_CAPTURE_BYTES = 64 * 1024; // 64 KiB cap
        const oldWrite = res.write;
        const oldEnd = res.end;
        const chunks = [];
        let totalBytes = 0;
        let capped = false;

        res.write = function (chunk, ...args) {
            if (!capped) {
                const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                totalBytes += buf.length;
                if (totalBytes <= MAX_CAPTURE_BYTES) {
                    chunks.push(buf);
                } else {
                    capped = true;
                }
            }
            oldWrite.apply(res, [chunk, ...args]);
        };

        res.end = function (chunk, ...args) {
            if (chunk && !capped) {
                const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                totalBytes += buf.length;
                if (totalBytes <= MAX_CAPTURE_BYTES) {
                    chunks.push(buf);
                } else {
                    capped = true;
                }
            }
            res.locals.body = capped
                ? "[response body too large — capture skipped]"
                : Buffer.concat(chunks).toString("utf8");
            oldEnd.apply(res, [chunk, ...args]);
        };

        next();
    }
}

const defaultErrorHandler = new ErrorHandlerMiddleware();
module.exports = { ErrorHandlerMiddleware, defaultErrorHandler };
