/**
 * serverStatus.js — Module-level pub/sub that turns transport signals into one
 * "is the API reachable?" state machine. No React, no DOM, no window events.
 *
 * WHAT THIS FILE DOES
 *   HttpClient (and the SSE owners) call `reportServerStatus()` with what they
 *   observed; `ServerStatusBanner` reads the resulting frozen snapshot through
 *   `useSyncExternalStore`. Pure module state keeps the reporters free of any
 *   React import and makes the whole machine testable with fake timers.
 *
 * STATE MACHINE (kinds: SHUTDOWN, NETWORK_FAILURE, OK, OUTAGE)
 *   idle        + NETWORK_FAILURE -> pending      (3 s show timer starts)
 *   idle/pending/unavailable/recovered + SHUTDOWN -> restarting
 *   pending     + NETWORK_FAILURE -> no-op
 *   pending     + OK              -> idle         (no flicker, nothing shown)
 *   pending     + show timer      -> unavailable
 *   restarting/unavailable + NETWORK_FAILURE -> no-op (restarting copy kept)
 *   restarting/unavailable + danger timer    -> severity "danger" (60 s after first failure)
 *   restarting/unavailable + OK (fresh)      -> recovered (3 s) + recovery callbacks
 *   recovered   + NETWORK_FAILURE -> pending
 *   recovered   + recovery timer  -> idle
 *   idle        + OK              -> no-op, nobody notified
 *   idle/pending/recovered + OUTAGE -> unavailable AT ONCE (no 3 s wait), strict episode
 *   unavailable + OUTAGE          -> strict (no other change); restarting + OUTAGE -> unavailable, firstAt kept
 *
 * CAUSE: `snapshot.cause` says WHO is down while unavailable: "server" (network failure,
 *   unreachable probe, OUTAGE default) or "database" (the probe reached the API but a gating DB pool is down,
 *   `reportServerStatus(OUTAGE, { cause: "database" })`). A later report may switch it (notifies); restarting,
 *   recovery, goIdle and reset clear it to null. Enum only, never a pool name or detail (CWE-209).
 *
 * OUTAGE + STRICT
 *   The 523 "Service Unavailable" page reports OUTAGE once when it mounts: a takeover
 *   hard-navigates (new document, idle store), so mounting the page IS the signal that the
 *   origin is down. While an OUTAGE episode is active the store is STRICT: only an OK carrying
 *   `healthy: true` (the readiness probe's HTTP 200) recovers it. A 503 error envelope (DB pool
 *   down) maps to `ready` for the banner, so an OK without `healthy` is ignored. Strict clears on
 *   recovery / goIdle / reset. HttpClient emits OUTAGE only for an infrastructure 5xx on a
 *   self-handled endpoint (sign-in), where no takeover happens and the 523 page never mounts;
 *   non-strict behaviour is unchanged.
 *
 * STALE OK
 *   A 200 that was SENT before the last SHUTDOWN was observed left the server
 *   before it began draining; it proves nothing about recovery. Reporters pass
 *   `{ sentAt }` and an OK older than `lastShutdownAt` is ignored.
 *
 * SECURITY: CWE-209/CWE-200 — carries only an enum kind and timestamps; never
 * a server message, URL or request id. Complexity: O(subscribers) per change.
 */

/** @enum {string} */
export const SERVER_STATUS_KIND = Object.freeze({
    SHUTDOWN: "shutdown",
    NETWORK_FAILURE: "network-failure",
    OK: "ok",
    /** Reported only by the 523 page on mount (see header). */
    OUTAGE: "outage",
});

/** Failure must persist this long before the banner appears. */
export const SERVER_SHOW_AFTER_MS = 3000;
/** Time since the first failure after which severity escalates to danger. */
export const SERVER_DANGER_AFTER_MS = 60000;
/** How long "Back online." stays visible. */
export const SERVER_RECOVERED_MS = 3000;

const IDLE = Object.freeze({ phase: "idle", severity: null, visible: false, outage: false, cause: null });
const NO_EPISODE = Object.freeze({ id: 0, firstAt: 0, recoveredAt: 0 });

