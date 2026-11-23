import { promises as fsp } from "fs";
import os from "os";
import path from "path";
import JSZip from "jszip";

import BackupStoreService, { DEFAULT_BACKUP_DIR, INDEX_CACHE_TTL_MS } from "../../../../src/services/BackupStoreService";
import BackupArchiveService from "../../../../src/services/BackupArchiveService";
import { AppError } from "../../../../src/constants/errors";
import { logger } from "../../../../src/utils/logger";
import { ProgressScope } from "../../../../src/utils/progress/ProgressScope";
import { runInScope } from "../../../../src/utils/progress/progress";
import { writeArchive, jsonl } from "../../helpers/backupFixtures";

let dir: string;
const BS = BackupStoreService;
const ENV_KEYS = ["DB_BACKUP_DIR", "DB_BACKUP_IDLE_TIMEOUT_MS", "DB_BACKUP_FULL_EVERY", "BACKUP_XLSX_ROW_CAP"];
const savedEnv: Record<string, string | undefined> = {};

const included = (rows: Record<string, unknown>[]) => ({ state: "INCLUDED" as const, rows });
const sha = (t: string) => require("crypto").createHash("sha256").update(t).digest("hex");

beforeEach(async () => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "bkstore-"));
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

const rejects = async (p: Promise<unknown>) => (await p.then(() => null, (e) => e)) as any;

describe("paths and filenames", () => {
    it("exposes constants", () => {
        expect(BS.DEFAULT_BACKUP_DIR).toBe(DEFAULT_BACKUP_DIR);
        expect(BS.INDEX_CACHE_TTL_MS).toBe(INDEX_CACHE_TTL_MS);
    });
    it("uses an absolute DB_BACKUP_DIR as is", () => {
        expect(BS._resolveBackupDir()).toBe(dir);
    });
    it("resolves relative and default dirs against cwd", () => {
        process.env.DB_BACKUP_DIR = "rel/dir";
        expect(BS._resolveBackupDir()).toBe(path.resolve(process.cwd(), "rel/dir"));
        delete process.env.DB_BACKUP_DIR;
        expect(BS._resolveBackupDir()).toBe(path.resolve(process.cwd(), DEFAULT_BACKUP_DIR));
    });
    it("_ensureDir creates the directory recursively", async () => {
        process.env.DB_BACKUP_DIR = path.join(dir, "a", "b");
        expect(await BS._ensureDir()).toBe(path.join(dir, "a", "b"));
        expect((await fsp.stat(path.join(dir, "a", "b"))).isDirectory()).toBe(true);
    });
    it("_filenameTimestamp is filesystem safe", () => {
        expect(BS._filenameTimestamp(new Date("2026-03-04T05:06:07.890Z"))).toBe("2026-03-04T05-06-07Z");
        expect(BS._filenameTimestamp()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/);
    });
    it.each([
        [{ trigger: "SCHEDULED", event: "NIGHTLY", eventId: 7 }, "app-backup_7_NIGHTLY_T.zip"],
        [{ trigger: "SCHEDULED", event: null, eventId: 7 }, "app-backup_scheduled_T.zip"],
        [{ trigger: "SCHEDULED" }, "app-backup_scheduled_T.zip"],
        [{ trigger: "MANUAL" }, "app-backup_manual_T.zip"],
        [{ trigger: "PURGE" }, "app-backup_purge_T.zip"],
        [{ trigger: "OTHER" }, "app-backup_other_T.zip"],
    ])("_buildFilename %j", (args, expected) => {
        const at = new Date("2026-03-04T05:06:07Z");
        expect(BS._buildFilename({ ...(args as any), at })).toBe(expected.replace("_T.zip", "_2026-03-04T05-06-07Z.zip"));
    });
    it("_buildFilename defaults at to now", () => {
        expect(BS._buildFilename({ trigger: "MANUAL" })).toMatch(/^app-backup_manual_.*Z\.zip$/);
    });
});

