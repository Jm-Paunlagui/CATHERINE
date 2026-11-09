"use strict";

/**
 * @fileoverview Pre-stable restart-reporting audit - PROOF tests (written before any fix).
 * Each test asserts the CORRECT behaviour, so a failing test proves the finding.
 * Real ServerRunMarker on tmp files; the alert notifier is faked, nothing is mailed.
 *
 *   R2   an unclean restart whose email failed is never reported later
 *   R4   an "unreported" stop's WARNING is swallowed by the 15-minute throttle
 *   R8   recordStartNotice after the data teardown drops the STOPPED details
 *   R9   a failed boot write leaves the previous run's STOPPED record behind
 *   R10  a clock that went backwards: throttle and downtime text
 *   S4   a tampered `state: "toString"` passes the shape check
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const ServerRunMarker = require("../../../../src/utils/lifecycle/ServerRunMarker");
const StartupNotifier = require("../../../../src/utils/lifecycle/StartupNotifier");

const noop = () => {};
const logger = () => ({ warning: vi.fn(), error: vi.fn(), info: vi.fn(), notice: vi.fn() });
let dir;
let file;
let clock;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-audit-proof-"));
    file = path.join(dir, "data", "server-run.json");
    clock = Date.UTC(2026, 9, 17, 9, 0, 0);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function marker({ runId = "run", pid = 4242, fsImpl = fs } = {}) {
    return new ServerRunMarker({
        filePath: file,
        runId,
        version: "2.1.3",
        logger: logger(),
        intervalMs: 30_000,
        now: () => clock,
        fs: fsImpl,
        processRef: Object.assign(new EventEmitter(), { pid }),
        hostname: "HOST1",
    });
}
function notifier(send) {
    const alertNotifier = { notifyLifecycleNow: vi.fn(send ?? (async () => ({ sent: true }))) };
    return { n: new StartupNotifier({ alertNotifier, logger: { warning: noop, info: noop }, tzOffsetMinutes: () => 480 }), alertNotifier };
}
/** One boot: read the previous run, start, announce (as server.js does). */
async function boot(m, n) {
    const v = m.readPrevious();
    const lastStartNoticeAt = m.lastStartNoticeAt();
    m.start();
    const res = await n.announce({ verdict: v.verdict, previous: v.previous, current: { pid: 1, version: "2.1.3", bootedAtMs: clock }, lastStartNoticeAt, nowMs: clock });
    if (res?.sent && res.event === "started") m.recordStartNotice(clock);
    return { v, res };
}

describe("R2 - an unclean restart whose email failed", function () {
    it("is still reported on a later start, not lost when the record is overwritten", async function () {
        const a = marker({ runId: "A", pid: 100 });
        a.start(); // run A is hard-killed: RUNNING stays behind
        a.stop();

        clock += 60_000;
        const b = marker({ runId: "B", pid: 200 });
        const failing = notifier(async () => ({ sent: false, reason: "error", cause: "SMTP down" }));
        const first = await boot(b, failing.n);
        expect(first.v.verdict).toBe("UNCLEAN"); // detected...
        expect(first.res.sent).toBe(false); // ...but the email failed
        b.noteStopping("SIGTERM", 0); // run B then stops cleanly
        b.noteTeardownComplete(0);
        b.stop();

        clock += 20 * 60_000;
        const c = marker({ runId: "C", pid: 300 });
        const ok = notifier();
        await boot(c, ok.n);
        const sent = ok.alertNotifier.notifyLifecycleNow.mock.calls.map(([p]) => `${p.severity} ${p.headline} ${p.summary}`).join(" | ");
        expect(sent, "run A's unclean restart was never emailed").toMatch(/without a clean shutdown/i);
    });
});

describe("R4 - the 15-minute throttle", function () {
    it("does not swallow the WARNING for a stop that sent no email at the time (unreported)", async function () {
        const { n, alertNotifier } = notifier();
        const previous = { state: "STOPPED", exitCode: 1, stopReason: "CRASH", unreported: true, stoppedAt: clock - 60_000, pid: 9 };
        const res = await n.announce({ verdict: "CLEAN", previous, current: { pid: 1, version: "2.1.3", bootedAtMs: clock }, lastStartNoticeAt: clock - 5 * 60_000, nowMs: clock });
        expect(res.reason).not.toBe("throttled");
        expect(alertNotifier.notifyLifecycleNow).toHaveBeenCalledTimes(1);
    });
});

