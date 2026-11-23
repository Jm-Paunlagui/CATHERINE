import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/constants/purgeTables", async (importOriginal) => {
    const { makeRegistryMock } = await import("../../helpers/restoreWave2");
    return makeRegistryMock(await importOriginal<typeof import("../../../../src/constants/purgeTables")>());
});

import DataRestoreService from "../../../../src/services/DataRestoreService";
import BackupArchiveService from "../../../../src/services/BackupArchiveService";
import DataPurgeModel from "../../../../src/models/data-purge.model";
import { CryptoVault } from "../../../../src/utils/encryption/CryptoVault";
import TamperDetectionService from "../../../../src/services/TamperDetectionService";
import { logger } from "../../../../src/utils/logger";
import { PURGE_ERRORS } from "../../../../src/constants/errors";
import { buildSignedZip } from "../../helpers/restoreWave2";

const V = BackupArchiveService.SCHEMA_VERSION;
const DATA = { W2_PARENT: [{ ID: 1, NAME: "p" }, { ID: 2, NAME: "q" }], W2_NATURAL: [{ KEY: "k1", ROW_HASH: "h" }] };

beforeEach(() => {
    vi.spyOn(logger, "warning").mockImplementation(() => undefined as never);
    vi.spyOn(logger, "alert").mockImplementation(() => undefined as never);
    vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
    vi.spyOn(logger, "security").mockImplementation(() => undefined as never);
    vi.spyOn(DataPurgeModel, "countRows").mockImplementation(async (tables: string[]) => Object.fromEntries(tables.map((t) => [t, 0])));
});
afterEach(() => {
    vi.restoreAllMocks();
});

const rejects = (p: Promise<unknown>, message: string, status?: number) =>
    expect(p).rejects.toMatchObject(status ? { message, statusCode: status } : { message });

describe("DataRestoreService.preview - archive verification", () => {
    it.each([
        ["empty buffer", Buffer.alloc(0)],
        ["non-buffer", "not a buffer" as unknown as Buffer],
    ])("rejects %s with RESTORE_NO_FILE (400)", async (_n, buf) => {
        await rejects(DataRestoreService.preview({ zipBuffer: buf }), PURGE_ERRORS.RESTORE_NO_FILE, 400);
    });

    it("rejects bytes that are not a zip as unreadable (422)", async () => {
        await rejects(DataRestoreService.preview({ zipBuffer: Buffer.from("definitely not a zip") }), PURGE_ERRORS.RESTORE_ARCHIVE_UNREADABLE, 422);
        expect(logger.warning).toHaveBeenCalled();
    });

    it.each(["manifest.json", "signature.json"] as const)("rejects an archive missing %s as incomplete", async (name) => {
        const zip = await buildSignedZip(V, { data: DATA, omit: [name] });
        await rejects(DataRestoreService.preview({ zipBuffer: zip }), PURGE_ERRORS.RESTORE_ARCHIVE_INCOMPLETE, 422);
    });

    it("rejects a manifest that is not JSON as malformed", async () => {
        const zip = await buildSignedZip(V, { data: DATA, rawManifest: "{nope" });
        await rejects(DataRestoreService.preview({ zipBuffer: zip }), PURGE_ERRORS.RESTORE_ARCHIVE_MALFORMED, 422);
    });

    it("rejects a signature.json that is not JSON as malformed", async () => {
        const zip = await buildSignedZip(V, { data: DATA, rawSignature: "}{" });
        await rejects(DataRestoreService.preview({ zipBuffer: zip }), PURGE_ERRORS.RESTORE_ARCHIVE_MALFORMED, 422);
    });

    it.each([
        ["null signature document", "null"],
        ["files not an object", JSON.stringify({ files: "x", digest: "d" })],
        ["files null", JSON.stringify({ files: null, digest: "d" })],
    ])("rejects %s as a signature failure (file-set mismatch)", async (_n, raw) => {
        const zip = await buildSignedZip(V, { data: DATA, rawSignature: raw });
        await expect(DataRestoreService.preview({ zipBuffer: zip })).rejects.toMatchObject({
            message: PURGE_ERRORS.RESTORE_SIGNATURE_INVALID,
            statusCode: 422,
            details: expect.arrayContaining([{ field: "archive", issue: "Archive file set does not match the signature manifest." }]),
        });
    });

    it("rejects a data file edited after signing and names the mismatching file", async () => {
        const zip = await buildSignedZip(V, {
            data: DATA,
            signatureOverride: (sig) => ({ ...sig, files: { ...sig.files, "data/W2_PARENT.jsonl": "0".repeat(64) } }),
        });
        await expect(DataRestoreService.preview({ zipBuffer: zip })).rejects.toMatchObject({
            message: PURGE_ERRORS.RESTORE_SIGNATURE_INVALID,
            details: [{ field: "archive", issue: '"data/W2_PARENT.jsonl" content does not match the archive signature.' }],
        });
    });

    it("rejects a forged digest even when every file hash matches", async () => {
        const zip = await buildSignedZip(V, { data: DATA, signatureOverride: (sig) => ({ ...sig, digest: "f".repeat(64) }) });
        await rejects(DataRestoreService.preview({ zipBuffer: zip }), PURGE_ERRORS.RESTORE_SIGNATURE_INVALID, 422);
    });

    it("treats a vault verification error as an invalid signature (fail closed)", async () => {
        const zip = await buildSignedZip(V, { data: DATA });
        vi.spyOn(CryptoVault, "verifyRecord").mockRejectedValue(new Error("vault down"));
        await rejects(DataRestoreService.preview({ zipBuffer: zip }), PURGE_ERRORS.RESTORE_SIGNATURE_INVALID, 422);
    });

    it("ignores blank JSONL lines and non-.jsonl files under data/ when counting rows", async () => {
        const zip = await buildSignedZip(V, {
            data: { W2_PARENT: [] },
            rawData: { "data/W2_PARENT.jsonl": '{"ID":1}\n\n   \n{"ID":2}\n' },
            extraFiles: { "data/notes.txt": "ignored" },
        });
        const report = await DataRestoreService.preview({ zipBuffer: zip });
        expect(report.rowCounts).toEqual({ W2_PARENT: 2 });
    });
});