/** @type {{phase:string, severity:string|null, visible:boolean, outage:boolean}} */
let snapshot = IDLE;
let phase = "idle";
let danger = false;
let firstAt = 0;
let lastShutdownAt = 0;
let strict = false;
/** @type {"server"|"database"|null} WHO is down while restarting/unavailable (null while restarting). */
let cause = null;
/** Monotonic across resets so consumers can tell one episode from the next. */
let episodeSeq = 0;
/** @type {Readonly<{id:number, firstAt:number, recoveredAt:number}>} Last (or current) episode's times. */
let episode = NO_EPISODE;

let showTimer = null;
let dangerTimer = null;
let recoveredTimer = null;

const listeners = new Set();
const recoveredListeners = new Set();

function clearTimers() {
    clearTimeout(showTimer);
    clearTimeout(dangerTimer);
    clearTimeout(recoveredTimer);
    showTimer = dangerTimer = recoveredTimer = null;
}

function computeSeverity() {
    if (phase === "restarting" || phase === "unavailable") return danger ? "danger" : "warning";
    if (phase === "recovered") return "success";
    return null;
}

/** Rebuilds the snapshot; replaces it (and notifies) only when something changed. */
function commit() {
    const severity = computeSeverity();
    const visible = phase === "restarting" || phase === "unavailable" || phase === "recovered";
    const outage = strict && (phase === "restarting" || phase === "unavailable");
    const shownCause = phase === "unavailable" ? cause : null;
    if (snapshot.phase === phase && snapshot.severity === severity && snapshot.visible === visible && snapshot.outage === outage && snapshot.cause === shownCause) return;
    snapshot = Object.freeze({ phase, severity, visible, outage, cause: shownCause });
    listeners.forEach((fn) => fn());
}

function armDangerTimer() {
    clearTimeout(dangerTimer);
    const remaining = Math.max(0, firstAt + SERVER_DANGER_AFTER_MS - Date.now());
    dangerTimer = setTimeout(() => {
        dangerTimer = null;
        if (phase !== "restarting" && phase !== "unavailable") return;
        danger = true;
        commit();
    }, remaining);
}

/** Starts a new episode record (firstAt is already set by the caller). */
function beginEpisode() {
    episodeSeq += 1;
    episode = Object.freeze({ id: episodeSeq, firstAt, recoveredAt: 0 });
}

function goIdle() {
    clearTimers();
    phase = "idle";
    danger = false;
    strict = false;
    cause = null;
    firstAt = 0;
    lastShutdownAt = 0;
    commit();
}

function onShutdown() {
    lastShutdownAt = Date.now();
    if (phase === "restarting") return;
    clearTimeout(showTimer);
    showTimer = null;
    clearTimeout(recoveredTimer);
    recoveredTimer = null;
    if (phase === "idle" || phase === "recovered") {
        firstAt = lastShutdownAt;
        danger = false;
        beginEpisode();
    }
    // pending keeps its firstAt; unavailable keeps firstAt + danger.
    phase = "restarting";
    cause = null; // the drain explains itself (phase restarting)
    armDangerTimer();
    commit();
}

function onNetworkFailure() {
    if (phase !== "idle" && phase !== "recovered") return;
    clearTimeout(recoveredTimer);
    recoveredTimer = null;
    phase = "pending";
    firstAt = Date.now();
    danger = false;
    cause = "server";
    beginEpisode();
    showTimer = setTimeout(() => {
        showTimer = null;
        if (phase !== "pending") return;
        phase = "unavailable";
        armDangerTimer();
        commit();
    }, SERVER_SHOW_AFTER_MS);
    commit();
}

/**
 * @param {"server"|"database"} [wanted] Who is down. Omitted (the 523 page's seed): keep an already-known
 *        cause, else "server".
 */
