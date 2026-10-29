"use strict";

/**
 * @fileoverview Integration tests for POST /api/v1/auth/refresh.
 *
 * Contract (AuthControllers.refresh + AuthService.refresh):
 *   - The refresh token is read ONLY from the signed cookie `app.refresh-token`;
 *     an Authorization header is ignored (replay vector closed).
 *   - No usable signed cookie → 401 AuthenticationError (controller).
 *   - Token fails verification (signature/exp/aud/iss/type/jti/fid) → 403 (service).
 *   - Revoked / reused / account gone → 401 (service).
 *
 * Happy-path tests stub AuthService.refresh (no Oracle). Verification-stage
 * rejections run the REAL service: jwt.verify throws before any DB call.
 */

const { randomUUID } = require("crypto");
const request = require("supertest");
const jwt = require("jsonwebtoken");
const cookieSignature = require("cookie-signature");
const app = require("../../../../src/app");
const AuthService = require("../../../../src/services/AuthService");
const { AppError, AUTH_ERRORS } = require("../../../../src/constants/errors");
const { HTTP_STATUS } = require("../../../../src/constants");
const {
    COOKIE_NAMES,
    TOKEN_TYPES,
    TOKEN_ISSUER,
    TOKEN_AUDIENCES,
} = require("../../../../src/constants/authTokens");
const { authRateLimiters } = require("../../../../src/middleware/security/authRateLimiters");
const { signToken } = require("../../helpers/auth");

// ── Helpers ────────────────────────────────────────────────────────────────────

const ROUTE = "/api/v1/auth/refresh";

const MOCK_USER = {
    userId: "10001",
    userLevel: 2,
    role: "ADMIN",
    firstName: "Juan",
    lastName: "Cruz",
    isDefaultPassword: false,
    requiresPasswordChange: false,
};

const MOCK_REFRESH_RESULT = {
    user: MOCK_USER,
    accessToken: "new.access.token",
    refreshToken: "new.refresh.token",
};

/** Refresh JWT with the full claim set AuthService.refresh requires. */
function makeRefreshToken(overrides = {}, { secret, expiresIn = "7d" } = {}) {
    const payload = {
        sub: "10001",
        type: TOKEN_TYPES.REFRESH,
        aud: TOKEN_AUDIENCES.REFRESH,
        iss: TOKEN_ISSUER,
        fid: randomUUID(),
        jti: randomUUID(),
        ...overrides,
    };
    const opts = payload.exp === undefined ? { expiresIn } : {};
    return jwt.sign(payload, secret ?? process.env.JWT_SECRET, { algorithm: "HS256", ...opts });
}

/** Signs a cookie value the way cookie-parser expects ("s:" + HMAC). */
function signCookie(value, secret = process.env.COOKIE_SECRET) {
    return "s:" + cookieSignature.sign(value, secret);
}

/** Cookie pair for a signed refresh cookie. */
function refreshCookie(token, secret) {
    return `${COOKIE_NAMES.REFRESH}=${encodeURIComponent(signCookie(token, secret))}`;
}

