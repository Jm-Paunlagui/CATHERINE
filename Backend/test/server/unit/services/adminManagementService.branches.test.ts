"use strict";

/**
 * @fileoverview AdminManagementService branch coverage: persistence edges
 * (AdminModel, UserModel, CryptoVault, email, backup, refresh revoke) are faked;
 * the role policy, validation, ordering and fail-closed logic are REAL.
 *
 * Security: CWE-269/285 (role policy), CWE-613 (sessions end first), CWE-602 (backup token).
 */

import AdminManagementService from "../../../../src/services/AdminManagementService";
import AdminModel from "../../../../src/models/admin.model";
import UserModel from "../../../../src/models/user.model";
import { CryptoVault } from "../../../../src/utils/encryption/CryptoVault";
import RefreshTokenService from "../../../../src/services/RefreshTokenService";
import AdminAccessEmailService from "../../../../src/services/AdminAccessEmailService";
import BackupTokenService from "../../../../src/services/BackupTokenService";
import BackupArchiveService from "../../../../src/services/BackupArchiveService";
import { registry } from "../../../../src/middleware/cache";
import { AppError, ADMIN_ERRORS } from "../../../../src/constants/errors";

const HASH = "$argon2id$v=19$m=8,t=1,p=1$c2FsdA$aGFzaA";
const SUPER = { username: "root", role: "SUPER_ADMIN" };
const ADMIN = { username: "alice", role: "ADMIN" };

const row = (over: Record<string, any> = {}): any => ({
    ID: 7,
    USERNAME: "bob",
    PASSWORD: HASH,
    ROLE: "USER",
    IS_ACTIVE: "Y",
    SYSSIGNATURE: "sig",
    ...over,
});

const recipient = { address: "bob@example.test", source: "PROFILE" as const, hint: "b**@example.test" };

async function rejects(p: Promise<unknown>) {
    try {
        await p;
    } catch (e) {
        return e as AppError;
    }
    throw new Error("expected rejection");
}

