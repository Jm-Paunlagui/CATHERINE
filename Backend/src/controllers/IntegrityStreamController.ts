"use strict";

/**
 * @fileoverview Integrity Center SSE live-tail controller.
 *
 * Real-time tamper watch for append-only tables registered with `live: true`.
 * Shared-poller shape:
 *   - ONE process-wide setInterval, regardless of connection count.
 *   - Connections are grouped by SUBSCRIPTION (table + scope filters); each
 *     distinct subscription issues ONE getMaxPk/listSince delta per tick and
 *     fans out to all its connections. O(distinct subscriptions) DB/tick.
 *   - On a new row beyond the cursor: pushes `update { newCount, tampered[] }`.
 *     Otherwise `heartbeat`. The cursor is the table's global MAX(pk).
 *
 * Access: SUPER_ADMIN only (enforced at the route via requireSuperAdmin; the
 * EventSource sends the HTTP-only JWT cookie with withCredentials — CWE-287).
 *
 * NOT wrapped in catchAsync — once the response is an event stream we can no
 * longer send a JSON error; the method manages its own lifecycle and the shared
 * poller catches/contains its own failures.
 */

const { logger } = require("../utils/logger");
const { integrityMessages } = require("../constants/messages");
const IntegrityModel = require("../models/integrity.model");
const IntegrityService = require("../services/IntegrityService");
const IntegrityController = require("./IntegrityController");
const SseConnectionRegistry = require("../utils/sse/SseConnectionRegistry");
const { HTTP_STATUS } = require("../constants");
const {
    AUTH_ERRORS,
    STREAM_ERRORS,
} = require("../constants/errors");
const { sendSsePreflightError } = require("../utils/sse/ssePreflight");

/** SSE poll interval (ms). */
const POLL_INTERVAL_MS = 5_000;
/** Consecutive poll failures before notifying clients and stopping. */
const MAX_POLL_ERRORS = 5;
/** Max delta rows verified per tick per subscription (bounds tick cost). */
const DELTA_CAP = 500;

/**
 * Subscriptions keyed by `${table}|${scopeJSON}`.
 * @type {Map<string, { key: string, filters: object, cursor: number|null, conns: Map<string, import('express').Response> }>}
 */
const _subs = new Map();

let _pollInterval = null;
let _consecutiveErrors = 0;

/**
 * Writes a named SSE event and flushes the gzip buffer. Swallows write errors —
 * a closed socket is cleaned up by req.on("close").
 * @param {import('express').Response} res
 * @param {string} event
 * @param {object} payload
 */
function _safeSend(res, event, payload) {
    try {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
        if (typeof res.flush === "function") res.flush();
    } catch {
        /* socket closed — cleanup handled on close */
    }
}

/** Deterministic subscription key from table + scope filters (sorted keys). */
function _subKey(table, filters) {
    const scope = {};
    for (const k of Object.keys(filters).sort()) {
        const v = filters[k];
        if (v == null) continue;
        scope[k] = v instanceof Date ? v.toISOString() : v;
    }
    return `${table}|${JSON.stringify(scope)}`;
}

/**
 * Shared poll tick — one delta query per active subscription, fan-out to its
 * connections. O(distinct subscriptions) DB, O(connections) JS.
 */
async function _sharedPoll() {
    // Re-entrancy guard: a slow tick must not overlap the next interval fire.
    if (_pollBusy) return;
    _pollBusy = true;
    try {
        await _sharedPollTick();
    } finally {
        _pollBusy = false;
    }
}

/** True while a `_sharedPoll` tick is in flight. */
let _pollBusy = false;

/** Body of one integrity poll tick — wrapped by `_sharedPoll`'s guard. */
async function _sharedPollTick() {
    if (_subs.size === 0) return;
    const ts = new Date().toISOString();

    try {
        for (const [, sub] of _subs) {
            const delta = await IntegrityService.getLiveDelta(sub.key, sub.filters, sub.cursor, DELTA_CAP);

            if (delta.newCount > 0) {
                sub.cursor = delta.maxPk;
                for (const [, res] of sub.conns) {
                    _safeSend(res, "update", {
                        table: sub.key,
                        newCount: delta.newCount,
                        maxPk: delta.maxPk,
                        tampered: delta.tampered,
                    });
                }
                logger.info(integrityMessages.SSE_UPDATE_SENT(sub.key, delta.newCount, delta.tampered.length));
                if (delta.tampered.length > 0) {
                    logger.security("INTEGRITY_TAMPER_LIVE", { table: sub.key, count: delta.tampered.length });
                }
            } else {
                for (const [, res] of sub.conns) {
                    _safeSend(res, "heartbeat", { timestamp: ts });
                }
            }
        }
        _consecutiveErrors = 0;
    } catch (err) {
        _consecutiveErrors++;
        logger.error(integrityMessages.SSE_POLL_ERROR("shared-poller", err.message ?? String(err)));
        if (_consecutiveErrors >= MAX_POLL_ERRORS) {
            let conns = 0;
            for (const [, sub] of _subs) {
                for (const [, res] of sub.conns) {
                    conns++;
                    _safeSend(res, "error", { message: "Stream polling failed repeatedly. Please refresh.", code: "POLL_FAILED" });
                }
            }
            logger.warning(integrityMessages.SSE_MAX_ERRORS(conns, MAX_POLL_ERRORS));
            _subs.clear();
            clearInterval(_pollInterval);
            _pollInterval = null;
        }
    }
}

