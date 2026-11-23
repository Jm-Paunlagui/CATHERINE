import path from "path";
import fs from "fs";
import os from "os";
import { EventEmitter } from "events";
import ServerRunMarker from "../../../src/utils/lifecycle/ServerRunMarker";
import StartupNotifier from "../../../src/utils/lifecycle/StartupNotifier";
import { SERVER_RUN_MARKER } from "../../../src/constants/serverRunMarker";

const { VERDICTS } = SERVER_RUN_MARKER;
let dir: string;
let file: string;
let sendLog: Array<Record<string, any>>;
const BOOT = 10_000_000;

function marker(runId = "run-A", p = Object.assign(new EventEmitter(), { pid: 1 })) {
    return new ServerRunMarker({ filePath: file, runId, version: "1", logger: { warning: vi.fn() }, now: () => BOOT, processRef: p, hostname: "h" });
}
function notifier(result: Record<string, unknown> | (() => never) = { sent: true }) {
    const notifyLifecycleNow = vi.fn(async (o: Record<string, unknown>) => {
        sendLog.push(o);
        if (typeof result === "function") return result();
        return result;
    });
    const logger = { warning: vi.fn(), info: vi.fn() };
    return { n: new StartupNotifier({ alertNotifier: { notifyLifecycleNow } as never, logger, tzOffsetMinutes: () => 480 }), notifyLifecycleNow, logger };
}
/** Runs a boot: read verdict then announce it. */
async function boot(n: InstanceType<typeof StartupNotifier>, m = marker()) {
    const { verdict, previous } = m.readPrevious();
    const res = await n.announce({ verdict, previous, current: { pid: 1, version: "1", bootedAtMs: BOOT, }, lastStartNoticeAt: m.lastStartNoticeAt(), nowMs: BOOT });
    return { verdict, res };
}
const seed = (rec: Record<string, unknown>) => fs.writeFileSync(file, JSON.stringify({ schema: 1, hostname: "h", pid: 9, version: "0", ...rec }));

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "boot-verdict-"));
    file = path.join(dir, "server-run.json");
    sendLog = [];
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("boot-verdict matrix", () => {
    it("FIRST_BOOT: one NOTICE 'started' email", async () => {
        const { n } = notifier();
        const { verdict, res } = await boot(n);
        expect(verdict).toBe(VERDICTS.FIRST_BOOT);
        expect(res).toMatchObject({ sent: true, event: "started" });
        expect(sendLog[0]).toMatchObject({ severity: "NOTICE", persist: true });
        expect(sendLog[0].summary).toContain("first start with restart tracking");
    });

    it("CLEAN: NOTICE 'stopped cleanly', service stop vs process exit wording", async () => {
        seed({ state: "STOPPED", stopReason: "SIGNAL", stoppedAt: BOOT - 100_000, exitCode: 0 });
        const { n } = notifier();
        const { verdict } = await boot(n);
        expect(verdict).toBe(VERDICTS.CLEAN);
        expect(sendLog[0].severity).toBe("NOTICE");
        expect(sendLog[0].summary).toContain("(service stop)");
        sendLog.length = 0;
        seed({ state: "STOPPED", stopReason: "EXIT", stoppedAt: BOOT - 100_000, exitCode: 0 });
        await boot(n);
        expect(sendLog[0].summary).toContain("(process exit)");
    });

    it("CLEAN after a crash exit code: WARNING, says whether the crash email was unsent", async () => {
        seed({ state: "STOPPED", stopReason: "CRASH", stoppedAt: BOOT - 1, exitCode: 1 });
        const { n } = notifier();
        await boot(n);
        expect(sendLog[0]).toMatchObject({ severity: "WARNING" });
        expect(sendLog[0].summary).toContain("after crash, reported when it happened");
        sendLog.length = 0;
        seed({ state: "STOPPED", stopReason: "FORCED_EXIT", stoppedAt: BOOT - 1, exitCode: 1, stopEmailUnsent: true, unreported: true });
        await boot(n);
        expect(sendLog[0].summary).toContain("after forced exit, the forced exit email could not be sent at the time");
    });

    it("CLEAN after PRIMARY_DISCONNECT (unreported): WARNING that it was not emailed", async () => {
        seed({ state: "STOPPED", stopReason: "PRIMARY_DISCONNECT", unreported: true, exitCode: 0 });
        const { n } = notifier();
        await boot(n);
        expect(sendLog[0].severity).toBe("WARNING");
        expect(sendLog[0].summary).toContain("primary disappeared");
    });

    it("UNCLEAN: CRITICAL email with downtime, STOPPING detail, and the record is queued until sent", async () => {
        seed({ state: "STOPPING", runId: "old", lastHeartbeatAt: BOOT - 5 * 60_000, bootedAt: BOOT - 3_600_000, stoppingAt: BOOT - 6 * 60_000, stopSignal: "SIGTERM" });
        const { n } = notifier();
        const m = marker();
        const { verdict, res } = await boot(n, m);
        expect(verdict).toBe(VERDICTS.UNCLEAN);
        expect(res).toMatchObject({ sent: true, event: "unclean-restart", uncleanReported: true });
        expect(sendLog[0]).toMatchObject({ severity: "CRITICAL" });
        expect(sendLog[0].summary).toContain("down about 5 min");
        expect(sendLog[0].summary).toContain("graceful shutdown had begun");
        expect(res.reportedKeys).toHaveLength(1);
    });

    it("UNCLEAN with a failed send stays unreported (kept for the next boot)", async () => {
        seed({ state: "RUNNING", runId: "old", lastHeartbeatAt: BOOT - 10_000 });
        const { n, logger } = notifier({ sent: false, reason: "smtp", cause: "ECONNREFUSED" });
        const { res } = await boot(n);
        expect(res).toMatchObject({ sent: false, uncleanReported: false, reportedKeys: [] });
        expect(logger.warning).toHaveBeenCalled();
    });

    it("UNCLEAN with notifications disabled counts as reported", async () => {
        seed({ state: "RUNNING", runId: "old", lastHeartbeatAt: BOOT - 10_000 });
        const { n, logger } = notifier({ sent: false, reason: "disabled" });
        const { res } = await boot(n);
        expect(res).toMatchObject({ uncleanReported: true });
        expect(logger.warning).not.toHaveBeenCalled();
    });

    it("UNCLEAN wording: under a minute, clock moved back, unknown heartbeat", async () => {
        const { n } = notifier();
        seed({ state: "RUNNING", runId: "old", lastHeartbeatAt: BOOT - 1000 });
        await boot(n);
        expect(sendLog.at(-1)!.summary).toContain("under a minute");
        seed({ state: "RUNNING", runId: "old", lastHeartbeatAt: BOOT + 5000 });
        await boot(n);
        expect(sendLog.at(-1)!.summary).toContain("system clock changed");
        seed({ state: "RUNNING", runId: "old" });
        await boot(n);
        expect(sendLog.at(-1)!.summary).toContain("last-alive time is unknown");
    });

    it("UNREADABLE: WARNING 'state unreadable' email", async () => {
        fs.writeFileSync(file, "garbage");
        const { n } = notifier();
        const { verdict } = await boot(n);
        expect(verdict).toBe(VERDICTS.UNREADABLE);
        expect(sendLog[0]).toMatchObject({ severity: "WARNING" });
        expect(sendLog[0].summary).toContain("state unreadable");
    });

    it("HANDOVER of a RUNNING leader: WARNING leader-lost email; STOPPING handover sends nothing", async () => {
        seed({ state: "RUNNING", runId: "run-A", lastHeartbeatAt: BOOT - 40_000 });
        const { n } = notifier();
        const first = await boot(n);
        expect(first.verdict).toBe(VERDICTS.HANDOVER);
        expect(first.res).toMatchObject({ event: "leader-lost", leaderLostReported: true });
        expect(sendLog[0]).toMatchObject({ severity: "WARNING" });
        expect(first.res.reportedLeaderLostKeys).toHaveLength(1);
        sendLog.length = 0;
        seed({ state: "STOPPING", runId: "run-A" });
        const second = await boot(n);
        expect(second.res).toEqual(expect.objectContaining({ sent: false, reason: "handover" }));
        expect(sendLog).toHaveLength(0);
    });

    it("HANDOVER leader-lost send failure leaves it pending", async () => {
        seed({ state: "RUNNING", runId: "run-A" });
        const { n } = notifier({ sent: false, reason: "timeout" });
        const { res } = await boot(n);
        expect(res.leaderLostReported).toBe(false);
    });

    it("earlier pending unclean + leader-lost entries are re-sent late, then this boot's own email", async () => {
        seed({ state: "STOPPED", stopReason: "EXIT", stoppedAt: 1, exitCode: 0, pendingUnclean: [{ pid: 3, bootedAt: 3 }], pendingLeaderLost: [{ pid: 4, bootedAt: 4 }] });
        const { n } = notifier();
        const { res } = await boot(n);
        expect(sendLog.map((s) => s.severity)).toEqual(["CRITICAL", "WARNING", "NOTICE"]);
        expect(sendLog[0].summary).toContain("not emailed when it happened");
        expect(sendLog[1].summary).toContain("A replacement worker took over then");
        expect(res.reportedKeys).toEqual(["3:3"]);
        expect(res.reportedLeaderLostKeys).toEqual(["4:4"]);
    });

    it("late entries whose resend fails stay pending", async () => {
        seed({ state: "STOPPED", pendingUnclean: [{ pid: 3 }], pendingLeaderLost: [{ pid: 4 }] });
        const { n } = notifier({ sent: false, reason: "x" });
        const { res } = await boot(n);
        expect(res).toMatchObject({ uncleanReported: false, leaderLostReported: false, reportedKeys: [], reportedLeaderLostKeys: [] });
    });

    it("full cycle: unclean boot, marker rewritten, next boot is CLEAN after a graceful stop", async () => {
        seed({ state: "RUNNING", runId: "old", lastHeartbeatAt: BOOT - 1 });
        const p = Object.assign(new EventEmitter(), { pid: 5 });
        const m = marker("run-B", p);
        expect(m.readPrevious().verdict).toBe(VERDICTS.UNCLEAN);
        m.start();
        m.noteStopping("SIGTERM", 0);
        m.noteTeardownComplete(0);
        m.stop();
        expect(marker("run-C").readPrevious().verdict).toBe(VERDICTS.CLEAN);
    });
});
