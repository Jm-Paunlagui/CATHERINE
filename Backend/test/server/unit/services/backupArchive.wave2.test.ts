import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import ExcelJS from "exceljs";

import BackupArchiveService, { SCHEMA_VERSION } from "../../../../src/services/BackupArchiveService";
import DataPurgeModel from "../../../../src/models/data-purge.model";
import BackupTokenService from "../../../../src/services/BackupTokenService";
import { CryptoVault } from "../../../../src/utils/encryption/CryptoVault";
import { logger } from "../../../../src/utils/logger";

const LOG = "T_SERVER_ALERT_LOG_DEV"; // append-only identity log
const ACK = "T_SERVER_ALERT_ACK_DEV"; // natural pk
const ADMINS = "T_ADMINS_DEV";

type Rows = Record<string, Record<string, unknown>[]>;
let source: Rows;

function stubDb() {
    vi.spyOn(DataPurgeModel, "streamAllTables").mockImplementation((async (tables: string[], { onBatch }: any) => {
        for (const t of tables) if (source[t]?.length) await onBatch(t, source[t].map((r) => ({ ...r })));
        return {};
    }) as never);
    vi.spyOn(DataPurgeModel, "streamTable").mockImplementation((async (t: string, { onBatch }: any) => {
        if (source[t]?.length) await onBatch(source[t].map((r) => ({ ...r })));
        return source[t]?.length ?? 0;
    }) as never);
}

beforeEach(() => {
    source = { [LOG]: [{ ID: "9", ALERT_KEY: "a" }, { ID: "10", ALERT_KEY: "b" }], [ACK]: [{ ALERT_KEY: "a", ACKED_BY: 1 }], [ADMINS]: [] };
    for (const m of ["info", "notice", "warning"] as const) vi.spyOn(logger, m).mockImplementation(() => undefined as never);
    stubDb();
    vi.spyOn(BackupTokenService, "issue").mockResolvedValue({ token: "tok", issuedAt: 1, expiresAt: 2_000_000_000_000 });
});
afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.BACKUP_XLSX_ROW_CAP;
});

describe("BackupArchiveService.buildArchiveId", () => {
    const at = new Date("2026-07-28T05:59:59.123Z");
    it("rejects an unknown trigger", () => {
        expect(() => BackupArchiveService.buildArchiveId({ trigger: "BOGUS" as never })).toThrow(/trigger must be one of/);
    });
    it("builds the scheduled form with event id, stripping milliseconds", () => {
        expect(BackupArchiveService.buildArchiveId({ trigger: "SCHEDULED", event: "NIGHTLY", eventId: 142, at })).toBe("bk_2026-07-28T05:59:59Z_e142_NIGHTLY");
    });
    it.each([
        ["scheduled without event id", { trigger: "SCHEDULED", event: "NIGHTLY" }, "bk_2026-07-28T05:59:59Z_scheduled"],
        ["scheduled without event", { trigger: "SCHEDULED", eventId: 3 }, "bk_2026-07-28T05:59:59Z_scheduled"],
        ["manual", { trigger: "MANUAL" }, "bk_2026-07-28T05:59:59Z_manual"],
    ])("falls back to the trigger suffix for %s", (_n, p, expected) => {
        expect(BackupArchiveService.buildArchiveId({ ...(p as object), at } as never)).toBe(expected);
    });
    it("defaults the instant to now", () => {
        expect(BackupArchiveService.buildArchiveId({ trigger: "PURGE" })).toMatch(/^bk_\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ_purge$/);
    });
});

