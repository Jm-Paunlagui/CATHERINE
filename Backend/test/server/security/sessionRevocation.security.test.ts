"use strict";

/**
 * @fileoverview Session revocation, end to end over HTTP.
 *
 * The REAL app, AuthMiddleware, AuthService, RefreshTokenService, registry and
 * access-revocation set run. Only the persistence edges are faked (admin
 * lookup and the refresh-token ledger), so no database is needed.
 *
 * Security: CWE-613 (ended session still usable), CWE-287 / token-type
 * confusion (refresh token used as access token), CWE-294 (refresh replay).
 */

import { randomUUID } from "crypto";
import request from "supertest";
import jwt from "jsonwebtoken";
import cookieSignature from "cookie-signature";
import app from "../../../src/app";
import AdminModel from "../../../src/models/admin.model";
import AuthRefreshTokenModel from "../../../src/models/auth.refresh.token.model";
import AccessRevocationService from "../../../src/services/AccessRevocationService";
import { CryptoVault } from "../../../src/utils/encryption/CryptoVault";
import { authRateLimiters } from "../../../src/middleware/security/authRateLimiters";
import { loginLockout } from "../../../src/middleware/authentication/LoginLockoutMiddleware";
import { COOKIE_NAMES, TOKEN_TYPES, TOKEN_ISSUER, TOKEN_AUDIENCES } from "../../../src/constants/authTokens";
import { AUTH_ERRORS } from "../../../src/constants/errors";

const PASSWORD = "Str0ng#Passw0rd-for-tests";
const ME = "/api/v1/auth/me";
const LOGOUT = "/api/v1/auth/logout";
const REFRESH = "/api/v1/auth/refresh";
const LOGIN = "/api/v1/auth/login";

type Ledger = { familyId: string; revoked: boolean; used: boolean };