describe("R8 - recordStartNotice after the data teardown", function () {
    it("keeps the STOPPED record complete (exit code, reason, time)", function () {
        const m = marker();
        m.start();
        m.noteStopping("SIGTERM", 0);
        m.noteTeardownComplete(0);
        m.recordStartNotice(clock); // the boot email settles late
        expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ state: "STOPPED", exitCode: 0, stopReason: "SIGNAL" });
        expect(JSON.parse(fs.readFileSync(file, "utf8")).stoppedAt).toBeDefined();
    });
});

describe("R9 - a boot write that fails", function () {
    it("does not leave the previous run's STOPPED record to read CLEAN after a later hard kill", function () {
        const old = marker({ runId: "OLD", pid: 100 });
        old.start();
        old.noteStopping("SIGTERM", 0);
        old.noteTeardownComplete(0); // previous run stopped cleanly
        old.stop();

        const failingFs = {
            ...fs,
            writeFileSync: () => {
                throw Object.assign(new Error("EPERM"), { code: "EPERM" });
            },
            renameSync: () => {
                throw Object.assign(new Error("EPERM"), { code: "EPERM" });
            },
        };
        const now = marker({ runId: "NOW", pid: 200, fsImpl: failingFs });
        now.readPrevious();
        now.start(); // cannot write RUNNING (antivirus lock, disk full)
        now.stop(); // ...and this run is then hard-killed

        const next = marker({ runId: "NEXT", pid: 300 });
        expect(next.readPrevious().verdict, "a hard-killed run reads as a clean stop").not.toBe("CLEAN");
    });
});

describe("R10 - a clock that went backwards", function () {
    it("a lastStartNoticeAt in the future does not throttle the started notice", async function () {
        const { n, alertNotifier } = notifier();
        const previous = { state: "STOPPED", exitCode: 0, stopReason: "SIGNAL", stoppedAt: clock - 60_000, pid: 9 };
        await n.announce({ verdict: "CLEAN", previous, current: { pid: 1, version: "2.1.3", bootedAtMs: clock }, lastStartNoticeAt: clock + 60 * 60_000, nowMs: clock });
        expect(alertNotifier.notifyLifecycleNow).toHaveBeenCalledTimes(1);
    });

    it("a last-alive time after the boot time is not reported as 'down under a minute'", async function () {
        const { n, alertNotifier } = notifier();
        const previous = { state: "RUNNING", pid: 9, version: "2.1.3", bootedAt: clock - 3_600_000, lastHeartbeatAt: clock + 10 * 60_000 };
        await n.announce({ verdict: "UNCLEAN", previous, current: { pid: 1, version: "2.1.3", bootedAtMs: clock }, lastStartNoticeAt: null, nowMs: clock });
        expect(alertNotifier.notifyLifecycleNow.mock.calls[0][0].summary).not.toMatch(/down under a minute/);
    });
});

describe("S4 - a tampered state value", function () {
    it("an inherited key such as 'toString' reads UNREADABLE, not a real state", function () {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ schema: 1, state: "toString", pid: 1, hostname: "HOST1", runId: "X" }));
        expect(marker({ runId: "NEXT" }).readPrevious().verdict).toBe("UNREADABLE");
    });
});

describe("R2 - an older pending report next to a new unclean restart", function () {
    it("both are emailed, and uncleanReported is true only when both were sent", async function () {
        const { n, alertNotifier } = notifier();
        const previous = { state: "RUNNING", pid: 9, version: "2.1.3", bootedAt: clock - 7_200_000, lastHeartbeatAt: clock - 60_000, pendingUnclean: { pid: 5, version: "2.1.3", lastHeartbeatAt: clock - 86_400_000, state: "RUNNING" } };
        const res = await n.announce({ verdict: "UNCLEAN", previous, current: { pid: 1, version: "2.1.3", bootedAtMs: clock }, lastStartNoticeAt: null, nowMs: clock });
        expect(alertNotifier.notifyLifecycleNow).toHaveBeenCalledTimes(2);
        expect(res.uncleanReported).toBe(true);

        const half = notifier(async (p) => ({ sent: !/not emailed when it happened/.test(p.summary) }));
        const res2 = await half.n.announce({ verdict: "UNCLEAN", previous, current: { pid: 1, version: "2.1.3", bootedAtMs: clock }, lastStartNoticeAt: null, nowMs: clock });
        expect(res2.uncleanReported).toBe(false);
    });
});

