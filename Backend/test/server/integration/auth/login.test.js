"use strict";

/**
 * @fileoverview Integration tests for POST /api/v1/auth/login.
 *
 * AuthService.login is stubbed with Sinon — no real Oracle connection required.
 * Covers the mandatory 10-item checklist (Backend CLAUDE.md §7) plus
 * auth-specific scenarios: lockout, permanent lockout, cookie presence.
 *
 * Security: CWE-287 (tokens in HttpOnly cookies only), CWE-307 (lockout gate),
 * CWE-20 (adversarial inputs rejected without 500).
 */

const request = require("supertest");
const app = require("../../../../src/app");
const AuthService = require("../../../../src/services/auth.service");
const { AppError, AUTH_ERRORS } = require("../../../../src/constants/errors");
const { HTTP_STATUS } = require("../../../../src/constants");
const {
    authRateLimiter,
} = require("../../../../src/middleware/security/RateLimiterMiddleware");

// ── Mock data ──────────────────────────────────────────────────────────────────

const MOCK_USER = {
    userId: "10001",
    GID: 20001,
    userLevel: 2,
    role: "ADMIN",
    firstName: "Juan",
    lastName: "Cruz",
    segmentCode: "HQ",
    segmentDesc: "Headquarters",
    email: "jcruz@corp.com",
    loginSource: "ua",
    isDefaultPassword: false,
    requiresPasswordChange: false,
};

const MOCK_TOKENS = {
    user: MOCK_USER,
    accessToken: "mock.access.token",
    refreshToken: "mock.refresh.token",
};

// ─── Suite ────────────────────────────────────────────────────────────────────

