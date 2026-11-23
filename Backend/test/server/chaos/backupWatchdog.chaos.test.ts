import { promises as fsp } from "fs";
import os from "os";
import path from "path";

import BackupStoreService from "../../../src/services/BackupStoreService";
import BackupArchiveService from "../../../src/services/BackupArchiveService";
import { defaultIdleWatchdog } from "../../../src/utils/progress/IdleWatchdog";
import { logger } from "../../../src/utils/logger";
import { AppError } from "../../../src/constants/errors";

const BS = BackupStoreService;
let dir: string;
const saved: Record<string, string | undefined> = {};

const deferred = <T = void>() => {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
};
const built = () => ({ zipBuffer: Buffer.from("ZIP"), manifest: { mode: "FULL", chain: null }, totalRows: 1, tableCount: 1, includedCount: 1, unchangedCount: 0 });
const flush = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
/** Fires the process-wide idle watchdog as if `ms` of silence had elapsed. */
const stallBy = (ms: number) => defaultIdleWatchdog.sweep(Date.now() + ms);

beforeEach(async () => {
    for (const k of ["DB_BACKUP_DIR", "DB_BACKUP_IDLE_TIMEOUT_MS"]) saved[k] = process.env[k];
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "bkchaos-"));
    process.env.DB_BACKUP_DIR = dir;
    process.env.DB_BACKUP_IDLE_TIMEOUT_MS = "65000";
    BS.invalidateIndex();
    for (const lvl of ["info", "notice", "warning", "error", "critical", "debug"] as const) {
        vi.spyOn(logger, lvl).mockImplementation(() => undefined as never);
    }
});
afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await fsp.rm(dir, { recursive: true, force: true });
});

describe("backup watchdog: stall while building", () => {
    it("cancels a hung scheduled build with BACKUP_STALLED, logs CRITICAL, releases the lease and lets the next run proceed", async () => {
        const hang = deferred<never>();
        const build = vi.spyOn(BackupArchiveService, "buildScheduledBackup").mockReturnValueOnce(hang.promise as never);
        const run = BS.runBackup({ trigger: "SCHEDULED", event: "NIGHTLY", eventId: 1, tables: ["T"] }).then(() => null, (e) => e);
        await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(1));
        stallBy(70_000);
        const err: any = await run;
        expect(err).toBeInstanceOf(AppError);
        expect(err.statusCode).toBe(503);
        expect(logger.critical).toHaveBeenCalledTimes(1);
        expect(logger.error).not.toHaveBeenCalled();
        expect(await fsp.readdir(dir)).toEqual([]); // lease file released, nothing published

        build.mockResolvedValueOnce(built() as never);
        const next = await BS.runBackup({ trigger: "SCHEDULED", tables: ["T"] });
        expect(next.sizeBytes).toBe(3);
        hang.resolve(undefined as never);
    });

    it("a manual backup stall is logged as ERROR, not CRITICAL", async () => {
        const hang = deferred<never>();
        const build = vi.spyOn(BackupArchiveService, "buildScheduledBackup").mockReturnValueOnce(hang.promise as never);
        const run = BS.runBackup({ trigger: "MANUAL", tables: ["T"] }).then(() => null, (e) => e);
        await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(1));
        stallBy(70_000);
        expect(((await run) as any).statusCode).toBe(503);
        expect(logger.error).toHaveBeenCalledTimes(1);
        expect(logger.critical).not.toHaveBeenCalled();
        hang.resolve(undefined as never);
    });

    it("does not cut a run that is still within its idle limit", async () => {
        const gate = deferred<ReturnType<typeof built>>();
        const build = vi.spyOn(BackupArchiveService, "buildScheduledBackup").mockReturnValueOnce(gate.promise as never);
        const run = BS.runBackup({ trigger: "SCHEDULED", tables: ["T"] });
        await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(1));
        stallBy(30_000);
        gate.resolve(built());
        await expect(run).resolves.toMatchObject({ sizeBytes: 3 });
        expect(logger.critical).not.toHaveBeenCalled();
    });
});

