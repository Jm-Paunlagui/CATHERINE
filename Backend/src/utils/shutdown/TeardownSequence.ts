"use strict";

/**
 * @fileoverview The graceful-shutdown teardown ORDER, as two injectable
 * functions.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The shutdown order is load-bearing and was verified only BY READING.
 * `test/server/reliability/graceful-shutdown.test.js` spawns a synthetic
 * fixture child with its own miniature shutdown and exercises NONE of the real
 * handler — so the two orderings that actually matter had no executable proof:
 *
 *   1. `SseConnectionRegistry.endAll()` must precede the in-flight drain.
 *      An SSE socket is a long-lived keep-alive connection with an in-flight
 *      response, so Node never treats it as idle and `server.close()` waits on
 *      it forever. Broadcasting the terminal frame first is what lets a
 *      business-hours restart reach `process.exit(0)` at all.
 *
 *   2. `InFlightTaskRegistry.drain()` must RESOLVE before `db.closeAll()` is
 *      ENTERED. The tracked work is detached DB/SMTP work; closing the pools
 *      underneath it is the exact race the drain was added to remove.
 *
 * Extracting them here makes both assertable against the REAL implementation
 * with injected fakes, instead of against a fixture that merely resembles it.
 *
 * ⚠ The ORDER is load-bearing: SSE end → idle close → (request grace) →
 * forced close before `server.close()`; critical rows (no email) → drain →
 * audit flush → pool close → marker STOPPED → lifecycle + crash emails → final
 * notifier flush (the critical email) → transporter close inside it. Nothing here may be "tidied" into a different
 * order, and nothing may be made to throw: every step is individually guarded
 * because a shutdown must continue through a failing step, not abort on it.
 *
 * Requests already in progress may FINISH. With an
 * `httpInFlight` tracker the forced close waits up to the computed request
 * grace (see {@link computeShutdownBudget}) instead of a fixed 500 ms, which
 * reset every request longer than half a second during a stop (sim 19i).
 *
 * @author senior-nodejs-engineer
 */

const { serverMessages } = require("../../constants/messages/server.messages");

/** Cadence of the "still waiting" notice during a long request grace. */
const SHUTDOWN_WAIT_NOTICE_MS = 60_000;

/**
 * Splits the forced-exit budget between the request grace window and the
 * post-close teardown.
 *
 *   phaseBudgetMs  = forcedExitMs − postDrainReserveMs − safetyMarginMs
 *   requestGraceMs = min(maxGraceMs, max(minGraceMs, phaseBudgetMs − (pendingTasks > 0 ? notifyDrainMs : 0)))
 *
 * The notify drain is reserved only when there is tracked background work to
 * drain; otherwise in-flight requests may use the whole phase. Both the grace
 * and the drain end by `T0 + phaseBudgetMs` (see {@link remainingDrainMs}),
 * which leaves the reserve + margin for flushPending → closeAll →
 * closeTransporter → logger.flush before the forced exit fires.
 *
 * @param {object} p
 * @param {number} p.forcedExitMs
 * @param {number} p.postDrainReserveMs
 * @param {number} p.safetyMarginMs
 * @param {number} p.notifyDrainMs
 * @param {number} p.pendingTasks - InFlightTaskRegistry.size() at signal time
 * @param {number} p.minGraceMs
 * @param {number} [p.maxGraceMs=Infinity] - Hard cap on the request grace (server.js uses 30 min)
 * @returns {{phaseBudgetMs: number, requestGraceMs: number, drainReservedMs: number}}
 */
function computeShutdownBudget({
    forcedExitMs,
    postDrainReserveMs,
    safetyMarginMs,
    notifyDrainMs,
    pendingTasks,
    minGraceMs,
    maxGraceMs = Infinity,
}) {
    const phaseBudgetMs = Math.max(0, forcedExitMs - postDrainReserveMs - safetyMarginMs);
    const drainReservedMs = pendingTasks > 0 ? notifyDrainMs : 0;
    const requestGraceMs = Math.min(maxGraceMs, Math.max(minGraceMs, phaseBudgetMs - drainReservedMs));
    return { phaseBudgetMs, requestGraceMs, drainReservedMs };
}

