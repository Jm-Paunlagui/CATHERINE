/**
 * useLiveStream.js — Shared Server-Sent Events (SSE) connection lifecycle.
 *
 * A reusable EventSource lifecycle (open on deps, `cancelled` guard, `esRef`,
 * close on cleanup, `isLive` from `onopen`, clear on error) so any feature that
 * needs a live stream against a different URL does not re-implement — and drift
 * — the same effect. Mirrors the backend's `ScopedSsePoller` extraction on the
 * client side.
 *
 * Native `EventSource`, never Axios — SSE is not an XHR. `withCredentials: true`
 * makes the browser send the HTTP-only JWT cookie, which is how these routes
 * authenticate (CWE-287); there is no header to attach, so `HttpClient`'s CSRF
 * interceptor is irrelevant here (a GET is not a mutating request, CWE-352 only
 * applies to POST/PUT/PATCH/DELETE).
 *
 * Only the `update` event is wired — a consumer reacts to `update` by
 * invalidating its own cache key(s) and refetching; `heartbeat`/`connected`
 * carry no information a consumer needs beyond "the connection is alive", which
 * `isLive` (driven by `onopen`/`onerror`) already reports.
 *
 * `onUpdate` is held in a ref, refreshed every render, so a caller passing a
 * fresh inline arrow does not tear the connection down and reopen it — only
 * `url`/`enabled` are real effect dependencies.
 *
 * Does NOT retry-loop on error — `EventSource` reconnects automatically on its
 * own; adding a second, manual retry on top would hammer the endpoint twice
 * over. `isLive` simply reflects the current connection state (`onopen` → true,
 * `onerror` → false) each time the browser's own reconnect cycles through.
 *
 * @param {{ url: string|null, enabled?: boolean, onUpdate: Function }} opts
 * @returns {{ isLive: boolean }}
 *
 * @example
 *   const { isLive } = useLiveStream({
 *     url: id != null ? buildStreamUrl({ id }) : null,
 *     enabled: id != null,
 *     onUpdate: () => { invalidateCache(cacheKey); refetch(); },
 *   });
 */

import { useEffect, useRef, useState } from "react";

export function useLiveStream({ url, enabled = true, onUpdate }) {
    const [isLive, setIsLive] = useState(false);
    const esRef = useRef(null);
    const onUpdateRef = useRef(onUpdate);

    // Keep the ref current every render WITHOUT making onUpdate an effect
    // dependency — see file header.
    useEffect(() => {
        onUpdateRef.current = onUpdate;
    });

    useEffect(() => {
        let cancelled = false;

        // `typeof EventSource === "undefined"` is a defensive no-op in any real
        // browser (SSE has been supported everywhere evergreen for years) — it
        // exists so an environment that genuinely lacks the API degrades to
        // "not live" instead of throwing, matching this hook's own "no manual
        // retry-loop" posture (graceful degradation over a hard failure).
        //
        // No explicit `esRef.current?.close()`/`setIsLive(false)` needed here:
        // React always runs the PREVIOUS effect's cleanup (below) before this
        // body executes on a dependency change, and that cleanup already closes
        // the prior connection and resets `isLive`; on first mount there is
        // nothing to close and `isLive` already starts `false`.
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

        es.onopen = () => {
            if (!cancelled) setIsLive(true);
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
    }, [url, enabled]);

    return { isLive };
}

export default useLiveStream;
