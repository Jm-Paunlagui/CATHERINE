"use strict";

/**
 * @fileoverview Adversarial role-policy tests over the REAL HTTP stack, REAL
 * AdminManagementService and REAL controller. Only persistence edges are faked
 * (AdminModel, CryptoVault, email, backup token, refresh ledger).
 *
 * Proves: ADMIN may only manage USER (CWE-269/285); the last active SUPER_ADMIN
 * cannot be removed (409); a revoke fails closed when sessions cannot be ended
 * (CWE-613); a backup token for admin A cannot unlock admin B (CWE-602).
 */

import request from "supertest";
import app from "../../../src/app";
const { signToken } = require("../helpers/auth");
import AdminManagementService from "../../../src/services/AdminManagementService";
import AdminModel from "../../../src/models/admin.model";
import { CryptoVault } from "../../../src/utils/encryption/CryptoVault";
import RefreshTokenService from "../../../src/services/RefreshTokenService";
import AdminAccessEmailService from "../../../src/services/AdminAccessEmailService";
import BackupTokenService from "../../../src/services/BackupTokenService";
import BackupArchiveService from "../../../src/services/BackupArchiveService";
import { AppError, ADMIN_ERRORS } from "../../../src/constants/errors";

const HASH = "$argon2id$v=19$m=8,t=1,p=1$c2FsdA$aGFzaA";
const row = (over: Record<string, any> = {}): any => ({ ID: 5, USERNAME: "target", PASSWORD: HASH, ROLE: "USER", IS_ACTIVE: "Y", SYSSIGNATURE: "s", ...over });

const superToken = () => signToken({ sub: "SA", userId: "SA", id: 1, role: "SUPER_ADMIN", userLevel: 3 });
const adminToken = () => signToken({ sub: "ADM", userId: "ADM", id: 2, role: "ADMIN", userLevel: 2 });