describe("backup watchdog: stall while publishing", () => {
    it("an in-flight write that finishes inside the settle window is reported as published after the cut", async () => {
        vi.spyOn(BackupArchiveService, "buildScheduledBackup").mockResolvedValue(built() as never);
        const gate = deferred();
        const realRename = fsp.rename.bind(fsp);
        const rename = vi.spyOn(fsp, "rename").mockImplementation((async (a: string, b: string) => { await gate.promise; return realRename(a, b); }) as never);
        const run = BS.runBackup({ trigger: "SCHEDULED", tables: ["T"], at: new Date("2026-03-04T05:06:07Z") });
        const settled = run.then((v) => v, (e) => e);
        await vi.waitFor(() => expect(rename).toHaveBeenCalled());
        stallBy(70_000);
        await flush(3);
        gate.resolve();
        const res: any = await settled;
        expect(res.filename).toBe("app-backup_scheduled_2026-03-04T05-06-07Z.zip");
        expect(await fsp.readFile(res.path, "utf8")).toBe("ZIP");
        expect(logger.warning).toHaveBeenCalled();
        expect(logger.critical).not.toHaveBeenCalled();
        expect(BS._indexCache).toBeNull();
    });

    it("a write that never settles is abandoned after CUT_SETTLE_MS and reported as cancelled", async () => {
        vi.spyOn(BackupArchiveService, "buildScheduledBackup").mockResolvedValue(built() as never);
        const never = deferred();
        vi.spyOn(fsp, "rename").mockImplementation((() => never.promise) as never);
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const settled = BS.runBackup({ trigger: "SCHEDULED", tables: ["T"] }).then((v) => v, (e) => e);
        await vi.waitFor(() => expect(fsp.rename).toHaveBeenCalled());
        stallBy(70_000);
        await vi.advanceTimersByTimeAsync(BS.CUT_SETTLE_MS);
        const err: any = await settled;
        expect(err.statusCode).toBe(503);
        expect(logger.critical).toHaveBeenCalledTimes(1);
        never.resolve();
    });

    it("a write aborted by the cut leaves no .part or final file", async () => {
        vi.spyOn(BackupArchiveService, "buildScheduledBackup").mockResolvedValue(built() as never);
        const gate = deferred();
        const realOpen = fsp.open.bind(fsp);
        vi.spyOn(fsp, "open").mockImplementation((async (p: string, flags: string) => {
            if (String(p).endsWith(".part")) await gate.promise;
            return realOpen(p, flags);
        }) as never);
        const openSpy = fsp.open as unknown as ReturnType<typeof vi.fn>;
        const settled = BS.runBackup({ trigger: "PURGE", tables: ["T"] }).then((v) => v, (e) => e);
        await vi.waitFor(() => expect(openSpy.mock.calls.some((c) => String(c[0]).endsWith(".part"))).toBe(true));
        stallBy(70_000);
        gate.resolve();
        const err: any = await settled;
        expect(err.statusCode).toBe(503);
        await flush();
        expect(await fsp.readdir(dir)).toEqual([]);
        expect(logger.error).toHaveBeenCalled();
    });
});

describe("_resolveCut", () => {
    const stall = { idleMs: 90_000, lastSource: "db-query" };
    const cutErr = new Error("cut");

    it("rethrows the cut error when the archive file exists but the publish never produced a result", async () => {
        const filePath = path.join(dir, "late.zip");
        await fsp.writeFile(filePath, "late");
        const publishing = Promise.reject(new Error("write failed")) as Promise<never>;
        publishing.catch(() => undefined);
        await expect(BS._resolveCut({ err: cutErr, stall, state: { publishing }, archiveId: "A", trigger: "SCHEDULED", filePath })).rejects.toBe(cutErr);
        expect(logger.warning).toHaveBeenCalledTimes(1);
    });

    it("returns the publish result when the file exists and the publish resolved", async () => {
        const filePath = path.join(dir, "late.zip");
        await fsp.writeFile(filePath, "late");
        const result = { archiveId: "A" } as never;
        await expect(BS._resolveCut({ err: cutErr, stall, state: { publishing: Promise.resolve(result) }, archiveId: "A", trigger: "MANUAL", filePath })).resolves.toBe(result);
    });

    it("treats a stall before any publish started as a plain cancellation", async () => {
        await expect(BS._resolveCut({ err: cutErr, stall, state: { publishing: null }, archiveId: "A", trigger: "MANUAL", filePath: path.join(dir, "none.zip") })).rejects.toBe(cutErr);
        expect(logger.error).toHaveBeenCalledTimes(1);
    });
});

describe("runBackup serialisation under chaos", () => {
    it("a second backup queued behind a hung one runs after the hung one is cut", async () => {
        const hang = deferred<never>();
        const build = vi.spyOn(BackupArchiveService, "buildScheduledBackup")
            .mockReturnValueOnce(hang.promise as never)
            .mockResolvedValueOnce(built() as never);
        const first = BS.runBackup({ trigger: "SCHEDULED", event: "A", eventId: 1, tables: ["T"] }).then(() => null, (e) => e);
        await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(1));
        const second = BS.runBackup({ trigger: "SCHEDULED", event: "B", eventId: 2, tables: ["T"] });
        await flush(5);
        expect(build).toHaveBeenCalledTimes(1);
        stallBy(70_000);
        expect(((await first) as any).statusCode).toBe(503);
        await expect(second).resolves.toMatchObject({ sizeBytes: 3 });
        expect(build).toHaveBeenCalledTimes(2);
        hang.resolve(undefined as never);
    });
});
