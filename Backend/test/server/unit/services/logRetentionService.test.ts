import { promises as fsp } from "fs";
import os from "os";
import path from "path";

import { LogRetentionService } from "../../../../src/services/LogRetentionService";
import { logger } from "../../../../src/utils/logger";

const DAY = 24 * 60 * 60 * 1000;
let root: string;
let svc: LogRetentionService;

const pad = (n: number) => String(n).padStart(2, "0");
async function mkDay(date: Date, files: Record<string, string> = { "app.log": "x" }) {
    const dir = path.join(root, String(date.getFullYear()), pad(date.getMonth() + 1), pad(date.getDate()));
    await fsp.mkdir(dir, { recursive: true });
    for (const [name, body] of Object.entries(files)) await fsp.writeFile(path.join(dir, name), body);
    return dir;
}
const daysAgo = (n: number) => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate() - n); };
const exists = (p: string) => fsp.stat(p).then(() => true, () => false);

beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "logret-"));
    svc = new LogRetentionService({ logBaseDir: root });
    process.env.LOG_RETENTION_DAYS = "10";
    vi.spyOn(logger, "notice").mockImplementation(() => undefined as never);
    vi.spyOn(logger, "warning").mockImplementation(() => undefined as never);
});
afterEach(async () => {
    svc.stop();
    delete process.env.LOG_RETENTION_DAYS;
    vi.useRealTimers();
    vi.restoreAllMocks();
    await fsp.rm(root, { recursive: true, force: true });
});

describe("LogRetentionService._retentionDays", () => {
    it.each([
        [undefined, 90], ["", 90], ["0", 0], ["7", 7], ["7.9", 7],
    ])("LOG_RETENTION_DAYS=%s -> %s with no warning", (raw, expected) => {
        if (raw === undefined) delete process.env.LOG_RETENTION_DAYS; else process.env.LOG_RETENTION_DAYS = raw;
        expect(svc._retentionDays()).toBe(expected);
        expect(logger.warning).not.toHaveBeenCalled();
    });

    it.each(["abc", "-3", "0.5", "Infinity"])("invalid %s falls back to 90 with a warning", (raw) => {
        process.env.LOG_RETENTION_DAYS = raw;
        expect(svc._retentionDays()).toBe(90);
        expect(logger.warning).toHaveBeenCalledTimes(1);
    });
});