describe("Admin role rules (security)", () => {
    let agent: ReturnType<typeof request.agent>;
    let csrf: string;
    let rows: Record<string, any>;

    beforeAll(async () => {
        agent = request.agent(app);
        csrf = (await agent.get("/api/v1/csrf/token")).body?.token;
    });

    const send = (method: "post" | "put" | "patch" | "delete", url: string, token: string, body: object = {}) =>
        (agent as any)[method](`/api/v1/admin-management${url}`).set("Authorization", `Bearer ${token}`).set("x-csrf-token", csrf).send(body);

    beforeEach(() => {
        rows = { target: row(), boss: row({ USERNAME: "boss", ROLE: "SUPER_ADMIN" }), peer: row({ USERNAME: "peer", ROLE: "ADMIN" }), ADM: row({ USERNAME: "ADM", ROLE: "USER" }) };
        vi.spyOn(AdminModel, "findByUsername").mockImplementation(async (u) => rows[u] ?? null);
        vi.spyOn(AdminModel, "existsByUsername").mockResolvedValue(false);
        vi.spyOn(AdminModel, "insertAdmin").mockResolvedValue(undefined as never);
        vi.spyOn(AdminModel, "updateRole").mockResolvedValue(undefined as never);
        vi.spyOn(AdminModel, "updateCredentials").mockResolvedValue(undefined as never);
        vi.spyOn(AdminModel, "setActive").mockResolvedValue(undefined as never);
        vi.spyOn(AdminModel, "setNotifyFlags").mockResolvedValue(undefined as never);
        vi.spyOn(AdminModel, "deleteAdmin").mockResolvedValue(undefined as never);
        vi.spyOn(AdminModel, "withLastSuperAdminGuard").mockImplementation(async (_id, fn) => fn({} as never));
        vi.spyOn(CryptoVault, "verifyRecord").mockResolvedValue(true);
        vi.spyOn(CryptoVault, "signRecord").mockResolvedValue("sig");
        vi.spyOn(CryptoVault, "hashAdminPassword").mockResolvedValue(HASH);
        vi.spyOn(RefreshTokenService, "revokeAllForUser").mockResolvedValue();
        vi.spyOn(AdminAccessEmailService, "resolveRecipient").mockResolvedValue({ address: "t@x.test", source: "PROFILE", hint: "t**@x.test" });
        vi.spyOn(AdminAccessEmailService, "sendTemporaryPassword").mockResolvedValue({ delivered: true });
        vi.spyOn(BackupArchiveService, "computeEntityScopeHash").mockReturnValue("scope-target");
    });
    afterEach(() => vi.restoreAllMocks());

    describe("ADMIN is confined to USER accounts", () => {
        it.each(["ADMIN", "SUPER_ADMIN"])("cannot create a %s account - 403 and nothing written", async (role) => {
            const res = await send("post", "", adminToken(), { username: "newbie", role });
            expect(res.status).toBe(403);
            expect(res.body.message).toBe(ADMIN_ERRORS.ADMIN_CREATE_USER_ONLY);
            expect(AdminModel.insertAdmin).not.toHaveBeenCalled();
            expect(RefreshTokenService.revokeAllForUser).not.toHaveBeenCalled();
        });

        it("can create a USER account (201) and the temp password is never in the response", async () => {
            const res = await send("post", "", adminToken(), { username: "newbie", role: "USER" });
            expect(res.status).toBe(201);
            expect(Object.keys(res.body.data)).not.toContain("tempPassword");
            expect(JSON.stringify(res.body)).not.toContain("$argon2");
            expect(AdminModel.insertAdmin).toHaveBeenCalledTimes(1);
        });

        it.each([["boss", "SUPER_ADMIN"], ["peer", "ADMIN"]])("cannot reset the password of %s (%s) - 403, credentials untouched", async (name) => {
            const res = await send("patch", `/${name}/reset-password`, adminToken());
            expect(res.status).toBe(403);
            expect(res.body.message).toBe(ADMIN_ERRORS.ADMIN_RESET_USER_ONLY);
            expect(AdminModel.updateCredentials).not.toHaveBeenCalled();
            expect(RefreshTokenService.revokeAllForUser).not.toHaveBeenCalled();
        });

        it("can reset a USER's password, but not its own", async () => {
            expect((await send("patch", "/target/reset-password", adminToken())).status).toBe(200);
            const self = await send("patch", "/ADM/reset-password", adminToken());
            expect(self.status).toBe(403);
        });

        it("cannot change any role (including promoting a USER) nor reset a signature", async () => {
            expect((await send("put", "/target", adminToken(), { role: "SUPER_ADMIN" })).status).toBe(403);
            expect((await send("patch", "/target/reset-signature", adminToken())).status).toBe(403);
            expect(AdminModel.updateRole).not.toHaveBeenCalled();
        });

        it("cannot revoke, delete, edit permissions or hit the privileged backup route", async () => {
            expect((await send("post", "/target/revoke", adminToken(), { backupToken: "t" })).status).toBe(403);
            expect((await send("delete", "/target", adminToken(), { backupToken: "t" })).status).toBe(403);
            expect((await send("patch", "/target/permissions", adminToken(), { flags: { isActive: "N" } })).status).toBe(403);
            expect((await send("post", "/target/revoke-backup", adminToken())).status).toBe(403);
            expect(AdminModel.setActive).not.toHaveBeenCalled();
            expect(AdminModel.deleteAdmin).not.toHaveBeenCalled();
        });
    });

    describe("last active SUPER_ADMIN", () => {
        beforeEach(() => {
            vi.spyOn(AdminModel, "withLastSuperAdminGuard").mockRejectedValue(new AppError(ADMIN_ERRORS.LAST_ACTIVE_SUPER_ADMIN, 409));
            vi.spyOn(BackupTokenService, "consume");
        });

        it("cannot be demoted - 409, no role write, sessions untouched", async () => {
            const res = await send("put", "/boss", superToken(), { role: "ADMIN" });
            expect(res.status).toBe(409);
            expect(AdminModel.updateRole).not.toHaveBeenCalled();
            expect(RefreshTokenService.revokeAllForUser).not.toHaveBeenCalled();
        });

        it("cannot be deactivated, revoked or deleted - 409 and the backup token is not burned", async () => {
            expect((await send("patch", "/boss/permissions", superToken(), { flags: { isActive: "N" } })).status).toBe(409);
            expect((await send("post", "/boss/revoke", superToken(), { backupToken: "t" })).status).toBe(409);
            expect((await send("delete", "/boss", superToken(), { backupToken: "t" })).status).toBe(409);
            expect(BackupTokenService.consume).not.toHaveBeenCalled();
            expect(AdminModel.deleteAdmin).not.toHaveBeenCalled();
        });
    });

    describe("self-lockout and backup-token binding", () => {
        it("a SUPER_ADMIN cannot revoke or delete itself - 403 and no token is consumed", async () => {
            const consume = vi.spyOn(BackupTokenService, "consume");
            rows.SA = row({ USERNAME: "SA", ROLE: "SUPER_ADMIN" });
            expect((await send("post", "/SA/revoke", superToken(), { backupToken: "t" })).status).toBe(403);
            expect((await send("delete", "/SA", superToken(), { backupToken: "t" })).status).toBe(403);
            expect(consume).not.toHaveBeenCalled();
        });

        it("revoke without a backup token is refused before any token is consumed; a token issued for another admin or actor -> 428 with one generic message", async () => {
            const consume = vi.spyOn(BackupTokenService, "consume");
            const none = await send("post", "/target/revoke", superToken(), {});
            expect(none.status).toBe(400);
            expect(consume).not.toHaveBeenCalled();
            consume.mockResolvedValueOnce({ valid: true, payload: { adminId: 1, scopeHash: "scope-OTHER" } } as never);
            const wrongScope = await send("post", "/target/revoke", superToken(), { backupToken: "t" });
            consume.mockResolvedValueOnce({ valid: true, payload: { adminId: 99, scopeHash: "scope-target" } } as never);
            const wrongActor = await send("post", "/target/revoke", superToken(), { backupToken: "t" });
            consume.mockResolvedValueOnce({ valid: false, reason: "expired" } as never);
            const expired = await send("post", "/target/revoke", superToken(), { backupToken: "t" });
            for (const r of [wrongScope, wrongActor, expired]) {
                expect(r.status).toBe(428);
                expect(r.body.message).toBe(ADMIN_ERRORS.BACKUP_TOKEN_INVALID);
                expect(JSON.stringify(r.body)).not.toMatch(/scope-OTHER|wrong admin|mismatch/i);
            }
            expect(AdminModel.setActive).not.toHaveBeenCalled();
        });

        it("a valid token revokes: sessions end BEFORE IS_ACTIVE flips", async () => {
            const order: string[] = [];
            vi.spyOn(BackupTokenService, "consume").mockResolvedValue({ valid: true, payload: { adminId: 1, scopeHash: "scope-target" } } as never);
            vi.mocked(RefreshTokenService.revokeAllForUser).mockImplementation(async () => void order.push("sessions"));
            vi.mocked(AdminModel.setActive).mockImplementation(async () => void order.push("flag"));
            const res = await send("post", "/target/revoke", superToken(), { backupToken: "t" });
            expect(res.status).toBe(200);
            expect(order).toEqual(["sessions", "flag"]);
        });

        it("FAIL CLOSED: when sessions cannot be ended the account is NOT deactivated and the API answers an error", async () => {
            vi.spyOn(BackupTokenService, "consume").mockResolvedValue({ valid: true, payload: { adminId: 1, scopeHash: "scope-target" } } as never);
            vi.mocked(RefreshTokenService.revokeAllForUser).mockRejectedValue(new Error("db down"));
            const res = await send("post", "/target/revoke", superToken(), { backupToken: "t" });
            expect(res.status).toBeGreaterThanOrEqual(500);
            expect(AdminModel.setActive).not.toHaveBeenCalled();
            expect(JSON.stringify(res.body)).not.toContain("db down");
        });

        it("a tampered admin row (bad SYSSIGNATURE) is refused 422 before any destructive write", async () => {
            vi.mocked(CryptoVault.verifyRecord).mockResolvedValue(false);
            const res = await send("delete", "/target", superToken(), { backupToken: "t" });
            expect(res.status).toBe(422);
            expect(AdminModel.deleteAdmin).not.toHaveBeenCalled();
        });
    });

    it("legacy password fields are refused even for SUPER_ADMIN (no operator-chosen passwords)", async () => {
        const create = await send("post", "", superToken(), { username: "n", role: "USER", newPassword: "x" });
        expect(create.status).toBe(400);
        expect(AdminModel.insertAdmin).not.toHaveBeenCalled();
        const edit = await send("put", "/target", superToken(), { role: "USER", changePassword: true });
        expect(edit.status).toBe(400);
        expect(typeof AdminManagementService.addAdmin).toBe("function");
    });
});
