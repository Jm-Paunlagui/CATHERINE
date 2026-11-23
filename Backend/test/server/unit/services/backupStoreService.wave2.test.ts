import { promises as fsp } from "fs";
import { createRequire } from "module";
import os from "os";
import path from "path";
import JSZip from "jszip";

import BackupStoreService from "../../../../src/services/BackupStoreService";
import { logger } from "../../../../src/utils/logger";
import { writeArchive } from "../../helpers/backupFixtures";

const BS = BackupStoreService;
const nativeRequire = createRequire(import.meta.url);
let dir: string;
const ENV_KEYS = ["DB_BACKUP_DIR", "DB_BACKUP_FULL_EVERY", "DEMO_MODE", "DB_BACKUP_IDLE_TIMEOUT_MS"];
const savedEnv: Record<string, string | undefined> = {};
const rejects = async (p: Promise<unknown>) => (await p.then(() => null, (e) => e)) as any;
const included = (rows: Record<string, unknown>[]) => ({ state: "INCLUDED" as const, rows });
const unchanged = (sourceArchiveId: string) => ({ state: "UNCHANGED" as const, rows: 1, sha256: "s", sourceArchiveId });

beforeEach(async () => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "bkstore2-"));
    process.env.DB_BACKUP_DIR = dir;
    BS.invalidateIndex();
    for (const lvl of ["info", "notice", "warning", "error", "critical", "debug"] as const) {
        vi.spyOn(logger, lvl).mockImplementation(() => undefined as never);
    }
});
afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
    await fsp.rm(dir, { recursive: true, force: true });
});

const entry = (archiveId: string, createdAt: string, extra: Record<string, unknown> = {}) =>
    ({ archiveId, createdAt, trigger: "SCHEDULED", chain: { baseArchiveId: "BASE", generation: 1 }, tables: {}, path: path.join(dir, `${archiveId}.zip`), ...extra }) as any;

describe("BackupStoreService wave2: chain decisions on sparse manifests", () => {
    it("honours DB_BACKUP_FULL_EVERY and treats a missing generation as 0", async () => {
        process.env.DB_BACKUP_FULL_EVERY = "2";
        const nogen = entry("H", "2026-02-01", { chain: { baseArchiveId: "BASE" } });
        vi.spyOn(BS, "_verifyArchiveFile").mockResolvedValue(true);
        const r = await BS._decideChain({ trigger: "SCHEDULED", index: [nogen] });
        expect(r).toMatchObject({ mode: "INCREMENTAL", chain: { baseArchiveId: "BASE", generation: 1 } });
        const capped = await BS._decideChain({ trigger: "SCHEDULED", index: [entry("H2", "2026-02-01", { chain: { baseArchiveId: "B", generation: 1 } })] });
        expect(capped.forcedFullReason).toMatch(/generation 2 >= DB_BACKUP_FULL_EVERY=2/);
    });

    it("continues the chain for a head with no tables and ignores UNCHANGED tables without a source", async () => {
        vi.spyOn(BS, "_verifyArchiveFile").mockResolvedValue(true);
        const bare = entry("H", "2026-02-01", { tables: undefined });
        expect(await BS._decideChain({ trigger: "MANUAL", index: [bare] })).toMatchObject({ mode: "INCREMENTAL", previousTableState: {} });
        const odd = entry("H", "2026-02-01", { tables: { T: { state: "UNCHANGED", rows: 1, sha256: "s" } } });
        const r = await BS._decideChain({ trigger: "MANUAL", index: [odd] });
        expect(r.mode).toBe("INCREMENTAL");
        expect(r.previousTableState.T).toEqual({ sha256: "s", sourceArchiveId: undefined });
    });

    it("maps INCLUDED tables to the head and UNCHANGED tables to their source", async () => {
        const verify = vi.spyOn(BS, "_verifyArchiveFile").mockResolvedValue(true);
        const src = entry("SRC", "2026-01-01");
        const head = entry("H", "2026-02-01", { tables: { A: { state: "INCLUDED", rows: 2, sha256: "a" }, B: unchanged("SRC") } });
        const r = await BS._decideChain({ trigger: "SCHEDULED", index: [src, head] });
        expect(r.previousTableState).toEqual({ A: { sha256: "a", sourceArchiveId: "H" }, B: { sha256: "s", sourceArchiveId: "SRC" } });
        expect(verify).toHaveBeenCalledTimes(2);
    });

    it("forces FULL when a referenced chain member is missing or fails verification", async () => {
        const head = entry("H", "2026-02-01", { tables: { B: unchanged("GONE") } });
        const verify = vi.spyOn(BS, "_verifyArchiveFile").mockResolvedValue(true);
        const missing = await BS._decideChain({ trigger: "SCHEDULED", index: [head] });
        expect(missing).toMatchObject({ mode: "FULL", chain: null });
        expect(missing.forcedFullReason).toContain('"GONE" is missing from disk');
        verify.mockImplementation(async (e: any) => e.archiveId !== "SRC");
        const bad = await BS._decideChain({ trigger: "SCHEDULED", index: [entry("SRC", "2026-01-01"), entry("H", "2026-02-01", { tables: { B: unchanged("SRC") } })] });
        expect(bad.forcedFullReason).toContain('"SRC" failed signature verification');
    });
});

