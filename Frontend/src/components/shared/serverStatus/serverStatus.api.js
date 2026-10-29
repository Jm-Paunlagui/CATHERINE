/**
 * serverStatus.api.js — Tier-3 HTTP layer for the server-reachability probe.
 *
 * WHAT THIS FILE DOES
 *   One call: `GET health/ready`, flagged `_serverStatusProbe` so HttpClient
 *   neither reports its outcome to utils/serverStatus, nor retries it, nor
 *   hard-navigates on it (otherwise the probe would feed the banner it drives).
 *   No state, no React.
 *
 * SECURITY: CWE-209 — only status/type/Retry-After are read; the body is never surfaced.
 */

import httpClient from "../../../middleware/HttpClient";
import { SERVER_SHUTTING_DOWN_TYPE } from "../../../constants/httpStatus";
import { parseRetryAfterSeconds } from "../../../utils/retryAfter";

/** Probe request budget. */
export const PROBE_TIMEOUT_MS = 5000;

/**
 * @typedef {object} ProbeResult
 * @property {boolean} ready       Server answers and is not draining (clear the banner).
 * @property {boolean} healthy     TRUE ONLY for HTTP 200. Distinct from `ready`: a 503 with an error
 *                                 envelope (e.g. a DB pool down) is "reachable" (`ready`) but NOT healthy.
 *                                 A strict outage episode (the 523 page) recovers on `healthy` alone.
 * @property {boolean} draining    503 ServerShuttingDown.
 * @property {boolean} reachable   Any HTTP answer from a real origin.
 * @property {number}  retryAfterMs Server-requested minimum wait (0 when absent).
 * @property {"server"|"database"|null} cause WHO is down. "database" = the API answers but a gating DB pool is
 *                                 down (503 `ServiceUnavailableError`, or `data.ready === false` while not draining);
 *                                 "server" = unreachable / no API envelope / any other failure; null = healthy or
 *                                 draining. A CLASSIFICATION ONLY: pool names and check details in the body are
 *                                 never copied out (CWE-209).
 */

export const serverStatusApi = {
    /**
     * Probes readiness. 200 -> ready; 503 ServerShuttingDown -> draining; 503 with
     * any other error envelope (e.g. DB outage, handled by the takeover page) ->
     * reachable and `ready` as far as the banner is concerned, but `healthy:false`; 503 without an
     * envelope or a network failure -> unreachable. An aborted probe rethrows.
     *
     * @param {AbortSignal} [signal]
     * @returns {Promise<ProbeResult>}
     */
    probeReady: async (signal) => {
        try {
            const res = await httpClient.get("health/ready", {
                signal,
                timeout: PROBE_TIMEOUT_MS,
                _serverStatusProbe: true,
                validateStatus: (s) => s === 200 || s === 503,
            });
            if (res.status === 200) return { ready: true, healthy: true, draining: false, reachable: true, retryAfterMs: 0, cause: null };

            const type = res.data?.error?.type;
            const hasEnvelope = res.data?.status === "error" && typeof type === "string";
            const secs = parseRetryAfterSeconds(res.headers?.["retry-after"]);
            const retryAfterMs = secs === null ? 0 : secs * 1000;
            if (type === SERVER_SHUTTING_DOWN_TYPE) return { ready: false, healthy: false, draining: true, reachable: true, retryAfterMs, cause: null };
            if (hasEnvelope) {
                const database = type === "ServiceUnavailableError" || res.data?.data?.ready === false;
                return { ready: true, healthy: false, draining: false, reachable: true, retryAfterMs, cause: database ? "database" : "server" };
            }
            return { ready: false, healthy: false, draining: false, reachable: false, retryAfterMs, cause: "server" };
        } catch (err) {
            if (signal?.aborted || err?.code === "ERR_CANCELED") throw err;
            return { ready: false, healthy: false, draining: false, reachable: false, retryAfterMs: 0, cause: "server" };
        }
    },
};

export default serverStatusApi;
