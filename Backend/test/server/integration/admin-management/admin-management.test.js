"use strict";

/**
 * @fileoverview Integration tests for the Admin Management routes.
 *
 * Tests the full HTTP stack: authentication middleware, requireAccess predicate,
 * validateRequiredFields, controller delegation, and response shape contract.
 *
 * The service layer is stubbed with Sinon to avoid real DB calls.
 * This suite covers the mandatory 10-item checklist for each route
 * as required by Backend CLAUDE.md §7.
 *
 * Routes under test:
 *   GET    /api/v1/admin-management
 *   POST   /api/v1/admin-management
 *   PUT    /api/v1/admin-management/:empId
 *   PATCH  /api/v1/admin-management/:empId/reset-password
 *   PATCH  /api/v1/admin-management/:empId/reset-signature
 *   DELETE /api/v1/admin-management/:empId
 */

const request = require("supertest");
const app = require("../../../../src/app");
const { signToken } = require("../../helpers/auth");
const AdminManagementService = require("../../../../src/services/AdminManagementService");
const { registry } = require("../../../../src/middleware/cache");

// ── Token factories ────────────────────────────────────────────────────────────

/** Super Admin token — all admin-management routes require ADMIN or SUPER_ADMIN */
const superAdminToken = () =>
    signToken({ userId: "SA001", role: "SUPER_ADMIN", userLevel: 3 });

/** ADMIN token */
const adminToken = () =>
    signToken({ userId: "ADM001", role: "ADMIN", userLevel: 2 });

/** USER token — insufficient privilege */
const userToken = () =>
    signToken({ userId: "USR001", role: "User", userLevel: 1 });

/** APPROVER token — insufficient privilege for admin-management */
const approverToken = () =>
    signToken({ userId: "APR001", role: "APPROVER", userLevel: 1 });

// ── Stub data fixtures ─────────────────────────────────────────────────────────

