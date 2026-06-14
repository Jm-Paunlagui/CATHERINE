"use strict";

const { catchAsync } = require('../utils/catchAsync');
const { sendSuccess, RESPONSE_MESSAGES } = require('../constants/responses');
const AuditLogService = require('../services/AuditLogService');
const MetricsService = require('../services/MetricsService');
const { logger } = require('../utils/logger');
const { auditLogMessages } = require('../constants/messages');

// ── SSE shared poller ─────────────────────────────────────────────────────────
//
// Architecture: one setInterval for the entire process, one Oracle LIMIT 1 query
// per tick regardless of how many admins are connected. Each connection is keyed
// by userId; all admins observe the same audit-log dataset, so detecting "new
// rows arrived" is a single MAX(CREATED_AT)-equivalent read fanned out in memory.
//
// The metrics snapshot pushed on every tick comes from MetricsStore.getSnapshot()
// which already excludes OPTIONS requests (filtered by MetricsMiddleware), so the
// live-traffic charts never count CORS preflights.
//
// NOT wrapped in catchAsync — the stream method upgrades the connection to an
// event stream, after which an HTTP error response would crash with write-after-end.
// Errors are handled internally and surfaced as SSE `error` events instead.

/** SSE poll interval in milliseconds. */
const SSE_POLL_INTERVAL_MS = 5_000;

/** Consecutive Oracle failures before notifying all clients and stopping. */
const SSE_MAX_POLL_ERRORS = 5;

/**
 * Registry of every active SSE connection keyed by userId.
 *
 * @type {Map<string, { res: import('express').Response, lastCreatedAtMs: number|undefined, pollCount: number, connectedAt: string }>}
 *
 * lastCreatedAtMs semantics:
 *   undefined  — baseline not yet set (first poll tick pending)
 *   number     — baseline established; compared against the latest CREATED_AT
 */
const _auditConnections = new Map();

/** setInterval reference for the shared poller. null when idle. */
let _auditPollInterval = null;

/** Consecutive Oracle failures on the shared poller since it last started. */
let _consecutivePollErrors = 0;

/**
 * Last cumulative-counter sample, used to derive per-second rates (req/s, err/s)
 * from the difference between two consecutive poll ticks. Reset to null when the
 * poller stops so the first tick after a restart re-establishes the baseline
 * instead of emitting a huge artificial spike.
 *
 * @type {{ requestsTotal: number, errorsTotal: number, atMs: number } | null}
 */
let _lastRateSample = null;

/** Bytes per mebibyte — for heap/RSS MB conversions in the SSE payload. */
const BYTES_PER_MB = 1024 * 1024;

/**
 * Writes a named SSE event and immediately flushes the compression buffer.
 * Swallows write errors — a closed socket is cleaned up by req.on("close").
 *
 * @param {import('express').Response} res
 * @param {string} eventName
 * @param {object} payload
 */
const _safeSend = (res, eventName, payload) => {
    try {
        res.write(`event: ${eventName}\n`);
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
        // CompressionMiddleware (gzip) patches res.flush() onto the response;
        // without it, gzip buffers SSE events until the buffer fills.
        if (typeof res.flush === 'function') res.flush();
    } catch {
        // Socket already closed — req.on("close") removes the Map entry
    }
};

/**
 * Build the metrics payload pushed on every tick. MetricsService throws
 * (AppError 503) if the snapshot is unavailable; we swallow it and push null so
 * a metrics hiccup never breaks the audit-log stream.
 *
 * The payload carries everything the live-traffic dashboard needs from the
 * in-process MetricsStore (which already EXCLUDES OPTIONS preflights):
 *   - red     : per-route RED metrics (top-endpoint + latency charts)
 *   - totals  : cumulative counts incl. successTotal/redirectsTotal/errorsTotal/apdex
 *   - system  : cpuPct, memoryMb, rssMb, eventLoopLag, uptime
 *   - rates   : reqPerSec / errPerSec, derived from the delta vs the prior tick
 *
 * @returns {{ red: object, totals: object, system: object, rates: object }|null}
 */
const _buildMetricsPayload = () => {
    try {
        const snap = MetricsService.getSnapshot();
        const t = snap.totals;
        const errorsTotal = t.errorsTotal ?? (t.clientErrorsTotal + t.serverErrorsTotal);

        // Derive per-second rates from the delta vs the previous tick. A negative
        // delta (process/counter reset) is clamped to 0 to avoid a phantom spike.
        const nowMs = Date.now();
        let reqPerSec = 0;
        let errPerSec = 0;
        if (_lastRateSample) {
            const dtSec = (nowMs - _lastRateSample.atMs) / 1000;
            if (dtSec > 0) {
                reqPerSec = Math.max(0, (t.requestsTotal - _lastRateSample.requestsTotal) / dtSec);
                errPerSec = Math.max(0, (errorsTotal - _lastRateSample.errorsTotal) / dtSec);
            }
        }
        _lastRateSample = { requestsTotal: t.requestsTotal, errorsTotal, atMs: nowMs };

        const mem = snap.system?.memory ?? {};
        return {
            red: snap.red,
            totals: t,
            system: {
                cpuPct: snap.system?.cpu?.percent ?? 0,
                memoryMb: Number(((mem.heapUsed ?? 0) / BYTES_PER_MB).toFixed(2)),
                rssMb: Number(((mem.rss ?? 0) / BYTES_PER_MB).toFixed(2)),
                eventLoopLag: snap.system?.eventLoopLag ?? 0,
                uptime: snap.uptime ?? 0,
            },
            rates: {
                reqPerSec: Number(reqPerSec.toFixed(2)),
                errPerSec: Number(errPerSec.toFixed(2)),
            },
        };
    } catch {
        return null;
    }
};

