"use strict";

/**
 * @fileoverview RefreshTokenService + AccessRevocationService. Ledger model,
 * cluster RPC and SSE registry are faked; registry and revoked-set are REAL.
 * Security: CWE-613 (revocation fails closed), CWE-294 (reuse kills the family).
 */

import RefreshTokenService from "../../../../src/services/RefreshTokenService";
import AccessRevocationService from "../../../../src/services/AccessRevocationService";
import AuthRefreshTokenModel from "../../../../src/models/auth.refresh.token.model";
import { refreshTokenRegistry } from "../../../../src/utils/auth/RefreshTokenRegistry";
import { revokedSessions } from "../../../../src/utils/auth/RevokedSessionSet";
import { hashJti } from "../../../../src/utils/auth/tokenClaims";
import { clusterRpc } from "../../../../src/utils/cluster/ClusterRpcClient";
import SseConnectionRegistry from "../../../../src/utils/sse/SseConnectionRegistry";
import { AUTH_ERRORS } from "../../../../src/constants/errors";
import { ACCESS_REVOCATION_LIMITS, REFRESH_REVOKE_REASONS } from "../../../../src/constants/authTokens";
import { canonicalUserKey as ck } from "../../../../src/utils/auth/userKey";

const FID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const FID2 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const next = { jtiHash: "n".repeat(64), familyId: FID, userKey: "u1", expiresAtMs: Date.now() + 1000 } as never;

async function rejects(p: Promise<unknown>): Promise<any> {
    try {
        await p;
    } catch (e) {
        return e;
    }
    throw new Error("expected rejection");
}