describe("DataRestoreService.preview - pre-flight", () => {
    const preview = async (manifest: Record<string, unknown>, data: Record<string, Record<string, unknown>[]> = DATA) =>
        DataRestoreService.preview({ zipBuffer: await buildSignedZip(V, { data, manifest }) });

    it("reports a valid FULL_SCOPE archive with fidelity notes, identity tables and archive meta", async () => {
        const r = await preview({});
        expect(r.kind).toBe("FULL_SCOPE");
        expect(r.tables.sort()).toEqual(["W2_NATURAL", "W2_PARENT"]);
        expect(r.rowCounts).toEqual({ W2_PARENT: 2, W2_NATURAL: 1 });
        expect(r.tablesGettingNewPks).toEqual(["W2_PARENT"]);
        expect(r.fidelityNotes.some((n) => n.startsWith("W2_NATURAL: virtual column(s) V"))).toBe(true);
        expect(r.entity).toBeNull();
        expect(r.archiveMeta).toEqual({ createdBy: 1, createdAt: "2026-01-01T00:00:00.000Z", requestId: "req1", appVersion: "1.0.0", scopeHash: "hash1" });
    });

    it("defaults missing archive provenance to null", async () => {
        const r = await preview({ createdBy: undefined, createdAt: undefined, requestId: undefined, appVersion: undefined, scopeHash: undefined });
        expect(r.archiveMeta).toEqual({ createdBy: null, createdAt: null, requestId: null, appVersion: null, scopeHash: null });
    });

    it("rejects a different schemaVersion (422)", async () => {
        await rejects(preview({ schemaVersion: "v0" }), PURGE_ERRORS.RESTORE_SCHEMA_MISMATCH, 422);
    });

    it("rejects an INCREMENTAL archive uploaded directly", async () => {
        await rejects(preview({ mode: "INCREMENTAL", archiveId: undefined }), PURGE_ERRORS.RESTORE_INCREMENTAL_UPLOAD, 422);
        expect(logger.warning).toHaveBeenCalled();
    });

    it.each([
        ["no scope", { scope: undefined }],
        ["non-array tables", { scope: { tables: "W2_PARENT" } }],
        ["empty tables", { scope: { tables: [] } }],
    ])("rejects %s as an empty scope (400)", async (_n, manifest) => {
        await rejects(preview(manifest as never), PURGE_ERRORS.RESTORE_EMPTY_SCOPE, 400);
    });

    it("rejects a protected table with 403 and raises an alert", async () => {
        await expect(preview({ scope: { tables: ["W2_PARENT", "W2_PROTECTED"] } })).rejects.toMatchObject({
            message: PURGE_ERRORS.PROTECTED_TABLE, statusCode: 403,
            details: [{ field: "tables", issue: '"W2_PROTECTED" is protected and can never be restored.' }],
        });
        expect(logger.alert).toHaveBeenCalled();
    });

    it.each([
        ["unregistered name", "T_NOT_REGISTERED"],
        ["SQL injection shaped name", 'W2_PARENT"; DROP TABLE X; --'],
        ["non-string entry", 42],
    ])("rejects %s as an unknown table (403)", async (_n, t) => {
        await expect(preview({ scope: { tables: ["W2_PARENT", t] } })).rejects.toMatchObject({ message: PURGE_ERRORS.RESTORE_UNKNOWN_TABLE, statusCode: 403 });
    });

    it("rejects data for a table the manifest does not declare", async () => {
        await expect(preview({ scope: { tables: ["W2_PARENT"] } })).rejects.toMatchObject({
            message: PURGE_ERRORS.RESTORE_UNKNOWN_TABLE,
            details: [{ field: "tables", issue: '"W2_NATURAL" has archived data but is not declared in the manifest scope.' }],
        });
    });

    it("rejects an unrecognised kind", async () => {
        await expect(preview({ kind: "WHATEVER" })).rejects.toMatchObject({ message: PURGE_ERRORS.RESTORE_INVALID_KIND, statusCode: 422 });
    });

    it("rejects FULL_SCOPE when a target table already holds rows (409)", async () => {
        vi.spyOn(DataPurgeModel, "countRows").mockResolvedValue({ W2_PARENT: 3, W2_NATURAL: 0 });
        await expect(preview({})).rejects.toMatchObject({
            message: PURGE_ERRORS.RESTORE_TARGET_NOT_EMPTY, statusCode: 409,
            details: [{ field: "W2_PARENT", issue: '"W2_PARENT" already has 3 row(s).' }],
        });
    });

    it("treats a table missing from the live counts as empty", async () => {
        vi.spyOn(DataPurgeModel, "countRows").mockResolvedValue({});
        await expect(preview({})).resolves.toMatchObject({ kind: "FULL_SCOPE" });
    });

    describe("ENTITY kind", () => {
        const entity = { table: "W2_PARENT", keyColumn: "ID", keyValue: 1 };
        const entityManifest = (e: unknown) => ({ kind: "ENTITY", entity: e });

        it("accepts an entity archive whose key is absent and echoes the entity", async () => {
            vi.spyOn(DataPurgeModel, "existsByKey").mockResolvedValue(false);
            const r = await preview(entityManifest(entity));
            expect(r.kind).toBe("ENTITY");
            expect(r.entity).toEqual(entity);
            expect(DataPurgeModel.existsByKey).toHaveBeenCalledWith("W2_PARENT", "ID", 1);
            expect(DataPurgeModel.countRows).not.toHaveBeenCalled();
        });

        it.each([
            ["missing entity", null],
            ["non-object entity", "x"],
            ["no table", { keyColumn: "ID", keyValue: 1 }],
            ["no keyColumn", { table: "W2_PARENT", keyValue: 1 }],
            ["keyValue null", { table: "W2_PARENT", keyColumn: "ID", keyValue: null }],
        ])("rejects %s as missing metadata", async (_n, e) => {
            await expect(preview(entityManifest(e))).rejects.toMatchObject({ message: PURGE_ERRORS.RESTORE_ENTITY_METADATA_MISSING, statusCode: 422 });
        });

        it("rejects an entity table that is not in scope (403)", async () => {
            await expect(preview(entityManifest({ table: "W2_CHILD", keyColumn: "ID", keyValue: 1 }))).rejects.toMatchObject({
                message: PURGE_ERRORS.RESTORE_UNKNOWN_TABLE, statusCode: 403,
            });
        });

        it("rejects an entity key column that is not the registered pk (CWE-89 defence)", async () => {
            vi.spyOn(DataPurgeModel, "existsByKey");
            await expect(preview(entityManifest({ ...entity, keyColumn: "NAME" }))).rejects.toMatchObject({
                message: PURGE_ERRORS.RESTORE_ENTITY_KEY_INVALID, statusCode: 422,
            });
            expect(DataPurgeModel.existsByKey).not.toHaveBeenCalled();
        });

        it("rejects when the entity row already exists (409)", async () => {
            vi.spyOn(DataPurgeModel, "existsByKey").mockResolvedValue(true);
            await expect(preview(entityManifest(entity))).rejects.toMatchObject({ message: PURGE_ERRORS.RESTORE_ENTITY_KEY_PRESENT, statusCode: 409 });
        });
    });
});

