"use strict";

/**
 * @fileoverview Chaos: cluster IPC and DB faults around session revocation.
 * Hypothesis: a revoke ends the session on THIS worker whatever the IPC or the
 * database does, and a lossy link is reported, never thrown into the caller.
 */

import AccessRevocationService from "../../../src/services/AccessRevocationService";
import RefreshTokenService from "../../../src/services/RefreshTokenService";
import AuthRefreshTokenModel from "../../../src/models/auth.refresh.token.model";
import { clusterRpc } from "../../../src/utils/cluster/ClusterRpcClient";
import SseConnectionRegistry from "../../../src/utils/sse/SseConnectionRegistry";
import { revokedSessions } from "../../../src/utils/auth/RevokedSessionSet";
import { refreshTokenRegistry } from "../../../src/utils/auth/RefreshTokenRegistry";
import { CLUSTER_RPC_METHODS } from "../../../src/constants/clusterIpc";
import { ACCESS_REVOCATION_LIMITS } from "../../../src/constants/authTokens";

const fid = (n: number) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;

describe("access revocation chaos", () => {
    let notify: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        revokedSessions.clear();
        refreshTokenRegistry.clear();
        vi.spyOn(SseConnectionRegistry, "endFamilies").mockReturnValue(0);
        vi.spyOn(clusterRpc, "active", "get").mockReturnValue(true);
        notify = vi.spyOn(clusterRpc, "notify").mockReturnValue(true);
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("broadcasts one NOTIFY with the entries when the cluster is active", () => {
        AccessRevocationService.revoke([fid(1), fid(2)], 1000);
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify.mock.calls[0][0]).toBe(CLUSTER_RPC_METHODS.AUTH_REVOKE);
        expect((notify.mock.calls[0][1] as any).entries.map((e: any) => e.fid)).toEqual([fid(1), fid(2)]);
    });

    it("a large revoke is chunked under the IPC payload cap and every family is still ended locally", () => {
        const max = ACCESS_REVOCATION_LIMITS.MAX_FIDS_PER_MESSAGE;
        const all = Array.from({ length: max * 2 + 5 }, (_, i) => fid(i + 1));
        expect(AccessRevocationService.revoke(all, 1000)).toBe(all.length);
        expect(notify.mock.calls.map((c) => (c[1] as any).entries.length)).toEqual([max, max, 5]);
        expect(AccessRevocationService.isRevoked(fid(all.length), 1001)).toBe(true);
    });

    it("a dropped/refused IPC send is reported, does not throw, and does not un-end the local session", () => {
        notify.mockReturnValue(false);
        expect(() => AccessRevocationService.revoke([fid(7)], 1000)).not.toThrow();
        expect(notify).toHaveBeenCalled();
        expect(AccessRevocationService.isRevoked(fid(7), 1001)).toBe(true);
    });

    it("nothing to broadcast (invalid ids only) sends no message", () => {
        AccessRevocationService.revoke(["nope"], 1000);
        expect(notify).not.toHaveBeenCalled();
    });

    it("inactive cluster (single process) never touches IPC", () => {
        vi.spyOn(clusterRpc, "active", "get").mockReturnValue(false);
        AccessRevocationService.revoke([fid(3)], 1000);
        expect(notify).not.toHaveBeenCalled();
    });

    it("DB outage during user-wide revoke: error surfaces (fail closed) but known families are already ended", async () => {
        refreshTokenRegistry.register({ jtiHash: "h", familyId: fid(9), userKey: "u", expiresAtMs: Date.now() + 10_000 });
        vi.spyOn(AuthRefreshTokenModel, "revokeUser").mockRejectedValue(new Error("ORA-03113"));
        await expect(RefreshTokenService.revokeAllForUser("u", "LOGOUT")).rejects.toThrow("ORA-03113");
        expect(AccessRevocationService.isRevoked(fid(9))).toBe(true);
        expect(refreshTokenRegistry.consume("h", null)).toBe("revoked");
    });

    it("boot reload survives a DB outage and a later retry succeeds", async () => {
        const find = vi.spyOn(AuthRefreshTokenModel, "findRevokedSince");
        find.mockRejectedValueOnce(new Error("pool exhausted"));
        expect(await AccessRevocationService.loadRecent(1000)).toBe(0);
        find.mockResolvedValueOnce([{ familyId: fid(4), revokedAt: new Date(1000) }]);
        expect(await AccessRevocationService.loadRecent(1000)).toBe(1);
        expect(AccessRevocationService.isRevoked(fid(4), 1001)).toBe(true);
    });

    it("a transient DB blip on logout is retried once (fake clock); a hard outage is swallowed when best effort", async () => {
        vi.useFakeTimers();
        const blip = Object.assign(new Error("ORA-03113: end-of-file on communication channel"), { code: "ORA-03113" });
        const rev = vi.spyOn(AuthRefreshTokenModel, "revokeFamily").mockRejectedValueOnce(blip).mockResolvedValueOnce(1);
        const p = RefreshTokenService.revokeFamily(fid(5), "LOGOUT", { bestEffort: true, retryTransient: true });
        await vi.runAllTimersAsync();
        await p;
        expect(rev).toHaveBeenCalledTimes(2);

        rev.mockReset().mockRejectedValue(blip);
        const q = RefreshTokenService.revokeFamily(fid(6), "LOGOUT", { bestEffort: true, retryTransient: true });
        await vi.runAllTimersAsync();
        await expect(q).resolves.toBeUndefined();
        expect(AccessRevocationService.isRevoked(fid(6))).toBe(true);
    });

    it("revoked set at capacity keeps accepting new revocations (oldest-expiring evicted, never throws)", () => {
        const spy = vi.spyOn(revokedSessions, "revoke").mockReturnValue({ added: true, dropped: true });
        expect(() => AccessRevocationService.revoke([fid(1), fid(2)], 1000)).not.toThrow();
        expect(spy).toHaveBeenCalledTimes(2);
    });
});