/**
 * Notify-drain budget left once the HTTP server has closed: never more than
 * `notifyDrainMs`, never past the phase deadline, never negative.
 *
 * @param {{phaseDeadline: number, now: number, notifyDrainMs: number}} p
 * @returns {number}
 */
function remainingDrainMs({ phaseDeadline, now, notifyDrainMs }) {
    return Math.max(0, Math.min(notifyDrainMs, phaseDeadline - now));
}

/**
 * Everything that must happen BEFORE `server.close()` is called.
 *
 * Ends every live SSE stream and drops idle keep-alive sockets immediately.
 *
 * Function, not a class, on purpose (QA-18, deferred): although it returns a
 * handle with `shortenTo` / `recordIdleCut`, the state is closure-local to a
 * single call and lives for one shutdown only; there is no second instance,
 * no lifecycle beyond the call and no inheritance need. Revisit if a second
 * consumer of the handle appears.
 *
 * Without an `httpInFlight` tracker the behaviour is the original one: a
 * single `closeAllConnections()` after `forceCloseAfterMs`.
 *
 * With a tracker, requests already being answered may finish:
 *   - each finished response closes its socket at once;
 *   - as soon as NO tracked request is left (at once, or when the last one
 *     finishes) every remaining socket is closed — but never before
 *     `minGraceMs`, so the SSE `shutdown` frame can flush. Sockets the tracker
 *     cannot see (a half-sent request, an SSE stream `endAll` missed) would
 *     otherwise hold `server.close()` open until the forced exit, because Node
 *     stops enforcing headersTimeout once `close()` is called;
 *   - requests still running at `forceCloseAfterMs` are cut: a warning, the
 *     `onRequestsCut` hook, then `closeAllConnections()`.
 * Synchronous and never throws.
 *
 * @param {object} deps
 * @param {{endAll: (reason: string) => void}} deps.sseRegistry
 * @param {import('http').Server} deps.server
 * @param {number} [deps.forceCloseAfterMs] - Grace before in-flight requests are cut.
 * @param {number} [deps.sseDrainGraceMs] - Legacy name for `forceCloseAfterMs`.
 * @param {number} [deps.minGraceMs=500] - Earliest forced close (lets the SSE frame flush).
 * @param {{notice?: Function, warning: Function}} deps.logger
 * @param {string} [deps.reason="server_shutdown"]
 * @param {{beginShutdown: Function, activeCount: () => number, activeSummary?: Function}} [deps.httpInFlight]
 * @param {(summary: Array<object>, graceMs: number, total: number, opts: {reason: "cap"|"idle"}) => void} [deps.onRequestsCut]
 *   Called at the cap with `reason: "cap"`, and once at the end of the wait with
 *   `reason: "idle"` when the idle watchdog cut requests meanwhile.
 * @param {number} [deps.waitNoticeMs=SHUTDOWN_WAIT_NOTICE_MS] - Cadence of the "still waiting" notice.
 * @returns {{shortenTo: (ms: number) => void, recordIdleCut: (entry: object) => void, idleCuts: Array<object>}}
 *   Handle: `shortenTo` pulls the cut deadline in (crash during a long stop),
 *   `recordIdleCut` is fed by the RequestWatchdog shutdown hook.
 */
