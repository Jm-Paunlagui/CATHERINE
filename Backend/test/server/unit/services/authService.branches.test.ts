"use strict";

/**
 * @fileoverview AuthService branches not reached by authService.test.ts.
 * Persistence, hashing and the lockout are faked (fast, deterministic); JWT
 * signing/verification, the refresh registry and revocation are REAL.
 *
 * Security: CWE-285 (inactive), CWE-354 (signature), CWE-307 (lockout),
 * CWE-367/613 (credential epoch, session end), CWE-208 (timing padding).
 */

import jwt from "jsonwebtoken";
import AuthService from "../../../../src/services/AuthService";
import AdminModel from "../../../../src/models/admin.model";
import UserModel from "../../../../src/models/user.model";
import RefreshTokenService from "../../../../src/services/RefreshTokenService";
import { CryptoVault } from "../../../../src/utils/encryption/CryptoVault";
import { loginLockout } from "../../../../src/middleware/authentication/LoginLockoutMiddleware";
import { registry } from "../../../../src/middleware/cache";
import { refreshTokenRegistry } from "../../../../src/utils/auth/RefreshTokenRegistry";
import { credentialEpoch } from "../../../../src/utils/auth/tokenClaims";
import { AUTH_ERRORS, ADMIN_ERRORS } from "../../../../src/constants/errors";
import { TOKEN_TYPES, TOKEN_ISSUER, TOKEN_AUDIENCES } from "../../../../src/constants/authTokens";

const HASH = "$argon2id$v=19$m=8,t=1,p=1$c2FsdA$aGFzaA";
const FID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const secret = () => process.env.JWT_SECRET as string;

const admin = (over: Record<string, any> = {}): any => ({
    ID: 3, USERNAME: "adm", PASSWORD: HASH, EMAIL: "a@x.test", ROLE: "ADMIN", IS_ACTIVE: "Y", SYSSIGNATURE: "s",
    CAN_RECEIVE_SRV_CRIT: "Y", ...over,
});
const user = (over: Record<string, any> = {}): any => ({
    ID: 9, USERNAME: "usr", PASSWORD: HASH, FIRST_NAME: "A", LAST_NAME: "L", EMAIL: null, IS_ACTIVE: "Y", ...over,
});

async function rejects(p: Promise<unknown>): Promise<any> {
    try {
        await p;
    } catch (e) {
        return e;
    }
    throw new Error("expected rejection");
}

function refreshToken(over: Record<string, unknown> = {}, opts: jwt.SignOptions = {}) {
    const options: jwt.SignOptions = { algorithm: "HS256", audience: TOKEN_AUDIENCES.REFRESH, issuer: TOKEN_ISSUER, jwtid: "jti-1", expiresIn: "1h", ...opts };
    if (options.jwtid === undefined) delete options.jwtid;
    return jwt.sign(
        { sub: "adm", type: TOKEN_TYPES.REFRESH, rs: "admin", fid: FID, pwv: credentialEpoch(HASH), ...over },
        secret(),
        options,
    );
}