describe("BackupArchiveService._streamAndHashTables", () => {
    it("tracks the numeric (not lexical) high-water pk of append-only logs and '0' for an empty one", async () => {
        const r = await BackupArchiveService._streamAndHashTables([LOG, ACK], { mode: "FULL" });
        expect(r.highWater).toEqual({ [LOG]: "10" });
        source[LOG] = [];
        const r2 = await BackupArchiveService._streamAndHashTables([LOG], { mode: "FULL" });
        expect(r2.highWater).toEqual({ [LOG]: "0" });
    });

    it("ignores rows without a pk when tracking the high-water mark and handles pks above 2^53 exactly", async () => {
        source[LOG] = [{ ID: null }, { ID: "9007199254740993" }, { ID: "5" }];
        const r = await BackupArchiveService._streamAndHashTables([LOG], { mode: "FULL" });
        expect(r.highWater[LOG]).toBe("9007199254740993");
        expect(r.totalRows).toBe(3);
    });

    it("counts rows, hashes jsonl and reports read-consistent on the happy path", async () => {
        const r = await BackupArchiveService._streamAndHashTables([LOG, ACK], { mode: "FULL" });
        expect(r.readConsistent).toBe(true);
        expect(r.tables[ACK]).toMatchObject({ state: "INCLUDED", rows: 1 });
        expect(r.dataBuffers[`data/${ACK}.jsonl`].toString()).toBe('{"ALERT_KEY":"a","ACKED_BY":1}\n');
        expect(DataPurgeModel.streamTable).not.toHaveBeenCalled();
    });

    it("falls back to per-table reads when the snapshot is too old, discarding partial state", async () => {
        vi.mocked(DataPurgeModel.streamAllTables).mockImplementation((async (_t: string[], { onBatch }: any) => {
            await onBatch(ACK, [{ ALERT_KEY: "partial" }]);
            throw Object.assign(new Error("ORA-01555"), { isSnapshotTooOld: true });
        }) as never);
        const r = await BackupArchiveService._streamAndHashTables([ACK], { mode: "FULL", archiveIdForLogging: "bk1" });
        expect(r.readConsistent).toBe(false);
        expect(r.tables[ACK].rows).toBe(1); // partial row discarded, re-read from scratch
        expect(r.dataBuffers[`data/${ACK}.jsonl`].toString()).not.toContain("partial");
        expect(logger.notice).toHaveBeenCalled();
    });

    it("propagates any other streaming failure unchanged (no silent fallback)", async () => {
        vi.mocked(DataPurgeModel.streamAllTables).mockRejectedValue(new Error("ORA-03113"));
        await expect(BackupArchiveService._streamAndHashTables([ACK], { mode: "FULL" })).rejects.toThrow("ORA-03113");
        expect(DataPurgeModel.streamTable).not.toHaveBeenCalled();
    });

    it("INCREMENTAL marks a table UNCHANGED only when hash and source archive both match", async () => {
        const base = await BackupArchiveService._streamAndHashTables([LOG, ACK, ADMINS], { mode: "FULL" });
        const prev = {
            [LOG]: { sha256: base.tables[LOG].sha256, sourceArchiveId: "old1" },
            [ACK]: { sha256: "different", sourceArchiveId: "old2" },
            [ADMINS]: { sha256: base.tables[ADMINS].sha256, sourceArchiveId: "" },
        };
        const r = await BackupArchiveService._streamAndHashTables([LOG, ACK, ADMINS], { mode: "INCREMENTAL", previousTableState: prev });
        expect(r.tables[LOG]).toEqual({ state: "UNCHANGED", rows: 2, sha256: base.tables[LOG].sha256, sourceArchiveId: "old1" });
        expect(r.tables[ACK].state).toBe("INCLUDED");
        expect(r.tables[ADMINS].state).toBe("INCLUDED");
        expect(Object.keys(r.dataBuffers)).not.toContain(`data/${LOG}.jsonl`);
    });

    it("FULL mode ignores previousTableState entirely", async () => {
        const base = await BackupArchiveService._streamAndHashTables([LOG], { mode: "FULL" });
        const r = await BackupArchiveService._streamAndHashTables([LOG], { mode: "FULL", previousTableState: { [LOG]: { sha256: base.tables[LOG].sha256, sourceArchiveId: "x" } } });
        expect(r.tables[LOG].state).toBe("INCLUDED");
    });
});

