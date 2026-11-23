"use strict";

/**
 * @fileoverview AuthRefreshTokenModel Oracle path: every statement is
 * parameterised (binds, never interpolated values); rotation resolves the
 * single-winner / reused / revoked / absent outcomes from rowsAffected and the
 * state SELECT. Complements authRefreshTokenDemo.test.ts.
 */

import AuthRefreshTokenModel from "../../../../src/models/auth.refresh.token.model";
import { fake } from "../../helpers/modelsWrapperFake";

vi.mock("../../../../src/utils/oracle-mongo-wrapper", async () => (await import("../../helpers/modelsWrapperFake")).wrapperMock);

const rec = (n: string) => ({ jtiHash: n, familyId: "fam", userKey: "alice", roleSource: "user" as const, issuedAtMs: 1_000, expiresAtMs: 2_000 });
const NOW = new Date("2026-06-01T00:00:00Z");

describe("AuthRefreshTokenModel (Oracle path)", function () {
    const conn = { execute: vi.fn() };

    beforeEach(function () {
        vi.stubEnv("DEMO_MODE", "false");
        conn.execute.mockReset();
        fake.db.withTransaction.mockReset().mockImplementation(async (fn: (c: typeof conn) => unknown) => fn(conn));
        fake.db.withConnection.mockReset().mockImplementation(async (fn: (c: typeof conn) => unknown) => fn(conn));
    });

    afterEach(function () {
        vi.unstubAllEnvs();
        vi.clearAllMocks();
    });

    it("insert binds every value and keeps SQL free of them", async function () {
        const hostile = { ...rec("h'); DROP TABLE x;--"), familyId: "f'1" };
        await AuthRefreshTokenModel.insert(hostile);
        const [sql, binds] = conn.execute.mock.calls[0];
        expect(sql).toContain("INSERT INTO T_AUTH_REFRESH_TOKEN_DEV");
        expect(sql).not.toContain("DROP");
        expect(sql).not.toContain("f'1");
        expect(binds).toEqual({ hash: hostile.jtiHash, fid: "f'1", userKey: "alice", roleSource: "user", issuedTs: new Date(1_000), expiresTs: new Date(2_000) });
    });

    describe("rotate", function () {
        const args = (allowAbsent: boolean) => ({ oldHash: "old", next: rec("new"), now: NOW, allowAbsent });

        it("ok: a single updated row triggers the follow-up insert", async function () {
            conn.execute.mockResolvedValueOnce({ rowsAffected: 1 }).mockResolvedValueOnce({ rowsAffected: 1 });
            expect(await AuthRefreshTokenModel.rotate(args(false))).toEqual({ outcome: "ok" });
            expect(conn.execute.mock.calls[0][1]).toEqual({ nowTs: NOW, newHash: "new", hash: "old" });
            expect(conn.execute.mock.calls[1][0]).toContain("INSERT INTO");
        });

        it("absent: unknown token is refused unless allowAbsent is set", async function () {
            conn.execute.mockResolvedValueOnce({ rowsAffected: 0 }).mockResolvedValueOnce({ rows: [] });
            expect(await AuthRefreshTokenModel.rotate(args(false))).toEqual({ outcome: "absent" });
            expect(conn.execute).toHaveBeenCalledTimes(2);
        });

        it("allowAbsent: unknown token is accepted and the successor inserted", async function () {
            conn.execute.mockResolvedValueOnce({ rowsAffected: 0 }).mockResolvedValueOnce({}).mockResolvedValueOnce({ rowsAffected: 1 });
            expect(await AuthRefreshTokenModel.rotate(args(true))).toEqual({ outcome: "ok" });
            expect(conn.execute.mock.calls[2][0]).toContain("INSERT INTO");
        });

        it("revoked vs reused: a revoked row wins over a merely used one", async function () {
            conn.execute.mockResolvedValueOnce({ rowsAffected: undefined }).mockResolvedValueOnce({ rows: [{ REVOKED_AT: NOW, USED_AT: null }] });
            expect(await AuthRefreshTokenModel.rotate(args(false))).toEqual({ outcome: "revoked" });
            conn.execute.mockResolvedValueOnce({ rowsAffected: 0 }).mockResolvedValueOnce({ rows: [{ REVOKED_AT: null, USED_AT: NOW }] });
            expect(await AuthRefreshTokenModel.rotate(args(false))).toEqual({ outcome: "reused" });
        });

        it("propagates a failure so the transaction rolls back", async function () {
            conn.execute.mockRejectedValueOnce(new Error("ORA-00060"));
            await expect(AuthRefreshTokenModel.rotate(args(false))).rejects.toThrow("ORA-00060");
        });
    });

    it("revokeFamily returns rowsAffected (0 when absent) and binds reason", async function () {
        conn.execute.mockResolvedValueOnce({ rowsAffected: 3 });
        expect(await AuthRefreshTokenModel.revokeFamily("fam", "reuse'--", NOW)).toBe(3);
        expect(conn.execute.mock.calls[0][1]).toEqual({ nowTs: NOW, reason: "reuse'--", fid: "fam" });
        conn.execute.mockResolvedValueOnce({});
        expect(await AuthRefreshTokenModel.revokeFamily("fam", "r", NOW)).toBe(0);
        fake.db.withTransaction.mockResolvedValueOnce(undefined);
        expect(await AuthRefreshTokenModel.revokeFamily("fam", "r", NOW)).toBe(0);
    });

    it("revokeUser returns the distinct non-string-filtered family ids", async function () {
        fake.updateMany.mockResolvedValueOnce({ returning: [{ FAMILY_ID: "a" }, { FAMILY_ID: "a" }, { FAMILY_ID: "b" }, { FAMILY_ID: null }, {}] });
        expect(await AuthRefreshTokenModel.revokeUser("alice", "logout", NOW)).toEqual(["a", "b"]);
        const [filter, update, opts] = fake.updateMany.mock.calls[0];
        expect(filter).toEqual({ USER_ID: "alice", REVOKED_AT: null });
        expect(update).toEqual({ $set: { REVOKED_AT: NOW, REVOKE_REASON: "logout" } });
        expect(opts).toEqual({ returning: ["FAMILY_ID"] });
        fake.updateMany.mockResolvedValueOnce({});
        expect(await AuthRefreshTokenModel.revokeUser("alice", "x", NOW)).toEqual([]);
    });

    it("findRevokedSince maps well-formed rows only", async function () {
        conn.execute.mockResolvedValueOnce({ rows: [
            { FAMILY_ID: "a", REVOKED_AT: NOW },
            { FAMILY_ID: 5, REVOKED_AT: NOW },
            { FAMILY_ID: "b", REVOKED_AT: "not-a-date" },
        ] });
        expect(await AuthRefreshTokenModel.findRevokedSince(NOW, 10)).toEqual([{ familyId: "a", revokedAt: NOW }]);
        expect(conn.execute.mock.calls[0][1]).toEqual({ sinceTs: NOW, lim: 10 });
        conn.execute.mockResolvedValueOnce(undefined);
        expect(await AuthRefreshTokenModel.findRevokedSince(NOW, 10)).toEqual([]);
    });

    it("purgeExpired issues a bounded delete, and none for a non-positive limit", async function () {
        fake.deleteMany.mockResolvedValueOnce({ deletedCount: 7 });
        expect(await AuthRefreshTokenModel.purgeExpired(NOW, 10.9)).toBe(7);
        expect(fake.deleteMany).toHaveBeenCalledWith({ EXPIRES_AT: { $lt: NOW } }, { limit: 10 });
        fake.deleteMany.mockClear();
        for (const bad of [0, -3, NaN, "x" as never, undefined as never]) expect(await AuthRefreshTokenModel.purgeExpired(NOW, bad)).toBe(0);
        expect(fake.deleteMany).not.toHaveBeenCalled();
    });
});
