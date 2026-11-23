import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/constants/purgeTables", async (importOriginal) => {
    const { makeRegistryMock } = await import("../helpers/restoreWave2");
    return makeRegistryMock(await importOriginal<typeof import("../../../src/constants/purgeTables")>());
});

import DataRestoreService from "../../../src/services/DataRestoreService";
import BackupArchiveService from "../../../src/services/BackupArchiveService";
import DataPurgeModel from "../../../src/models/data-purge.model";
import AuditLogModel from "../../../src/models/audit.log.model";
import { registry } from "../../../src/middleware/cache";
import { PURGE_ERRORS } from "../../../src/constants/errors";
import { buildSignedZip } from "../helpers/restoreWave2";
import { stubRestoreWorld } from "../helpers/restoreWave2Setup";

const V = BackupArchiveService.SCHEMA_VERSION;
const PHRASE = "RESTORE T_ 3 ROWS";
const DATA = { W2_PARENT: [{ ID: 1 }, { ID: 2 }], W2_CHILD: [{ ID: 10, PARENT_ID: 1, ROW_HASH: "good" }] };
let world: ReturnType<typeof stubRestoreWorld>["world"];

beforeEach(() => {
    ({ world } = stubRestoreWorld());
});
afterEach(() => {
    vi.restoreAllMocks();
});

const restore = async (data: Record<string, any[]> = DATA, phrase = PHRASE) =>
    DataRestoreService.restore({ zipBuffer: await buildSignedZip(V, { data }), adminId: 1, adminPassword: "pw", confirmPhrase: phrase });

/** After any failure the transaction rolled back and no post-commit side effect ran. */
async function expectRolledBack(p: Promise<unknown>, message?: string | RegExp) {
    await expect(p).rejects.toThrow(message);
    expect(world.rolledBack).toBe(1);
    expect(world.committed).toBe(0);
    await Promise.resolve();
    expect(AuditLogModel.insert).not.toHaveBeenCalled();
    expect(registry.flushAll).not.toHaveBeenCalled();
}

describe("DataRestoreService.restore - atomic rollback", () => {
    it("a failing insert of a later table rolls the whole restore back", async () => {
        const real = vi.mocked(DataPurgeModel.insertRestoreBatch).getMockImplementation()!;
        vi.mocked(DataPurgeModel.insertRestoreBatch).mockImplementation((async (table: string, rows: any[], s: unknown) => {
            if (table === "W2_CHILD") throw new Error("ORA-00001: unique constraint violated");
            return real(table, rows, s as never);
        }) as never);
        await expectRolledBack(restore(), "ORA-00001");
        expect(world.inserts.map((i) => i.table)).toEqual(["W2_PARENT"]);
    });

    it("a child row pointing at a parent that is not in the archive aborts (internally inconsistent archive)", async () => {
        await expectRolledBack(restore({ W2_PARENT: [{ ID: 1 }], W2_CHILD: [{ ID: 10, PARENT_ID: 99, ROW_HASH: "good" }] }, "RESTORE T_ 2 ROWS"), /references "W2_PARENT" value "99"/);
        expect(world.inserts.map((i) => i.table)).toEqual(["W2_PARENT"]);
    });

    it("a missing RETURNING identity aborts instead of remapping against a guess", async () => {
        vi.mocked(DataPurgeModel.insertRestoreBatch).mockResolvedValue({ insertedCount: 2, returning: [{ ID: null }, {}] } as never);
        await expectRolledBack(restore(), /no identity value returned for row 0/);
    });

    it("a failing ROW_HASH update aborts and reports no restore", async () => {
        world.bulkUpdate.mockRejectedValue(new Error("update failed"));
        await expectRolledBack(restore(), "update failed");
    });

    it("a connection failure while acquiring the transaction leaves no writes or side effects", async () => {
        const { Transaction } = await import("../../../src/utils/oracle-mongo-wrapper");
        vi.mocked(Transaction.prototype.withTransaction).mockRejectedValue(new Error("ORA-12541: no listener"));
        await expect(restore()).rejects.toThrow("ORA-12541");
        expect(world.inserts).toEqual([]);
        expect(AuditLogModel.insert).not.toHaveBeenCalled();
        expect(registry.flushAll).not.toHaveBeenCalled();
    });

    it("a successful restore commits exactly once with post-commit effects", async () => {
        await restore();
        expect(world.committed).toBe(1);
        expect(world.rolledBack).toBe(0);
        expect(registry.flushAll).toHaveBeenCalledTimes(1);
    });
});

describe("DataRestoreService.restore - drift abort", () => {
    it("aborts with 409 before opening a transaction when a target filled up since preview", async () => {
        const zipBuffer = await buildSignedZip(V, { data: DATA });
        await expect(DataRestoreService.preview({ zipBuffer })).resolves.toMatchObject({ kind: "FULL_SCOPE" });
        vi.spyOn(DataPurgeModel, "countRows").mockResolvedValue({ W2_PARENT: 1, W2_CHILD: 0 });
        await expect(DataRestoreService.restore({ zipBuffer, adminId: 1, adminPassword: "pw", confirmPhrase: PHRASE }))
            .rejects.toMatchObject({ message: PURGE_ERRORS.RESTORE_TARGET_NOT_EMPTY, statusCode: 409 });
        expect(world.committed + world.rolledBack).toBe(0);
        expect(world.inserts).toEqual([]);
    });

    it("an ENTITY row that appeared since preview aborts with 409 and writes nothing", async () => {
        vi.spyOn(DataPurgeModel, "existsByKey").mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        const zipBuffer = await buildSignedZip(V, { data: { W2_PARENT: DATA.W2_PARENT }, manifest: { kind: "ENTITY", entity: { table: "W2_PARENT", keyColumn: "ID", keyValue: 1 } } });
        await DataRestoreService.preview({ zipBuffer });
        await expect(DataRestoreService.restore({ zipBuffer, adminId: 1, adminPassword: "pw", confirmPhrase: "RESTORE T_ 2 ROWS" }))
            .rejects.toMatchObject({ message: PURGE_ERRORS.RESTORE_ENTITY_KEY_PRESENT, statusCode: 409 });
        expect(world.inserts).toEqual([]);
    });
});