/** Fetches a CSRF token plus its cookie pairs (session id is req.ip, so reusable). */
async function getCsrf() {
    const res = await request(app).get("/api/v1/csrf/token");
    const pairs = (res.headers["set-cookie"] || []).map((c) => c.split(";")[0]);
    return { token: res.body?.token ?? "", cookies: pairs };
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe("POST /api/v1/auth/refresh — integration", function () {
    let csrf;

    /** POST with CSRF header + cookie and any extra cookie pairs. */
    function post(extraCookies = [], { withCsrf = true } = {}) {
        const cookies = [...csrf.cookies, ...extraCookies];
        const req = request(app).post(ROUTE).set("Cookie", cookies.join("; "));
        return withCsrf ? req.set("x-csrf-token", csrf.token) : req;
    }

    beforeAll(async function () {
        csrf = await getCsrf();
    });

    beforeEach(function () {
        authRateLimiters.flushAll();
    });

    afterEach(function () {
        vi.restoreAllMocks();
    });

    // ── 1. Happy path ───────────────────────────────────────────────────────────

    describe("happy path — valid signed refresh cookie", function () {
        let refreshStub;
        let token;

        beforeEach(function () {
            refreshStub = vi.spyOn(AuthService, "refresh").mockResolvedValue(MOCK_REFRESH_RESULT);
            token = makeRefreshToken();
        });

        it("returns 200 with refreshed user in data", async function () {
            const res = await post([refreshCookie(token)]);

            expect(res.status).toBe(HTTP_STATUS.OK);
            expect(res.body.status).toBe("success");
            expect(res.body.data.user.userId).toBe("10001");
        });

        it("passes the unsigned raw token from the cookie to the service", async function () {
            await post([refreshCookie(token)]);

            expect(refreshStub).toHaveBeenCalledTimes(1);
            expect(refreshStub).toHaveBeenCalledWith(token);
        });

        it("rotates both cookies — new access-token and refresh-token set", async function () {
            const res = await post([refreshCookie(token)]);

            const cookies = res.headers["set-cookie"] || [];
            expect(cookies.some((c) => c.startsWith(`${COOKIE_NAMES.ACCESS}=`))).toBe(true);
            expect(cookies.some((c) => c.startsWith(`${COOKIE_NAMES.REFRESH}=`))).toBe(true);
        });

        it("new cookies are HttpOnly, SameSite=Strict and signed (CWE-287)", async function () {
            const res = await post([refreshCookie(token)]);

            const cookies = res.headers["set-cookie"] || [];
            const access = cookies.find((c) => c.startsWith(`${COOKIE_NAMES.ACCESS}=`));
            const refresh = cookies.find((c) => c.startsWith(`${COOKIE_NAMES.REFRESH}=`));
            for (const c of [access, refresh]) {
                expect(c).toContain("HttpOnly");
                expect(c).toContain("SameSite=Strict");
                expect(c).toMatch(/=s%3A/);
            }
        });

        it("rotated refresh cookie is path-scoped to the refresh route", async function () {
            const res = await post([refreshCookie(token)]);

            const refresh = (res.headers["set-cookie"] || []).find((c) =>
                c.startsWith(`${COOKIE_NAMES.REFRESH}=`),
            );
            expect(refresh).toContain(`Path=${ROUTE}`);
        });

        it("response conforms to { status, code, message, data } shape", async function () {
            const res = await post([refreshCookie(token)]);

            expect(res.body).toEqual(
                expect.objectContaining({
                    status: expect.anything(),
                    code: expect.anything(),
                    message: expect.anything(),
                    data: expect.anything(),
                }),
            );
            expect(res.headers["content-type"]).toMatch(/application\/json/);
        });

        it("X-Request-ID header is present", async function () {
            const res = await post([refreshCookie(token)]);
            expect(res.headers).toHaveProperty("x-request-id");
        });

        it("responds in under 500ms", async function () {
            const start = Date.now();
            await post([refreshCookie(token)]);
            expect(Date.now() - start).toBeLessThan(500);
        });
    });

    // ── 2. Missing / unusable cookie → 401 at the controller ───────────────────

    describe("missing or unusable refresh cookie", function () {
        let refreshStub;

        beforeEach(function () {
            refreshStub = vi.spyOn(AuthService, "refresh").mockResolvedValue(MOCK_REFRESH_RESULT);
        });

        it("no cookie → 401 AuthenticationError and the service is never called", async function () {
            const res = await post();

            expect(res.status).toBe(401);
            expect(res.body.error.type).toBe("AuthenticationError");
            expect(res.body.message).toBe(AUTH_ERRORS.REFRESH_TOKEN_MISSING);
            expect(refreshStub).not.toHaveBeenCalled();
        });

        it("no cookie is reported as REFRESH_TOKEN_MISSING, never USER_NOT_FOUND", async function () {
            const res = await post();

            expect(AUTH_ERRORS.REFRESH_TOKEN_MISSING).toBeTypeOf("string");
            expect(res.body.message).toBe(AUTH_ERRORS.REFRESH_TOKEN_MISSING);
            expect(res.body.message).not.toBe(AUTH_ERRORS.USER_NOT_FOUND);
            expect(res.body.error.hint).toBe("No refresh token provided.");
        });

        it("error response body conforms to { status, code, title, message, error } shape", async function () {
            const res = await post();

            expect(res.body).toEqual(
                expect.objectContaining({
                    status: expect.anything(),
                    code: expect.anything(),
                    title: expect.anything(),
                    message: expect.anything(),
                    error: expect.anything(),
                }),
            );
            expect(res.body.status).toBe("error");
        });

        it("valid refresh token in Authorization header only → 401 (header source removed)", async function () {
            // Was accepted by the old contract; header tokens are now a refused replay vector.
            const res = await post().set("Authorization", `Bearer ${makeRefreshToken()}`);

            expect(res.status).toBe(401);
            expect(refreshStub).not.toHaveBeenCalled();
        });

        it("unsigned plain cookie → 401 (lands in req.cookies not req.signedCookies)", async function () {
            const res = await post([`${COOKIE_NAMES.REFRESH}=${makeRefreshToken()}`]);

            expect(res.status).toBe(401);
            expect(res.body.message).toBe(AUTH_ERRORS.REFRESH_TOKEN_MISSING);
            expect(refreshStub).not.toHaveBeenCalled();
        });

        it("cookie signed with the wrong cookie secret → 401", async function () {
            const res = await post([refreshCookie(makeRefreshToken(), "wrong-cookie-secret")]);

            expect(res.status).toBe(401);
            expect(res.body.message).toBe(AUTH_ERRORS.REFRESH_TOKEN_MISSING);
            expect(refreshStub).not.toHaveBeenCalled();
        });
    });

    // ── 3. Verification failures → 403 (real AuthService.refresh, no DB) ────────

    describe("invalid, expired, or wrong-type refresh token", function () {
        it("expired refresh token → 403", async function () {
            const expired = makeRefreshToken({ exp: Math.floor(Date.now() / 1000) - 60 });
            const res = await post([refreshCookie(expired)]);

            expect(res.status).toBe(403);
            expect(res.body.error.type).toBe("AuthenticationError");
        });

        it("access token presented as refresh → 403 (token-type confusion, CWE-287)", async function () {
            const res = await post([refreshCookie(signToken({ sub: "10001" }))]);

            expect(res.status).toBe(403);
        });

        it("refresh audience/issuer but type 'access' → 403", async function () {
            const res = await post([refreshCookie(makeRefreshToken({ type: TOKEN_TYPES.ACCESS }))]);

            expect(res.status).toBe(403);
        });

        it("refresh token without a family id → 403", async function () {
            const res = await post([refreshCookie(makeRefreshToken({ fid: undefined }))]);

            expect(res.status).toBe(403);
        });

        it("refresh token without a jti → 403", async function () {
            const res = await post([refreshCookie(makeRefreshToken({ jti: undefined }))]);

            expect(res.status).toBe(403);
        });

        it("wrong issuer → 403", async function () {
            const res = await post([refreshCookie(makeRefreshToken({ iss: "other-api" }))]);

            expect(res.status).toBe(403);
        });

        it("structurally invalid token string → 403", async function () {
            const res = await post([refreshCookie("not.a.real.jwt.at.all")]);

            expect(res.status).toBe(403);
        });

        it("token signed with the wrong JWT secret → 403 (forged)", async function () {
            const forged = makeRefreshToken({}, { secret: "wrong-secret" });
            const res = await post([refreshCookie(forged)]);

            expect(res.status).toBe(403);
        });

        it("alg=none token → 403", async function () {
            const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
            const body = Buffer.from(
                JSON.stringify({
                    sub: "10001",
                    type: TOKEN_TYPES.REFRESH,
                    aud: TOKEN_AUDIENCES.REFRESH,
                    iss: TOKEN_ISSUER,
                    fid: randomUUID(),
                    jti: randomUUID(),
                }),
            ).toString("base64url");
            const res = await post([refreshCookie(`${header}.${body}.`)]);

            expect(res.status).toBe(403);
        });

        it("account gone / session revoked during refresh → 401", async function () {
            vi.spyOn(AuthService, "refresh").mockRejectedValue(
                new AppError(AUTH_ERRORS.USER_NOT_FOUND, 401, { type: "AuthenticationError" }),
            );

            const res = await post([refreshCookie(makeRefreshToken())]);

            expect(res.status).toBe(401);
            expect(res.headers["set-cookie"] || []).not.toEqual(
                expect.arrayContaining([expect.stringMatching(/^app\.access-token=s%3A/)]),
            );
        });
    });

    // ── 4. CSRF gate ────────────────────────────────────────────────────────────

    describe("CSRF protection", function () {
        let refreshStub;

        beforeEach(function () {
            refreshStub = vi.spyOn(AuthService, "refresh").mockResolvedValue(MOCK_REFRESH_RESULT);
        });

        it("POST without CSRF token → 403", async function () {
            const res = await post([refreshCookie(makeRefreshToken())], { withCsrf: false });

            expect(res.status).toBe(403);
            expect(refreshStub).not.toHaveBeenCalled();
        });

        it("POST with forged CSRF token → 403", async function () {
            const res = await post([refreshCookie(makeRefreshToken())], { withCsrf: false })
                .set("x-csrf-token", "forged-csrf-xyz");

            expect(res.status).toBe(403);
            expect(refreshStub).not.toHaveBeenCalled();
        });
    });

    // ── 5. Oversized body ───────────────────────────────────────────────────────

    it("oversized body → 413", async function () {
        const huge = Buffer.alloc(11 * 1024 * 1024, "x").toString();
        const res = await post()
            .set("Content-Type", "application/json")
            .send(JSON.stringify({ data: huge }));

        expect(res.status).toBe(413);
    });

    // ── 6. Route method guard ────────────────────────────────────────────────────

    it("GET /api/v1/auth/refresh is not a valid route (404 or 405)", async function () {
        const res = await request(app).get(ROUTE);
        expect([404, 405]).toContain(res.status);
    });
});
