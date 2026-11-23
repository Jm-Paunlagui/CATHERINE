import StartupNotifier, { isReportedSend } from "../../../../src/utils/lifecycle/StartupNotifier";
import { SERVER_RUN_MARKER } from "../../../../src/constants/serverRunMarker";

const { VERDICTS } = SERVER_RUN_MARKER;
const NOW = 100_000_000;
const MIN = SERVER_RUN_MARKER.STARTUP_NOTICE_MIN_INTERVAL_MS;
const current = { pid: 2, version: "9.9", bootedAtMs: NOW };

function build(notify: (o: any) => unknown = async () => ({ sent: true }), tz = () => 0) {
    const notifyLifecycleNow = vi.fn(notify);
    const logger = { warning: vi.fn(), info: vi.fn() };
    const n = new StartupNotifier({ alertNotifier: { notifyLifecycleNow } as never, logger, tzOffsetMinutes: tz });
    return { n, notifyLifecycleNow, logger };
}
const clean = (extra: Record<string, unknown> = {}) => ({ schema: 1, state: "STOPPED", pid: 1, ...extra }) as never;

describe("isReportedSend", () => {
    it("is true for sent or disabled only", () => {
        expect(isReportedSend({ sent: true })).toBe(true);
        expect(isReportedSend({ sent: false, reason: "disabled" })).toBe(true);
        expect(isReportedSend({ sent: false, reason: "timeout" })).toBe(false);
        expect(isReportedSend(null)).toBe(false);
        expect(isReportedSend(undefined)).toBe(false);
        expect(StartupNotifier.isReportedSend).toBe(isReportedSend);
    });
});

describe("StartupNotifier throttle", () => {
    it("throttles a started notice inside the window and logs it", async () => {
        const { n, notifyLifecycleNow, logger } = build();
        const res = await n.announce({ verdict: VERDICTS.CLEAN, previous: clean({ stopReason: "EXIT" }), current, lastStartNoticeAt: NOW - 1000, nowMs: NOW });
        expect(res).toMatchObject({ sent: false, reason: "throttled", event: "started" });
        expect(notifyLifecycleNow).not.toHaveBeenCalled();
        expect(logger.info).toHaveBeenCalledTimes(1);
    });
    it("does not throttle with no earlier notice, outside the window, or when the clock went back", async () => {
        const { n, notifyLifecycleNow } = build();
        await n.announce({ verdict: VERDICTS.CLEAN, previous: clean(), current, lastStartNoticeAt: null, nowMs: NOW });
        await n.announce({ verdict: VERDICTS.CLEAN, previous: clean(), current, lastStartNoticeAt: NOW - MIN, nowMs: NOW });
        await n.announce({ verdict: VERDICTS.CLEAN, previous: clean(), current, lastStartNoticeAt: NOW + 5000, nowMs: NOW });
        await n.announce({ verdict: VERDICTS.CLEAN, previous: clean(), current, lastStartNoticeAt: Number.NaN, nowMs: NOW });
        expect(notifyLifecycleNow).toHaveBeenCalledTimes(4);
    });
    it("does not throttle after an unreported stop", async () => {
        const { n, notifyLifecycleNow } = build();
        await n.announce({ verdict: VERDICTS.CLEAN, previous: clean({ unreported: true }), current, lastStartNoticeAt: NOW - 10, nowMs: NOW });
        expect(notifyLifecycleNow).toHaveBeenCalledTimes(1);
    });
    it.each([
        ["SIGNAL with stoppingAt", { stopReason: "SIGNAL", stoppingAt: NOW - 5 }],
        ["CRASH falling back to stoppedAt", { stopReason: "CRASH", stoppedAt: NOW - 5, stoppingAt: null }],
        ["FORCED_EXIT", { stopReason: "FORCED_EXIT", stoppingAt: NOW - 5 }],
    ])("does not throttle after an announced stop since the last notice: %s", async (_n, extra) => {
        const { n, notifyLifecycleNow } = build();
        await n.announce({ verdict: VERDICTS.CLEAN, previous: clean(extra), current, lastStartNoticeAt: NOW - 100, nowMs: NOW });
        expect(notifyLifecycleNow).toHaveBeenCalledTimes(1);
    });
    it("still throttles when the announced stop predates the last notice, has no time, or is a silent reason", async () => {
        const { n, notifyLifecycleNow } = build();
        const args = { verdict: VERDICTS.CLEAN, current, lastStartNoticeAt: NOW - 100, nowMs: NOW };
        await n.announce({ ...args, previous: clean({ stopReason: "SIGNAL", stoppingAt: NOW - 500 }) });
        await n.announce({ ...args, previous: clean({ stopReason: "SIGNAL" }) });
        await n.announce({ ...args, previous: clean({ stopReason: "EXIT", stoppingAt: NOW - 5 }) });
        await n.announce({ ...args, previous: clean() });
        expect(notifyLifecycleNow).not.toHaveBeenCalled();
    });
});

