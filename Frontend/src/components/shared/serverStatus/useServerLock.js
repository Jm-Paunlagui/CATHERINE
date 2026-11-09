/**
 * useServerLock.js — Derives the app-wide "server lock" and the outage countdown from the
 * server-status store (utils/serverStatus). No JSX, no router, no probe loop.
 *
 * WHAT THIS FILE DOES
 *   `useServerLock()` returns `{ locked, shouldRedirect, redirectInMs, cause }`:
 *     - locked         a restarting/unavailable episode is VISIBLE (the banner is up). Same moment the
 *                      banner appears (after SERVER_SHOW_AFTER_MS), so a blip never locks the app.
 *     - shouldRedirect the store's OWN danger timer fired (severity "danger"). No second timer exists.
 *     - redirectInMs   ms until that timer fires, derived from `episode.firstAt + SERVER_DANGER_AFTER_MS`
 *                      (null when not locked; 0 floor). Recomputed from `firstAt` each tick: cannot drift.
 *     - cause          "server" | "database" | null (passed through).
 *
 *   A small module-level display clock feeds `redirectInMs`. It runs ONLY while a consumer is counting
 *   (locked and not yet danger), ticks at whole-second boundaries, resyncs on `visibilitychange`, and is
 *   ref-counted so StrictMode / several consumers share one timer. It is an external store so render
 *   stays pure (react-hooks `purity`) and no setState happens in an effect (`set-state-in-effect`).
 *
 * WCAG 2.2.1 (Timing Adjustable): the forced redirect to the outage page is an ESSENTIAL time limit:
 *   the server is unreachable, so nothing on the current page can work. The product owner records this.
 *
 * SECURITY: CWE-209/CWE-200 — enum + numbers only, never server text. Big-O: O(1) per tick/derivation.
 */

import { useState, useSyncExternalStore } from "react";
import { SERVER_DANGER_AFTER_MS, getServerEpisode, getServerStatusSnapshot, subscribeServerStatus } from "../../../utils/serverStatus";

// ── Display clock (external store) ─────────────────────────────────────────
let clockNow = 0;
const clockListeners = new Set();
let tickTimer = null;
let onVisibility = null;

const getClock = () => clockNow;
const subscribeNever = () => () => {};

function scheduleTick() {
    clearTimeout(tickTimer);
    tickTimer = null;
    const remaining = getServerEpisode().firstAt + SERVER_DANGER_AFTER_MS - clockNow;
    if (remaining <= 0) return; // display holds "Redirecting…" until the store flips to danger
    // Next whole-second boundary of the remaining time (+5 ms so ceil(remaining/1000) has moved on).
    tickTimer = setTimeout(tick, (remaining % 1000 || 1000) + 5);
}

function tick() {
    clockNow = Date.now();
    clockListeners.forEach((fn) => fn());
    scheduleTick();
}

function subscribeClock(fn) {
    clockListeners.add(fn);
    if (clockListeners.size === 1) {
        clockNow = Date.now();
        scheduleTick();
        onVisibility = () => {
            if (document.visibilityState === "visible") tick();
        };
        document.addEventListener("visibilitychange", onVisibility);
    }
    return () => {
        clockListeners.delete(fn);
        if (clockListeners.size === 0) {
            clearTimeout(tickTimer);
            tickTimer = null;
            if (onVisibility) document.removeEventListener("visibilitychange", onVisibility);
            onVisibility = null;
        }
    };
}

/** Store subscription that refreshes the clock first, so the render where the lock engages is current. */
function subscribeLockServer(fn) {
    return subscribeServerStatus(() => {
        clockNow = Date.now();
        fn();
    });
}

/**
 * Pure derivation (exported for tests).
 *
 * @param {ReturnType<typeof getServerStatusSnapshot>} snapshot Server-status snapshot.
 * @param {number} firstAt Episode start (`getServerEpisode().firstAt`).
 * @param {number} now Current time, ms.
 * @returns {{ locked: boolean, shouldRedirect: boolean, redirectInMs: number|null, cause: "server"|"database"|null }}
 */
export function deriveServerLock(snapshot, firstAt, now) {
    const locked = (snapshot.phase === "restarting" || snapshot.phase === "unavailable") && snapshot.visible;
    return {
        locked,
        shouldRedirect: snapshot.severity === "danger",
        redirectInMs: locked ? Math.max(0, firstAt + SERVER_DANGER_AFTER_MS - now) : null,
        cause: snapshot.cause,
    };
}

/**
 * Lock + countdown state for the whole app.
 *
 * @param {{ tick?: boolean }} [options] `tick: false` opts out of the per-second display clock for consumers that never
 *        render `redirectInMs` (the guard; the silent banner on the 523 page): they then re-render only on store changes,
 *        and `redirectInMs` is not kept fresh.
 * @returns {{ locked: boolean, shouldRedirect: boolean, redirectInMs: number|null, cause: "server"|"database"|null }}
 */
export function useServerLock({ tick = true } = {}) {
    const snap = useSyncExternalStore(subscribeLockServer, getServerStatusSnapshot, getServerStatusSnapshot);
    const [mountNow] = useState(() => Date.now()); // floor: a stale shared clock never shows more than 60 s
    const counting = tick && deriveServerLock(snap, 0, 0).locked && snap.severity !== "danger";
    const now = useSyncExternalStore(counting ? subscribeClock : subscribeNever, getClock, getClock);
    return deriveServerLock(snap, getServerEpisode().firstAt, Math.max(now, mountNow));
}

/** Test-only: stops the clock and drops its listeners. */
export function _resetServerLockForTests() {
    clearTimeout(tickTimer);
    tickTimer = null;
    if (onVisibility) document.removeEventListener("visibilitychange", onVisibility);
    onVisibility = null;
    clockListeners.clear();
    clockNow = 0;
}