describe("LogRetentionService lifecycle", () => {
    it("constructor falls back to the default log dir", () => {
        const s = new LogRetentionService();
        expect(s._logBaseDir).toBe(path.join(process.cwd(), "logs"));
    });

    it("start arms an unref'd timer, is idempotent, stop clears it", () => {
        expect(svc.start()).toEqual({ started: true });
        expect(svc._timer).not.toBeNull();
        expect(svc.start()).toEqual({ started: false, reason: "already-started" });
        svc.stop();
        expect(svc._timer).toBeNull();
        svc.stop(); // safe when never started
    });

    it("start is a no-op when retention is disabled", () => {
        process.env.LOG_RETENTION_DAYS = "0";
        expect(svc.start()).toEqual({ started: false, reason: "disabled" });
        expect(svc._timer).toBeNull();
    });

    it("sweeps at most once per calendar day", async () => {
        vi.useFakeTimers();
        const sweep = vi.spyOn(svc, "_runSweep").mockResolvedValue({ removedDays: 0, freedBytes: 0, failedDays: [] });
        svc.start();
        await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
        await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
        expect(sweep).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(DAY);
        expect(sweep.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it("a rejecting sweep never escapes the timer", async () => {
        vi.useFakeTimers();
        vi.spyOn(svc, "_runSweep").mockRejectedValue(new Error("boom"));
        svc.start();
        await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
        expect(svc._lastSweepDay).toBe(new Date().toDateString());
    });
});

describe("LogRetentionService._runSweep", () => {
    it("removes only directories strictly older than the cutoff and reports bytes", async () => {
        const old = await mkDay(daysAgo(30), { "a.log": "12345", "b.log": "123" });
        await fsp.mkdir(path.join(old, "sub"));
        await fsp.writeFile(path.join(old, "sub", "c.log"), "12");
        const edge = await mkDay(daysAgo(10));
        const recent = await mkDay(daysAgo(9));
        const today = await mkDay(daysAgo(0));

        const res = await svc._runSweep();
        expect(res).toEqual({ removedDays: 1, freedBytes: 10, failedDays: [] });
        expect(await exists(old)).toBe(false);
        expect(await exists(edge)).toBe(true);
        expect(await exists(recent)).toBe(true);
        expect(await exists(today)).toBe(true);
        expect(logger.notice).toHaveBeenCalledTimes(1);
    });

    it("is a no-op when disabled", async () => {
        process.env.LOG_RETENTION_DAYS = "0";
        const old = await mkDay(daysAgo(300));
        expect(await svc._runSweep()).toEqual({ removedDays: 0, freedBytes: 0, failedDays: [] });
        expect(await exists(old)).toBe(true);
    });

    it("returns an empty summary when the base dir does not exist", async () => {
        const s = new LogRetentionService({ logBaseDir: path.join(root, "nope") });
        expect(await s._runSweep()).toEqual({ removedDays: 0, freedBytes: 0, failedDays: [] });
    });

    it("prunes empty month and year dirs but never the base dir", async () => {
        const d = daysAgo(400);
        const dir = await mkDay(d);
        await svc._runSweep();
        expect(await exists(path.dirname(dir))).toBe(false);
        expect(await exists(path.join(root, String(d.getFullYear())))).toBe(false);
        expect(await exists(root)).toBe(true);
    });

    it("skips non-numeric, stray-file and impossible-calendar entries", async () => {
        await fsp.mkdir(path.join(root, "archive", "01", "01"), { recursive: true });
        await fsp.writeFile(path.join(root, "2020"), "file-named-like-year");
        await fsp.writeFile(path.join(root, "1999x"), "x");
        const badMonth = path.join(root, "2020", "13", "01");
        const badDay = path.join(root, "2020", "02", "31");
        const monthFile = path.join(root, "2020", "05");
        await fsp.rm(path.join(root, "2020"), { force: true });
        await fsp.mkdir(badMonth, { recursive: true });
        await fsp.mkdir(badDay, { recursive: true });
        await fsp.writeFile(monthFile, "f");
        await fsp.mkdir(path.join(root, "2020", "06", "dayfile"), { recursive: true });
        await fsp.writeFile(path.join(root, "2020", "06", "15"), "file not dir");
        await fsp.mkdir(path.join(root, "2020", "xx"), { recursive: true });

        const res = await svc._runSweep();
        expect(res.removedDays).toBe(0);
        expect(await exists(badMonth)).toBe(true);
        expect(await exists(badDay)).toBe(true);
        expect(await exists(path.join(root, "archive", "01", "01"))).toBe(true);
    });

    it("skips unreadable year and month dirs", async () => {
        const dir = await mkDay(daysAgo(50));
        const real = fsp.readdir.bind(fsp);
        let calls = 0;
        vi.spyOn(fsp, "readdir").mockImplementation(((p: any, o: any) => {
            calls++;
            if (calls === 2 || calls === 3) return Promise.reject(new Error("EACCES"));
            return real(p, o);
        }) as never);
        const first = await svc._runSweep();
        expect(first.removedDays).toBe(0);
        calls = 10; // pass-through for the second month-level failure
        expect(await exists(dir)).toBe(true);
    });

    it("skips an unreadable month dir but keeps going", async () => {
        const dir = await mkDay(daysAgo(50));
        const real = fsp.readdir.bind(fsp);
        let calls = 0;
        vi.spyOn(fsp, "readdir").mockImplementation(((p: any, o: any) => {
            calls++;
            if (calls === 3) return Promise.reject(new Error("EACCES"));
            return real(p, o);
        }) as never);
        expect((await svc._runSweep()).removedDays).toBe(0);
        expect(await exists(dir)).toBe(true);
    });

    it("converts an unexpected exception into a warning and a summary", async () => {
        vi.spyOn(Date.prototype, "getFullYear").mockImplementation(() => { throw new Error("clock exploded"); });
        const res = await svc._runSweep();
        expect(res).toEqual({ removedDays: 0, freedBytes: 0, failedDays: [] });
        expect(logger.warning).toHaveBeenCalledTimes(1);
    });

    it("formats freed bytes in KB/MB/GB in the notice", async () => {
        const dir = await mkDay(daysAgo(40), { "a.log": "x" });
        vi.spyOn(svc, "_removeDayDir").mockResolvedValue({ ok: true, freedBytes: 3 * 1024 ** 3 });
        await svc._runSweep();
        expect(await exists(dir)).toBe(true);
        expect(logger.notice).toHaveBeenCalledWith(expect.stringContaining("3.00 GB"));
        vi.mocked(logger.notice).mockClear();
        vi.spyOn(svc, "_removeDayDir").mockResolvedValue({ ok: true, freedBytes: 1536 });
        await svc._runSweep();
        expect(logger.notice).toHaveBeenCalledWith(expect.stringContaining("1.50 KB"));
        vi.mocked(logger.notice).mockClear();
        vi.spyOn(svc, "_removeDayDir").mockResolvedValue({ ok: true, freedBytes: 5 * 1024 ** 2 });
        await svc._runSweep();
        expect(logger.notice).toHaveBeenCalledWith(expect.stringContaining("5.00 MB"));
        vi.mocked(logger.notice).mockClear();
        vi.spyOn(svc, "_removeDayDir").mockResolvedValue({ ok: true, freedBytes: 2 * 1024 ** 4 });
        await svc._runSweep();
        expect(logger.notice).toHaveBeenCalledWith(expect.stringContaining("2.00 TB"));
        vi.mocked(logger.notice).mockClear();
        vi.spyOn(svc, "_removeDayDir").mockResolvedValue({ ok: true, freedBytes: 12 });
        await svc._runSweep();
        expect(logger.notice).toHaveBeenCalledWith(expect.stringContaining("12 B"));
    });

    it("does not count a vanished directory", async () => {
        await mkDay(daysAgo(40));
        vi.spyOn(svc, "_removeDayDir").mockResolvedValue({ ok: false, vanished: true, freedBytes: 0 });
        expect(await svc._runSweep()).toEqual({ removedDays: 0, freedBytes: 0, failedDays: [] });
        expect(logger.notice).not.toHaveBeenCalled();
    });

    it("aborts after 5 failed days with a single budget warning", async () => {
        for (let i = 20; i < 28; i++) await mkDay(daysAgo(i));
        const remove = vi.spyOn(svc, "_removeDayDir").mockResolvedValue({ ok: false, freedBytes: 0 });
        const res = await svc._runSweep();
        expect(res.failedDays).toHaveLength(5);
        expect(remove).toHaveBeenCalledTimes(5);
        expect(logger.warning).toHaveBeenCalledTimes(1);
    });

    it("budget abort stops across months and years too", async () => {
        await mkDay(new Date(2001, 0, 1));
        await mkDay(new Date(2001, 1, 1));
        await mkDay(new Date(2002, 0, 1));
        await mkDay(new Date(2003, 0, 1));
        for (const day of [2, 3, 4, 5]) await mkDay(new Date(2001, 0, day));
        const remove = vi.spyOn(svc, "_removeDayDir").mockResolvedValue({ ok: false, freedBytes: 0 });
        const res = await svc._runSweep();
        expect(res.failedDays).toHaveLength(5);
        expect(remove).toHaveBeenCalledTimes(5);
    });
});

describe("LogRetentionService._removeDayDir / _sumDirBytes", () => {
    it("reports vanished when the dir is already gone", async () => {
        expect(await svc._removeDayDir(path.join(root, "gone"), "x")).toEqual({ ok: false, vanished: true, freedBytes: 0 });
    });

    it("removes a dir and returns the summed size", async () => {
        const dir = await mkDay(daysAgo(40), { "a.log": "abcd" });
        expect(await svc._removeDayDir(dir, "l")).toEqual({ ok: true, freedBytes: 4 });
        expect(await exists(dir)).toBe(false);
    });

    it("still removes when size accounting fails", async () => {
        const dir = await mkDay(daysAgo(40));
        vi.spyOn(svc, "_sumDirBytes").mockRejectedValue(new Error("x"));
        expect(await svc._removeDayDir(dir, "l")).toEqual({ ok: true, freedBytes: 0 });
    });

    it("retries rm once after the delay and succeeds", async () => {
        const dir = await mkDay(daysAgo(40));
        const real = fsp.rm.bind(fsp);
        vi.useFakeTimers({ toFake: ["setTimeout"] });
        const rm = vi.spyOn(fsp, "rm").mockRejectedValueOnce(new Error("EBUSY")).mockImplementation(real as never);
        const p = svc._removeDayDir(dir, "l");
        await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
        await vi.advanceTimersByTimeAsync(250);
        expect((await p).ok).toBe(true);
        expect(rm).toHaveBeenCalledTimes(2);
    });

    it("fails with the rm error when both attempts fail", async () => {
        const dir = await mkDay(daysAgo(40));
        vi.useFakeTimers({ toFake: ["setTimeout"] });
        vi.spyOn(fsp, "rm").mockRejectedValue(new Error("EBUSY locked"));
        const p = svc._removeDayDir(dir, "2020-01-01");
        await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
        await vi.advanceTimersByTimeAsync(250);
        expect(await p).toEqual({ ok: false, freedBytes: 0 });
        expect(logger.warning).toHaveBeenCalledWith(expect.stringContaining("EBUSY locked"));
    });

    it("fails when rm resolves but the directory is still present (Windows AV case)", async () => {
        const dir = await mkDay(daysAgo(40));
        vi.spyOn(fsp, "rm").mockResolvedValue(undefined);
        expect(await svc._removeDayDir(dir, "l")).toEqual({ ok: false, freedBytes: 0 });
        expect(logger.warning).toHaveBeenCalledWith(expect.stringContaining("still present"));
    });

    it("_sumDirBytes skips files that vanish before stat and ignores non-files", async () => {
        const dir = await mkDay(daysAgo(40), { "a.log": "abc" });
        const real = fsp.stat.bind(fsp);
        vi.spyOn(fsp, "stat").mockImplementation(((p: any) => String(p).endsWith("a.log") ? Promise.reject(new Error("ENOENT")) : real(p)) as never);
        expect(await svc._sumDirBytes(dir)).toBe(0);
    });
});