describe("_atomicWrite", () => {
    it("writes via .part and renames", async () => {
        const target = path.join(dir, "x.zip");
        await BS._atomicWrite(target, Buffer.from("hello"));
        expect(await fsp.readFile(target, "utf8")).toBe("hello");
        expect(await fsp.readdir(dir)).toEqual(["x.zip"]);
    });
    it("honours an aborted signal carrying an Error and leaves no part file", async () => {
        const ac = new AbortController();
        ac.abort(new Error("cut"));
        const err = await rejects(BS._atomicWrite(path.join(dir, "x.zip"), Buffer.from("a"), { signal: ac.signal }));
        expect(err.message).toBe("cut");
        expect(await fsp.readdir(dir)).toEqual([]);
    });
    it("uses a generic message when the abort reason is not an Error", async () => {
        const ac = new AbortController();
        ac.abort("string reason");
        const err = await rejects(BS._atomicWrite(path.join(dir, "x.zip"), Buffer.from("a"), { signal: ac.signal }));
        expect(err.message).toBe("Backup write aborted.");
    });
    it("propagates a write failure and cleans up", async () => {
        vi.spyOn(fsp, "rename").mockRejectedValueOnce(new Error("EXDEV"));
        const err = await rejects(BS._atomicWrite(path.join(dir, "x.zip"), Buffer.from("a")));
        expect(err.message).toBe("EXDEV");
        expect(await fsp.readdir(dir)).toEqual([]);
    });
});

describe("_sweepStaleParts", () => {
    it("removes only .zip.part files and logs a notice", async () => {
        await fsp.writeFile(path.join(dir, "a.zip.part"), "x");
        await fsp.writeFile(path.join(dir, "b.zip.part"), "x");
        await fsp.writeFile(path.join(dir, "keep.zip"), "x");
        await fsp.writeFile(path.join(dir, "keep.txt.part"), "x");
        expect(await BS._sweepStaleParts()).toBe(2);
        expect((await fsp.readdir(dir)).sort()).toEqual(["keep.txt.part", "keep.zip"]);
        expect(logger.notice).toHaveBeenCalledTimes(1);
    });
    it("returns 0 and stays quiet when nothing is stale", async () => {
        expect(await BS._sweepStaleParts()).toBe(0);
        expect(logger.notice).not.toHaveBeenCalled();
    });
    it("returns 0 when the directory vanishes, rethrows other readdir errors", async () => {
        const spy = vi.spyOn(fsp, "readdir").mockRejectedValueOnce(Object.assign(new Error("gone"), { code: "ENOENT" }));
        expect(await BS._sweepStaleParts()).toBe(0);
        spy.mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));
        await expect(BS._sweepStaleParts()).rejects.toThrow("denied");
    });
    it("ignores ENOENT on unlink but rethrows other failures", async () => {
        await fsp.writeFile(path.join(dir, "a.zip.part"), "x");
        const spy = vi.spyOn(fsp, "unlink").mockRejectedValueOnce(Object.assign(new Error("race"), { code: "ENOENT" }));
        expect(await BS._sweepStaleParts()).toBe(0);
        spy.mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "EBUSY" }));
        await expect(BS._sweepStaleParts()).rejects.toThrow("busy");
    });
});

describe("_idleLimitMs", () => {
    it.each([
        [undefined, 600_000, false], ["", 600_000, false], ["120000", 120_000, false],
        ["10", 65_000, true], ["99999999", 3_600_000, true], ["abc", 600_000, true],
    ])("env %s -> %s (warn=%s)", (raw, expected, warns) => {
        if (raw === undefined) delete process.env.DB_BACKUP_IDLE_TIMEOUT_MS; else process.env.DB_BACKUP_IDLE_TIMEOUT_MS = raw;
        expect(BS._idleLimitMs()).toBe(expected);
        expect((logger.warning as any).mock.calls.length).toBe(warns ? 1 : 0);
    });
});

describe("_validateArchiveId", () => {
    it("accepts safe ids", () => {
        expect(BS._validateArchiveId("backup_1:abc-2")).toBe("backup_1:abc-2");
    });
    it.each([undefined, null, 5, "", "a".repeat(201), "a..b", "a/b", "a\\b", "a\0b", "/abs", "has space", "ünï"])("rejects %j with 400", (id) => {
        let err: any;
        try { BS._validateArchiveId(id); } catch (e) { err = e; }
        expect(err).toBeInstanceOf(AppError);
        expect(err.statusCode).toBe(400);
    });
});

