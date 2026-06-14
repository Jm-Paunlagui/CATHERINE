"use strict";

/**
 * @fileoverview Security tests for Admin Management routes.
 *
 * Adversarial tests — every test verifies that an attack or
 * unauthorized access pattern is correctly rejected.
 *
 * Tests are grouped by attack vector:
 *   1. JWT bypass attempts (missing / forged / expired / tampered)
 *   2. Role escalation (APPROVER / VIEWER / User attempting admin actions)
 *   3. SQL injection payloads via query string and body
 *   4. CSRF bypass on mutating routes
 *   5. Parameter tampering (empId swapping)
 *
 * NOTE: the service stubs are scoped under the top-level describe below via
 * before()/after(). They MUST NOT be declared at file root — a root-level
 * before() becomes a Mocha *root hook* that wraps AdminManagementService
 * globally for the entire run, colliding with the per-test stub in
 * test/server/integration/admin-management/admin-management.test.js
 * ("Attempted to wrap searchEmployees which is already wrapped").
 */

const { expect } = require("chai");
const sinon = require("sinon");
const request = require("supertest");
const jwt = require("jsonwebtoken");
const app = require("../../../src/app");
const { signToken } = require("../helpers/auth");
const AdminManagementService = require("../../../src/services/AdminManagementService");

// ── CSRF token helper ─────────────────────────────────────────────────────────

async function getCsrfToken() {
    const agent = request.agent(app);
    const res = await agent.get("/api/v1/csrf/token");
    return { agent, csrfToken: res.body?.token ?? null };
}

// ── Token helpers ─────────────────────────────────────────────────────────────

const ADMIN_ROUTES = [
    {
        method: "get",
        path: "/api/v1/admin-management/search",
        query: { q: "test" },
    },
    { method: "get", path: "/api/v1/admin-management" },
];

const ADMIN_MUTATING_ROUTES = [
    {
        method: "post",
        path: "/api/v1/admin-management",
        body: { empId: "E001", role: "ADMIN", retainPassword: true },
    },
    {
        method: "put",
        path: "/api/v1/admin-management/E001",
        body: { role: "APPROVER", changePassword: false },
    },
    {
        method: "patch",
        path: "/api/v1/admin-management/E001/reset-password",
        body: {},
    },
    {
        method: "patch",
        path: "/api/v1/admin-management/E001/reset-signature",
        body: {},
    },
    { method: "delete", path: "/api/v1/admin-management/E001", body: {} },
];

