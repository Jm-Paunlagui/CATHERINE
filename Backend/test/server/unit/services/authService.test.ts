"use strict";

/**
 * @fileoverview Real AuthService against in-memory fakes (no DB).
 *
 * Only the persistence edges are faked: AdminModel / UserModel lookups and the
 * AuthRefreshTokenModel ledger. CryptoVault (argon2 + HMAC signatures), the
 * login lockout, the refresh-token registry, access revocation and token
 * signing are all REAL, so the gates below are exercised end to end.
 *
 * Security: CWE-285 (IS_ACTIVE), CWE-354 (SYSSIGNATURE), CWE-307 (lockout),
 * CWE-613 (temporary password expiry, refresh reuse).
 */

import { randomUUID } from "crypto";
import jwt from "jsonwebtoken";
import AuthService from "../../../../src/services/AuthService";
import AdminModel from "../../../../src/models/admin.model";
import UserModel from "../../../../src/models/user.model";
import AuthRefreshTokenModel from "../../../../src/models/auth.refresh.token.model";
import AccessRevocationService from "../../../../src/services/AccessRevocationService";
import { CryptoVault } from "../../../../src/utils/encryption/CryptoVault";
import { wrapTemporaryHash } from "../../../../src/utils/encryption/adminTempPassword";
import { loginLockout } from "../../../../src/middleware/authentication/LoginLockoutMiddleware";
import { classifyAccessClaims } from "../../../../src/utils/auth/tokenClaims";
import { AUTH_ERRORS, ADMIN_ERRORS } from "../../../../src/constants/errors";
import { TOKEN_TYPES, TOKEN_ISSUER, TOKEN_AUDIENCES } from "../../../../src/constants/authTokens";

const PASSWORD = "Str0ng#Passw0rd-for-tests";
const WRONG = "Wr0ng#Passw0rd-for-tests";

type Ledger = { familyId: string; revoked: boolean; used: boolean };

/** In-memory stand-in for the T_AUTH_REFRESH_TOKEN_DEV ledger. */
function installLedger() {
    const rows = new Map<string, Ledger>();
    const add = (rec: { jtiHash: string; familyId: string }) =>
        rows.set(rec.jtiHash, { familyId: rec.familyId, revoked: false, used: false });
    const insert = vi.spyOn(AuthRefreshTokenModel, "insert").mockImplementation(async (rec) => {
        add(rec);
    });
    vi.spyOn(AuthRefreshTokenModel, "rotate").mockImplementation(async ({ oldHash, next, allowAbsent }) => {
        const row = rows.get(oldHash);
        if (!row) {
            if (!allowAbsent) return { outcome: "absent" };
            add(next);
            return { outcome: "ok" };
        }
        if (row.revoked) return { outcome: "revoked" };
        if (row.used) return { outcome: "reused" };
        row.used = true;
        add(next);
        return { outcome: "ok" };
    });
    vi.spyOn(AuthRefreshTokenModel, "revokeFamily").mockImplementation(async (familyId) => {
        let n = 0;
        for (const r of rows.values()) {
            if (r.familyId === familyId && !r.revoked) {
                r.revoked = true;
                n++;
            }
        }
        return n;
    });
    vi.spyOn(AuthRefreshTokenModel, "revokeUser").mockResolvedValue([]);
    vi.spyOn(AuthRefreshTokenModel, "purgeExpired").mockResolvedValue(0);
    return { rows, insert };
}

let nextId = 1;

/** A correctly signed T_ADMINS_DEV row. */
async function adminRow(over: Record<string, any> = {}) {
    const row: any = {
        ID: nextId++,
        USERNAME: `admin-${randomUUID().slice(0, 8)}`,
        PASSWORD: await CryptoVault.hashAdminPassword(PASSWORD),
        EMAIL: null,
        ROLE: "ADMIN",
        IS_ACTIVE: "Y",
        CREATED_AT: new Date(),
        UPDATED_AT: new Date(),
        ...over,
    };
    if (!("SYSSIGNATURE" in over)) {
        row.SYSSIGNATURE = await CryptoVault.signRecord(AdminModel.SIGN_CONTEXT, AdminModel.buildSignedFields(row));
    }
    return row;
}

/** Re-signs a row after `over` is applied (a legitimate edit). */
async function resign(row: any) {
    return CryptoVault.signRecord(AdminModel.SIGN_CONTEXT, AdminModel.buildSignedFields(row));
}