function preCloseTeardown({
    sseRegistry,
    server,
    forceCloseAfterMs,
    sseDrainGraceMs,
    minGraceMs = 500,
    logger,
    reason = "server_shutdown",
    httpInFlight,
    onRequestsCut,
    waitNoticeMs = SHUTDOWN_WAIT_NOTICE_MS,
}) {
    let graceMs = forceCloseAfterMs ?? sseDrainGraceMs;
    /** @type {Array<object>} */
    const idleCuts = [];
    const handle = {
        shortenTo() {},
        recordIdleCut: (entry) => {
            idleCuts.push(entry);
        },
        idleCuts,
    };
    const closeAll = () => {
        if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    };
    const unref = (t) => {
        if (typeof t.unref === "function") t.unref();
        return t;
    };

    try {
        sseRegistry.endAll(reason);
    } catch (err) {
        logger.warning("SSE shutdown broadcast failed", { error: err.message });
    }

    if (typeof server.closeIdleConnections === "function") {
        server.closeIdleConnections();
    }

    if (!httpInFlight) {
        unref(setTimeout(closeAll, graceMs));
        return handle;
    }

    const startedAt = Date.now();
    const initial = httpInFlight.activeCount();
    let finished = false;
    let cutTimer = null;
    let noticeTimer = null;

    // ONE email for everything the idle watchdog cut during the wait.
    const reportIdleCuts = () => {
        if (idleCuts.length === 0) return;
        logger.warning?.(serverMessages.SHUTDOWN_IDLE_CUTS(idleCuts.length));
        if (!onRequestsCut) return;
        try {
            onRequestsCut(idleCuts.slice(0, 20), graceMs, idleCuts.length, { reason: "idle" });
        } catch (err) {
            logger.warning(serverMessages.SHUTDOWN_CUT_HOOK_FAILED(err.message));
        }
    };

    // Nothing tracked is left: close every remaining socket, no earlier than
    // minGraceMs after the start.
    const finish = (logFinished) => {
        if (finished) return;
        finished = true;
        if (cutTimer) clearTimeout(cutTimer);
        if (noticeTimer) clearInterval(noticeTimer);
        reportIdleCuts();
        if (logFinished) {
            logger.notice?.(serverMessages.SHUTDOWN_REQUESTS_FINISHED(Date.now() - startedAt));
        }
        unref(setTimeout(closeAll, Math.max(0, startedAt + minGraceMs - Date.now())));
    };

    httpInFlight.beginShutdown(() => {
        // A finished response's socket is now idle (Connection: close also
        // ends it) — drop it so server.close() can complete.
        if (typeof server.closeIdleConnections === "function") {
            server.closeIdleConnections();
        }
        if (httpInFlight.activeCount() === 0) finish(true);
    });

    if (initial === 0) {
        finish(false);
        return handle;
    }

    logger.notice?.(serverMessages.SHUTDOWN_REQUEST_GRACE(initial, graceMs));

    const cut = () => {
        if (finished) return;
        finished = true;
        if (noticeTimer) clearInterval(noticeTimer);
        const stillRunning = httpInFlight.activeCount();
        if (stillRunning > 0) {
            logger.warning(serverMessages.SHUTDOWN_REQUESTS_CUT(stillRunning, graceMs));
            if (onRequestsCut) {
                try {
                    onRequestsCut(httpInFlight.activeSummary?.() ?? [], graceMs, stillRunning, { reason: "cap" });
                } catch (err) {
                    logger.warning(serverMessages.SHUTDOWN_CUT_HOOK_FAILED(err.message));
                }
            }
        }
        reportIdleCuts();
        closeAll();
    };
    cutTimer = unref(setTimeout(cut, graceMs));

    // Long waits are legal now (cap 30 min) — say what is being waited on.
    if (waitNoticeMs > 0) {
        noticeTimer = unref(
            setInterval(() => {
                if (finished) return;
                try {
                    logger.notice?.(
                        serverMessages.SHUTDOWN_WAITING(
                            httpInFlight.activeCount(),
                            Date.now() - startedAt,
                            graceMs,
                            httpInFlight.activeSummary?.(3) ?? [],
                        ),
                    );
                } catch {
                    /* a notice must never break the wait */
                }
            }, waitNoticeMs),
        );
    }

    handle.shortenTo = (ms) => {
        if (finished) return;
        const remaining = Math.max(0, startedAt + graceMs - Date.now());
        const next = Math.max(0, Math.min(remaining, ms));
        graceMs = Date.now() - startedAt + next;
        clearTimeout(cutTimer);
        cutTimer = unref(setTimeout(cut, next));
    };
    return handle;
}