describe("RefreshTokenService", () => {
    beforeEach(() => {
        refreshTokenRegistry.clear();
        revokedSessions.clear();
        vi.spyOn(SseConnectionRegistry, "endFamilies").mockReturnValue(0);
        vi.spyOn(clusterRpc, "active", "get").mockReturnValue(false);
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("persistIssued writes the ledger row and propagates a DB failure (login must fail closed)", async () => {
        const ins = vi.spyOn(AuthRefreshTokenModel, "insert").mockResolvedValue();
        await RefreshTokenService.persistIssued(next);
        expect(ins).toHaveBeenCalledWith(next);
        ins.mockRejectedValueOnce(new Error("db down"));
        await expect(RefreshTokenService.persistIssued(next)).rejects.toThrow("db down");
    });

    describe("rotate", () => {
        const claims = { jti: "jti-1", familyId: FID, userId: "u1" };
        const known = () =>
            refreshTokenRegistry.register({ jtiHash: hashJti("jti-1"), familyId: FID, userKey: "u1", expiresAtMs: Date.now() + 60_000 });

        it("ok in both tiers resolves", async () => {
            known();
            const rot = vi.spyOn(AuthRefreshTokenModel, "rotate").mockResolvedValue({ outcome: "ok" });
            await expect(RefreshTokenService.rotate(claims, next)).resolves.toBeUndefined();
            expect(rot.mock.calls[0][0].allowAbsent).toBe(true);
        });

        it("registry says reused -> family revoked (best effort) and 401 REUSED, DB rotate never called", async () => {
            known();
            vi.spyOn(AuthRefreshTokenModel, "rotate").mockResolvedValue({ outcome: "ok" });
            const rev = vi.spyOn(AuthRefreshTokenModel, "revokeFamily").mockRejectedValue(new Error("db down"));
            await RefreshTokenService.rotate(claims, next);
            vi.mocked(AuthRefreshTokenModel.rotate).mockClear();
            const err = await rejects(RefreshTokenService.rotate(claims, next));
            expect(err.statusCode).toBe(401);
            expect(err.message).toBe(AUTH_ERRORS.REFRESH_TOKEN_REUSED);
            expect(rev).toHaveBeenCalledWith(FID, REFRESH_REVOKE_REASONS.REUSE, expect.any(Date));
            expect(AuthRefreshTokenModel.rotate).not.toHaveBeenCalled();
            expect(AccessRevocationService.isRevoked(FID)).toBe(true);
        });

        it("registry says the family is revoked -> 401 REVOKED without a DB call", async () => {
            refreshTokenRegistry.revokeFamily(FID);
            const rot = vi.spyOn(AuthRefreshTokenModel, "rotate");
            const err = await rejects(RefreshTokenService.rotate(claims, next));
            expect(err.message).toBe(AUTH_ERRORS.REFRESH_TOKEN_REVOKED);
            expect(rot).not.toHaveBeenCalled();
        });

        it("DB 'reused' revokes the family; DB 'revoked' / 'absent' are refused", async () => {
            vi.spyOn(AuthRefreshTokenModel, "revokeFamily").mockResolvedValue(1);
            const rot = vi.spyOn(AuthRefreshTokenModel, "rotate");
            rot.mockResolvedValueOnce({ outcome: "reused" });
            expect((await rejects(RefreshTokenService.rotate(claims, next))).message).toBe(AUTH_ERRORS.REFRESH_TOKEN_REUSED);
            for (const outcome of ["revoked", "absent"] as const) {
                refreshTokenRegistry.clear();
                rot.mockResolvedValueOnce({ outcome });
                expect((await rejects(RefreshTokenService.rotate({ ...claims, familyId: FID2 }, next))).message).toBe(AUTH_ERRORS.REFRESH_TOKEN_REVOKED);
            }
        });

        it("a DB error un-consumes the local mark so the client's retry is not read as reuse; unknown token passes allowAbsent=false", async () => {
            known();
            const rot = vi.spyOn(AuthRefreshTokenModel, "rotate").mockRejectedValueOnce(new Error("timeout"));
            await expect(RefreshTokenService.rotate(claims, next)).rejects.toThrow("timeout");
            rot.mockResolvedValueOnce({ outcome: "ok" });
            await expect(RefreshTokenService.rotate(claims, next)).resolves.toBeUndefined();

            refreshTokenRegistry.clear();
            rot.mockRejectedValueOnce(new Error("timeout"));
            await expect(RefreshTokenService.rotate(claims, next)).rejects.toThrow("timeout");
            expect(rot.mock.calls.at(-1)![0].allowAbsent).toBe(false);
        });
    });

    describe("revokeFamily", () => {
        it("does nothing for an empty family id", async () => {
            const rev = vi.spyOn(AuthRefreshTokenModel, "revokeFamily");
            await RefreshTokenService.revokeFamily("", "LOGOUT");
            expect(rev).not.toHaveBeenCalled();
        });

        it("ends the access session locally BEFORE the DB write", async () => {
            let revokedWhenDbCalled: boolean | undefined;
            vi.spyOn(AuthRefreshTokenModel, "revokeFamily").mockImplementation(async () => {
                revokedWhenDbCalled = AccessRevocationService.isRevoked(FID);
                return 1;
            });
            await RefreshTokenService.revokeFamily(FID, "LOGOUT");
            expect(revokedWhenDbCalled).toBe(true);
        });

        it("a DB failure throws by default and is swallowed when bestEffort", async () => {
            vi.spyOn(AuthRefreshTokenModel, "revokeFamily").mockRejectedValue(new Error("db down"));
            await expect(RefreshTokenService.revokeFamily(FID, "LOGOUT")).rejects.toThrow("db down");
            await expect(RefreshTokenService.revokeFamily(FID, "LOGOUT", { bestEffort: true })).resolves.toBeUndefined();
            vi.mocked(AuthRefreshTokenModel.revokeFamily).mockRejectedValueOnce("string failure");
            await expect(RefreshTokenService.revokeFamily(FID, "LOGOUT", { bestEffort: true })).resolves.toBeUndefined();
            expect(AccessRevocationService.isRevoked(FID)).toBe(true); // still ended locally
        });

        it("retryTransient retries a transient DB error once (fake clock) and then succeeds", async () => {
            vi.useFakeTimers();
            const transient = Object.assign(new Error("ORA-03113: end-of-file on communication channel"), { code: "ORA-03113" });
            const rev = vi.spyOn(AuthRefreshTokenModel, "revokeFamily").mockRejectedValueOnce(transient).mockResolvedValueOnce(1);
            const p = RefreshTokenService.revokeFamily(FID, "LOGOUT", { retryTransient: true });
            await vi.runAllTimersAsync();
            await expect(p).resolves.toBeUndefined();
            expect(rev).toHaveBeenCalledTimes(2);
        });

        it("retryTransient on a permanent error does not retry", async () => {
            const rev = vi.spyOn(AuthRefreshTokenModel, "revokeFamily").mockRejectedValue(Object.assign(new Error("ORA-00942: table or view does not exist"), { code: "ORA-00942" }));
            await expect(RefreshTokenService.revokeFamily(FID, "LOGOUT", { retryTransient: true })).rejects.toThrow("ORA-00942");
            expect(rev).toHaveBeenCalledTimes(1);
        });
    });

    describe("revokeAllForUser", () => {
        it("ends known and DB-named families, canonicalises the key, and logs the cause", async () => {
            refreshTokenRegistry.register({ jtiHash: "h1", familyId: FID, userKey: ck("030901"), expiresAtMs: Date.now() + 1000 });
            const rev = vi.spyOn(AuthRefreshTokenModel, "revokeUser").mockResolvedValue([FID2]);
            await RefreshTokenService.revokeAllForUser("030901", "PASSWORD_RESET", { cause: "DEACTIVATED" });
            expect(rev).toHaveBeenCalledWith("30901", "PASSWORD_RESET", expect.any(Date));
            expect(AccessRevocationService.isRevoked(FID)).toBe(true);
            expect(AccessRevocationService.isRevoked(FID2)).toBe(true);
            expect(refreshTokenRegistry.consume("h1", null)).toBe("revoked");
        });

        it("works without a cause and FAILS CLOSED on a DB error (local sessions already ended)", async () => {
            vi.spyOn(AuthRefreshTokenModel, "revokeUser").mockResolvedValueOnce([]);
            await expect(RefreshTokenService.revokeAllForUser("u9", "LOGOUT")).resolves.toBeUndefined();
            refreshTokenRegistry.register({ jtiHash: "h2", familyId: FID, userKey: "u9", expiresAtMs: Date.now() + 1000 });
            vi.mocked(AuthRefreshTokenModel.revokeUser).mockRejectedValueOnce(new Error("db down"));
            await expect(RefreshTokenService.revokeAllForUser("u9", "LOGOUT")).rejects.toThrow("db down");
            expect(AccessRevocationService.isRevoked(FID)).toBe(true);
        });
    });

    describe("purgeExpired", () => {
        it("deletes older than the grace window; never throws", async () => {
            const purge = vi.spyOn(AuthRefreshTokenModel, "purgeExpired").mockResolvedValueOnce(12);
            await expect(RefreshTokenService.purgeExpired()).resolves.toBe(12);
            expect(purge).toHaveBeenCalledWith(expect.any(Date), 500);
            purge.mockRejectedValueOnce(new Error("db down"));
            await expect(RefreshTokenService.purgeExpired()).resolves.toBe(0);
            purge.mockRejectedValueOnce("odd");
            await expect(RefreshTokenService.purgeExpired()).resolves.toBe(0);
        });
    });
});

describe("AccessRevocationService", () => {
    let ends: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
        revokedSessions.clear();
        ends = vi.spyOn(SseConnectionRegistry, "endFamilies").mockReturnValue(0);
        vi.spyOn(clusterRpc, "active", "get").mockReturnValue(false);
    });
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it("retentionMs is the access TTL + skew, clamped to the IPC maximum", () => {
        vi.stubEnv("JWT_EXPIRES_IN", "30m");
        expect(AccessRevocationService.retentionMs()).toBe(30 * 60_000 + ACCESS_REVOCATION_LIMITS.CLOCK_SKEW_MS);
        vi.stubEnv("JWT_EXPIRES_IN", "99999d");
        expect(AccessRevocationService.retentionMs()).toBe(ACCESS_REVOCATION_LIMITS.MAX_TTL_MS);
    });

    it("an unparseable JWT_EXPIRES_IN falls back to the refresh lifetime (never shorter)", () => {
        vi.stubEnv("JWT_EXPIRES_IN", "half an hour");
        const expected = ACCESS_REVOCATION_LIMITS.FALLBACK_TTL_MS + ACCESS_REVOCATION_LIMITS.CLOCK_SKEW_MS;
        expect(AccessRevocationService.retentionMs()).toBe(expected);
        expect(AccessRevocationService.retentionMs()).toBe(expected); // warns once, same answer
    });

    it("revoke records valid family ids only, de-duplicates, ends SSE streams, and ignores non-arrays", () => {
        expect(AccessRevocationService.revoke([FID, FID, "not-a-family", 5 as never], 1000)).toBe(1);
        expect(AccessRevocationService.isRevoked(FID, 1001)).toBe(true);
        expect(ends).toHaveBeenCalledWith([FID]);
        ends.mockClear();
        expect(AccessRevocationService.revoke(new Set([FID2]) as never)).toBe(0); // non-array: nothing
        expect(ends).not.toHaveBeenCalled();
        expect(AccessRevocationService.revoke([FID])).toBe(0); // already recorded
    });

    it("isRevoked is false for a token without a fid and after the entry expires", () => {
        expect(AccessRevocationService.isRevoked(undefined)).toBe(false);
        AccessRevocationService.revoke([FID], 1000);
        const until = revokedSessions.snapshot(1000)[0].untilMs;
        expect(AccessRevocationService.isRevoked(FID, until)).toBe(false);
    });

    it("applyRemote records what the primary sent (and tolerates garbage)", () => {
        expect(AccessRevocationService.applyRemote([{ fid: FID, untilMs: Date.now() + 5000 }])).toBe(1);
        expect(AccessRevocationService.isRevoked(FID)).toBe(true);
        expect(AccessRevocationService.applyRemote(null as never)).toBe(0);
        expect(AccessRevocationService.applyRemote([])).toBe(0);
    });

    it("loadRecent reloads valid families without touching live streams; a DB failure is non-fatal", async () => {
        const now = 10_000_000;
        const find = vi.spyOn(AuthRefreshTokenModel, "findRevokedSince").mockResolvedValue([
            { familyId: FID, revokedAt: new Date(now) },
            { familyId: "junk", revokedAt: new Date(now) },
        ]);
        await expect(AccessRevocationService.loadRecent(now)).resolves.toBe(1);
        expect(AccessRevocationService.isRevoked(FID, now + 1)).toBe(true);
        expect(ends).not.toHaveBeenCalled();
        expect(find.mock.calls[0][1]).toBe(ACCESS_REVOCATION_LIMITS.BOOT_LOAD_LIMIT);
        find.mockRejectedValueOnce(new Error("db down"));
        await expect(AccessRevocationService.loadRecent(now)).resolves.toBe(0);
        find.mockRejectedValueOnce("odd");
        await expect(AccessRevocationService.loadRecent()).resolves.toBe(0);
    });

    it("when the set is full of live entries the drop is logged, not thrown", () => {
        vi.spyOn(revokedSessions, "revoke").mockReturnValue({ added: true, dropped: true });
        expect(AccessRevocationService.revoke([FID])).toBe(1);
    });
});
