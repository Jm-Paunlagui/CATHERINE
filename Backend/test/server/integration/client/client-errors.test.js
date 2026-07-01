"use strict";

/**
 * @fileoverview Integration tests for POST /api/v1/client/errors.
 *
 * This endpoint receives structured render-error reports from the frontend
 * ErrorBoundary. Any authenticated user (any role) may call it.
 *
 * ClientService.logError is stubbed to avoid filesystem or logger I/O.
 *
 * Covers:
 *   - Happy path (200, any authenticated role)
 *   - Auth enforcement: 401 no token, 440 expired, 401 wrong secret
 *   - CSRF gate: 403 on missing/forged token
 *   - Oversized body → 413
 *   - Malformed JSON → 400
 *   - Response shape contract { status, code, message, data }
 *   - X-Request-ID on every response
 *   - Response time < 500ms
 */

const request = require("supertest");
const jwt = require("jsonwebtoken");
const app = require("../../../../src/app");
const { signToken } = require("../../helpers/auth");
const ClientService = require("../../../../src/services/ClientService");

// ── Token factories ───────────────────────────────────────────────────────────

const adminToken = () =>
    signToken({ userId: "ADM001", role: "ADMIN", userLevel: 2 });
const approverToken = () =>
    signToken({ userId: "APR001", role: "APPROVER", userLevel: 1 });
const superToken = () =>
    signToken({ userId: "SA001", role: "SUPER_ADMIN", userLevel: 3 });

// ── Assertion helpers ─────────────────────────────────────────────────────────

function expectSuccessShape(body) {
    expect(body).toHaveProperty("status");
    expect(body).toHaveProperty("code");
    expect(body).toHaveProperty("message");
    expect(body).toHaveProperty("data");
    expect(body.status).toBe("success");
}

function expectErrorShape(body) {
    expect(body).toHaveProperty("status");
    expect(body).toHaveProperty("code");
    expect(body).toHaveProperty("message");
    expect(body).toHaveProperty("error");
    expect(body.status).toBe("error");
}

// ── Valid error report fixture ────────────────────────────────────────────────