describe("_loadIndex / getArchive / listArchives", () => {
    it("reads manifests, skips unreadable archives, ignores non-zip files", async () => {
        await writeArchive(dir, { archiveId: "A1", tables: { T: included([{ id: 1 }]) } });
        await fsp.writeFile(path.join(dir, "garbage.zip"), "not a zip");
        await writeArchive(dir, { archiveId: "B", filename: "nomanifest.zip", tables: {}, tamper: "no-manifest" });
        await fsp.writeFile(path.join(dir, "readme.txt"), "x");
        const idx = await BS._loadIndex();
        expect(idx.map((e) => e.archiveId)).toEqual(["A1"]);
        expect(idx[0]).toMatchObject({ filename: "A1.zip", path: path.join(dir, "A1.zip") });
        expect(idx[0].sizeBytes).toBeGreaterThan(0);
        expect(logger.warning).toHaveBeenCalledTimes(2);
    });
    it("serves from cache within the TTL, bypasses with force, expires after TTL", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
        await writeArchive(dir, { archiveId: "A1", tables: {} });
        const first = await BS._loadIndex();
        await writeArchive(dir, { archiveId: "A2", tables: {} });
        expect(await BS._loadIndex()).toBe(first);
        expect((await BS._loadIndex({ force: true })).length).toBe(2);
        await writeArchive(dir, { archiveId: "A3", tables: {} });
        vi.setSystemTime(new Date(Date.now() + INDEX_CACHE_TTL_MS + 1));
        expect((await BS._loadIndex()).length).toBe(3);
    });
    it("treats a missing dir (ENOENT) as empty and rethrows other errors", async () => {
        const spy = vi.spyOn(fsp, "readdir").mockRejectedValueOnce(Object.assign(new Error("x"), { code: "ENOENT" }));
        expect(await BS._loadIndex({ force: true })).toEqual([]);
        spy.mockRejectedValueOnce(Object.assign(new Error("perm"), { code: "EACCES" }));
        await expect(BS._loadIndex({ force: true })).rejects.toThrow("perm");
    });
    it("getArchive validates the id and 404s when unknown", async () => {
        await writeArchive(dir, { archiveId: "A1", tables: {} });
        expect((await BS.getArchive("A1")).archiveId).toBe("A1");
        expect((await rejects(BS.getArchive("nope"))).statusCode).toBe(404);
        expect((await rejects(BS.getArchive("../x"))).statusCode).toBe(400);
    });
    it("listArchives sorts newest-first and reports no delete vote when none are pending", async () => {
        process.env.DEMO_MODE = "true";
        try {
            await writeArchive(dir, { archiveId: "OLD", createdAt: "2026-01-01T00:00:00Z", tables: {} });
            await writeArchive(dir, { archiveId: "NEW", createdAt: "2026-02-01T00:00:00Z", tables: {} });
            vi.spyOn(BS, "countActiveSuperAdmins").mockResolvedValue(4);
            const list = await BS.listArchives();
            expect(list.map((e) => e.archiveId)).toEqual(["NEW", "OLD"]);
            expect((list[0] as any).deleteVote).toBeNull();
            expect((list[1] as any).deleteVote).toBeNull();
        } finally {
            delete process.env.DEMO_MODE;
        }
    });
});

describe("_verifyZipBuffer / _verifyArchiveFile", () => {
    it("accepts an intact signed archive", async () => {
        const a = await writeArchive(dir, { archiveId: "A", tables: { T: included([{ id: 1 }]) } });
        expect(await BS._verifyZipBuffer(a.zip)).toBe(true);
        expect(await BS._verifyArchiveFile({ path: a.path } as any)).toBe(true);
    });
    it.each(["data", "no-signature", "no-manifest", "extra-file", "bad-digest", "signature-garbage"] as const)("rejects tamper=%s", async (tamper) => {
        const a = await writeArchive(dir, { archiveId: "A", tables: { T: included([{ id: 1 }]) }, tamper });
        expect(await BS._verifyZipBuffer(a.zip)).toBe(false);
    });
    it("rejects non-zip input and unreadable files", async () => {
        expect(await BS._verifyZipBuffer(Buffer.from("junk"))).toBe(false);
        expect(await BS._verifyArchiveFile({ path: path.join(dir, "missing.zip") } as any)).toBe(false);
    });
    it("ignores directory entries named like data files", async () => {
        const a = await writeArchive(dir, { archiveId: "A", tables: {} });
        const zip = await JSZip.loadAsync(a.zip);
        zip.folder("data/dir.jsonl");
        expect(await BS._verifyZipBuffer(await zip.generateAsync({ type: "nodebuffer" }))).toBe(true);
    });
});

