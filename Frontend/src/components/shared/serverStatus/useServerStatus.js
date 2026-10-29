/**
 * useServerStatus.js — Reads the server-status store and owns the ONE readiness
 * probe loop.
 *
 * WHAT THIS FILE DOES
 *   - Subscribes to utils/serverStatus via `useSyncExternalStore`.
 *   - While the phase is restarting/unavailable AND the tab is visible, probes
 *     `health/ready`: first probe after 0-2 s jitter, then `probeBackoffMs`
 *     (full-jitter exponential, capped 15 s, Retry-After as a floor).
 *   - Aborts on hidden / unmount / recovery; restarts on `visibilitychange ->
 *     visible` and window `online`.
 *   A module-level guard guarantees a single loop however many components mount
 *   the hook (the banner AND the 523 page both do).
 *
 *   Episode semantics:
 *   - STRICT outage: while the store holds an OUTAGE episode (the 523 page declared the origin
 *     down) only a probe HTTP 200 (`healthy`) recovers; a 503 error envelope (DB pool down) maps to
 *     OUTAGE again instead of OK, so the page never claims "available" during a DB outage.
 *   - CAUSE: each probe is classified (`serverStatusApi` `cause`). A database-cause probe (API up, a gating DB
 *     pool down) reports OUTAGE{cause:"database"} in strict AND non-strict episodes: it is never "recovered"
 *     and the banner shows the database copy instead of "Back online."; only HTTP 200 recovers. A later probe
 *     can switch the cause back to "server". Status values the 523 page derives: checking | unavailable |
 *     database | restarting | danger | offline | available.
 *   - The loop is re-claimed by a remaining consumer when its owner unmounts mid-episode.
 *   - Probe meta (`getProbeMeta` / `subscribeProbeMeta`): attempt, lastProbeAt, nextProbeAt, firstAt,
 *     recoveredAt — numbers only, a SEPARATE subscription so the banner does not re-render per tick.
 *   - `checkNow()`: restart the loop right now (no jitter); the caller enforces its own cooldown. No JSX here; copy lives in constants and is NEVER taken from the
 *   server (CWE-79 / CWE-209).
 *
 * Big-O: O(1) per probe; one in-flight request at a time.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { probeBackoffMs } from "../../../utils/retryAfter";
import { SERVER_STATUS_KIND, getServerEpisode, getServerStatusSnapshot, reportServerStatus, subscribeServerStatus } from "../../../utils/serverStatus";
import { serverStatusApi } from "./serverStatus.api";

/** How long the banner stays mounted while it collapses (= --duration-moderate, 350 ms). */
export const SERVER_BANNER_EXIT_MS = 350;

/** Fixed user-facing copy. */
export const SERVER_STATUS_MESSAGES = Object.freeze({
    restarting: "The server is restarting. We'll reconnect automatically. Please wait before saving.",
    unavailable: "Can't reach the server. Retrying…",
    outage: "The service is unavailable. Retrying automatically…",
    databaseUnavailable: "The database isn't responding. We'll reconnect automatically. Please wait before saving.",
    databaseDanger: "Still can't reach the database. Retrying… If this continues, contact your system administrator.",
    danger: "Still can't reach the server. Retrying… If this continues, contact your system administrator.",
    recovered: "Back online.",
});

const FIRST_PROBE_JITTER_MS = 2000;

/** @type {AbortController|null} Module guard: the single live probe loop. */
let loopOwner = null;
/** Mounted hook instances. When the loop owner unmounts, a remaining one must take the loop over. */
let consumers = 0;
/** `checkNow()` asks the next loop start to skip the first-probe jitter. */
let immediateNext = false;
let loopNonce = 0;
const nonceListeners = new Set();
const subscribeNonce = (fn) => {
    nonceListeners.add(fn);
    return () => nonceListeners.delete(fn);
};
const getNonce = () => loopNonce;

/**
 * @typedef {object} ProbeMeta
 * @property {number} attempt      Settled probes in this episode.
 * @property {number} lastProbeAt  `Date.now()` when the last probe settled (0 = none yet).
 * @property {number} nextProbeAt  `Date.now()` the next probe is due (0 = none scheduled).
 * @property {number} firstAt      Episode start (0 = no episode).
 * @property {number} recoveredAt  Episode end (0 = not recovered).
 */