describe("StartupNotifier payloads and formatting", () => {
    it("formats stamps in the DB zone with 12-hour clock (positive and negative offsets, noon/midnight)", async () => {
        const stoppedAt = Date.UTC(2026, 10, 3, 0, 5, 7); // midnight UTC
        const pos = build(undefined, () => 480);
        await pos.n.announce({ verdict: VERDICTS.CLEAN, previous: clean({ stopReason: "EXIT", stoppedAt }), current, lastStartNoticeAt: null, nowMs: NOW });
        expect(pos.notifyLifecycleNow.mock.calls[0][0].summary).toContain("Nov 3, 2026, 8:05:07 AM UTC+08:00");
        const neg = build(undefined, () => -570);
        await neg.n.announce({ verdict: VERDICTS.CLEAN, previous: clean({ stopReason: "EXIT", stoppedAt: Date.UTC(2026, 10, 3, 12, 0, 0) }), current, lastStartNoticeAt: null, nowMs: NOW });
        expect(neg.notifyLifecycleNow.mock.calls[0][0].summary).toContain("Nov 3, 2026, 2:30:00 AM UTC-09:30");
        const noon = build(undefined, () => 0);
        await noon.n.announce({ verdict: VERDICTS.CLEAN, previous: clean({ stopReason: "EXIT", stoppedAt: Date.UTC(2026, 10, 3, 12, 0, 0) }), current, lastStartNoticeAt: null, nowMs: NOW });
        expect(noon.notifyLifecycleNow.mock.calls[0][0].summary).toContain("12:00:00 PM UTC+00:00");
    });
    it("says 'an unknown time' for a missing stamp", async () => {
        const { n, notifyLifecycleNow } = build();
        await n.announce({ verdict: VERDICTS.CLEAN, previous: clean({ stopReason: "EXIT" }), current, lastStartNoticeAt: null, nowMs: NOW });
        expect(notifyLifecycleNow.mock.calls[0][0].summary).toContain("an unknown time");
    });
    it("UNCLEAN copy for a record with no fields uses placeholders; late copy omits downtime", async () => {
        const { n, notifyLifecycleNow } = build();
        await n.announce({ verdict: VERDICTS.UNCLEAN, previous: null, current, lastStartNoticeAt: null, nowMs: NOW });
        const s = notifyLifecycleNow.mock.calls[0][0];
        expect(s.summary).toContain("PID ?, version ?");
        expect(s.rows[0].description).toContain("previous state unknown");
        await n.announce({ verdict: VERDICTS.CLEAN, previous: clean({ pendingUnclean: { pid: 8, lastHeartbeatAt: NOW - 1000, state: "STOPPING" } }), current, lastStartNoticeAt: null, nowMs: NOW });
        const late = notifyLifecycleNow.mock.calls[1][0];
        expect(late.summary).toContain("not emailed when it happened");
        expect(late.summary).not.toContain("(down ");
        expect(late.summary).toContain("(signal)");
    });
    it("leader-lost copy for an empty record", async () => {
        const { n, notifyLifecycleNow } = build();
        await n.announce({ verdict: VERDICTS.CLEAN, previous: clean({ pendingLeaderLost: {} }), current, lastStartNoticeAt: null, nowMs: NOW });
        expect(notifyLifecycleNow.mock.calls[0][0].rows[0].description).toBe("Worker PID ? lost (reported late).");
    });
    it("copy never carries env values or stack traces (CWE-209)", async () => {
        process.env.SMTP_PASS = "super-secret-pass";
        const { n, notifyLifecycleNow } = build();
        await n.announce({ verdict: VERDICTS.UNCLEAN, previous: clean({ state: "RUNNING" }), current, lastStartNoticeAt: null, nowMs: NOW });
        const text = JSON.stringify(notifyLifecycleNow.mock.calls[0][0]);
        expect(text).not.toContain("super-secret-pass");
        expect(text).not.toMatch(/\bat .*\(.*:\d+:\d+\)/);
        delete process.env.SMTP_PASS;
    });
});

describe("StartupNotifier failure handling", () => {
    it("a synchronous throw from the notifier becomes reason 'error' and a warning", async () => {
        const { n, logger } = build(() => { throw new Error("sync"); });
        const res = await n.announce({ verdict: VERDICTS.UNCLEAN, previous: clean({ state: "RUNNING" }), current, lastStartNoticeAt: null, nowMs: NOW });
        expect(res).toMatchObject({ sent: false, reason: "error", uncleanReported: false });
        expect(logger.warning).toHaveBeenCalled();
    });
    it("a rejected promise is tracked and settled() waits for it", async () => {
        const { n } = build(() => Promise.reject(new Error("async")));
        const p = n.announce({ verdict: VERDICTS.FIRST_BOOT, previous: null, current, lastStartNoticeAt: null, nowMs: NOW });
        await n.settled();
        expect(await p).toMatchObject({ sent: false, reason: "error", event: "started" });
    });
    it("an undefined notifier result is treated as not sent; a non-Error cause is stringified", async () => {
        const { n, logger } = build(async () => undefined);
        const res = await n.announce({ verdict: VERDICTS.FIRST_BOOT, previous: null, current, lastStartNoticeAt: null, nowMs: NOW });
        expect(res).toMatchObject({ sent: false, event: "started" });
        const second = build(async () => ({ sent: false, reason: "timeout" }));
        await second.n.announce({ verdict: VERDICTS.FIRST_BOOT, previous: null, current, lastStartNoticeAt: null, nowMs: NOW });
        expect(second.logger.warning).toHaveBeenCalledTimes(1);
        expect(logger.warning).toHaveBeenCalledTimes(0);
    });
    it("a throwing logger never breaks boot", async () => {
        const { n, logger } = build(() => { throw "str"; });
        logger.warning.mockImplementation(() => { throw new Error("log"); });
        await expect(n.announce({ verdict: VERDICTS.FIRST_BOOT, previous: null, current, lastStartNoticeAt: null, nowMs: NOW })).resolves.toMatchObject({ reason: "error" });
    });
    it("settled() resolves immediately with nothing pending", async () => {
        await expect(build().n.settled()).resolves.toBeUndefined();
    });
});