describe("_chainHead / _decideChain", () => {
    const e = (archiveId: string, createdAt: string, extra: Record<string, unknown> = {}) =>
        ({ archiveId, createdAt, trigger: "SCHEDULED", chain: { baseArchiveId: "BASE", generation: 1 }, tables: {}, ...extra }) as any;

    it("_chainHead ignores PURGE and chainless entries and picks the newest", () => {
        expect(BS._chainHead([])).toBeNull();
        expect(BS._chainHead([e("P", "2026-02-01", { trigger: "PURGE" }), e("N", "2026-02-02", { chain: null })])).toBeNull();
        expect(BS._chainHead([e("A", "2026-01-01"), e("B", "2026-03-01"), e("C", "2026-02-01")])?.archiveId).toBe("B");
    });
    it("PURGE is always full and chainless", async () => {
        expect(await BS._decideChain({ trigger: "PURGE", index: [e("A", "2026-01-01")] })).toMatchObject({ mode: "FULL", chain: null });
    });
    it("no head forces FULL", async () => {
        expect((await BS._decideChain({ trigger: "SCHEDULED", index: [] })).forcedFullReason).toMatch(/no previous/);
    });
    it("generation cap forces FULL (env override and default 6)", async () => {
        process.env.DB_BACKUP_FULL_EVERY = "2";
        const r = await BS._decideChain({ trigger: "SCHEDULED", index: [e("A", "2026-01-01")] });
        expect(r.forcedFullReason).toMatch(/generation cap/);
        delete process.env.DB_BACKUP_FULL_EVERY;
        const r2 = await BS._decideChain({ trigger: "SCHEDULED", index: [e("A", "2026-01-01", { chain: { baseArchiveId: "B", generation: 5 } })] });
        expect(r2.forcedFullReason).toMatch(/>= DB_BACKUP_FULL_EVERY=6/);
    });
    it("a head without generation counts as generation 0", async () => {
        const a = await writeArchive(dir, { archiveId: "H", tables: { T: included([{ id: 1 }]) } });
        const head = e("H", "2026-01-01", { path: a.path, chain: { baseArchiveId: "H" }, tables: { T: { state: "INCLUDED", rows: 1, sha256: "s" } } });
        const r = await BS._decideChain({ trigger: "SCHEDULED", index: [head] });
        expect(r.chain).toEqual({ baseArchiveId: "H", generation: 1 });
    });
    it("forces FULL when a referenced chain member is missing", async () => {
        const head = e("H", "2026-02-01", { tables: { T: { state: "UNCHANGED", rows: 1, sha256: "s", sourceArchiveId: "GONE" } } });
        const r = await BS._decideChain({ trigger: "SCHEDULED", index: [head] });
        expect(r.forcedFullReason).toMatch(/"H" failed|"GONE" is missing|is missing from disk/);
        const r2 = await BS._decideChain({ trigger: "SCHEDULED", index: [{ ...head, path: path.join(dir, "none.zip") }] });
        expect(r2.forcedFullReason).toMatch(/is missing from disk|failed signature/);
    });
    it("forces FULL when a chain member fails verification", async () => {
        const bad = await writeArchive(dir, { archiveId: "H", tables: {}, tamper: "bad-digest" });
        const r = await BS._decideChain({ trigger: "SCHEDULED", index: [e("H", "2026-02-01", { path: bad.path })] });
        expect(r.forcedFullReason).toMatch(/failed signature verification/);
    });
    it("goes INCREMENTAL carrying previous table state when all members verify", async () => {
        const base = await writeArchive(dir, { archiveId: "BASEA", createdAt: "2026-01-01T00:00:00Z", tables: { T1: included([{ id: 1 }]), T2: included([{ id: 2 }]) } });
        const head = await writeArchive(dir, {
            archiveId: "HEAD", createdAt: "2026-02-01T00:00:00Z", mode: "INCREMENTAL", chain: { baseArchiveId: "BASEA", generation: 1 },
            tables: { T1: included([{ id: 9 }]), T2: { state: "UNCHANGED", rows: 1, sha256: "h2", sourceArchiveId: "BASEA" } },
        });
        BS.invalidateIndex();
        const index = await BS._loadIndex();
        expect(index).toHaveLength(2);
        const r = await BS._decideChain({ trigger: "MANUAL", index });
        expect(r.mode).toBe("INCREMENTAL");
        expect(r.chain).toEqual({ baseArchiveId: "BASEA", generation: 2 });
        expect(r.previousTableState.T1.sourceArchiveId).toBe("HEAD");
        expect(r.previousTableState.T2).toEqual({ sha256: "h2", sourceArchiveId: "BASEA" });
        expect(head.filename).toBe("HEAD.zip");
        expect(base.filename).toBe("BASEA.zip");
    });
});