function installLedger() {
    const rows = new Map<string, Ledger>();
    const add = (rec: { jtiHash: string; familyId: string }) =>
        rows.set(rec.jtiHash, { familyId: rec.familyId, revoked: false, used: false });
    vi.spyOn(AuthRefreshTokenModel, "insert").mockImplementation(async (rec) => {
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
}

function signCookie(value: string) {
    return "s:" + cookieSignature.sign(value, process.env.COOKIE_SECRET as string);
}

/** Raw JWT out of a signed Set-Cookie header ("name=s%3A<jwt>.<sig>; ..."). */
function cookieJwt(setCookie: string[], name: string): string {
    const line = setCookie.find((c) => c.startsWith(`${name}=`));
    if (!line) throw new Error(`cookie ${name} not set`);
    const value = decodeURIComponent(line.split(";")[0].slice(name.length + 1));
    return value.slice(2, value.lastIndexOf("."));
}

describe("session revocation (security)", () => {
    let csrf: { token: string; cookies: string[] };
    let username: string;
    const savedEnv: Record<string, string | undefined> = {};

    beforeAll(async () => {
        for (const [k, v] of Object.entries({
            ARGON2_PEPPER: "unit-test-pepper-unit-test-pepper-0123456789",
            ARGON2_MEMORY_COST: "8192",
            ARGON2_TIME_COST: "1",
            ARGON2_PARALLELISM: "1",
        })) {
            savedEnv[k] = process.env[k];
            process.env[k] ??= v;
        }
        const res = await request(app).get("/api/v1/csrf/token");
        csrf = {
            token: res.body?.token ?? "",
            cookies: ((res.headers["set-cookie"] || []) as unknown as string[]).map((c: string) => c.split(";")[0]),
        };
    });

    afterAll(() => {
        for (const [k, v] of Object.entries(savedEnv)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    });

    beforeEach(async () => {
        authRateLimiters.flushAll();
        installLedger();
        username = `rev-${randomUUID().slice(0, 8)}`;
        const row: any = {
            ID: 777,
            USERNAME: username,
            PASSWORD: await CryptoVault.hashAdminPassword(PASSWORD),
            EMAIL: null,
            ROLE: "ADMIN",
            IS_ACTIVE: "Y",
            CREATED_AT: new Date(),
            UPDATED_AT: new Date(),
        };
        row.SYSSIGNATURE = await CryptoVault.signRecord(AdminModel.SIGN_CONTEXT, AdminModel.buildSignedFields(row));
        vi.spyOn(AdminModel, "findByUsername").mockImplementation(async (u) => (u === username ? row : null));
    });

    afterEach(() => {
        loginLockout.recordSuccess(username);
        vi.restoreAllMocks();
    });

    function post(path: string, extra: string[] = []) {
        return request(app)
            .post(path)
            .set("Cookie", [...csrf.cookies, ...extra].join("; "))
            .set("x-csrf-token", csrf.token);
    }

    /** Real login; returns the raw access and refresh JWTs. */
    async function login() {
        const res = await post(LOGIN).send({ userId: username, password: PASSWORD });
        expect(res.status).toBe(200);
        const cookies = res.headers["set-cookie"] as unknown as string[];
        return {
            access: cookieJwt(cookies, COOKIE_NAMES.ACCESS),
            refresh: cookieJwt(cookies, COOKIE_NAMES.REFRESH),
        };
    }

    const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
    const refreshCookie = (t: string) => `${COOKIE_NAMES.REFRESH}=${encodeURIComponent(signCookie(t))}`;

    it("a freshly issued access token is accepted", async () => {
        const { access } = await login();

        const res = await request(app).get(ME).set(bearer(access));

        expect(res.status).toBe(200);
    });

    it("logout, then the SAME access token -> 440 SessionRevokedError", async () => {
        const { access } = await login();

        const out = await post(LOGOUT).set(bearer(access));
        expect(out.status).toBe(200);

        const res = await request(app).get(ME).set(bearer(access));
        expect(res.status).toBe(440);
        expect(res.body.error.type).toBe("SessionRevokedError");
        expect(res.body.message).toBe(AUTH_ERRORS.ACCESS_SESSION_REVOKED);
    });

    it("logout also kills the refresh token of that session", async () => {
        const { access, refresh } = await login();
        await post(LOGOUT).set(bearer(access));

        const res = await post(REFRESH, [refreshCookie(refresh)]);

        expect(res.status).toBe(401);
    });

    it("another session of the same user survives a logout of the first", async () => {
        const a = await login();
        const b = await login();

        await post(LOGOUT).set(bearer(a.access));

        expect((await request(app).get(ME).set(bearer(b.access))).status).toBe(200);
        expect((await request(app).get(ME).set(bearer(a.access))).status).toBe(440);
    });

    it("a REFRESH token presented as an access token -> 401 (Bearer)", async () => {
        const { refresh } = await login();

        const res = await request(app).get(ME).set(bearer(refresh));

        expect(res.status).toBe(401);
        expect(res.body.message).toBe(AUTH_ERRORS.TOKEN_TYPE_INVALID);
    });

    it("a refresh token with forged access claims but the wrong aud -> 401", async () => {
        const { refresh } = await login();
        const claims = jwt.decode(refresh) as jwt.JwtPayload;
        const forged = jwt.sign(
            { sub: claims.sub, userLevel: 3, fid: claims.fid, type: TOKEN_TYPES.ACCESS, aud: TOKEN_AUDIENCES.REFRESH, iss: TOKEN_ISSUER },
            process.env.JWT_SECRET as string,
            { algorithm: "HS256", expiresIn: "5m" },
        );

        const res = await request(app).get(ME).set(bearer(forged));

        expect(res.status).toBe(401);
    });

    it("a legacy token (no type/aud/iss) signed with the real secret -> 440", async () => {
        const legacy = jwt.sign({ sub: username, userId: username, userLevel: 3 }, process.env.JWT_SECRET as string, {
            expiresIn: "5m",
        });

        const res = await request(app).get(ME).set(bearer(legacy));

        expect(res.status).toBe(440);
        expect(res.body.error.type).toBe("SessionTimeoutError");
    });

    it("a legacy token is refused on a state-changing route too (logout)", async () => {
        const legacy = jwt.sign({ sub: username, userId: username }, process.env.JWT_SECRET as string, { expiresIn: "5m" });

        const res = await post(LOGOUT).set(bearer(legacy));

        expect(res.status).toBe(440);
    });

    it("refresh rotates: the old refresh token is one-time", async () => {
        const { refresh } = await login();

        const first = await post(REFRESH, [refreshCookie(refresh)]);

        expect(first.status).toBe(200);
        const next = cookieJwt(first.headers["set-cookie"] as unknown as string[], COOKIE_NAMES.REFRESH);
        expect(next).not.toBe(refresh);
    });

    it("refresh reuse -> 401 and the whole family dies: successor refresh token AND the live access token", async () => {
        const { access, refresh } = await login();
        const first = await post(REFRESH, [refreshCookie(refresh)]);
        expect(first.status).toBe(200);
        const cookies = first.headers["set-cookie"] as unknown as string[];
        const newRefresh = cookieJwt(cookies, COOKIE_NAMES.REFRESH);
        const newAccess = cookieJwt(cookies, COOKIE_NAMES.ACCESS);
        expect((await request(app).get(ME).set(bearer(newAccess))).status).toBe(200);

        const replay = await post(REFRESH, [refreshCookie(refresh)]);
        expect(replay.status).toBe(401);
        expect(replay.body.message).toBe(AUTH_ERRORS.REFRESH_TOKEN_REUSED);

        const successor = await post(REFRESH, [refreshCookie(newRefresh)]);
        expect(successor.status).toBe(401);
        expect(successor.body.message).toBe(AUTH_ERRORS.REFRESH_TOKEN_REVOKED);
        for (const t of [access, newAccess]) {
            const res = await request(app).get(ME).set(bearer(t));
            expect(res.status).toBe(440);
            expect(res.body.error.type).toBe("SessionRevokedError");
        }
    });

    it("reuse of one family does not end another family of the same user", async () => {
        const a = await login();
        const b = await login();
        await post(REFRESH, [refreshCookie(a.refresh)]);
        await post(REFRESH, [refreshCookie(a.refresh)]); // replay -> family A revoked

        expect((await request(app).get(ME).set(bearer(b.access))).status).toBe(200);
        expect((await post(REFRESH, [refreshCookie(b.refresh)])).status).toBe(200);
    });

    it("revocation is in-memory: it holds even when the ledger write fails (fails closed for access tokens)", async () => {
        const { access } = await login();
        vi.spyOn(AuthRefreshTokenModel, "revokeFamily").mockRejectedValue(new Error("ORA-03113"));

        const out = await post(LOGOUT).set(bearer(access));
        expect(out.status).toBe(200);

        const fid = (jwt.decode(access) as jwt.JwtPayload).fid as string;
        expect(AccessRevocationService.isRevoked(fid)).toBe(true);
        expect((await request(app).get(ME).set(bearer(access))).status).toBe(440);
    });

    it("a refresh token signed with a different secret is refused", async () => {
        const forged = jwt.sign(
            { sub: username, type: TOKEN_TYPES.REFRESH, jti: randomUUID(), fid: randomUUID() },
            "not-the-server-secret",
            { audience: TOKEN_AUDIENCES.REFRESH, issuer: TOKEN_ISSUER, expiresIn: "1h" },
        );

        const res = await post(REFRESH, [refreshCookie(forged)]);

        expect(res.status).toBe(403);
    });
});
