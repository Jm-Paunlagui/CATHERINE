import httpClient from "../../../middleware/HttpClient";

export const auditLogApi = {
  list:         (params)           => httpClient.get("audit-logs", { params }).then(r => r.data),
  stats:        (params)           => httpClient.get("audit-logs/stats", { params }).then(r => r.data),
  requestLogs:  (requestId, date)  => httpClient.get(`audit-logs/${requestId}/logs`, { params: { date } }).then(r => r.data),
  traceExcel:   (requestId, date)  => httpClient.get(`audit-logs/${requestId}/export/trace`, { params: { date }, responseType: "arraybuffer" }).then(r => r.data),
  exportExcel:  (params)           => httpClient.get("audit-logs/export/excel", { params, responseType: "arraybuffer" }).then(r => r.data),
  exportLogs:   (params)           => httpClient.get("audit-logs/export/logs",  { params, responseType: "arraybuffer" }).then(r => r.data),
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
    const baseUrl = import.meta.env.VITE_API_BASE_URL || "http://localhost:3000/api/v1/";
    const url = `${baseUrl.replace(/\/$/, "")}/audit-logs/stream`;
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
