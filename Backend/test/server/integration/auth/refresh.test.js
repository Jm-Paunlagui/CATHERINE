"use strict";

/**
 * @fileoverview Integration tests for POST /api/v1/auth/refresh.
 *
 * AuthService.refresh is stubbed — no real Oracle connection required.
 * The refresh token is supplied via Authorization: Bearer header
 * (the controller reads from signedCookie OR header; header is simpler in tests).
 *
 * Covers: happy path (token rotation, cookie rotation, response shape),
 * missing token, invalid / expired / wrong-type tokens, CSRF gate, oversized body.
 */

const request = require("supertest");
const jwt = require("jsonwebtoken");
const app = require("../../../../src/app");
const AuthService = require("../../../../src/services/auth.service");
const { AppError, AUTH_ERRORS } = require("../../../../src/constants/errors");
const { HTTP_STATUS } = require("../../../../src/constants");
const {
    authRateLimiter,
} = require("../../../../src/middleware/security/RateLimiterMiddleware");

// ── Helpers ────────────────────────────────────────────────────────────────────

const MOCK_USER = {
    userId: "10001",
    GID: 20001,
    userLevel: 2,
    role: "ADMIN",
    firstName: "Juan",
    lastName: "Cruz",
    loginSource: "ua",
    isDefaultPassword: false,
    requiresPasswordChange: false,
};

const MOCK_REFRESH_RESULT = {
    user: MOCK_USER,
    accessToken: "new.access.token",
    refreshToken: "new.refresh.token",
};

