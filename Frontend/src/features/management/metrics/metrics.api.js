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
};
