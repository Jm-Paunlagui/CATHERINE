"use strict";

/**
 * @fileoverview RequestWatchdog — cuts HTTP requests that stop making progress.
 *
 * WHAT IT DOES
 *   Attached as a SERVER-level `request` listener via `prependListener`, so it
 *   runs BEFORE the Express app: it creates one ProgressScope per request
 *   (keyed in a WeakMap, read back with `RequestWatchdog.scopeOf(req)`) and
 *   registers it with an IdleWatchdog. The 13-step middleware chain in
 *   `src/app.js` is untouched — TraceabilityMiddleware only copies the scope
 *   into the ALS store (step 3).
 *
 * WHAT COUNTS AS PROGRESS
 *   DB calls / SMTP steps / explicit touches (call sites), plus SOCKET I/O
 *   observed here: on every sweep, if `socket.bytesRead + bytesWritten`
 *   changed since the last sweep the scope is touched "socket-io". That covers
 *   slow uploads and streamed downloads with no stream listeners. A client
 *   that stops reading leaves `bytesWritten` frozen, so it is correctly idle.
 *
 * WHAT "TERMINATE" DOES
 *   1. abort the scope with a 504 `RequestStalledError` — later DB calls on the
 *      request's connection throw before running (a transaction rolls back,
 *      never commits) and an in-flight call is `break()`-ed by the adapter;
 *   2. headers not sent -> 504 JSON envelope + `Connection: close`;
 *      headers sent    -> destroy the response socket;
 *   3. log at error level (not critical: no per-cut email), count in the
 *      metrics store, feed the burst detector (ONE critical email when
 *      WATCHDOG_ALERT_BURST cuts land within WATCHDOG_ALERT_WINDOW_MS), and
 *      notify the shutdown hook (idle cuts during a stop).
 *   The 504 passes through the CORS policy (`applyToErrorResponse`) first.
 *   `res.locals.__watchdogTerminated` tells ErrorHandlerMiddleware to drop the
 *   handler's late error.
 *
 * SSE responses (route rule or `text/event-stream` content type) are exempt.
 * `server.requestTimeout` is independent: it only bounds request RECEIPT.
 *
 * Class: holds a WeakMap + wraps the server + owns a shutdown hook.
 */

const { logger } = require("../logger");
const { AppError, REQUEST_ERRORS } = require("../../constants/errors");
const { sendError } = require("../../constants/responses");
const { HTTP_STATUS } = require("../../constants");
const { watchdogMessages } = require("../../constants/messages");
const {
    EXEMPT,
    resolveIdleLimits,
    classifyRoute,
} = require("../../constants/requestWatchdog");
const { metricsStore } = require("../../middleware/metrics/MetricsStore");
const { buildRouteLabel } = require("../routeLabel");
const { ProgressScope } = require("./ProgressScope");
const { defaultIdleWatchdog } = require("./IdleWatchdog");
const { defaultBurstDetector } = require("./WatchdogBurstDetector");

/**
 * Label for a request with no route template (stalled before routing): the
 * `/api/vN` prefix plus the FIRST segment only, then `/…` — never an id.
 * @param {string} p - Raw path without query string.
 * @returns {string}
 */
const maskIds = (p) => {
    const m = /^(\/api\/v\d+)?(\/[^/]+)?/.exec(p);
    return `${m?.[1] ?? ""}${m?.[2] ?? ""}/…`;
};

class RequestWatchdog {
    /** @type {WeakMap<import("http").IncomingMessage, ProgressScope>} */
    static #scopes = new WeakMap();
    /** @type {null | ((cut: { method: string, path: string, ageMs: number, idleMs: number }) => void)} */
    static #shutdownHook = null;

    /**
     * The ProgressScope of a request (undefined outside a watched server).
     * @param {import("http").IncomingMessage} req
     * @returns {ProgressScope|undefined}
     */
    static scopeOf(req) {
        return req ? RequestWatchdog.#scopes.get(req) : undefined;
    }

    /**
     * Register the callback invoked after EVERY termination (the receiver
     * decides whether a shutdown is in progress). Pass null to clear.
     * @param {null | ((cut: { method: string, path: string, ageMs: number, idleMs: number }) => void)} fn
     */
    static setShutdownHook(fn) {
        RequestWatchdog.#shutdownHook = typeof fn === "function" ? fn : null;
    }

    /**
     * @param {object} [options]
     * @param {{ defaultMs: number, longMs: number }} [options.limits] - Idle windows; default: env via `resolveIdleLimits`.
     * @param {import("./IdleWatchdog").IdleWatchdog} [options.idleWatchdog=defaultIdleWatchdog]
     * @param {() => number} [options.now=Date.now]
     * @param {{ applyToErrorResponse: Function }} [options.cors] - CORS policy for the 504 (default: the one `app.js` mounts).
     * @param {{ record: Function }} [options.burstDetector=defaultBurstDetector] - Stall-burst alert (one critical log per burst).
     */
    constructor({ limits, idleWatchdog = defaultIdleWatchdog, now = Date.now, cors, burstDetector = defaultBurstDetector } = {}) {
        this._burstDetector = burstDetector;
        this._corsOverride = cors ?? null;
        if (limits) {
            this._limits = limits;
        } else {
            const resolved = resolveIdleLimits(process.env);
            for (const w of resolved.warnings) {
                logger.warning(
                    watchdogMessages.WATCHDOG_LIMIT_CLAMPED(w.name, w.raw, w.applied),
                );
            }
            this._limits = resolved;
        }
        this._idleWatchdog = idleWatchdog;
        this._now = now;
    }