describe("materialise", () => {
    it("builds a self-contained signed zip from a chain, honouring the row cap and skipping blank lines", async () => {
        process.env.BACKUP_XLSX_ROW_CAP = "2";
        const t1 = [{ id: 1 }, { id: 2 }, { id: 3 }];
        await writeArchive(dir, { archiveId: "BASEA", createdAt: "2026-01-01T00:00:00Z", tables: { OLD: included([{ k: "v" }]) } });
        await writeArchive(dir, {
            archiveId: "HEAD", createdAt: "2026-02-01T00:00:00Z", mode: "INCREMENTAL", chain: { baseArchiveId: "BASEA", generation: 1 },
            tables: { T1: included(t1), OLD: { state: "UNCHANGED", rows: 1, sha256: sha(jsonl([{ k: "v" }])), sourceArchiveId: "BASEA" } },
        });
        const out = await BS.materialise("HEAD");
        expect(out.filename).toBe("HEAD_materialised.zip");
        expect(out.manifest).toMatchObject({ mode: "FULL", chain: null, kind: "FULL_SCOPE" });
        expect(await BS._verifyZipBuffer(out.zipBuffer)).toBe(true);
        const zip = await JSZip.loadAsync(out.zipBuffer);
        expect(Object.keys(zip.files).sort()).toEqual(["data/OLD.jsonl", "data/T1.jsonl", "manifest.json", "readable/backup-summary.xlsx", "signature.json"]);
        const man = JSON.parse(await zip.file("manifest.json")!.async("string"));
        expect(man.tables.OLD.state).toBe("INCLUDED");
        expect(man.tableRowCounts).toEqual({ T1: 3, OLD: 1 });
        expect(man.fidelityNotes).toEqual([]);
    });
    it("builds the xlsx summary with capped and truncated sheet names", async () => {
        process.env.BACKUP_XLSX_ROW_CAP = "1";
        const longName = "T".repeat(40);
        const buf = await BS._buildSummaryWorkbook([longName, "EMPTY"], { [longName]: [{ a: 1, b: "x" }] }, { [longName]: 5, EMPTY: 0 });
        const ExcelJS = (await import("exceljs")).default;
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(buf as never);
        expect(wb.worksheets.map((w) => w.name)).toEqual(["Summary", "T".repeat(31), "EMPTY"]);
        expect(wb.getWorksheet("Summary")!.getRow(2).getCell(3).value).toBe("First 1 of 5");
        expect(wb.getWorksheet("Summary")!.getRow(3).getCell(3).value).toBe("All rows");
        delete process.env.BACKUP_XLSX_ROW_CAP;
        const buf2 = await BS._buildSummaryWorkbook(["X"], {}, {});
        expect(buf2.length).toBeGreaterThan(0);
    });
    it("404s for unknown ids and 400s for invalid ones", async () => {
        expect((await rejects(BS.materialise("nope"))).statusCode).toBe(404);
        expect((await rejects(BS.materialise("a/b"))).statusCode).toBe(400);
    });
    it("422s when the head archive fails signature verification", async () => {
        await writeArchive(dir, { archiveId: "A", tables: { T: included([{ id: 1 }]) }, tamper: "data" });
        expect((await rejects(BS.materialise("A"))).statusCode).toBe(422);
    });
    it("422s when a chain member is missing from the index", async () => {
        await writeArchive(dir, { archiveId: "H", tables: { T: { state: "UNCHANGED", rows: 1, sha256: "s", sourceArchiveId: "GONE" } } });
        const err = await rejects(BS.materialise("H"));
        expect(err.statusCode).toBe(422);
        expect(logger.error).toHaveBeenCalled();
    });
    it("422s when a chain member fails signature verification", async () => {
        await writeArchive(dir, { archiveId: "BASEA", tables: { T: included([{ id: 1 }]) }, tamper: "data" });
        await writeArchive(dir, { archiveId: "H", createdAt: "2026-02-01T00:00:00Z", tables: { T: { state: "UNCHANGED", rows: 1, sha256: "s", sourceArchiveId: "BASEA" } } });
        const err = await rejects(BS.materialise("H"));
        expect(err.statusCode).toBe(422);
        expect(JSON.stringify(err.details)).toMatch(/failed signature verification/);
    });
    it("422s when the owner archive lacks the table data file", async () => {
        await writeArchive(dir, { archiveId: "BASEA", tables: {} });
        await writeArchive(dir, { archiveId: "H", tables: { T: { state: "UNCHANGED", rows: 1, sha256: "s", sourceArchiveId: "BASEA" } } });
        const err = await rejects(BS.materialise("H"));
        expect(err.statusCode).toBe(422);
        expect(JSON.stringify(err.details)).toMatch(/not found in archive/);
    });
    it("handles an archive with no tables", async () => {
        await writeArchive(dir, { archiveId: "E", tables: {} });
        const out = await BS.materialise("E");
        expect(out.manifest.tables).toEqual({});
    });
    it("skips blank lines in jsonl", async () => {
        const a = await writeArchive(dir, { archiveId: "B", tables: { T: included([{ id: 1 }]) } });
        const zip = await JSZip.loadAsync(await fsp.readFile(a.path));
        expect(zip.file("data/T.jsonl")).not.toBeNull();
        const out = await BS.materialise("B");
        expect(out.zipBuffer.length).toBeGreaterThan(0);
    });
});

