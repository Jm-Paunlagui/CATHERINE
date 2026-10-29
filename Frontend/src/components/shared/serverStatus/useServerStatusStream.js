/**
 * useServerStatusStream.js — The app-wide readiness push.
 *
 * WHY
 *   The banner used to learn about an outage only from real traffic, so an idle user (signed in or
 *   not) saw nothing until they clicked something. The API now pushes its readiness verdict over
 *   `GET health/stream` (SSE), and this hook keeps that stream open on every route.
 *
 * WHAT IT REPORTS (to utils/serverStatus)
 *   - `status` {ready:false, cause:"database"} -> OUTAGE{cause:"database"}: the banner shows at once.
 *   - `status` {ready:true}                    -> OK{healthy:true}: ends any episode ("Back online").
 *     The API sends ready:true only when EVERY pool answers and every circuit breaker is closed, so
 *     sign-in works by the time the banner says so.
 *   - `shutdown`                               -> SHUTDOWN ("restarting").
 *   - connection lost (browser retrying)       -> NETWORK_FAILURE: the banner shows after 3 s unless
 *                                                 the stream comes back first (no flicker).
 *   - no frame for HEARTBEAT_STALE_MS          -> NETWORK_FAILURE + reconnect (hung server/proxy).
 *   The banner's own probe loop (useServerStatus) still owns probing and recovery while an episode
 *   runs; a push simply gets there first.
 *
 * FALLBACK
 *   Returns `{ fallback: true }` when the stream cannot be used: no `EventSource` (old browser,
 *   jsdom), the constructor throws (CSP, bad URL), or the server refused it (non-200: draining, the per-IP cap, an API without the route).
 *   ServerStatusWatch then runs the readiness poll instead. A refused stream is retried after
 *   STREAM_RETRY_AFTER_REFUSAL_MS.
 *
 * SECURITY: CWE-209 — the payload is `{ready, cause}` only; nothing from it is shown verbatim. The
 * stream is unauthenticated and sent without credentials.
 *
 * Big-O: O(1) per frame.
 */

import { useEffect, useState } from "react";
import { API_BASE_URL_TRIMMED } from "../../../config/apiBase";
import { SERVER_STATUS_KIND, reportServerStatus } from "../../../utils/serverStatus";

/** The API heartbeats every 15 s; this long without any frame means the server is gone or hung. */
export const HEARTBEAT_STALE_MS = 40000;
/** After the server refuses the stream, poll instead and try the stream again after this long. */
export const STREAM_RETRY_AFTER_REFUSAL_MS = 60000;
/** How often staleness is checked. */
const STALE_CHECK_MS = 5000;

/**
 * Applies one `status` frame.
 * @param {{ ready?: boolean, cause?: string|null }} data
 * @returns {void}
 */
export function applyStatusFrame(data) {
    if (data?.ready === true) reportServerStatus(SERVER_STATUS_KIND.OK, { sentAt: Date.now(), healthy: true });
    else if (data?.ready === false) reportServerStatus(SERVER_STATUS_KIND.OUTAGE, { cause: "database" });
}

function parse(e) {
    try {
        return JSON.parse(e.data);
    } catch {
        return null;
    }
}

/**
 * Keeps the readiness stream open while mounted. Mount ONCE (ServerStatusWatch in App).
 * @returns {{ fallback: boolean }}
 */
export function useServerStatusStream() {
    const supported = typeof EventSource !== "undefined";
    const [refused, setRefused] = useState(false);
    const [retryKey, setRetryKey] = useState(0);

    useEffect(() => {
        if (!supported || refused) return undefined;
        let es = null;
        let lastFrameAt = Date.now();
        let stopped = false;

        const open = () => {
            try {
                es = new EventSource(`${API_BASE_URL_TRIMMED}/health/stream`);
            } catch {
                // Blocked (CSP connect-src, bad base URL): treat as refused so the poll takes over.
                es = null;
                setRefused(true);
                return;
            }
            lastFrameAt = Date.now();
            es.onopen = () => {
                lastFrameAt = Date.now();
            };
            es.addEventListener("status", (e) => {
                lastFrameAt = Date.now();
                applyStatusFrame(parse(e));
            });
            es.addEventListener("heartbeat", () => {
                lastFrameAt = Date.now();
            });
            es.addEventListener("shutdown", () => {
                lastFrameAt = Date.now();
                reportServerStatus(SERVER_STATUS_KIND.SHUTDOWN);
            });
            es.onerror = () => {
                if (stopped) return;
                // CLOSED = the server answered but refused (non-200 / not an event stream): it is
                // reachable, so the poll decides what is wrong. CONNECTING = the connection dropped
                // and the browser is retrying: the server is (for now) unreachable.
                if (es.readyState === 2) {
                    es.close();
                    setRefused(true);
                    return;
                }
                reportServerStatus(SERVER_STATUS_KIND.NETWORK_FAILURE);
            };
        };

        const staleTimer = setInterval(() => {
            if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
            if (Date.now() - lastFrameAt < HEARTBEAT_STALE_MS) return;
            reportServerStatus(SERVER_STATUS_KIND.NETWORK_FAILURE);
            es?.close();
            open();
        }, STALE_CHECK_MS);

        // A frozen background tab misses heartbeats; on return, judge freshness again from now.
        const onVisible = () => {
            if (document.visibilityState !== "hidden" && Date.now() - lastFrameAt >= HEARTBEAT_STALE_MS) {
                es?.close();
                open();
            }
        };
        document.addEventListener("visibilitychange", onVisible);

        open();
        return () => {
            stopped = true;
            clearInterval(staleTimer);
            document.removeEventListener("visibilitychange", onVisible);
            es?.close();
        };
    }, [supported, refused, retryKey]);

    useEffect(() => {
        if (!refused) return undefined;
        const t = setTimeout(() => {
            setRefused(false);
            setRetryKey((k) => k + 1);
        }, STREAM_RETRY_AFTER_REFUSAL_MS);
        return () => clearTimeout(t);
    }, [refused]);

    return { fallback: !supported || refused };
}

export default useServerStatusStream;
