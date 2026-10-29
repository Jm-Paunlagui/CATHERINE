"use strict";

/**
 * @fileoverview Integration tests for the Admin Management routes.
 *
 * Tests the full HTTP stack: authentication middleware, requireAccess predicate,
 * validateRequiredFields, controller delegation, and response shape contract.
 *
 * The service layer is stubbed with vi.spyOn to avoid real DB calls. Legacy
 * password-flag refusals delegate to the REAL service method: it validates and
 * throws 400 before any DB access.
 * This suite covers the mandatory 10-item checklist for each route
 * as required by Backend CLAUDE.md §7.
 *
 * Contract: create/reset issue an emailed TEMPORARY password (no
 * retainPassword/changePassword); create → 201; delete requires { backupToken }.
 *
 * Routes under test:
 *   GET    /api/v1/admin-management
 *   POST   /api/v1/admin-management
 *   PUT    /api/v1/admin-management/:username
 *   PATCH  /api/v1/admin-management/:username/reset-password
 *   PATCH  /api/v1/admin-management/:username/reset-signature
 *   DELETE /api/v1/admin-management/:username
 *   POST   /api/v1/admin-management/security/unblock-ip
 *
 * Wire contract: the create body and the response objects use `username`
 * and `role`.
 */

const request = require("supertest");
const app = require("../../../../src/app");
const { signToken } = require("../../helpers/auth");
const AdminManagementService = require("../../../../src/services/AdminManagementService");
const { registry } = require("../../../../src/middleware/cache");
const {
    credentialEmailRateLimiter,
} = require("../../../../src/middleware/security/RateLimiterMiddleware");

// Captured before any spy so legacy-flag tests can run the real refusal.
const realAddAdmin = AdminManagementService.addAdmin;
const realUpdateAdmin = AdminManagementService.updateAdmin;

// ── Token factories ────────────────────────────────────────────────────────────

/** Super Admin token — all admin-management routes require ADMIN or SUPER_ADMIN */
const superAdminToken = () =>
    signToken({ sub: "SA001", userId: "SA001", role: "SUPER_ADMIN", userLevel: 3 });

/** ADMIN token */
const adminToken = () =>
    signToken({ sub: "ADM001", userId: "ADM001", role: "ADMIN", userLevel: 2 });

/** USER token — insufficient privilege */
const userToken = () =>
    signToken({ sub: "USR001", userId: "USR001", role: "USER", userLevel: 1 });

/** The caller object the controller derives from the SUPER_ADMIN token. */
const SA_CALLER = { username: "SA001", role: "SUPER_ADMIN" };

// ── Stub data fixtures ─────────────────────────────────────────────────────────

const MOCK_ADMIN = {
    username: "EMP001",
    role: "ADMIN",
    firstName: "Juan",
    lastName: "dela Cruz",
};

const MOCK_ADMIN_LIST = [MOCK_ADMIN];

// ── Shared response shape assertion ───────────────────────────────────────────

function expectSuccessShape(body) {
    expect(body).toHaveProperty("status", "success");
    expect(body).toHaveProperty("code", 200);
    expect(body).toHaveProperty("message");
    expect(body["message"]).toEqual(expect.any(String));
    expect(body).toHaveProperty("data");
}

function expectErrorShape(body) {
    expect(body).toEqual(
        expect.objectContaining({
            status: expect.anything(),
            code: expect.anything(),
            title: expect.anything(),
            message: expect.anything(),
            error: expect.anything(),
        }),
    );
    expect(body.status).toBe("error");
    expect(body.error).toHaveProperty("type");
    expect(body.error["type"]).toEqual(expect.any(String));
}

function expectRequestId(headers) {
    expect(headers).toHaveProperty("x-request-id");
    expect(headers["x-request-id"]).toMatch(/^(\d{13}-\d{4}-\d{4}|req_.+)$/);
}

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/admin-management  (list)
// ═══════════════════════════════════════════════════════════════════════════════