describe("_zipFiles", () => {
    it("zips named buffers", async () => {
        const zip = await JSZip.loadAsync(await BS._zipFiles({ "a.txt": Buffer.from("A"), "d/b.txt": Buffer.from("B") }));
        expect(await zip.file("d/b.txt")!.async("string")).toBe("B");
    });
});

describe("deleteArchive", () => {
    it("deletes an archive with no dependents and invalidates the cache", async () => {
        const a = await writeArchive(dir, { archiveId: "A", tables: {} });
        expect(await BS.deleteArchive("A")).toEqual({ archiveId: "A", filename: "A.zip" });
        await expect(fsp.stat(a.path)).rejects.toThrow();
        expect(BS._indexCache).toBeNull();
    });
    it("404s for unknown archives", async () => {
        expect((await rejects(BS.deleteArchive("nope"))).statusCode).toBe(404);
    });
    it("409s while another archive still depends on it and names the dependents", async () => {
        await writeArchive(dir, { archiveId: "BASEA", tables: { T: included([{ id: 1 }]) } });
        await writeArchive(dir, { archiveId: "DEP", tables: { T: { state: "UNCHANGED", rows: 1, sha256: "s", sourceArchiveId: "BASEA" } } });
        const err = await rejects(BS.deleteArchive("BASEA"));
        expect(err.statusCode).toBe(409);
        expect(JSON.stringify(err.details)).toContain("DEP");
        await fsp.stat(path.join(dir, "BASEA.zip"));
    });
    it("refuses to unlink a path outside the backup directory", async () => {
        const outside = path.join(os.tmpdir(), "outside-evil.zip");
        vi.spyOn(BS, "_loadIndex").mockResolvedValue([{ archiveId: "A", filename: "A.zip", path: outside, tables: {} }] as never);
        const unlink = vi.spyOn(fsp, "unlink");
        await expect(BS.deleteArchive("A")).rejects.toThrow(/outside the backup directory/);
        expect(unlink).not.toHaveBeenCalled();
    });
});

