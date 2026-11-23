import { AlertNotifierService } from "../../../../src/services/AlertNotifierService";
import ServerNotificationService from "../../../../src/services/email/ServerNotificationService";
import ServerAlertLogModel from "../../../../src/models/serverAlertLog.model";
import { logger } from "../../../../src/utils/logger";

const MB = 1024 * 1024;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("AlertNotifierService digest and lifecycle helpers", () => {
    let svc: any;

    beforeEach(() => {
        svc = new AlertNotifierService();
        for (const m of ["warning", "notice", "info", "debug", "critical", "error"] as const) vi.spyOn(logger, m).mockImplementation((() => undefined) as any);
        vi.spyOn(ServerAlertLogModel, "insertOne").mockResolvedValue(undefined as never);
    });
    afterEach(() => {
        svc.stop();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    describe("_buildChannelKv", () => {
        it("critical channel: event count, poll window label and a first-event stamp", () => {
            const kv = svc._buildChannelKv("server-critical-notification", {}, 4);
            expect(kv.eventCount).toBe(4);
            expect(kv.windowLabel).toMatch(/^\d+s metrics poll$/);
            expect(String(kv.firstEventAt)).toContain("UTC");
        });

        it("dependencies channel: pool count, alerting pools (>80%) and the busiest utilisation", () => {
            const kv = svc._buildChannelKv("server-dependencies-notification", { dependencies: { oracle: { a: { poolUtilization: 0.9 }, b: { poolUtilization: 0.5 }, c: { poolUtilization: null } } } });
            expect(kv).toEqual({ poolCount: 3, alertingPoolCount: 1, maxUtilization: "90%" });
        });

        it("dependencies channel with no pools (or no snapshot) says n/a", () => {
            expect(svc._buildChannelKv("server-dependencies-notification", {})).toEqual({ poolCount: 0, alertingPoolCount: 0, maxUtilization: "n/a" });
            expect(svc._buildChannelKv("server-dependencies-notification", undefined)).toMatchObject({ poolCount: 0 });
        });

        it("red-metrics channel: busiest route by p95 and the 5-minute window error rate", () => {
            const kv = svc._buildChannelKv("server-red-metrics-notification", {
                totals: { requestsTotal: 500, window: { errorRate: 0.1234, windowMs: 300_000 } },
                red: { "GET /a": { p95: 10 }, "GET /b": { p95: 900 }, "GET /c": { p95: 20 } },
            });
            expect(kv).toEqual({ requestsTotal: 500, errorRatePct: "12.34% (last 5 min)", topRoute: "GET /b", topRouteP95: "900ms" });
        });

        it("red-metrics channel without a window falls back to the lifetime rate; without routes says n/a", () => {
            const kv = svc._buildChannelKv("server-red-metrics-notification", { totals: { errorRate: 0.5 }, red: {} });
            expect(kv).toEqual({ requestsTotal: 0, errorRatePct: "50.00%", topRoute: "n/a", topRouteP95: "n/a" });
            expect(svc._buildChannelKv("server-red-metrics-notification", undefined)).toMatchObject({ errorRatePct: "0.00%" });
        });

        it("system channel: heap in MB with percent of the limit, lag and GC overhead", () => {
            const kv = svc._buildChannelKv("server-system-notification", { system: { memory: { heapUsed: 50 * MB, heapSizeLimit: 200 * MB }, eventLoopLag: 12, gc: { overheadPct: 3 } } });
            expect(kv).toEqual({ heapUsedMb: 50, heapLimitMb: 200, heapPct: "25.0%", eventLoopLagMs: 12, gcOverheadPct: "3%" });
        });

        it("system channel with nothing reported degrades to zeros and n/a", () => {
            expect(svc._buildChannelKv("server-system-notification", undefined)).toEqual({ heapUsedMb: 0, heapLimitMb: 0, heapPct: "n/a", eventLoopLagMs: 0, gcOverheadPct: "0%" });
        });

        it("an unknown channel has no placeholders", () => {
            expect(svc._buildChannelKv("something-else", {})).toEqual({});
        });
    });

    describe("headlines", () => {
        it("one active alert uses its description, else its rule, else empty", () => {
            expect(svc._buildActiveHeadline([{ alert: { description: "Heap high", rule: "HIGH_HEAP" } }])).toBe("Heap high");
            expect(svc._buildActiveHeadline([{ alert: { rule: "HIGH_HEAP" } }])).toBe("HIGH_HEAP");
            expect(svc._buildActiveHeadline([{}])).toBe("");
        });

        it("several active alerts name the most severe one", () => {
            const h = svc._buildActiveHeadline([
                { alert: { rule: "A", severity: "warning" } },
                { alert: { rule: "B", severity: "critical" } },
                { alert: { rule: "C" } },
            ]);
            expect(h).toBe("3 alerts active — most severe: B (CRITICAL)");
        });

        it("a missing severity renders as empty text in the multi-alert headline", () => {
            const h = svc._buildActiveHeadline([{ alert: { rule: "A" } }, { alert: { rule: "B" } }]);
            expect(h).toBe("2 alerts active — most severe: A ()");
        });

        it("recovery headlines: one rule by name, several by count", () => {
            expect(svc._buildRecoveryHeadline([{ state: { rule: "HIGH_HEAP" } }])).toBe("HIGH_HEAP back to normal");
            expect(svc._buildRecoveryHeadline([{}, {}])).toBe("2 alert(s) recovered");
        });

        it("severity ranking", () => {
            expect([svc._severityRank("critical"), svc._severityRank("warning"), svc._severityRank("x"), svc._severityRank(undefined)]).toEqual([2, 1, 0, 0]);
        });
    });

    describe("formatting", () => {
        it("_formatEmailStamp returns an offset-labelled stamp, and the raw text for an invalid date", () => {
            expect(svc._formatEmailStamp("2026-03-01T10:00:00.000Z")).toMatch(/UTC[+-]\d\d:\d\d$/);
            expect(svc._formatEmailStamp("not a date")).toBe("not a date");
            expect(svc._formatEmailStamp(undefined as any)).toBe("");
        });

        it("_formatTimeOnly renders hh:mm:ss.mmm and survives an unconvertible value", () => {
            expect(svc._formatTimeOnly(new Date(2026, 0, 1, 9, 8, 7, 6))).toBe("09:08:07.006");
            expect(svc._formatTimeOnly(Symbol("x") as any)).toBe("00:00:00.000");
        });

        it("_truncate cuts with an ellipsis, leaves short text, and coerces null", () => {
            expect(svc._truncate("abcdef", 4)).toBe("abc…");
            expect(svc._truncate("abc", 4)).toBe("abc");
            expect(svc._truncate(null, 4)).toBe("");
        });
    });

    describe("whenDelivered", () => {
        it("resolves true at once when notifications are off", async () => {
            vi.spyOn(ServerNotificationService, "isEnabled").mockReturnValue(false);
            await expect(svc.whenDelivered("tok")).resolves.toBe(true);
        });

        it("resolves false when the notifier is not running, or the token is empty", async () => {
            vi.spyOn(ServerNotificationService, "isEnabled").mockReturnValue(true);
            await expect(svc.whenDelivered("tok")).resolves.toBe(false);
            svc._running = true;
            svc._unsubscribeTap = () => {};
            await expect(svc.whenDelivered("")).resolves.toBe(false);
        });

        it("times out to false, and a newer waiter for the same token releases the older one as false", async () => {
            vi.useFakeTimers();
            vi.spyOn(ServerNotificationService, "isEnabled").mockReturnValue(true);
            svc._running = true;
            svc._unsubscribeTap = () => {};
            const first = svc.whenDelivered("tok", { timeoutMs: 1000 });
            const second = svc.whenDelivered("tok", { timeoutMs: 1000 });
            await expect(first).resolves.toBe(false);
            await vi.advanceTimersByTimeAsync(1000);
            await expect(second).resolves.toBe(false);
            expect(svc._deliveryWaiters.size).toBe(0);
        });

        it("the default wait is the digest window plus two send bounds plus 10s", async () => {
            vi.useFakeTimers();
            vi.spyOn(ServerNotificationService, "isEnabled").mockReturnValue(true);
            svc._running = true;
            svc._unsubscribeTap = () => {};
            const p = svc.whenDelivered("tok");
            const budget = svc._digestWindowMs() + 2 * 5000 + 10_000;
            let settled = false;
            p.then(() => { settled = true; });
            await vi.advanceTimersByTimeAsync(budget - 1);
            expect(settled).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            expect(settled).toBe(true);
        });

        it("_settleDelivery resolves the waiter with the outcome; unknown tokens are ignored", async () => {
            vi.spyOn(ServerNotificationService, "isEnabled").mockReturnValue(true);
            svc._running = true;
            svc._unsubscribeTap = () => {};
            const p = svc.whenDelivered("tok", { timeoutMs: 60_000 });
            svc._settleDelivery("nope", true);
            svc._settleDelivery("tok", true);
            await expect(p).resolves.toBe(true);
            expect(svc._deliveryWaiters.size).toBe(0);
        });

        it("_settleDeliveries settles only events carrying a string token; _settleAllDeliveries releases the rest", async () => {
            vi.spyOn(ServerNotificationService, "isEnabled").mockReturnValue(true);
            svc._running = true;
            svc._unsubscribeTap = () => {};
            const a = svc.whenDelivered("a", { timeoutMs: 60_000 });
            const b = svc.whenDelivered("b", { timeoutMs: 60_000 });
            svc._settleDeliveries([{ meta: { _deliveryToken: "a" } }, { meta: { _deliveryToken: 5 } }, { meta: {} }, {}, null as any], true);
            await expect(a).resolves.toBe(true);
            svc._settleAllDeliveries(false);
            await expect(b).resolves.toBe(false);
        });
    });

    describe("_flushCriticalDigest at the hourly ceiling", () => {
        const record = (token?: string) => ({ level: "CRITICAL", message: "boom", meta: token ? { _deliveryToken: token } : {}, requestId: null, timestamp: new Date().toISOString() });

        it("an empty buffer does nothing", async () => {
            const dispatch = vi.spyOn(svc, "_dispatchCriticalDigest");
            await svc._flushCriticalDigest();
            expect(dispatch).not.toHaveBeenCalled();
        });

        it("suppresses the digest, records one SUPPRESSED row for the whole window, and tells waiters it was not emailed", async () => {
            vi.spyOn(ServerNotificationService, "isEnabled").mockReturnValue(true);
            svc._running = true;
            svc._unsubscribeTap = () => {};
            const dispatch = vi.spyOn(svc, "_dispatchCriticalDigest");
            const rows = vi.spyOn(svc, "_writeAlertLogRows").mockResolvedValue(undefined);
            const waiter = svc.whenDelivered("tok", { timeoutMs: 60_000 });
            svc._criticalSentTimestamps = Array.from({ length: svc._maxEmailsPerHour() }, () => Date.now());
            svc._criticalBuffer = [record("tok"), record()];
            svc._criticalOverflowInWindow = 3;
            await svc._flushCriticalDigest();
            expect(dispatch).not.toHaveBeenCalled();
            expect(rows).toHaveBeenCalledTimes(1);
            expect((rows.mock.calls as any[][])[0][0]).toHaveLength(1);
            expect((rows.mock.calls as any[][])[0][0][0]).toMatchObject({ transition: "SUPPRESSED", valueNum: 5, emailStatus: "SKIPPED" });
            expect(svc._criticalSuppressedSinceLastSend).toBe(5);
            expect(svc._criticalBuffer).toEqual([]);
            await expect(waiter).resolves.toBe(false);
        });

        it("with persist:false (pools closed) it writes no row and says so", async () => {
            const rows = vi.spyOn(svc, "_writeAlertLogRows").mockResolvedValue(undefined);
            svc._criticalSentTimestamps = Array.from({ length: svc._maxEmailsPerHour() }, () => Date.now());
            svc._criticalBuffer = [record()];
            await svc._flushCriticalDigest({ persist: false });
            expect(rows).not.toHaveBeenCalled();
            expect(logger.warning).toHaveBeenCalled();
        });

        it("under the ceiling the digest is sent with the suppressed-count note, which then resets", async () => {
            const dispatch = vi.spyOn(svc, "_dispatchCriticalDigest").mockResolvedValue({ sent: true } as never);
            svc._criticalSuppressedSinceLastSend = 7;
            svc._criticalBuffer = [record()];
            await svc._flushCriticalDigest();
            expect((dispatch.mock.calls as any[][])[0][1]).toContain("7 further event(s)");
            expect(svc._criticalSuppressedSinceLastSend).toBe(0);
            expect(svc._criticalSentTimestamps).toHaveLength(1);
            svc._criticalBuffer = [record()];
            await svc._flushCriticalDigest();
            expect((dispatch.mock.calls as any[][])[1][1]).toBe("");
        });
    });

    describe("_saveBufferedCriticalRowsForShutdown", () => {
        const rec = (o: Record<string, unknown> = {}) => ({ level: "CRITICAL", message: "m".repeat(2000), meta: {}, requestId: null, timestamp: new Date().toISOString(), ...o });

        it("writes one SKIPPED FIRED row per unsaved critical and flags them so they are not written twice", async () => {
            const rows = vi.spyOn(svc, "_writeAlertLogRows").mockResolvedValue(undefined);
            svc._criticalBuffer = [rec(), rec({ rowSaved: true })];
            await svc._saveBufferedCriticalRowsForShutdown();
            expect(rows).toHaveBeenCalledTimes(1);
            expect((rows.mock.calls as any[][])[0][0]).toHaveLength(1);
            expect((rows.mock.calls as any[][])[0][0][0]).toMatchObject({ transition: "FIRED", emailStatus: "SKIPPED", channel: "server-critical-notification" });
            expect((rows.mock.calls as any[][])[0][0][0].description.length).toBeLessThanOrEqual(1000);
            expect(svc._criticalBuffer.every((e: any) => e.rowSaved)).toBe(true);
            await svc._saveBufferedCriticalRowsForShutdown();
            expect(rows).toHaveBeenCalledTimes(1);
        });

        it("nothing buffered writes nothing", async () => {
            const rows = vi.spyOn(svc, "_writeAlertLogRows").mockResolvedValue(undefined);
            await svc._saveBufferedCriticalRowsForShutdown();
            expect(rows).not.toHaveBeenCalled();
        });

        it("at the hourly ceiling it takes the normal flush path (SUPPRESSED row, no mail)", async () => {
            const flushSpy = vi.spyOn(svc, "_flushCriticalDigest");
            const rows = vi.spyOn(svc, "_writeAlertLogRows").mockResolvedValue(undefined);
            svc._criticalSentTimestamps = Array.from({ length: svc._maxEmailsPerHour() }, () => Date.now());
            svc._criticalBuffer = [rec()];
            await svc._saveBufferedCriticalRowsForShutdown();
            expect(flushSpy).toHaveBeenCalledTimes(1);
            expect((rows.mock.calls as any[][])[0][0][0].transition).toBe("SUPPRESSED");
        });
    });

    describe("notifyLifecycleNow", () => {
        const rows = [{ rule: "SHUTDOWN", scope: "process", description: "going down", severity: "WARNING" }];

        it("disabled: reports 'disabled' without persisting by default", async () => {
            vi.spyOn(ServerNotificationService, "isEnabled").mockReturnValue(false);
            const rec = vi.spyOn(svc, "_recordLifecycleRows");
            await expect(svc.notifyLifecycleNow({ severity: "WARNING", headline: "h", summary: "s", rows })).resolves.toEqual({ sent: false, reason: "disabled" });
            expect(rec).not.toHaveBeenCalled();
        });

        it("disabled with persist records a DISABLED row for a WARNING/CRITICAL email", async () => {
            vi.spyOn(ServerNotificationService, "isEnabled").mockReturnValue(false);
            const write = vi.spyOn(svc, "_writeAlertLogRows").mockResolvedValue(undefined);
            await svc.notifyLifecycleNow({ severity: "CRITICAL", headline: "h", summary: "s", rows, persist: true });
            await flush();
            expect(write).toHaveBeenCalledTimes(1);
            expect((write.mock.calls as any[][])[0][0][0]).toMatchObject({ emailStatus: "DISABLED", emailError: null, severity: "CRITICAL", alertKey: "SHUTDOWN::process" });
        });

        it("a NOTICE or a row-less email is never persisted", async () => {
            vi.spyOn(ServerNotificationService, "isEnabled").mockReturnValue(false);
            const rec = vi.spyOn(svc, "_recordLifecycleRows");
            await svc.notifyLifecycleNow({ severity: "NOTICE", headline: "h", summary: "s", rows, persist: true });
            await svc.notifyLifecycleNow({ severity: "WARNING", headline: "h", summary: "s", rows: [], persist: true });
            expect(rec).not.toHaveBeenCalled();
        });

        it("enabled: sends on the system channel with heap placeholders and a logs-only note when not persisted", async () => {
            vi.spyOn(ServerNotificationService, "isEnabled").mockReturnValue(true);
            const send = vi.spyOn(ServerNotificationService, "sendChannelDigest").mockResolvedValue({ sent: true, notificationId: "n1" } as never);
            await expect(svc.notifyLifecycleNow({ severity: "NOTICE", headline: "H", summary: "S", rows })).resolves.toEqual({ sent: true, notificationId: "n1" });
            const [channel, payload] = send.mock.calls[0] as any;
            expect(channel).toBe("server-system-notification");
            expect(payload).toMatchObject({ severity: "NOTICE", headline: "H", summary: "S", rows });
            expect(payload.kv.heapPct).toMatch(/%$/);
        });

        it("enabled with persist: the row follows the real send result (SENT with the notification id)", async () => {
            vi.spyOn(ServerNotificationService, "isEnabled").mockReturnValue(true);
            vi.spyOn(ServerNotificationService, "sendChannelDigest").mockResolvedValue({ sent: true, notificationId: "n9" } as never);
            const write = vi.spyOn(svc, "_writeAlertLogRows").mockResolvedValue(undefined);
            await svc.notifyLifecycleNow({ severity: "WARNING", headline: "H", summary: "S", rows: [{ rule: "R", description: "d", severity: "WARNING" }], persist: true });
            await flush();
            expect((write.mock.calls as any[][])[0][0][0]).toMatchObject({ emailStatus: "SENT", notificationId: "n9", alertKey: "R::process", emailError: null });
        });

        it("a send that throws becomes a failed result with the cause, and the row says FAILED", async () => {
            vi.spyOn(ServerNotificationService, "isEnabled").mockReturnValue(true);
            vi.spyOn(ServerNotificationService, "sendChannelDigest").mockRejectedValue(new Error("SMTP refused"));
            const write = vi.spyOn(svc, "_writeAlertLogRows").mockResolvedValue(undefined);
            const out = await svc.notifyLifecycleNow({ severity: "CRITICAL", headline: "H", summary: "S", rows, persist: true });
            expect(out).toEqual({ sent: false, reason: "error", cause: "SMTP refused" });
            await flush();
            expect((write.mock.calls as any[][])[0][0][0]).toMatchObject({ emailStatus: "FAILED", emailError: "SMTP refused" });
        });

        it("a send rejecting with a non-Error is stringified", async () => {
            vi.spyOn(ServerNotificationService, "isEnabled").mockReturnValue(true);
            vi.spyOn(ServerNotificationService, "sendChannelDigest").mockRejectedValue("plain");
            const out = await svc.notifyLifecycleNow({ severity: "NOTICE", headline: "H", summary: "S" });
            expect(out.cause).toBe("plain");
        });
    });

    describe("_recordLifecycleRows", () => {
        it("falls back to the headline, a reason-based error, and tolerates a nullish send result", async () => {
            const write = vi.spyOn(svc, "_writeAlertLogRows").mockResolvedValue(undefined);
            svc._recordLifecycleRows({ severity: "WARNING", headline: "HEAD", summary: "S", rows: [{ rule: "R" }] }, Promise.resolve({ sent: false, reason: "timeout" }));
            svc._recordLifecycleRows({ severity: "WARNING", headline: "HEAD", summary: "S", rows: [{ rule: "R2", scope: "web" }] }, Promise.resolve(undefined as any));
            svc._recordLifecycleRows({ severity: "WARNING", headline: "HEAD", summary: "S", rows: [{ rule: "R3" }] }, Promise.resolve({ sent: false }));
            await flush();
            const [a, b, c] = (write.mock.calls as any[][]).map((x) => x[0][0]);
            expect(a).toMatchObject({ description: "HEAD", emailStatus: "FAILED", emailError: "timeout", details: { source: "lifecycle", scope: null } });
            expect(b).toMatchObject({ alertKey: "R2::web", emailStatus: "FAILED", emailError: null });
            expect(c.emailError).toBeNull();
        });

        it("a failing write never surfaces", async () => {
            vi.spyOn(svc, "_writeAlertLogRows").mockRejectedValue(new Error("db"));
            expect(() => svc._recordLifecycleRows({ severity: "WARNING", headline: "H", summary: "S", rows: [{ rule: "R" }] }, Promise.resolve({ sent: true }))).not.toThrow();
            await flush();
        });
    });

    describe("_getRecentSends", () => {
        it("maps alert-log rows, drops bookkeeping state rows, and normalises dates and nulls", async () => {
            const at = new Date("2026-01-01T00:00:00.000Z");
            vi.spyOn(ServerAlertLogModel, "findRecent").mockResolvedValue([
                { CHANNEL: "c1", NOTIFICATION_ID: "n1", EMAIL_STATUS: "SENT", DESCRIPTION: "d1", EMAIL_ERROR: null, CREATED_AT: at },
                { CHANNEL: "c2", NOTIFICATION_ID: null, EMAIL_STATUS: "FAILED", DESCRIPTION: null, EMAIL_ERROR: "boom", CREATED_AT: "2026-01-02" },
                { CHANNEL: "c3", EMAIL_STATUS: "SKIPPED", DETAILS: { stateRow: true }, CREATED_AT: at },
                { CHANNEL: "c4", EMAIL_STATUS: "SKIPPED", DETAILS: { stateRow: false }, CREATED_AT: at },
            ] as never);
            const out = await svc._getRecentSends();
            expect(out.map((r: any) => r.channel)).toEqual(["c1", "c2", "c4"]);
            expect(out[0]).toEqual({ channel: "c1", notificationId: "n1", sent: true, headline: "d1", reason: null, at: at.toISOString() });
            expect(out[1]).toMatchObject({ notificationId: null, sent: false, headline: "", reason: "boom", at: "2026-01-02" });
            expect(out[2]).toMatchObject({ notificationId: null, reason: null });
        });

        it("a failing read falls back to the in-memory recent sends and logs", async () => {
            vi.spyOn(ServerAlertLogModel, "findRecent").mockRejectedValue(new Error("pool down"));
            const fallback = [{ channel: "mem" }];
            vi.spyOn(ServerNotificationService, "getRecentSends").mockReturnValue(fallback as never);
            await expect(svc._getRecentSends()).resolves.toBe(fallback);
            expect(logger.warning).toHaveBeenCalled();
        });

        it("a non-Error read failure is also tolerated", async () => {
            vi.spyOn(ServerAlertLogModel, "findRecent").mockRejectedValue("nope");
            vi.spyOn(ServerNotificationService, "getRecentSends").mockReturnValue([] as never);
            await expect(svc._getRecentSends()).resolves.toEqual([]);
        });
    });

    describe("poll tick re-entrancy", () => {
        it("a tick that starts while another is in flight is skipped without evaluating", async () => {
            const run = vi.spyOn(svc, "_runPollTick").mockResolvedValue(undefined);
            svc._pollInFlight = true;
            await svc._pollTick();
            expect(run).not.toHaveBeenCalled();
            expect(logger.debug).toHaveBeenCalled();
            svc._pollInFlight = false;
            await svc._pollTick();
            expect(run).toHaveBeenCalledTimes(1);
            expect(svc._pollInFlight).toBe(false);
        });

        it("the in-flight flag is cleared even when the tick throws", async () => {
            vi.spyOn(svc, "_runPollTick").mockRejectedValue(new Error("x"));
            await expect(svc._pollTick()).rejects.toThrow("x");
            expect(svc._pollInFlight).toBe(false);
        });
    });
});