const metaListeners = new Set();
let metaEpisodeId = 0;
/** @type {Readonly<ProbeMeta>} */
let probeMeta = Object.freeze({ attempt: 0, lastProbeAt: 0, nextProbeAt: 0, firstAt: 0, recoveredAt: 0 });

function freshMeta() {
    const ep = getServerEpisode();
    metaEpisodeId = ep.id;
    return Object.freeze({ attempt: 0, lastProbeAt: 0, nextProbeAt: 0, firstAt: ep.firstAt, recoveredAt: ep.recoveredAt });
}

function publishMeta(patch) {
    const ep = getServerEpisode();
    const base = metaEpisodeId === ep.id ? probeMeta : freshMeta();
    probeMeta = Object.freeze({ ...base, ...patch, firstAt: ep.firstAt || base.firstAt, recoveredAt: ep.recoveredAt });
    metaListeners.forEach((fn) => fn());
}

/**
 * Probe cadence of the current episode (numbers only). Stable identity until something changes.
 * @returns {Readonly<ProbeMeta>}
 */
export function getProbeMeta() {
    if (metaEpisodeId !== getServerEpisode().id) probeMeta = freshMeta(); // a new episode starts from zero
    return probeMeta;
}

/**
 * `useSyncExternalStore`-compatible subscribe for `getProbeMeta`.
 * @param {() => void} fn
 * @returns {() => void} Unsubscribe.
 */
export function subscribeProbeMeta(fn) {
    metaListeners.add(fn);
    return () => metaListeners.delete(fn);
}

/**
 * Probes again right now: aborts the current wait and restarts the loop without the first-probe
 * jitter. Callers own the cooldown (the 523 page enforces 5 s). No-op while nothing is down.
 * @returns {void}
 */
export function checkNow() {
    if (!isActivePhase()) return;
    immediateNext = true;
    loopNonce += 1;
    nonceListeners.forEach((fn) => fn());
}

const isActivePhase = () => {
    const p = getServerStatusSnapshot().phase;
    return p === "restarting" || p === "unavailable";
};

function messageFor({ phase, severity, outage, cause }) {
    if (phase === "restarting") return severity === "danger" ? SERVER_STATUS_MESSAGES.danger : SERVER_STATUS_MESSAGES.restarting;
    if (phase === "unavailable" && cause === "database") return severity === "danger" ? SERVER_STATUS_MESSAGES.databaseDanger : SERVER_STATUS_MESSAGES.databaseUnavailable;
    if (phase === "unavailable") {
        if (severity === "danger") return SERVER_STATUS_MESSAGES.danger;
        return outage ? SERVER_STATUS_MESSAGES.outage : SERVER_STATUS_MESSAGES.unavailable;
    }
    if (phase === "recovered") return SERVER_STATUS_MESSAGES.recovered;
    return null;
}

/** Abortable sleep; resolves early (without throwing) on abort. */
function wait(ms, signal) {
    return new Promise((resolve) => {
        if (signal.aborted) return resolve();
        const t = setTimeout(done, ms);
        function done() {
            signal.removeEventListener("abort", done);
            clearTimeout(t);
            resolve();
        }
        signal.addEventListener("abort", done, { once: true });
    });
}