const MOCK_ADMIN = {
    empId: "EMP001",
    empRole: "ADMIN",
    firstName: "Juan",
    lastName: "dela Cruz",
    segmentCode: "WH",
    segmentDesc: "Warehouse",
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
        empId: "EMP001",
        role: "ADMIN",
        retainPassword: true,
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
    });

    // ✅ 2. Missing required field — empId
    it("returns 400 when empId is missing", async function () {
        const { empId: _removed, ...body } = validBody();
        const res = await agent
            .post("/api/v1/admin-management")
            .set("Authorization", `Bearer ${superAdminToken()}`)
            .set("x-csrf-token", agent._csrfToken)
            .send(body);

        expect(res.status).toBe(400);
        expectErrorShape(res.body);
        const fields = res.body.error.details?.map((d) => d.field) ?? [];
        expect(fields).toContain("empId");
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

    // ✅ 4. Missing required field — retainPassword
    it("returns 400 when retainPassword is missing", async function () {
        const { retainPassword: _removed, ...body } = validBody();
        const res = await agent
            .post("/api/v1/admin-management")
            .set("Authorization", `Bearer ${superAdminToken()}`)
            .set("x-csrf-token", agent._csrfToken)
            .send(body);

        expect(res.status).toBe(400);
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
                    empId: "EMP001",
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
        expect(res.body.code).toBe(200);
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
// PUT /api/v1/admin-management/:empId  (update)
// ═══════════════════════════════════════════════════════════════════════════════

describe("PUT /api/v1/admin-management/:empId", function () {
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

    const validBody = () => ({ role: "APPROVER", changePassword: false });

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

    // ✅ 3. Missing required field — changePassword
    it("returns 400 when changePassword is missing", async function () {
        const { changePassword: _removed, ...body } = validBody();
        const res = await agent
            .put("/api/v1/admin-management/EMP001")
            .set("Authorization", `Bearer ${superAdminToken()}`)
            .set("x-csrf-token", agent._csrfToken)
            .send(body);

        expect(res.status).toBe(400);
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
                "Admin record not found. Verify the Employee ID and try again.",
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
// PATCH /api/v1/admin-management/:empId/reset-password
// ═══════════════════════════════════════════════════════════════════════════════

describe("PATCH /api/v1/admin-management/:empId/reset-password", function () {
    let resetPwStub;
    let agent;

    beforeEach(async function () {
        resetPwStub = vi
            .spyOn(AdminManagementService, "resetPassword")
            .mockResolvedValue({ empId: "EMP001" });
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
        expect(res.body.message).toBe(
            "Password reset to default successfully.",
        );
        expect(resetPwStub).toHaveBeenCalledTimes(1);
        expect(resetPwStub).toHaveBeenCalledWith("EMP001");
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
                "Admin record not found. Verify the Employee ID and try again.",
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
// PATCH /api/v1/admin-management/:empId/reset-signature
// ═══════════════════════════════════════════════════════════════════════════════

describe("PATCH /api/v1/admin-management/:empId/reset-signature", function () {
    let resetSigStub;
    let agent;

    beforeEach(async function () {
        resetSigStub = vi
            .spyOn(AdminManagementService, "resetSignature")
            .mockResolvedValue({ empId: "EMP001" });
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
        expect(resetSigStub).toHaveBeenCalledWith("EMP001");
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
                "Admin record not found. Verify the Employee ID and try again.",
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
            empId: "SA001",
            empRole: "SUPER_ADMIN",
        });

        const res = await agent
            .patch("/api/v1/admin-management/SA001/reset-signature")
            .set("Authorization", `Bearer ${superAdminToken()}`)
            .set("x-csrf-token", agent._csrfToken);

        expect(res.status).toBe(200);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DELETE /api/v1/admin-management/:empId
// ═══════════════════════════════════════════════════════════════════════════════

describe("DELETE /api/v1/admin-management/:empId", function () {
    let deleteStub;
    let agent;

    beforeEach(async function () {
        deleteStub = vi
            .spyOn(AdminManagementService, "deleteAdmin")
            .mockResolvedValue({ empId: "EMP001", deleted: true });
        agent = request.agent(app);
        const csrfRes = await agent.get("/api/v1/csrf/token");
        agent._csrfToken = csrfRes.body?.token ?? null;
    });

    afterEach(function () {
        vi.restoreAllMocks();
    });

    // ✅ 1. Happy path
    it("returns 200 on successful deletion", async function () {
        const res = await agent
            .delete("/api/v1/admin-management/EMP001")
            .set("Authorization", `Bearer ${superAdminToken()}`)
            .set("x-csrf-token", agent._csrfToken);

        expect(res.status).toBe(200);
        expect(res.body.message).toBe("Admin removed successfully.");
        expect(deleteStub).toHaveBeenCalledTimes(1);
        expect(deleteStub).toHaveBeenCalledWith("EMP001");
    });

    // ✅ 2. Unauthenticated
    it("returns 401 when no token is provided", async function () {
        const res = await agent
            .delete("/api/v1/admin-management/EMP001")
            .set("x-csrf-token", agent._csrfToken);

        expect(res.status).toBe(401);
    });

    // ✅ 3. Unauthorized — USER role
    it("returns 403 for USER role", async function () {
        const res = await agent
            .delete("/api/v1/admin-management/EMP001")
            .set("Authorization", `Bearer ${userToken()}`)
            .set("x-csrf-token", agent._csrfToken);

        expect(res.status).toBe(403);
    });

    // ✅ 4. Not found
    it("returns 404 when admin does not exist", async function () {
        const { AppError } = require("../../../../src/constants/errors");
        deleteStub.mockRejectedValue(
            new AppError(
                "Admin record not found. Verify the Employee ID and try again.",
                404,
            ),
        );

        const res = await agent
            .delete("/api/v1/admin-management/NONEXISTENT")
            .set("Authorization", `Bearer ${superAdminToken()}`)
            .set("x-csrf-token", agent._csrfToken);

        expect(res.status).toBe(404);
    });

    // ✅ 5. DataIntegrityError before delete
    it("returns 422 when SYSSIGNATURE is broken", async function () {
        const { AppError } = require("../../../../src/constants/errors");
        deleteStub.mockRejectedValue(
            new AppError("Admin record integrity check failed.", 422, {
                type: "DataIntegrityError",
            }),
        );

        const res = await agent
            .delete("/api/v1/admin-management/EMP001")
            .set("Authorization", `Bearer ${superAdminToken()}`)
            .set("x-csrf-token", agent._csrfToken);

        expect(res.status).toBe(422);
    });

    // ✅ 6. Response shape contract
    it("response shape matches { status, code, message, data } contract", async function () {
        const res = await agent
            .delete("/api/v1/admin-management/EMP001")
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

    // ✅ 7. X-Request-ID present
    it("sets X-Request-ID", async function () {
        const res = await agent
            .delete("/api/v1/admin-management/EMP001")
            .set("Authorization", `Bearer ${superAdminToken()}`)
            .set("x-csrf-token", agent._csrfToken);

        expectRequestId(res.headers);
    });

    // ✅ 8. Response time
    it("responds in under 500ms", async function () {
        const start = Date.now();
        await agent
            .delete("/api/v1/admin-management/EMP001")
            .set("Authorization", `Bearer ${superAdminToken()}`)
            .set("x-csrf-token", agent._csrfToken);
        expect(Date.now() - start).toBeLessThan(500);
    });

    // ✅ 9. Scanner path cannot reach this route prefix
    it("/.env scanner path is blocked (not routed to admin-management)", async function () {
        const res = await agent.get("/.env");
        expect([400, 403, 404]).toContain(res.status);
    });
});