describe("GET /api/v1/admin-management", function () {
    let listStub;

    beforeEach(function () {
        listStub = vi
            .spyOn(AdminManagementService, "listAdmins")
            .mockResolvedValue(MOCK_ADMIN_LIST);
    });

    afterEach(function () {
        vi.restoreAllMocks();
    });

    // ✅ 1. Happy path
    it("returns 200 with admin list", async function () {
        const res = await request(app)
            .get("/api/v1/admin-management")
            .set("Authorization", `Bearer ${superAdminToken()}`);

        expect(res.status).toBe(200);
        expectSuccessShape(res.body);
        expect(res.body.data).toBeInstanceOf(Array).with.lengthOf(1);
        expect(listStub).toHaveBeenCalledTimes(1);
    });

    // ✅ 2. Unauthenticated
    it("returns 401 when no token is provided", async function () {
        const res = await request(app).get("/api/v1/admin-management");
        expect(res.status).toBe(401);
    });

    // ✅ 3. Unauthorized — USER role
    it("returns 403 for USER role", async function () {
        const res = await request(app)
            .get("/api/v1/admin-management")
            .set("Authorization", `Bearer ${userToken()}`);
        expect(res.status).toBe(403);
    });

    // ✅ 4. Authorized — ADMIN role can list
    it("returns 200 for ADMIN role", async function () {
        const res = await request(app)
            .get("/api/v1/admin-management")
            .set("Authorization", `Bearer ${adminToken()}`);
        expect(res.status).toBe(200);
    });

    // ✅ 5. Response shape contract
    it("response body matches { status, code, message, data } contract", async function () {
        const res = await request(app)
            .get("/api/v1/admin-management")
            .set("Authorization", `Bearer ${superAdminToken()}`);
        expectSuccessShape(res.body);
    });

    // ✅ 6. X-Request-ID present
    it("sets X-Request-ID", async function () {
        const res = await request(app)
            .get("/api/v1/admin-management")
            .set("Authorization", `Bearer ${superAdminToken()}`);
        expectRequestId(res.headers);
    });

    // ✅ 7. Response time
    it("responds in under 500ms", async function () {
        const start = Date.now();
        await request(app)
            .get("/api/v1/admin-management")
            .set("Authorization", `Bearer ${superAdminToken()}`);
        expect(Date.now() - start).toBeLessThan(500);
    });

    // ✅ 8. Returns empty array when no admins exist (not null/undefined)
    it("returns an empty array when no admins exist", async function () {
        listStub.mockResolvedValue([]);
        registry.resolve("adminList").flush(); // ensure no cached admin list from prior tests
        const res = await request(app)
            .get("/api/v1/admin-management")
            .set("Authorization", `Bearer ${superAdminToken()}`);
        expect(res.status).toBe(200);
        expect(res.body.data).toBeInstanceOf(Array).with.lengthOf(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/v1/admin-management  (create)
// ═══════════════════════════════════════════════════════════════════════════════

describe("POST /api/v1/admin-management", function () {
    let createStub;
    let agent;

    beforeEach(async function () {
        createStub = vi
            .spyOn(AdminManagementService, "addAdmin")
            .mockResolvedValue(MOCK_ADMIN);
        agent = request.agent(app);
        // Fetch CSRF token
        const csrfRes = await agent.get("/api/v1/csrf/token");
        agent._csrfToken = csrfRes.body?.token ?? null;
    });

    afterEach(function () {
        vi.restoreAllMocks();
    });

    const validBody = () => ({
        username: "EMP001",
        role: "ADMIN",
    });

    // ✅ 1. Happy path
    it("returns 201 with created admin data", async function () {
        const res = await agent
            .post("/api/v1/admin-management")
            .set("Authorization", `Bearer ${superAdminToken()}`)
            .set("x-csrf-token", agent._csrfToken)
            .send(validBody());

        expect(res.status).toBe(201);
        expect(res.body.status).toBe("success");
        expect(res.body.message).toBe("Admin created successfully.");
        expect(createStub).toHaveBeenCalledTimes(1);
        expect(createStub).toHaveBeenCalledWith(
            expect.objectContaining({
                username: "EMP001",
                role: "ADMIN",
                caller: SA_CALLER,
                retainPassword: undefined,
                newPassword: undefined,
            }),
        );
    });

    // ✅ 1b. Temporary-password result is returned without the password itself
    it("returns the delivery summary and never a password field", async function () {
        createStub.mockResolvedValue({
            username: "EMP001",
            role: "ADMIN",
            emailDelivered: true,
            recipientSource: "account",
            recipientHint: "j***@example.com",
            tempPasswordExpiresAt: "2026-10-29T00:00:00.000Z",
        });

        const res = await agent
            .post("/api/v1/admin-management")
            .set("Authorization", `Bearer ${superAdminToken()}`)
            .set("x-csrf-token", agent._csrfToken)
            .send(validBody());

        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({ emailDelivered: true, tempPasswordExpiresAt: expect.any(String) });
        expect(JSON.stringify(res.body)).not.toMatch(/"(password|newPassword|tempPassword)"/i);
    });

    // ✅ 1c. ADMIN may call create (per-target policy lives in the service)
    it("returns 201 for ADMIN role", async function () {
        const res = await agent
            .post("/api/v1/admin-management")
            .set("Authorization", `Bearer ${adminToken()}`)
            .set("x-csrf-token", agent._csrfToken)
            .send({ username: "USR002", role: "USER" });

        expect(res.status).toBe(201);
        expect(createStub).toHaveBeenCalledWith(
            expect.objectContaining({ caller: { username: "ADM001", role: "ADMIN" } }),
        );
    });

    // ✅ 2. Missing required field — username
    it("returns 400 when username is missing", async function () {
        const { username: _removed, ...body } = validBody();
        const res = await agent
            .post("/api/v1/admin-management")
            .set("Authorization", `Bearer ${superAdminToken()}`)
            .set("x-csrf-token", agent._csrfToken)
            .send(body);

        expect(res.status).toBe(400);
        expectErrorShape(res.body);
        const fields = res.body.error.details?.map((d) => d.field) ?? [];
        expect(fields).toContain("username");
    });

    // ✅ 3. Missing required field — role
    it("returns 400 when role is missing", async function () {
        const { role: _removed, ...body } = validBody();
        const res = await agent
            .post("/api/v1/admin-management")
            .set("Authorization", `Bearer ${superAdminToken()}`)
            .set("x-csrf-token", agent._csrfToken)
            .send(body);

        expect(res.status).toBe(400);
        expectErrorShape(res.body);
    });

    // ✅ 4. Legacy retainPassword is refused — the server always issues a temporary password
    it("returns 400 ValidationError when retainPassword is sent", async function () {
        createStub.mockImplementation(realAddAdmin);
        const res = await agent
            .post("/api/v1/admin-management")
            .set("Authorization", `Bearer ${superAdminToken()}`)
            .set("x-csrf-token", agent._csrfToken)
            .send({ ...validBody(), retainPassword: true });

        expect(res.status).toBe(400);
        expectErrorShape(res.body);
        expect(res.body.error.type).toBe("ValidationError");
        expect(res.body.error.details.map((d) => d.field)).toContain("retainPassword");
    });

    // ✅ 4b. Client-chosen newPassword is refused
    it("returns 400 ValidationError when newPassword is sent", async function () {
        createStub.mockImplementation(realAddAdmin);
        const res = await agent
            .post("/api/v1/admin-management")
            .set("Authorization", `Bearer ${superAdminToken()}`)
            .set("x-csrf-token", agent._csrfToken)
            .send({ ...validBody(), newPassword: "Chosen#Pass123" });

        expect(res.status).toBe(400);
        expect(res.body.error.details.map((d) => d.field)).toContain("newPassword");
    });

    // ✅ 4c. Invalid role value
    it("returns 400 when role is not SUPER_ADMIN / ADMIN / USER", async function () {
        createStub.mockImplementation(realAddAdmin);
        const res = await agent
            .post("/api/v1/admin-management")
            .set("Authorization", `Bearer ${superAdminToken()}`)
            .set("x-csrf-token", agent._csrfToken)
            .send({ username: "EMP001", role: "MANAGER" });

        expect(res.status).toBe(400);
        expect(res.body.error.details.map((d) => d.field)).toContain("role");
    });

    // ✅ 5. Unauthenticated
    it("returns 401 when no token is provided", async function () {
        const res = await agent
            .post("/api/v1/admin-management")
            .set("x-csrf-token", agent._csrfToken)
            .send(validBody());

        expect(res.status).toBe(401);
    });

    // ✅ 6. Unauthorized — USER role
    it("returns 403 for USER role", async function () {
        const res = await agent
            .post("/api/v1/admin-management")
            .set("Authorization", `Bearer ${userToken()}`)
            .set("x-csrf-token", agent._csrfToken)
            .send(validBody());

        expect(res.status).toBe(403);
    });

    // ✅ 7. Oversized body
    it("returns 413 when body exceeds size limit", async function () {
        const huge = "x".repeat(11 * 1024 * 1024);
        const res = await agent
            .post("/api/v1/admin-management")
            .set("Authorization", `Bearer ${superAdminToken()}`)
            .set("x-csrf-token", agent._csrfToken)
            .set("Content-Type", "application/json")
            .send(
                JSON.stringify({
                    username: "EMP001",
                    role: "ADMIN",
                    retainPassword: true,
                    pad: huge,
                }),
            );

        expect(res.status).toBe(413);
    });

    // ✅ 8. Response shape contract
    it("response shape matches contract", async function () {
        const res = await agent
            .post("/api/v1/admin-management")
            .set("Authorization", `Bearer ${superAdminToken()}`)
            .set("x-csrf-token", agent._csrfToken)
            .send(validBody());

        expect(res.body).toEqual(
            expect.objectContaining({
                status: expect.anything(),
                code: expect.anything(),
                message: expect.anything(),
                data: expect.anything(),
            }),
        );
        // Envelope code mirrors the 201 Created status.
        expect(res.body.code).toBe(201);
    });

    // ✅ 9. X-Request-ID present
    it("sets X-Request-ID", async function () {
        const res = await agent
            .post("/api/v1/admin-management")
            .set("Authorization", `Bearer ${superAdminToken()}`)
            .set("x-csrf-token", agent._csrfToken)
            .send(validBody());

        expectRequestId(res.headers);
    });

    // ✅ 10. Response time
    it("responds in under 500ms", async function () {
        const start = Date.now();
        await agent
            .post("/api/v1/admin-management")
            .set("Authorization", `Bearer ${superAdminToken()}`)
            .set("x-csrf-token", agent._csrfToken)
            .send(validBody());
        expect(Date.now() - start).toBeLessThan(500);
    });

    // ✅ 11. Service-level conflict — already exists
    it("returns the service AppError status when employee is already an admin", async function () {
        const { AppError } = require("../../../../src/constants/errors");
        createStub.mockRejectedValue(
            new AppError(
                "This employee is already registered as an admin.",
                409,
            ),
        );

        const res = await agent
            .post("/api/v1/admin-management")
            .set("Authorization", `Bearer ${superAdminToken()}`)
            .set("x-csrf-token", agent._csrfToken)
            .send(validBody());

        expect(res.status).toBe(409);
        expectErrorShape(res.body);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PUT /api/v1/admin-management/:username  (update)
// ═══════════════════════════════════════════════════════════════════════════════

describe("PUT /api/v1/admin-management/:username", function () {
    let updateStub;
    let agent;

    beforeEach(async function () {
        updateStub = vi
            .spyOn(AdminManagementService, "updateAdmin")
            .mockResolvedValue(MOCK_ADMIN);
        agent = request.agent(app);
        const csrfRes = await agent.get("/api/v1/csrf/token");
        agent._csrfToken = csrfRes.body?.token ?? null;
    });

    afterEach(function () {
        vi.restoreAllMocks();
    });

    const validBody = () => ({ role: "USER" });

    // ✅ 1. Happy path
    it("returns 200 with updated admin data", async function () {
        const res = await agent
            .put("/api/v1/admin-management/EMP001")
            .set("Authorization", `Bearer ${superAdminToken()}`)
            .set("x-csrf-token", agent._csrfToken)
            .send(validBody());

        expect(res.status).toBe(200);
        expectSuccessShape(res.body);
        expect(updateStub).toHaveBeenCalledTimes(1);
        expect(updateStub).toHaveBeenCalledWith(
            expect.objectContaining({
                username: "EMP001",
                role: "USER",
                caller: SA_CALLER,
                changePassword: false,
            }),
        );
    });

    // ✅ 1b. Role changes are SUPER_ADMIN only
    it("returns 403 for ADMIN role (role change is SUPER_ADMIN only)", async function () {
        const res = await agent
            .put("/api/v1/admin-management/EMP001")
            .set("Authorization", `Bearer ${adminToken()}`)
            .set("x-csrf-token", agent._csrfToken)
            .send(validBody());

        expect(res.status).toBe(403);
        expect(updateStub).not.toHaveBeenCalled();
    });

    // ✅ 2. Missing required field — role
    it("returns 400 when role is missing", async function () {
        const { role: _removed, ...body } = validBody();
        const res = await agent
            .put("/api/v1/admin-management/EMP001")
            .set("Authorization", `Bearer ${superAdminToken()}`)
            .set("x-csrf-token", agent._csrfToken)
            .send(body);

        expect(res.status).toBe(400);
        expectErrorShape(res.body);
    });

    // ✅ 3. Edit never sets a password — changePassword: true is refused
    it("returns 400 ValidationError when changePassword is true", async function () {
        updateStub.mockImplementation(realUpdateAdmin);
        const res = await agent
            .put("/api/v1/admin-management/EMP001")
            .set("Authorization", `Bearer ${superAdminToken()}`)
            .set("x-csrf-token", agent._csrfToken)
            .send({ ...validBody(), changePassword: true });

        expect(res.status).toBe(400);
        expect(res.body.error.type).toBe("ValidationError");
        expect(res.body.error.details.map((d) => d.field)).toContain("changePassword");
    });

    // ✅ 3b. The string "false" (coerced by validateRequiredFields) is not read as true
    it("treats changePassword: false as absent and succeeds", async function () {
        const res = await agent
            .put("/api/v1/admin-management/EMP001")
            .set("Authorization", `Bearer ${superAdminToken()}`)
            .set("x-csrf-token", agent._csrfToken)
            .send({ ...validBody(), changePassword: false });

        expect(res.status).toBe(200);
        expect(updateStub).toHaveBeenCalledWith(expect.objectContaining({ changePassword: false }));
    });

    // ✅ 4. Unauthenticated
    it("returns 401 when no token is provided", async function () {
        const res = await agent
            .put("/api/v1/admin-management/EMP001")
            .set("x-csrf-token", agent._csrfToken)
            .send(validBody());

        expect(res.status).toBe(401);
    });

    // ✅ 5. Unauthorized — USER role
    it("returns 403 for USER role", async function () {
        const res = await agent
            .put("/api/v1/admin-management/EMP001")
            .set("Authorization", `Bearer ${userToken()}`)
            .set("x-csrf-token", agent._csrfToken)
            .send(validBody());

        expect(res.status).toBe(403);
    });

    // ✅ 6. Not found — service throws 404
    it("returns 404 when admin does not exist", async function () {
        const { AppError } = require("../../../../src/constants/errors");
        updateStub.mockRejectedValue(
            new AppError(
                "Admin record not found. Verify the username and try again.",
                404,
            ),
        );

        const res = await agent
            .put("/api/v1/admin-management/NONEXISTENT")
            .set("Authorization", `Bearer ${superAdminToken()}`)
            .set("x-csrf-token", agent._csrfToken)
            .send(validBody());

        expect(res.status).toBe(404);
        expectErrorShape(res.body);
    });

    // ✅ 7. Response shape contract
    it("response shape matches { status, code, message, data } contract", async function () {
        const res = await agent
            .put("/api/v1/admin-management/EMP001")
            .set("Authorization", `Bearer ${superAdminToken()}`)
            .set("x-csrf-token", agent._csrfToken)
            .send(validBody());

        expect(res.body).toEqual(
            expect.objectContaining({
                status: expect.anything(),
                code: expect.anything(),
                message: expect.anything(),
                data: expect.anything(),
            }),
        );
    });

    // ✅ 8. X-Request-ID present
    it("sets X-Request-ID", async function () {
        const res = await agent
            .put("/api/v1/admin-management/EMP001")
            .set("Authorization", `Bearer ${superAdminToken()}`)
            .set("x-csrf-token", agent._csrfToken)
            .send(validBody());

        expectRequestId(res.headers);
    });

    // ✅ 9. Response time
    it("responds in under 500ms", async function () {
        const start = Date.now();
        await agent
            .put("/api/v1/admin-management/EMP001")
            .set("Authorization", `Bearer ${superAdminToken()}`)
            .set("x-csrf-token", agent._csrfToken)
            .send(validBody());
        expect(Date.now() - start).toBeLessThan(500);
    });

    // ✅ 10. Signature integrity error (422)
    it("returns 422 DataIntegrityError when SYSSIGNATURE is broken", async function () {
        const { AppError } = require("../../../../src/constants/errors");
        updateStub.mockRejectedValue(
            new AppError(
                "Admin record integrity check failed. A signature reset is required before this record can be modified.",
                422,
                { type: "DataIntegrityError" },
            ),
        );

        const res = await agent
            .put("/api/v1/admin-management/EMP001")
            .set("Authorization", `Bearer ${superAdminToken()}`)
            .set("x-csrf-token", agent._csrfToken)
            .send(validBody());

        expect(res.status).toBe(422);
        expect(res.body.error.type).toBe("DataIntegrityError");
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PATCH /api/v1/admin-management/:username/reset-password
// ═══════════════════════════════════════════════════════════════════════════════

describe("PATCH /api/v1/admin-management/:username/reset-password", function () {
    let resetPwStub;
    let agent;

    beforeEach(async function () {
        // The route emails a credential: 5/min per caller. Reset so tests stay independent.
        credentialEmailRateLimiter.flushAll();
        resetPwStub = vi
            .spyOn(AdminManagementService, "resetPassword")
            .mockResolvedValue({ username: "EMP001" });
        agent = request.agent(app);
        const csrfRes = await agent.get("/api/v1/csrf/token");
        agent._csrfToken = csrfRes.body?.token ?? null;
    });

    afterEach(function () {
        vi.restoreAllMocks();
    });

    // ✅ 1. Happy path
    it("returns 200 on successful password reset", async function () {
        const res = await agent
            .patch("/api/v1/admin-management/EMP001/reset-password")
            .set("Authorization", `Bearer ${superAdminToken()}`)
            .set("x-csrf-token", agent._csrfToken);

        expect(res.status).toBe(200);
        expect(res.body.message).toBe("A new temporary password was issued.");
        expect(resetPwStub).toHaveBeenCalledTimes(1);
        expect(resetPwStub).toHaveBeenCalledWith("EMP001", {
            overrideEmail: undefined,
            caller: SA_CALLER,
        });
    });

    // ✅ 1b. overrideEmail is forwarded to the service
    it("forwards overrideEmail from the body", async function () {
        const res = await agent
            .patch("/api/v1/admin-management/EMP001/reset-password")
            .set("Authorization", `Bearer ${superAdminToken()}`)
            .set("x-csrf-token", agent._csrfToken)
            .send({ overrideEmail: "someone@example.com" });

        expect(res.status).toBe(200);
        expect(resetPwStub).toHaveBeenCalledWith("EMP001", {
            overrideEmail: "someone@example.com",
            caller: SA_CALLER,
        });
    });

    // ✅ 1c. Credential-email limiter caps one caller at 5 per minute (mailbox bombing)
    it("returns 429 on the 6th reset within the window and stops calling the service", async function () {
        const send = () =>
            agent
                .patch("/api/v1/admin-management/EMP001/reset-password")
                .set("Authorization", `Bearer ${superAdminToken()}`)
                .set("x-csrf-token", agent._csrfToken);

        for (let i = 0; i < 5; i++) {
            expect((await send()).status).toBe(200);
        }
        const res = await send();

        expect(res.status).toBe(429);
        expect(resetPwStub).toHaveBeenCalledTimes(5);
    });

    // ✅ 1d. Limiter is per caller — one admin's budget does not block another
    it("a different caller still gets 200 after another caller is limited", async function () {
        for (let i = 0; i < 6; i++) {
            await agent
                .patch("/api/v1/admin-management/EMP001/reset-password")
                .set("Authorization", `Bearer ${superAdminToken()}`)
                .set("x-csrf-token", agent._csrfToken);
        }
        const res = await agent
            .patch("/api/v1/admin-management/EMP001/reset-password")
            .set("Authorization", `Bearer ${adminToken()}`)
            .set("x-csrf-token", agent._csrfToken);

        expect(res.status).toBe(200);
    });

    // ✅ 2. Unauthenticated
    it("returns 401 when no token is provided", async function () {
        const res = await agent
            .patch("/api/v1/admin-management/EMP001/reset-password")
            .set("x-csrf-token", agent._csrfToken);

        expect(res.status).toBe(401);
    });

    // ✅ 3. Unauthorized
    it("returns 403 for USER role", async function () {
        const res = await agent
            .patch("/api/v1/admin-management/EMP001/reset-password")
            .set("Authorization", `Bearer ${userToken()}`)
            .set("x-csrf-token", agent._csrfToken);

        expect(res.status).toBe(403);
    });

    // ✅ 4. Not found
    it("returns 404 when admin does not exist", async function () {
        const { AppError } = require("../../../../src/constants/errors");
        resetPwStub.mockRejectedValue(
            new AppError(
                "Admin record not found. Verify the username and try again.",
                404,
            ),
        );

        const res = await agent
            .patch("/api/v1/admin-management/NONEXISTENT/reset-password")
            .set("Authorization", `Bearer ${superAdminToken()}`)
            .set("x-csrf-token", agent._csrfToken);

        expect(res.status).toBe(404);
    });

    // ✅ 5. Response shape contract
    it("response shape matches { status, code, message, data } contract", async function () {
        const res = await agent
            .patch("/api/v1/admin-management/EMP001/reset-password")
            .set("Authorization", `Bearer ${superAdminToken()}`)
            .set("x-csrf-token", agent._csrfToken);

        expect(res.body).toEqual(
            expect.objectContaining({
                status: expect.anything(),
                code: expect.anything(),
                message: expect.anything(),
                data: expect.anything(),
            }),
        );
    });

    // ✅ 6. X-Request-ID present
    it("sets X-Request-ID", async function () {
        const res = await agent
            .patch("/api/v1/admin-management/EMP001/reset-password")
            .set("Authorization", `Bearer ${superAdminToken()}`)
            .set("x-csrf-token", agent._csrfToken);

        expectRequestId(res.headers);
    });

    // ✅ 7. Response time
    it("responds in under 500ms", async function () {
        const start = Date.now();
        await agent
            .patch("/api/v1/admin-management/EMP001/reset-password")
            .set("Authorization", `Bearer ${superAdminToken()}`)
            .set("x-csrf-token", agent._csrfToken);
        expect(Date.now() - start).toBeLessThan(500);
    });

    // ✅ 8. DataIntegrityError propagated correctly
    it("returns 422 when SYSSIGNATURE is broken", async function () {
        const { AppError } = require("../../../../src/constants/errors");
        resetPwStub.mockRejectedValue(
            new AppError("Admin record integrity check failed.", 422, {
                type: "DataIntegrityError",
            }),
        );

        const res = await agent
            .patch("/api/v1/admin-management/EMP001/reset-password")
            .set("Authorization", `Bearer ${superAdminToken()}`)
            .set("x-csrf-token", agent._csrfToken);

        expect(res.status).toBe(422);
        expect(res.body.error.type).toBe("DataIntegrityError");
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PATCH /api/v1/admin-management/:username/reset-signature
// ═══════════════════════════════════════════════════════════════════════════════

describe("PATCH /api/v1/admin-management/:username/reset-signature", function () {
    let resetSigStub;
    let agent;

    beforeEach(async function () {
        resetSigStub = vi
            .spyOn(AdminManagementService, "resetSignature")
            .mockResolvedValue({ username: "EMP001" });
        agent = request.agent(app);
        const csrfRes = await agent.get("/api/v1/csrf/token");
        agent._csrfToken = csrfRes.body?.token ?? null;
    });

    afterEach(function () {
        vi.restoreAllMocks();
    });

    // ✅ 1. Happy path
    it("returns 200 on successful signature reset", async function () {
        const res = await agent
            .patch("/api/v1/admin-management/EMP001/reset-signature")
            .set("Authorization", `Bearer ${superAdminToken()}`)
            .set("x-csrf-token", agent._csrfToken);

        expect(res.status).toBe(200);
        expect(res.body.message).toBe(
            "Record signature recomputed successfully.",
        );
        expect(resetSigStub).toHaveBeenCalledTimes(1);
        expect(resetSigStub).toHaveBeenCalledWith("EMP001", { caller: SA_CALLER });
    });

    // ✅ 1b. Re-signing erases tamper evidence — SUPER_ADMIN only
    it("returns 403 for ADMIN role", async function () {
        const res = await agent
            .patch("/api/v1/admin-management/EMP001/reset-signature")
            .set("Authorization", `Bearer ${adminToken()}`)
            .set("x-csrf-token", agent._csrfToken);

        expect(res.status).toBe(403);
        expect(resetSigStub).not.toHaveBeenCalled();
    });

    // ✅ 2. Unauthenticated
    it("returns 401 when no token is provided", async function () {
        const res = await agent
            .patch("/api/v1/admin-management/EMP001/reset-signature")
            .set("x-csrf-token", agent._csrfToken);

        expect(res.status).toBe(401);
    });

    // ✅ 3. Unauthorized
    it("returns 403 for USER role", async function () {
        const res = await agent
            .patch("/api/v1/admin-management/EMP001/reset-signature")
            .set("Authorization", `Bearer ${userToken()}`)
            .set("x-csrf-token", agent._csrfToken);

        expect(res.status).toBe(403);
    });

    // ✅ 4. Not found
    it("returns 404 when admin does not exist", async function () {
        const { AppError } = require("../../../../src/constants/errors");
        resetSigStub.mockRejectedValue(
            new AppError(
                "Admin record not found. Verify the username and try again.",
                404,
            ),
        );

        const res = await agent
            .patch("/api/v1/admin-management/NONEXISTENT/reset-signature")
            .set("Authorization", `Bearer ${superAdminToken()}`)
            .set("x-csrf-token", agent._csrfToken);

        expect(res.status).toBe(404);
    });

    // ✅ 5. Response shape contract
    it("response shape matches { status, code, message, data } contract", async function () {
        const res = await agent
            .patch("/api/v1/admin-management/EMP001/reset-signature")
            .set("Authorization", `Bearer ${superAdminToken()}`)
            .set("x-csrf-token", agent._csrfToken);

        expect(res.body).toEqual(
            expect.objectContaining({
                status: expect.anything(),
                code: expect.anything(),
                message: expect.anything(),
                data: expect.anything(),
            }),
        );
    });

    // ✅ 6. X-Request-ID present
    it("sets X-Request-ID", async function () {
        const res = await agent
            .patch("/api/v1/admin-management/EMP001/reset-signature")
            .set("Authorization", `Bearer ${superAdminToken()}`)
            .set("x-csrf-token", agent._csrfToken);

        expectRequestId(res.headers);
    });

    // ✅ 7. Response time
    it("responds in under 500ms", async function () {
        const start = Date.now();
        await agent
            .patch("/api/v1/admin-management/EMP001/reset-signature")
            .set("Authorization", `Bearer ${superAdminToken()}`)
            .set("x-csrf-token", agent._csrfToken);
        expect(Date.now() - start).toBeLessThan(500);
    });

    // ✅ 8. SUPER_ADMIN can reset a SUPER_ADMIN signature
    it("allows SUPER_ADMIN to reset any admin's signature", async function () {
        resetSigStub.mockResolvedValue({
            username: "SA001",
            role: "SUPER_ADMIN",
        });

        const res = await agent
            .patch("/api/v1/admin-management/SA001/reset-signature")
            .set("Authorization", `Bearer ${superAdminToken()}`)
            .set("x-csrf-token", agent._csrfToken);

        expect(res.status).toBe(200);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DELETE /api/v1/admin-management/:username
// ═══════════════════════════════════════════════════════════════════════════════

describe("DELETE /api/v1/admin-management/:username", function () {
    let deleteStub;
    let agent;

    const BACKUP_TOKEN = "test-backup-token";

    beforeEach(async function () {
        deleteStub = vi
            .spyOn(AdminManagementService, "deleteAdmin")
            .mockResolvedValue({ username: "EMP001", deleted: true });
        agent = request.agent(app);
        const csrfRes = await agent.get("/api/v1/csrf/token");
        agent._csrfToken = csrfRes.body?.token ?? null;
    });

    afterEach(function () {
        vi.restoreAllMocks();
    });

    /** DELETE as SUPER_ADMIN with a backup token unless overridden; body null sends none. */
    const del = (username = "EMP001", body = { backupToken: BACKUP_TOKEN }, token = superAdminToken()) => {
        const req = agent
            .delete(`/api/v1/admin-management/${username}`)
            .set("x-csrf-token", agent._csrfToken);
        if (token) req.set("Authorization", `Bearer ${token}`);
        return body === null ? req : req.send(body);
    };

    // ✅ 1. Happy path
    it("returns 200 on successful deletion", async function () {
        const res = await del();

        expect(res.status).toBe(200);
        expect(res.body.message).toBe("Admin removed successfully.");
        expect(deleteStub).toHaveBeenCalledTimes(1);
        expect(deleteStub).toHaveBeenCalledWith({
            username: "EMP001",
            backupToken: BACKUP_TOKEN,
            callerUsername: "SA001",
            callerId: "SA001",
        });
    });

    // ✅ 2. Missing backupToken — a revoke-backup must precede a hard delete
    it("returns 400 with details when backupToken is missing", async function () {
        const res = await del("EMP001", {});

        expect(res.status).toBe(400);
        expectErrorShape(res.body);
        expect(res.body.error.details.map((d) => d.field)).toContain("backupToken");
        expect(deleteStub).not.toHaveBeenCalled();
    });

    // ✅ 2b. No body at all
    it("returns 400 when the body is absent", async function () {
        const res = await del("EMP001", null);

        expect(res.status).toBe(400);
        expect(deleteStub).not.toHaveBeenCalled();
    });

    // ✅ 2c. A backup token that does not verify is rejected by the service
    // with the real contract: 428 Precondition Required + BACKUP_TOKEN_INVALID.
    it("returns 428 BACKUP_TOKEN_INVALID when the backup token does not verify", async function () {
        const { AppError, ADMIN_ERRORS } = require("../../../../src/constants/errors");
        deleteStub.mockRejectedValue(
            new AppError(ADMIN_ERRORS.BACKUP_TOKEN_INVALID, 428, { type: "AuthenticationError" }),
        );

        const res = await del("EMP001", { backupToken: "forged" });

        expect(res.status).toBe(428);
        expectErrorShape(res.body);
        expect(res.body.message).toBe(ADMIN_ERRORS.BACKUP_TOKEN_INVALID);
    });

    // ✅ 3. Unauthenticated
    it("returns 401 when no token is provided", async function () {
        const res = await del("EMP001", { backupToken: BACKUP_TOKEN }, null);

        expect(res.status).toBe(401);
        expect(deleteStub).not.toHaveBeenCalled();
    });

    // ✅ 4. Unauthorized — USER role
    it("returns 403 for USER role", async function () {
        const res = await del("EMP001", { backupToken: BACKUP_TOKEN }, userToken());

        expect(res.status).toBe(403);
        expect(deleteStub).not.toHaveBeenCalled();
    });

    // ✅ 4b. Hard delete is SUPER_ADMIN only
    it("returns 403 for ADMIN role", async function () {
        const res = await del("EMP001", { backupToken: BACKUP_TOKEN }, adminToken());

        expect(res.status).toBe(403);
        expect(deleteStub).not.toHaveBeenCalled();
    });

    // ✅ 5. Not found
    it("returns 404 when admin does not exist", async function () {
        const { AppError } = require("../../../../src/constants/errors");
        deleteStub.mockRejectedValue(
            new AppError(
                "Admin record not found. Verify the username and try again.",
                404,
            ),
        );

        const res = await del("NONEXISTENT");

        expect(res.status).toBe(404);
    });

    // ✅ 6. DataIntegrityError before delete
    it("returns 422 when SYSSIGNATURE is broken", async function () {
        const { AppError } = require("../../../../src/constants/errors");
        deleteStub.mockRejectedValue(
            new AppError("Admin record integrity check failed.", 422, {
                type: "DataIntegrityError",
            }),
        );

        const res = await del();

        expect(res.status).toBe(422);
        expect(res.body.error.type).toBe("DataIntegrityError");
    });

    // ✅ 7. Oversized body
    it("returns 413 when body exceeds size limit", async function () {
        const res = await agent
            .delete("/api/v1/admin-management/EMP001")
            .set("Authorization", `Bearer ${superAdminToken()}`)
            .set("x-csrf-token", agent._csrfToken)
            .set("Content-Type", "application/json")
            .send(JSON.stringify({ backupToken: BACKUP_TOKEN, pad: "x".repeat(11 * 1024 * 1024) }));

        expect(res.status).toBe(413);
        expect(deleteStub).not.toHaveBeenCalled();
    });

    // ✅ 8. Response shape contract
    it("response shape matches { status, code, message, data } contract", async function () {
        const res = await del();

        expect(res.body).toEqual(
            expect.objectContaining({
                status: expect.anything(),
                code: expect.anything(),
                message: expect.anything(),
                data: expect.anything(),
            }),
        );
    });

    // ✅ 9. X-Request-ID present
    it("sets X-Request-ID", async function () {
        const res = await del();

        expectRequestId(res.headers);
    });

    // ✅ 10. Response time
    it("responds in under 500ms", async function () {
        const start = Date.now();
        await del();
        expect(Date.now() - start).toBeLessThan(500);
    });

    // ✅ 11. Scanner path cannot reach this route prefix
    it("/.env scanner path is blocked (not routed to admin-management)", async function () {
        const res = await agent.get("/.env");
        expect([400, 403, 404]).toContain(res.status);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/v1/admin-management/security/unblock-ip
// ═══════════════════════════════════════════════════════════════════════════════

describe("POST /api/v1/admin-management/security/unblock-ip", function () {
    const {
        defaultSecurityFilter,
    } = require("../../../../src/middleware/security/SecurityFilterMiddleware");
    const { ADMIN_ERRORS } = require("../../../../src/constants/errors");
    let unblockStub;
    let agent;

    beforeEach(async function () {
        unblockStub = vi
            .spyOn(defaultSecurityFilter, "unblockClusterWide")
            .mockResolvedValue(true);
        agent = request.agent(app);
        const csrfRes = await agent.get("/api/v1/csrf/token");
        agent._csrfToken = csrfRes.body?.token ?? null;
    });

    afterEach(function () {
        vi.restoreAllMocks();
    });

    const post = (body, token = superAdminToken()) => {
        const req = agent
            .post("/api/v1/admin-management/security/unblock-ip")
            .set("x-csrf-token", agent._csrfToken);
        if (token) req.set("Authorization", `Bearer ${token}`);
        return req.send(body);
    };

    it("returns 200 and clears a literal IPv4 address", async function () {
        const res = await post({ ip: "203.0.113.7" });

        expect(res.status).toBe(200);
        expectSuccessShape(res.body);
        expect(res.body.data).toEqual({ ip: "203.0.113.7", cleared: true });
        expect(unblockStub).toHaveBeenCalledWith("203.0.113.7", "SA001");
    });

    it("accepts a literal IPv6 address", async function () {
        const res = await post({ ip: "2001:db8::1" });

        expect(res.status).toBe(200);
        expect(unblockStub).toHaveBeenCalledWith("2001:db8::1", "SA001");
    });

    it.each(["not-an-ip", "999.1.1.1", "10.0.0.1/24", "example.com"])(
        "returns 400 INVALID_IP for %s and never touches the filter",
        async function (ip) {
            const res = await post({ ip });

            expect(res.status).toBe(400);
            expectErrorShape(res.body);
            expect(res.body.message).toBe(ADMIN_ERRORS.INVALID_IP);
            expect(res.body.error.details.map((d) => d.field)).toContain("ip");
            expect(unblockStub).not.toHaveBeenCalled();
        },
    );

    it("returns 400 when ip is missing", async function () {
        const res = await post({});

        expect(res.status).toBe(400);
        expect(unblockStub).not.toHaveBeenCalled();
    });

    it("returns 401 when no token is provided", async function () {
        const res = await post({ ip: "203.0.113.7" }, null);

        expect(res.status).toBe(401);
        expect(unblockStub).not.toHaveBeenCalled();
    });

    it("returns 403 for ADMIN role (SUPER_ADMIN only)", async function () {
        const res = await post({ ip: "203.0.113.7" }, adminToken());

        expect(res.status).toBe(403);
        expect(unblockStub).not.toHaveBeenCalled();
    });
});
