import { AlertNotifierService } from "../../../../src/services/AlertNotifierService";
import ServerNotificationService from "../../../../src/services/email/ServerNotificationService";
import ServerAlertLogModel from "../../../../src/models/serverAlertLog.model";
import { metricsStore } from "../../../../src/middleware/metrics";
import { logger } from "../../../../src/utils/logger";

describe("AlertNotifierService wave2", () => {
    let svc: any;
    beforeEach(() => {
        vi.useFakeTimers();
        svc = new AlertNotifierService();
        for (const m of ["warning", "notice", "info", "debug", "critical", "error"] as const) vi.spyOn(logger, m).mockImplementation((() => undefined) as never);
        vi.spyOn(ServerAlertLogModel, "insertOne").mockResolvedValue(undefined as never);
        vi.spyOn(ServerNotificationService, "isEnabled").mockReturnValue(true);
    });
    afterEach(() => {
        svc.stop();
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });
    const rec = (message = "m", meta: Record<string, unknown> = {}) => ({ level: "CRITICAL", message, meta, requestId: null, timestamp: new Date().toISOString() });

    it("mapRuleToChannel maps known rules and falls back (with a warning) for unknown ones", () => {
        expect(AlertNotifierService.mapRuleToChannel("HIGH_HEAP")).toBe("server-system-notification");
        expect(AlertNotifierService.mapRuleToChannel("ORACLE_POOL_DOWN")).toBe("server-critical-notification");
        expect(AlertNotifierService.mapRuleToChannel("BRAND_NEW_RULE")).toBe("server-system-notification");
        expect(logger.warning).toHaveBeenCalled();
    });

    it("_emailStatusFor and _severityRank classify results and severities", () => {
        expect(svc._emailStatusFor({ sent: true })).toBe("SENT");
        expect(svc._emailStatusFor({ sent: false, reason: "disabled" })).toBe("DISABLED");
        expect(svc._emailStatusFor({ sent: false, reason: "send-error" })).toBe("FAILED");
        expect([svc._severityRank("critical"), svc._severityRank("warning"), svc._severityRank("x")]).toEqual([2, 1, 0]);
    });

    it("headline builders summarise single and multiple events, picking the most severe", () => {
        expect(svc._buildActiveHeadline([{ alert: { description: "pool down", rule: "R" } }])).toBe("pool down");
        expect(svc._buildActiveHeadline([{ alert: { rule: "R" } }])).toBe("R");
        expect(svc._buildActiveHeadline([{ alert: {} }])).toBe("");
        expect(svc._buildActiveHeadline([{ alert: { rule: "A", severity: "warning" } }, { alert: { rule: "B", severity: "critical" } }])).toBe("2 alerts active — most severe: B (CRITICAL)");
        expect(svc._buildRecoveryHeadline([{ state: { rule: "R" } }])).toBe("R back to normal");
        expect(svc._buildRecoveryHeadline([{}, {}])).toBe("2 alert(s) recovered");
    });

    it("_buildMetricAlertDetails attaches a pool, route or global snapshot slice plus email info", () => {
        const snapshot: any = {
            uptime: 5,
            dependencies: { oracle: { app: { connectionsInUse: 1, connectionsOpen: 2, queueLength: 3 } } },
            red: { "GET /x": { p99: 9, count: 4, window: { p99: 1 } }, "GET /y": { p99: 1, count: 1 } },
            system: { memory: { heapUsed: 2 * 1024 * 1024, heapSizeLimit: 4 * 1024 * 1024 }, eventLoopLag: 7, gc: { overheadPct: 1.5 } },
        };
        const pool = svc._buildMetricAlertDetails({ pool: "app", value: 3, description: "d" }, "app", snapshot, { sent: false, cause: "smtp down", recipientCount: 2 });
        expect(pool).toMatchObject({ value: 3, pool: "app", uptime: 5, snapshot: { connectionsInUse: 1, connectionsOpen: 2, queueLength: 3 }, email: { smtpCause: "smtp down", recipientCount: 2, attempt: 1 } });
        expect(svc._buildMetricAlertDetails({ route: "GET /x" }, "GET /x", snapshot, { sent: true }).snapshot).toEqual({ p99: 9, count: 4, window: { p99: 1 } });
        expect(svc._buildMetricAlertDetails({ route: "GET /y" }, "GET /y", snapshot, { sent: true }).snapshot.window).toBeNull();
        const global = svc._buildMetricAlertDetails({ value: "n/a" }, "global", snapshot, { sent: true });
        expect(global).toMatchObject({ value: null, description: null, snapshot: { heapUsedMb: 2, heapLimitMb: 4, eventLoopLagMs: 7, gcOverheadPct: 1.5 }, email: { smtpCause: null, recipientCount: 0 } });
        const bare = svc._buildMetricAlertDetails({ pool: "gone" }, "gone", undefined, { sent: true });
        expect(bare.uptime).toBeNull();
        expect(bare.snapshot).toBeUndefined();
    });

    it("_buildChannelKv fills channel-specific placeholders with sane fallbacks", () => {
        const crit = svc._buildChannelKv("server-critical-notification", {}, 3);
        expect(crit).toMatchObject({ eventCount: 3, windowLabel: expect.stringContaining("s metrics poll") });

        expect(svc._buildChannelKv("server-dependencies-notification", undefined)).toEqual({ poolCount: 0, alertingPoolCount: 0, maxUtilization: "n/a" });
        expect(svc._buildChannelKv("server-dependencies-notification", { dependencies: { oracle: { a: { poolUtilization: 0.9 }, b: { poolUtilization: 0.1 }, c: {} } } })).toEqual({ poolCount: 3, alertingPoolCount: 1, maxUtilization: "90%" });

        expect(svc._buildChannelKv("server-red-metrics-notification", undefined)).toEqual({ requestsTotal: 0, errorRatePct: "0.00%", topRoute: "n/a", topRouteP95: "n/a" });
        const red = svc._buildChannelKv("server-red-metrics-notification", {
            totals: { requestsTotal: 10, window: { errorRate: 0.05, windowMs: 300_000 } },
            red: { "GET /a": { p95: 10 }, "GET /b": { p95: 40 }, "GET /c": { p95: 5 } },
        });
        expect(red).toEqual({ requestsTotal: 10, errorRatePct: "5.00% (last 5 min)", topRoute: "GET /b", topRouteP95: "40ms" });
        expect(svc._buildChannelKv("server-red-metrics-notification", { totals: { errorRate: 0.5 } }).errorRatePct).toBe("50.00%");

        expect(svc._buildChannelKv("server-system-notification", undefined)).toEqual({ heapUsedMb: 0, heapLimitMb: 0, heapPct: "n/a", eventLoopLagMs: 0, gcOverheadPct: "0%" });
        expect(svc._buildChannelKv("server-system-notification", { system: { memory: { heapUsed: 512 * 1048576, heapSizeLimit: 1024 * 1048576 }, eventLoopLag: 3, gc: { overheadPct: 2 } } })).toEqual({ heapUsedMb: 512, heapLimitMb: 1024, heapPct: "50.0%", eventLoopLagMs: 3, gcOverheadPct: "2%" });
        expect(svc._buildChannelKv("unknown", {})).toEqual({});
    });

    it("_acksSnapshot serialises the ack map into JSON-safe rows", () => {
        svc._acks.set("R::g", { ackedBy: 1, ackedAt: 2, expiresAt: 3, severityAtAck: "WARNING", note: null });
        expect(svc._acksSnapshot()).toEqual([{ alertKey: "R::g", ackedBy: 1, ackedAt: 2, expiresAt: 3, severityAtAck: "WARNING", note: null }]);
    });

    it("ingestRelayedCritical rejects when stopped/invalid and normalises relayed records when running", () => {
        expect(svc.ingestRelayedCritical({ message: "x" })).toBe(false);
        svc._running = true;
        expect(svc.ingestRelayedCritical(null as never)).toBe(false);
        expect(svc.ingestRelayedCritical("s" as never)).toBe(false);
        expect(svc.ingestRelayedCritical({ level: "BOGUS", message: "m", meta: { a: 1 }, pid: 77, timestamp: "garbage", requestId: 5 as never })).toBe(true);
        expect(svc.ingestRelayedCritical({ level: "ALERT", message: "m2", timestamp: "2026-01-01T00:00:00.000Z", requestId: "rid", pid: Number.NaN })).toBe(true);
        const [a, b] = svc._criticalBuffer;
        expect(a).toMatchObject({ level: "CRITICAL", meta: { a: 1, relayedFromPid: 77 }, requestId: null });
        expect(new Date(a.timestamp).getTime()).not.toBeNaN();
        expect(b).toMatchObject({ level: "ALERT", requestId: "rid", timestamp: "2026-01-01T00:00:00.000Z" });
        expect(b.meta).toEqual({});
    });

    it("critical buffer overflow is counted, warns once, and the digest window timer fires the flush", async () => {
        const flush = vi.spyOn(svc, "_flushCriticalDigest").mockResolvedValue(undefined as never);
        for (let i = 0; i < 400; i++) svc._onCriticalLog(rec(`m${i}`));
        expect(svc._criticalOverflowInWindow).toBeGreaterThanOrEqual(1);
        const warnings = (logger.warning as any).mock.calls.length;
        svc._onCriticalLog(rec());
        expect((logger.warning as any).mock.calls.length).toBe(warnings);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(flush).toHaveBeenCalledTimes(1);
        expect(svc._criticalWindowTimer).toBeNull();
    });

    it("chaos: a rejected digest flush from the window timer is logged as a warning, never thrown", async () => {
        vi.spyOn(svc, "_flushCriticalDigest").mockRejectedValue(new Error("smtp down"));
        svc._onCriticalLog(rec());
        await vi.advanceTimersByTimeAsync(30_000);
        expect((logger.warning as any).mock.calls.flat().join(" ")).toContain("smtp down");
    });

    it("storm ceiling: at the hourly cap the window is suppressed, recorded, one audit row written, deliveries settled false", async () => {
        vi.stubEnv("CRITICAL_MAX_EMAILS_PER_HOUR", "1");
        const suppressed = vi.spyOn(metricsStore, "recordNotificationSuppressed").mockImplementation(() => undefined as never);
        const send = vi.spyOn(ServerNotificationService, "sendChannelDigest").mockResolvedValue({ sent: true, notificationId: "n" } as never);
        const write = vi.spyOn(svc, "_writeAlertLogRows").mockResolvedValue(undefined);
        svc._criticalSentTimestamps = [Date.now()];
        svc._criticalBuffer = [rec("a"), rec("b")];
        svc._criticalOverflowInWindow = 3;
        await svc._flushCriticalDigest();
        expect(send).not.toHaveBeenCalled();
        expect(suppressed).toHaveBeenCalledWith("server-critical-notification", 5);
        expect((write.mock.calls[0] as any[][])[0][0]).toMatchObject({ transition: "SUPPRESSED", emailStatus: "SKIPPED", valueNum: 5 });
        expect(svc._criticalBuffer).toEqual([]);
        // after pools close no row is persisted
        svc._criticalBuffer = [rec("c")];
        await svc._flushCriticalDigest({ persist: false });
        expect(write).toHaveBeenCalledTimes(1);
        // empty buffer is a no-op
        await svc._flushCriticalDigest();
    });

    it("shutdown rows: saves one SKIPPED row per unsaved buffered critical once, and delegates to the ceiling path when capped", async () => {
        const write = vi.spyOn(svc, "_writeAlertLogRows").mockResolvedValue(undefined);
        const a = rec("a");
        const b = { ...rec("b"), rowSaved: true };
        svc._criticalBuffer = [a, b];
        await svc._saveBufferedCriticalRowsForShutdown();
        expect(write).toHaveBeenCalledTimes(1);
        expect((write.mock.calls[0] as any[][])[0]).toHaveLength(1);
        expect((write.mock.calls[0] as any[][])[0][0]).toMatchObject({ transition: "FIRED", emailStatus: "SKIPPED", description: "a" });
        expect((a as any).rowSaved).toBe(true);
        await svc._saveBufferedCriticalRowsForShutdown();
        expect(write).toHaveBeenCalledTimes(1);

        vi.stubEnv("CRITICAL_MAX_EMAILS_PER_HOUR", "1");
        svc._criticalSentTimestamps = [Date.now()];
        const flush = vi.spyOn(svc, "_flushCriticalDigest").mockResolvedValue(undefined as never);
        await svc._saveBufferedCriticalRowsForShutdown();
        expect(flush).toHaveBeenCalledTimes(1);
    });

    it("whenDelivered: true when disabled, false when not running, replaces a previous waiter, and times out to false", async () => {
        (ServerNotificationService.isEnabled as any).mockReturnValue(false);
        await expect(svc.whenDelivered("t")).resolves.toBe(true);
        (ServerNotificationService.isEnabled as any).mockReturnValue(true);
        await expect(svc.whenDelivered("t")).resolves.toBe(false);
        await expect(svc.whenDelivered("")).resolves.toBe(false);
        svc._running = true;
        svc._unsubscribeTap = () => undefined;
        const first = svc.whenDelivered("tok", { timeoutMs: 1000 });
        const second = svc.whenDelivered("tok", { timeoutMs: 1000 });
        await expect(first).resolves.toBe(false);
        await vi.advanceTimersByTimeAsync(1000);
        await expect(second).resolves.toBe(false);
    });

    it("start() arms the poll interval whose tick failure is logged, and stop() discards buffered criticals with a warning", async () => {
        vi.spyOn(logger, "onLevel").mockReturnValue(() => undefined);
        vi.spyOn(svc, "_hydrateAcksShared").mockResolvedValue(undefined as never);
        vi.spyOn(svc, "_pollTick").mockRejectedValue(new Error("tick exploded"));
        expect(svc.start()).toEqual({ started: true });
        await vi.advanceTimersByTimeAsync(svc._pollIntervalMs());
        expect((logger.warning as any).mock.calls.flat().join(" ")).toContain("tick exploded");
        svc._criticalBuffer = [rec()];
        svc._criticalOverflowInWindow = 2;
        svc.stop();
        expect((logger.warning as any).mock.calls.flat().join(" ")).toContain("3");
        expect(svc._pollTimer).toBeNull();
        expect(svc._running).toBe(false);
    });

    it("start() reports disabled and does not arm timers when notifications are off", () => {
        (ServerNotificationService.isEnabled as any).mockReturnValue(false);
        expect(svc.start()).toEqual({ started: false, reason: "disabled" });
        expect(vi.getTimerCount()).toBe(0);
    });

    it("_raceBudget reports done, timeout (clamped budget) and error", async () => {
        await expect(svc._raceBudget(Promise.resolve(1), 1000)).resolves.toBe("done");
        await expect(svc._raceBudget(Promise.reject(new Error("x")), 1000)).resolves.toBe("error");
        const slow = svc._raceBudget(new Promise(() => undefined), 0);
        await vi.advanceTimersByTimeAsync(0);
        await expect(slow).resolves.toBe("timeout");
    });
});
