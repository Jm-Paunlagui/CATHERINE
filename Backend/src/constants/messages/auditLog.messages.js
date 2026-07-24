"use strict";

const auditLogMessages = {
  INSERT_FAILED: (requestId, err) =>
    `Audit log insert failed for REQUEST_ID ${requestId}: ${err}.`,
  BATCH_INSERT_FAILED: (count, err) =>
    `Audit log batch insert failed for ${count} record(s): ${err}.`,
  INSERT_SKIPPED_DISABLED: () =>
    `Audit log middleware is disabled — skipping DB insert.`,
  LIST_FETCHED: (count, page) =>
    `Audit log list fetched — ${count} rows, page ${page}.`,
  STATS_FETCHED: (fromDate, toDate) =>
    `Audit log stats fetched — range: ${fromDate} to ${toDate}.`,
  INVALID_DATE_RANGE_WARN: (fromDate, toDate) =>
    `Audit log query called with invalid date range: fromDate=${fromDate}, toDate=${toDate}.`,
  LOG_TRACE_FETCHED: (requestId, count) =>
    `Request log trace fetched — ${requestId}: ${count} line(s).`,
  EXPORT_EXCEL_STARTED: (from, to) =>
    `Audit log Excel export started — range: ${from} to ${to}.`,
  EXPORT_ZIP_STARTED: (from, to) =>
    `Audit log ZIP export started — range: ${from} to ${to}.`,
  DELETE_RANGE_STARTED: (from, to) =>
    `Audit log delete range started — ${from} to ${to}.`,
  DELETE_RANGE_DONE: (rows, days) =>
    `Audit log delete complete — ${rows} DB rows, ${days} log day(s) removed.`,
  DELETE_DAY_FAILED: (day, err) =>
    `Audit log day folder delete failed — ${day}: ${err}.`,
  EXPORT_TRACE_STARTED: (requestId) =>
    `Audit log trace Excel export started — requestId: ${requestId}.`,

  // ── SSE (real-time stream) ───────────────────────────────────────────────────
  SSE_CONNECTED: (userId) =>
    `Audit log SSE connected — userId: ${userId}.`,
  SSE_DISCONNECTED: (userId) =>
    `Audit log SSE disconnected — userId: ${userId}.`,
  SSE_DUPLICATE_CONNECTION: (userId) =>
    `Audit log SSE duplicate connection rejected — userId: ${userId}.`,
  SSE_BASELINE_ESTABLISHED: (userId, latestTs) =>
    `Audit log SSE baseline established — userId: ${userId}, latestTs: ${latestTs ?? 'none'}.`,
  SSE_UPDATE_SENT: (userId) =>
    `Audit log SSE update pushed — userId: ${userId}.`,
  SSE_POLL_ERROR: (err) =>
    `Audit log SSE poll error: ${err}.`,
  SSE_SHARED_POLL_STARTED: () =>
    `Audit log SSE shared poller started.`,
  SSE_SHARED_POLL_STOPPED: () =>
    `Audit log SSE shared poller stopped.`,
  SSE_SHARED_POLL_MAX_ERRORS: (size, max) =>
    `Audit log SSE shared poller hit ${max} consecutive errors with ${size} client(s) — stopping and notifying all.`,
  SSE_CONNECTED_EVENT_SENT: (userId) =>
    `Audit log SSE connected event sent — userId: ${userId}.`,
  
  // ── System log file view (RFC 5424 level files, System sub-tab) ─────────────
  SYSTEM_LOGS_FETCHED: (date, count, page) =>
    `System log entries fetched — date: ${date}, ${count} row(s), page ${page}.`,
  SYSTEM_LOG_DIR_MISSING: (date) =>
    `System log directory not found for date ${date} — returning empty result.`,

  // ── System log SSE live tail (SystemLogTailService) ─────────────────────────
  SYSTEM_TAIL_STARTED: () =>
    `System log tail poller started.`,
  SYSTEM_TAIL_STOPPED: () =>
    `System log tail poller stopped — no active connections.`,
  SYSTEM_TAIL_CONNECTED: (connId) =>
    `System log tail SSE connected — connId: ${connId}.`,
  SYSTEM_TAIL_DISCONNECTED: (connId) =>
    `System log tail SSE disconnected — connId: ${connId}.`,
  SYSTEM_TAIL_DUPLICATE_CONNECTION: (connId) =>
    `System log tail SSE duplicate connection rejected — connId: ${connId}.`,
  SYSTEM_TAIL_ROTATION_DETECTED: (file) =>
    `System log tail detected rotation/truncation on ${file} — offset reset to 0.`,
  SYSTEM_TAIL_DIR_ROLLOVER: (dir) =>
    `System log tail day directory changed — now tailing ${dir}.`,
  SYSTEM_TAIL_TICK_ERROR: (err) =>
    `System log tail poll tick error: ${err}.`,
  SYSTEM_TAIL_MAX_ERRORS: (size, max) =>
    `System log tail poller hit ${max} consecutive errors with ${size} client(s) — stopping and notifying all.`,
};

module.exports = { auditLogMessages };