describe("DataRestoreService._verifyThenSign", () => {
    const childEntry = { table: "W2_CHILD", pk: "ID", rowHashDomain: "W2_CHILD", canonicalTimestampColumns: ["CREATED_TS"] };

    beforeEach(() => {
        vi.spyOn(TamperDetectionService, "buildSignedFields").mockImplementation(((_d: string, row: Record<string, unknown>) => ({ ID: String(row.ID), TS: String(row.CREATED_TS ?? "") })) as never);
        vi.spyOn(CryptoVault, "verifyRecord").mockImplementation(async (_d, _f, sig) => sig === "good");
        vi.spyOn(CryptoVault, "signRecord").mockImplementation((async (_d: string, f: Record<string, string>) => `signed:${f.ID}:${f.TS}`) as never);
    });

    it("throws when the table has no rowHashDomain", async () => {
        await expect(DataRestoreService._verifyThenSign({ ...childEntry, rowHashDomain: null } as never, [], {} as never)).rejects.toThrow("has no rowHashDomain");
    });

    it("signs valid rows over the NEW pk and the canonical timestamp read back from the db", async () => {
        const execute = vi.fn().mockResolvedValue({ rows: [{ ID: 9, CREATED_TS: "2026-01-01T00:00:00.000001" }] });
        const items = [{ row: { ID: 1, ROW_HASH: "good", CREATED_TS: "client" }, original: { ID: 1, ROW_HASH: "good" }, newPk: 9 }];
        const r = await DataRestoreService._verifyThenSign(childEntry as never, items, { execute } as never);
        expect(r).toEqual({ signRows: [{ ID: 9, ROW_HASH: "signed:9:2026-01-01T00:00:00.000001" }], tampered: 0 });
        const [sql, binds] = execute.mock.calls[0];
        expect(sql).toContain('TO_CHAR("CREATED_TS"');
        expect(sql).toContain('IN (:p0)');
        expect(binds).toEqual({ p0: 9 });
    });

    it("signs with the row's own timestamp when the db read-back finds nothing, and tolerates a result without rows", async () => {
        const execute = vi.fn().mockResolvedValue(undefined);
        const items = [{ row: { ID: 1, CREATED_TS: "mine" }, original: { ID: 1, ROW_HASH: "good" }, newPk: 5 }];
        const r = await DataRestoreService._verifyThenSign(childEntry as never, items, { execute } as never);
        expect(r.signRows).toEqual([{ ID: 5, ROW_HASH: "signed:5:mine" }]);
    });

    it("reads canonical timestamps in groups of 1000 pks", async () => {
        const execute = vi.fn().mockResolvedValue({ rows: [] });
        const items = Array.from({ length: 1001 }, (_, i) => ({ row: { ID: i }, original: { ID: i, ROW_HASH: "good" }, newPk: i }));
        await DataRestoreService._verifyThenSign(childEntry as never, items, { execute } as never);
        expect(execute).toHaveBeenCalledTimes(2);
    });

    it("skips the read-back entirely when the table has no canonical timestamp columns", async () => {
        const execute = vi.fn();
        const entry = { table: "W2_NATURAL", pk: "KEY", rowHashDomain: "W2_NATURAL" };
        const r = await DataRestoreService._verifyThenSign(entry as never, [{ row: { KEY: "a" }, original: { KEY: "a", ROW_HASH: "good" }, newPk: "a" }], { execute } as never);
        expect(execute).not.toHaveBeenCalled();
        expect(r.tampered).toBe(0);
    });

    it.each([
        ["bad hash", { ID: 1, ROW_HASH: "forged" }],
        ["missing hash", { ID: 1 }],
        ["null hash", { ID: 1, ROW_HASH: null }],
    ])("never launders a row with %s: restored with ROW_HASH null, counted and logged without PII", async (_n, original) => {
        const entry = { table: "W2_NATURAL", pk: "ID", rowHashDomain: "W2_NATURAL" };
        const r = await DataRestoreService._verifyThenSign(entry as never, [{ row: { ID: 1, SECRET: "pii" }, original, newPk: 7 }], { execute: vi.fn() } as never);
        expect(r).toEqual({ signRows: [{ ID: 7, ROW_HASH: null }], tampered: 1 });
        expect(logger.security).toHaveBeenCalledWith("TAMPER_DETECTED", { table: "W2_NATURAL", pk: "1", action: "RESTORE_ORIGINAL_HASH_INVALID" });
        expect(JSON.stringify((logger.security as any).mock.calls)).not.toContain("pii");
        expect(CryptoVault.signRecord).not.toHaveBeenCalled();
    });

    it("treats a non-string ROW_HASH as unverifiable (passes null to the verifier)", async () => {
        const verify = vi.spyOn(CryptoVault, "verifyRecord").mockResolvedValue(false);
        const entry = { table: "W2_NATURAL", pk: "ID", rowHashDomain: "W2_NATURAL" };
        const r = await DataRestoreService._verifyThenSign(entry as never, [{ row: { ID: 1 }, original: { ID: 1, ROW_HASH: 12345 }, newPk: 1 }], { execute: vi.fn() } as never);
        expect(verify.mock.calls[0][2]).toBeNull();
        expect(r.tampered).toBe(1);
    });

    it("counts a row the signer cannot canonicalise as tampered instead of failing the restore", async () => {
        vi.spyOn(TamperDetectionService, "buildSignedFields").mockImplementation(() => { throw new Error("bad row"); });
        const entry = { table: "W2_NATURAL", pk: "ID", rowHashDomain: "W2_NATURAL" };
        const r = await DataRestoreService._verifyThenSign(entry as never, [{ row: { ID: 1 }, original: { ID: 1, ROW_HASH: "good" }, newPk: 1 }], { execute: vi.fn() } as never);
        expect(r.signRows).toEqual([{ ID: 1, ROW_HASH: null }]);
        expect(r.tampered).toBe(1);
    });
});

describe("DataRestoreService small helpers", () => {
    it("buildConfirmPhrase dedupes and sorts groups", () => {
        expect(DataRestoreService.buildConfirmPhrase(["T_", "SERVER_", "T_"], 7)).toBe("RESTORE SERVER_, T_ 7 ROWS");
    });

    it("_returnedIdentity returns numeric identities and fails closed otherwise", () => {
        expect(DataRestoreService._returnedIdentity([{ ID: 5 }], 0, "T", "ID")).toBe(5);
        expect(() => DataRestoreService._returnedIdentity([{ ID: null }], 0, "T", "ID")).toThrow("no identity value returned for row 0");
        expect(() => DataRestoreService._returnedIdentity([], 3, "T", "ID")).toThrow("row 3");
    });
});