describe("review of ff794a36 - M: several unreported unclean restarts", function () {
    it("each one is reported exactly once, none dropped, none re-sent", async function () {
        const a = marker({ runId: "A", pid: 100 });
        a.start();
        a.stop(); // run 100 hard-killed

        clock += 60_000;
        const b = marker({ runId: "B", pid: 200 });
        await boot(b, notifier(async () => ({ sent: false, reason: "error" })).n); // 100's email fails
        b.stop(); // run 200 hard-killed too

        clock += 60_000;
        const c = marker({ runId: "C", pid: 300 });
        // the late email (100) goes out, 200's own email fails
        const half = notifier(async (p) => ({ sent: /not emailed when it happened/.test(p.summary) }));
        const r = await boot(c, half.n);
        if (r.res?.uncleanReported) c.clearPendingUnclean();
        else if (r.res?.reportedKeys) c.clearPendingUnclean(r.res.reportedKeys);
        c.noteStopping("SIGTERM", 0);
        c.noteTeardownComplete(0);
        c.stop();

        clock += 60_000;
        const d = marker({ runId: "D", pid: 400 });
        const ok = notifier();
        await boot(d, ok.n);
        const pids = ok.alertNotifier.notifyLifecycleNow.mock.calls
            .map(([p]) => p.summary)
            .filter((s) => /without running its shutdown sequence/.test(s))
            .map((s) => Number((/PID (\d+)/.exec(s) || [])[1]));
        expect(pids, "run 200 must be reported and run 100 not re-sent").toEqual([200]);
    });
});

describe("review of ff794a36 - L-c: notifications disabled", function () {
    it("a disabled result counts as reported, so no stale 'late' email months later", async function () {
        const { n } = notifier(async () => ({ sent: false, reason: "disabled" }));
        const previous = { state: "RUNNING", pid: 9, version: "2.1.3", lastHeartbeatAt: clock - 60_000 };
        const res = await n.announce({ verdict: "UNCLEAN", previous, current: { pid: 1, version: "2.1.3", bootedAtMs: clock }, lastStartNoticeAt: null, nowMs: clock });
        expect(res.uncleanReported).toBe(true);
    });
});

