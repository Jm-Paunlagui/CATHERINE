"use strict";

/**
 * @fileoverview Branch sweep for `AlertNotifierService`: the arms that only
 * run on odd input (non-Error rejections, missing alert fields, timers that
 * have no `unref`, cluster forwarding, invalid ack keys, queue overflow).
 *
 * No Oracle, no SMTP: every collaborator (ServerNotificationService, the
 * alert-log / ack models, MetricsService, clusterRpc) is stubbed.
 */

const { AlertNotifierService } = require("../../../../src/services/AlertNotifierService");
const MetricsService = require("../../../../src/services/MetricsService");
const ServerNotificationService = require("../../../../src/services/email/ServerNotificationService");
const ServerAlertLogModel = require("../../../../src/models/serverAlertLog.model");
const ServerAlertAckModel = require("../../../../src/models/serverAlertAck.model");
const AdminModel = require("../../../../src/models/admin.model");
const { logger } = require("../../../../src/utils/logger");
const { NOTIFICATION_ERRORS, AppError } = require("../../../../src/constants/errors");

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function rejection(promise) {
    try {
        await promise;
    } catch (err) {
        return err;
    }
    throw new Error("expected rejection");
}

describe("AlertNotifierService — branch sweep", function () {
    let svc;

    beforeEach(function () {
        svc = new AlertNotifierService();
        vi.spyOn(logger, "warning").mockImplementation(() => {});
        vi.spyOn(logger, "notice").mockImplementation(() => {});
        vi.spyOn(logger, "info").mockImplementation(() => {});
        vi.spyOn(logger, "debug").mockImplementation(() => {});
        vi.spyOn(ServerAlertLogModel, "insertOne").mockResolvedValue(undefined);
    });

    afterEach(function () {
        svc.stop();
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    // ── timers without unref (e.g. a host that returns numeric handles) ──────
    describe("timers whose handle has no unref()", function () {
        it("start() still arms the poll timer and the retention sweep", function () {
            vi.spyOn(ServerNotificationService, "isEnabled").mockReturnValue(true);
            vi.spyOn(logger, "onLevel").mockReturnValue(() => {});
            vi.spyOn(svc, "_hydrateAcks").mockResolvedValue();
            const si = vi.spyOn(global, "setInterval").mockReturnValue(7);
            vi.spyOn(global, "clearInterval").mockImplementation(() => {});

            expect(svc.start()).toEqual({ started: true });

            expect(si).toHaveBeenCalledTimes(2); // poll + retention
            expect(svc._pollTimer).toBe(7);
            expect(svc._retentionSweepTimer).toBe(7);
        });

        it("_onCriticalLog arms the digest window with a handle lacking unref", function () {
            const st = vi.spyOn(global, "setTimeout").mockReturnValue(9);
            svc._onCriticalLog({ level: "CRITICAL", message: "x", meta: {}, requestId: null, timestamp: new Date().toISOString() });
            expect(svc._criticalWindowTimer).toBe(9);
            expect(st).toHaveBeenCalledWith(expect.any(Function), svc._digestWindowMs());
            svc._criticalWindowTimer = null;
        });

        it("_raceBudget resolves 'done' when work wins and the timer has no unref", async function () {
            vi.spyOn(global, "setTimeout").mockReturnValue(5);
            vi.spyOn(global, "clearTimeout").mockImplementation(() => {});
            await expect(svc._raceBudget(Promise.resolve(), 100)).resolves.toBe("done");
        });

        it("_raceBudget reports 'error' when the work rejects", async function () {
            await expect(svc._raceBudget(Promise.reject(new Error("x")), 100)).resolves.toBe("error");
        });

        it("notifyCriticalNow and notifyLifecycleNow still resolve with handle lacking unref", async function () {
            vi.spyOn(ServerNotificationService, "isEnabled").mockReturnValue(true);
            vi.spyOn(ServerNotificationService, "sendChannelDigest").mockResolvedValue({ sent: true, notificationId: "n1" });
            vi.spyOn(global, "setTimeout").mockReturnValue(3);

            await expect(svc.notifyCriticalNow({ message: "boom" })).resolves.toMatchObject({ sent: true });
            await expect(
                svc.notifyLifecycleNow({ severity: "WARNING", headline: "h", summary: "s" }),
            ).resolves.toMatchObject({ sent: true });
        });

        it("_armRetentionSweep is idempotent and tolerates a handle lacking unref", function () {
            const si = vi.spyOn(global, "setInterval").mockReturnValue(11);
            svc._armRetentionSweep();
            svc._armRetentionSweep();
            expect(si).toHaveBeenCalledTimes(1);
            svc._retentionSweepTimer = null;
        });
    });

    describe("non-Error rejections are stringified in log text", function () {
        it("poll-timer rejection with a bare string logs that string", async function () {
            vi.useFakeTimers();
            vi.spyOn(ServerNotificationService, "isEnabled").mockReturnValue(true);
            vi.spyOn(logger, "onLevel").mockReturnValue(() => {});
            vi.spyOn(svc, "_hydrateAcks").mockResolvedValue();
            vi.spyOn(svc, "_pollTick").mockRejectedValue("plain-string-failure");

            svc.start();
            await vi.advanceTimersByTimeAsync(svc._pollIntervalMs() + 1);

            expect(logger.warning).toHaveBeenCalledWith(
                expect.stringContaining("plain-string-failure"),
                { _noNotify: true },
            );
        });

        it("a getClusterSnapshot rejecting with a bare string ends the tick quietly", async function () {
            vi.spyOn(MetricsService, "getClusterSnapshot").mockRejectedValue("snapshot-down");
            await expect(svc._runPollTick()).resolves.toBeUndefined();
            expect(logger.warning).toHaveBeenCalledWith(expect.stringContaining("snapshot-down"), { _noNotify: true });
        });

        it("the critical-digest timer rejection with a bare string is logged", async function () {
            vi.useFakeTimers();
            vi.spyOn(svc, "_flushCriticalDigest").mockRejectedValue("digest-down");
            svc._onCriticalLog({ level: "CRITICAL", message: "m", meta: {}, requestId: null, timestamp: new Date().toISOString() });
            await vi.advanceTimersByTimeAsync(svc._digestWindowMs() + 1);
            expect(logger.warning).toHaveBeenCalledWith(expect.stringContaining("digest-down"), { _noNotify: true });
        });

        it("a retention-purge rejection with a bare string is logged", async function () {
            vi.useFakeTimers();
            vi.spyOn(svc, "_runRetentionPurge").mockRejectedValue("purge-down");
            svc._armRetentionSweep();
            await vi.advanceTimersByTimeAsync(24 * 3600_000 + 1);
            expect(logger.warning).toHaveBeenCalledWith(expect.stringContaining("purge-down"), { _noNotify: true });
        });
    });

    describe("_clearTimers / drainAndStop with nothing armed", function () {
        it("_clearTimers on an idle instance is a harmless no-op", function () {
            expect(() => svc._clearTimers()).not.toThrow();
            expect(svc._pollTimer).toBeFalsy();
            expect(svc._retentionSweepTimer).toBeFalsy();
            expect(svc._criticalWindowTimer).toBeFalsy();
        });

        it("drainAndStop on a running notifier with an empty buffer reports 'empty' and does not email", async function () {
            const send = vi.spyOn(ServerNotificationService, "sendChannelDigest");
            svc._running = true;
            await expect(svc.drainAndStop()).resolves.toEqual({ events: 0, outcome: "empty" });
            expect(send).not.toHaveBeenCalled();
        });

        it("flushForShutdown with a non-running notifier reports 'empty'", async function () {
            svc._criticalBuffer.push({ level: "CRITICAL", message: "m", meta: {}, requestId: null, timestamp: "2026-01-01T00:00:00Z" });
            await expect(svc.flushForShutdown()).resolves.toEqual({ events: 0, outcome: "empty" });
        });

        it("mapRuleToChannel falls back to the system channel for an unmapped rule", function () {
            expect(AlertNotifierService.mapRuleToChannel("BRAND_NEW_RULE")).toBe("server-system-notification");
            expect(AlertNotifierService.mapRuleToChannel("ORACLE_POOL_DOWN")).toBe("server-critical-notification");
        });
    });

    describe("graceful shutdown steps", function () {
        const ev = { level: "CRITICAL", message: "m", meta: {}, requestId: null, timestamp: "2026-01-01T00:00:00Z" };

        it("beginShutdown stops poll + retention timers, keeps the tap, and is idempotent", function () {
            vi.spyOn(ServerNotificationService, "isEnabled").mockReturnValue(true);
            const unsub = vi.fn();
            vi.spyOn(logger, "onLevel").mockReturnValue(unsub);
            vi.spyOn(svc, "_hydrateAcks").mockResolvedValue();
            svc.start();
            svc.beginShutdown();
            expect(svc._pollTimer).toBeNull();
            expect(svc._retentionSweepTimer).toBeNull();
            expect(unsub).not.toHaveBeenCalled();
            logger.notice.mockClear();
            svc.beginShutdown();
            expect(logger.notice).not.toHaveBeenCalled();
        });

        it("beginShutdown on a notifier that never started does nothing", function () {
            svc.beginShutdown();
            expect(svc._shuttingDown).toBeFalsy();
        });

        it("beginShutdown with already-cleared timers still marks shutting down", function () {
            svc._running = true;
            svc.beginShutdown();
            expect(svc._shuttingDown).toBe(true);
        });

        it("flushForShutdown saves the buffer's rows, cancels the digest window timer, reports done and emails nothing yet", async function () {
            vi.spyOn(ServerNotificationService, "sendChannelDigest").mockResolvedValue({ sent: true });
            svc._running = true;
            svc._criticalBuffer.push(ev);
            svc._criticalWindowTimer = setTimeout(() => {}, 100000);
            const res = await svc.flushForShutdown();
            expect(res).toEqual({ events: 1, outcome: "done" });
            expect(svc._criticalWindowTimer).toBeNull();
            expect(ServerNotificationService.sendChannelDigest).not.toHaveBeenCalled(); // the email follows in drainAndStop
            expect(svc._criticalBuffer).toHaveLength(1);
            expect(svc._criticalBuffer[0].rowSaved).toBe(true);
        });

        it("flushForShutdown without a pending window timer still flushes", async function () {
            vi.spyOn(ServerNotificationService, "sendChannelDigest").mockResolvedValue({ sent: true });
            svc._running = true;
            svc._criticalBuffer.push(ev);
            await expect(svc.flushForShutdown({ timeoutMs: 1000 })).resolves.toEqual({ events: 1, outcome: "done" });
        });

        it("drainAndStop is single-flight and does not cache a 'skipped' result", async function () {
            vi.spyOn(ServerNotificationService, "sendChannelDigest").mockResolvedValue({ sent: true });
            svc._running = true;
            svc._criticalBuffer.push(ev);
            const skipped = await svc.drainAndStop({ timeoutMs: 0 });
            expect(skipped).toEqual({ events: 1, outcome: "skipped" });
            expect(ServerNotificationService.sendChannelDigest).not.toHaveBeenCalled();
            expect(svc._drainPromise).toBeFalsy();

            svc._criticalBuffer = [ev];
            const first = svc.drainAndStop({ timeoutMs: 1000 });
            expect(svc.drainAndStop()).toBe(first);
            await expect(first).resolves.toEqual({ events: 1, outcome: "done" });
        });

        it("drainAndStop on a never-started notifier with nothing buffered resolves empty and caches it", async function () {
            const first = svc.drainAndStop();
            await expect(first).resolves.toEqual({ events: 0, outcome: "empty" });
            expect(svc.drainAndStop()).toBe(first);
        });

        it("drainAndStop unsubscribes the tap exactly once", async function () {
            const unsub = vi.fn();
            svc._running = true;
            svc._unsubscribeTap = unsub;
            await svc.drainAndStop();
            expect(unsub).toHaveBeenCalledTimes(1);
            expect(svc._unsubscribeTap).toBeNull();
        });

        it("a second start() while running is a no-op; stop() reports discarded buffered criticals", function () {
            vi.spyOn(ServerNotificationService, "isEnabled").mockReturnValue(true);
            vi.spyOn(logger, "onLevel").mockReturnValue(() => {});
            vi.spyOn(svc, "_hydrateAcks").mockResolvedValue();
            svc.start();
            expect(svc.start()).toEqual({ started: false, reason: "already-started" });
            svc._criticalBuffer.push(ev);
            svc._criticalOverflowInWindow = 2;
            svc.stop();
            expect(logger.warning).toHaveBeenCalledWith(expect.stringContaining("3"), { _noNotify: true });
        });

        it("ingest storm past the 200-event cap counts overflow and warns once", function () {
            svc._running = true;
            vi.spyOn(global, "setTimeout").mockReturnValue(1);
            for (let n = 0; n < 203; n++) svc._onCriticalLog({ ...ev, message: `m${n}` });
            expect(svc._criticalBuffer).toHaveLength(200);
            expect(svc._criticalOverflowInWindow).toBe(3);
            const capped = logger.warning.mock.calls.filter(([, m]) => m && m._noNotify);
            expect(capped).toHaveLength(1);
            svc._criticalWindowTimer = null;
        });
    });

    // ── poll-tick state machine odd inputs ───────────────────────────────────
    describe("_runPollTick state machine", function () {
        const wire = (alertsPerTick) => {
            let i = 0;
            vi.spyOn(MetricsService, "getClusterSnapshot").mockResolvedValue({});
            vi.spyOn(MetricsService, "evaluateAlerts").mockImplementation(() => alertsPerTick[Math.min(i++, alertsPerTick.length - 1)]);
            vi.spyOn(MetricsService, "evaluateAlertHolds").mockReturnValue([]);
            return vi.spyOn(svc, "_dispatchMetricDigest").mockResolvedValue();
        };

        it("an alert with no severity is treated as WARNING and fires once", async function () {
            const dispatch = wire([[{ rule: "HIGH_HEAP", description: "d" }]]);
            await svc._runPollTick();
            expect(svc._alertStates.get("HIGH_HEAP::global").status).toBe("WARNING");
            expect(dispatch).toHaveBeenCalledTimes(1);
            expect(dispatch.mock.calls[0][0]).toBe("server-system-notification");
            expect(dispatch.mock.calls[0][2]).toEqual({});
            expect(dispatch.mock.calls[0][3]).toBe(false);
        });

        it("an unknown severity after WARNING neither sends nor throws", async function () {
            const dispatch = wire([
                [{ rule: "HIGH_HEAP", severity: "warning" }],
                [{ rule: "HIGH_HEAP", severity: "info" }],
            ]);
            await svc._runPollTick();
            dispatch.mockClear();
            await svc._runPollTick();
            expect(dispatch).not.toHaveBeenCalled();
            expect(svc._alertStates.get("HIGH_HEAP::global").status).toBe("INFO");
        });

        it("CRITICAL -> WARNING de-escalation sends nothing", async function () {
            const dispatch = wire([
                [{ rule: "HIGH_HEAP", severity: "critical" }],
                [{ rule: "HIGH_HEAP", severity: "warning" }],
            ]);
            await svc._runPollTick();
            dispatch.mockClear();
            await svc._runPollTick();
            expect(dispatch).not.toHaveBeenCalled();
        });

        it("WARNING -> CRITICAL escalation sends with transition ESCALATED", async function () {
            const dispatch = wire([
                [{ rule: "HIGH_HEAP", severity: "warning" }],
                [{ rule: "HIGH_HEAP", severity: "critical" }],
            ]);
            await svc._runPollTick();
            dispatch.mockClear();
            await svc._runPollTick();
            expect(dispatch).toHaveBeenCalledTimes(1);
            expect(dispatch.mock.calls[0][1][0]).toMatchObject({ key: "HIGH_HEAP::global", transitionType: "ESCALATED" });
        });

        it("same severity inside the cooldown is not re-sent; after the cooldown it is RENOTIFIED", async function () {
            const dispatch = wire([[{ rule: "HIGH_HEAP", severity: "warning" }]]);
            await svc._runPollTick();
            dispatch.mockClear();
            await svc._runPollTick();
            expect(dispatch).not.toHaveBeenCalled();

            svc._alertStates.get("HIGH_HEAP::global").lastNotifiedAt = Date.now() - svc._cooldownMs() - 1;
            await svc._runPollTick();
            expect(dispatch).toHaveBeenCalledTimes(1);
            expect(dispatch.mock.calls[0][1][0].transitionType).toBe("RENOTIFIED");
        });

        it("a valid ack suppresses the cooldown re-notify and logs it", async function () {
            const dispatch = wire([[{ rule: "HIGH_HEAP", severity: "warning" }]]);
            await svc._runPollTick();
            svc._acks.set("HIGH_HEAP::global", {
                ackedBy: 1, ackedAt: Date.now(), expiresAt: Date.now() + 60_000, severityAtAck: "WARNING", note: null,
            });
            svc._alertStates.get("HIGH_HEAP::global").lastNotifiedAt = Date.now() - svc._cooldownMs() - 1;
            dispatch.mockClear();
            await svc._runPollTick();
            expect(dispatch).not.toHaveBeenCalled();
            expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("HIGH_HEAP::global"), { _noNotify: true });
        });

        it("two alerts on one channel recovering together are batched into ONE recovery digest", async function () {
            process.env.ALERT_RECOVERY_CONFIRM_POLLS = "1";
            try {
                const dispatch = wire([
                    [{ rule: "HIGH_HEAP", severity: "warning" }, { rule: "EVENT_LOOP_LAG", severity: "warning" }],
                    [],
                ]);
                await svc._runPollTick();
                dispatch.mockClear();
                await svc._runPollTick();
                const recoveries = dispatch.mock.calls.filter((c) => c[3] === true);
                expect(recoveries).toHaveLength(1);
                expect(recoveries[0][0]).toBe("server-system-notification");
                expect(recoveries[0][1].map((e) => e.key).sort()).toEqual(["EVENT_LOOP_LAG::global", "HIGH_HEAP::global"]);
            } finally {
                delete process.env.ALERT_RECOVERY_CONFIRM_POLLS;
            }
        });

        it("a state removed while its digest is being sent is skipped when stamping lastNotifiedAt", async function () {
            wire([[{ rule: "HIGH_HEAP", severity: "warning" }]]);
            svc._dispatchMetricDigest.mockImplementation(async () => {
                svc._alertStates.delete("HIGH_HEAP::global");
            });
            await expect(svc._runPollTick()).resolves.toBeUndefined();
            expect(svc._alertStates.has("HIGH_HEAP::global")).toBe(false);
        });
    });

    // ── digest builders with sparse inputs ───────────────────────────────────
    describe("_dispatchMetricDigest with sparse events", function () {
        beforeEach(function () {
            vi.spyOn(ServerNotificationService, "sendChannelDigest").mockResolvedValue({ sent: true, notificationId: "n-9" });
        });

        it("an active event with an empty alert uses UNKNOWN_RULE / global / '' / warning defaults", async function () {
            const write = vi.spyOn(svc, "_writeAlertLogRows").mockResolvedValue();
            await svc._dispatchMetricDigest("server-system-notification", [{ alert: {}, key: undefined }], {}, false);

            const [, payload] = ServerNotificationService.sendChannelDigest.mock.calls[0];
            expect(payload.rows).toEqual([{ rule: "UNKNOWN_RULE", scope: "global", description: "", severity: "warning" }]);
            expect(payload.severity).toBe("WARNING");
            const [logRows] = write.mock.calls[0];
            expect(logRows[0]).toMatchObject({
                rule: "UNKNOWN_RULE", transition: "RENOTIFIED", description: null, notificationId: "n-9", emailStatus: "SENT",
            });
        });

        it("a recovery event takes rule and route from state.lastAlert", async function () {
            const write = vi.spyOn(svc, "_writeAlertLogRows").mockResolvedValue();
            await svc._dispatchMetricDigest(
                "server-system-notification",
                [{ state: { lastAlert: { rule: "HIGH_LATENCY", route: "/r" }, rule: "x", scope: "y" }, key: "HIGH_LATENCY::/r" }],
                {},
                true,
            );
            const [, payload] = ServerNotificationService.sendChannelDigest.mock.calls[0];
            expect(payload.rows[0]).toMatchObject({ rule: "HIGH_LATENCY", scope: "/r" });
            expect(write.mock.calls[0][0][0].rule).toBe("HIGH_LATENCY");
        });

        it("a critical alert makes the digest CRITICAL", async function () {
            vi.spyOn(svc, "_writeAlertLogRows").mockResolvedValue();
            await svc._dispatchMetricDigest(
                "server-system-notification",
                [{ alert: { rule: "HIGH_HEAP", severity: "CRITICAL" }, key: "HIGH_HEAP::global", transitionType: "FIRED" }],
                {},
                false,
            );
            expect(ServerNotificationService.sendChannelDigest.mock.calls[0][1].severity).toBe("CRITICAL");
        });

        it("recovery rows ignore alert fields and take scope from the key when state has none", async function () {
            const write = vi.spyOn(svc, "_writeAlertLogRows").mockResolvedValue();
            await svc._dispatchMetricDigest(
                "server-system-notification",
                [{ state: { lastAlert: null }, key: "HIGH_LATENCY::/api/x" }],
                {},
                true,
            );
            const [, payload] = ServerNotificationService.sendChannelDigest.mock.calls[0];
            expect(payload.severity).toBe("RESOLVED");
            expect(payload.rows[0]).toEqual({
                rule: "UNKNOWN_RULE", scope: "global", description: "Recovered - no longer firing.", severity: "resolved",
            });
            const [logRows] = write.mock.calls[0];
            expect(logRows[0]).toMatchObject({
                transition: "RECOVERED", rule: "UNKNOWN_RULE", description: "Recovered - no longer firing.", severity: "RESOLVED",
            });
            expect(logRows[0].details).toBeDefined();
        });

        it("a failed send is recorded as FAILED with the cause, a disabled one as DISABLED", async function () {
            ServerNotificationService.sendChannelDigest.mockResolvedValueOnce({ sent: false, reason: "smtp", cause: "ECONNREFUSED" });
            const write = vi.spyOn(svc, "_writeAlertLogRows").mockResolvedValue();
            await svc._dispatchMetricDigest("server-system-notification", [{ alert: { rule: "R" }, key: "R::global" }], {}, false);
            expect(write.mock.calls[0][0][0]).toMatchObject({ emailStatus: "FAILED", emailError: "ECONNREFUSED", notificationId: null });
            expect(svc._emailStatusFor({ sent: false, reason: "disabled" })).toBe("DISABLED");
        });
    });

    describe("_buildMetricAlertDetails / _buildChannelKv", function () {
        it("a bare alert yields null value/description and no route or pool", function () {
            const d = svc._buildMetricAlertDetails({}, "weird", {}, {});
            expect(d).toEqual({
                value: null, description: null, uptime: null,
                email: { smtpCause: null, recipientCount: 0, attempt: 1 },
            });
        });

        it("a route alert whose route is absent from the snapshot gets no snapshot slice", function () {
            const d = svc._buildMetricAlertDetails({ route: "/a", value: 3 }, "/a", { red: {} }, {});
            expect(d.route).toBe("/a");
            expect(d.value).toBe(3);
            expect(d.snapshot).toBeUndefined();
        });

        it("a route alert with RED data carries p99/count/window (window defaults to null)", function () {
            const d = svc._buildMetricAlertDetails({ route: "/a" }, "/a", { red: { "/a": { p99: 900, count: 12 } } }, {});
            expect(d.snapshot).toEqual({ p99: 900, count: 12, window: null });
        });

        it("a pool alert carries connection counters", function () {
            const dep = { connectionsInUse: 4, connectionsOpen: 5, queueLength: 2 };
            const d = svc._buildMetricAlertDetails({ pool: "appDb" }, "appDb", { dependencies: { oracle: { appDb: dep } } }, {});
            expect(d.pool).toBe("appDb");
            expect(d.snapshot).toEqual(dep);
        });

        it("a global alert carries rounded heap numbers (0 when memory is missing)", function () {
            const d = svc._buildMetricAlertDetails({}, "global", { system: {} }, {});
            expect(d.snapshot).toEqual({ heapUsedMb: 0, heapLimitMb: 0, eventLoopLagMs: null, gcOverheadPct: null });
        });

        it("red-metrics kv with no routes reports n/a and a zero error rate", function () {
            expect(svc._buildChannelKv("server-red-metrics-notification", {})).toEqual({
                requestsTotal: 0, errorRatePct: "0.00%", topRoute: "n/a", topRouteP95: "n/a",
            });
        });

        it("red-metrics kv picks the slowest route by p95", function () {
            const kv = svc._buildChannelKv("server-red-metrics-notification", {
                totals: { requestsTotal: 10, errorRate: 0.1 },
                red: { "/fast": { p95: 10 }, "/slow": { p95: 500 } },
            });
            expect(kv).toMatchObject({ topRoute: "/slow", topRouteP95: "500ms", errorRatePct: "10.00%" });
        });

        it("an unknown channel yields an empty kv", function () {
            expect(svc._buildChannelKv("nope", {})).toEqual({});
        });
    });

    // ── critical path ────────────────────────────────────────────────────────
    describe("critical digest", function () {
        it("_flushCriticalDigest on an empty buffer does nothing", async function () {
            const send = vi.spyOn(ServerNotificationService, "sendChannelDigest");
            await svc._flushCriticalDigest();
            expect(send).not.toHaveBeenCalled();
        });

        it("_dispatchCriticalDigest with no events falls back to 'now' for firstEventAt and counts overflow", async function () {
            const send = vi.spyOn(ServerNotificationService, "sendChannelDigest").mockResolvedValue({ sent: true });
            vi.spyOn(svc, "_writeAlertLogRows").mockResolvedValue();
            await svc._dispatchCriticalDigest([], "", 3);
            const [, payload] = send.mock.calls[0];
            expect(payload.kv.eventCount).toBe(3);
            expect(payload.kv.firstEventAt).toMatch(/ UTC[+-]\d{2}:\d{2}$/);
            expect(payload.summary).toContain("3 crit/alert/emerg");
        });

        it("persist:false skips alert-log rows and logs that it did", async function () {
            vi.spyOn(ServerNotificationService, "sendChannelDigest").mockResolvedValue({ sent: true });
            const write = vi.spyOn(svc, "_writeAlertLogRows").mockResolvedValue();
            const ev = { level: "CRITICAL", message: "m", meta: {}, requestId: null, timestamp: "2026-01-01T00:00:00Z" };
            await svc._dispatchCriticalDigest([ev], "", 0, { persist: false });
            expect(write).not.toHaveBeenCalled();
            expect(logger.warning).toHaveBeenCalled();
        });

        it("persist:true writes one FIRED row per event with the callsite when function+file are present", async function () {
            vi.spyOn(ServerNotificationService, "sendChannelDigest").mockResolvedValue({ sent: false, reason: "smtp", cause: "bad" });
            const write = vi.spyOn(svc, "_writeAlertLogRows").mockResolvedValue();
            const ev = { level: "ALERT", message: "m", meta: { function: "f", file: "a.js", line: 4 }, requestId: "r1", timestamp: "2026-01-01T00:00:00Z" };
            await svc._dispatchCriticalDigest([ev], "", 0);
            const row = write.mock.calls[0][0][0];
            expect(row).toMatchObject({ transition: "FIRED", emailStatus: "FAILED", emailError: "bad", rule: "ALERT" });
            expect(row.details.callsite).toBe("f @ a.js:4");
            expect(row.details.requestId).toBe("r1");
        });

        it("_buildCriticalLogDetails without a meta/line gives callsite null and '?' line when only line is missing", function () {
            expect(svc._buildCriticalLogDetails({ level: "ALERT", message: "m" }, {}).callsite).toBeNull();
            expect(svc._buildCriticalLogDetails({ level: "ALERT", message: "m", meta: { function: "f", file: "a.js" } }, {}).callsite).toBe("f @ a.js:?");
        });

        it("over the hourly ceiling with persist:false logs the skipped row instead of writing it", async function () {
            process.env.CRITICAL_MAX_EMAILS_PER_HOUR = "1";
            try {
                const send = vi.spyOn(ServerNotificationService, "sendChannelDigest").mockResolvedValue({ sent: true });
                const write = vi.spyOn(svc, "_writeAlertLogRows").mockResolvedValue();
                svc._criticalSentTimestamps = [Date.now()];
                svc._criticalBuffer = [{ level: "CRITICAL", message: "m", meta: {}, requestId: null, timestamp: "2026-01-01T00:00:00Z" }];
                await svc._flushCriticalDigest({ persist: false });
                expect(send).not.toHaveBeenCalled();
                expect(write).not.toHaveBeenCalled();
                expect(svc._criticalSuppressedSinceLastSend).toBe(1);
            } finally {
                delete process.env.CRITICAL_MAX_EMAILS_PER_HOUR;
            }
        });

        it("notifyCriticalNow / notifyLifecycleNow return disabled when notifications are off", async function () {
            vi.spyOn(ServerNotificationService, "isEnabled").mockReturnValue(false);
            await expect(svc.notifyCriticalNow({ message: "x" })).resolves.toEqual({ sent: false, reason: "disabled" });
            await expect(svc.notifyLifecycleNow({})).resolves.toEqual({ sent: false, reason: "disabled" });
        });

        it("notifyLifecycleNow converts a send rejection into reason 'error'", async function () {
            vi.spyOn(ServerNotificationService, "isEnabled").mockReturnValue(true);
            vi.spyOn(ServerNotificationService, "sendChannelDigest").mockRejectedValue("smtp-fatal");
            await expect(
                svc.notifyLifecycleNow({ severity: "CRITICAL", headline: "h", summary: "s" }),
            ).resolves.toEqual({ sent: false, reason: "error", cause: "smtp-fatal" });
        });
    });

    // ── alert-log persistence ────────────────────────────────────────────────
    describe("alert-log queue", function () {
        it("overflow past 500 rows drops the oldest and warns once with the count", async function () {
            vi.spyOn(svc, "_flushAlertLogQueue").mockResolvedValue();
            const rows = Array.from({ length: 502 }, (_, n) => ({ alertKey: `k${n}`, details: null }));
            await svc._writeAlertLogRows(rows);
            expect(svc._alertLogQueue).toHaveLength(500);
            expect(svc._alertLogQueue[0].alertKey).toBe("k2");
            expect(logger.warning).toHaveBeenCalledWith(expect.stringContaining("2"), { _noNotify: true });
        });

        it("overflow while a flush is in flight keeps the head row (drops index 1)", async function () {
            vi.spyOn(svc, "_flushAlertLogQueue").mockResolvedValue();
            svc._alertLogFlushing = Promise.resolve();
            svc._alertLogQueue = Array.from({ length: 500 }, (_, n) => ({ alertKey: `q${n}` }));
            await svc._writeAlertLogRows([{ alertKey: "new", details: null }]);
            expect(svc._alertLogQueue[0].alertKey).toBe("q0");
            expect(svc._alertLogQueue[1].alertKey).toBe("q2");
            expect(svc._alertLogQueue.at(-1).alertKey).toBe("new");
        });

        it("concurrent flushes share one in-flight promise and insert each row once", async function () {
            svc._alertLogQueue = [{ alertKey: "a" }, { alertKey: "b" }];
            const p1 = svc._flushAlertLogQueue();
            const p2 = svc._flushAlertLogQueue();
            await Promise.all([p1, p2]);
            expect(ServerAlertLogModel.insertOne).toHaveBeenCalledTimes(2);
            expect(svc._alertLogQueue).toEqual([]);
        });

        it("a failing insert stops the flush and leaves the rows queued in order", async function () {
            ServerAlertLogModel.insertOne.mockRejectedValueOnce("db-down");
            svc._alertLogQueue = [{ alertKey: "a" }, { alertKey: "b" }];
            await svc._flushAlertLogQueue();
            expect(svc._alertLogQueue.map((r) => r.alertKey)).toEqual(["a", "b"]);
            expect(logger.warning).toHaveBeenCalledWith(expect.stringContaining("db-down"), { _noNotify: true });
        });

        it("_sanitizeDetails: null passes through; secrets in arrays are redacted; long stacks are cut", function () {
            expect(svc._sanitizeDetails(null)).toBeNull();
            const out = svc._sanitizeDetails({
                list: [{ password: "p", ok: 1 }, 5],
                stack: "s".repeat(2500),
                Authorization: "Bearer x",
            });
            expect(out.list).toEqual([{ password: "[REDACTED]", ok: 1 }, 5]);
            expect(out.Authorization).toBe("[REDACTED]");
            expect(out.stack).toHaveLength(2001);
            expect(out.stack.endsWith("…")).toBe(true);
        });

        it("_sanitizeDetails: a payload over 64KB becomes a truncated envelope", function () {
            const out = svc._sanitizeDetails({ blob: "x".repeat(70 * 1024) });
            expect(out.truncated).toBe(true);
            expect(out.preview.length).toBe(64 * 1024 - 200);
        });

        it("_runRetentionPurge logs only when rows were deleted and honours ALERT_LOG_RETENTION_DAYS", async function () {
            const purge = vi.spyOn(ServerAlertLogModel, "purgeOlderThan").mockResolvedValueOnce(0).mockResolvedValueOnce(4);
            await svc._runRetentionPurge();
            expect(purge).toHaveBeenLastCalledWith(180);
            expect(logger.notice).not.toHaveBeenCalled();

            process.env.ALERT_LOG_RETENTION_DAYS = "30";
            try {
                await svc._runRetentionPurge();
            } finally {
                delete process.env.ALERT_LOG_RETENTION_DAYS;
            }
            expect(purge).toHaveBeenLastCalledWith(30);
            expect(logger.notice).toHaveBeenCalledWith(expect.stringContaining("purged 4"), { _noNotify: true });
        });
    });

    // ── acknowledgement ──────────────────────────────────────────────────────
    describe("acknowledgement", function () {
        it.each([undefined, null, "", 42, {}])("acknowledge(%j) rejects 400 ALERT_KEY_REQUIRED", async function (key) {
            const err = await rejection(svc.acknowledge(key, 1));
            expect(err).toBeInstanceOf(AppError);
            expect(err.statusCode).toBe(400);
            expect(err.message).toBe(NOTIFICATION_ERRORS.ALERT_KEY_REQUIRED);
        });

        it.each([undefined, "", 7])("unacknowledge(%j) rejects 400 ALERT_KEY_REQUIRED", async function (key) {
            const err = await rejection(svc.unacknowledge(key));
            expect(err.statusCode).toBe(400);
            expect(err.message).toBe(NOTIFICATION_ERRORS.ALERT_KEY_REQUIRED);
        });

        it("the leader-side bodies re-validate the key (IPC input is not trusted)", async function () {
            expect((await rejection(svc._acknowledgeLocal("", 1))).statusCode).toBe(400);
            expect((await rejection(svc._unacknowledgeLocal(null))).statusCode).toBe(400);
        });

        it("unknown key -> 404 ALERT_NOT_FOUND; OK-state key -> 400 ALERT_NOT_ACTIVE; no write happens", async function () {
            const upsert = vi.spyOn(ServerAlertAckModel, "upsert").mockResolvedValue();
            const e1 = await rejection(svc.acknowledge("HIGH_HEAP::global", 1));
            expect(e1.statusCode).toBe(404);
            expect(e1.message).toBe(NOTIFICATION_ERRORS.ALERT_NOT_FOUND);

            svc._alertStates.set("HIGH_HEAP::global", { status: "OK" });
            const e2 = await rejection(svc.acknowledge("HIGH_HEAP::global", 1));
            expect(e2.statusCode).toBe(400);
            expect(e2.message).toBe(NOTIFICATION_ERRORS.ALERT_NOT_ACTIVE);
            expect(upsert).not.toHaveBeenCalled();
        });

        it("a persist failure is a 502 and nothing is cached in memory", async function () {
            vi.spyOn(ServerAlertAckModel, "upsert").mockRejectedValue("ora-down");
            svc._alertStates.set("HIGH_HEAP::global", { status: "CRITICAL" });
            const err = await rejection(svc.acknowledge("HIGH_HEAP::global", 1));
            expect(err.statusCode).toBe(502);
            expect(err.message).toBe(NOTIFICATION_ERRORS.ACK_WRITE_FAILED);
            expect(svc._acks.has("HIGH_HEAP::global")).toBe(false);
        });

        it("success stores severityAtAck from live state, caps the note at 500 chars and uses the TTL", async function () {
            const upsert = vi.spyOn(ServerAlertAckModel, "upsert").mockResolvedValue();
            svc._alertStates.set("HIGH_HEAP::global", { status: "WARNING" });
            const res = await svc.acknowledge("HIGH_HEAP::global", "17", "n".repeat(600));
            expect(res).toMatchObject({ alertKey: "HIGH_HEAP::global", acknowledged: true, ackedBy: 17, severityAtAck: "WARNING" });
            expect(res.note).toHaveLength(500);
            expect(Date.parse(res.ackExpiresAt) - Date.parse(res.ackedAt)).toBe(24 * 3_600_000);
            expect(upsert.mock.calls[0][0]).toMatchObject({ ackedBy: 17, severityAtAck: "WARNING" });
            const res2 = await svc.acknowledge("HIGH_HEAP::global", 17, "");
            expect(res2.note).toBeNull();
        });

        it("unacknowledge: unknown ack -> 404; remove failure -> 502 and ack kept; success removes it", async function () {
            expect((await rejection(svc.unacknowledge("k::g"))).message).toBe(NOTIFICATION_ERRORS.ACK_NOT_FOUND);

            svc._acks.set("k::g", { ackedBy: 1, ackedAt: 1, expiresAt: 2, severityAtAck: "WARNING", note: null });
            const rm = vi.spyOn(ServerAlertAckModel, "remove").mockRejectedValueOnce("ora-down").mockResolvedValue();
            const err = await rejection(svc.unacknowledge("k::g"));
            expect(err.statusCode).toBe(502);
            expect(svc._acks.has("k::g")).toBe(true);

            await expect(svc.unacknowledge("k::g")).resolves.toEqual({ alertKey: "k::g", acknowledged: false });
            expect(svc._acks.has("k::g")).toBe(false);
            expect(rm).toHaveBeenLastCalledWith("k::g");
        });

        it("an expired ack is cleared on the next check and does not suppress", function () {
            vi.spyOn(ServerAlertAckModel, "remove").mockResolvedValue();
            svc._acks.set("k::g", { ackedBy: 1, ackedAt: 1, expiresAt: Date.now() - 1, severityAtAck: "CRITICAL", note: null });
            expect(svc._checkAndUpdateAck("k::g", "WARNING")).toEqual({ suppress: false });
            expect(svc._acks.has("k::g")).toBe(false);
        });

        it("escalation past the ack baseline clears the ack; same level keeps suppressing", function () {
            vi.spyOn(ServerAlertAckModel, "remove").mockResolvedValue();
            svc._acks.set("k::g", { ackedBy: 1, ackedAt: 1, expiresAt: Date.now() + 1e6, severityAtAck: "WARNING", note: null });
            expect(svc._checkAndUpdateAck("k::g", "WARNING")).toEqual({ suppress: true });
            expect(svc._checkAndUpdateAck("k::g", "CRITICAL")).toEqual({ suppress: false });
            expect(svc._acks.has("k::g")).toBe(false);
            expect(svc._ackSeverityRank(undefined)).toBe(0);
        });

        it("_clearAck of an unknown key does not touch the DB; a failing delete only warns", async function () {
            const rm = vi.spyOn(ServerAlertAckModel, "remove").mockRejectedValue("gone");
            svc._clearAck("never::set");
            expect(rm).not.toHaveBeenCalled();
            svc._acks.set("k::g", { ackedBy: 1 });
            svc._clearAck("k::g");
            await flush();
            expect(logger.warning).toHaveBeenCalledWith(expect.stringContaining("gone"), { _noNotify: true });
        });

        it("_hydrateAcks loads live rows, drops lapsed ones (and deletes them), tolerates failure", async function () {
            const rm = vi.spyOn(ServerAlertAckModel, "remove").mockResolvedValue();
            vi.spyOn(ServerAlertAckModel, "findAll").mockResolvedValueOnce([
                { ALERT_KEY: "live::g", EXPIRES_AT: new Date(Date.now() + 1e6), ACKED_AT: new Date(), ACKED_BY: "5", SEVERITY_AT_ACK: "WARNING", NOTE: undefined },
                { ALERT_KEY: "old::g", EXPIRES_AT: new Date(Date.now() - 1e6), ACKED_AT: new Date(), ACKED_BY: 6, SEVERITY_AT_ACK: "WARNING" },
                { ALERT_KEY: "str::g", EXPIRES_AT: new Date(Date.now() + 1e6).toISOString(), ACKED_AT: new Date().toISOString(), ACKED_BY: 7, SEVERITY_AT_ACK: "CRITICAL", NOTE: "n" },
            ]);
            await svc._hydrateAcks();
            expect([...svc._acks.keys()].sort()).toEqual(["live::g", "str::g"]);
            expect(svc._acks.get("live::g")).toMatchObject({ ackedBy: 5, note: null });
            expect(svc._acks.get("str::g")).toMatchObject({ ackedBy: 7, note: "n" });
            expect(rm).toHaveBeenCalledWith("old::g");

            ServerAlertAckModel.findAll.mockRejectedValueOnce("ora-down");
            await expect(svc._hydrateAcks()).resolves.toBeUndefined();
            expect(logger.warning).toHaveBeenCalledWith(expect.stringContaining("ora-down"), { _noNotify: true });
        });
    });

    // ── decorate / status / history / test email ─────────────────────────────
    describe("decorateAlertsWithAckState", function () {
        it("returns the input untouched for empty / nullish alerts", async function () {
            const empty = [];
            await expect(svc.decorateAlertsWithAckState(empty)).resolves.toBe(empty);
            await expect(svc.decorateAlertsWithAckState(null)).resolves.toEqual([]);
        });

        it("un-acked alerts get null ack fields and no name lookup is made", async function () {
            const names = vi.spyOn(AdminModel, "getNamesByIds");
            const [a] = await svc.decorateAlertsWithAckState([{ rule: "R", route: "/x" }]);
            expect(a).toMatchObject({ alertKey: "R::/x", acknowledged: false, ackedBy: null, ackedByName: null, ackNote: null });
            expect(names).not.toHaveBeenCalled();
        });

        it("acked alerts are resolved with ONE batched name lookup; unknown names become null", async function () {
            const names = vi.spyOn(AdminModel, "getNamesByIds").mockResolvedValue(new Map([[5, "Ana"]]));
            const ack = (by) => ({ ackedBy: by, ackedAt: 1_700_000_000_000, expiresAt: 1_700_003_600_000, severityAtAck: "WARNING", note: undefined });
            const acks = new Map([["A::global", ack(5)], ["B::p1", ack(9)]]);
            const out = await svc.decorateAlertsWithAckState([{ rule: "A" }, { rule: "B", pool: "p1" }], acks);
            expect(names).toHaveBeenCalledTimes(1);
            expect(names).toHaveBeenCalledWith([5, 9]);
            expect(out[0]).toMatchObject({ acknowledged: true, ackedByName: "Ana", ackNote: null, ackedAt: "2023-11-14T22:13:20.000Z" });
            expect(out[1].ackedByName).toBeNull();
        });

        it("on a non-leader worker the ack list comes from the leader (non-array answer -> no acks)", async function () {
            vi.spyOn(AlertNotifierService, "_forwardsToLeader").mockReturnValue(true);
            const fwd = vi.spyOn(svc, "_forwardToLeader").mockResolvedValueOnce([
                { alertKey: "A::global", ackedBy: 5, ackedAt: 1, expiresAt: 2, severityAtAck: "WARNING", note: "x" },
            ]);
            vi.spyOn(AdminModel, "getNamesByIds").mockResolvedValue(new Map());
            const out = await svc.decorateAlertsWithAckState([{ rule: "A" }]);
            expect(fwd).toHaveBeenCalledTimes(1);
            expect(out[0]).toMatchObject({ acknowledged: true, ackNote: "x" });

            fwd.mockResolvedValueOnce({ not: "an array" });
            const out2 = await svc.decorateAlertsWithAckState([{ rule: "A" }]);
            expect(out2[0].acknowledged).toBe(false);
        });
    });

    describe("cluster forwarding from a non-leader worker", function () {
        beforeEach(function () {
            vi.spyOn(AlertNotifierService, "_forwardsToLeader").mockReturnValue(true);
        });

        it("acknowledge forwards stringified ackedBy and a capped note (null when empty)", async function () {
            const fwd = vi.spyOn(svc, "_forwardToLeader").mockResolvedValue({ ok: true });
            await svc.acknowledge("A::global", 12, "z".repeat(700));
            expect(fwd.mock.calls[0][1]).toMatchObject({ alertKey: "A::global", ackedBy: "12" });
            expect(fwd.mock.calls[0][1].note).toHaveLength(500);
            await svc.acknowledge("A::global", 12);
            expect(fwd.mock.calls[1][1].note).toBeNull();
        });

        it("unacknowledge and getStatus forward without touching local state", async function () {
            const fwd = vi.spyOn(svc, "_forwardToLeader").mockResolvedValue({ forwarded: true });
            const local = vi.spyOn(svc, "_unacknowledgeLocal");
            await expect(svc.unacknowledge("A::global")).resolves.toEqual({ forwarded: true });
            await expect(svc.getStatus()).resolves.toEqual({ forwarded: true });
            expect(local).not.toHaveBeenCalled();
            expect(fwd).toHaveBeenCalledTimes(2);
        });

        it("_forwardToLeader maps a transport failure to an AppError", async function () {
            const { clusterRpc } = require("../../../../src/utils/cluster/ClusterRpcClient");
            vi.spyOn(clusterRpc, "call").mockRejectedValue(new Error("no leader"));
            const err = await rejection(svc._forwardToLeader("alerts.status", {}));
            expect(err).toBeInstanceOf(AppError);
            expect(err.statusCode).toBe(503);
        });
    });

    describe("getStatus / history / test email", function () {
        it("_getStatusLocal masks recipients, lists only non-OK alerts and falls back to the ring buffer when the log read fails", async function () {
            vi.spyOn(ServerNotificationService, "resolveRecipients").mockResolvedValue(["alice@corp.com"]);
            vi.spyOn(ServerAlertLogModel, "findRecent").mockRejectedValue("ora-down");
            vi.spyOn(ServerNotificationService, "getRecentSends").mockReturnValue([{ headline: "ring" }]);
            svc._alertStates.set("A::global", { status: "CRITICAL", rule: "A", scope: "global", channel: "c", lastNotifiedAt: 0 });
            svc._alertStates.set("B::global", { status: "OK", rule: "B", scope: "global", channel: "c", lastNotifiedAt: null });
            svc._alertStates.set("C::global", { status: "WARNING", rule: "C", scope: "global", channel: "c", lastNotifiedAt: 1_700_000_000_000 });

            const st = await svc.getStatus();
            expect(st.activeAlerts.map((a) => a.rule)).toEqual(["A", "C"]);
            expect(st.activeAlerts[0].lastNotifiedAt).toBeNull();
            expect(st.activeAlerts[1].lastNotifiedAt).toBe("2023-11-14T22:13:20.000Z");
            expect(st.recentSends).toEqual([{ headline: "ring" }]);
            for (const ch of ServerNotificationService.CHANNELS) {
                expect(st.recipients[ch]).toEqual([ServerNotificationService.maskEmail("alice@corp.com")]);
                expect(st.recipients[ch][0]).not.toContain("alice@");
            }
        });

        it("_getRecentSends maps DB rows (string dates pass through, missing fields default)", async function () {
            vi.spyOn(ServerAlertLogModel, "findRecent").mockResolvedValue([
                { CHANNEL: "c", NOTIFICATION_ID: "n", EMAIL_STATUS: "SENT", DESCRIPTION: "d", EMAIL_ERROR: "e", CREATED_AT: new Date(0) },
                { CHANNEL: "c2", EMAIL_STATUS: "FAILED", CREATED_AT: "2026-01-01" },
            ]);
            const out = await svc._getRecentSends();
            expect(out[0]).toEqual({ channel: "c", notificationId: "n", sent: true, headline: "d", reason: "e", at: "1970-01-01T00:00:00.000Z" });
            expect(out[1]).toEqual({ channel: "c2", notificationId: null, sent: false, headline: "", reason: null, at: "2026-01-01" });
        });

        it("getAlertHistory passes filters and paging straight to the model", async function () {
            const page = vi.spyOn(ServerAlertLogModel, "findPage").mockResolvedValue({ rows: [], total: 0, page: 2, limit: 5 });
            await svc.getAlertHistory({ rule: "R" }, { page: 2, limit: 5 });
            expect(page).toHaveBeenCalledWith({ rule: "R" }, { page: 2, limit: 5 });
        });

        it("sendTestNotification rejects an unknown channel with 400 and sends nothing", async function () {
            const send = vi.spyOn(ServerNotificationService, "sendChannelDigest");
            const err = await rejection(svc.sendTestNotification("nope", {}));
            expect(err.statusCode).toBe(400);
            expect(err.message).toBe(NOTIFICATION_ERRORS.CHANNEL_UNKNOWN);
            expect(send).not.toHaveBeenCalled();
        });

        it("a failed test send is a 502 carrying the reason as hint", async function () {
            vi.spyOn(ServerNotificationService, "sendChannelDigest").mockResolvedValue({ sent: false, reason: "no-recipients" });
            const err = await rejection(svc.sendTestNotification("server-critical-notification", { userId: "u1" }));
            expect(err.statusCode).toBe(502);
            expect(err.message).toBe(NOTIFICATION_ERRORS.TEST_SEND_FAILED);
        });

        it.each([
            ["server-critical-notification", { userId: "u1" }, "u1", "level"],
            ["server-dependencies-notification", { username: "s1" }, "s1", "rule"],
            ["server-red-metrics-notification", undefined, "an admin", "rule"],
            ["server-system-notification", {}, "an admin", "rule"],
        ])("test email on %s names the requester and uses the right row/kv shape", async function (channel, user, who, rowKey) {
            const send = vi.spyOn(ServerNotificationService, "sendChannelDigest").mockResolvedValue({ sent: true, notificationId: "t" });
            await expect(svc.sendTestNotification(channel, user)).resolves.toMatchObject({ sent: true });
            const [ch, payload] = send.mock.calls[0];
            expect(ch).toBe(channel);
            expect(payload.summary).toContain(who);
            expect(payload.rows[0]).toHaveProperty(rowKey);
            expect(Object.keys(payload.kv).length).toBeGreaterThan(0);
        });

        it("_buildTestKv returns {} for an unknown channel", function () {
            expect(svc._buildTestKv("zzz")).toEqual({});
        });
    });

    // ── relayed critical ─────────────────────────────────────────────────────
    describe("ingestRelayedCritical", function () {
        it("is ignored when not running or when the record is not an object", function () {
            expect(svc.ingestRelayedCritical({ message: "m" })).toBe(false);
            svc._running = true;
            expect(svc.ingestRelayedCritical(null)).toBe(false);
            expect(svc.ingestRelayedCritical("str")).toBe(false);
            expect(svc._criticalBuffer).toHaveLength(0);
        });

        it("normalises level, timestamp, requestId and meta; stamps relayedFromPid only for a numeric pid", function () {
            svc._running = true;
            vi.spyOn(svc, "_onCriticalLog").mockImplementation(() => {});
            expect(svc.ingestRelayedCritical({ level: "EMERGENCY", message: "m", meta: { a: 1 }, pid: 77, requestId: "r", timestamp: "2026-01-01T00:00:00.000Z" })).toBe(true);
            expect(svc._onCriticalLog.mock.calls[0][0]).toEqual({
                level: "EMERGENCY", message: "m", meta: { a: 1, relayedFromPid: 77 }, requestId: "r", timestamp: "2026-01-01T00:00:00.000Z",
            });

            svc.ingestRelayedCritical({ level: "DEBUG", message: "m", meta: "bad", pid: "77", requestId: 5, timestamp: "garbage" });
            const rec = svc._onCriticalLog.mock.calls[1][0];
            expect(rec.level).toBe("CRITICAL");
            expect(rec.meta).toEqual({});
            expect(rec.requestId).toBeNull();
            expect(Number.isNaN(Date.parse(rec.timestamp))).toBe(false);
        });
    });
});