function onOutage(wanted) {
    if (phase === "unavailable" || phase === "restarting") {
        // Same episode: keep firstAt / danger / lastShutdownAt, just make it strict.
        const wasRestarting = phase === "restarting";
        cause = wanted ?? (wasRestarting ? "server" : (cause ?? "server"));
        strict = true;
        if (wasRestarting) {
            phase = "unavailable";
            armDangerTimer();
        }
        commit();
        return;
    }
    // idle | pending | recovered -> a fresh, strict, immediately visible outage
    clearTimeout(showTimer);
    showTimer = null;
    clearTimeout(recoveredTimer);
    recoveredTimer = null;
    phase = "unavailable";
    firstAt = Date.now();
    danger = false;
    strict = true;
    cause = wanted ?? "server";
    beginEpisode();
    armDangerTimer();
    commit();
}

/**
 * @param {number} [sentAt]   `Date.now()` when the request was sent.
 * @param {boolean} [healthy] The probe got HTTP 200. Required to leave a strict (outage) episode.
 */
function onOk(sentAt, healthy) {
    if (phase === "idle" || phase === "recovered") return;
    if (typeof sentAt === "number" && sentAt < lastShutdownAt) return; // sent before the drain began
    if (strict && healthy !== true) return; // an outage recovers only on a real 200
    if (phase === "pending") return goIdle();
    // restarting | unavailable -> recovered
    clearTimers();
    episode = Object.freeze({ id: episode.id, firstAt: firstAt || episode.firstAt, recoveredAt: Date.now() });
    phase = "recovered";
    danger = false;
    strict = false;
    cause = null;
    firstAt = 0;
    lastShutdownAt = 0;
    recoveredTimer = setTimeout(() => {
        recoveredTimer = null;
        if (phase === "recovered") goIdle();
    }, SERVER_RECOVERED_MS);
    commit();
    recoveredListeners.forEach((fn) => fn());
}

/**
 * Reports one transport observation.
 *
 * @param {"shutdown"|"network-failure"|"ok"|"outage"} kind One of `SERVER_STATUS_KIND`.
 * @param {{ sentAt?: number, healthy?: boolean, cause?: "server"|"database" }} [meta] `cause` = who is down
 *        (OUTAGE only; a later report may switch it). `sentAt` = `Date.now()` when the request was sent
 *        (OK only); `healthy` = the readiness probe answered HTTP 200 (OK only; required to end an outage).
 * @returns {void}
 */
export function reportServerStatus(kind, { sentAt, healthy, cause: wantedCause } = {}) {
    if (kind === SERVER_STATUS_KIND.SHUTDOWN) onShutdown();
    else if (kind === SERVER_STATUS_KIND.NETWORK_FAILURE) onNetworkFailure();
    else if (kind === SERVER_STATUS_KIND.OK) onOk(sentAt, healthy);
    else if (kind === SERVER_STATUS_KIND.OUTAGE) onOutage(wantedCause);
}

/**
 * `useSyncExternalStore`-compatible subscribe.
 * @param {() => void} fn
 * @returns {() => void} Unsubscribe.
 */
export function subscribeServerStatus(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/**
 * @returns {Readonly<{phase:"idle"|"pending"|"restarting"|"unavailable"|"recovered", severity:"warning"|"danger"|"success"|null, visible:boolean, outage:boolean, cause:"server"|"database"|null}>}
 */
export function getServerStatusSnapshot() {
    return snapshot;
}

/**
 * Times of the current (or last finished) episode, kept after the store returns to idle so the 523
 * page can say "Back online at hh:mm:ss / Down for n min". Numbers only (CWE-209).
 * `id` is monotonic across the document's lifetime (0 = no episode yet).
 *
 * @returns {Readonly<{id:number, firstAt:number, recoveredAt:number}>}
 */
export function getServerEpisode() {
    return episode;
}

/**
 * Registers a callback fired once each time a restarting/unavailable episode recovers.
 * @param {() => void} fn
 * @returns {() => void} Unsubscribe.
 */
export function onServerRecovered(fn) {
    recoveredListeners.add(fn);
    return () => recoveredListeners.delete(fn);
}

/** Test-only: restores the pristine idle state and drops every subscriber. */
export function _resetServerStatusForTests() {
    clearTimers();
    phase = "idle";
    danger = false;
    firstAt = 0;
    lastShutdownAt = 0;
    strict = false;
    cause = null;
    episode = NO_EPISODE;
    snapshot = IDLE;
    listeners.clear();
    recoveredListeners.clear();
}
