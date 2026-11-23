"use strict";

/**
 * @fileoverview BackupTokenModel (exactly-once JTI) and BackupVoteModel
 * (two-person delete votes): DEMO_MODE and Oracle ORA-00001 handling.
 */

import BackupTokenModel from "../../../../src/models/backup-token.model";
import BackupVoteModel from "../../../../src/models/backup-vote.model";
import demo from "../../../../src/models/demo/demoStore";
import { fake } from "../../helpers/modelsWrapperFake";

vi.mock("../../../../src/utils/oracle-mongo-wrapper", async () => (await import("../../helpers/modelsWrapperFake")).wrapperMock);

describe("BackupTokenModel", function () {
    afterEach(function () {
        vi.unstubAllEnvs();
        vi.clearAllMocks();
        demo.backupTokensConsumed().clear();
    });

    it("DEMO_MODE: first consume wins, replay is refused, adminId is numeric", async function () {
        vi.stubEnv("DEMO_MODE", "true");
        const exp = new Date("2030-01-01T00:00:00Z");
        expect(await BackupTokenModel.consumeJti({ jti: "j1", adminId: "42", expiresAt: exp })).toEqual({ consumed: true });
        expect(demo.backupTokensConsumed().get("j1")).toMatchObject({ JTI: "j1", EMP_ID: 42, EXPIRES_AT: exp });
        expect(await BackupTokenModel.consumeJti({ jti: "j1", adminId: 1, expiresAt: exp })).toEqual({ consumed: false, reason: "already-consumed" });
        expect(demo.backupTokensConsumed().get("j1")!.EMP_ID).toBe(42);
    });

    it("DEMO_MODE: concurrent replays yield exactly one winner", async function () {
        vi.stubEnv("DEMO_MODE", "true");
        const exp = new Date();
        const results = await Promise.all(Array.from({ length: 5 }, () => BackupTokenModel.consumeJti({ jti: "race", adminId: 1, expiresAt: exp })));
        expect(results.filter((r) => r.consumed)).toHaveLength(1);
    });

    describe("Oracle mode", function () {
        beforeEach(function () {
            vi.stubEnv("DEMO_MODE", "false");
        });

        it("inserts with RETURNING pinned to JTI (PK is not ID)", async function () {
            fake.insertOne.mockResolvedValue({});
            const exp = new Date();
            expect(await BackupTokenModel.consumeJti({ jti: "jx", adminId: "7", expiresAt: exp })).toEqual({ consumed: true });
            expect(fake.insertOne).toHaveBeenCalledWith({ JTI: "jx", EMP_ID: 7, EXPIRES_AT: exp }, { returning: ["JTI"] });
            expect(fake.ctor.some((c) => c[0] === "T_SERVER_BACKUP_TOKEN_CONSUMED_DEV")).toBe(true);
        });

        it("maps a unique-constraint violation to already-consumed", async function () {
            fake.insertOne.mockRejectedValue(new Error("ORA-00001: unique constraint violated"));
            expect(await BackupTokenModel.consumeJti({ jti: "dup", adminId: 1, expiresAt: new Date() })).toEqual({ consumed: false, reason: "already-consumed" });
        });

        it("rethrows any other database error, including a non-Error rejection", async function () {
            fake.insertOne.mockRejectedValueOnce(new Error("ORA-03113"));
            await expect(BackupTokenModel.consumeJti({ jti: "a", adminId: 1, expiresAt: new Date() })).rejects.toThrow("ORA-03113");
            fake.insertOne.mockRejectedValueOnce(undefined);
            await expect(BackupTokenModel.consumeJti({ jti: "a", adminId: 1, expiresAt: new Date() })).rejects.toBeUndefined();
        });
    });
});

