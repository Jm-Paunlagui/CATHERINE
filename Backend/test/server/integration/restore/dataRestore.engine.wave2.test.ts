import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/constants/purgeTables", async (importOriginal) => {
    const { makeRegistryMock } = await import("../../helpers/restoreWave2");
    return makeRegistryMock(await importOriginal<typeof import("../../../../src/constants/purgeTables")>());
});

import DataRestoreService from "../../../../src/services/DataRestoreService";
import BackupArchiveService from "../../../../src/services/BackupArchiveService";
import DataPurgeService from "../../../../src/services/DataPurgeService";
import DataPurgeModel from "../../../../src/models/data-purge.model";
import AuditLogModel from "../../../../src/models/audit.log.model";
import TamperDetectionService from "../../../../src/services/TamperDetectionService";
import { CryptoVault } from "../../../../src/utils/encryption/CryptoVault";
import { Transaction } from "../../../../src/utils/oracle-mongo-wrapper";
import { registry } from "../../../../src/middleware/cache";
import { logger } from "../../../../src/utils/logger";
import { buildSignedZip } from "../../helpers/restoreWave2";

const V = BackupArchiveService.SCHEMA_VERSION;

const DATA = {
    W2_PARENT: [{ ID: 1, NAME: "a" }, { ID: 2, NAME: "b" }, { ID: 3, NAME: "c" }],
    W2_CHILD: [
        { ID: 10, PARENT_ID: 1, ROW_HASH: "good" },
        { ID: 11, PARENT_ID: null, ROW_HASH: "good" },
        { ID: 12, PARENT_ID: 3, ROW_HASH: "forged" },
    ],
    W2_NATURAL: [{ KEY: "k1", ROW_HASH: "good" }],
    W2_EMPTY: [],
};
const PHRASE = "RESTORE SERVER_, T_ 7 ROWS";

let inserts: Array<{ table: string; rows: Record<string, any>[] }>;
let rehashes: Array<Record<string, any>>;
let execute: ReturnType<typeof vi.fn>;
let session: any;

beforeEach(() => {
    inserts = [];
    rehashes = [];
    for (const m of ["info", "notice", "warning", "alert", "security", "error"] as const) {
        vi.spyOn(logger, m).mockImplementation(() => undefined as never);
    }
    vi.spyOn(DataPurgeModel, "countRows").mockImplementation(async (tables: string[]) => Object.fromEntries(tables.map((t) => [t, 0])));
    vi.spyOn(DataPurgeService, "findAdminById").mockResolvedValue({ ID: 1, PASSWORD: "h" } as never);
    vi.spyOn(CryptoVault, "verifyAdminPassword").mockResolvedValue({ matched: true, newHash: null });
    vi.spyOn(AuditLogModel, "insert").mockResolvedValue({ rowsAffected: 1 });
    vi.spyOn(registry, "flushAll").mockImplementation(() => undefined as never);
    const counters: Record<string, number> = { W2_PARENT: 100, W2_CHILD: 200, W2_EMPTY: 300 };
    vi.spyOn(DataPurgeModel, "insertRestoreBatch").mockImplementation((async (table: string, rows: Record<string, any>[]) => {
        inserts.push({ table, rows: rows.map((r) => ({ ...r })) });
        return { insertedCount: rows.length, returning: rows.map(() => ({ ID: ++counters[table] })) };
    }) as never);
    vi.spyOn(TamperDetectionService, "buildSignedFields").mockImplementation(((_d: string, row: Record<string, unknown>) => ({ ID: String(row.ID ?? row.KEY), P: String(row.PARENT_ID ?? ""), TS: String(row.CREATED_TS ?? "") })) as never);
    const realVerify = CryptoVault.verifyRecord.bind(CryptoVault);
    const realSign = CryptoVault.signRecord.bind(CryptoVault);
    vi.spyOn(CryptoVault, "verifyRecord").mockImplementation((async (d: string, f: any, sig: any) => (d.startsWith("W2_") ? sig === "good" : realVerify(d, f, sig))) as never);
    vi.spyOn(CryptoVault, "signRecord").mockImplementation((async (d: string, f: any) => (d.startsWith("W2_") ? `signed:${f.ID}:${f.P}:${f.TS}` : realSign(d, f))) as never);
    execute = vi.fn().mockImplementation(async (_sql: string, binds: Record<string, number>) => ({
        rows: Object.values(binds).map((id) => ({ ID: id, CREATED_TS: `ts-${id}` })),
    }));
    session = {
        execute,
        collection: (table: string) => ({
            bulkUpdateByKeys: async (rows: Record<string, any>[], opts: unknown) => {
                rehashes.push(...rows.map((r) => ({ table, opts, ...r })));
                return { acknowledged: true, modifiedCount: rows.length };
            },
        }),
    };
    vi.spyOn(Transaction.prototype, "withTransaction").mockImplementation((async (fn: (s: unknown) => Promise<unknown>) => fn(session)) as never);
});
afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.RESTORE_BATCH_SIZE;
});

const run = async (overrides: Record<string, unknown> = {}, zipOpts: Record<string, unknown> = {}) =>
    DataRestoreService.restore({
        zipBuffer: await buildSignedZip(V, { data: DATA, ...zipOpts }),
        adminId: 1, adminPassword: "pw", confirmPhrase: PHRASE,
        ...overrides,
    } as never);

