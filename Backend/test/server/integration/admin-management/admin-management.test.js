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
 *   GET    /api/v1/admin-management/search?q=<query>
 *   GET    /api/v1/admin-management
 *   POST   /api/v1/admin-management
 *   PUT    /api/v1/admin-management/:empId
 *   PATCH  /api/v1/admin-management/:empId/reset-password
 *   PATCH  /api/v1/admin-management/:empId/reset-signature
 *   DELETE /api/v1/admin-management/:empId
 */

const { expect } = require("chai");
const sinon = require("sinon");
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

const MOCK_EMPLOYEE = {
  USERID: "EMP001",
  FIRSTNAME: "Juan",
  LASTNAME: "dela Cruz",
  SEGMENT_CODE: "WH",
  SEGMENT_DESC: "Warehouse",
};

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
  expect(body).to.have.property("status", "success");
  expect(body).to.have.property("code", 200);
  expect(body).to.have.property("message").that.is.a("string");
  expect(body).to.have.property("data");
}

function expectErrorShape(body) {
  expect(body).to.have.all.keys("status", "code", "title", "message", "error");
  expect(body.status).to.equal("error");
  expect(body.error).to.have.property("type").that.is.a("string");
}

function expectRequestId(headers) {
  expect(headers).to.have.property("x-request-id");
  expect(headers["x-request-id"]).to.match(/^req_/);
}

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/admin-management/search
// ═══════════════════════════════════════════════════════════════════════════════