/** Starts the shared poller (idempotent). */
function _startPoller() {
    if (_pollInterval !== null) return;
    _consecutiveErrors = 0;
    _pollInterval = setInterval(_sharedPoll, POLL_INTERVAL_MS);
    _pollInterval.unref?.();
    logger.notice(integrityMessages.SSE_POLL_STARTED());
}

/** Stops the shared poller once no subscriptions remain. */
function _stopPollerIfIdle() {
    if (_subs.size > 0 || _pollInterval === null) return;
    clearInterval(_pollInterval);
    _pollInterval = null;
    logger.notice(integrityMessages.SSE_POLL_STOPPED());
}

class IntegrityStreamController {
    /**
     * GET /api/v1/integrity/stream?table=<key>[&<filter>=…]
     *
     * Registers the connection under its (table, scope) subscription, sets the
     * baseline cursor to the current MAX(pk), and streams update/heartbeat events.
     * SUPER_ADMIN-only (route guard). NOT catchAsync — manages its own lifecycle.
     *
     * @param {import('express').Request} req
     * @param {import('express').Response} res
     */
    static stream = async (req, res) => {
        if (!req.user) {
            sendSsePreflightError(
                req,
                res,
                AUTH_ERRORS.AUTHENTICATION_REQUIRED,
                HTTP_STATUS.UNAUTHORIZED,
                { type: "AuthenticationError" },
            );
            return;
        }

        const table = String(req.query.table ?? "");
        const cfg = IntegrityModel.getTableConfig(table);
        if (!cfg || !cfg.live) {
            sendSsePreflightError(
                req,
                res,
                STREAM_ERRORS.TABLE_NOT_STREAMABLE,
                HTTP_STATUS.BAD_REQUEST,
                { type: "ValidationError" },
            );
            return;
        }

        // Parse scope + resolve the baseline cursor BEFORE upgrading to SSE — once
        // the response is an event stream we can no longer send a JSON error.
        let filters;
        let baseline;
        try {
            filters = IntegrityController.parseFilters(req.query);
            baseline = await IntegrityService.getMaxPk(table, filters);
        } catch (err) {
            // A filter-validation AppError (4xx) carries a client-safe message.
            // Anything else (a getMaxPk DB failure) is logged server-side and
            // answered with a generic 500 — never the raw driver text (CWE-209).
            if (err?.isOperational && err.statusCode >= 400 && err.statusCode < 500) {
                sendSsePreflightError(req, res, err.message, err.statusCode, {
                    type: "ValidationError",
                });
                return;
            }
            logger.error(integrityMessages.SSE_BASELINE_FAILED(table, err?.message ?? String(err)));
            sendSsePreflightError(
                req,
                res,
                STREAM_ERRORS.BASELINE_UNAVAILABLE,
                HTTP_STATUS.INTERNAL_SERVER_ERROR,
                { type: "DatabaseError" },
            );
            return;
        }

        // ── SSE headers ───────────────────────────────────────────────────────
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();

        // Register with the process-level SSE registry so gracefulShutdown can
        // end this stream cleanly on restart (defect B1).
        const unregisterFromShutdown = SseConnectionRegistry.register(res);

        const actor = req.user.userId ?? req.user.sub ?? "SYSTEM";
        const sk = _subKey(table, filters);
        const connId = `${actor}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

        let sub = _subs.get(sk);
        if (!sub) {
            sub = { key: table, filters, cursor: baseline, conns: new Map() };
            _subs.set(sk, sub);
            logger.notice(integrityMessages.SSE_BASELINE(table, baseline));
        }
        sub.conns.set(connId, res);
        logger.info(integrityMessages.SSE_CONNECTED(table, actor));

        _safeSend(res, "connected", {
            table,
            baselineMaxPk: sub.cursor,
            pollIntervalMs: POLL_INTERVAL_MS,
        });

        _startPoller();

        req.on("close", () => {
            unregisterFromShutdown();
            const s = _subs.get(sk);
            if (s) {
                s.conns.delete(connId);
                if (s.conns.size === 0) _subs.delete(sk);
            }
            logger.info(integrityMessages.SSE_DISCONNECTED(table, actor));
            _stopPollerIfIdle();
        });
    };
}

module.exports = IntegrityStreamController;
