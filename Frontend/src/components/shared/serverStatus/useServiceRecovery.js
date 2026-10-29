/**
 * useServiceRecovery.js — State machine behind the 523 "Service Unavailable" page.
 *
 * WHAT THIS FILE DOES
 *   A takeover hard-navigates (new document, idle store) and the page itself sends almost no
 *   traffic, so the app-wide banner never knew the origin was down. Mounting the 523 page IS the
 *   signal: this hook reports OUTAGE once (idempotent, StrictMode-safe), joins the ONE probe loop
 *   through `useServerStatus`, and turns the store + probe meta + browser connectivity into one
 *   page status:
 *
 *     checking      no probe has settled since this mount
 *     unavailable   probing, the server is not answering 200
 *     database      the server answers but its database does not (cause "database")
 *     restarting    a probe saw the 503 ServerShuttingDown drain
 *     danger        60 s+ of outage (store severity)
 *     offline       navigator.onLine === false (overrides every down state)
 *     available     LATCHED on the first healthy 200 until the user acts — the banner clearing 3 s
 *                   later, or a later network blip, never flips the page back (no auto-redirect).
 *
 *   Order matters: the recovery subscription is registered BEFORE the OUTAGE seed, so a 200 that
 *   lands immediately after mount cannot be missed.
 *
 * SECURITY: CWE-601 — `returnTo` only ever navigates after `sanitizeReturnTo`; navigation goes
 *   through the `serviceRecoveryNavigation` test seam. CWE-209/CWE-79 — no server text is read here;
 *   only enums and timestamps. No JSX in this file.
 * Complexity: O(1) per render; one in-flight probe (see useServerStatus).
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { SERVER_STATUS_KIND, getServerEpisode, onServerRecovered, reportServerStatus } from "../../../utils/serverStatus";
import { sanitizeReturnTo } from "../../../utils/returnTo";
import { checkNow as restartProbeLoop, getProbeMeta, subscribeProbeMeta, useServerStatus } from "./useServerStatus";

/** Minimum gap between two manual "Check again" presses. */
export const CHECK_COOLDOWN_MS = 5000;

/**
 * Navigation seam for "Continue". A hard navigation on purpose (drops every in-memory store after an
 * outage). Exists as an object so tests can spy on it: jsdom's `location` is [Unforgeable]. Never
 * repoint it from production code.
 */
export const serviceRecoveryNavigation = {
    /** @param {string} url Already-validated root-relative path. */
    go(url) {
        window.location.replace(url);
    },
};

const isOnline = () => typeof navigator === "undefined" || navigator.onLine !== false;

/**
 * @param {{ returnTo?: unknown }} [options] `returnTo` = the stashed hint (validated here, never trusted).
 * @returns {{
 *   status: "checking"|"unavailable"|"database"|"restarting"|"danger"|"offline"|"available",
 *   cause: "server"|"database"|null,
 *   meta: { attempt:number, lastProbeAt:number, nextProbeAt:number, firstAt:number, recoveredAt:number },
 *   checkNow: () => void,
 *   checkCooldown: boolean,
 *   continueToApp: () => void,
 *   returnTo: string|null,
 * }}
 *
 * @example
 * const { status, meta, checkNow, continueToApp } = useServiceRecovery({ returnTo: stored?.returnTo });
 */
export function useServiceRecovery({ returnTo } = {}) {
    const server = useServerStatus(); // also keeps the single probe loop alive
    const probeMeta = useSyncExternalStore(subscribeProbeMeta, getProbeMeta, getProbeMeta);
    const [mountedAt] = useState(() => Date.now());
    const [latched, setLatched] = useState(null);
    const [online, setOnline] = useState(isOnline);
    const [checkCooldown, setCheckCooldown] = useState(false);
    const cooldownTimer = useRef(null);

    // 1) Recovery subscription FIRST …
    useEffect(
        () =>
            onServerRecovered(() => {
                const ep = getServerEpisode();
                setLatched({ firstAt: ep.firstAt, recoveredAt: ep.recoveredAt });
            }),
        [],
    );
    // 2) … then the OUTAGE seed (idempotent: StrictMode's replay is a no-op).
    useEffect(() => {
        reportServerStatus(SERVER_STATUS_KIND.OUTAGE);
    }, []);

    useEffect(() => {
        const sync = () => setOnline(isOnline());
        window.addEventListener("online", sync);
        window.addEventListener("offline", sync);
        return () => {
            window.removeEventListener("online", sync);
            window.removeEventListener("offline", sync);
        };
    }, []);

    useEffect(() => () => clearTimeout(cooldownTimer.current), []);

    const validReturnTo = useMemo(() => sanitizeReturnTo(returnTo), [returnTo]);

    const checkNow = useCallback(() => {
        if (cooldownTimer.current || !isOnline()) return;
        setCheckCooldown(true);
        cooldownTimer.current = setTimeout(() => {
            cooldownTimer.current = null;
            setCheckCooldown(false);
        }, CHECK_COOLDOWN_MS);
        restartProbeLoop();
    }, []);

    const continueToApp = useCallback(() => {
        serviceRecoveryNavigation.go(validReturnTo ?? "/");
    }, [validReturnTo]);

    const settled = probeMeta.attempt > 0 && probeMeta.lastProbeAt >= mountedAt;
    let status;
    if (latched) status = "available";
    else if (!online) status = "offline";
    else if (server.severity === "danger") status = "danger";
    else if (server.phase === "restarting") status = "restarting";
    else if (server.cause === "database") status = "database";
    else if (!settled) status = "checking";
    else status = "unavailable";

    const meta = latched ? { ...probeMeta, firstAt: latched.firstAt, recoveredAt: latched.recoveredAt } : probeMeta;

    return { status, cause: latched ? null : server.cause, meta, checkNow, checkCooldown, continueToApp, returnTo: validReturnTo };
}

export default useServiceRecovery;