describe("R3 - a cron-leader worker that died while RUNNING", function () {
    it("sends one WARNING (leader-lost), unthrottled and not recorded as a started notice", async function () {
        const { n, alertNotifier } = notifier();
        const previous = { state: "RUNNING", pid: 41, version: "2.1.3", runId: "cluster-run", lastHeartbeatAt: clock - 20_000 };
        const res = await n.announce({ verdict: "HANDOVER", previous, current: { pid: 42, version: "2.1.3", bootedAtMs: clock }, lastStartNoticeAt: clock - 60_000, nowMs: clock });
        expect(res).toMatchObject({ sent: true, event: "leader-lost" });
        const p = alertNotifier.notifyLifecycleNow.mock.calls[0][0];
        expect(p.severity).toBe("WARNING");
        expect(p.headline).toMatch(/Cron-leader worker restarted unexpectedly/);
        expect(p.summary).toMatch(/PID 41/);
        expect(p.summary).toMatch(/replacement \(PID 42/);
    });

    it("stays silent when the old leader was STOPPING (the cluster's forced kill already emailed)", async function () {
        const { n, alertNotifier } = notifier();
        const previous = { state: "STOPPING", pid: 41, runId: "cluster-run" };
        const res = await n.announce({ verdict: "HANDOVER", previous, current: { pid: 42, version: "2.1.3", bootedAtMs: clock }, lastStartNoticeAt: null, nowMs: clock });
        expect(res).toMatchObject({ sent: false, reason: "handover" });
        expect(alertNotifier.notifyLifecycleNow).not.toHaveBeenCalled();
    });
});

describe("R7 - the cluster primary vanished while the cron leader was stopping cleanly", function () {
    function stopThenDisconnect() {
        const proc = Object.assign(new EventEmitter(), { pid: 4242 });
        const m = new ServerRunMarker({ filePath: file, runId: "run", version: "2.1.3", logger: logger(), intervalMs: 30_000, now: () => clock, processRef: proc, hostname: "HOST1" });
        m.readPrevious();
        m.start();
        m.noteStopping("SIGTERM", 0);
        // gracefulShutdown re-entry from the worker's "disconnect" handler (server.js)
        m.noteExitCodeRaised(1, { unreported: true, reason: "PRIMARY_DISCONNECT" });
        return { m, proc };
    }

    it("records PRIMARY_DISCONNECT and unreported, not a crash", function () {
        const { m, proc } = stopThenDisconnect();
        expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ state: "STOPPING", unreported: true });
        proc.emit("exit", 1);
        expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ state: "STOPPED", exitCode: 1, stopReason: "PRIMARY_DISCONNECT", unreported: true });
        m.stop();
    });

    it("the next start says the primary disappeared and was not emailed, never 'after crash, reported when it happened'", async function () {
        const { proc } = stopThenDisconnect();
        proc.emit("exit", 1);
        clock += 16 * 60_000;
        const { n, alertNotifier } = notifier();
        const { res } = await boot(marker(), n);
        expect(res).toMatchObject({ sent: true, event: "started" });
        const p = alertNotifier.notifyLifecycleNow.mock.calls[0][0];
        expect(p.severity).toBe("WARNING");
        expect(p.summary).toContain("cluster primary disappeared");
        expect(p.summary).not.toContain("reported when it happened");
    });

    it("review L3: a crash during the clean stop, then the disconnect inside the crash email's wait, stays CRASH and reported", function () {
        const proc = Object.assign(new EventEmitter(), { pid: 4242 });
        const m = new ServerRunMarker({ filePath: file, runId: "run", version: "2.1.3", logger: logger(), intervalMs: 30_000, now: () => clock, processRef: proc, hostname: "HOST1" });
        m.readPrevious();
        m.start();
        m.noteStopping("SIGTERM", 0);
        m.noteExitCodeRaised(1); // crash handler, before its EMERGENCY email (shutdownExitCode still 0)
        m.noteExitCodeRaised(1, { unreported: true, reason: "PRIMARY_DISCONNECT" }); // disconnect re-entry
        proc.emit("exit", 1);
        const rec = JSON.parse(fs.readFileSync(file, "utf8"));
        expect(rec.stopReason).toBe("CRASH");
        expect(rec.unreported).toBeUndefined();
        m.stop();
    });

    it("review L3: a crash (email in flight) then a FIRST-call disconnect stop stays CRASH and reported", function () {
        const proc = Object.assign(new EventEmitter(), { pid: 4242 });
        const m = new ServerRunMarker({ filePath: file, runId: "run", version: "2.1.3", logger: logger(), intervalMs: 30_000, now: () => clock, processRef: proc, hostname: "HOST1" });
        m.readPrevious();
        m.start();
        m.noteExitCodeRaised(1); // crash handler while RUNNING, awaiting its EMERGENCY email
        m.noteStopping("PRIMARY_DISCONNECT", 1, { unreported: true, reason: "PRIMARY_DISCONNECT" });
        proc.emit("exit", 1);
        const rec = JSON.parse(fs.readFileSync(file, "utf8"));
        expect(rec.stopReason).toBe("CRASH");
        expect(rec.unreported).toBeUndefined();
        m.stop();
    });

    it("a reason never replaces a real crash or forced exit", function () {
        const proc = Object.assign(new EventEmitter(), { pid: 4242 });
        const m = new ServerRunMarker({ filePath: file, runId: "run", version: "2.1.3", logger: logger(), intervalMs: 30_000, now: () => clock, processRef: proc, hostname: "HOST1" });
        m.readPrevious();
        m.start();
        m.noteStopping("uncaughtException", 1);
        m.noteExitCodeRaised(1, { reason: "PRIMARY_DISCONNECT" });
        proc.emit("exit", 1);
        expect(JSON.parse(fs.readFileSync(file, "utf8")).stopReason).toBe("CRASH");
        m.stop();
    });
});