function makeRefreshToken(overrides = {}, expiresIn = "7d") {
    return jwt.sign(
        { sub: "10001", type: "refresh", ...overrides },
        process.env.JWT_SECRET || "test-secret",
        { expiresIn },
    );
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe("POST /api/v1/auth/refresh — integration", function () {
    let agent;
    let csrfToken;

    beforeAll(async function () {
        agent = request.agent(app);
        const tokenRes = await agent.get("/api/v1/csrf/token");
        csrfToken = tokenRes.body?.token ?? "";
    });

    beforeEach(function () {
        authRateLimiter.flushAll();
    });

    afterEach(function () {
        vi.restoreAllMocks();
    });

    // ── 1. Happy path ───────────────────────────────────────────────────────────

    describe("happy path — valid refresh token", function () {
        beforeEach(function () {
            vi.spyOn(AuthService, "refresh").mockResolvedValue(MOCK_REFRESH_RESULT);
        });

        it("returns 200 with refreshed user in data", async function () {
            const res = await agent
                .post("/api/v1/auth/refresh")
                .set("x-csrf-token", csrfToken)
                .set("Authorization", `Bearer ${makeRefreshToken()}`);

            expect(res.status).toBe(HTTP_STATUS.OK);
            expect(res.body.status).toBe("success");
            expect(res.body.data).toHaveProperty("user");
            expect(res.body.data.user.userId).toBe("10001");
        });

        it("rotates both cookies — new access-token and refresh-token set", async function () {
            const res = await agent
                .post("/api/v1/auth/refresh")
                .set("x-csrf-token", csrfToken)
                .set("Authorization", `Bearer ${makeRefreshToken()}`);

            const cookies = res.headers["set-cookie"] || [];
            expect(
                cookies.some((c) => c.includes("app.access-token")),
                "access cookie missing",
            ).toBe(true);
            expect(
                cookies.some((c) => c.includes("app.refresh-token")),
                "refresh cookie missing",
            ).toBe(true);
        });

        it("new cookies are HttpOnly (CWE-287)", async function () {
            const res = await agent
                .post("/api/v1/auth/refresh")
                .set("x-csrf-token", csrfToken)
                .set("Authorization", `Bearer ${makeRefreshToken()}`);

            const cookies = res.headers["set-cookie"] || [];
            const access = cookies.find((c) => c.includes("app.access-token"));
            const refresh = cookies.find((c) =>
                c.includes("app.refresh-token"),
            );
            expect(access).toContain("HttpOnly");
            expect(refresh).toContain("HttpOnly");
        });

        it("response conforms to { status, code, message, data } shape", async function () {
            const res = await agent
                .post("/api/v1/auth/refresh")
                .set("x-csrf-token", csrfToken)
                .set("Authorization", `Bearer ${makeRefreshToken()}`);

            expect(res.body).toEqual(expect.objectContaining({status: expect.anything(), code: expect.anything(), message: expect.anything(), data: expect.anything()}));
        });

        it("X-Request-ID header is present", async function () {
            const res = await agent
                .post("/api/v1/auth/refresh")
                .set("x-csrf-token", csrfToken)
                .set("Authorization", `Bearer ${makeRefreshToken()}`);

            expect(res.headers).toHaveProperty("x-request-id");
        });

        it("responds in under 500ms", async function () {
            const start = Date.now();
            await agent
                .post("/api/v1/auth/refresh")
                .set("x-csrf-token", csrfToken)
                .set("Authorization", `Bearer ${makeRefreshToken()}`);
            expect(Date.now() - start).toBeLessThan(500);
        });
    });

    // ── 2. Missing refresh token ─────────────────────────────────────────────────

    describe("missing refresh token", function () {
        // Use a fresh agent so it doesn't carry the refresh-token cookie that the
        // happy-path tests write into the shared `agent` cookie jar. Without
        // isolation, the controller finds the cookie and tries to verify it —
        // the mock "new.refresh.token" value is not a valid JWT → 403.
        let cleanAgent;
        let cleanCsrf;

        beforeAll(async function () {
            cleanAgent = request.agent(app);
            const tokenRes = await cleanAgent.get("/api/v1/csrf/token");
            cleanCsrf = tokenRes.body?.token ?? "";
        });

        it("no Authorization header and no signed cookie → 401 AuthenticationError", async function () {
            const res = await cleanAgent
                .post("/api/v1/auth/refresh")
                .set("x-csrf-token", cleanCsrf);

            expect(res.status).toBe(401);
            expect(res.body.error.type).toBe("AuthenticationError");
        });

        it("error response body conforms to { status, code, message, error } shape", async function () {
            const res = await cleanAgent
                .post("/api/v1/auth/refresh")
                .set("x-csrf-token", cleanCsrf);

            expect(res.body).toEqual(expect.objectContaining({status: expect.anything(), code: expect.anything(), title: expect.anything(), message: expect.anything(), error: expect.anything()}));
            expect(res.body.status).toBe("error");
        });
    });

    // ── 3. Invalid / expired / wrong-type tokens ─────────────────────────────────

    describe("invalid, expired, or wrong-type refresh token", function () {
        it("expired refresh token → 403", async function () {
            vi.spyOn(AuthService, "refresh").mockRejectedValue(
                new AppError(AUTH_ERRORS.TOKEN_INVALID, 403, {
                    type: "AuthenticationError",
                }),
            );

            const res = await agent
                .post("/api/v1/auth/refresh")
                .set("x-csrf-token", csrfToken)
                .set("Authorization", `Bearer ${makeRefreshToken({}, "-1s")}`);

            expect(res.status).toBe(403);
        });

        it("access token used as refresh (missing type: 'refresh') → service throws 403", async function () {
            vi.spyOn(AuthService, "refresh").mockRejectedValue(
                new AppError(AUTH_ERRORS.TOKEN_INVALID, 403, {
                    type: "AuthenticationError",
                }),
            );

            const wrongType = jwt.sign(
                { sub: "10001" },
                process.env.JWT_SECRET || "test-secret",
                { expiresIn: "1h" },
            );

            const res = await agent
                .post("/api/v1/auth/refresh")
                .set("x-csrf-token", csrfToken)
                .set("Authorization", `Bearer ${wrongType}`);

            expect(res.status).toBe(403);
        });

        it("structurally invalid token string → service throws 403", async function () {
            vi.spyOn(AuthService, "refresh").mockRejectedValue(
                new AppError(AUTH_ERRORS.TOKEN_INVALID, 403, {
                    type: "AuthenticationError",
                }),
            );

            const res = await agent
                .post("/api/v1/auth/refresh")
                .set("x-csrf-token", csrfToken)
                .set("Authorization", "Bearer not.a.real.jwt.at.all");

            expect(res.status).toBe(403);
        });

        it("token signed with wrong secret → service throws 403", async function () {
            vi.spyOn(AuthService, "refresh").mockRejectedValue(
                new AppError(AUTH_ERRORS.TOKEN_INVALID, 403, {
                    type: "AuthenticationError",
                }),
            );

            const forged = jwt.sign(
                { sub: "10001", type: "refresh" },
                "wrong-secret",
            );

            const res = await agent
                .post("/api/v1/auth/refresh")
                .set("x-csrf-token", csrfToken)
                .set("Authorization", `Bearer ${forged}`);

            expect(res.status).toBe(403);
        });

        it("user not found in DB during refresh → 401", async function () {
            vi.spyOn(AuthService, "refresh").mockRejectedValue(
                new AppError(AUTH_ERRORS.USER_NOT_FOUND, 401, {
                    type: "AuthenticationError",
                }),
            );

            const res = await agent
                .post("/api/v1/auth/refresh")
                .set("x-csrf-token", csrfToken)
                .set("Authorization", `Bearer ${makeRefreshToken()}`);

            expect(res.status).toBe(401);
        });
    });

    // ── 4. CSRF gate ────────────────────────────────────────────────────────────

    describe("CSRF protection", function () {
        it("POST without CSRF token → 403", async function () {
            const res = await agent
                .post("/api/v1/auth/refresh")
                .set("Authorization", `Bearer ${makeRefreshToken()}`);

            expect(res.status).toBe(403);
        });

        it("POST with forged CSRF token → 403", async function () {
            const res = await agent
                .post("/api/v1/auth/refresh")
                .set("Authorization", `Bearer ${makeRefreshToken()}`)
                .set("x-csrf-token", "forged-csrf-xyz");

            expect(res.status).toBe(403);
        });
    });

    // ── 5. Oversized body ───────────────────────────────────────────────────────

    it("oversized body → 413", async function () {
        const huge = Buffer.alloc(11 * 1024 * 1024, "x").toString();
        const res = await agent
            .post("/api/v1/auth/refresh")
            .set("x-csrf-token", csrfToken)
            .set("Content-Type", "application/json")
            .send(JSON.stringify({ data: huge }));

        expect(res.status).toBe(413);
    });

    // ── 6. Route method guard ────────────────────────────────────────────────────

    it("GET /api/v1/auth/refresh is not a valid route (404 or 405)", async function () {
        const res = await agent.get("/api/v1/auth/refresh");
        expect([404, 405]).toContain(res.status);
    });
});