/**
 * Shared poll tick — fires once per SSE_POLL_INTERVAL_MS for ALL connections.
 *
 * One Oracle LIMIT 1 query yields the latest CREATED_AT; the result and a fresh
 * metrics snapshot are fanned out to every connection in O(connections) memory
 * work — zero additional DB calls regardless of connection count.
 *
 * @returns {Promise<void>}
 */
const _auditSharedPoll = async () => {
    if (_auditConnections.size === 0) return;
    const ts = new Date().toISOString();

    try {
        const latestMs = await AuditLogService.getLatestCreatedAt();
        const metricsPayload = _buildMetricsPayload();
        _consecutivePollErrors = 0;

        for (const [userId, conn] of _auditConnections) {
            conn.pollCount++;

            if (conn.lastCreatedAtMs === undefined) {
                // First tick for this connection — lock in the baseline
                conn.lastCreatedAtMs = latestMs;
                logger.info(auditLogMessages.SSE_BASELINE_ESTABLISHED(userId, latestMs));
                _safeSend(conn.res, 'heartbeat', { timestamp: ts, pollCount: conn.pollCount, metrics: metricsPayload });
                continue;
            }

            if (latestMs > conn.lastCreatedAtMs) {
                conn.lastCreatedAtMs = latestMs;
                logger.info(auditLogMessages.SSE_UPDATE_SENT(userId));
                _safeSend(conn.res, 'update', { timestamp: ts, metrics: metricsPayload });
            } else {
                _safeSend(conn.res, 'heartbeat', { timestamp: ts, pollCount: conn.pollCount, metrics: metricsPayload });
            }
        }
    } catch (err) {
        _consecutivePollErrors++;
        logger.error(auditLogMessages.SSE_POLL_ERROR(err.message ?? String(err)));

        if (_consecutivePollErrors >= SSE_MAX_POLL_ERRORS) {
            logger.warning(auditLogMessages.SSE_SHARED_POLL_MAX_ERRORS(_auditConnections.size, SSE_MAX_POLL_ERRORS));
            for (const [, conn] of _auditConnections) {
                _safeSend(conn.res, 'error', { message: 'Stream polling failed repeatedly. Please refresh your page.', code: 'POLL_FAILED' });
            }
            _auditConnections.clear();
            clearInterval(_auditPollInterval);
            _auditPollInterval = null;
        }
    }
};

/**
 * Starts the shared poller. Idempotent — safe to call on every new connection.
 */
const _startAuditPoller = () => {
    if (_auditPollInterval !== null) return;
    _consecutivePollErrors = 0;
    _auditPollInterval = setInterval(_auditSharedPoll, SSE_POLL_INTERVAL_MS);
    logger.notice(auditLogMessages.SSE_SHARED_POLL_STARTED());
};

/**
 * Stops the shared poller once no connections remain.
 */
const _stopAuditPoller = () => {
    if (_auditConnections.size > 0 || _auditPollInterval === null) return;
    clearInterval(_auditPollInterval);
    _auditPollInterval = null;
    _lastRateSample = null; // next start re-establishes the rate baseline
    logger.notice(auditLogMessages.SSE_SHARED_POLL_STOPPED());
};

class AuditLogController {
  static getList = catchAsync(async (req, res) => {
    const { page = 1, pageSize = 20, fromDate, toDate, method, statusCategory, search } = req.query;
    const data = await AuditLogService.getList({
      page:     parseInt(page, 10)     || 1,
      pageSize: parseInt(pageSize, 10) || 20,
      fromDate,
      toDate,
      method,
      statusCategory,
      search,
    });
    res.json(sendSuccess(RESPONSE_MESSAGES.AUDIT_LOG_LIST_FETCHED, data));
  });

  static getStats = catchAsync(async (req, res) => {
    const { fromDate, toDate } = req.query;
    const data = await AuditLogService.getStats({ fromDate, toDate });
    res.json(sendSuccess(RESPONSE_MESSAGES.AUDIT_LOG_STATS_FETCHED, data));
  });

  static getRequestLogs = catchAsync(async (req, res) => {
    const { requestId } = req.params;
    const { date }      = req.query;
    const data = await AuditLogService.getRequestLogs(requestId, date);
    res.json(sendSuccess(RESPONSE_MESSAGES.AUDIT_LOG_TRACE_FETCHED, data));
  });