/**
 * Everything that must happen INSIDE the `server.close()` callback, in order.
 *
 * The drain is deliberately here and not before `server.close()`: the socket
 * must stop accepting new connections first, or it would go on accepting for
 * up to `notifyDrainMs` into a shutdown.
 *
 * Never throws — a failing step is logged and the sequence continues, because
 * the steps after it (pool close, transporter close) are what actually let the
 * process exit.
 *
 * @param {object} deps
 * @param {{drain: (ms: number) => Promise<any>}} deps.inFlight
 * @param {{flushPending: (opts?: {final?: boolean}) => Promise<any>}} deps.auditLog
 * @param {{closeAll?: () => Promise<any>}} deps.db
 * @param {{closeTransporter: () => void}} deps.sharedTransporter
 * @param {{notice: Function, warning: Function, error: Function}} deps.logger
 * @param {number|(() => number)} deps.notifyDrainMs - Drain budget. A function is resolved right AFTER
 *   phase 1 (so the phase-1 flush, up to 5 s, is subtracted from the phase deadline); a number is used as is.
 * @param {() => Promise<any>} [deps.lifecycleSettled] - Resolves when the shutdown lifecycle emails left. Awaited
 *   AFTER the data teardown: they are never written to SERVER_ALERT_LOG, so they need no pool, and a
 *   slow mail server must not hold the audit flush, the pool close or the STOPPED marker hostage.
 * @param {() => void} [deps.onDataTeardownComplete] - Called once the audit flush and the pool close have run
 *   (both are bounded and never throw: a timed-out audit flush logs SHUTDOWN_ROWS_UNPERSISTED and still counts),
 *   before any further wait (writes the restart marker's STOPPED record). Never allowed to throw past here.
 * @param {{flushForShutdown: () => Promise<any>, drainAndStop: (opts: {timeoutMs: number, persist: boolean}) => Promise<any>}} [deps.alertNotifier]
 *   Injected (this module never imports AlertNotifierService). Phase 1 flushes
 *   buffered criticals with rows; phase 2 (after the pools closed) is email-only.
 * @param {() => number} [deps.finalNotifyMs] - Live budget for the phase-2 flush (default 0 = skip).
 * @returns {Promise<void>}
 */
