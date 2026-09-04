"use strict";

/**
 * @fileoverview Request traceability middleware.
 * Injects unique X-Request-ID per request, logs incoming and completed
 * requests with structured messages.
 */

const { logger } = require("../../utils/logger");
const { snowflake } = require("../../utils/snowflake");
const { requestContext } = require("../../utils/requestContext");

const SENSITIVE_PATTERNS = [
    "password",
    "passwd",
    "pwd",
    "token",
    "secret",
    "apikey",
    "auth",
    "otp",
    "pin",
    "cvv",
    "cvc",
    "ssn",
    "privatekey",
    "creditcard",
    "cardnumber",
    // L4: PII fields — redact to prevent personal data from appearing in logs
    "email",
    "firstname",
    "lastname",
    "fullname",
    "phonenumber",
    "phone",
    "address",
    "dateofbirth",
    "dob",
];

function isSensitiveKey(key) {
    const norm = key.toLowerCase().replace(/[-_\s]/g, "");
    return SENSITIVE_PATTERNS.some((p) => norm.includes(p));
}

function redactValue(key, value) {
    return isSensitiveKey(key) ? "[REDACTED]" : value;
}

class TraceabilityMiddleware {
    constructor(options = {}) {
        this._excludedUrls = options.excludedUrls ?? [
            ...(process.env.LOG_EXCLUDE_HEALTH === "true" ? ["/health"] : []),
            ...(process.env.LOG_EXCLUDE_URLS
                ? process.env.LOG_EXCLUDE_URLS.split(",")
                : []),
        ];

        this.handle = this.handle.bind(this);
        this.logIncoming = this.logIncoming.bind(this);
    }

    /**
     * Whether this request should produce log lines at all.
     * @param {import('express').Request} req
     * @returns {boolean}
     */
    _shouldLog(req) {
        if (req.method === "OPTIONS") return false;
        const url = req.originalUrl || req.url;
        return !this._excludedUrls.some((u) => url.includes(u.trim()));
    }

    /**
     * Emit the "[Incoming Request]" line exactly once per request.
     *
     * @param {import('express').Request} req
     */
    _emitIncoming(req) {
        if (req._incomingLogged) return;
        req._incomingLogged = true;
        logger.logIncomingRequest(
            req,
            TraceabilityMiddleware.createRequestMessage(req),
        );
    }

    /**
     * Emits the "[Incoming Request]" trace line — MOUNT THIS IMMEDIATELY AFTER
     * THE BODY PARSERS, never with `handle`.
     *
     * WHY IT IS A SEPARATE MIDDLEWARE
     * `handle` must run near the top of the stack: it mints `req.id`, sets the
     * X-Request-ID header, and opens the AsyncLocalStorage context every
     * downstream `logger.*` call reads its `[Request ID]` from. But the body
     * parsers necessarily run LATER, so at `handle` time `req.body` does not
     * exist yet — and `createRequestMessage` therefore printed
     * `[BODY @ req.body is undefined]` on every POST/PUT/PATCH while the
     * "[Request Complete]" line, built from the same helper after parsing, showed
     * the real body. The pair looked like the body had appeared out of nowhere
     * mid-request.
     *
     * Moving `handle` itself below the parsers is NOT the fix: a malformed-JSON
     * 400 is raised BY the parser, so every such request would lose its request
     * id, its ALS context, and its audit row (AuditLogMiddleware is mounted above
     * the parsers and reads `req.id`).
     *
     * Splitting the log line out costs nothing: `handle` calls `next()` from
     * INSIDE `requestContext.run()`, so this middleware — and everything after it
     * — still executes within that context and the line still carries `[req_id]`.
     *
     * @param {import('express').Request} req
     * @param {import('express').Response} res
     * @param {Function} next
     */
    logIncoming(req, res, next) {
        if (this._shouldLog(req)) this._emitIncoming(req);
        next();
    }

