/**
 * @fileoverview HTTP API layer for the metrics feature.
 * All calls go through httpClient — never direct Axios imports (CWE-352).
 * No state, no React, no side effects — pure HTTP calls only.
 */

import httpClient from "../../../middleware/HttpClient";

/**
 * @namespace metricsApi
 */
export const metricsApi = {
  /**
   * Fetch the full in-process metrics snapshot.
   * Requires userLevel >= 2.
   *
   * @returns {Promise<object>} Full metrics snapshot payload
   */
  snapshot: () => httpClient.get("metrics").then((r) => r.data),

  /**
   * Fetch the abbreviated metrics summary (totals, top-5 slow routes, alert count).
   * Requires userLevel >= 1.
   *
   * @returns {Promise<object>} Summary payload
   */
  summary: () => httpClient.get("metrics/summary").then((r) => r.data),

  /**
   * Fetch current alert evaluations.
   * Requires userLevel >= 2.
   *
   * @returns {Promise<{ alerts: Array, count: number }>} Alert evaluation payload
   */
  alerts: () => httpClient.get("metrics/alerts").then((r) => r.data),

  /**
   * Liveness probe — always 200 while the process is up. No auth required.
   *
   * @returns {Promise<object>} Response envelope; `data`: { alive, pid, uptime, timestamp }
   */
  healthLive: () => httpClient.get("health/live").then((r) => r.data),

  /**
   * Readiness probe — 200 when every dependency is up, 503 otherwise. No auth.
   * 503 is treated as a valid response (not thrown) so the dashboard can render
   * the per-dependency check breakdown carried in the body instead of erroring.
   *
   * @returns {Promise<object>} Response envelope; `data`: { ready, checks }
   */
  healthReady: () =>
    httpClient
      .get("health/ready", { validateStatus: (s) => s === 200 || s === 503 })
      .then((r) => r.data),

  /**
   * Server email notifications — status snapshot (enabled flag, masked
   * per-channel recipients, active alert states, recent sends). Requires
   * userLevel >= 2.
   *
   * @returns {Promise<object>} Notification status payload
   */
  notificationStatus: () =>
    httpClient.get("metrics/notifications/status").then((r) => r.data),

  /**
   * Sends a one-off test digest email on the given channel. SUPER_ADMIN only;
   * strictly rate-limited server-side (3/min).
   *
   * @param {string} channel - One of the four server notification channel keys
   * @returns {Promise<object>} `{ sent: boolean, notificationId?: string }` envelope
   */
  testSendNotification: (channel) =>
    httpClient
      .post("metrics/notifications/test", { channel })
      .then((r) => r.data),

  /**
   * Offset-paginated alert/notification history. Requires userLevel >= 2.
   *
   * @param {object} [params]
   * @param {string} [params.rule]
   * @param {string} [params.severity] - "WARNING" | "CRITICAL" | "RESOLVED"
   * @param {string} [params.from]     - ISO date
   * @param {string} [params.to]       - ISO date
   * @param {number} [params.page]
   * @param {number} [params.limit]
   * @returns {Promise<{ data: { rows: object[], total: number, page: number, limit: number } }>}
   */
  alertHistory: (params) =>
    httpClient.get("metrics/alerts/history", { params }).then((r) => r.data),

  /**
   * Acknowledges an active alert. Silences the routine cooldown re-notify
   * email while the ack is active; two server-side safety nets remain in force
   * regardless — the ack auto-clears (and the email still sends) the moment
   * severity escalates past what it was at ack time, and it lapses on its own
   * after `ALERT_ACK_TTL_HOURS` (default 24) even if nobody unacknowledges it.
   * Requires userLevel >= 2 (same tier as `alerts`).
   *
   * @param {string} alertKey - Identity key, e.g. "HIGH_LATENCY::POST /api/v1/auth/login"
   * @param {string} [note] - Optional free-text note
   * @returns {Promise<object>} `{ alertKey, acknowledged, ackedBy, ackedAt, ackExpiresAt, severityAtAck, note }` envelope
   */
  acknowledgeAlert: (alertKey, note) =>
    httpClient
      .post("metrics/alerts/ack", { alertKey, note })
      .then((r) => r.data),

  /**
   * Clears an alert's acknowledgement (explicit admin "never mind").
   * Requires userLevel >= 2.
   *
   * @param {string} alertKey
   * @returns {Promise<object>} `{ alertKey, acknowledged: false }` envelope
   */
  unacknowledgeAlert: (alertKey) =>
    httpClient
      .delete("metrics/alerts/ack", { data: { alertKey } })
      .then((r) => r.data),
};
