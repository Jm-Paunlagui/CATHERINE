"use strict";

/**
 * @fileoverview Reliability: refresh-token rotation under DB faults and
 * concurrency. Registry/revocation are real; the ledger table is faked.
 */

import RefreshTokenService from "../../../src/services/RefreshTokenService";
import AuthRefreshTokenModel from "../../../src/models/auth.refresh.token.model";
import SseConnectionRegistry from "../../../src/utils/sse/SseConnectionRegistry";
import { clusterRpc } from "../../../src/utils/cluster/ClusterRpcClient";
import { refreshTokenRegistry } from "../../../src/utils/auth/RefreshTokenRegistry";
import { revokedSessions } from "../../../src/utils/auth/RevokedSessionSet";
import { hashJti } from "../../../src/utils/auth/tokenClaims";
import { AUTH_ERRORS } from "../../../src/constants/errors";

const FID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const rec = (n: number) => ({ jtiHash: `next-${n}`, familyId: FID, userId: "u", userKey: "u", roleSource: "user", issuedAtMs: 0, expiresAtMs: Date.now() + 60_000 }) as never;

describe("refresh rotation reliability", () => {
    beforeEach(() => {
        refreshTokenRegistry.clear();
        revokedSessions.clear();
        vi.spyOn(SseConnectionRegistry, "endFamilies").mockReturnValue(0);
        vi.spyOn(clusterRpc, "active", "get").mockReturnValue(false);
        refreshTokenRegistry.register({ jtiHash: hashJti("j"), familyId: FID, userKey: "u", expiresAtMs: Date.now() + 60_000 });
    });
    afterEach(() => vi.restoreAllMocks());

    const claims = { jti: "j", familyId: FID, userId: "u" };

    it("a transient DB error during rotation does not burn the token: the client's retry succeeds", async () => {
        const rot = vi.spyOn(AuthRefreshTokenModel, "rotate");
        rot.mockRejectedValueOnce(new Error("ORA-03113")).mockResolvedValueOnce({ outcome: "ok" });
        await expect(RefreshTokenService.rotate(claims, rec(1))).rejects.toThrow("ORA-03113");
        await expect(RefreshTokenService.rotate(claims, rec(2))).resolves.toBeUndefined();
    });

    it("two concurrent rotations of one token: exactly one wins, the loser is treated as reuse and the family dies", async () => {
        vi.spyOn(AuthRefreshTokenModel, "rotate").mockResolvedValue({ outcome: "ok" });
        vi.spyOn(AuthRefreshTokenModel, "revokeFamily").mockResolvedValue(1);
        const results = await Promise.allSettled([RefreshTokenService.rotate(claims, rec(1)), RefreshTokenService.rotate(claims, rec(2))]);
        expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
        const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
        expect(lost.reason.message).toBe(AUTH_ERRORS.REFRESH_TOKEN_REUSED);
        // the winner's successor is now unusable too: the family is revoked
        expect(refreshTokenRegistry.consume("next-1", null, Date.now(), FID)).toBe("revoked");
    });

    it("reuse handling survives the ledger being down: family still ended in memory, caller still gets 401", async () => {
        vi.spyOn(AuthRefreshTokenModel, "rotate").mockResolvedValue({ outcome: "reused" });
        vi.spyOn(AuthRefreshTokenModel, "revokeFamily").mockRejectedValue(new Error("db down"));
        await expect(RefreshTokenService.rotate(claims, rec(1))).rejects.toMatchObject({ statusCode: 401, message: AUTH_ERRORS.REFRESH_TOKEN_REUSED });
        expect(refreshTokenRegistry.consume("any", null, Date.now(), FID)).toBe("revoked");
    });

    it("purge is best effort: a failing purge never blocks a login that follows it", async () => {
        vi.spyOn(AuthRefreshTokenModel, "purgeExpired").mockRejectedValue(new Error("db down"));
        await expect(RefreshTokenService.purgeExpired()).resolves.toBe(0);
    });
});
