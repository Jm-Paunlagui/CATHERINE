"use strict";

/**
 * @fileoverview Security properties of the persistence models: single-use
 * backup tokens (replay refused), two-person vote integrity (no double vote),
 * allow-listed purge tables / key columns, and hostile input travelling as
 * bind data only.
 */

import BackupTokenModel from "../../../src/models/backup-token.model";
import BackupVoteModel from "../../../src/models/backup-vote.model";
import DataPurgeModel from "../../../src/models/data-purge.model";
import AdminModel from "../../../src/models/admin.model";
import { fake } from "../helpers/modelsWrapperFake";

vi.mock("../../../src/utils/oracle-mongo-wrapper", async () => (await import("../helpers/modelsWrapperFake")).wrapperMock);

describe("models security (Oracle mode, faked driver)", function () {
    beforeEach(function () {
        vi.stubEnv("DEMO_MODE", "false");
    });

    afterEach(function () {
        vi.unstubAllEnvs();
        vi.clearAllMocks();
        fake.insertOne.mockReset();
    });

    it("a replayed backup token is refused once the DB reports the PK violation", async function () {
        fake.insertOne.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("ORA-00001: unique constraint"));
        const exp = new Date(Date.now() + 60_000);
        const first = await BackupTokenModel.consumeJti({ jti: "same", adminId: 1, expiresAt: exp });
        const replay = await BackupTokenModel.consumeJti({ jti: "same", adminId: 1, expiresAt: exp });
        expect([first.consumed, replay.consumed]).toEqual([true, false]);
    });

    it("a second vote by the same admin never counts as a new vote", async function () {
        fake.insertOne.mockRejectedValueOnce(new Error("ORA-00001"));
        expect(await BackupVoteModel.castVote("A", 5, 5)).toEqual({ inserted: false, reason: "already-voted" });
    });

    it("purge refuses table names and key columns outside the registry", async function () {
        await expect(DataPurgeModel.countRows(['T_ADMINS_DEV" WHERE 1=1 --'])).rejects.toThrow("not a registered purge table");
        await expect(DataPurgeModel.existsByKey("T_SERVER_ALERT_LOG_DEV", "ID OR 1=1", 1)).rejects.toThrow("refusing an arbitrary column lookup");
        expect(fake.countDocuments).not.toHaveBeenCalled();
        expect(fake.findOne).not.toHaveBeenCalled();
    });

    it("admin search escapes LIKE wildcards and sends the needle as a bind", async function () {
        const execute = vi.fn().mockResolvedValue({ rows: [] });
        fake.db.withConnection.mockImplementation(async (fn: (c: unknown) => unknown) => fn({ execute }));
        await AdminModel.search("100%_\\' OR '1'='1");
        const [sql, binds] = execute.mock.calls[0];
        expect(sql).not.toContain("OR '1'='1");
        expect(binds.q).toBe("%100\\%\\_\\\\' OR '1'='1%".toUpperCase());
    });

    it("admin lookups pass hostile usernames as filter values only", async function () {
        fake.next.mockResolvedValue(null);
        await AdminModel.findByUsername("admin'--");
        expect(fake.findArgs.at(-1)).toEqual({ USERNAME: "admin'--" });
    });
});
