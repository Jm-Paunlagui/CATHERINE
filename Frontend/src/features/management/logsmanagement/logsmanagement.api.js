import httpClient from "../../../middleware/HttpClient";
import { API_BASE_URL_TRIMMED } from "../../../config/apiBase";

export const auditLogApi = {
  list:         (params)           => httpClient.get("audit-logs", { params }).then(r => r.data),
  stats:        (params)           => httpClient.get("audit-logs/stats", { params }).then(r => r.data),
  requestLogs:  (requestId, date)  => httpClient.get(`audit-logs/${requestId}/logs`, { params: { date } }).then(r => r.data),
  // Explicit 120s timeout on each: generating a binary Excel export
  // server-side is a genuinely long-running operation, longer than the
  // default request budget (HttpClient's global 30s).
  traceExcel:   (requestId, date)  => httpClient.get(`audit-logs/${requestId}/export/trace`, { params: { date }, responseType: "arraybuffer", timeout: 120_000 }).then(r => r.data),
  exportExcel:  (params)           => httpClient.get("audit-logs/export/excel", { params, responseType: "arraybuffer", timeout: 120_000 }).then(r => r.data),
  exportLogs:   (params)           => httpClient.get("audit-logs/export/logs",  { params, responseType: "arraybuffer", timeout: 120_000 }).then(r => r.data),
  deleteRange:  (params)           => httpClient.delete("audit-logs", { params }).then(r => r.data),

  /**
   * Opens an SSE stream for real-time audit log updates and live traffic metrics.
   *
   * Uses native EventSource (not httpClient — Axios cannot consume an SSE stream).
   * `withCredentials: true` makes the browser send the HTTP-only JWT cookie
   * automatically, so cookie-based auth works without manual header handling.
   * The stream route is a GET, so no CSRF token is required.
   *
   * Events from the server:
   *   connected  — on stream open;        { timestamp, pollIntervalMs }
   *   heartbeat  — every idle tick;       { timestamp, pollCount, metrics: { red, totals } }
   *   update     — new audit rows;        { timestamp, metrics: { red, totals } }
   *   error      — max poll errors hit;   stream closing
   *
   * @param {object} options
   * @param {(data: { timestamp: string, metrics: object }) => void} [options.onUpdate]
   * @param {(data: { timestamp: string, pollCount: number, metrics: object }) => void} [options.onHeartbeat]
   * @param {(event: Event) => void} [options.onError]
   * @returns {EventSource} The open EventSource — caller is responsible for .close().
   */
  createStream: ({ onUpdate, onHeartbeat, onError } = {}) => {
    const url = `${API_BASE_URL_TRIMMED}/audit-logs/stream`;
    const es = new EventSource(url, { withCredentials: true });

    es.addEventListener("update", (e) => {
      try { onUpdate?.(JSON.parse(e.data)); } catch { /* malformed frame — ignore */ }
    });
    es.addEventListener("heartbeat", (e) => {
      try { onHeartbeat?.(JSON.parse(e.data)); } catch { /* malformed frame — ignore */ }
    });
    if (onError) es.onerror = onError;

    return es;
  },
};

/**
 * HTTP + SSE calls for the "System" sub-tab (RFC 5424 server log files by
 * level) — GET audit-logs/system-logs (browse) and the
 * audit-logs/system-logs/stream live tail.
 *
 * @namespace systemLogApi
 */
export const systemLogApi = {
  /**
   * Browse RFC 5424 server log entries for one calendar day.
   *
   * @param {object} params
   * @param {string} [params.date]        - 'YYYY-MM-DD', defaults server-side to today.
   * @param {number} [params.maxPriority] - 0-7 ceiling; ignored when `level` is set.
   * @param {string} [params.level]       - Exact single level name; overrides maxPriority.
   * @param {number} [params.page]
   * @param {number} [params.pageSize]
   * @param {string} [params.search]
   * @returns {Promise<{ data: { rows: object[], total: number, page: number, pageSize: number, totalPages: number, truncatedFiles: string[] } }>}
   */
  list: (params) => httpClient.get("audit-logs/system-logs", { params }).then((r) => r.data),

  /**
   * Opens an SSE stream for the System sub-tab's live tail.
   *
   * Uses native EventSource (not httpClient — Axios cannot consume an SSE
   * stream). `withCredentials: true` sends the HTTP-only JWT cookie
   * automatically. Separate connection from `createStream` above (the audit
   * traffic stream) — a user may hold both open at once.
   *
   * Events from the server:
   *   connected  — on stream open;   { timestamp, maxPriority, level? }
   *   heartbeat  — every idle tick;  { timestamp, pollCount }
   *   lines      — new parsed rows;  { timestamp, lines: object[], dropped: number }
   *   error      — max poll errors hit; stream closing
   *
   * @param {object} options
   * @param {number} [options.maxPriority=5]
   * @param {string} [options.level] - Exact single level name (case-insensitive;
   *   e.g. "debug"). Overrides `maxPriority` server-side for this connection —
   *   mirrors `list()`'s `level` param overriding `maxPriority` on the browse
   *   endpoint. Omitted from the URL when not set.
   * @param {(data: { timestamp: string, lines: object[], dropped: number }) => void} [options.onLines]
   * @param {(data: { timestamp: string, pollCount: number }) => void} [options.onHeartbeat]
   * @param {(event: Event) => void} [options.onError]
   * @returns {EventSource} The open EventSource — caller is responsible for .close().
   */
  createStream: ({ maxPriority = 5, level, onLines, onHeartbeat, onError } = {}) => {
    const url = `${API_BASE_URL_TRIMMED}/audit-logs/system-logs/stream?maxPriority=${encodeURIComponent(maxPriority)}${level ? `&level=${encodeURIComponent(level)}` : ""}`;
    const es = new EventSource(url, { withCredentials: true });

    es.addEventListener("lines", (e) => {
      try { onLines?.(JSON.parse(e.data)); } catch { /* malformed frame — ignore */ }
    });
    es.addEventListener("heartbeat", (e) => {
      try { onHeartbeat?.(JSON.parse(e.data)); } catch { /* malformed frame — ignore */ }
    });
    if (onError) es.onerror = onError;

    return es;
  },
};