describe("GET /api/v1/admin-management/search", function () {
  let searchStub;

  beforeEach(function () {
    searchStub = sinon
      .stub(AdminManagementService, "searchEmployees")
      .resolves([MOCK_EMPLOYEE]);
  });

  afterEach(function () {
    sinon.restore();
  });

  // ✅ 1. Happy path
  it("returns 200 with employee results when q is provided", async function () {
    const res = await request(app)
      .get("/api/v1/admin-management/search")
      .query({ q: "Juan" })
      .set("Authorization", `Bearer ${superAdminToken()}`);

    expect(res.status).to.equal(200);
    expectSuccessShape(res.body);
    expect(res.body.data).to.be.an("array").with.lengthOf(1);
    expect(res.body.data[0]).to.have.property("USERID", "EMP001");
    expect(searchStub.calledOnceWith("Juan")).to.be.true;
  });

  // ✅ 2. Missing required field
  it("returns 400 when q query param is missing", async function () {
    const res = await request(app)
      .get("/api/v1/admin-management/search")
      .set("Authorization", `Bearer ${superAdminToken()}`);

    expect(res.status).to.equal(400);
    expectErrorShape(res.body);
    expect(res.body.error).to.have.property("details").that.is.an("array");
  });

  // ✅ 3. Unauthenticated
  it("returns 401 when no token is provided", async function () {
    const res = await request(app)
      .get("/api/v1/admin-management/search")
      .query({ q: "Juan" });

    expect(res.status).to.equal(401);
    expectErrorShape(res.body);
  });

  // ✅ 4. Authenticated but unauthorized — USER role
  it("returns 403 when user has USER role", async function () {
    const res = await request(app)
      .get("/api/v1/admin-management/search")
      .query({ q: "Juan" })
      .set("Authorization", `Bearer ${userToken()}`);

    expect(res.status).to.equal(403);
    expectErrorShape(res.body);
  });

  // ✅ 5. Authenticated but unauthorized — APPROVER role
  it("returns 403 when user has APPROVER role", async function () {
    const res = await request(app)
      .get("/api/v1/admin-management/search")
      .query({ q: "Juan" })
      .set("Authorization", `Bearer ${approverToken()}`);

    expect(res.status).to.equal(403);
  });

  // ✅ 6. Response shape contract
  it("response shape matches { status, code, message, data } contract", async function () {
    const res = await request(app)
      .get("/api/v1/admin-management/search")
      .query({ q: "test" })
      .set("Authorization", `Bearer ${adminToken()}`);

    expectSuccessShape(res.body);
  });

  // ✅ 7. X-Request-ID present
  it("sets X-Request-ID on every response", async function () {
    const res = await request(app)
      .get("/api/v1/admin-management/search")
      .query({ q: "test" })
      .set("Authorization", `Bearer ${superAdminToken()}`);

    expectRequestId(res.headers);
  });

  // ✅ 8. Response time
  it("responds in under 500ms", async function () {
    const start = Date.now();
    await request(app)
      .get("/api/v1/admin-management/search")
      .query({ q: "test" })
      .set("Authorization", `Bearer ${superAdminToken()}`);
    expect(Date.now() - start).to.be.lessThan(500);
  });

  // ✅ 9. Scanner path blocking (parent route guard applies)
  it("is not accessible via /.env scanner path", async function () {
    const res = await request(app).get("/.env");
    expect([400, 403, 404]).to.include(res.status);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/admin-management  (list)
// ═══════════════════════════════════════════════════════════════════════════════

describe("GET /api/v1/admin-management", function () {
  let listStub;

  beforeEach(function () {
    listStub = sinon
      .stub(AdminManagementService, "listAdmins")
      .resolves(MOCK_ADMIN_LIST);
  });

  afterEach(function () {
    sinon.restore();
  });

  // ✅ 1. Happy path
  it("returns 200 with admin list", async function () {
    const res = await request(app)
      .get("/api/v1/admin-management")
      .set("Authorization", `Bearer ${superAdminToken()}`);

    expect(res.status).to.equal(200);
    expectSuccessShape(res.body);
    expect(res.body.data).to.be.an("array").with.lengthOf(1);
    expect(listStub.calledOnce).to.be.true;
  });

  // ✅ 2. Unauthenticated
  it("returns 401 when no token is provided", async function () {
    const res = await request(app).get("/api/v1/admin-management");
    expect(res.status).to.equal(401);
  });

  // ✅ 3. Unauthorized — USER role
  it("returns 403 for USER role", async function () {
    const res = await request(app)
      .get("/api/v1/admin-management")
      .set("Authorization", `Bearer ${userToken()}`);
    expect(res.status).to.equal(403);
  });

  // ✅ 4. Authorized — ADMIN role can list
  it("returns 200 for ADMIN role", async function () {
    const res = await request(app)
      .get("/api/v1/admin-management")
      .set("Authorization", `Bearer ${adminToken()}`);
    expect(res.status).to.equal(200);
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
    expect(Date.now() - start).to.be.lessThan(500);
  });

  // ✅ 8. Returns empty array when no admins exist (not null/undefined)
  it("returns an empty array when no admins exist", async function () {
    listStub.resolves([]);
    registry.resolve("adminList").flush(); // ensure no cached admin list from prior tests
    const res = await request(app)
      .get("/api/v1/admin-management")
      .set("Authorization", `Bearer ${superAdminToken()}`);
    expect(res.status).to.equal(200);
    expect(res.body.data).to.be.an("array").with.lengthOf(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/v1/admin-management  (create)
// ═══════════════════════════════════════════════════════════════════════════════

describe("POST /api/v1/admin-management", function () {
  let createStub;
  let agent;

  beforeEach(async function () {
    createStub = sinon
      .stub(AdminManagementService, "addAdmin")
      .resolves(MOCK_ADMIN);
    agent = request.agent(app);
    // Fetch CSRF token
    const csrfRes = await agent.get("/api/v1/csrf/token");
    agent._csrfToken = csrfRes.body?.token ?? null;
  });

  afterEach(function () {
    sinon.restore();
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

    expect(res.status).to.equal(201);
    expect(res.body.status).to.equal("success");
    expect(res.body.message).to.equal("Admin created successfully.");
    expect(createStub.calledOnce).to.be.true;
  });

  // ✅ 2. Missing required field — empId
  it("returns 400 when empId is missing", async function () {
    const { empId: _removed, ...body } = validBody();
    const res = await agent
      .post("/api/v1/admin-management")
      .set("Authorization", `Bearer ${superAdminToken()}`)
      .set("x-csrf-token", agent._csrfToken)
      .send(body);

    expect(res.status).to.equal(400);
    expectErrorShape(res.body);
    const fields = res.body.error.details?.map((d) => d.field) ?? [];
    expect(fields).to.include("empId");
  });

  // ✅ 3. Missing required field — role
  it("returns 400 when role is missing", async function () {
    const { role: _removed, ...body } = validBody();
    const res = await agent
      .post("/api/v1/admin-management")
      .set("Authorization", `Bearer ${superAdminToken()}`)
      .set("x-csrf-token", agent._csrfToken)
      .send(body);

    expect(res.status).to.equal(400);
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

    expect(res.status).to.equal(400);
  });

  // ✅ 5. Unauthenticated
  it("returns 401 when no token is provided", async function () {
    const res = await agent
      .post("/api/v1/admin-management")
      .set("x-csrf-token", agent._csrfToken)
      .send(validBody());

    expect(res.status).to.equal(401);
  });

  // ✅ 6. Unauthorized — USER role
  it("returns 403 for USER role", async function () {
    const res = await agent
      .post("/api/v1/admin-management")
      .set("Authorization", `Bearer ${userToken()}`)
      .set("x-csrf-token", agent._csrfToken)
      .send(validBody());

    expect(res.status).to.equal(403);
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

    expect(res.status).to.equal(413);
  });

  // ✅ 8. Response shape contract
  it("response shape matches contract", async function () {
    const res = await agent
      .post("/api/v1/admin-management")
      .set("Authorization", `Bearer ${superAdminToken()}`)
      .set("x-csrf-token", agent._csrfToken)
      .send(validBody());

    expect(res.body).to.have.all.keys("status", "code", "message", "data");
    expect(res.body.code).to.equal(200);
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
    expect(Date.now() - start).to.be.lessThan(500);
  });

  // ✅ 11. Service-level conflict — already exists
  it("returns the service AppError status when employee is already an admin", async function () {
    const { AppError } = require("../../../../src/constants/errors");
    createStub.rejects(
      new AppError("This employee is already registered as an admin.", 409),
    );

    const res = await agent
      .post("/api/v1/admin-management")
      .set("Authorization", `Bearer ${superAdminToken()}`)
      .set("x-csrf-token", agent._csrfToken)
      .send(validBody());

    expect(res.status).to.equal(409);
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
    updateStub = sinon
      .stub(AdminManagementService, "updateAdmin")
      .resolves(MOCK_ADMIN);
    agent = request.agent(app);
    const csrfRes = await agent.get("/api/v1/csrf/token");
    agent._csrfToken = csrfRes.body?.token ?? null;
  });

  afterEach(function () {
    sinon.restore();
  });

  const validBody = () => ({ role: "APPROVER", changePassword: false });

  // ✅ 1. Happy path
  it("returns 200 with updated admin data", async function () {
    const res = await agent
      .put("/api/v1/admin-management/EMP001")
      .set("Authorization", `Bearer ${superAdminToken()}`)
      .set("x-csrf-token", agent._csrfToken)
      .send(validBody());

    expect(res.status).to.equal(200);
    expectSuccessShape(res.body);
    expect(updateStub.calledOnce).to.be.true;
  });

  // ✅ 2. Missing required field — role
  it("returns 400 when role is missing", async function () {
    const { role: _removed, ...body } = validBody();
    const res = await agent
      .put("/api/v1/admin-management/EMP001")
      .set("Authorization", `Bearer ${superAdminToken()}`)
      .set("x-csrf-token", agent._csrfToken)
      .send(body);

    expect(res.status).to.equal(400);
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

    expect(res.status).to.equal(400);
  });

  // ✅ 4. Unauthenticated
  it("returns 401 when no token is provided", async function () {
    const res = await agent
      .put("/api/v1/admin-management/EMP001")
      .set("x-csrf-token", agent._csrfToken)
      .send(validBody());

    expect(res.status).to.equal(401);
  });

  // ✅ 5. Unauthorized — USER role
  it("returns 403 for USER role", async function () {
    const res = await agent
      .put("/api/v1/admin-management/EMP001")
      .set("Authorization", `Bearer ${userToken()}`)
      .set("x-csrf-token", agent._csrfToken)
      .send(validBody());

    expect(res.status).to.equal(403);
  });

  // ✅ 6. Not found — service throws 404
  it("returns 404 when admin does not exist", async function () {
    const { AppError } = require("../../../../src/constants/errors");
    updateStub.rejects(
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

    expect(res.status).to.equal(404);
    expectErrorShape(res.body);
  });

  // ✅ 7. Response shape contract
  it("response shape matches { status, code, message, data } contract", async function () {
    const res = await agent
      .put("/api/v1/admin-management/EMP001")
      .set("Authorization", `Bearer ${superAdminToken()}`)
      .set("x-csrf-token", agent._csrfToken)
      .send(validBody());

    expect(res.body).to.have.all.keys("status", "code", "message", "data");
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
    expect(Date.now() - start).to.be.lessThan(500);
  });

  // ✅ 10. Signature integrity error (422)
  it("returns 422 DataIntegrityError when SYSSIGNATURE is broken", async function () {
    const { AppError } = require("../../../../src/constants/errors");
    updateStub.rejects(
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

    expect(res.status).to.equal(422);
    expect(res.body.error.type).to.equal("DataIntegrityError");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PATCH /api/v1/admin-management/:empId/reset-password
// ═══════════════════════════════════════════════════════════════════════════════

describe("PATCH /api/v1/admin-management/:empId/reset-password", function () {
  let resetPwStub;
  let agent;

  beforeEach(async function () {
    resetPwStub = sinon
      .stub(AdminManagementService, "resetPassword")
      .resolves({ empId: "EMP001" });
    agent = request.agent(app);
    const csrfRes = await agent.get("/api/v1/csrf/token");
    agent._csrfToken = csrfRes.body?.token ?? null;
  });

  afterEach(function () {
    sinon.restore();
  });

  // ✅ 1. Happy path
  it("returns 200 on successful password reset", async function () {
    const res = await agent
      .patch("/api/v1/admin-management/EMP001/reset-password")
      .set("Authorization", `Bearer ${superAdminToken()}`)
      .set("x-csrf-token", agent._csrfToken);

    expect(res.status).to.equal(200);
    expect(res.body.message).to.equal(
      "Password reset to default successfully.",
    );
    expect(resetPwStub.calledOnceWith("EMP001")).to.be.true;
  });

  // ✅ 2. Unauthenticated
  it("returns 401 when no token is provided", async function () {
    const res = await agent
      .patch("/api/v1/admin-management/EMP001/reset-password")
      .set("x-csrf-token", agent._csrfToken);

    expect(res.status).to.equal(401);
  });

  // ✅ 3. Unauthorized
  it("returns 403 for USER role", async function () {
    const res = await agent
      .patch("/api/v1/admin-management/EMP001/reset-password")
      .set("Authorization", `Bearer ${userToken()}`)
      .set("x-csrf-token", agent._csrfToken);

    expect(res.status).to.equal(403);
  });

  // ✅ 4. Not found
  it("returns 404 when admin does not exist", async function () {
    const { AppError } = require("../../../../src/constants/errors");
    resetPwStub.rejects(
      new AppError(
        "Admin record not found. Verify the Employee ID and try again.",
        404,
      ),
    );

    const res = await agent
      .patch("/api/v1/admin-management/NONEXISTENT/reset-password")
      .set("Authorization", `Bearer ${superAdminToken()}`)
      .set("x-csrf-token", agent._csrfToken);

    expect(res.status).to.equal(404);
  });

  // ✅ 5. Response shape contract
  it("response shape matches { status, code, message, data } contract", async function () {
    const res = await agent
      .patch("/api/v1/admin-management/EMP001/reset-password")
      .set("Authorization", `Bearer ${superAdminToken()}`)
      .set("x-csrf-token", agent._csrfToken);

    expect(res.body).to.have.all.keys("status", "code", "message", "data");
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
    expect(Date.now() - start).to.be.lessThan(500);
  });

  // ✅ 8. DataIntegrityError propagated correctly
  it("returns 422 when SYSSIGNATURE is broken", async function () {
    const { AppError } = require("../../../../src/constants/errors");
    resetPwStub.rejects(
      new AppError("Admin record integrity check failed.", 422, {
        type: "DataIntegrityError",
      }),
    );

    const res = await agent
      .patch("/api/v1/admin-management/EMP001/reset-password")
      .set("Authorization", `Bearer ${superAdminToken()}`)
      .set("x-csrf-token", agent._csrfToken);

    expect(res.status).to.equal(422);
    expect(res.body.error.type).to.equal("DataIntegrityError");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PATCH /api/v1/admin-management/:empId/reset-signature
// ═══════════════════════════════════════════════════════════════════════════════

describe("PATCH /api/v1/admin-management/:empId/reset-signature", function () {
  let resetSigStub;
  let agent;

  beforeEach(async function () {
    resetSigStub = sinon
      .stub(AdminManagementService, "resetSignature")
      .resolves({ empId: "EMP001" });
    agent = request.agent(app);
    const csrfRes = await agent.get("/api/v1/csrf/token");
    agent._csrfToken = csrfRes.body?.token ?? null;
  });

  afterEach(function () {
    sinon.restore();
  });

  // ✅ 1. Happy path
  it("returns 200 on successful signature reset", async function () {
    const res = await agent
      .patch("/api/v1/admin-management/EMP001/reset-signature")
      .set("Authorization", `Bearer ${superAdminToken()}`)
      .set("x-csrf-token", agent._csrfToken);

    expect(res.status).to.equal(200);
    expect(res.body.message).to.equal(
      "Record signature recomputed successfully.",
    );
    expect(resetSigStub.calledOnceWith("EMP001")).to.be.true;
  });

  // ✅ 2. Unauthenticated
  it("returns 401 when no token is provided", async function () {
    const res = await agent
      .patch("/api/v1/admin-management/EMP001/reset-signature")
      .set("x-csrf-token", agent._csrfToken);

    expect(res.status).to.equal(401);
  });

  // ✅ 3. Unauthorized
  it("returns 403 for USER role", async function () {
    const res = await agent
      .patch("/api/v1/admin-management/EMP001/reset-signature")
      .set("Authorization", `Bearer ${userToken()}`)
      .set("x-csrf-token", agent._csrfToken);

    expect(res.status).to.equal(403);
  });

  // ✅ 4. Not found
  it("returns 404 when admin does not exist", async function () {
    const { AppError } = require("../../../../src/constants/errors");
    resetSigStub.rejects(
      new AppError(
        "Admin record not found. Verify the Employee ID and try again.",
        404,
      ),
    );

    const res = await agent
      .patch("/api/v1/admin-management/NONEXISTENT/reset-signature")
      .set("Authorization", `Bearer ${superAdminToken()}`)
      .set("x-csrf-token", agent._csrfToken);

    expect(res.status).to.equal(404);
  });

  // ✅ 5. Response shape contract
  it("response shape matches { status, code, message, data } contract", async function () {
    const res = await agent
      .patch("/api/v1/admin-management/EMP001/reset-signature")
      .set("Authorization", `Bearer ${superAdminToken()}`)
      .set("x-csrf-token", agent._csrfToken);

    expect(res.body).to.have.all.keys("status", "code", "message", "data");
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
    expect(Date.now() - start).to.be.lessThan(500);
  });

  // ✅ 8. SUPER_ADMIN can reset a SUPER_ADMIN signature
  it("allows SUPER_ADMIN to reset any admin's signature", async function () {
    resetSigStub.resolves({ empId: "SA001", empRole: "SUPER_ADMIN" });

    const res = await agent
      .patch("/api/v1/admin-management/SA001/reset-signature")
      .set("Authorization", `Bearer ${superAdminToken()}`)
      .set("x-csrf-token", agent._csrfToken);

    expect(res.status).to.equal(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DELETE /api/v1/admin-management/:empId
// ═══════════════════════════════════════════════════════════════════════════════

describe("DELETE /api/v1/admin-management/:empId", function () {
  let deleteStub;
  let agent;

  beforeEach(async function () {
    deleteStub = sinon
      .stub(AdminManagementService, "deleteAdmin")
      .resolves({ empId: "EMP001", deleted: true });
    agent = request.agent(app);
    const csrfRes = await agent.get("/api/v1/csrf/token");
    agent._csrfToken = csrfRes.body?.token ?? null;
  });

  afterEach(function () {
    sinon.restore();
  });

  // ✅ 1. Happy path
  it("returns 200 on successful deletion", async function () {
    const res = await agent
      .delete("/api/v1/admin-management/EMP001")
      .set("Authorization", `Bearer ${superAdminToken()}`)
      .set("x-csrf-token", agent._csrfToken);

    expect(res.status).to.equal(200);
    expect(res.body.message).to.equal("Admin removed successfully.");
    expect(deleteStub.calledOnceWith("EMP001")).to.be.true;
  });

  // ✅ 2. Unauthenticated
  it("returns 401 when no token is provided", async function () {
    const res = await agent
      .delete("/api/v1/admin-management/EMP001")
      .set("x-csrf-token", agent._csrfToken);

    expect(res.status).to.equal(401);
  });

  // ✅ 3. Unauthorized — USER role
  it("returns 403 for USER role", async function () {
    const res = await agent
      .delete("/api/v1/admin-management/EMP001")
      .set("Authorization", `Bearer ${userToken()}`)
      .set("x-csrf-token", agent._csrfToken);

    expect(res.status).to.equal(403);
  });

  // ✅ 4. Not found
  it("returns 404 when admin does not exist", async function () {
    const { AppError } = require("../../../../src/constants/errors");
    deleteStub.rejects(
      new AppError(
        "Admin record not found. Verify the Employee ID and try again.",
        404,
      ),
    );

    const res = await agent
      .delete("/api/v1/admin-management/NONEXISTENT")
      .set("Authorization", `Bearer ${superAdminToken()}`)
      .set("x-csrf-token", agent._csrfToken);

    expect(res.status).to.equal(404);
  });

  // ✅ 5. DataIntegrityError before delete
  it("returns 422 when SYSSIGNATURE is broken", async function () {
    const { AppError } = require("../../../../src/constants/errors");
    deleteStub.rejects(
      new AppError("Admin record integrity check failed.", 422, {
        type: "DataIntegrityError",
      }),
    );

    const res = await agent
      .delete("/api/v1/admin-management/EMP001")
      .set("Authorization", `Bearer ${superAdminToken()}`)
      .set("x-csrf-token", agent._csrfToken);

    expect(res.status).to.equal(422);
  });

  // ✅ 6. Response shape contract
  it("response shape matches { status, code, message, data } contract", async function () {
    const res = await agent
      .delete("/api/v1/admin-management/EMP001")
      .set("Authorization", `Bearer ${superAdminToken()}`)
      .set("x-csrf-token", agent._csrfToken);

    expect(res.body).to.have.all.keys("status", "code", "message", "data");
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
    expect(Date.now() - start).to.be.lessThan(500);
  });

  // ✅ 9. Scanner path cannot reach this route prefix
  it("/.env scanner path is blocked (not routed to admin-management)", async function () {
    const res = await agent.get("/.env");
    expect([400, 403, 404]).to.include(res.status);
  });
});