async function userRow(over: Record<string, any> = {}) {
    return {
        ID: nextId++,
        USERNAME: `user-${randomUUID().slice(0, 8)}`,
        PASSWORD: await CryptoVault.hashPassword(PASSWORD),
        FIRST_NAME: "Ada",
        LAST_NAME: "Lovelace",
        EMAIL: null,
        IS_ACTIVE: "Y",
        CREATED_AT: new Date(),
        UPDATED_AT: new Date(),
        ...over,
    };
}

function serve(admin: any | null, user: any | null = null) {
    vi.spyOn(AdminModel, "findByUsername").mockImplementation(async (u) => (admin && admin.USERNAME === u ? admin : null));
    vi.spyOn(UserModel, "findByUsername").mockImplementation(async (u) => (user && user.USERNAME === u ? user : null));
}

describe("AuthService (real, fake DB)", () => {
    let ledger: ReturnType<typeof installLedger>;
    const savedEnv: Record<string, string | undefined> = {};

    beforeAll(() => {
        // CryptoVault reads these lazily on first hash. The pepper is mandatory for argon2;
        // the cost is lowered (still argon2id) so the suite stays fast.
        const env = {
            ARGON2_PEPPER: "unit-test-pepper-unit-test-pepper-0123456789",
            ARGON2_MEMORY_COST: "8192",
            ARGON2_TIME_COST: "1",
            ARGON2_PARALLELISM: "1",
        };
        for (const [k, v] of Object.entries(env)) {
            savedEnv[k] = process.env[k];
            process.env[k] ??= v;
        }
    });

    afterAll(() => {
        for (const [k, v] of Object.entries(savedEnv)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    });

    beforeEach(() => {
        ledger = installLedger();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    // ── login: happy path ────────────────────────────────────────────────────

    describe("login", () => {
        it("issues a typed access token and a refresh token of one family, and persists the ledger row", async () => {
            const admin = await adminRow();
            serve(admin);

            const out = await AuthService.login(admin.USERNAME, PASSWORD);

            const access = jwt.verify(out.accessToken, process.env.JWT_SECRET as string) as jwt.JwtPayload;
            expect(classifyAccessClaims(access)).toBe("access");
            expect(access.aud).toBe(TOKEN_AUDIENCES.ACCESS);
            expect(access.iss).toBe(TOKEN_ISSUER);
            const refresh = jwt.verify(out.refreshToken, process.env.JWT_SECRET as string) as jwt.JwtPayload;
            expect(refresh.type).toBe(TOKEN_TYPES.REFRESH);
            expect(refresh.fid).toBe(access.fid);
            expect(out.user.requiresPasswordChange).toBe(false);
            expect(ledger.insert).toHaveBeenCalledTimes(1);
            expect(out.accessToken).not.toBe(out.refreshToken);
        });

        it("wrong password -> 401 and no session persisted", async () => {
            const admin = await adminRow();
            serve(admin);

            await expect(AuthService.login(admin.USERNAME, WRONG)).rejects.toMatchObject({
                statusCode: 401,
                message: AUTH_ERRORS.INVALID_CREDENTIALS,
            });
            expect(ledger.insert).not.toHaveBeenCalled();
        });

        it("unknown username -> same 401 as a wrong password (no enumeration)", async () => {
            serve(null);

            await expect(AuthService.login(`ghost-${randomUUID()}`, PASSWORD)).rejects.toMatchObject({
                statusCode: 401,
                message: AUTH_ERRORS.INVALID_CREDENTIALS,
            });
        });

        it("regular user logs in from T_USERS_DEV with role USER", async () => {
            const user = await userRow();
            serve(null, user);

            const out = await AuthService.login(user.USERNAME, PASSWORD);

            expect(out.user.role).toBe("USER");
            const access = jwt.verify(out.accessToken, process.env.JWT_SECRET as string) as jwt.JwtPayload;
            expect(classifyAccessClaims(access)).toBe("access");
        });
    });

    // ── IS_ACTIVE gate ───────────────────────────────────────────────────────

    describe("IS_ACTIVE gate", () => {
        it("deactivated admin with the CORRECT password -> 403 and no token", async () => {
            const row = await adminRow({ IS_ACTIVE: "N" });
            row.SYSSIGNATURE = await resign(row);
            serve(row);

            await expect(AuthService.login(row.USERNAME, PASSWORD)).rejects.toMatchObject({
                statusCode: 403,
                message: ADMIN_ERRORS.ACCOUNT_INACTIVE,
            });
            expect(ledger.insert).not.toHaveBeenCalled();
        });

        it("deactivated user -> 403 on login", async () => {
            const user = await userRow({ IS_ACTIVE: "N" });
            serve(null, user);

            await expect(AuthService.login(user.USERNAME, PASSWORD)).rejects.toMatchObject({
                statusCode: 403,
                message: AUTH_ERRORS.ACCOUNT_INACTIVE,
            });
        });

        it("an admin deactivated AFTER login cannot refresh", async () => {
            const admin = await adminRow();
            serve(admin);
            const { refreshToken } = await AuthService.login(admin.USERNAME, PASSWORD);

            const off = { ...admin, IS_ACTIVE: "N" };
            off.SYSSIGNATURE = await resign(off);
            serve(off);

            await expect(AuthService.refresh(refreshToken)).rejects.toMatchObject({ statusCode: 403 });
        });

        it("a user deactivated AFTER login cannot refresh", async () => {
            const user = await userRow();
            serve(null, user);
            const { refreshToken } = await AuthService.login(user.USERNAME, PASSWORD);

            serve(null, { ...user, IS_ACTIVE: "N" });

            await expect(AuthService.refresh(refreshToken)).rejects.toMatchObject({ statusCode: 403 });
        });
    });

    // ── SYSSIGNATURE ─────────────────────────────────────────────────────────

    describe("SYSSIGNATURE tamper", () => {
        it("role edited outside the app (signature stale) -> 422 at login, before any password check", async () => {
            const row = await adminRow();
            row.ROLE = "SUPER_ADMIN"; // direct SQL edit, signature NOT recomputed
            serve(row);
            const verify = vi.spyOn(CryptoVault, "verifyAdminPassword");

            await expect(AuthService.login(row.USERNAME, PASSWORD)).rejects.toMatchObject({
                statusCode: 422,
                message: AUTH_ERRORS.ACCOUNT_INTEGRITY_FAILED,
            });
            expect(verify).not.toHaveBeenCalled();
            expect(ledger.insert).not.toHaveBeenCalled();
        });

        it("IS_ACTIVE flipped back to Y by direct SQL -> 422", async () => {
            const row = await adminRow({ IS_ACTIVE: "N" });
            row.SYSSIGNATURE = await resign(row);
            row.IS_ACTIVE = "Y";
            serve(row);

            await expect(AuthService.login(row.USERNAME, PASSWORD)).rejects.toMatchObject({ statusCode: 422 });
        });

        it("missing signature -> 422", async () => {
            const row = await adminRow({ SYSSIGNATURE: null });
            serve(row);

            await expect(AuthService.login(row.USERNAME, PASSWORD)).rejects.toMatchObject({ statusCode: 422 });
        });

        it("password hash swapped by direct SQL -> 422", async () => {
            const row = await adminRow();
            row.PASSWORD = await CryptoVault.hashAdminPassword(WRONG);
            serve(row);

            await expect(AuthService.login(row.USERNAME, WRONG)).rejects.toMatchObject({ statusCode: 422 });
        });

        it("tamper discovered at refresh ends the session with 403", async () => {
            const admin = await adminRow();
            serve(admin);
            const { refreshToken } = await AuthService.login(admin.USERNAME, PASSWORD);

            serve({ ...admin, ROLE: "SUPER_ADMIN" });

            await expect(AuthService.refresh(refreshToken)).rejects.toMatchObject({
                statusCode: 403,
                message: AUTH_ERRORS.FORBIDDEN_ACCESS,
            });
        });
    });

    // ── Lockout ──────────────────────────────────────────────────────────────

    describe("lockout", () => {
        it("locks after the max failed attempts: the CORRECT password is then refused with 429", async () => {
            const admin = await adminRow();
            serve(admin);
            const max = (loginLockout as any)._maxAttempts as number;

            try {
                for (let i = 0; i < max; i++) {
                    await expect(AuthService.login(admin.USERNAME, WRONG)).rejects.toMatchObject({ statusCode: 401 });
                }

                await expect(AuthService.login(admin.USERNAME, PASSWORD)).rejects.toMatchObject({
                    statusCode: 429,
                    message: AUTH_ERRORS.ACCOUNT_LOCKED,
                });
                expect(ledger.insert).not.toHaveBeenCalled();
            } finally {
                loginLockout.recordSuccess(admin.USERNAME);
            }
        });

        it("failures below the threshold do not lock, and a success resets the counter", async () => {
            const admin = await adminRow();
            serve(admin);
            const max = (loginLockout as any)._maxAttempts as number;

            try {
                for (let i = 0; i < max - 1; i++) {
                    await expect(AuthService.login(admin.USERNAME, WRONG)).rejects.toMatchObject({ statusCode: 401 });
                }
                await expect(AuthService.login(admin.USERNAME, PASSWORD)).resolves.toBeDefined();

                // counter was cleared: max-1 more failures still do not lock
                for (let i = 0; i < max - 1; i++) {
                    await expect(AuthService.login(admin.USERNAME, WRONG)).rejects.toMatchObject({ statusCode: 401 });
                }
                await expect(AuthService.login(admin.USERNAME, PASSWORD)).resolves.toBeDefined();
            } finally {
                loginLockout.recordSuccess(admin.USERNAME);
            }
        });

        it("unknown usernames are counted too, so lockout cannot be used to enumerate accounts", async () => {
            const ghost = `ghost-${randomUUID()}`;
            serve(null);
            const max = (loginLockout as any)._maxAttempts as number;

            try {
                for (let i = 0; i < max; i++) {
                    await expect(AuthService.login(ghost, WRONG)).rejects.toMatchObject({ statusCode: 401 });
                }
                await expect(AuthService.login(ghost, WRONG)).rejects.toMatchObject({ statusCode: 429 });
            } finally {
                loginLockout.recordSuccess(ghost);
            }
        });
    });

    // ── Temporary password ───────────────────────────────────────────────────

    describe("temporary password", () => {
        async function tempAdmin(expiresAtMs: number) {
            const inner = await CryptoVault.hashAdminPassword(PASSWORD);
            const row = await adminRow({ PASSWORD: wrapTemporaryHash(inner, expiresAtMs) });
            row.SYSSIGNATURE = await resign(row);
            return row;
        }

        it("expired temporary password, correct secret -> 401 TemporaryPasswordExpiredError, no session", async () => {
            const row = await tempAdmin(Date.now() - 60_000);
            serve(row);

            await expect(AuthService.login(row.USERNAME, PASSWORD)).rejects.toMatchObject({
                statusCode: 401,
                name: "TemporaryPasswordExpiredError",
                message: AUTH_ERRORS.TEMP_PASSWORD_EXPIRED,
            });
            expect(ledger.insert).not.toHaveBeenCalled();
        });

        it("expired temporary password, WRONG secret -> generic invalid credentials (expiry not disclosed)", async () => {
            const row = await tempAdmin(Date.now() - 60_000);
            serve(row);

            try {
                await expect(AuthService.login(row.USERNAME, WRONG)).rejects.toMatchObject({
                    statusCode: 401,
                    message: AUTH_ERRORS.INVALID_CREDENTIALS,
                });
            } finally {
                loginLockout.recordSuccess(row.USERNAME);
            }
        });

        it("valid temporary password logs in but is restricted (requiresPasswordChange claim)", async () => {
            const row = await tempAdmin(Date.now() + 3_600_000);
            serve(row);

            const out = await AuthService.login(row.USERNAME, PASSWORD);

            const access = jwt.verify(out.accessToken, process.env.JWT_SECRET as string) as jwt.JwtPayload;
            expect(access.requiresPasswordChange).toBe(true);
            expect(access.isTemporaryPassword).toBe(true);
            expect(typeof access.temporaryPasswordExpiresAt).toBe("string");
        });

        it("a session minted while the temporary password was valid cannot refresh after it expires", async () => {
            const row = await tempAdmin(Date.now() + 60_000);
            serve(row);
            const { refreshToken } = await AuthService.login(row.USERNAME, PASSWORD);

            const realNow = Date.now();
            vi.spyOn(Date, "now").mockReturnValue(realNow + 120_000);

            await expect(AuthService.refresh(refreshToken)).rejects.toMatchObject({
                statusCode: 401,
                name: "TemporaryPasswordExpiredError",
            });
        });
    });

    // ── Refresh / logout ─────────────────────────────────────────────────────

    describe("refresh rotation and session end", () => {
        it("rotates within the same family; the presented token is one-time", async () => {
            const admin = await adminRow();
            serve(admin);
            const first = await AuthService.login(admin.USERNAME, PASSWORD);

            const second = await AuthService.refresh(first.refreshToken);

            const fidOf = (t: string) => (jwt.decode(t) as jwt.JwtPayload).fid;
            expect(fidOf(second.refreshToken)).toBe(fidOf(first.refreshToken));
            expect(second.refreshToken).not.toBe(first.refreshToken);
            expect(classifyAccessClaims(jwt.decode(second.accessToken) as jwt.JwtPayload)).toBe("access");
        });

        it("reusing a consumed refresh token -> 401 and the whole family (incl. the successor and its access token) dies", async () => {
            const admin = await adminRow();
            serve(admin);
            const first = await AuthService.login(admin.USERNAME, PASSWORD);
            const second = await AuthService.refresh(first.refreshToken);
            const fid = (jwt.decode(first.accessToken) as jwt.JwtPayload).fid as string;
            expect(AccessRevocationService.isRevoked(fid)).toBe(false);

            await expect(AuthService.refresh(first.refreshToken)).rejects.toMatchObject({
                statusCode: 401,
                message: AUTH_ERRORS.REFRESH_TOKEN_REUSED,
            });

            expect(AccessRevocationService.isRevoked(fid)).toBe(true);
            await expect(AuthService.refresh(second.refreshToken)).rejects.toMatchObject({
                statusCode: 401,
                message: AUTH_ERRORS.REFRESH_TOKEN_REVOKED,
            });
        });

        it("a refresh token from before a password change is refused (credential epoch)", async () => {
            const admin = await adminRow();
            serve(admin);
            const { refreshToken } = await AuthService.login(admin.USERNAME, PASSWORD);

            const changed = { ...admin, PASSWORD: await CryptoVault.hashAdminPassword(WRONG) };
            changed.SYSSIGNATURE = await resign(changed);
            serve(changed);

            await expect(AuthService.refresh(refreshToken)).rejects.toMatchObject({
                statusCode: 401,
                message: AUTH_ERRORS.REFRESH_TOKEN_REVOKED,
            });
        });

        it("an ACCESS token presented as a refresh token -> 403", async () => {
            const admin = await adminRow();
            serve(admin);
            const { accessToken } = await AuthService.login(admin.USERNAME, PASSWORD);

            await expect(AuthService.refresh(accessToken)).rejects.toMatchObject({ statusCode: 403 });
        });

        it("refresh token signed with another secret -> 403", async () => {
            const forged = jwt.sign(
                { sub: "x", type: TOKEN_TYPES.REFRESH, jti: randomUUID(), fid: randomUUID() },
                "some-other-secret",
                { audience: TOKEN_AUDIENCES.REFRESH, issuer: TOKEN_ISSUER },
            );

            await expect(AuthService.refresh(forged)).rejects.toMatchObject({ statusCode: 403 });
        });

        it("refresh for an account whose row is gone -> 401", async () => {
            const admin = await adminRow();
            serve(admin);
            const { refreshToken } = await AuthService.login(admin.USERNAME, PASSWORD);
            serve(null);

            await expect(AuthService.refresh(refreshToken)).rejects.toMatchObject({
                statusCode: 401,
                message: AUTH_ERRORS.USER_NOT_FOUND,
            });
        });

        it("logout ends the access token's family at once and revokes the ledger", async () => {
            const admin = await adminRow();
            serve(admin);
            const out = await AuthService.login(admin.USERNAME, PASSWORD);
            const claims = jwt.decode(out.accessToken) as any;
            expect(AccessRevocationService.isRevoked(claims.fid)).toBe(false);

            await AuthService.logout(claims);

            expect(AccessRevocationService.isRevoked(claims.fid)).toBe(true);
            expect(AuthRefreshTokenModel.revokeFamily).toHaveBeenCalledWith(claims.fid, expect.any(String), expect.any(Date));
            await expect(AuthService.refresh(out.refreshToken)).rejects.toMatchObject({ statusCode: 401 });
        });

        it("logout still ends the session in memory when the DB revoke fails (best effort)", async () => {
            const admin = await adminRow();
            serve(admin);
            const out = await AuthService.login(admin.USERNAME, PASSWORD);
            const claims = jwt.decode(out.accessToken) as any;
            vi.spyOn(AuthRefreshTokenModel, "revokeFamily").mockRejectedValue(new Error("ORA-03113"));

            await expect(AuthService.logout(claims)).resolves.toBeUndefined();

            expect(AccessRevocationService.isRevoked(claims.fid)).toBe(true);
        });

        it("logout without a user is a no-op", async () => {
            await expect(AuthService.logout(undefined)).resolves.toBeUndefined();
            expect(AuthRefreshTokenModel.revokeFamily).not.toHaveBeenCalled();
        });
    });
});
