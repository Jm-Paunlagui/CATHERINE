import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/constants/purgeTables", async (importOriginal) => {
    const { makeRegistryMock } = await import("../helpers/restoreWave2");
    return makeRegistryMock(await importOriginal<typeof import("../../../src/constants/purgeTables")>());
});

import JSZip from "jszip";
import DataRestoreService from "../../../src/services/DataRestoreService";
import BackupArchiveService from "../../../src/services/BackupArchiveService";
import DataPurgeService from "../../../src/services/DataPurgeService";
import { CryptoVault } from "../../../src/utils/encryption/CryptoVault";
import { PURGE_ERRORS } from "../../../src/constants/errors";
import { logger } from "../../../src/utils/logger";
import { buildSignedZip } from "../helpers/restoreWave2";
import { stubRestoreWorld } from "../helpers/restoreWave2Setup";

const V = BackupArchiveService.SCHEMA_VERSION;
const DATA = { W2_PARENT: [{ ID: 1 }, { ID: 2 }] };
const PHRASE = "RESTORE T_ 2 ROWS";
let world: ReturnType<typeof stubRestoreWorld>["world"];

beforeEach(() => {
    ({ world } = stubRestoreWorld());
});
afterEach(() => {
    vi.restoreAllMocks();
});

const restore = async (o: Record<string, unknown> = {}, zip?: Buffer) =>
    DataRestoreService.restore({ zipBuffer: zip ?? (await buildSignedZip(V, { data: DATA })), adminId: 1, adminPassword: "pw", confirmPhrase: PHRASE, ...o } as never);

describe("DataRestoreService.restore - authentication and confirmation gates", () => {
    it("rejects an unknown admin with 401 before touching the archive or the database", async () => {
        vi.spyOn(DataPurgeService, "findAdminById").mockResolvedValue(null as never);
        await expect(restore()).rejects.toMatchObject({ message: PURGE_ERRORS.ADMIN_NOT_FOUND, statusCode: 401 });
        expect(CryptoVault.verifyAdminPassword).not.toHaveBeenCalled();
        expect(world.committed + world.rolledBack).toBe(0);
    });

    it("requires an admin password (400, field named)", async () => {
        await expect(restore({ adminPassword: "" })).rejects.toMatchObject({
            message: PURGE_ERRORS.ADMIN_PASSWORD_REQUIRED, statusCode: 400, details: [{ field: "adminPassword", issue: "Required." }],
        });
        expect(CryptoVault.verifyAdminPassword).not.toHaveBeenCalled();
    });

    it("rejects a wrong admin password with 401, logs it, and writes nothing", async () => {
        vi.spyOn(CryptoVault, "verifyAdminPassword").mockResolvedValue({ matched: false, newHash: null });
        await expect(restore({ adminPassword: "wrong" })).rejects.toMatchObject({ message: PURGE_ERRORS.INVALID_ADMIN_PASSWORD, statusCode: 401 });
        expect(logger.warning).toHaveBeenCalled();
        expect(world.inserts).toEqual([]);
        expect(world.committed + world.rolledBack).toBe(0);
    });

    it("verifies the password with the admin-mode verifier against the stored hash", async () => {
        await restore();
        expect(CryptoVault.verifyAdminPassword).toHaveBeenCalledWith("pw", "h");
    });

    it("requires the confirm phrase (400)", async () => {
        await expect(restore({ confirmPhrase: "" })).rejects.toMatchObject({
            message: PURGE_ERRORS.CONFIRM_PHRASE_REQUIRED, statusCode: 400, details: [{ field: "confirmPhrase", issue: "Required." }],
        });
        expect(world.inserts).toEqual([]);
    });

    it.each(["restore t_ 2 rows", "RESTORE T_ 3 ROWS", "RESTORE SERVER_ 2 ROWS", "DELETE T_ 2 ROWS"])("rejects confirm phrase %j with 422", async (phrase) => {
        await expect(restore({ confirmPhrase: phrase })).rejects.toMatchObject({ message: PURGE_ERRORS.CONFIRM_PHRASE_MISMATCH, statusCode: 422 });
        expect(world.inserts).toEqual([]);
    });

    it("trims whitespace around an otherwise exact confirm phrase", async () => {
        await expect(restore({ confirmPhrase: `  ${PHRASE}\n` })).resolves.toMatchObject({ totalInserted: 2 });
    });
});

describe("DataRestoreService.restore - tampered archives never reach the database", () => {
    it("a byte flipped in a data file is refused and nothing is inserted", async () => {
        const good = await buildSignedZip(V, { data: DATA });
        const zip = await JSZip.loadAsync(good);
        const text = await zip.file("data/W2_PARENT.jsonl")!.async("string");
        zip.file("data/W2_PARENT.jsonl", text.replace('"ID":1', '"ID":9'));
        const tampered = await zip.generateAsync({ type: "nodebuffer" });
        await expect(restore({}, tampered)).rejects.toMatchObject({ message: PURGE_ERRORS.RESTORE_SIGNATURE_INVALID, statusCode: 422 });
        expect(world.inserts).toEqual([]);
        expect(world.committed + world.rolledBack).toBe(0);
    });

    it("an edited manifest (kind flipped to ENTITY) is refused: HMAC covers the manifest hash", async () => {
        const good = await buildSignedZip(V, { data: DATA });
        const zip = await JSZip.loadAsync(good);
        const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
        manifest.kind = "ENTITY";
        zip.file("manifest.json", JSON.stringify(manifest));
        await expect(restore({}, await zip.generateAsync({ type: "nodebuffer" }))).rejects.toMatchObject({ message: PURGE_ERRORS.RESTORE_SIGNATURE_INVALID });
        expect(world.inserts).toEqual([]);
    });

    it("a hash map re-signed with a DIFFERENT key (HMAC forgery) is refused", async () => {
        const good = await buildSignedZip(V, { data: DATA });
        const zip = await JSZip.loadAsync(good);
        const sig = JSON.parse(await zip.file("signature.json")!.async("string"));
        sig.digest = "a".repeat(sig.digest.length);
        zip.file("signature.json", JSON.stringify(sig));
        await expect(restore({}, await zip.generateAsync({ type: "nodebuffer" }))).rejects.toMatchObject({ message: PURGE_ERRORS.RESTORE_SIGNATURE_INVALID });
        expect(world.inserts).toEqual([]);
    });

    it("a validly signed archive naming a protected table is still refused (signature is not the only gate)", async () => {
        const zip = await buildSignedZip(V, { data: DATA, manifest: { scope: { tables: ["W2_PARENT", "W2_PROTECTED"] } } });
        await expect(restore({}, zip)).rejects.toMatchObject({ message: PURGE_ERRORS.PROTECTED_TABLE, statusCode: 403 });
        expect(world.inserts).toEqual([]);
    });

    it("a forged row hash is restored UNSIGNED, never re-signed (CWE-345), with a TAMPER_DETECTED event", async () => {
        const zip = await buildSignedZip(V, { data: { W2_NATURAL: [{ KEY: "k", ROW_HASH: "forged" }] } });
        const r = await restore({ confirmPhrase: "RESTORE SERVER_ 1 ROWS" }, zip);
        expect(r.tamperedRowsRestoredUnsigned).toBe(1);
        expect(r.totalResigned).toBe(0);
        expect(world.bulkUpdate).toHaveBeenCalledWith([{ KEY: "k", ROW_HASH: null }], { keys: ["KEY"] });
        expect(logger.security).toHaveBeenCalledWith("TAMPER_DETECTED", expect.objectContaining({ table: "W2_NATURAL", pk: "k" }));
    });
});