describe("BackupVoteModel", function () {
    afterEach(function () {
        vi.unstubAllEnvs();
        vi.useRealTimers();
        vi.clearAllMocks();
        demo.backupVotes().length = 0;
    });

    describe("DEMO_MODE", function () {
        beforeEach(function () {
            vi.stubEnv("DEMO_MODE", "true");
        });

        it("castVote records once per voter and refuses a duplicate", async function () {
            expect(await BackupVoteModel.castVote("A1", "5", "9")).toEqual({ inserted: true });
            expect(await BackupVoteModel.castVote("A1", 5, 9)).toEqual({ inserted: false, reason: "already-voted" });
            expect(await BackupVoteModel.castVote("A1", 6, 9)).toEqual({ inserted: true });
            expect(await BackupVoteModel.castVote("A2", 5, 9)).toEqual({ inserted: true });
            expect(await BackupVoteModel.countVotesForArchive("A1")).toBe(2);
            expect(await BackupVoteModel.countVotesForArchive("none")).toBe(0);
        });

        it("findVotesByArchive orders by VOTED_AT then VOTE_ID", async function () {
            const t = new Date("2030-01-01T00:00:00Z");
            demo.backupVotes().push(
                { VOTE_ID: 3, ARCHIVE_ID: "A", REQUESTED_BY: 1, VOTED_BY: 3, VOTED_AT: new Date(t.getTime() + 1000) },
                { VOTE_ID: 2, ARCHIVE_ID: "A", REQUESTED_BY: 1, VOTED_BY: 2, VOTED_AT: t },
                { VOTE_ID: 1, ARCHIVE_ID: "A", REQUESTED_BY: 1, VOTED_BY: 1, VOTED_AT: t },
                { VOTE_ID: 4, ARCHIVE_ID: "B", REQUESTED_BY: 1, VOTED_BY: 1, VOTED_AT: t },
            );
            expect((await BackupVoteModel.findVotesByArchive("A")).map((r) => r.VOTE_ID)).toEqual([1, 2, 3]);
        });

        it("findAllPendingVotes groups votes by archive with the first requester", async function () {
            await BackupVoteModel.castVote("A", 1, 10);
            await BackupVoteModel.castVote("B", 2, 20);
            await BackupVoteModel.castVote("A", 3, 10);
            const pending = await BackupVoteModel.findAllPendingVotes();
            expect(pending).toHaveLength(2);
            const a = pending.find((p) => p.archiveId === "A")!;
            expect(a.requestedBy).toBe(10);
            expect(a.votes.map((v) => v.votedBy).sort()).toEqual([1, 3]);
            expect(await (async () => { demo.backupVotes().length = 0; return BackupVoteModel.findAllPendingVotes(); })()).toEqual([]);
        });

        it("cancelRequest deletes only the named archive's rows", async function () {
            await BackupVoteModel.castVote("A", 1, 10);
            await BackupVoteModel.castVote("A", 2, 10);
            await BackupVoteModel.castVote("B", 1, 10);
            expect(await BackupVoteModel.cancelRequest("A")).toEqual({ deletedCount: 2 });
            expect(await BackupVoteModel.cancelRequest("A")).toEqual({ deletedCount: 0 });
            expect(await BackupVoteModel.countVotesForArchive("B")).toBe(1);
        });
    });

    describe("Oracle mode", function () {
        beforeEach(function () {
            vi.stubEnv("DEMO_MODE", "false");
        });

        it("findVotesByArchive binds the archive id and sorts by VOTED_AT", async function () {
            fake.toArray.mockResolvedValue([{ VOTE_ID: 1 }]);
            expect(await BackupVoteModel.findVotesByArchive("x' OR 1=1")).toEqual([{ VOTE_ID: 1 }]);
            expect(fake.findArgs.at(-1)).toEqual({ ARCHIVE_ID: "x' OR 1=1" });
            expect(fake.chain).toEqual([{ op: "sort", arg: { VOTED_AT: 1 } }]);
        });

        it("findAllPendingVotes groups rows returned by the database", async function () {
            const at = new Date();
            fake.toArray.mockResolvedValue([
                { ARCHIVE_ID: "A", REQUESTED_BY: 1, VOTED_BY: 1, VOTED_AT: at },
                { ARCHIVE_ID: "A", REQUESTED_BY: 1, VOTED_BY: 2, VOTED_AT: at },
            ]);
            expect(await BackupVoteModel.findAllPendingVotes()).toEqual([
                { archiveId: "A", requestedBy: 1, votes: [{ votedBy: 1, votedAt: at }, { votedBy: 2, votedAt: at }] },
            ]);
        });

        it("castVote inserts numeric ids with RETURNING pinned to VOTE_ID", async function () {
            fake.insertOne.mockResolvedValue({});
            expect(await BackupVoteModel.castVote("A", "3", "4")).toEqual({ inserted: true });
            expect(fake.insertOne).toHaveBeenCalledWith({ ARCHIVE_ID: "A", REQUESTED_BY: 4, VOTED_BY: 3 }, { returning: ["VOTE_ID"] });
        });

        it("castVote maps ORA-00001 to already-voted and rethrows the rest", async function () {
            fake.insertOne.mockRejectedValueOnce(new Error("ORA-00001"));
            expect(await BackupVoteModel.castVote("A", 1, 1)).toEqual({ inserted: false, reason: "already-voted" });
            fake.insertOne.mockRejectedValueOnce(new Error("ORA-00904"));
            await expect(BackupVoteModel.castVote("A", 1, 1)).rejects.toThrow("ORA-00904");
            fake.insertOne.mockRejectedValueOnce(undefined);
            await expect(BackupVoteModel.castVote("A", 1, 1)).rejects.toBeUndefined();
        });

        it("cancelRequest returns deletedCount, defaulting to 0", async function () {
            fake.deleteMany.mockResolvedValueOnce({ deletedCount: 3 });
            expect(await BackupVoteModel.cancelRequest("A")).toEqual({ deletedCount: 3 });
            expect(fake.deleteMany).toHaveBeenCalledWith({ ARCHIVE_ID: "A" });
            fake.deleteMany.mockResolvedValueOnce({});
            expect(await BackupVoteModel.cancelRequest("A")).toEqual({ deletedCount: 0 });
        });

        it("countVotesForArchive delegates to a filtered count", async function () {
            fake.count.mockResolvedValue(2);
            expect(await BackupVoteModel.countVotesForArchive("A")).toBe(2);
            expect(fake.findArgs.at(-1)).toEqual({ ARCHIVE_ID: "A" });
        });
    });
});