describe("AuthService (branches)", () => {
    let revokeFamily: ReturnType<typeof vi.spyOn>;
    let revokeAll: ReturnType<typeof vi.spyOn>;
    let rotate: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        refreshTokenRegistry.clear();
        vi.spyOn(loginLockout, "checkAsync").mockResolvedValue({ locked: false });
        vi.spyOn(loginLockout, "recordFailureAsync").mockResolvedValue();
        vi.spyOn(loginLockout, "recordSuccessAsync").mockResolvedValue();
        vi.spyOn(AdminModel, "findByUsername").mockResolvedValue(null);
        vi.spyOn(UserModel, "findByUsername").mockResolvedValue(null);
        vi.spyOn(AdminModel, "updateCredentials").mockResolvedValue(undefined as never);
        vi.spyOn(UserModel, "updatePassword").mockResolvedValue(undefined as never);
        vi.spyOn(CryptoVault, "verifyRecord").mockResolvedValue(true);
        vi.spyOn(CryptoVault, "signRecord").mockResolvedValue("sig");
        vi.spyOn(CryptoVault, "verifyAdminPassword").mockResolvedValue({ matched: true, newHash: null, expired: false, temporary: false } as never);
        vi.spyOn(CryptoVault, "verifyPassword").mockResolvedValue(true);
        vi.spyOn(CryptoVault, "adminNeedsRehash").mockReturnValue(false);
        vi.spyOn(CryptoVault, "hashAdminPassword").mockResolvedValue(HASH);
        vi.spyOn(CryptoVault, "hashPassword").mockResolvedValue("user-hash");
        vi.spyOn(RefreshTokenService, "persistIssued").mockResolvedValue();
        vi.spyOn(RefreshTokenService, "purgeExpired").mockResolvedValue(0);
        revokeAll = vi.spyOn(RefreshTokenService, "revokeAllForUser").mockResolvedValue();
        revokeFamily = vi.spyOn(RefreshTokenService, "revokeFamily").mockResolvedValue();
        rotate = vi.spyOn(RefreshTokenService, "rotate").mockResolvedValue();
        delete process.env.ADMIN_DEFAULT_PASSWORD;
    });
    afterEach(() => {
        vi.unstubAllEnvs();
        delete process.env.ADMIN_DEFAULT_PASSWORD;
        vi.restoreAllMocks();
    });

    describe("login gates", () => {
        it("permanent lockout -> 423 and no account lookup; temporary lockout -> 429 with retryAfter", async () => {
            vi.mocked(loginLockout.checkAsync).mockResolvedValueOnce({ locked: true, hrReset: true });
            expect((await rejects(AuthService.login("adm", "p"))).statusCode).toBe(423);
            vi.mocked(loginLockout.checkAsync).mockResolvedValueOnce({ locked: true, retryAfter: 42 });
            const err = await rejects(AuthService.login("adm", "p"));
            expect(err.statusCode).toBe(429);
            expect(JSON.stringify(err.details ?? err.error ?? err)).toContain("42");
            expect(AdminModel.findByUsername).not.toHaveBeenCalled();
        });

        it("unknown account -> 401, a failure is recorded, and the timing-padding hash survives a verify error", async () => {
            vi.mocked(CryptoVault.verifyAdminPassword).mockRejectedValueOnce(new Error("boom"));
            const err = await rejects(AuthService.login("ghost", "p"));
            expect(err.statusCode).toBe(401);
            expect(err.message).toBe(AUTH_ERRORS.INVALID_CREDENTIALS);
            expect(loginLockout.recordFailureAsync).toHaveBeenCalledWith("ghost");
        });

        it("admin: tampered signature -> 422 with no password comparison", async () => {
            vi.mocked(AdminModel.findByUsername).mockResolvedValue(admin());
            vi.mocked(CryptoVault.verifyRecord).mockResolvedValueOnce(false);
            const err = await rejects(AuthService.login("adm", "p"));
            expect(err.statusCode).toBe(422);
            expect(CryptoVault.verifyAdminPassword).not.toHaveBeenCalled();
        });

        it("admin: an expired temporary password -> 401 TemporaryPasswordExpired and NOT a lockout failure", async () => {
            vi.mocked(AdminModel.findByUsername).mockResolvedValue(admin());
            vi.mocked(CryptoVault.verifyAdminPassword).mockResolvedValueOnce({ matched: false, expired: true } as never);
            const err = await rejects(AuthService.login("adm", "p"));
            expect(err.message).toBe(AUTH_ERRORS.TEMP_PASSWORD_EXPIRED);
            expect(loginLockout.recordFailureAsync).not.toHaveBeenCalled();
        });

        it("user: wrong password -> 401 plus lockout failure; inactive handled before hashing", async () => {
            vi.mocked(UserModel.findByUsername).mockResolvedValue(user());
            vi.mocked(CryptoVault.verifyPassword).mockResolvedValueOnce(false);
            expect((await rejects(AuthService.login("usr", "bad"))).statusCode).toBe(401);
            expect(loginLockout.recordFailureAsync).toHaveBeenCalledWith("usr");
            vi.mocked(UserModel.findByUsername).mockResolvedValue(user({ IS_ACTIVE: "N" }));
            expect((await rejects(AuthService.login("usr", "p"))).statusCode).toBe(403);
        });
    });

    describe("login success paths", () => {
        it("a legacy hash is upgraded + re-signed and the session binds to the NEW hash", async () => {
            vi.mocked(AdminModel.findByUsername).mockResolvedValue(admin());
            vi.mocked(CryptoVault.verifyAdminPassword).mockResolvedValueOnce({ matched: true, newHash: "$argon2id$new", expired: false } as never);
            const out = await AuthService.login("adm", "p");
            expect(AdminModel.updateCredentials).toHaveBeenCalledWith("adm", "$argon2id$new", "sig");
            const rt = jwt.decode(out.refreshToken) as any;
            expect(rt.pwv).toBe(credentialEpoch("$argon2id$new"));
        });

        it("a failed hash upgrade is logged, login still succeeds on the OLD hash", async () => {
            vi.mocked(AdminModel.findByUsername).mockResolvedValue(admin());
            vi.mocked(CryptoVault.adminNeedsRehash).mockReturnValue(true);
            vi.mocked(AdminModel.updateCredentials).mockRejectedValueOnce(new Error("db"));
            const out = await AuthService.login("adm", "p");
            expect((jwt.decode(out.refreshToken) as any).pwv).toBe(credentialEpoch(HASH));
            vi.mocked(AdminModel.updateCredentials).mockRejectedValueOnce({});
            await expect(AuthService.login("adm", "p")).resolves.toBeDefined();
        });

        it("rehash is skipped for a temporary password (its wrapper must not be replaced)", async () => {
            vi.mocked(AdminModel.findByUsername).mockResolvedValue(admin({ PASSWORD: `$t$${Math.floor((Date.now() + 3_600_000) / 1000).toString(36)}${HASH}` }));
            vi.mocked(CryptoVault.adminNeedsRehash).mockReturnValue(true);
            const out = await AuthService.login("adm", "p");
            expect(CryptoVault.hashAdminPassword).not.toHaveBeenCalled();
            expect(out.user).toMatchObject({ isTemporaryPassword: true, requiresPasswordChange: true });
        });

        it("a stored temporary password past its expiry is refused even when the vault matched", async () => {
            vi.mocked(AdminModel.findByUsername).mockResolvedValue(admin({ PASSWORD: `$t$1${HASH}` }));
            expect((await rejects(AuthService.login("adm", "p"))).message).toBe(AUTH_ERRORS.TEMP_PASSWORD_EXPIRED);
            vi.mocked(AdminModel.findByUsername).mockResolvedValue(admin({ PASSWORD: "$t$bad" }));
            expect((await rejects(AuthService.login("adm", "p"))).statusCode).toBe(401);
        });

        it("ADMIN_DEFAULT_PASSWORD still stored -> restricted session; user path honours it too", async () => {
            process.env.ADMIN_DEFAULT_PASSWORD = "Default#1";
            vi.mocked(AdminModel.findByUsername).mockResolvedValue(admin());
            const a = await AuthService.login("adm", "p");
            expect(a.user).toMatchObject({ isDefaultPassword: true, requiresPasswordChange: true });
            vi.mocked(AdminModel.findByUsername).mockResolvedValue(null);
            vi.mocked(UserModel.findByUsername).mockResolvedValue(user());
            const u = await AuthService.login("usr", "p");
            expect(u.user).toMatchObject({ role: "USER", isDefaultPassword: true });
        });

        it("default-password check is false when verification throws or the stored hash is empty", async () => {
            process.env.ADMIN_DEFAULT_PASSWORD = "Default#1";
            vi.mocked(CryptoVault.verifyAdminPassword).mockRejectedValueOnce(new Error("x"));
            await expect(AuthService._checkIsDefaultPassword(HASH)).resolves.toBe(false);
            await expect(AuthService._checkIsDefaultPassword(null)).resolves.toBe(false);
        });

        it("a session that cannot be persisted fails the login (fail closed)", async () => {
            vi.mocked(AdminModel.findByUsername).mockResolvedValue(admin());
            vi.mocked(RefreshTokenService.persistIssued).mockRejectedValueOnce(new Error("db down"));
            await expect(AuthService.login("adm", "p")).rejects.toThrow("db down");
            expect(loginLockout.recordSuccessAsync).not.toHaveBeenCalled();
        });
    });

    describe("refresh", () => {
        it("rejects garbage, wrong-audience and incomplete-claim tokens with 403", async () => {
            expect((await rejects(AuthService.refresh("garbage"))).statusCode).toBe(403);
            expect((await rejects(AuthService.refresh(refreshToken({}, { audience: TOKEN_AUDIENCES.ACCESS })))).statusCode).toBe(403);
            expect((await rejects(AuthService.refresh(refreshToken({ type: TOKEN_TYPES.ACCESS })))).message).toBe(AUTH_ERRORS.TOKEN_INVALID);
            expect((await rejects(AuthService.refresh(refreshToken({ fid: "" })))).statusCode).toBe(403);
            expect((await rejects(AuthService.refresh(refreshToken({}, { jwtid: undefined })))).statusCode).toBe(403);
            expect((await rejects(AuthService.refresh(refreshToken({ sub: 5 })))).statusCode).toBe(403);
            expect(rotate).not.toHaveBeenCalled();
        });

        it("admin session whose row is gone -> 401 (no silent downgrade to USER)", async () => {
            expect((await rejects(AuthService.refresh(refreshToken()))).message).toBe(AUTH_ERRORS.USER_NOT_FOUND);
            expect(UserModel.findByUsername).not.toHaveBeenCalled();
        });

        it("admin: inactive -> 403; tampered row -> 403 (session ends); both before rotation", async () => {
            vi.mocked(AdminModel.findByUsername).mockResolvedValue(admin({ IS_ACTIVE: "N" }));
            expect((await rejects(AuthService.refresh(refreshToken()))).statusCode).toBe(403);
            vi.mocked(AdminModel.findByUsername).mockResolvedValue(admin());
            vi.mocked(CryptoVault.verifyRecord).mockResolvedValueOnce(false);
            const err = await rejects(AuthService.refresh(refreshToken()));
            expect(err.statusCode).toBe(403);
            expect(err.message).toBe(AUTH_ERRORS.FORBIDDEN_ACCESS);
            expect(rotate).not.toHaveBeenCalled();
        });

        it("admin: a refresh token minted before a password change is refused and its family revoked", async () => {
            vi.mocked(AdminModel.findByUsername).mockResolvedValue(admin({ PASSWORD: "$argon2id$changed" }));
            const err = await rejects(AuthService.refresh(refreshToken()));
            expect(err.message).toBe(AUTH_ERRORS.REFRESH_TOKEN_REVOKED);
            expect(revokeFamily).toHaveBeenCalledWith(FID, "PASSWORD_CHANGE", { bestEffort: true });
            expect(rotate).not.toHaveBeenCalled();
        });

        it("a token with no pwv claim, or a pwv of the wrong length, is refused (fail closed)", async () => {
            vi.mocked(AdminModel.findByUsername).mockResolvedValue(admin());
            expect((await rejects(AuthService.refresh(refreshToken({ pwv: undefined })))).statusCode).toBe(401);
            expect((await rejects(AuthService.refresh(refreshToken({ pwv: 12345 })))).statusCode).toBe(401);
            expect((await rejects(AuthService.refresh(refreshToken({ pwv: "short" })))).statusCode).toBe(401);
        });

        it("fails closed when no credential epoch can be derived (empty stored hash)", async () => {
            vi.mocked(AdminModel.findByUsername).mockResolvedValue(admin({ PASSWORD: "" }));
            expect((await rejects(AuthService.refresh(refreshToken()))).statusCode).toBe(401);
        });

        it("admin: success keeps the SAME family, rotates the presented jti and returns fresh tokens", async () => {
            vi.mocked(AdminModel.findByUsername).mockResolvedValue(admin());
            const out = await AuthService.refresh(refreshToken());
            expect((jwt.decode(out.refreshToken) as any).fid).toBe(FID);
            expect(rotate).toHaveBeenCalledWith({ jti: "jti-1", familyId: FID, userId: "adm" }, expect.objectContaining({ familyId: FID }));
        });

        it("a rotation refusal (reuse/revoked) propagates and no tokens are returned", async () => {
            vi.mocked(AdminModel.findByUsername).mockResolvedValue(admin());
            rotate.mockRejectedValueOnce(Object.assign(new Error("reused"), { statusCode: 401 }));
            expect((await rejects(AuthService.refresh(refreshToken()))).statusCode).toBe(401);
        });

        it("temporary password: expired at refresh -> 401; live -> restricted claims and no 'login' log requirement", async () => {
            vi.mocked(AdminModel.findByUsername).mockResolvedValue(admin({ PASSWORD: `$t$1${HASH}` }));
            const stored = `$t$1${HASH}`;
            const rt = refreshToken({ pwv: credentialEpoch(stored) });
            expect((await rejects(AuthService.refresh(rt))).message).toBe(AUTH_ERRORS.TEMP_PASSWORD_EXPIRED);
            const live = `$t$${Math.floor((Date.now() + 3_600_000) / 1000).toString(36)}${HASH}`;
            vi.mocked(AdminModel.findByUsername).mockResolvedValue(admin({ PASSWORD: live }));
            const out = await AuthService.refresh(refreshToken({ pwv: credentialEpoch(live) }));
            expect(out.user).toMatchObject({ isTemporaryPassword: true, requiresPasswordChange: true });
        });

        it("user session: unknown -> 401, inactive -> 403, stale epoch -> 401, success -> USER tokens", async () => {
            const tok = (o: Record<string, unknown> = {}) => refreshToken({ sub: "usr", rs: "user", ...o });
            expect((await rejects(AuthService.refresh(tok()))).statusCode).toBe(401);
            vi.mocked(UserModel.findByUsername).mockResolvedValue(user({ IS_ACTIVE: "N" }));
            expect((await rejects(AuthService.refresh(tok()))).statusCode).toBe(403);
            vi.mocked(UserModel.findByUsername).mockResolvedValue(user({ PASSWORD: "other" }));
            expect((await rejects(AuthService.refresh(tok()))).statusCode).toBe(401);
            vi.mocked(UserModel.findByUsername).mockResolvedValue(user());
            const out = await AuthService.refresh(tok());
            expect(out.user.role).toBe("USER");
        });

        it("a user session can never be re-issued with the admin role (rs claim missing -> user table only)", async () => {
            vi.mocked(AdminModel.findByUsername).mockResolvedValue(admin());
            vi.mocked(UserModel.findByUsername).mockResolvedValue(null);
            const err = await rejects(AuthService.refresh(refreshToken({ rs: undefined })));
            expect(err.statusCode).toBe(401);
        });
    });

    describe("logout", () => {
        it("no user, or a user without userId, does nothing; without fid logs only; with fid revokes best-effort with retry", async () => {
            await AuthService.logout(undefined);
            await AuthService.logout({} as never);
            await AuthService.logout({ userId: "u" } as never);
            expect(revokeFamily).not.toHaveBeenCalled();
            await AuthService.logout({ userId: "u", fid: FID } as never);
            expect(revokeFamily).toHaveBeenCalledWith(FID, "LOGOUT", { bestEffort: true, retryTransient: true });
        });
    });

    describe("getProfile", () => {
        const decoded = { userId: "adm", role: "ADMIN" } as never;

        it("returns undefined for no caller and USER sessions unchanged (no flags, no DB)", async () => {
            await expect(AuthService.getProfile(undefined)).resolves.toBeUndefined();
            const u = { userId: "u", role: "USER" } as never;
            await expect(AuthService.getProfile(u)).resolves.toBe(u);
            expect(AdminModel.findByUsername).not.toHaveBeenCalled();
        });

        it("without a cache store reads the row; adds flags for an admin, none for a vanished one", async () => {
            vi.spyOn(registry, "resolve").mockImplementation(() => {
                throw new Error("not registered");
            });
            vi.mocked(AdminModel.findByUsername).mockResolvedValueOnce(admin());
            const out: any = await AuthService.getProfile(decoded);
            expect(out.permissions).toMatchObject({ canReceiveSrvCrit: "Y", canReceiveSrvSys: "N", isActive: "Y" });
            vi.mocked(AdminModel.findByUsername).mockResolvedValueOnce(null);
            await expect(AuthService.getProfile(decoded)).resolves.toBe(decoded);
        });

        it("uses the cache store's getOrSet (and its 'false' sentinel means not an admin)", async () => {
            const getOrSet = vi.fn().mockImplementation(async (_k: string, load: () => Promise<unknown>) => load());
            vi.spyOn(registry, "resolve").mockReturnValue({ getOrSet } as never);
            vi.mocked(AdminModel.findByUsername).mockResolvedValueOnce(admin());
            const out: any = await AuthService.getProfile(decoded);
            expect(getOrSet).toHaveBeenCalledTimes(1);
            expect(out.permissions.canReceiveSrvCrit).toBe("Y");
            getOrSet.mockResolvedValueOnce(false);
            await expect(AuthService.getProfile(decoded)).resolves.toBe(decoded);
        });

        it("a lookup failure degrades to the token payload (best effort)", async () => {
            vi.spyOn(registry, "resolve").mockImplementation(() => {
                throw new Error("x");
            });
            vi.mocked(AdminModel.findByUsername).mockRejectedValueOnce(new Error("db down"));
            await expect(AuthService.getProfile(decoded)).resolves.toBe(decoded);
        });
    });

    describe("cookie options", () => {
        it("are always httpOnly/signed/strict; Secure under USE_HTTPS or production; refresh is path-scoped", () => {
            vi.stubEnv("NODE_ENV", "test");
            vi.stubEnv("USE_HTTPS", "false");
            expect(AuthService.accessCookieOptions()).toMatchObject({ httpOnly: true, signed: true, sameSite: "strict", secure: false });
            vi.stubEnv("USE_HTTPS", "true");
            expect(AuthService.refreshCookieOptions()).toMatchObject({ secure: true, path: "/api/v1/auth/refresh", maxAge: 7 * 86_400_000 });
            vi.stubEnv("USE_HTTPS", "false");
            vi.stubEnv("NODE_ENV", "production");
            expect(AuthService.accessCookieOptions().secure).toBe(true);
            expect(AuthService.refreshCookieOptions().secure).toBe(true);
        });

        it("access maxAge follows JWT_EXPIRES_IN, defaulting when unset; a bad format throws", () => {
            vi.stubEnv("JWT_EXPIRES_IN", "2h");
            expect(AuthService.accessCookieOptions().maxAge).toBe(7_200_000);
            vi.stubEnv("JWT_EXPIRES_IN", "");
            expect(AuthService.accessCookieOptions().maxAge).toEqual(expect.any(Number));
            expect(() => AuthService._parseDuration("2w")).toThrow();
        });
    });

    describe("small mappers", () => {
        it("role levels, permission flags and claim shapes", () => {
            expect([AuthService._roleToUserLevel("SUPER_ADMIN"), AuthService._roleToUserLevel("ADMIN"), AuthService._roleToUserLevel("USER"), AuthService._roleToUserLevel("x")]).toEqual([3, 2, 1, 1]);
            expect(AuthService._extractPermissionFlags(null)).toEqual({});
            expect(AuthService._extractPermissionFlags({ IS_ACTIVE: null })).toMatchObject({ isActive: "Y", canReceiveSrvRed: "N" });
            expect(AuthService._adminClaims(admin({ ID: "x", EMAIL: undefined }))).toMatchObject({ id: null, email: null, roleSource: "admin" });
            expect(AuthService._userClaims(user({ ID: 0, FIRST_NAME: undefined, LAST_NAME: undefined }))).toMatchObject({ id: null, firstName: null, lastName: null, role: "USER" });
        });

        it("_issueTokens defaults (no family, no credential hash) mint a fresh family and no pwv", () => {
            vi.stubEnv("JWT_REFRESH_EXPIRES_IN", "");
            const t = AuthService._issueTokens({ id: null, userId: "x", firstName: null, lastName: null, email: null, role: "USER", roleSource: "user" });
            const rt = jwt.decode(t.refreshToken) as any;
            expect(rt.pwv).toBeUndefined();
            expect(rt.fid).toMatch(/^[0-9a-f-]{36}$/);
            expect(t.user).toMatchObject({ requiresPasswordChange: false, permissions: {} });
        });
    });

    describe("changePassword", () => {
        it("unknown account -> 404", async () => {
            expect((await rejects(AuthService.changePassword("ghost", "a", "b"))).statusCode).toBe(404);
        });

        it("admin: inactive 403; tampered 422; expired temporary 401; wrong current 401 - none revoke or write", async () => {
            vi.mocked(AdminModel.findByUsername).mockResolvedValue(admin({ IS_ACTIVE: "N" }));
            expect((await rejects(AuthService.changePassword("adm", "a", "b"))).statusCode).toBe(403);
            vi.mocked(AdminModel.findByUsername).mockResolvedValue(admin());
            vi.mocked(CryptoVault.verifyRecord).mockResolvedValueOnce(false);
            expect((await rejects(AuthService.changePassword("adm", "a", "b"))).statusCode).toBe(422);
            vi.mocked(CryptoVault.verifyAdminPassword).mockResolvedValueOnce({ matched: false, expired: true } as never);
            expect((await rejects(AuthService.changePassword("adm", "a", "b"))).message).toBe(AUTH_ERRORS.TEMP_PASSWORD_EXPIRED);
            vi.mocked(CryptoVault.verifyAdminPassword).mockResolvedValueOnce({ matched: false } as never);
            expect((await rejects(AuthService.changePassword("adm", "a", "b"))).message).toBe(AUTH_ERRORS.INVALID_CREDENTIALS);
            expect(revokeAll).not.toHaveBeenCalled();
            expect(AdminModel.updateCredentials).not.toHaveBeenCalled();
        });

        it("refuses the system default password (400) and reuse of the emailed temporary password (400)", async () => {
            vi.mocked(AdminModel.findByUsername).mockResolvedValue(admin());
            process.env.ADMIN_DEFAULT_PASSWORD = "Default#1";
            const err = await rejects(AuthService.changePassword("adm", "old", "Default#1"));
            expect(err.message).toBe(ADMIN_ERRORS.DEFAULT_PASSWORD_FORBIDDEN);
            delete process.env.ADMIN_DEFAULT_PASSWORD;
            vi.mocked(CryptoVault.verifyAdminPassword).mockResolvedValueOnce({ matched: true, temporary: true } as never);
            const same = await rejects(AuthService.changePassword("adm", "Temp-1234", "Temp-1234"));
            expect(same.message).toBe(AUTH_ERRORS.NEW_PASSWORD_SAME_AS_TEMPORARY);
            expect(revokeAll).not.toHaveBeenCalled();
        });

        it("admin success: ends old sessions FIRST, re-signs, binds the new epoch, and clears the forced change", async () => {
            const order: string[] = [];
            revokeAll.mockImplementation(async () => void order.push("revoke"));
            vi.mocked(AdminModel.updateCredentials).mockImplementation(async () => void order.push("write"));
            vi.mocked(AdminModel.findByUsername).mockResolvedValueOnce(admin()).mockResolvedValueOnce(null);
            vi.mocked(CryptoVault.verifyAdminPassword).mockResolvedValueOnce({ matched: true, temporary: true } as never);
            vi.mocked(CryptoVault.hashAdminPassword).mockResolvedValueOnce("$argon2id$brand-new");
            const out = await AuthService.changePassword("adm", "Temp-1234", "Better#Pass9");
            expect(order).toEqual(["revoke", "write"]);
            expect((jwt.decode(out.refreshToken) as any).pwv).toBe(credentialEpoch("$argon2id$brand-new"));
            expect(out.user).toMatchObject({ requiresPasswordChange: false, isTemporaryPassword: false });
        });

        it("fails closed: if sessions cannot be revoked the password is NOT changed", async () => {
            vi.mocked(AdminModel.findByUsername).mockResolvedValue(admin());
            revokeAll.mockRejectedValueOnce(new Error("db down"));
            await expect(AuthService.changePassword("adm", "a", "Better#Pass9")).rejects.toThrow("db down");
            expect(AdminModel.updateCredentials).not.toHaveBeenCalled();
        });

        it("user: inactive 403, wrong current 401, success hashes with the user vault and writes UserModel", async () => {
            vi.mocked(UserModel.findByUsername).mockResolvedValue(user({ IS_ACTIVE: "N" }));
            expect((await rejects(AuthService.changePassword("usr", "a", "b"))).statusCode).toBe(403);
            vi.mocked(UserModel.findByUsername).mockResolvedValue(user());
            vi.mocked(CryptoVault.verifyPassword).mockResolvedValueOnce(false);
            expect((await rejects(AuthService.changePassword("usr", "a", "b"))).statusCode).toBe(401);
            const out = await AuthService.changePassword("usr", "a", "Better#Pass9");
            expect(UserModel.updatePassword).toHaveBeenCalledWith("usr", "user-hash");
            expect(out.user.role).toBe("USER");
        });
    });
});