async function unzip(buf: Buffer) {
    const zip = await JSZip.loadAsync(buf);
    const read = async (n: string) => JSON.parse(await zip.file(n)!.async("string"));
    return { zip, manifest: await read("manifest.json"), signature: await read("signature.json") };
}

describe("BackupArchiveService.buildBackup", () => {
    it("builds a signed archive, token bound to the scope and a custom slug for a table selection", async () => {
        const r = await BackupArchiveService.buildBackup({ selection: { tables: [LOG, ACK] }, adminId: 5, requestId: "rq" });
        expect(r.filename).toMatch(/^app-backup_custom_\d{8}-\d{6}\.zip$/);
        expect(r.totalRows).toBe(3);
        expect(r.rowCounts).toEqual({ [LOG]: 2, [ACK]: 1 });
        expect(r.confirmPhrase).toMatch(/SERVER_ 3 ROWS$/);
        const { zip, manifest, signature } = await unzip(r.zipBuffer);
        expect(manifest).toMatchObject({ kind: "FULL_SCOPE", mode: "FULL", trigger: "PURGE", chain: null, schemaVersion: SCHEMA_VERSION, createdBy: 5, requestId: "rq", readConsistent: true });
        expect(zip.file("readable/backup-summary.xlsx")).not.toBeNull();
        await expect(CryptoVault.verifyRecord("APP_BACKUP_ARCHIVE", signature.files, signature.digest)).resolves.toBe(true);
        expect(BackupTokenService.issue).toHaveBeenCalledWith(expect.objectContaining({ adminId: 5, rowCounts: { [LOG]: 2, [ACK]: 1 }, highWater: { [LOG]: "10" } }));
    });

    it("uses the group name as the filename slug for a group selection", async () => {
        const r = await BackupArchiveService.buildBackup({ selection: { groups: ["SERVER_"] }, adminId: 1 });
        expect(r.filename).toMatch(/^app-backup_server_/);
        expect(r.tableCount).toBe(2);
    });

    it("rejects an empty selection before reading anything", async () => {
        await expect(BackupArchiveService.buildBackup({ selection: {}, adminId: 1 })).rejects.toMatchObject({ statusCode: 400 });
        expect(DataPurgeModel.streamAllTables).not.toHaveBeenCalled();
    });

    it("records the read-consistency fallback in the manifest", async () => {
        vi.mocked(DataPurgeModel.streamAllTables).mockRejectedValue(Object.assign(new Error("x"), { isSnapshotTooOld: true }));
        const r = await BackupArchiveService.buildBackup({ selection: { tables: [ACK] }, adminId: 1 });
        expect((await unzip(r.zipBuffer)).manifest.readConsistent).toBe(false);
    });
});