    /** @returns {{ applyToErrorResponse: Function }} */
    _corsPolicy() {
        return (
            this._corsOverride ??
            require("../../middleware/security/CorsMiddleware").defaultCors
        );
    }

    /**
     * Watch every request `server` receives. Uses `prependListener` so the scope
     * exists before the Express app (the first `request` listener) runs.
     * @param {import("http").Server} server
     * @returns {RequestWatchdog} this
     */
    attach(server) {
        server.prependListener("request", (req, res) => this._watch(req, res));
        return this;
    }

    /**
     * Idle limit for a request, from its route class.
     * @param {import("http").IncomingMessage} req
     * @returns {number}
     */
    _limitFor(req) {
        const cls = classifyRoute(req.method, req.url);
        if (cls === "exempt") return EXEMPT;
        return cls === "long" ? this._limits.longMs : this._limits.defaultMs;
    }

    /**
     * @param {import("http").IncomingMessage} req
     * @param {import("http").ServerResponse} res
     */
    _watch(req, res) {
        const scope = new ProgressScope({
            label: `${req.method} request`,
            idleLimitMs: this._limitFor(req),
            now: this._now,
        });
        RequestWatchdog.#scopes.set(req, scope);

        const socket = req.socket;
        const bytes = () => (socket?.bytesRead ?? 0) + (socket?.bytesWritten ?? 0);
        let lastBytes = bytes();

        const probe = (s) => {
            // `writeHead(status, {headers})` does not populate getHeader(), so
            // fall back to the serialised head once it was flushed.
            const ct = String(res.getHeader?.("content-type") ?? "");
            const flushed = typeof res._header === "string" ? res._header : "";
            if (
                ct.includes("text/event-stream") ||
                /^content-type:\s*text\/event-stream/im.test(flushed)
            ) {
                s.touch("sse-exempt");
                return;
            }
            const b = bytes();
            if (b !== lastBytes) {
                lastBytes = b;
                s.touch("socket-io");
            }
        };

        const unregister = this._idleWatchdog.register(
            scope,
            (s, idleMs) => this._terminate(req, res, s, idleMs),
            { probe },
        );

        let cleaned = false;
        const cleanup = () => {
            if (cleaned) return;
            cleaned = true;
            unregister();
            scope.dispose();
        };
        res.once("finish", cleanup);
        res.once("close", cleanup);
    }

    /**
     * Cut a stalled request. Never throws.
     * @param {import("http").IncomingMessage} req
     * @param {import("http").ServerResponse} res
     * @param {ProgressScope} scope
     * @param {number} idleMs
     */
    _terminate(req, res, scope, idleMs) {
        const method = req.method || "GET";
        const rawPath = String(req.originalUrl || req.url || "/").split("?")[0];
        const template = req.route?.path;
        const path =
            typeof template === "string"
                ? `${req.baseUrl ?? ""}${template}`
                : maskIds(rawPath);
        const ageMs = this._now() - scope.createdAt;
        const lastSource = scope.lastSource;

        try {
            scope.abort(
                new AppError(REQUEST_ERRORS.STALLED, HTTP_STATUS.GATEWAY_TIMEOUT, {
                    type: "RequestStalledError",
                    hint: REQUEST_ERRORS.STALLED_HINT,
                }),
            );

            if (!res.headersSent && !res.writableEnded) {
                res.locals = res.locals || {};
                res.locals.__watchdogTerminated = true;
                res.setHeader("Connection", "close");
                const body = sendError(REQUEST_ERRORS.STALLED, HTTP_STATUS.GATEWAY_TIMEOUT, {
                    type: "RequestStalledError",
                    hint: REQUEST_ERRORS.STALLED_HINT,
                    requestId: req.id ?? null,
                });
                // A stall before the CORS step (e.g. a client stopping mid-body
                // at step 4) would otherwise reach the browser as a network error.
                this._corsPolicy().applyToErrorResponse(req, res, () => {
                    if (typeof res.status === "function" && typeof res.json === "function") {
                        res.status(HTTP_STATUS.GATEWAY_TIMEOUT).json(body);
                    } else {
                        res.statusCode = HTTP_STATUS.GATEWAY_TIMEOUT;
                        res.setHeader("Content-Type", "application/json; charset=utf-8");
                        res.end(JSON.stringify(body));
                    }
                });
            } else {
                res.locals = res.locals || {};
                res.locals.__watchdogTerminated = true;
                res.destroy();
            }
        } catch (err) {
            logger.error(watchdogMessages.WATCHDOG_ONIDLE_FAILED(err.message));
            try {
                res.destroy();
            } catch {
                /* socket already gone */
            }
        }

        logger.error(
            watchdogMessages.WATCHDOG_REQUEST_STALLED(
                method,
                path,
                idleMs,
                scope.idleLimitMs,
                lastSource,
                ageMs,
            ),
        );
        try {
            metricsStore.recordWatchdogTermination(buildRouteLabel(req));
        } catch {
            /* metrics must never break a termination */
        }
        try {
            this._burstDetector.record({ method, path, lastSource });
        } catch {
            /* the burst alert must never break a termination */
        }

        const hook = RequestWatchdog.#shutdownHook;
        if (hook) {
            try {
                hook({ method, path, ageMs, idleMs });
            } catch {
                /* a hook error must not surface */
            }
        }
    }
}

module.exports = { RequestWatchdog };