describe("BackupStoreService wave2: verification and deletion on sparse manifests", () => {
    it("verifyArchive accepts an entry that declares no tables", async () => {
        const e = entry("H", "2026-02-01", { tables: undefined });
        vi.spyOn(BS, "getArchive").mockResolvedValue(e);
        vi.spyOn(BS, "_verifyArchiveFile").mockResolvedValue(true);
        expect(await BS.verifyArchive("H")).toEqual({ archiveId: "H", signatureValid: true, chainHealth: { valid: true, missing: [], invalid: [] } });
    });

    it("verifyArchive reports only the signature when the chain is healthy", async () => {
        vi.spyOn(BS, "getArchive").mockResolvedValue(entry("H", "2026-02-01"));
        vi.spyOn(BS, "_verifyArchiveFile").mockResolvedValue(false);
        const err = await rejects(BS.verifyArchive("H"));
        expect(err.statusCode).toBe(422);
        expect(err.details.map((d: any) => d.field)).toEqual(["signature"]);
    });

    it("deleteArchive tolerates other archives that declare no tables when checking dependents", async () => {
        await writeArchive(dir, { archiveId: "A", tables: { T: included([{ id: 1 }]) } });
        await writeArchive(dir, { archiveId: "B", tables: { T: included([{ id: 2 }]) } });
        const index = await BS._loadIndex({ force: true });
        vi.spyOn(BS, "_loadIndex").mockResolvedValue(index.map((e) => (e.archiveId === "B" ? { ...e, tables: undefined } : e)) as any);
        expect(await BS.deleteArchive("A")).toEqual({ archiveId: "A", filename: "A.zip" });
    });

    it("_verifyZipBuffer refuses a signature document that is JSON null or lacks a files map", async () => {
        const a = await writeArchive(dir, { archiveId: "SIG", tables: { T: included([{ id: 1 }]) } });
        for (const doc of ["null", '{"digest":"x"}', '{"files":"oops","digest":"x"}']) {
            const zip = await JSZip.loadAsync(a.zip);
            zip.file("signature.json", doc);
            expect(await BS._verifyZipBuffer(await zip.generateAsync({ type: "nodebuffer" }))).toBe(false);
        }
    });

    it("materialise treats a manifest without tables as an empty archive", async () => {
        await writeArchive(dir, { archiveId: "EMPTY", tables: {} });
        const out = await BS.materialise("EMPTY");
        expect(out.manifest.archiveId).toBe("EMPTY");
        const zip = await JSZip.loadAsync(out.zipBuffer);
        expect(Object.keys(zip.files).some((n) => n.startsWith("data/") && n.endsWith(".jsonl"))).toBe(false);
    });
});

describe("BackupStoreService wave2: listing with pending delete votes", () => {
    it("attaches the vote tally and the strict-majority requirement to the matching archive only", async () => {
        process.env.DEMO_MODE = "true";
        await writeArchive(dir, { archiveId: "VOTED", createdAt: "2026-02-01T00:00:00Z", tables: {} });
        await writeArchive(dir, { archiveId: "PLAIN", createdAt: "2026-01-01T00:00:00Z", tables: {} });
        // src reaches the model through its own native require, so seed that same instance.
        const Vote = nativeRequire("../../../../src/models/backup-vote.model").default;
        await Vote.castVote("VOTED", 11, 11);
        await Vote.castVote("VOTED", 12, 11);
        try {
            vi.spyOn(BS, "countActiveSuperAdmins").mockResolvedValue(5);
            const list = (await BS.listArchives()) as any[];
            const voted = list.find((e) => e.archiveId === "VOTED");
            expect(voted.deleteVote).toMatchObject({ requestedBy: 11, votesNeeded: 3, votesCast: 2 });
            expect(voted.deleteVote.voters.map((v: any) => v.votedBy)).toEqual([11, 12]);
            expect(list.find((e) => e.archiveId === "PLAIN").deleteVote).toBeNull();
        } finally {
            await Vote.cancelRequest("VOTED");
        }
    });
});