  /**
   * Export a single request trace as an Excel workbook (two sheets:
   * "Request Summary" and "Log Trace"). Reads the requestId from the URL
   * param and the date (YYYY-MM-DD) from the query string.
   *
   * @param {import('express').Request}  req
   * @param {import('express').Response} res
   */
  static exportTraceExcel = catchAsync(async (req, res) => {
    const { requestId } = req.params;
    const { date }      = req.query;
    const buffer = await AuditLogService.exportTraceExcel(requestId, date);
    const safeId = requestId.replace(/[^A-Za-z0-9_-]/g, '');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="trace-${safeId}-${date}.xlsx"`);
    res.send(buffer);
  });

  /**
   * Export audit log DB records for a date range as an Excel file.
   * Responds with the raw buffer and appropriate Content-Disposition header.
   *
   * @param {import('express').Request}  req
   * @param {import('express').Response} res
   */
  static exportExcel = catchAsync(async (req, res) => {
    const { fromDate, toDate } = req.query;
    const buffer = await AuditLogService.exportToExcel({ fromDate, toDate });
    const safeFrom = String(fromDate).replace(/[^0-9\-]/g, '');
    const safeTo = String(toDate).replace(/[^0-9\-]/g, '');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="audit-logs-${safeFrom}-to-${safeTo}.xlsx"`);
    res.send(buffer);
  });

  /**
   * Export server log files for a date range as a ZIP archive.
   * Responds with the raw buffer and appropriate Content-Disposition header.
   *
   * @param {import('express').Request}  req
   * @param {import('express').Response} res
   */
  static exportLogs = catchAsync(async (req, res) => {
    const { fromDate, toDate } = req.query;
    const buffer = await AuditLogService.exportToZip({ fromDate, toDate });
    const safeFrom = String(fromDate).replace(/[^0-9\-]/g, '');
    const safeTo = String(toDate).replace(/[^0-9\-]/g, '');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="server-logs-${safeFrom}-to-${safeTo}.zip"`);
    res.send(buffer);
  });

  /**
   * Permanently delete audit log DB records and server log files in the given range.
   *
   * @param {import('express').Request}  req
   * @param {import('express').Response} res
   */
  static deleteRange = catchAsync(async (req, res) => {
    const { fromDate, toDate } = req.query;
    const result = await AuditLogService.deleteRange({ fromDate, toDate });
    res.json(sendSuccess(RESPONSE_MESSAGES.AUDIT_LOG_DELETED, result));
  });

  /**
   * GET /api/v1/audit-logs/stream
   *
   * SSE endpoint — real-time audit log change notifications + live traffic metrics.
   * Requires isAdminOrSuperAdmin (enforced by route middleware before this runs).
   *
   * Events:
   *   connected  — sent immediately on upgrade; carries { timestamp, pollIntervalMs }
   *   heartbeat  — every idle tick; carries { timestamp, pollCount, metrics: { red, totals } }
   *   update     — when new audit log rows are detected; carries { timestamp, metrics }
   *   error      — when max consecutive poll errors reached; the stream will close
   *
   * NOT wrapped in catchAsync — it manages its own SSE lifecycle. Wrapping it
   * would attempt an HTTP error response after the connection is already an event
   * stream, crashing with write-after-end.
   *
   * The metrics payload uses MetricsStore.getSnapshot() which already excludes
   * OPTIONS requests (filtered by MetricsMiddleware).
   *
   * @param {import('express').Request}  req
   * @param {import('express').Response} res
   */
  static stream = async (req, res) => {
    if (!req.user) {
      res.status(401).json({ status: 'error', code: 401, message: 'Authentication required.', error: { type: 'AuthenticationError' } });
      return;
    }

    const userId = String(req.user.userId);

    if (_auditConnections.has(userId)) {
      logger.warning(auditLogMessages.SSE_DUPLICATE_CONNECTION(userId));
      res.status(409).json({ status: 'error', code: 409, message: 'Stream already open for this account.', error: { type: 'ConflictError' } });
      return;
    }

    // ── SSE headers ───────────────────────────────────────────────────────────
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Nginx proxy buffer disable
    res.flushHeaders();

    logger.info(auditLogMessages.SSE_CONNECTED(userId));

    // Register in the shared connection map — baseline is set on the first poll tick
    _auditConnections.set(userId, {
      res,
      lastCreatedAtMs: undefined, // undefined = awaiting first poll
      pollCount: 0,
      connectedAt: new Date().toISOString(),
    });

    // Immediate connected event — client sees data before the first poll tick
    _safeSend(res, 'connected', {
      timestamp: new Date().toISOString(),
      pollIntervalMs: SSE_POLL_INTERVAL_MS,
    });
    logger.info(auditLogMessages.SSE_CONNECTED_EVENT_SENT(userId));

    // Start the shared poller if this is the first connection (idempotent)
    _startAuditPoller();

    // ── Cleanup on disconnect ───────────────────────────────────────────────────
    req.on('close', () => {
      _auditConnections.delete(userId);
      logger.info(auditLogMessages.SSE_DISCONNECTED(userId));
      _stopAuditPoller(); // no-op unless _auditConnections is now empty
    });
  };
}

module.exports = AuditLogController;