describe("verifyArchive", () => {
    it("passes for a valid archive with a healthy chain", async () => {
        await writeArchive(dir, { archiveId: "BASEA", tables: { T: included([{ id: 1 }]) } });
        await writeArchive(dir, { archiveId: "H", tables: { T: { state: "UNCHANGED", rows: 1, sha256: "s", sourceArchiveId: "BASEA" } } });
        expect(await BS.verifyArchive("H")).toEqual({ archiveId: "H", signatureValid: true, chainHealth: { valid: true, missing: [], invalid: [] } });
    });
    it("422s listing a bad signature, a missing member and an invalid member", async () => {
        await writeArchive(dir, { archiveId: "BADMEM", tables: { T: included([{ id: 1 }]) }, tamper: "data" });
        await writeArchive(dir, {
            archiveId: "H", tamper: "bad-digest",
            tables: {
                A: { state: "UNCHANGED", rows: 1, sha256: "s", sourceArchiveId: "GONE" },
                B: { state: "UNCHANGED", rows: 1, sha256: "s", sourceArchiveId: "BADMEM" },
                C: included([{ id: 1 }]),
            },
        });
        const err = await rejects(BS.verifyArchive("H"));
        expect(err.statusCode).toBe(422);
        const issues = err.details.map((d: any) => d.issue).join("|");
        expect(issues).toMatch(/signature verification failed/);
        expect(issues).toMatch(/"GONE" is missing/);
        expect(issues).toMatch(/"BADMEM" failed/);
    });
    it("422s for an invalid signature even when the chain is healthy", async () => {
        await writeArchive(dir, { archiveId: "H", tables: { T: included([{ id: 1 }]) }, tamper: "data" });
        const err = await rejects(BS.verifyArchive("H"));
        expect(err.details).toHaveLength(1);
    });
    it("passes for a manifest without tables", async () => {
        const a = await writeArchive(dir, { archiveId: "H", tables: {} });
        vi.spyOn(BS, "getArchive").mockResolvedValue({ archiveId: "H", path: a.path } as never);
        expect((await BS.verifyArchive("H")).chainHealth.valid).toBe(true);
    });
});