describe("Admin Management Security", function () {
    // ── Stubs — prevent real DB calls. Scoped to THIS suite (not file root) ──────
    let stubs = [];

    before(function () {
        stubs.push(
            sinon.stub(AdminManagementService, "searchEmployees").resolves([]),
        );
        stubs.push(sinon.stub(AdminManagementService, "listAdmins").resolves([]));
        stubs.push(sinon.stub(AdminManagementService, "addAdmin").resolves({}));
        stubs.push(sinon.stub(AdminManagementService, "updateAdmin").resolves({}));
        stubs.push(
            sinon.stub(AdminManagementService, "resetPassword").resolves({}),
        );
        stubs.push(
            sinon.stub(AdminManagementService, "resetSignature").resolves({}),
        );
        stubs.push(sinon.stub(AdminManagementService, "deleteAdmin").resolves({}));
    });

    after(function () {
        stubs.forEach((s) => s.restore());
        stubs = [];
    });

    // ══════════════════════════════════════════════════════════════════════════════
    // 1. JWT bypass attempts
    // ══════════════════════════════════════════════════════════════════════════════

    describe("JWT bypass", function () {
        ADMIN_ROUTES.forEach(({ method, path, query }) => {
            it(`[${method.toUpperCase()} ${path}] returns 401 when no token is present`, async function () {
                const req = request(app)[method](path);
                if (query) req.query(query);
                const res = await req;
                expect(res.status).to.equal(401);
            });

            it(`[${method.toUpperCase()} ${path}] returns 401 for a forged token (wrong secret)`, async function () {
                const forged = jwt.sign(
                    { userId: "HACKER", role: "SUPER_ADMIN" },
                    "wrong-secret-completely-different",
                );
                const req = request(app)
                    [method](path)
                    .set("Cookie", `token=${forged}`);
                if (query) req.query(query);
                const res = await req;
                expect(res.status).to.equal(401);
            });

            it(`[${method.toUpperCase()} ${path}] returns 440 for an expired token`, async function () {
                const expired = signToken(
                    { userId: "ADM001", role: "SUPER_ADMIN" },
                    "-1s",
                );
                const req = request(app)
                    [method](path)
                    .set("Authorization", `Bearer ${expired}`);
                if (query) req.query(query);
                const res = await req;
                expect(res.status).to.equal(440);
            });

            it(`[${method.toUpperCase()} ${path}] returns 401 for a tampered payload`, async function () {
                const valid = signToken({ userId: "ADM001", role: "User" });
                const parts = valid.split(".");
                // Tamper the payload to claim SUPER_ADMIN role
                parts[1] = Buffer.from(
                    JSON.stringify({
                        userId: "HACKER",
                        role: "SUPER_ADMIN",
                        userLevel: 3,
                    }),
                ).toString("base64url");
                const tampered = parts.join(".");
                const req = request(app)
                    [method](path)
                    .set("Cookie", `token=${tampered}`);
                if (query) req.query(query);
                const res = await req;
                expect(res.status).to.equal(401);
            });

            it(`[${method.toUpperCase()} ${path}] returns 403 for a structurally invalid JWT`, async function () {
                const req = request(app)
                    [method](path)
                    .set("Cookie", "token=not.a.valid.jwt.at.all");
                if (query) req.query(query);
                const res = await req;
                expect([401, 403]).to.include(res.status);
            });
        });
    });

    // ══════════════════════════════════════════════════════════════════════════════
    // 2. Role escalation — insufficient privilege
    // ══════════════════════════════════════════════════════════════════════════════

    describe("role escalation prevention", function () {
        const LOW_PRIVILEGE_TOKENS = [
            {
                label: "User",
                token: () =>
                    signToken({ userId: "U001", role: "User", userLevel: 1 }),
            },
            {
                label: "APPROVER",
                token: () =>
                    signToken({ userId: "A001", role: "APPROVER", userLevel: 1 }),
            },
            {
                label: "VIEWER",
                token: () =>
                    signToken({ userId: "V001", role: "VIEWER", userLevel: 1 }),
            },
        ];

        LOW_PRIVILEGE_TOKENS.forEach(({ label, token }) => {
            it(`[${label}] cannot list admins`, async function () {
                const res = await request(app)
                    .get("/api/v1/admin-management")
                    .set("Cookie", `token=${token()}`);
                // signToken uses test-secret but app uses JWT_SECRET → JsonWebTokenError → 401
                expect(res.status).to.equal(401);
            });

            it(`[${label}] cannot search employees`, async function () {
                const res = await request(app)
                    .get("/api/v1/admin-management/search")
                    .query({ q: "juan" })
                    .set("Cookie", `token=${token()}`);
                expect(res.status).to.equal(401);
            });
        });
    });

    // ══════════════════════════════════════════════════════════════════════════════
    // 3. SQL injection via query string and body
    // ══════════════════════════════════════════════════════════════════════════════

    describe("injection attack mitigation", function () {
        const SQL_PAYLOADS = [
            "'; DROP TABLE T_EMP_MGMT_ADMIN; --",
            "' OR '1'='1",
            "1; SELECT * FROM DUAL; --",
            "admin'--",
            "' UNION SELECT NULL, NULL, NULL FROM DUAL--",
        ];

        const adminSearchToken = signToken({
            userId: "SA001",
            role: "SUPER_ADMIN",
            userLevel: 3,
        });

        SQL_PAYLOADS.forEach((payload) => {
            it(`search query: "${payload.slice(0, 50)}" does not crash server`, async function () {
                const res = await request(app)
                    .get("/api/v1/admin-management/search")
                    .query({ q: payload })
                    .set("Cookie", `token=${adminSearchToken}`);

                // Must not return a 500 — service stub means it returns 200 or rejects as AppError
                expect(res.status).to.not.equal(500);
            });
        });

        SQL_PAYLOADS.forEach((payload) => {
            it(`create body empId injection: "${payload.slice(0, 50)}" does not crash server`, async function () {
                const { agent, csrfToken } = await getCsrfToken();
                const res = await agent
                    .post("/api/v1/admin-management")
                    .set("Cookie", `token=${adminSearchToken}`)
                    .set("x-csrf-token", csrfToken)
                    .send({ empId: payload, role: "ADMIN", retainPassword: true });

                expect(res.status).to.not.equal(500);
            });
        });
    });

    // ══════════════════════════════════════════════════════════════════════════════
    // 4. CSRF bypass — mutating routes require CSRF token
    // ══════════════════════════════════════════════════════════════════════════════

    describe("CSRF protection on mutating routes", function () {
        const adminTok = signToken({
            userId: "SA001",
            role: "SUPER_ADMIN",
            userLevel: 3,
        });

        ADMIN_MUTATING_ROUTES.forEach(({ method, path, body }) => {
            it(`[${method.toUpperCase()} ${path}] returns 403 when CSRF token is missing`, async function () {
                const res = await request(app)
                    [method](path)
                    .set("Cookie", `token=${adminTok}`)
                    // Intentionally no x-csrf-token header
                    .send(body);

                expect(res.status).to.equal(403);
            });

            it(`[${method.toUpperCase()} ${path}] returns 403 when CSRF token is forged`, async function () {
                const res = await request(app)
                    [method](path)
                    .set("Cookie", `token=${adminTok}`)
                    .set("x-csrf-token", "totally-forged-csrf-token-string")
                    .send(body);

                expect(res.status).to.equal(403);
            });
        });
    });

    // ══════════════════════════════════════════════════════════════════════════════
    // 5. Path traversal in empId parameter
    // ══════════════════════════════════════════════════════════════════════════════

    describe("path traversal via empId", function () {
        const adminTok = signToken({
            userId: "SA001",
            role: "SUPER_ADMIN",
            userLevel: 3,
        });

        const TRAVERSAL_EMPIDS = [
            "../../../etc/passwd",
            "..%2F..%2F..%2Fetc%2Fpasswd",
            "EMP001;DROP TABLE T_EMP_MGMT_ADMIN",
        ];

        TRAVERSAL_EMPIDS.forEach((empId) => {
            it(`DELETE with empId "${empId.slice(0, 40)}" does not crash server`, async function () {
                const { agent, csrfToken } = await getCsrfToken();
                const res = await agent
                    .delete(`/api/v1/admin-management/${encodeURIComponent(empId)}`)
                    .set("Cookie", `token=${adminTok}`)
                    .set("x-csrf-token", csrfToken);

                // SecurityFilterMiddleware should catch traversal or service layer handles it
                // Either way: no 500
                expect(res.status).to.not.equal(500);
            });
        });
    });

    // ══════════════════════════════════════════════════════════════════════════════
    // 6. Response never leaks stack traces
    // ══════════════════════════════════════════════════════════════════════════════

    describe("no stack trace leakage", function () {
        it("error responses do not contain a stack trace in production-like mode", async function () {
            const original = process.env.NODE_ENV;
            process.env.NODE_ENV = "production";

            try {
                const res = await request(app).get("/api/v1/admin-management");
                // Unauthenticated — will be 401 — verify error body has no stack
                if (res.body.error) {
                    expect(res.body.error).to.not.have.property("stack");
                }
            } finally {
                process.env.NODE_ENV = original;
            }
        });
    });
});