describe("review M2 - recipient lookup while the database is the thing that hung", function () {
    const RecipientResolver = require("../../../../src/services/email/RecipientResolver");
    const ServerNotificationService = require("../../../../src/services/email/ServerNotificationService");
    const AdminModel = require("../../../../src/models/admin.model");
    let savedTo;
    beforeEach(() => {
        savedTo = process.env.SERVER_NOTIFY_TO;
        process.env.SERVER_NOTIFY_TO = "ops-floor@example.invalid";
        RecipientResolver._cache = new Map();
        RecipientResolver._lastRefreshAt = 0;
        RecipientResolver._refreshPromise = null;
    });
    afterEach(() => {
        if (savedTo === undefined) delete process.env.SERVER_NOTIFY_TO;
        else process.env.SERVER_NOTIFY_TO = savedTo;
        vi.restoreAllMocks();
        RecipientResolver._refreshPromise = null;
        RecipientResolver._lastRefreshAt = 0;
    });

    it("a hung opt-in query does not hold the env-floor recipients past a short bound (well under the 5 s send race)", async function () {
        vi.spyOn(AdminModel, "findServerNotifyRecipients").mockImplementation(() => new Promise(() => {}));
        const t0 = Date.now();
        const result = await Promise.race([
            ServerNotificationService.resolveRecipients("server-system-notification"),
            new Promise((r) => setTimeout(() => r("STILL_WAITING"), 4000)),
        ]);
        expect(result, "resolveRecipients waited on the hung DB query").not.toBe("STILL_WAITING");
        expect(result).toContain("ops-floor@example.invalid");
        expect(Date.now() - t0).toBeLessThan(4000);
    }, 10_000);

    it("a hung refresh counts as database down: SERVER_NOTIFY_TO only, cached opt-ins not mailed", async function () {
        RecipientResolver._cache = new Map([["server-system-notification", ["optin@example.invalid"]]]);
        RecipientResolver._lastRefreshAt = 0; // stale
        vi.spyOn(AdminModel, "findServerNotifyRecipients").mockImplementation(() => new Promise(() => {}));
        const result = await ServerNotificationService.resolveRecipients("server-system-notification");
        expect(result).toEqual(["ops-floor@example.invalid"]);
    }, 10_000);

    it("fake clock: getDbRecipients resolves at REFRESH_WAIT_MS (>= 2000, < 2500) with the last-known-good list and one RECIPIENT_REFRESH_WAIT_EXCEEDED warning {_noNotify:true}", async function () {
        const { logger: appLogger } = require("../../../../src/utils/logger");
        const { notificationMessages } = require("../../../../src/constants/messages");
        expect(RecipientResolver.RecipientResolver.REFRESH_WAIT_MS).toBe(2000);
        RecipientResolver._cache = new Map([["server-system-notification", ["optin@example.invalid"]]]);
        RecipientResolver._lastRefreshAt = 0; // stale -> refresh starts and hangs
        const hung = vi.spyOn(AdminModel, "findServerNotifyRecipients").mockImplementation(() => new Promise(() => {}));
        const warn = vi.spyOn(appLogger, "warning").mockImplementation(() => {});
        vi.useFakeTimers();
        try {
            const t0 = Date.now();
            let settledAt = null;
            let value;
            const p = RecipientResolver.getDbRecipients("server-system-notification").then((v) => {
                settledAt = Date.now();
                value = v;
            });
            await vi.advanceTimersByTimeAsync(1999);
            expect(settledAt, "resolved before the bound").toBeNull();
            expect(warn).not.toHaveBeenCalledWith(notificationMessages.RECIPIENT_REFRESH_WAIT_EXCEEDED(2000), expect.anything());
            await vi.advanceTimersByTimeAsync(1);
            await p;
            expect(hung).toHaveBeenCalled();
            expect(settledAt - t0).toBeGreaterThanOrEqual(2000);
            expect(settledAt - t0).toBeLessThan(2500);
            expect(value).toEqual(["optin@example.invalid"]);
            const exceeded = warn.mock.calls.filter(([msg]) => msg === notificationMessages.RECIPIENT_REFRESH_WAIT_EXCEEDED(2000));
            expect(exceeded).toHaveLength(1);
            expect(exceeded[0][1]).toEqual({ _noNotify: true });
        } finally {
            vi.useRealTimers();
        }
    });
});