async function runLoop(signal, immediate) {
    if (!immediate) await wait(Math.random() * FIRST_PROBE_JITTER_MS, signal);
    let attempt = 0;
    while (!signal.aborted && isActivePhase()) {
        const sentAt = Date.now();
        // A probe is going out now. After "Check again" the previous round's due time is still in the
        // future; stamping it as due lets the 523 card say "Checking now…" instead of counting down.
        if (getProbeMeta().nextProbeAt > sentAt) publishMeta({ nextProbeAt: sentAt });
        let result;
        try {
            result = await serverStatusApi.probeReady(signal);
        } catch {
            if (signal.aborted) return;
            result = { ready: false, healthy: false, draining: false, reachable: false, retryAfterMs: 0 };
        }
        if (signal.aborted) return;
        const gap = probeBackoffMs(attempt, result.retryAfterMs);
        const settledAt = Date.now();
        publishMeta({ attempt: getProbeMeta().attempt + 1, lastProbeAt: settledAt, nextProbeAt: settledAt + gap });
        if (result.draining) reportServerStatus(SERVER_STATUS_KIND.SHUTDOWN);
        else if (result.healthy) reportServerStatus(SERVER_STATUS_KIND.OK, { sentAt, healthy: true });
        // The API answers but a gating DB pool is down: the DATABASE is the outage. Never "recovered",
        // in strict AND non-strict episodes (this makes the episode strict); a later probe may switch back.
        else if (result.cause === "database") reportServerStatus(SERVER_STATUS_KIND.OUTAGE, { cause: "database" });
        // Reachable with some other envelope: legacy "ready" for a plain episode; still down in an outage.
        else if (result.ready) reportServerStatus(getServerStatusSnapshot().outage ? SERVER_STATUS_KIND.OUTAGE : SERVER_STATUS_KIND.OK, { sentAt, cause: "server" });
        // The API itself is not answering. In an outage that is a (possible) switch database -> server.
        else if (getServerStatusSnapshot().outage) reportServerStatus(SERVER_STATUS_KIND.OUTAGE, { cause: "server" });
        if (getServerEpisode().recoveredAt !== getProbeMeta().recoveredAt) publishMeta({}); // recovery stamped
        // A stale-ignored OK leaves the phase active -> keep probing.
        if (!isActivePhase()) return;
        await wait(gap, signal);
        attempt += 1;
    }
}

/**
 * @returns {{ phase: string, severity: "warning"|"danger"|"success"|null, visible: boolean, message: string|null, outage: boolean, cause: "server"|"database"|null }}
 */
export function useServerStatus() {
    const snap = useSyncExternalStore(subscribeServerStatus, getServerStatusSnapshot, getServerStatusSnapshot);
    const [tabVisible, setTabVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
    const [restartKey, setRestartKey] = useState(0);
    const nonce = useSyncExternalStore(subscribeNonce, getNonce, getNonce);
    // Declared BEFORE the loop effect so, on unmount, this cleanup runs first and the loop effect's cleanup
    // can tell a real unmount from a dependency change.
    const unmounting = useRef(false);
    useEffect(() => {
        consumers += 1;
        unmounting.current = false;
        return () => {
            consumers -= 1;
            unmounting.current = true;
        };
    }, []);

    useEffect(() => {
        const onVis = () => setTabVisible(document.visibilityState !== "hidden");
        const onOnline = () => setRestartKey((k) => k + 1);
        document.addEventListener("visibilitychange", onVis);
        window.addEventListener("online", onOnline);
        return () => {
            document.removeEventListener("visibilitychange", onVis);
            window.removeEventListener("online", onOnline);
        };
    }, []);

    const active = snap.phase === "restarting" || snap.phase === "unavailable";

    useEffect(() => {
        if (!active || !tabVisible || loopOwner) return undefined;
        const ac = new AbortController();
        loopOwner = ac;
        const immediate = immediateNext;
        immediateNext = false;
        runLoop(ac.signal, immediate).finally(() => {
            if (loopOwner === ac) loopOwner = null;
        });
        return () => {
            ac.abort();
            if (loopOwner === ac) loopOwner = null;
            // The owner is going away for good while the episode is still active and another consumer
            // remains: wake the others so one of them re-claims the loop (single loop invariant kept by
            // the `loopOwner` guard). A dependency-change cleanup never bumps (it would loop forever).
            if (unmounting.current && consumers > 0 && isActivePhase()) {
                loopNonce += 1;
                nonceListeners.forEach((fn) => fn());
            }
        };
    }, [active, tabVisible, restartKey, nonce]);

    return { phase: snap.phase, severity: snap.severity, visible: snap.visible, message: messageFor(snap), outage: snap.outage, cause: snap.cause };
}

export default useServerStatus;