describe("DataRestoreService.restore - engine", () => {
    it("restores in tier order, remaps FKs, re-signs verified rows and counts forged ones", async () => {
        const report = await run({ clientIp: "10.0.0.1", requestId: "rq-1" });
        expect(inserts.map((i) => i.table)).toEqual(["W2_PARENT", "W2_CHILD", "W2_NATURAL"]); // empty table never inserted
        const child = inserts.find((i) => i.table === "W2_CHILD")!.rows;
        expect(child.map((r) => r.PARENT_ID)).toEqual([101, null, 103]); // null FK left untouched
        const byPk = Object.fromEntries(rehashes.filter((r) => r.table === "W2_CHILD").map((r) => [r.ID, r.ROW_HASH]));
        expect(byPk[201]).toBe("signed:201:101:ts-201"); // canonical timestamp read back from the db
        expect(byPk[203]).toBeNull();
        expect(rehashes.find((r) => r.table === "W2_NATURAL")).toMatchObject({ KEY: "k1", ROW_HASH: "signed:k1::" });
        expect(report).toMatchObject({ kind: "FULL_SCOPE", totalInserted: 7, totalResigned: 3, tamperedRowsRestoredUnsigned: 1 });
        expect(report.perTable.map((p) => [p.table, p.insertedCount])).toEqual([["W2_PARENT", 3], ["W2_CHILD", 3], ["W2_NATURAL", 1], ["W2_EMPTY", 0]]);
        expect(rehashes[0].opts).toEqual({ keys: expect.any(Array) });
    });

    it("writes the post-commit audit row, flushes caches, and records the client ip and request id", async () => {
        await run({ clientIp: "10.0.0.1", requestId: "rq-1" });
        await vi.waitFor(() => expect(AuditLogModel.insert).toHaveBeenCalledTimes(1));
        expect(AuditLogModel.insert).toHaveBeenCalledWith(expect.objectContaining({
            REQUEST_ID: "rq-1", USER_ID: 1, USERNAME: "1", METHOD: "POST", ENDPOINT: "/api/v1/data-purge/restore",
            STATUS_CODE: 200, CLIENT_IP: "10.0.0.1",
        }));
        expect(registry.flushAll).toHaveBeenCalledTimes(1);
    });

    it("audit row falls back to a generated request id, null ip and null user id for a non-numeric admin id", async () => {
        vi.spyOn(DataPurgeService, "findAdminById").mockResolvedValue({ ID: 1, PASSWORD: "h" } as never);
        await run({ adminId: "root" });
        await vi.waitFor(() => expect(AuditLogModel.insert).toHaveBeenCalled());
        const row = (AuditLogModel.insert as any).mock.calls[0][0];
        expect(row.REQUEST_ID).toMatch(/^restore-\d+$/);
        expect(row.USER_ID).toBeNull();
        expect(row.USERNAME).toBe("root");
        expect(row.CLIENT_IP).toBeNull();
    });

    it("a failing post-commit audit write is logged but never fails the committed restore", async () => {
        vi.spyOn(AuditLogModel, "insert").mockRejectedValue(new Error("audit down"));
        await expect(run()).resolves.toMatchObject({ totalInserted: 7 });
        await vi.waitFor(() => expect(logger.error).toHaveBeenCalled());
    });

    it("splits inserts and re-sign updates by RESTORE_BATCH_SIZE", async () => {
        process.env.RESTORE_BATCH_SIZE = "2";
        await run();
        expect(inserts.filter((i) => i.table === "W2_PARENT").map((i) => i.rows.length)).toEqual([2, 1]);
        expect(inserts.filter((i) => i.table === "W2_CHILD").map((i) => i.rows.length)).toEqual([2, 1]);
    });

    it.each(["0", "-3", "abc", ""])("falls back to the default batch size for RESTORE_BATCH_SIZE=%j", async (v) => {
        process.env.RESTORE_BATCH_SIZE = v;
        await run();
        expect(inserts.filter((i) => i.table === "W2_PARENT")).toHaveLength(1);
    });

    it("an ENTITY archive restores without the empty-target check", async () => {
        vi.spyOn(DataPurgeModel, "existsByKey").mockResolvedValue(false);
        const r = await run(
            { confirmPhrase: "RESTORE T_ 3 ROWS" },
            { data: { W2_PARENT: DATA.W2_PARENT }, manifest: { kind: "ENTITY", entity: { table: "W2_PARENT", keyColumn: "ID", keyValue: 1 } } },
        );
        expect(r.kind).toBe("ENTITY");
        expect(DataPurgeModel.countRows).not.toHaveBeenCalled();
    });

    it("uses 'unknown' scope hash in log messages when the manifest has none", async () => {
        await expect(run({}, { manifest: { scopeHash: undefined } })).resolves.toMatchObject({ archiveMeta: { scopeHash: null } });
    });

    it("an unsigned (no rowHashDomain) identity table is inserted without any re-sign", async () => {
        const r = await run({ confirmPhrase: "RESTORE T_ 3 ROWS" }, { data: { W2_PARENT: DATA.W2_PARENT } });
        expect(rehashes).toEqual([]);
        expect(r.totalResigned).toBe(0);
    });

    it("preview and restore agree on row counts (no divergence)", async () => {
        const zipBuffer = await buildSignedZip(V, { data: DATA });
        const preview = await DataRestoreService.preview({ zipBuffer });
        const report = await DataRestoreService.restore({ zipBuffer, adminId: 1, adminPassword: "pw", confirmPhrase: PHRASE });
        expect(Object.values(preview.rowCounts).reduce((a, b) => a + b, 0)).toBe(report.totalInserted);
    });
});
