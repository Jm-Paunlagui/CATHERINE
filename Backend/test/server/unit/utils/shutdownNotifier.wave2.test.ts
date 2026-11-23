import ShutdownNotifier from "../../../../src/utils/shutdown/ShutdownNotifier";

type Notify = ReturnType<typeof vi.fn>;
function make(announce?: boolean, notify: Notify = vi.fn().mockResolvedValue({ sent: true })) {
    const logger = { warning: vi.fn() };
    const n = new ShutdownNotifier({ alertNotifier: { notifyLifecycleNow: notify as never }, logger, announce });
    return { n, notify, logger };
}

describe("ShutdownNotifier wave2", () => {
    it("started: skips when this process is not the announcer", async () => {
        const { n, notify } = make(false);
        await expect(n.started({ signal: "SIGTERM", inFlight: 1, graceMs: 1000, pendingTasks: 0 })).resolves.toEqual({ sent: false, reason: "not-announcer" });
        expect(notify).not.toHaveBeenCalled();
    });

    it("started: fixed-grace wording and known signal label", async () => {
        const { n, notify } = make();
        await n.started({ signal: "SIGTERM", inFlight: 2, graceMs: 30_000, pendingTasks: 3 });
        const p = notify.mock.calls[0][0];
        expect(p.severity).toBe("WARNING");
        expect(p.summary).toContain("service stop (SIGTERM)");
        expect(p.summary).toContain("2 request(s) in progress may finish for up to 30 s");
        expect(p.rows[0].description).toContain("3 background task(s) pending, grace 30 s");
    });

    it("started: progress-aware wording, seconds for short and minutes for long cap, raw unknown signal", async () => {
        const { n, notify } = make();
        await n.started({ signal: "SIGUSR2", inFlight: 1, graceMs: 90_000, pendingTasks: 0, idleLimits: { defaultMs: 30_000, longMs: 120_000 } });
        await n.started({ signal: "SIGINT", inFlight: 1, graceMs: 600_000, pendingTasks: 0, idleLimits: { defaultMs: 30_000, longMs: 120_000 } });
        const short = notify.mock.calls[0][0].summary as string;
        const long = notify.mock.calls[1][0].summary as string;
        expect(short).toContain("(SIGUSR2)");
        expect(short).toContain("30s, long operations 120s");
        expect(short).toContain("Absolute cap 90 s.");
        expect(long).toContain("Ctrl+C / service stop (SIGINT)");
        expect(long).toContain("Absolute cap 10 min.");
    });

    it("requestsCut: cap reason and idle reason build different rows and headlines", async () => {
        const { n, notify } = make();
        const sum = [{ method: "GET", path: "/a", ageMs: 5000 }, { method: "POST", path: "/b", ageMs: 9000, idleMs: 7000 }];
        await n.requestsCut(sum, 10_000);
        await n.requestsCut(sum, 10_000, 5, { reason: "idle" });
        const cap = notify.mock.calls[0][0];
        const idle = notify.mock.calls[1][0];
        expect(cap.headline).toBe("2 request(s) cut during shutdown");
        expect(cap.rows[0].description).toContain("Still running after 5 s");
        expect(cap.summary).toContain("10 s shutdown grace ran out");
        expect(idle.headline).toBe("5 request(s) cut during shutdown — stopped making progress");
        expect(idle.rows[0].description).toContain("idle 5 s, age 5 s");
        expect(idle.rows[1].description).toContain("idle 7 s, age 9 s");
        expect(idle.rows[1].scope).toBe("POST /b");
    });

    it("forcedExit: names a non-leader worker, stays silent about it for the announcer", async () => {
        const a = make(true);
        const b = make(false);
        await a.n.forcedExit(15_000);
        await b.n.forcedExit(15_000);
        expect(a.notify.mock.calls[0][0].headline).toBe("Shutdown hung — forced exit after 15 s");
        expect(b.notify.mock.calls[0][0].headline).toContain(`cluster worker PID ${process.pid}, not the cron leader`);
    });

    it("logs a warning for a not-sent result other than disabled, but not for disabled or sent", async () => {
        const { n, logger, notify } = make();
        notify.mockResolvedValueOnce({ sent: false, reason: "disabled" });
        await n.forcedExit(1000);
        expect(logger.warning).not.toHaveBeenCalled();
        notify.mockResolvedValueOnce({ sent: false, reason: "timeout", cause: "smtp slow" });
        await expect(n.forcedExit(1000)).resolves.toEqual({ sent: false, reason: "timeout", cause: "smtp slow" });
        expect(logger.warning).toHaveBeenCalledTimes(1);
        expect(logger.warning.mock.calls[0][0]).toContain("smtp slow");
        expect(logger.warning.mock.calls[0][1]).toEqual({ _noNotify: true });
        notify.mockResolvedValueOnce({ sent: false, reason: "no-recipients" });
        await n.forcedExit(1000);
        expect(logger.warning.mock.calls[1][0]).toContain("no-recipients");
    });

    it("never throws: a rejecting or synchronously throwing notifier resolves to an error result", async () => {
        const rej = make(true, vi.fn().mockRejectedValue(new Error("boom")));
        await expect(rej.n.forcedExit(1000)).resolves.toEqual({ sent: false, reason: "error" });
        expect(rej.logger.warning.mock.calls[0][0]).toContain("boom");
        const thrower = make(true, vi.fn(() => { throw "raw string"; }));
        await expect(thrower.n.forcedExit(1000)).resolves.toEqual({ sent: false, reason: "error" });
        expect(thrower.logger.warning.mock.calls[0][0]).toContain("raw string");
    });

    it("settled waits for every in-flight send and is a no-op when none are pending", async () => {
        let release!: (v: unknown) => void;
        const gate = new Promise((r) => { release = r; });
        const { n } = make(true, vi.fn().mockReturnValue(gate));
        const p = n.forcedExit(1000);
        let done = false;
        const s = n.settled().then(() => { done = true; });
        await Promise.resolve();
        expect(done).toBe(false);
        release({ sent: true });
        await p;
        await s;
        expect(done).toBe(true);
        await expect(n.settled()).resolves.toBeUndefined();
    });
});