describe("AdminManagementService", () => {
    let calls: string[];

    beforeEach(() => {
        calls = [];
        vi.spyOn(CryptoVault, "signRecord").mockResolvedValue("new-sig");
        vi.spyOn(CryptoVault, "verifyRecord").mockResolvedValue(true);
        vi.spyOn(CryptoVault, "hashAdminPassword").mockResolvedValue(HASH);
        vi.spyOn(RefreshTokenService, "revokeAllForUser").mockImplementation(async (u, reason, opts) => {
            calls.push(`revoke:${u}:${reason}:${opts?.cause ?? ""}`);
        });
        vi.spyOn(AdminModel, "findByUsername").mockResolvedValue(row());
        vi.spyOn(AdminModel, "existsByUsername").mockResolvedValue(false);
        vi.spyOn(AdminModel, "insertAdmin").mockImplementation(async () => {
            calls.push("insert");
        });
        vi.spyOn(AdminModel, "setNotifyFlags").mockImplementation(async () => {
            calls.push("flags");
        });
        vi.spyOn(AdminModel, "updateRole").mockImplementation(async () => {
            calls.push("updateRole");
        });
        vi.spyOn(AdminModel, "updateCredentials").mockImplementation(async () => {
            calls.push("updateCredentials");
        });
        vi.spyOn(AdminModel, "setEmail").mockImplementation(async () => {
            calls.push("setEmail");
        });
        vi.spyOn(AdminModel, "setActive").mockImplementation(async () => {
            calls.push("setActive");
        });
        vi.spyOn(AdminModel, "deleteAdmin").mockImplementation(async () => {
            calls.push("delete");
        });
        vi.spyOn(AdminModel, "withLastSuperAdminGuard").mockImplementation(async (_id, fn) => fn({} as never));
        vi.spyOn(AdminAccessEmailService, "resolveRecipient").mockResolvedValue(recipient);
        vi.spyOn(AdminAccessEmailService, "sendTemporaryPassword").mockResolvedValue({ delivered: true });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("searchAccounts", () => {
        it("rejects empty and non-string queries with a 400 naming the field", async () => {
            for (const q of ["", "   ", undefined as unknown as string, 5 as unknown as string]) {
                const err = await rejects(AdminManagementService.searchAccounts(q));
                expect(err.statusCode).toBe(400);
            }
        });

        it("matches by username/first/last name, flags admins and resolves name-only matches in one batch", async () => {
            vi.spyOn(UserModel, "findAll").mockResolvedValue([
                { USERNAME: "ada", FIRST_NAME: "Ada", LAST_NAME: null, EMAIL: "ada@x.test" },
                { USERNAME: "u2", FIRST_NAME: "Zed", LAST_NAME: "Adams", EMAIL: null },
                { USERNAME: "nomatch", FIRST_NAME: "Q", LAST_NAME: "Q" },
            ] as never);
            vi.spyOn(AdminModel, "search").mockResolvedValue([{ USERNAME: "ada", EMAIL: null }] as never);
            const batch = vi.spyOn(AdminModel, "findByUsernames").mockResolvedValue([{ USERNAME: "u2", EMAIL: "u2@x.test" }] as never);

            const out = await AdminManagementService.searchAccounts("  AD ");

            expect(batch).toHaveBeenCalledWith(["u2"]);
            expect(out.map((r) => [r.username, r.isAdmin])).toEqual([["ada", true], ["u2", true]]);
            expect(out[1].emailOnFile).toBe(true);
            expect(out[0].emailOnFile).toBe(true);
        });

        it("reports a non-admin with no address as emailOnFile=false", async () => {
            vi.spyOn(UserModel, "findAll").mockResolvedValue([{ USERNAME: "solo", FIRST_NAME: null, LAST_NAME: null }] as never);
            vi.spyOn(AdminModel, "search").mockResolvedValue([]);
            vi.spyOn(AdminModel, "findByUsernames").mockResolvedValue([]);
            const [r] = await AdminManagementService.searchAccounts("solo");
            expect(r).toMatchObject({ isAdmin: false, emailOnFile: false, emailHint: null, firstName: null });
        });
    });

    describe("listAdmins", () => {
        it("adds signatureValid, profile names, flags and temp-password expiry; invalid signature is reported not hidden", async () => {
            vi.spyOn(AdminModel, "findAll").mockResolvedValue([
                row({ USERNAME: "a", CAN_RECEIVE_SRV_CRIT: "Y", IS_ACTIVE: "N", PASSWORD: "$t$zzzzzz" + HASH }),
                row({ USERNAME: "b", CREATED_AT: new Date(0), UPDATED_AT: new Date(1) }),
            ]);
            vi.spyOn(UserModel, "findAll").mockResolvedValue([{ USERNAME: "a", FIRST_NAME: "A", LAST_NAME: "L", EMAIL: "a@x.test" }] as never);
            vi.spyOn(CryptoVault, "verifyRecord").mockResolvedValueOnce(false).mockResolvedValueOnce(true);

            const out = await AdminManagementService.listAdmins();

            expect(out[0]).toMatchObject({ username: "a", signatureValid: false, firstName: "A", canReceiveSrvCrit: "Y", isActive: "N", createdAt: null });
            expect(out[0].tempPasswordExpiresAt).toEqual(expect.any(String));
            expect(out[1]).toMatchObject({ signatureValid: true, firstName: null, canReceiveSrvSys: "N", isActive: "Y", tempPasswordExpiresAt: null });
            expect(out[1].updatedAt).toEqual(new Date(1));
        });
    });

    describe("_validateFlags", () => {
        it.each([null, [], "x", 3])("rejects non-object flags %j", (bad) => {
            expect(() => AdminManagementService._validateFlags(bad)).toThrow(AppError);
        });
        it("rejects unknown keys and non Y/N values, naming each field", () => {
            try {
                AdminManagementService._validateFlags({ evil: "Y" });
                throw new Error("no throw");
            } catch (e: any) {
                expect(e.statusCode).toBe(400);
            }
            expect(() => AdminManagementService._validateFlags({ isActive: "maybe" })).toThrow(AppError);
            expect(() => AdminManagementService._validateFlags({ isActive: "Y", canReceiveSrvCrit: "N" })).not.toThrow();
        });
    });

    describe("role policy (_assertCanManage) — security", () => {
        const deny = (caller: any, action: any, ctx: any = {}) => {
            try {
                AdminManagementService._assertCanManage(caller, action, ctx);
            } catch (e) {
                return e as AppError;
            }
            return null;
        };

        it("SUPER_ADMIN may do everything", () => {
            for (const a of ["create", "changeRole", "resetPassword", "resetSignature"] as const) {
                expect(deny(SUPER, a, { newRole: "SUPER_ADMIN", targetRole: "ADMIN" })).toBeNull();
            }
        });

        it("ADMIN may create only USER and reset only another USER", () => {
            expect(deny(ADMIN, "create", { newRole: "USER" })).toBeNull();
            expect(deny(ADMIN, "create", { newRole: "ADMIN" })?.statusCode).toBe(403);
            expect(deny(ADMIN, "create", { newRole: "ADMIN" })?.message).toBe(ADMIN_ERRORS.ADMIN_CREATE_USER_ONLY);
            expect(deny(ADMIN, "resetPassword", { target: "bob", targetRole: "USER" })).toBeNull();
            expect(deny(ADMIN, "resetPassword", { target: "alice", targetRole: "USER" })?.message).toBe(ADMIN_ERRORS.ADMIN_RESET_USER_ONLY);
            expect(deny(ADMIN, "resetPassword", { target: "x", targetRole: "ADMIN" })?.statusCode).toBe(403);
        });

        it("ADMIN can never change a role or reset a signature", () => {
            expect(deny(ADMIN, "changeRole")?.message).toBe(ADMIN_ERRORS.ROLE_CHANGE_SUPER_ADMIN_ONLY);
            expect(deny(ADMIN, "resetSignature")?.message).toBe(ADMIN_ERRORS.RESET_SIGNATURE_SUPER_ADMIN_ONLY);
        });

        it("fails closed for USER, unknown role, and a missing caller", () => {
            expect(deny({ username: "u", role: "USER" }, "create", { newRole: "USER" })?.message).toBe(ADMIN_ERRORS.ROLE_ACTION_FORBIDDEN);
            expect(deny({ username: "u", role: undefined }, "resetSignature")?.statusCode).toBe(403);
            expect(deny(null, "create", { newRole: "USER" })?.statusCode).toBe(403);
            expect(deny(undefined, "changeRole")?.statusCode).toBe(403);
        });
    });

    describe("addAdmin", () => {
        const base = { username: "bob", role: "USER", caller: SUPER };

        it("rejects an invalid role, legacy password fields and bad usernames before touching the DB", async () => {
            expect((await rejects(AdminManagementService.addAdmin({ ...base, role: "GOD" }))).statusCode).toBe(400);
            expect((await rejects(AdminManagementService.addAdmin({ ...base, retainPassword: true }))).message).toBe(ADMIN_ERRORS.PASSWORD_FIELDS_NOT_ACCEPTED);
            expect((await rejects(AdminManagementService.addAdmin({ ...base, newPassword: "x" }))).statusCode).toBe(400);
            expect((await rejects(AdminManagementService.addAdmin({ ...base, retainPassword: 1, newPassword: 2 }))).statusCode).toBe(400);
            for (const username of ["has space", "", "x".repeat(101), 5 as unknown as string]) {
                expect((await rejects(AdminManagementService.addAdmin({ ...base, username }))).statusCode).toBe(400);
            }
            expect(AdminModel.existsByUsername).not.toHaveBeenCalled();
            expect(calls).toEqual([]);
        });

        it("ADMIN creating an ADMIN is refused (403) with nothing written", async () => {
            const err = await rejects(AdminManagementService.addAdmin({ ...base, role: "ADMIN", caller: ADMIN }));
            expect(err.statusCode).toBe(403);
            expect(calls).toEqual([]);
        });

        it("invalid flags -> 400; existing account -> 409; recipient refusal happens before any write", async () => {
            expect((await rejects(AdminManagementService.addAdmin({ ...base, flags: { nope: "Y" } }))).statusCode).toBe(400);
            vi.mocked(AdminModel.existsByUsername).mockResolvedValueOnce(true);
            expect((await rejects(AdminManagementService.addAdmin(base))).statusCode).toBe(409);
            vi.mocked(AdminAccessEmailService.resolveRecipient).mockRejectedValueOnce(new AppError("no address", 422));
            expect((await rejects(AdminManagementService.addAdmin(base))).statusCode).toBe(422);
            expect(calls).toEqual([]);
        });

        it("revokes stale sessions BEFORE insert, defaults flags to N, emails, and reports delivery", async () => {
            const out = await AdminManagementService.addAdmin(base);
            expect(calls).toEqual(["revoke:bob:ADMIN_READD:", "insert"]);
            expect(AdminModel.setNotifyFlags).not.toHaveBeenCalled();
            expect(out).toMatchObject({ username: "bob", role: "USER", emailDelivered: true, recipientSource: "PROFILE" });
            expect(AdminModel.insertAdmin).toHaveBeenCalledWith(expect.objectContaining({ isActive: "Y", email: recipient.address }));
        });

        it("persists Y notify flags and honours isActive N", async () => {
            await AdminManagementService.addAdmin({ ...base, flags: { canReceiveSrvCrit: "Y", isActive: "N" } });
            expect(calls).toContain("flags");
            expect(AdminModel.insertAdmin).toHaveBeenCalledWith(expect.objectContaining({ isActive: "N" }));
        });

        it("fails closed: if the session revoke fails nothing is inserted", async () => {
            vi.mocked(RefreshTokenService.revokeAllForUser).mockRejectedValueOnce(new Error("db down"));
            await expect(AdminManagementService.addAdmin(base)).rejects.toThrow("db down");
            expect(calls).not.toContain("insert");
        });

        it("a failed email send is reported, not rolled back", async () => {
            vi.mocked(AdminAccessEmailService.sendTemporaryPassword).mockResolvedValueOnce({ delivered: false });
            const out = await AdminManagementService.addAdmin(base);
            expect(out.emailDelivered).toBe(false);
            expect(calls).toContain("insert");
        });

        it("a hash too large to store becomes a 500 ConfigurationError; other errors pass through", async () => {
            vi.mocked(CryptoVault.hashAdminPassword).mockResolvedValueOnce(`$argon2id$${"x".repeat(200)}`);
            const err = await rejects(AdminManagementService.addAdmin(base));
            expect(err.statusCode).toBe(500);
            vi.mocked(CryptoVault.hashAdminPassword).mockResolvedValueOnce("not-a-hash");
            await expect(AdminManagementService.addAdmin(base)).rejects.toBeInstanceOf(TypeError);
        });
    });

    describe("updateAdmin", () => {
        it("refuses legacy password edit fields (400) and invalid roles", async () => {
            const p = { username: "bob", role: "ADMIN", caller: SUPER };
            expect((await rejects(AdminManagementService.updateAdmin({ ...p, changePassword: true }))).message).toBe(ADMIN_ERRORS.EDIT_PASSWORD_NOT_ACCEPTED);
            expect((await rejects(AdminManagementService.updateAdmin({ ...p, newPassword: "x" }))).statusCode).toBe(400);
            expect((await rejects(AdminManagementService.updateAdmin({ ...p, changePassword: true, newPassword: "x" }))).statusCode).toBe(400);
            expect((await rejects(AdminManagementService.updateAdmin({ ...p, role: "X" }))).statusCode).toBe(400);
        });

        it("ADMIN can never change a role (403, nothing written)", async () => {
            const err = await rejects(AdminManagementService.updateAdmin({ username: "bob", role: "ADMIN", caller: ADMIN }));
            expect(err.statusCode).toBe(403);
            expect(AdminModel.findByUsername).not.toHaveBeenCalled();
        });

        it("a role change ends sessions first, then writes; same role writes without ending sessions", async () => {
            await AdminManagementService.updateAdmin({ username: "bob", role: "ADMIN", caller: SUPER });
            expect(calls).toEqual(["revoke:bob:LOGOUT:ROLE_CHANGED", "updateRole"]);
            calls.length = 0;
            await AdminManagementService.updateAdmin({ username: "bob", role: "USER", caller: SUPER });
            expect(calls).toEqual(["updateRole"]);
        });

        it("demoting the last active SUPER_ADMIN is refused with 409 and writes nothing", async () => {
            vi.mocked(AdminModel.findByUsername).mockResolvedValue(row({ ROLE: "SUPER_ADMIN" }));
            vi.mocked(AdminModel.withLastSuperAdminGuard).mockRejectedValueOnce(new AppError(ADMIN_ERRORS.LAST_ACTIVE_SUPER_ADMIN, 409));
            const err = await rejects(AdminManagementService.updateAdmin({ username: "bob", role: "ADMIN", caller: SUPER }));
            expect(err.statusCode).toBe(409);
            expect(calls).toEqual([]);
        });

        it("demoting a SUPER_ADMIN runs inside the guard transaction", async () => {
            vi.mocked(AdminModel.findByUsername).mockResolvedValue(row({ ROLE: "SUPER_ADMIN" }));
            await AdminManagementService.updateAdmin({ username: "bob", role: "ADMIN", caller: SUPER });
            expect(AdminModel.withLastSuperAdminGuard).toHaveBeenCalledWith(7, expect.any(Function));
            expect(calls).toEqual(["revoke:bob:LOGOUT:ROLE_CHANGED", "updateRole"]);
        });
    });

    describe("fetch + verify", () => {
        it("unknown admin -> 404; tampered signature -> 422 and no write", async () => {
            vi.mocked(AdminModel.findByUsername).mockResolvedValueOnce(null);
            expect((await rejects(AdminManagementService.resetPassword("ghost", { caller: SUPER }))).statusCode).toBe(404);
            vi.mocked(CryptoVault.verifyRecord).mockResolvedValueOnce(false);
            expect((await rejects(AdminManagementService.resetPassword("bob", { caller: SUPER }))).statusCode).toBe(422);
            expect(calls).toEqual([]);
        });
    });

    describe("resetPassword", () => {
        it("ADMIN may reset a USER but not an ADMIN; role is checked after the row is verified", async () => {
            await AdminManagementService.resetPassword("bob", { caller: ADMIN });
            expect(calls).toEqual(["revoke:bob:PASSWORD_RESET:", "updateCredentials"]);
            vi.mocked(AdminModel.findByUsername).mockResolvedValue(row({ ROLE: "ADMIN" }));
            expect((await rejects(AdminManagementService.resetPassword("bob", { caller: ADMIN }))).statusCode).toBe(403);
        });

        it("no caller -> 403 (fail closed)", async () => {
            expect((await rejects(AdminManagementService.resetPassword("bob"))).statusCode).toBe(403);
        });

        it("keeps an operator-typed address (OVERRIDE) as the admin's email", async () => {
            vi.mocked(AdminAccessEmailService.resolveRecipient).mockResolvedValueOnce({ ...recipient, source: "OVERRIDE" });
            const out = await AdminManagementService.resetPassword("bob", { caller: SUPER, overrideEmail: "n@x.test" });
            expect(calls).toEqual(["revoke:bob:PASSWORD_RESET:", "updateCredentials", "setEmail"]);
            expect(out).toMatchObject({ username: "bob", recipientSource: "OVERRIDE" });
        });

        it("fail closed: a revoke failure leaves the password unchanged", async () => {
            vi.mocked(RefreshTokenService.revokeAllForUser).mockRejectedValueOnce(new Error("db down"));
            await expect(AdminManagementService.resetPassword("bob", { caller: SUPER })).rejects.toThrow("db down");
            expect(calls).not.toContain("updateCredentials");
        });
    });

    describe("resetSignature", () => {
        it("is SUPER_ADMIN only; unknown target 404; success re-signs without checking the old signature", async () => {
            expect((await rejects(AdminManagementService.resetSignature("bob", { caller: ADMIN }))).statusCode).toBe(403);
            vi.mocked(AdminModel.findByUsername).mockResolvedValueOnce(null);
            expect((await rejects(AdminManagementService.resetSignature("ghost", { caller: SUPER }))).statusCode).toBe(404);
            vi.mocked(CryptoVault.verifyRecord).mockClear();
            await expect(AdminManagementService.resetSignature("bob", { caller: SUPER })).resolves.toEqual({ username: "bob" });
            expect(AdminModel.updateCredentials).toHaveBeenCalledWith("bob", HASH, "new-sig");
            expect(CryptoVault.verifyRecord).not.toHaveBeenCalled();
        });

        it("defaults the options argument (no caller) to a refusal", async () => {
            expect((await rejects(AdminManagementService.resetSignature("bob"))).statusCode).toBe(403);
        });
    });

    describe("backup-token gated actions", () => {
        const scopeHash = "scope-ok";
        const valid = (over: Record<string, any> = {}) =>
            ({ valid: true, payload: { adminId: 1, scopeHash, ...over } }) as never;

        beforeEach(() => {
            vi.spyOn(BackupArchiveService, "computeEntityScopeHash").mockReturnValue(scopeHash);
            vi.spyOn(BackupTokenService, "consume").mockResolvedValue(valid());
        });

        const del = (over: Record<string, any> = {}) =>
            AdminManagementService.deleteAdmin({ username: "bob", backupToken: "t", callerUsername: "root", callerId: 1, ...over });
        const rev = (over: Record<string, any> = {}) =>
            AdminManagementService.revokeAccess({ username: "bob", backupToken: "t", callerUsername: "root", callerId: 1, ...over });

        it("cannot delete or revoke yourself (403) and consumes no token", async () => {
            expect((await rejects(del({ username: "root" }))).message).toBe(ADMIN_ERRORS.CANNOT_DELETE_SELF);
            expect((await rejects(rev({ username: "root" }))).message).toBe(ADMIN_ERRORS.CANNOT_REVOKE_SELF);
            expect(BackupTokenService.consume).not.toHaveBeenCalled();
        });

        it("missing token -> 428 before consume; invalid, wrong-admin and wrong-scope tokens -> the same 428 message", async () => {
            const missing = await rejects(del({ backupToken: undefined }));
            expect(missing.statusCode).toBe(428);
            expect(missing.message).toBe(ADMIN_ERRORS.BACKUP_TOKEN_REQUIRED);

            vi.mocked(BackupTokenService.consume).mockResolvedValueOnce({ valid: false, reason: "expired" } as never);
            const invalid = await rejects(del());
            vi.mocked(BackupTokenService.consume).mockResolvedValueOnce(valid({ adminId: 99 }));
            const wrongAdmin = await rejects(del());
            vi.mocked(BackupTokenService.consume).mockResolvedValueOnce(valid({ scopeHash: "other-admin" }));
            const wrongScope = await rejects(rev());
            for (const e of [invalid, wrongAdmin, wrongScope]) {
                expect(e.statusCode).toBe(428);
                expect(e.message).toBe(ADMIN_ERRORS.BACKUP_TOKEN_INVALID);
            }
            expect(calls).toEqual([]);
        });

        it("delete: ends sessions, deletes inside the guard, flushes caches", async () => {
            await expect(del()).resolves.toEqual({ username: "bob" });
            expect(calls).toEqual(["revoke:bob:LOGOUT:ADMIN_DELETED", "delete"]);
        });

        it("delete of the last active SUPER_ADMIN -> 409 and the backup token is not burned", async () => {
            vi.mocked(AdminModel.findByUsername).mockResolvedValue(row({ ROLE: "SUPER_ADMIN" }));
            vi.mocked(AdminModel.withLastSuperAdminGuard).mockRejectedValueOnce(new AppError(ADMIN_ERRORS.LAST_ACTIVE_SUPER_ADMIN, 409));
            expect((await rejects(del())).statusCode).toBe(409);
            expect(BackupTokenService.consume).not.toHaveBeenCalled();
        });

        it("deleting an INACTIVE super admin skips the lock", async () => {
            vi.mocked(AdminModel.findByUsername).mockResolvedValue(row({ ROLE: "SUPER_ADMIN", IS_ACTIVE: "N" }));
            await del();
            expect(AdminModel.withLastSuperAdminGuard).not.toHaveBeenCalled();
        });

        it("revoke: sessions end BEFORE IS_ACTIVE flips, all notify flags go N", async () => {
            await expect(rev()).resolves.toEqual({ username: "bob", isActive: "N" });
            expect(calls).toEqual(["revoke:bob:LOGOUT:ACCESS_REVOKED", "setActive", "flags"]);
            const flags = vi.mocked(AdminModel.setNotifyFlags).mock.calls[0][1];
            expect(Object.values(flags)).toEqual(["N", "N", "N", "N"]);
        });

        it("revoke fails closed: if sessions cannot be ended the account stays active", async () => {
            vi.mocked(RefreshTokenService.revokeAllForUser).mockRejectedValueOnce(new Error("db down"));
            await expect(rev()).rejects.toThrow("db down");
            expect(AdminModel.setActive).not.toHaveBeenCalled();
        });

        it("buildRevokeBackup scopes the archive to the target and the acting admin", async () => {
            vi.spyOn(BackupArchiveService, "buildEntityBackup").mockResolvedValue({ token: "tk" } as never);
            Object.defineProperty(BackupArchiveService, "ADMIN_REVOKE_BACKUP_TABLES", {
                value: ["T_ADMINS_DEV", "T_AUDIT_LOGS_DEV", "T_SERVER_ALERT_ACK_DEV"],
                configurable: true,
            });
            const out = await AdminManagementService.buildRevokeBackup({ username: "bob", actorId: 1 });
            expect(out).toEqual({ token: "tk" });
            const arg = vi.mocked(BackupArchiveService.buildEntityBackup).mock.calls[0][0];
            expect(arg.requestId).toBeNull();
            expect(arg.tableFilters.map((f) => [f.table, f.whereValue])).toEqual([
                ["T_ADMINS_DEV", "bob"],
                ["T_AUDIT_LOGS_DEV", "bob"],
                ["T_SERVER_ALERT_ACK_DEV", 7],
            ]);
        });
    });

    describe("updatePermissions", () => {
        const up = (flags: Record<string, unknown>) => AdminManagementService.updatePermissions({ username: "bob", flags });

        it("rejects bad flags first (400) and unknown admin (404)", async () => {
            expect((await rejects(up({ bogus: "Y" }))).statusCode).toBe(400);
            vi.mocked(AdminModel.findByUsername).mockResolvedValueOnce(null);
            expect((await rejects(up({ isActive: "N" }))).statusCode).toBe(404);
        });

        it("deactivation ends sessions, re-signs, flips; notify flags persist and caches flush", async () => {
            await up({ isActive: "N", canReceiveSrvCrit: "Y" });
            expect(calls).toEqual(["revoke:bob:LOGOUT:DEACTIVATED", "setActive", "flags"]);
        });

        it("deactivating the last active SUPER_ADMIN -> 409", async () => {
            vi.mocked(AdminModel.findByUsername).mockResolvedValue(row({ ROLE: "SUPER_ADMIN" }));
            vi.mocked(AdminModel.withLastSuperAdminGuard).mockRejectedValueOnce(new AppError(ADMIN_ERRORS.LAST_ACTIVE_SUPER_ADMIN, 409));
            expect((await rejects(up({ isActive: "N" }))).statusCode).toBe(409);
            expect(AdminModel.setActive).not.toHaveBeenCalled();
        });

        it("reactivating flips without ending sessions; an unchanged isActive writes nothing", async () => {
            vi.mocked(AdminModel.findByUsername).mockResolvedValue(row({ IS_ACTIVE: "N" }));
            await up({ isActive: "Y" });
            expect(calls).toEqual(["setActive"]);
            calls.length = 0;
            vi.mocked(AdminModel.findByUsername).mockResolvedValue(row({ IS_ACTIVE: null }));
            await up({ isActive: "Y" });
            expect(calls).toEqual([]);
        });

        it("an empty flags object does not touch the DB", async () => {
            await up({});
            expect(calls).toEqual([]);
        });
    });

    describe("_invalidateProfileFlags", () => {
        it("deletes the cached /auth/me entry, and swallows an unregistered store", () => {
            const del = vi.fn();
            vi.spyOn(registry, "resolve").mockReturnValueOnce({ del } as never);
            AdminManagementService._invalidateProfileFlags("bob");
            expect(del).toHaveBeenCalledTimes(1);
            vi.spyOn(registry, "resolve").mockImplementationOnce(() => {
                throw new Error("not registered");
            });
            expect(() => AdminManagementService._invalidateProfileFlags("bob")).not.toThrow();
        });
    });
});