const validPayload = () => ({
    message: "Cannot read properties of undefined (reading 'map')",
    stack: "TypeError: Cannot read properties of undefined...\n  at Component (Component.jsx:42)",
    componentStack: "\n    at Component\n    at App",
    url: "/dashboard",
    userAgent: "Mozilla/5.0 (Windows NT 10.0)",
    timestamp: new Date().toISOString(),
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/v1/client/errors
// ═══════════════════════════════════════════════════════════════════════════════

describe("POST /api/v1/client/errors", function () {
    let agent;
    let csrfToken;

    beforeAll(async function () {
        agent = request.agent(app);
        const tokenRes = await agent.get("/api/v1/csrf/token");
        csrfToken = tokenRes.body?.token ?? "";
    });

    beforeEach(function () {
        vi.spyOn(ClientService, "logError").mockResolvedValue();
    });

    afterEach(function () {
        vi.restoreAllMocks();
    });

    // ─── 1. Happy path ─────────────────────────────────────────────────────────

    it("returns 200 for ADMIN role (any authenticated user is accepted)", async function () {
        const res = await agent
            .post("/api/v1/client/errors")
            .set("Authorization", `Bearer ${adminToken()}`)
            .set("x-csrf-token", csrfToken)
            .send(validPayload());

        expect(res.status).toBe(200);
        expectSuccessShape(res.body);
        expect(ClientService.logError).toHaveBeenCalledTimes(1);
    });

    it("returns 200 for APPROVER role (no privilege escalation check — any role)", async function () {
        const res = await agent
            .post("/api/v1/client/errors")
            .set("Authorization", `Bearer ${approverToken()}`)
            .set("x-csrf-token", csrfToken)
            .send(validPayload());

        expect(res.status).toBe(200);
    });

    it("returns 200 for SUPER_ADMIN role", async function () {
        const res = await agent
            .post("/api/v1/client/errors")
            .set("Authorization", `Bearer ${superToken()}`)
            .set("x-csrf-token", csrfToken)
            .send(validPayload());

        expect(res.status).toBe(200);
    });

    it("passes req.body and req.user to ClientService.logError", async function () {
        await agent
            .post("/api/v1/client/errors")
            .set("Authorization", `Bearer ${adminToken()}`)
            .set("x-csrf-token", csrfToken)
            .send(validPayload());

        expect(ClientService.logError).toHaveBeenCalledTimes(1);
        const [body, user] = ClientService.logError.mock.calls[0];
        expect(body).toHaveProperty("message");
        expect(user).toHaveProperty("userId", "ADM001");
    });

    // ─── 2. Authentication failures ───────────────────────────────────────────

    it("returns 401 when no Authorization header is provided", async function () {
        const res = await agent
            .post("/api/v1/client/errors")
            .set("x-csrf-token", csrfToken)
            .send(validPayload());

        expect(res.status).toBe(401);
        expectErrorShape(res.body);
    });

    it("returns 401 when token is structurally invalid", async function () {
        const res = await agent
            .post("/api/v1/client/errors")
            .set("Authorization", "Bearer not.a.jwt")
            .set("x-csrf-token", csrfToken)
            .send(validPayload());

        expect(res.status).toBe(401);
    });

    it("returns 440 when token is expired (AuthMiddleware maps TokenExpiredError → 440)", async function () {
        const expired = signToken({ userId: "ADM001", role: "ADMIN" }, "-1s");
        const res = await agent
            .post("/api/v1/client/errors")
            .set("Authorization", `Bearer ${expired}`)
            .set("x-csrf-token", csrfToken)
            .send(validPayload());

        expect(res.status).toBe(440);
    });

    it("returns 403 when token is signed with wrong secret (M-11: tampered → 403)", async function () {
        const forged = jwt.sign(
            { sub: "hacker", userId: "X", userLevel: 2 },
            "wrong-secret",
        );
        const res = await agent
            .post("/api/v1/client/errors")
            .set("Authorization", `Bearer ${forged}`)
            .set("x-csrf-token", csrfToken)
            .send(validPayload());

        expect(res.status).toBe(403);
    });

    // ─── 3. CSRF gate ─────────────────────────────────────────────────────────

    it("returns 403 when CSRF token is absent", async function () {
        const res = await agent
            .post("/api/v1/client/errors")
            .set("Authorization", `Bearer ${adminToken()}`)
            .send(validPayload());

        expect(res.status).toBe(403);
    });

    it("returns 403 when CSRF token is forged", async function () {
        const res = await agent
            .post("/api/v1/client/errors")
            .set("Authorization", `Bearer ${adminToken()}`)
            .set("x-csrf-token", "forged-csrf-xyz")
            .send(validPayload());

        expect(res.status).toBe(403);
    });

    // ─── 4. Body limits ────────────────────────────────────────────────────────

    it("returns 413 when body exceeds size limit", async function () {
        const huge = "x".repeat(11 * 1024 * 1024);
        const res = await agent
            .post("/api/v1/client/errors")
            .set("Authorization", `Bearer ${adminToken()}`)
            .set("x-csrf-token", csrfToken)
            .set("Content-Type", "application/json")
            .send(JSON.stringify({ message: huge }));

        expect(res.status).toBe(413);
    });

    it("returns 400 for malformed JSON body", async function () {
        const res = await agent
            .post("/api/v1/client/errors")
            .set("Authorization", `Bearer ${adminToken()}`)
            .set("x-csrf-token", csrfToken)
            .set("Content-Type", "application/json")
            .send("{invalid json}");

        expect(res.status).toBe(400);
    });

    // ─── 5. Response contract ─────────────────────────────────────────────────

    it("response shape matches { status, code, message, data } contract", async function () {
        const res = await agent
            .post("/api/v1/client/errors")
            .set("Authorization", `Bearer ${adminToken()}`)
            .set("x-csrf-token", csrfToken)
            .send(validPayload());

        expect(res.body).toHaveProperty("status");
        expect(res.body).toHaveProperty("code");
        expect(res.body).toHaveProperty("message");
        expect(res.body).toHaveProperty("data");
        expect(res.body.code).toBe(200);
    });

    // ─── 6. X-Request-ID ──────────────────────────────────────────────────────

    it("sets X-Request-ID on the response", async function () {
        const res = await agent
            .post("/api/v1/client/errors")
            .set("Authorization", `Bearer ${adminToken()}`)
            .set("x-csrf-token", csrfToken)
            .send(validPayload());

        expect(res.headers["x-request-id"]).toMatch(
            /^(\d{13}-\d{4}-\d{4}|req_.+)$/,
        );
    });

    // ─── 7. Response time ─────────────────────────────────────────────────────

    it("responds in under 500ms", async function () {
        const start = Date.now();
        await agent
            .post("/api/v1/client/errors")
            .set("Authorization", `Bearer ${adminToken()}`)
            .set("x-csrf-token", csrfToken)
            .send(validPayload());
        expect(Date.now() - start).toBeLessThan(500);
    });

    // ─── 8. Scanner path ─────────────────────────────────────────────────────

    it("GET /api/v1/client/errors is not a valid route (404 or 405)", async function () {
        const res = await agent
            .get("/api/v1/client/errors")
            .set("Authorization", `Bearer ${adminToken()}`);
        expect([404, 405]).toContain(res.status);
    });
});