describe("POST /api/v1/auth/login — integration", function () {
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

    describe("happy path — valid credentials", function () {
        beforeEach(function () {
            vi.spyOn(AuthService, "login").mockResolvedValue(MOCK_TOKENS);
        });

        it("returns 200 with user object in data", async function () {
            const res = await agent
                .post("/api/v1/auth/login")
                .set("x-csrf-token", csrfToken)
                .send({ userId: "10001", password: "Correct@1234" });

            expect(res.status).toBe(HTTP_STATUS.OK);
            expect(res.body.status).toBe("success");
            expect(res.body.data).toHaveProperty("user");
            expect(res.body.data.user.userId).toBe("10001");
            expect(res.body.data.user.role).toBe("ADMIN");
        });

        it("sets HttpOnly access-token and refresh-token cookies (CWE-287)", async function () {
            const res = await agent
                .post("/api/v1/auth/login")
                .set("x-csrf-token", csrfToken)
                .send({ userId: "10001", password: "Correct@1234" });

            const cookies = res.headers["set-cookie"] || [];
            const accessCookie = cookies.find((c) =>
                c.includes("app.access-token"),
            );
            const refreshCookie = cookies.find((c) =>
                c.includes("app.refresh-token"),
            );

            expect(accessCookie, "access cookie missing").toBeDefined();
            expect(refreshCookie, "refresh cookie missing").toBeDefined();
            expect(accessCookie).toContain("HttpOnly");
            expect(refreshCookie).toContain("HttpOnly");
        });

        it("response conforms to { status, code, message, data } contract", async function () {
            const res = await agent
                .post("/api/v1/auth/login")
                .set("x-csrf-token", csrfToken)
                .send({ userId: "10001", password: "Correct@1234" });

            expect(res.body).toEqual(
                expect.objectContaining({
                    status: expect.anything(),
                    code: expect.anything(),
                    message: expect.anything(),
                    data: expect.anything(),
                }),
            );
        });

        it("X-Request-ID header is present on every response", async function () {
            const res = await agent
                .post("/api/v1/auth/login")
                .set("x-csrf-token", csrfToken)
                .send({ userId: "10001", password: "Correct@1234" });

            expect(res.headers).toHaveProperty("x-request-id");
        });

        it("responds in under 500ms (hot path budget)", async function () {
            const start = Date.now();
            await agent
                .post("/api/v1/auth/login")
                .set("x-csrf-token", csrfToken)
                .send({ userId: "10001", password: "Correct@1234" });
            expect(Date.now() - start).toBeLessThan(500);
        });

        it("does not expose the raw token values in the response body", async function () {
            const res = await agent
                .post("/api/v1/auth/login")
                .set("x-csrf-token", csrfToken)
                .send({ userId: "10001", password: "Correct@1234" });

            const body = JSON.stringify(res.body);
            expect(body).not.toContain("mock.access.token");
            expect(body).not.toContain("mock.refresh.token");
        });
    });

    // ── 2. Required field validation ────────────────────────────────────────────

    describe("required field validation — 400 responses", function () {
        it("missing userId → 400 with ValidationError and field details", async function () {
            const res = await agent
                .post("/api/v1/auth/login")
                .set("x-csrf-token", csrfToken)
                .send({ password: "some-password" });

            expect(res.status).toBe(400);
            expect(res.body.error.type).toBe("ValidationError");
            expect(res.body.error.details).toBeInstanceOf(Array).that.is.not
                .empty;
            expect(res.body.error.details.some((d) => d.field === "userId")).to
                .be.true;
        });

        it("missing password → 400 with 'password' in details", async function () {
            const res = await agent
                .post("/api/v1/auth/login")
                .set("x-csrf-token", csrfToken)
                .send({ userId: "10001" });

            expect(res.status).toBe(400);
            expect(
                res.body.error.details.some((d) => d.field === "password"),
            ).toBe(true);
        });

        it("empty body → 400 with both userId and password in details", async function () {
            const res = await agent
                .post("/api/v1/auth/login")
                .set("x-csrf-token", csrfToken)
                .send({});

            expect(res.status).toBe(400);
            const fields = res.body.error.details.map((d) => d.field);
            expect(fields).toContain("userId");
            expect(fields).toContain("password");
        });

        it("oversized body → 413 (CWE-400 resource exhaustion)", async function () {
            const huge = Buffer.alloc(11 * 1024 * 1024, "x").toString();
            const res = await agent
                .post("/api/v1/auth/login")
                .set("x-csrf-token", csrfToken)
                .set("Content-Type", "application/json")
                .send(JSON.stringify({ userId: huge, password: "pw" }));

            expect(res.status).toBe(413);
        });
    });

    // ── 3. Authentication failures ──────────────────────────────────────────────

    describe("authentication failures", function () {
        it("invalid credentials → 401 AuthenticationError", async function () {
            vi.spyOn(AuthService, "login").mockRejectedValue(
                new AppError(AUTH_ERRORS.INVALID_CREDENTIALS, 401, {
                    type: "AuthenticationError",
                }),
            );

            const res = await agent
                .post("/api/v1/auth/login")
                .set("x-csrf-token", csrfToken)
                .send({ userId: "10001", password: "wrong-password" });

            expect(res.status).toBe(401);
            expect(res.body.error.type).toBe("AuthenticationError");
        });

        it("account locked (lockout window active) → 429 AccountLockedError", async function () {
            vi.spyOn(AuthService, "login").mockRejectedValue(
                new AppError(AUTH_ERRORS.ACCOUNT_LOCKED, 429, {
                    type: "AccountLockedError",
                    details: [{ field: "retryAfter", issue: "30" }],
                }),
            );

            const res = await agent
                .post("/api/v1/auth/login")
                .set("x-csrf-token", csrfToken)
                .send({ userId: "10001", password: "any" });

            expect(res.status).toBe(429);
            expect(res.body.error.type).toBe("AccountLockedError");
        });

        it("permanent lockout (all cycles exhausted, HR-reset) → 423", async function () {
            vi.spyOn(AuthService, "login").mockRejectedValue(
                new AppError(AUTH_ERRORS.ACCOUNT_LOCKED_PERMANENTLY, 423, {
                    type: "AccountLockedError",
                }),
            );

            const res = await agent
                .post("/api/v1/auth/login")
                .set("x-csrf-token", csrfToken)
                .send({ userId: "10001", password: "any" });

            expect(res.status).toBe(423);
        });

        it("account integrity failure (tampered record) → 422", async function () {
            vi.spyOn(AuthService, "login").mockRejectedValue(
                new AppError("Account integrity check failed.", 422, {
                    type: "DataIntegrityError",
                }),
            );

            const res = await agent
                .post("/api/v1/auth/login")
                .set("x-csrf-token", csrfToken)
                .send({ userId: "10001", password: "any" });

            expect(res.status).toBe(422);
        });
    });

    // ── 4. CSRF gate ────────────────────────────────────────────────────────────

    describe("CSRF protection", function () {
        it("POST without CSRF token → 403", async function () {
            const res = await agent
                .post("/api/v1/auth/login")
                .send({ userId: "10001", password: "pw" });

            expect(res.status).toBe(403);
        });

        it("POST with a forged CSRF token → 403", async function () {
            const res = await agent
                .post("/api/v1/auth/login")
                .set("x-csrf-token", "forged-token-xyz-abc")
                .send({ userId: "10001", password: "pw" });

            expect(res.status).toBe(403);
        });
    });

    // ── 5. Injection payloads (CWE-20) ─────────────────────────────────────────

    describe("adversarial input handling (CWE-20)", function () {
        const PAYLOADS = [
            "'; DROP TABLE USERS; --",
            "' OR 1=1--",
            "<script>alert(1)</script>",
            "../../../etc/passwd",
        ];

        PAYLOADS.forEach((payload) => {
            it(`does not 500 on payload: ${payload.slice(0, 40)}`, async function () {
                vi.spyOn(AuthService, "login").mockRejectedValue(
                    new AppError(AUTH_ERRORS.INVALID_CREDENTIALS, 401, {
                        type: "AuthenticationError",
                    }),
                );

                const res = await agent
                    .post("/api/v1/auth/login")
                    .set("x-csrf-token", csrfToken)
                    .send({ userId: payload, password: payload });

                expect(res.status).not.toBe(500);
                expect(res.body.status).toBe("error");
            });
        });
    });

    // ── 6. Route not accessible via GET ─────────────────────────────────────────

    it("GET /api/v1/auth/login is not a valid route (405 or 404)", async function () {
        const res = await agent.get("/api/v1/auth/login");
        expect([404, 405]).toContain(res.status);
    });
});