describe("BackupArchiveService.buildScheduledBackup", () => {
    const base = { tables: [LOG, ACK], trigger: "SCHEDULED" as const, event: "NIGHTLY", eventId: 1, mode: "FULL" as const, archiveId: "bk_x" };

    it.each([
        ["empty tables", { tables: [] }, /non-empty array/],
        ["non-array tables", { tables: "x" }, /non-empty array/],
        ["bad trigger", { trigger: "NOPE" }, /trigger must be one of/],
        ["bad mode", { mode: "PARTIAL" }, /mode must be/],
        ["missing archive id", { archiveId: "" }, /archiveId. is required/],
        ["non-string archive id", { archiveId: 5 }, /archiveId. is required/],
    ])("rejects %s", async (_n, over, re) => {
        await expect(BackupArchiveService.buildScheduledBackup({ ...base, ...over } as never)).rejects.toThrow(re);
        expect(DataPurgeModel.streamAllTables).not.toHaveBeenCalled();
    });

    it("FULL archive is its own chain base with generation 0 and no readable sheet", async () => {
        const r = await BackupArchiveService.buildScheduledBackup({ ...base, createdBy: 9 });
        expect(r.manifest.chain).toEqual({ baseArchiveId: "bk_x", generation: 0 });
        expect(r).toMatchObject({ includedCount: 2, unchangedCount: 0, tableCount: 2, totalRows: 3 });
        const { zip, manifest } = await unzip(r.zipBuffer);
        expect(zip.file("readable/backup-summary.xlsx")).toBeNull();
        expect(manifest.createdBy).toBe(9);
        expect(manifest.scopeHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("a PURGE-trigger archive never carries a chain object", async () => {
        const r = await BackupArchiveService.buildScheduledBackup({ ...base, trigger: "PURGE", event: null, eventId: null });
        expect(r.manifest.chain).toBeNull();
    });

    it("INCREMENTAL keeps the given chain, omits UNCHANGED data and signs only what is present", async () => {
        const first = await BackupArchiveService._streamAndHashTables([LOG, ACK], { mode: "FULL" });
        const r = await BackupArchiveService.buildScheduledBackup({
            ...base, mode: "INCREMENTAL", chain: { baseArchiveId: "bk_base", generation: 3 },
            previousTableState: { [LOG]: { sha256: first.tables[LOG].sha256, sourceArchiveId: "bk_prev" } },
        });
        expect(r.manifest.chain).toEqual({ baseArchiveId: "bk_base", generation: 3 });
        expect(r).toMatchObject({ includedCount: 1, unchangedCount: 1 });
        const { zip, signature } = await unzip(r.zipBuffer);
        expect(zip.file(`data/${LOG}.jsonl`)).toBeNull();
        expect(Object.keys(signature.files).sort()).toEqual([`data/${ACK}.jsonl`, "manifest.json"]);
    });

    it("INCREMENTAL without a chain defaults to a null base at generation 0", async () => {
        const r = await BackupArchiveService.buildScheduledBackup({ ...base, mode: "INCREMENTAL" });
        expect(r.manifest.chain).toEqual({ baseArchiveId: null, generation: 0 });
    });
});

describe("BackupArchiveService entity backups", () => {
    const entity = { table: ADMINS, keyColumn: "USERNAME", keyValue: "jdoe" };

    it("computeEntityScopeHash is order and duplicate independent but bound to the key value", () => {
        const a = BackupArchiveService.computeEntityScopeHash(entity, [ACK, ADMINS]);
        expect(a).toBe(BackupArchiveService.computeEntityScopeHash(entity, [ADMINS, ACK, ADMINS]));
        expect(a).not.toBe(BackupArchiveService.computeEntityScopeHash({ ...entity, keyValue: "other" }, [ACK, ADMINS]));
    });

    it("builds a signed ENTITY archive from filtered streams, including an empty table", async () => {
        const spy = vi.spyOn(DataPurgeModel, "streamTableFiltered").mockImplementation((async (t: string, { onBatch }: any) => {
            if (t === ACK) { onBatch([{ ALERT_KEY: "a", ACKED_BY: 1 }]); return 1; }
            return 0;
        }) as never);
        const r = await BackupArchiveService.buildEntityBackup({
            entity,
            tableFilters: [{ table: ADMINS, whereColumns: ["USERNAME"], whereValue: "jdoe" }, { table: ACK, whereColumns: ["ACKED_BY"], whereValue: 1 }],
            adminId: 7,
        });
        expect(spy).toHaveBeenCalledTimes(2);
        expect(r.filename).toMatch(/^app-backup_admin-jdoe_/);
        expect(r).toMatchObject({ totalRows: 1, tableCount: 2, rowCounts: { [ADMINS]: 0, [ACK]: 1 } });
        const { zip, manifest, signature } = await unzip(r.zipBuffer);
        expect(manifest).toMatchObject({ kind: "ENTITY", entity, requestId: null });
        expect(await zip.file(`data/${ADMINS}.jsonl`)!.async("string")).toBe("");
        await expect(CryptoVault.verifyRecord("APP_BACKUP_ARCHIVE", signature.files, signature.digest)).resolves.toBe(true);
        expect(BackupTokenService.issue).toHaveBeenCalledWith({ adminId: 7, scopeHash: r.scopeHash, rowCounts: r.rowCounts });
    });

    it("refuses an unregistered table in a filter (CWE-89 allow-list)", async () => {
        await expect(BackupArchiveService.buildEntityBackup({ entity, tableFilters: [{ table: "EVIL", whereColumns: ["X"], whereValue: 1 }], adminId: 1 })).rejects.toThrow();
    });
});

describe("BackupArchiveService readable workbooks", () => {
    async function sheets(buf: Buffer) {
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(buf as never);
        return wb;
    }

    it("caps rows per sheet by BACKUP_XLSX_ROW_CAP and says so in the summary", async () => {
        process.env.BACKUP_XLSX_ROW_CAP = "1";
        const wb = await sheets(await BackupArchiveService._buildReadableWorkbook([LOG], { [LOG]: 2 }));
        expect(wb.getWorksheet(LOG)!.rowCount).toBe(2); // header + 1 capped row
        expect(wb.getWorksheet("Summary")!.getRow(2).getCell(3).value).toBe("First 1 of 2");
    });

    it("writes all rows, truncates >31 char sheet names, and tolerates empty tables and missing counts", async () => {
        const longName = "T_A_VERY_LONG_TABLE_NAME_OVER_31_CHARS";
        source[longName] = [{ A: 1 }];
        const wb = await sheets(await BackupArchiveService._buildReadableWorkbook([longName, ADMINS], {}));
        expect(wb.getWorksheet(longName.slice(0, 31))!.rowCount).toBe(2);
        expect(wb.getWorksheet("Summary")!.getRow(2).getCell(2).value).toBe(0);
        expect(wb.getWorksheet("Summary")!.getRow(2).getCell(3).value).toBe("All rows");
        expect(wb.getWorksheet(ADMINS)!.rowCount).toBe(0);
    });

    it("stops consuming batches once the cap is reached across batches", async () => {
        process.env.BACKUP_XLSX_ROW_CAP = "1";
        vi.mocked(DataPurgeModel.streamTable).mockImplementation((async (_t: string, { onBatch }: any) => {
            onBatch([{ A: 1 }]);
            onBatch([{ A: 2 }]);
            return 2;
        }) as never);
        const wb = await sheets(await BackupArchiveService._buildReadableWorkbook([LOG], { [LOG]: 2 }));
        expect(wb.getWorksheet(LOG)!.rowCount).toBe(2);
    });

    it("builds the in-memory variant with cap, long names, empty and missing tables", async () => {
        process.env.BACKUP_XLSX_ROW_CAP = "1";
        const longName = "T_A_VERY_LONG_TABLE_NAME_OVER_31_CHARS";
        const wb = await sheets(await BackupArchiveService._buildReadableWorkbookFromRows([longName, ADMINS, ACK], { [longName]: [{ A: 1 }, { A: 2 }], [ADMINS]: [] }));
        expect(wb.getWorksheet(longName.slice(0, 31))!.rowCount).toBe(2);
        expect(wb.getWorksheet("Summary")!.getRow(2).getCell(3).value).toBe("First 1 of 2");
        expect(wb.getWorksheet(ACK)!.rowCount).toBe(0);
    });

    it("an invalid BACKUP_XLSX_ROW_CAP falls back to the default cap", async () => {
        process.env.BACKUP_XLSX_ROW_CAP = "junk";
        const wb = await sheets(await BackupArchiveService._buildReadableWorkbookFromRows([LOG], { [LOG]: [{ A: 1 }] }));
        expect(wb.getWorksheet("Summary")!.getRow(2).getCell(3).value).toBe("All rows");
    });
});
