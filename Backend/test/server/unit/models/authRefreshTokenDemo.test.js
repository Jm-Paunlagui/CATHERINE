"use strict";

/**
 * @fileoverview DEMO_MODE branch of AuthRefreshTokenModel — the in-memory
 * ledger must give the same outcomes as the Oracle table (single-winner
 * rotate, revoke by family / user, boot reload, purge) without opening a
 * connection.
 */

const config = require("../../../../src/config");
const AuthRefreshTokenModel = require("../../../../src/models/auth.refresh.token.model");
const demo = require("../../../../src/models/demo/demoStore");

const ORIGINAL_DEMO_MODE = process.env.DEMO_MODE;
const HOUR = 3_600_000;

function rec(n, { fid = "fam-1", user = "alice", issued = Date.now() } = {}) {
    return {
        jtiHash: String(n).padStart(64, "0"),
        familyId: fid,
        userKey: user,
        roleSource: "user",
        issuedAtMs: issued,
        expiresAtMs: issued + HOUR,
    };
}

describe("AuthRefreshTokenModel — DEMO_MODE", function () {
    beforeEach(function () {
        process.env.DEMO_MODE = "true";
        demo.refreshTokens().length = 0;
        vi.spyOn(config, "withConnection").mockRejectedValue(new Error("no DB in demo"));
        vi.spyOn(config, "withTransaction").mockRejectedValue(new Error("no DB in demo"));
    });

    afterEach(function () {
        demo.refreshTokens().length = 0;
        if (ORIGINAL_DEMO_MODE === undefined) delete process.env.DEMO_MODE;
        else process.env.DEMO_MODE = ORIGINAL_DEMO_MODE;
        vi.restoreAllMocks();
    });

    it("rotate: first wins, replay is 'reused', unknown is 'absent'", async function () {
        await AuthRefreshTokenModel.insert(rec(1));
        const now = new Date();

        await expect(
            AuthRefreshTokenModel.rotate({ oldHash: rec(1).jtiHash, next: rec(2), now, allowAbsent: false }),
        ).resolves.toEqual({ outcome: "ok" });
        await expect(
            AuthRefreshTokenModel.rotate({ oldHash: rec(1).jtiHash, next: rec(3), now, allowAbsent: false }),
        ).resolves.toEqual({ outcome: "reused" });
        await expect(
            AuthRefreshTokenModel.rotate({ oldHash: rec(9).jtiHash, next: rec(4), now, allowAbsent: false }),
        ).resolves.toEqual({ outcome: "absent" });
        await expect(
            AuthRefreshTokenModel.rotate({ oldHash: rec(9).jtiHash, next: rec(5), now, allowAbsent: true }),
        ).resolves.toEqual({ outcome: "ok" });

        const old = demo.refreshTokens().find((r) => r.JTI_HASH === rec(1).jtiHash);
        expect(old.USED_AT).toBe(now);
        expect(old.REPLACED_BY).toBe(rec(2).jtiHash);
    });

    it("revokeFamily / revokeUser / findRevokedSince / rotate-after-revoke", async function () {
        await AuthRefreshTokenModel.insert(rec(1, { fid: "f1" }));
        await AuthRefreshTokenModel.insert(rec(2, { fid: "f2" }));
        await AuthRefreshTokenModel.insert(rec(3, { fid: "f3", user: "bob" }));
        const now = new Date();

        expect(await AuthRefreshTokenModel.revokeFamily("f1", "LOGOUT", now)).toBe(1);
        expect(await AuthRefreshTokenModel.revokeFamily("f1", "LOGOUT", now)).toBe(0);
        expect(await AuthRefreshTokenModel.revokeUser("alice", "PASSWORD_RESET", now)).toEqual(["f2"]);

        await expect(
            AuthRefreshTokenModel.rotate({ oldHash: rec(1).jtiHash, next: rec(7), now, allowAbsent: false }),
        ).resolves.toEqual({ outcome: "revoked" });

        const recent = await AuthRefreshTokenModel.findRevokedSince(new Date(now.getTime() - 1), 10);
        expect(recent.map((r) => r.familyId).sort()).toEqual(["f1", "f2"]);
        expect(await AuthRefreshTokenModel.findRevokedSince(new Date(now.getTime() - 1), 1)).toHaveLength(1);
    });

    it("purgeExpired deletes at most `limit` expired rows", async function () {
        const past = Date.now() - 10 * HOUR;
        await AuthRefreshTokenModel.insert(rec(1, { issued: past }));
        await AuthRefreshTokenModel.insert(rec(2, { issued: past }));
        await AuthRefreshTokenModel.insert(rec(3));

        expect(await AuthRefreshTokenModel.purgeExpired(new Date(), 1)).toBe(1);
        expect(await AuthRefreshTokenModel.purgeExpired(new Date(), 10)).toBe(1);
        expect(demo.refreshTokens()).toHaveLength(1);
    });

    it("insert rejects a duplicate JTI_HASH like UQ_TARTD_JTI_HASH", async function () {
        await AuthRefreshTokenModel.insert(rec(1));
        await expect(AuthRefreshTokenModel.insert(rec(1))).rejects.toThrow(/ORA-00001/);
    });
});