describe("BackupStoreService wave2: outcome of a watchdog cut", () => {
    const stall = { idleMs: 700_000, lastSource: "db" };
    const result = { archiveId: "R" } as any;

    it("returns a publish that completed after the cut and keeps the index fresh", async () => {
        const file = path.join(dir, "R.zip");
        await fsp.writeFile(file, "zip");
        BS._indexCache = [];
        const err = new Error("stalled");
        const out = await BS._resolveCut({ err, stall, state: { publishing: Promise.resolve(result) }, archiveId: "R", trigger: "SCHEDULED", filePath: file });
        expect(out).toBe(result);
        expect(BS._indexCache).toBeNull();
        expect(logger.warning).toHaveBeenCalledTimes(1);
    });

    it("throws the stall error when the file exists but the publish never settles", async () => {
        vi.useFakeTimers();
        const file = path.join(dir, "R.zip");
        await fsp.writeFile(file, "zip");
        const err = new Error("stalled");
        const p = BS._resolveCut({ err, stall, state: { publishing: new Promise(() => {}) }, archiveId: "R", trigger: "MANUAL", filePath: file }).catch((e) => e);
        await vi.advanceTimersByTimeAsync(BS.CUT_SETTLE_MS + 1);
        expect(await p).toBe(err);
        expect(logger.warning).toHaveBeenCalledTimes(1);
    });

    it("treats a rejected publish as unknown and, with nothing on disk, pages for SCHEDULED but only errors otherwise", async () => {
        const gone = path.join(dir, "none.zip");
        const err = new Error("stalled");
        const rejected = () => ({ publishing: Promise.reject(new Error("write failed")) });
        await expect(BS._resolveCut({ err, stall, state: rejected(), archiveId: "R", trigger: "SCHEDULED", filePath: gone })).rejects.toBe(err);
        expect(logger.critical).toHaveBeenCalledTimes(1);
        expect(logger.error).not.toHaveBeenCalled();
        await expect(BS._resolveCut({ err, stall, state: { publishing: null }, archiveId: "R", trigger: "PURGE", filePath: gone })).rejects.toBe(err);
        expect(logger.error).toHaveBeenCalledTimes(1);
        expect(logger.critical).toHaveBeenCalledTimes(1);
    });
});

describe("BackupStoreService wave2: idle limit and argument guards", () => {
    it("clamps and defaults DB_BACKUP_IDLE_TIMEOUT_MS, warning only when it changed the value", () => {
        delete process.env.DB_BACKUP_IDLE_TIMEOUT_MS;
        expect(BS._idleLimitMs()).toBe(600_000);
        process.env.DB_BACKUP_IDLE_TIMEOUT_MS = "";
        expect(BS._idleLimitMs()).toBe(600_000);
        process.env.DB_BACKUP_IDLE_TIMEOUT_MS = "120000";
        expect(BS._idleLimitMs()).toBe(120_000);
        expect(logger.warning).not.toHaveBeenCalled();
        process.env.DB_BACKUP_IDLE_TIMEOUT_MS = "1";
        expect(BS._idleLimitMs()).toBe(65_000);
        process.env.DB_BACKUP_IDLE_TIMEOUT_MS = "99999999";
        expect(BS._idleLimitMs()).toBe(3_600_000);
        process.env.DB_BACKUP_IDLE_TIMEOUT_MS = "abc";
        expect(BS._idleLimitMs()).toBe(600_000);
        expect(logger.warning).toHaveBeenCalledTimes(3);
    });

    it("runBackup rejects a bad trigger or an empty table list before touching the disk", async () => {
        await expect(BS.runBackup({ trigger: "WEEKLY" as never, tables: ["T"] })).rejects.toThrow(/trigger must be one of/);
        await expect(BS.runBackup({ trigger: "MANUAL", tables: [] })).rejects.toThrow(/non-empty array/);
        await expect(BS.runBackup({ trigger: "MANUAL", tables: undefined as never })).rejects.toThrow(/non-empty array/);
        expect(await fsp.readdir(dir)).toEqual([]);
    });
});
