/**
 * useLiveStream.js — Shared Server-Sent Events (SSE) connection lifecycle.
 *
 * One effect (open on deps, `cancelled` guard, `esRef`, close on cleanup,
 * `isLive` from `onopen`, clear on error) shared by every live view, each
 * against a different URL — the same drift-avoidance as the backend's
 * `ScopedSsePoller` extraction.
 *
 * Native `EventSource`, never Axios — SSE is not an XHR. `withCredentials:
 * true` makes the browser send the HTTP-only JWT cookie, which is how
 * these routes authenticate (CWE-287); there is no header to attach, so
 * `HttpClient`'s CSRF interceptor is irrelevant here (a GET is not a
 * mutating request, CWE-352 only applies to POST/PUT/PATCH/DELETE).
 *
 * Only the `update` event is wired — a consumer reacts to `update` by
 * invalidating its
 * own cache key(s) and refetching; `heartbeat`/`connected` carry no
 * information any consumer currently needs beyond "the connection is
 * alive", which `isLive` (driven by `onopen`/`onerror`) already reports.
 *
 * `onUpdate` is held in a ref, refreshed every render, so a caller passing
 * a fresh inline arrow does not tear the connection down and reopen it —
 * only `url`/`enabled` are real effect dependencies.
 *
 * Server-status wiring: a named `shutdown` event (the API is draining) reports
 * SHUTDOWN and `open` reports OK to utils/serverStatus; `onerror` reports
 * nothing. When the server recovers and this stream's socket is CLOSED (the
 * browser stopped retrying), `reconnectKey` is bumped so the effect reopens it.
 *
 * Does NOT retry-loop on error — `EventSource` reconnects automatically on
 * its own; adding a second, manual retry on top would hammer the endpoint
 * twice over. `isLive` simply reflects the current connection state
 * (`onopen` → true, `onerror` → false) each time the browser's own
 * reconnect cycles through.
 *
 * @param {{ url: string|null, enabled?: boolean, onUpdate: Function }} opts
 * @returns {{ isLive: boolean }}
 *
 * @example
 *   const { isLive } = useLiveStream({
 *     url: cutoffId != null ? salesApi.buildTapStreamUrl({ cutoffId, half }) : null,
 *     enabled: cutoffId != null,
 *     onUpdate: () => { invalidateCache(cacheKey); refetch(); },
 *   });
 */

import { useEffect, useRef, useState } from "react";
import { SERVER_STATUS_KIND, onServerRecovered, reportServerStatus } from "../utils/serverStatus";

/** `EventSource.readyState` value once the browser has given up reconnecting. */
const ES_CLOSED = 2;

export function useLiveStream({ url, enabled = true, onUpdate }) {
    const [isLive, setIsLive] = useState(false);
    const [reconnectKey, setReconnectKey] = useState(0);
    const esRef = useRef(null);
    const onUpdateRef = useRef(onUpdate);

    // Keep the ref current every render WITHOUT making onUpdate an effect
    // dependency — see file header.
    useEffect(() => {
        onUpdateRef.current = onUpdate;
    });

    // Reopen a socket the browser gave up on once the server is back.
    useEffect(
        () =>
            onServerRecovered(() => {
                if (esRef.current?.readyState === ES_CLOSED) setReconnectKey((k) => k + 1);
            }),
        [],
    );

    useEffect(() => {
        let cancelled = false;

        // `typeof EventSource === "undefined"` is a defensive no-op in any
        // real browser (SSE has been supported everywhere evergreen since
        // long before this app shipped) — it exists so an environment that
        // genuinely lacks the API degrades to "not live" instead of
        // throwing, matching this hook's own "no manual retry-loop" posture
        // (Chaos & Resilience: graceful degradation over a hard failure).
        //
        // No explicit `esRef.current?.close()`/`setIsLive(false)` needed
        // here: React always runs the PREVIOUS effect's cleanup (below)
        // before this body executes on a dependency change, and that
        // cleanup already closes the prior connection and resets `isLive`;
        // on first mount there is nothing to close and `isLive` already
        // starts `false`. Avoids a synchronous setState-in-effect-body,
        // which is redundant here and not the pattern React's own
        // `set-state-in-effect` lint rule flags.
        if (!enabled || !url || typeof EventSource === "undefined") {
            return undefined;
        }

        const es = new EventSource(url, { withCredentials: true });

        es.addEventListener("update", (e) => {
            if (cancelled) return;
            let data;
            try {
                data = JSON.parse(e.data);
            } catch {
                // Malformed SSE payload — ignore silently, still notify.
                data = undefined;
            }
            onUpdateRef.current?.(data);
        });

        es.addEventListener("shutdown", () => {
            if (!cancelled) reportServerStatus(SERVER_STATUS_KIND.SHUTDOWN);
        });

        es.onopen = () => {
            if (cancelled) return;
            setIsLive(true);
            reportServerStatus(SERVER_STATUS_KIND.OK, { sentAt: Date.now() });
        };
        es.onerror = () => {
            if (!cancelled) setIsLive(false);
        };

        esRef.current = es;

        return () => {
            cancelled = true;
            es.close();
            if (esRef.current === es) esRef.current = null;
            setIsLive(false);
        };
    }, [url, enabled, reconnectKey]);

    return { isLive };
}
