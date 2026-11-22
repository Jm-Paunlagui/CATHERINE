

const auditLogMessages = {
  INSERT_FAILED: (requestId: unknown, err: unknown) =>
    `Audit log insert failed for REQUEST_ID ${requestId}: ${err}.`,
  BATCH_INSERT_FAILED: (count: unknown, err: unknown) =>
    `Audit log batch insert failed for ${count} record(s): ${err}.`,
  PENDING_OVERFLOW_DROPPED: (dropped: unknown, cap: unknown) =>
    `Audit log queue over cap ${cap} during DB outage — ${dropped} oldest record(s) dropped.`,
  SHUTDOWN_ROWS_UNPERSISTED: (count: unknown, reason: unknown) =>
    `Shutdown: ${count} audit record(s) could not be persisted (${reason}) and are lost.`,
  INSERT_SKIPPED_DISABLED: () =>
    `Audit log middleware is disabled — skipping DB insert.`,
  LIST_FETCHED: (count: unknown, page: unknown) =>
    `Audit log list fetched — ${count} rows, page ${page}.`,
  STATS_FETCHED: (fromDate: unknown, toDate: unknown) =>
    `Audit log stats fetched — range: ${fromDate} to ${toDate}.`,
  INVALID_DATE_RANGE_WARN: (fromDate: unknown, toDate: unknown) =>
    `Audit log query called with invalid date range: fromDate=${fromDate}, toDate=${toDate}.`,
  LOG_TRACE_FETCHED: (requestId: unknown, count: unknown) =>
    `Request log trace fetched — ${requestId}: ${count} line(s).`,
  EXPORT_EXCEL_STARTED: (from: unknown, to: unknown) =>
    `Audit log Excel export started — range: ${from} to ${to}.`,
  EXPORT_ZIP_STARTED: (from: unknown, to: unknown) =>
    `Audit log ZIP export started — range: ${from} to ${to}.`,
  EXPORT_ZIP_TRAVERSAL_BLOCKED: (file: unknown) =>
    `AuditLogService.exportToZip: path traversal attempt blocked — ${file}`,
  DELETE_RANGE_STARTED: (from: unknown, to: unknown) =>
    `Audit log delete range started — ${from} to ${to}.`,
  DELETE_RANGE_DONE: (rows: unknown, days: unknown) =>
    `Audit log delete complete — ${rows} DB rows, ${days} log day(s) removed.`,
  DELETE_DAY_FAILED: (day: unknown, err: unknown) =>
    `Audit log day folder delete failed — ${day}: ${err}.`,
  EXPORT_TRACE_STARTED: (requestId: unknown) =>
    `Audit log trace Excel export started — requestId: ${requestId}.`,

  // ── SSE (real-time stream) ───────────────────────────────────────────────────
  SSE_CONNECTED: (userId: unknown) =>
    `Audit log SSE connected — userId: ${userId}.`,
  SSE_DISCONNECTED: (userId: unknown) =>
    `Audit log SSE disconnected — userId: ${userId}.`,
  SSE_DUPLICATE_CONNECTION: (userId: unknown) =>
    `Audit log SSE duplicate connection rejected — userId: ${userId}.`,
  SSE_BASELINE_ESTABLISHED: (userId: unknown, latestTs: unknown) =>
    `Audit log SSE baseline established — userId: ${userId}, latestTs: ${latestTs ?? 'none'}.`,
  SSE_UPDATE_SENT: (userId: unknown) =>
    `Audit log SSE update pushed — userId: ${userId}.`,
  SSE_POLL_ERROR: (err: unknown) =>
    `Audit log SSE poll error: ${err}.`,
  SSE_SHARED_POLL_STARTED: () =>
    `Audit log SSE shared poller started.`,
  SSE_SHARED_POLL_STOPPED: () =>
    `Audit log SSE shared poller stopped.`,
  SSE_SHARED_POLL_MAX_ERRORS: (size: unknown, max: unknown) =>
    `Audit log SSE shared poller hit ${max} consecutive errors with ${size} client(s) — stopping and notifying all.`,
  SSE_CONNECTED_EVENT_SENT: (userId: unknown) =>
    `Audit log SSE connected event sent — userId: ${userId}.`,

  // ── System log file view (RFC 5424 level files, System sub-tab) ─────────────
  SYSTEM_LOGS_FETCHED: (date: unknown, count: unknown, page: unknown) =>
    `System log entries fetched — date: ${date}, ${count} row(s), page ${page}.`,
  SYSTEM_LOG_DIR_MISSING: (date: unknown) =>
    `System log directory not found for date ${date} — returning empty result.`,

  // ── System log SSE live tail (SystemLogTailService) ─────────────────────────
  SYSTEM_TAIL_STARTED: () =>
    `System log tail poller started.`,
  SYSTEM_TAIL_STOPPED: () =>
    `System log tail poller stopped — no active connections.`,
  SYSTEM_TAIL_CONNECTED: (connId: unknown) =>
    `System log tail SSE connected — connId: ${connId}.`,
  SYSTEM_TAIL_DISCONNECTED: (connId: unknown) =>
    `System log tail SSE disconnected — connId: ${connId}.`,
  SYSTEM_TAIL_DUPLICATE_CONNECTION: (connId: unknown) =>
    `System log tail SSE duplicate connection rejected — connId: ${connId}.`,
  SYSTEM_TAIL_ROTATION_DETECTED: (file: unknown) =>
    `System log tail detected rotation/truncation on ${file} — offset reset to 0.`,
  SYSTEM_TAIL_DIR_ROLLOVER: (dir: unknown) =>
    `System log tail day directory changed — now tailing ${dir}.`,
  SYSTEM_TAIL_TICK_ERROR: (err: unknown) =>
    `System log tail poll tick error: ${err}.`,
  SYSTEM_TAIL_MAX_ERRORS: (size: unknown, max: unknown) =>
    `System log tail poller hit ${max} consecutive errors with ${size} client(s) — stopping and notifying all.`,
};

export { auditLogMessages };
