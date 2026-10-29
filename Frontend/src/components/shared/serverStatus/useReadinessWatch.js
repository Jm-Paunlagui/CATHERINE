/**
 * useReadinessWatch.js — Readiness poll. The fallback of the app-wide
 * ServerStatusWatch: it runs only when the readiness push stream cannot be used.
 *
 * WHY
 *   The banner is fed by real traffic: HttpClient reports what each request saw. A screen that
 *   sends nothing while it sits open (the sign-in page) never learns that the database or the
 *   server went down, so the banner stays hidden until the user presses Sign In. Signed-in screens
 *   do not need this: their own requests feed the banner.
 *
 * WHAT IT DOES
 *   While mounted, the tab is visible AND the store is idle (no episode running), probes
 *   `health/ready` once on mount and then every `READINESS_WATCH_MS`, and again when the tab
 *   becomes visible or the browser comes back online. A finding starts an episode; from then on
 *   the banner's own probe loop (useServerStatus) owns probing and recovery, and this watch pauses
 *   until the store is idle again.
 *     - database down (503 ServiceUnavailableError) -> OUTAGE{cause:"database"} (banner at once)
 *     - server draining (503 ServerShuttingDown)    -> SHUTDOWN
 *     - unreachable / no API envelope               -> NETWORK_FAILURE (banner after the usual 3 s)
 *     - healthy                                     -> nothing
 *   `health/*` is exempt from the API rate limiter and the shutdown gate, and the probe is flagged
 *   `_serverStatusProbe` so HttpClient never reports, retries or navigates on it.
 *
 * Big-O: O(1) per tick; at most one probe in flight.
 */

import { useEffect } from "react";
import { SERVER_STATUS_KIND, getServerStatusSnapshot, reportServerStatus } from "../../../utils/serverStatus";
import { serverStatusApi } from "./serverStatus.api";

/** Gap between idle readiness checks. */
export const READINESS_WATCH_MS = 10000;

/**
 * Maps one probe result to a store report (or none).
 * @param {import("./serverStatus.api").ProbeResult} result
 * @returns {void}
 */
export function reportReadiness(result) {
    if (getServerStatusSnapshot().phase !== "idle") return; // an episode started meanwhile; the banner loop owns it
    if (result.draining) reportServerStatus(SERVER_STATUS_KIND.SHUTDOWN);
    else if (result.healthy) return;
    else if (result.cause === "database") reportServerStatus(SERVER_STATUS_KIND.OUTAGE, { cause: "database" });
    else if (!result.reachable) reportServerStatus(SERVER_STATUS_KIND.NETWORK_FAILURE);
}

/**
 * Polls readiness while mounted and `enabled`. Since the readiness push stream (useServerStatusStream)
 * this is the FALLBACK: ServerStatusWatch enables it only when the browser has no EventSource or the
 * server refused the stream.
 * @param {{ enabled?: boolean }} [options]
 * @returns {void}
 */
export function useReadinessWatch({ enabled = true } = {}) {
    useEffect(() => {
        if (!enabled) return undefined;
        let timer = null;
        let ac = null;
        let stopped = false;

        const schedule = (ms) => {
            clearTimeout(timer);
            timer = setTimeout(tick, ms);
        };

        async function tick() {
            timer = null;
            if (stopped) return;
            const idle = getServerStatusSnapshot().phase === "idle";
            if (idle && document.visibilityState !== "hidden" && !ac) {
                ac = new AbortController();
                try {
                    reportReadiness(await serverStatusApi.probeReady(ac.signal));
                } catch {
                    // aborted (unmount / re-check): nothing to report
                } finally {
                    ac = null;
                }
            }
            if (!stopped) schedule(READINESS_WATCH_MS);
        }

        const checkNow = () => {
            if (document.visibilityState === "hidden") return;
            schedule(0);
        };

        document.addEventListener("visibilitychange", checkNow);
        window.addEventListener("online", checkNow);
        schedule(0);

        return () => {
            stopped = true;
            clearTimeout(timer);
            ac?.abort();
            document.removeEventListener("visibilitychange", checkNow);
            window.removeEventListener("online", checkNow);
        };
    }, [enabled]);
}

export default useReadinessWatch;