    handle(req, res, next) {
        // Inject unique Snowflake request ID — time-sortable, deconstructable,
        // collision-free across distributed instances, PKG-compatible (pure JS).
        // Format: "0078812966528-0448-0000" (Timestamp-MachineID-Sequence).
        req.id = snowflake.nextId();
        res.setHeader("X-Request-ID", req.id);
        const startTime = Date.now();
        const url = req.originalUrl || req.url;
        const isOptions = req.method === "OPTIONS";
        const shouldLog = !this._excludedUrls.some((u) =>
            url.includes(u.trim()),
        );

        // Inject requestId into every JSON response body so the frontend can
        // display it in error toasts and the ErrorBoundary. This covers both
        // sendSuccess() and ErrorHandlerMiddleware responses without requiring
        // any controller changes. The header X-Request-ID is still set above
        // for non-JSON consumers (curl, load balancers, log correlation).
        const originalJson = res.json.bind(res);
        res.json = function (body) {
            if (body && typeof body === "object" && !Buffer.isBuffer(body)) {
                body.requestId = req.id;
            }
            return originalJson(body);
        };

        // Run the entire request inside an AsyncLocalStorage context so every
        // downstream logger.info() call automatically includes [req_id].
        requestContext.run({ requestId: req.id }, () => {
            // The "[Incoming Request]" line is NOT emitted here — `logIncoming`
            // does it after the body parsers, so the body is populated. See that
            // method's docblock for why.

            const originalEnd = res.end;
            const emitIncoming = () => this._emitIncoming(req);
            res.end = function (...args) {
                const duration = Date.now() - startTime;
                if (shouldLog && !isOptions) {
                    // Safety net for requests that never reach `logIncoming`:
                    // a malformed-JSON 400 is raised by the body parser itself,
                    // which sits BELOW `handle` and ABOVE `logIncoming`. Without
                    // this, such a request would log only "[Request Complete]"
                    // and its trace would open with no Incoming line at all.
                    // Idempotent — a no-op on the normal path.
                    emitIncoming();
                    logger.logCompletedRequest(
                        req,
                        res,
                        duration,
                        TraceabilityMiddleware.createRequestMessage(req),
                    );
                }
                originalEnd.apply(this, args);
            };

            next();
        });
    }

    /**
     * Re-enter the request's AsyncLocalStorage context.
     *
     * Stream-driven middleware (multer/busboy) invokes its completion callback
     * from socket-level 'data'/'end' events whose async resource was created
     * BEFORE requestContext.run() — so the ALS store is lost and every
     * logger.* call downstream of an upload middleware drops the [Request ID]
     * from its [FUNC] line. Mount this immediately AFTER any multer middleware
     * to restore the context for the controller/service chain.
     *
     * @example router.post("/upload", auth, upload.any(), TraceabilityMiddleware.restoreContext, Controller.method)
     */
    static restoreContext(req, res, next) {
        if (requestContext.getStore()?.requestId === req.id) return next();
        requestContext.run({ requestId: req.id }, next);
    }

    static createRequestMessage(req) {
        const url = req.originalUrl || req.url;
        let message = `[${req.method} @ ${url}]`;

        if (Object.keys(req.query).length > 0) {
            const params = Object.entries(req.query)
                .map(([k, v]) => `${k}=${redactValue(k, v)}`)
                .join("&");
            message += ` [PARAMS @ ${params}]`;
        }

        if (["POST", "PUT", "PATCH"].includes(req.method)) {
            let bodyContent = "";
            if (!req.body) {
                bodyContent = "req.body is undefined";
            } else if (typeof req.body !== "object") {
                bodyContent = `req.body is ${typeof req.body}`;
            } else if (Object.keys(req.body).length === 0) {
                bodyContent = "req.body is empty object";
            } else {
                bodyContent = Object.entries(req.body)
                    .map(([key, value]) => {
                        if (isSensitiveKey(key)) return `${key}=[REDACTED]`;
                        if (value === null) return `${key}=null`;
                        if (value === undefined) return `${key}=undefined`;
                        if (typeof value === "object") {
                            try {
                                // Full value — never truncated. Cutting the body
                                // defeats traceability; disk space is cheaper
                                // than an unreproducible incident.
                                return `${key}=${JSON.stringify(value)}`;
                            } catch {
                                return `${key}=[Complex Object]`;
                            }
                        }
                        return `${key}=${value}`;
                    })
                    .join(", ");
            }
            message += ` [BODY @ ${bodyContent}]`;
        }

        return message;
    }
}

const defaultTraceability = new TraceabilityMiddleware();
module.exports = {
    TraceabilityMiddleware,
    defaultTraceability,
    // Exported so any future consumer of `res.locals.body` (see
    // ErrorHandlerMiddleware.captureResponseBody) can redact sensitive keys
    // in the captured response JSON with the exact same rules used for
    // request logging, instead of re-implementing key-substring matching.
    isSensitiveKey,
    redactValue,
};