async function postCloseTeardown({
    inFlight,
    auditLog,
    db,
    sharedTransporter,
    logger,
    notifyDrainMs,
    lifecycleSettled,
    alertNotifier,
    finalNotifyMs = () => 0,
    onDataTeardownComplete,
}) {
    // Phase 2 notifier flush: runs after the pools closed, before the SMTP
    // transporter closes. Single-flight in the service, so calling it from both
    // the happy path and the catch is idempotent. Never throws.
    const finalNotify = async () => {
        if (!alertNotifier) return;
        try {
            await alertNotifier.drainAndStop({ timeoutMs: finalNotifyMs(), persist: false });
        } catch (e) {
            logger.warning(serverMessages.SHUTDOWN_NOTIFIER_STEP_FAILED("final flush", e.message), { _noNotify: true });
        }
    };

    // The shutdown lifecycle emails ("Server shutting down", already on their
    // way since the signal) are awaited only AFTER the data teardown below.
    // They are never written to SERVER_ALERT_LOG, so they need no pool; a host
    // reboot gives the service a few seconds, and on CBWEB001V that email alone
    // took 3.7 s. Bounded by the service; never throws.
    const lifecycleEmails = async () => {
        if (!lifecycleSettled) return;
        try {
            await Promise.resolve().then(lifecycleSettled);
        } catch (err) {
            logger.warning(serverMessages.SHUTDOWN_STEP_FAILED("waiting for the shutdown emails", err?.message ?? String(err)), { _noNotify: true });
        }
    };

    // Phase 1: buffered criticals, while the Oracle pools are still open so
    // their SERVER_ALERT_LOG rows land (bounded by the service).
    if (alertNotifier) {
        try {
            await Promise.resolve().then(() => alertNotifier.flushForShutdown());
        } catch (err) {
            logger.warning(serverMessages.SHUTDOWN_NOTIFIER_STEP_FAILED("phase-1 flush", err?.message ?? String(err)), { _noNotify: true });
        }
    }

    // Bound-drain tracked detached work BEFORE the Oracle pools and SMTP
    // transporter close. Silent and free when nothing is tracked — the
    // overwhelmingly common case. The budget is resolved HERE, after phase 1,
    // so time spent in phase 1 is not given to the drain twice.
    try {
        await inFlight.drain(typeof notifyDrainMs === "function" ? notifyDrainMs() : notifyDrainMs);
    } catch (err) {
        logger.warning("In-flight task drain failed during shutdown", {
            error: err.message,
        });
    }

    try {
        // Flush buffered audit records BEFORE closing the pools — batched
        // audit persistence holds records in memory between flushes. `final`
        // makes it one bounded attempt with no requeue or retry timer.
        await auditLog.flushPending({ final: true });

        if (typeof db.closeAll === "function") {
            await db.closeAll();
        }

        // Records saved and pools closed: everything a hard kill could damage is
        // done. Tell the restart marker now, before the remaining waits.
        if (onDataTeardownComplete) {
            try {
                onDataTeardownComplete();
            } catch (err) {
                logger.warning(serverMessages.SHUTDOWN_STEP_FAILED("marking the stop as clean", err?.message ?? String(err)), { _noNotify: true });
            }
        }

        // The lifecycle emails and phase 2 run CONCURRENTLY, both before the transporter
        // closes. Serial, the digest started only after the "Server shutting down" email (3.7 s on
        // CBWEB001V) and missed a ~5 s host-reboot window. Phase 2 is the final critical-digest
        // flush, email only (the pools are closed), bounded by the live failsafe budget.
        await Promise.all([lifecycleEmails(), finalNotify()]);

        // The shared SMTP transporter pools connections by default; open pool
        // sockets keep the event loop alive, so without this the process hangs
        // until the forced-exit timer fires and a clean stop reads as a hang.
        sharedTransporter.closeTransporter();

        logger.notice("All resources cleaned up.");
    } catch (err) {
        logger.error("Error during shutdown cleanup", { error: err.message });
        await Promise.all([lifecycleEmails(), finalNotify()]);
    }
}

/**
 * Failsafe delay for a crash (exitCode > 0): the sum of the crash schedule
 * phases. Single source for both the first-call arm and `shortenForCrash`.
 *
 * @example computeCrashFailsafeMs({ crashGraceMs: 10_000, notifyDrainClampMs: 15_000, postDrainReserveMs: 13_000, safetyMarginMs: 6_000 }) // 44_000
 * @param {object} p
 * @param {number} p.crashGraceMs
 * @param {number} p.notifyDrainClampMs
 * @param {number} p.postDrainReserveMs
 * @param {number} p.safetyMarginMs
 * @returns {number}
 */
function computeCrashFailsafeMs({ crashGraceMs, notifyDrainClampMs, postDrainReserveMs, safetyMarginMs }) {
    return crashGraceMs + notifyDrainClampMs + postDrainReserveMs + safetyMarginMs;
}

/**
 * Budget for the phase-2 notifier flush: time left before the failsafe fires,
 * minus the reserve for logger.flush + exit. Never negative.
 *
 * @param {{failsafeFireAt: number, now: number, reserveMs: number}} p
 * @returns {number}
 */
function finalNotifyBudgetMs({ failsafeFireAt, now, reserveMs }) {
    return Math.max(0, failsafeFireAt - now - reserveMs);
}

module.exports = {
    computeCrashFailsafeMs,
    finalNotifyBudgetMs,
    preCloseTeardown,
    postCloseTeardown,
    computeShutdownBudget,
    remainingDrainMs,
    SHUTDOWN_WAIT_NOTICE_MS,
};