describe("runBackup", () => {
    const built = (mode = "FULL", chain: any = null) => ({
        zipBuffer: Buffer.from("ZIPDATA"), manifest: { mode, chain }, totalRows: 10, tableCount: 2, includedCount: 2, unchangedCount: 0,
    });

    it("rejects an invalid trigger and empty tables", async () => {
        await expect(BS.runBackup({ trigger: "BOGUS" as never, tables: ["T"] })).rejects.toThrow(/trigger must be one of/);
        await expect(BS.runBackup({ trigger: "SCHEDULED", tables: [] })).rejects.toThrow(/non-empty array/);
        await expect(BS.runBackup({ trigger: "SCHEDULED", tables: null as never })).rejects.toThrow(/non-empty array/);
    });

    it("writes a FULL scheduled archive, passes chain decisions to the builder and frees the lease", async () => {
        const build = vi.spyOn(BackupArchiveService, "buildScheduledBackup").mockResolvedValue(built() as never);
        const res = await BS.runBackup({ trigger: "SCHEDULED", event: "NIGHTLY", eventId: 3, tables: ["T"], at: new Date("2026-03-04T05:06:07Z") });
        expect(res).toMatchObject({
            filename: "app-backup_3_NIGHTLY_2026-03-04T05-06-07Z.zip", sizeBytes: 7, mode: "FULL", chain: null,
            totalRows: 10, tableCount: 2, includedCount: 2, unchangedCount: 0, forcedFullReason: "no previous archive exists",
        });
        expect(await fsp.readFile(res.path, "utf8")).toBe("ZIPDATA");
        expect(build.mock.calls[0][0]).toMatchObject({ mode: "FULL", chain: null, trigger: "SCHEDULED" });
        expect(await fsp.readdir(dir)).toEqual([res.filename]);
        expect(logger.notice).toHaveBeenCalled();
    });

    it("runs an INCREMENTAL backup on top of a verified chain head", async () => {
        await writeArchive(dir, { archiveId: "BASEA", tables: { T: included([{ id: 1 }]) } });
        const build = vi.spyOn(BackupArchiveService, "buildScheduledBackup").mockResolvedValue(built("INCREMENTAL", { baseArchiveId: "BASEA", generation: 1 }) as never);
        const res = await BS.runBackup({ trigger: "SCHEDULED", tables: ["T"] });
        expect(res.mode).toBe("INCREMENTAL");
        expect(res.forcedFullReason).toBeNull();
        expect(build.mock.calls[0][0]).toMatchObject({ mode: "INCREMENTAL", chain: { baseArchiveId: "BASEA", generation: 1 } });
        expect(logger.info).toHaveBeenCalled();
    });

    it("allows MANUAL backups when no scheduled backup is running or imminent", async () => {
        vi.spyOn(BackupArchiveService, "buildScheduledBackup").mockResolvedValue(built() as never);
        const res = await BS.runBackup({ trigger: "MANUAL", tables: ["T"], createdBy: 1, requestId: "rq" });
        expect(res.filename).toMatch(/^app-backup_manual_/);
    });

    it("logs and rethrows a failed publish, leaving no .part", async () => {
        vi.spyOn(BackupArchiveService, "buildScheduledBackup").mockResolvedValue(built() as never);
        vi.spyOn(fsp, "rename").mockRejectedValue(new Error("disk full"));
        await expect(BS.runBackup({ trigger: "PURGE", tables: ["T"] })).rejects.toThrow("disk full");
        expect(logger.error).toHaveBeenCalled();
        expect((await fsp.readdir(dir)).filter((f) => f.endsWith(".part"))).toEqual([]);
    });

    it("propagates builder errors", async () => {
        vi.spyOn(BackupArchiveService, "buildScheduledBackup").mockRejectedValue(new Error("db down"));
        await expect(BS.runBackup({ trigger: "SCHEDULED", tables: ["T"] })).rejects.toThrow("db down");
        expect(await fsp.readdir(dir)).toEqual([]);
    });
});

describe("_withRunBackupLock", () => {
    it("serialises runs and lets a queued waiter follow the holder's progress", async () => {
        const order: string[] = [];
        let releaseFirst!: () => void;
        const holderScope = new ProgressScope({ label: "holder" });
        const waiterScope = new ProgressScope({ label: "waiter" });
        const first = runInScope(holderScope, () => BS._withRunBackupLock(async () => {
            order.push("first-start");
            await new Promise<void>((r) => { releaseFirst = r; });
            order.push("first-end");
        }));
        await Promise.resolve();
        const second = runInScope(waiterScope, () => BS._withRunBackupLock(async () => { order.push("second"); }));
        expect(waiterScope._followed).not.toBeNull();
        expect(waiterScope._followed!.lastProgressAt).toBe(holderScope.lastProgressAt);
        releaseFirst();
        await Promise.all([first, second]);
        expect(order).toEqual(["first-start", "first-end", "second"]);
        expect(waiterScope._followed).toBeNull();
        expect(BS._runLockDepth).toBe(0);
        expect(BS._runHolderScope).toBeNull();
    });
    it("a failing holder does not wedge the queue", async () => {
        await expect(BS._withRunBackupLock(async () => { throw new Error("x"); })).rejects.toThrow("x");
        await expect(BS._withRunBackupLock(async () => 5)).resolves.toBe(5);
    });
    it("follows with a zero progress time when the holder has no scope", async () => {
        let release!: () => void;
        const first = BS._withRunBackupLock(() => new Promise<void>((r) => { release = r; }));
        await Promise.resolve();
        const waiter = new ProgressScope({ label: "w" });
        const second = runInScope(waiter, () => BS._withRunBackupLock(async () => undefined));
        expect(waiter._followed!.lastProgressAt).toBe(0);
        release();
        await Promise.all([first, second]);
    });
});
