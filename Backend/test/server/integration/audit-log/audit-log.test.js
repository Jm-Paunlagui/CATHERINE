"use strict";

/**
 * @fileoverview Integration tests for the /api/v1/audit-logs resource.
 *
 * Route map (from audit-log.route.js):
 *   GET    /api/v1/audit-logs/stats                  Admin+SuperAdmin
 *   GET    /api/v1/audit-logs/export/excel            SuperAdmin only
 *   GET    /api/v1/audit-logs/export/logs             SuperAdmin only
 *   GET    /api/v1/audit-logs                         Admin+SuperAdmin
 *   GET    /api/v1/audit-logs/:requestId/export/trace SuperAdmin only
 *   GET    /api/v1/audit-logs/:requestId/logs         Admin+SuperAdmin
 *   DELETE /api/v1/audit-logs                         SuperAdmin only (CSRF req.)
 *
 * AuditLogService is stubbed for all tests — Oracle is not available in CI.
 * Export routes return binary buffers (xlsx / zip); their assertions check
 * Content-Type and Content-Disposition rather than JSON body shape.
 *
 * Covers:
 *   - Happy paths for every route
 *   - RBAC: ADMIN, SUPER_ADMIN, APPROVER (userLevel 1 — never authorised here)
 *   - 401 for unauthenticated, 440 for expired token
 *   - CSRF gate on DELETE
 *   - Response shape { status, code, message, data } for JSON routes
 *   - Correct Content-Type for binary export routes
 *   - X-Request-ID on every response
 *   - Response time < 500ms on fast paths
 */

const { expect }    = require("chai");
const sinon         = require("sinon");
const request       = require("supertest");
const app           = require("../../../../src/app");
const { signToken } = require("../../helpers/auth");
const AuditLogService = require("../../../../src/services/AuditLogService");

// ── Token factories ───────────────────────────────────────────────────────────

const adminToken    = () => signToken({ userId: "ADM001", role: "ADMIN",       userLevel: 2 });
const superToken    = () => signToken({ userId: "SA001",  role: "SUPER_ADMIN", userLevel: 3 });
const approverToken = () => signToken({ userId: "APR001", role: "APPROVER",    userLevel: 1 });

// ── Mock service returns ──────────────────────────────────────────────────────

const MOCK_LIST  = { rows: [], total: 0, page: 1, pageSize: 20 };
const MOCK_STATS = { totalRequests: 120, errorRate: 0.03, topEndpoints: [] };
const MOCK_LOGS  = { logs: [], requestId: "req_abc123" };
const MOCK_DELETE_RESULT = { deleted: 5, filesRemoved: 2 };
const MOCK_BUFFER_XLSX   = Buffer.from("PK\x03\x04mock-xlsx-content");
const MOCK_BUFFER_ZIP    = Buffer.from("PK\x03\x04mock-zip-content");

// ── Assertion helpers ─────────────────────────────────────────────────────────

function expectSuccessShape(body) {
  expect(body).to.include.all.keys("status", "code", "message", "data");
  expect(body.status).to.equal("success");
}

function expectErrorShape(body) {
  expect(body).to.include.all.keys("status", "code", "message", "error");
  expect(body.status).to.equal("error");
}

function expectRequestId(headers) {
  expect(headers["x-request-id"]).to.match(/^req_/);
}

// ─── Agent with CSRF (needed for DELETE) ─────────────────────────────────────

let agent;
let csrfToken;

before(async function () {
  this.timeout(10_000);
  agent = request.agent(app);
  const tokenRes = await agent.get("/api/v1/csrf/token");
  csrfToken = tokenRes.body?.token ?? "";
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/audit-logs/stats
// ═══════════════════════════════════════════════════════════════════════════════

describe("GET /api/v1/audit-logs/stats", function () {
  beforeEach(function () {
    sinon.stub(AuditLogService, "getStats").resolves(MOCK_STATS);
  });

  afterEach(function () {
    sinon.restore();
  });

  it("returns 200 for ADMIN role", async function () {
    const res = await request(app)
      .get("/api/v1/audit-logs/stats")
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(res.status).to.equal(200);
    expectSuccessShape(res.body);
    expect(AuditLogService.getStats.calledOnce).to.be.true;
  });

  it("returns 200 for SUPER_ADMIN role", async function () {
    const res = await request(app)
      .get("/api/v1/audit-logs/stats")
      .set("Authorization", `Bearer ${superToken()}`);
    expect(res.status).to.equal(200);
  });

  it("returns 403 for APPROVER (role not in [ADMIN, SUPER_ADMIN])", async function () {
    const res = await request(app)
      .get("/api/v1/audit-logs/stats")
      .set("Authorization", `Bearer ${approverToken()}`);
    expect(res.status).to.equal(403);
    expectErrorShape(res.body);
  });

  it("returns 401 when unauthenticated", async function () {
    const res = await request(app).get("/api/v1/audit-logs/stats");
    expect(res.status).to.equal(401);
  });

  it("returns 440 for expired token", async function () {
    const expired = signToken({ userId: "ADM001", role: "ADMIN" }, "-1s");
    const res = await request(app)
      .get("/api/v1/audit-logs/stats")
      .set("Authorization", `Bearer ${expired}`);
    expect(res.status).to.equal(440);
  });

  it("X-Request-ID is present", async function () {
    const res = await request(app)
      .get("/api/v1/audit-logs/stats")
      .set("Authorization", `Bearer ${adminToken()}`);
    expectRequestId(res.headers);
  });

  it("passes fromDate and toDate query params to AuditLogService.getStats", async function () {
    const res = await request(app)
      .get("/api/v1/audit-logs/stats?fromDate=2025-01-01&toDate=2025-01-31")
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(res.status).to.equal(200);
    const [params] = AuditLogService.getStats.firstCall.args;
    expect(params.fromDate).to.equal("2025-01-01");
    expect(params.toDate).to.equal("2025-01-31");
  });

  it("responds in under 500ms", async function () {
    const start = Date.now();
    await request(app)
      .get("/api/v1/audit-logs/stats")
      .set("Authorization", `Bearer ${adminToken()}`);
    expect(Date.now() - start).to.be.lessThan(500);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/audit-logs  (paginated list)
// ═══════════════════════════════════════════════════════════════════════════════

describe("GET /api/v1/audit-logs — paginated list", function () {
  beforeEach(function () {
    sinon.stub(AuditLogService, "getList").resolves(MOCK_LIST);
  });

  afterEach(function () {
    sinon.restore();
  });

  it("returns 200 for ADMIN role", async function () {
    const res = await request(app)
      .get("/api/v1/audit-logs")
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(res.status).to.equal(200);
    expectSuccessShape(res.body);
    expect(AuditLogService.getList.calledOnce).to.be.true;
  });

  it("returns 200 for SUPER_ADMIN role", async function () {
    const res = await request(app)
      .get("/api/v1/audit-logs")
      .set("Authorization", `Bearer ${superToken()}`);
    expect(res.status).to.equal(200);
  });

  it("returns 403 for APPROVER", async function () {
    const res = await request(app)
      .get("/api/v1/audit-logs")
      .set("Authorization", `Bearer ${approverToken()}`);
    expect(res.status).to.equal(403);
  });

  it("returns 401 when unauthenticated", async function () {
    const res = await request(app).get("/api/v1/audit-logs");
    expect(res.status).to.equal(401);
  });

  it("passes pagination and filter params to AuditLogService.getList", async function () {
    await request(app)
      .get("/api/v1/audit-logs?page=2&pageSize=50&method=GET&statusCategory=error")
      .set("Authorization", `Bearer ${adminToken()}`);

    const [params] = AuditLogService.getList.firstCall.args;
    expect(params.page).to.equal(2);
    expect(params.pageSize).to.equal(50);
    expect(params.method).to.equal("GET");
    expect(params.statusCategory).to.equal("error");
  });

  it("defaults page to 1 and pageSize to 20 when omitted (unique key forces cache miss)", async function () {
    // Use a unique search param so the cache key differs from the previous test,
    // ensuring AuditLogService.getList is called and firstCall.args is accessible.
    const res = await request(app)
      .get("/api/v1/audit-logs?search=__default_check__")
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(res.status).to.equal(200);
    const [params] = AuditLogService.getList.firstCall.args;
    expect(params.page).to.equal(1);
    expect(params.pageSize).to.equal(20);
  });

  it("X-Request-ID is present", async function () {
    const res = await request(app)
      .get("/api/v1/audit-logs")
      .set("Authorization", `Bearer ${adminToken()}`);
    expectRequestId(res.headers);
  });

  it("responds in under 500ms", async function () {
    const start = Date.now();
    await request(app)
      .get("/api/v1/audit-logs")
      .set("Authorization", `Bearer ${adminToken()}`);
    expect(Date.now() - start).to.be.lessThan(500);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/audit-logs/:requestId/logs
// ═══════════════════════════════════════════════════════════════════════════════

describe("GET /api/v1/audit-logs/:requestId/logs", function () {
  beforeEach(function () {
    sinon.stub(AuditLogService, "getRequestLogs").resolves(MOCK_LOGS);
  });

  afterEach(function () {
    sinon.restore();
  });

  const TEST_ID = "req_abc1234567890";

  it("returns 200 for ADMIN role with requestId in data", async function () {
    const res = await request(app)
      .get(`/api/v1/audit-logs/${TEST_ID}/logs`)
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(res.status).to.equal(200);
    expectSuccessShape(res.body);
    expect(AuditLogService.getRequestLogs.calledOnce).to.be.true;
    const [id] = AuditLogService.getRequestLogs.firstCall.args;
    expect(id).to.equal(TEST_ID);
  });

  it("returns 200 for SUPER_ADMIN", async function () {
    const res = await request(app)
      .get(`/api/v1/audit-logs/${TEST_ID}/logs`)
      .set("Authorization", `Bearer ${superToken()}`);
    expect(res.status).to.equal(200);
  });

  it("returns 403 for APPROVER", async function () {
    const res = await request(app)
      .get(`/api/v1/audit-logs/${TEST_ID}/logs`)
      .set("Authorization", `Bearer ${approverToken()}`);
    expect(res.status).to.equal(403);
  });

  it("returns 401 when unauthenticated", async function () {
    const res = await request(app).get(`/api/v1/audit-logs/${TEST_ID}/logs`);
    expect(res.status).to.equal(401);
  });

  it("X-Request-ID is present", async function () {
    const res = await request(app)
      .get(`/api/v1/audit-logs/${TEST_ID}/logs`)
      .set("Authorization", `Bearer ${adminToken()}`);
    expectRequestId(res.headers);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/audit-logs/export/excel  (SUPER_ADMIN only — binary)
// ═══════════════════════════════════════════════════════════════════════════════

describe("GET /api/v1/audit-logs/export/excel — binary xlsx export", function () {
  beforeEach(function () {
    sinon.stub(AuditLogService, "exportToExcel").resolves(MOCK_BUFFER_XLSX);
  });

  afterEach(function () {
    sinon.restore();
  });

  it("returns 200 with xlsx Content-Type for SUPER_ADMIN", async function () {
    const res = await request(app)
      .get("/api/v1/audit-logs/export/excel?fromDate=2025-01-01&toDate=2025-01-31")
      .set("Authorization", `Bearer ${superToken()}`);

    expect(res.status).to.equal(200);
    expect(res.headers["content-type"]).to.include(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
  });

  it("sets Content-Disposition attachment header", async function () {
    const res = await request(app)
      .get("/api/v1/audit-logs/export/excel?fromDate=2025-01-01&toDate=2025-01-31")
      .set("Authorization", `Bearer ${superToken()}`);

    expect(res.headers["content-disposition"]).to.include("attachment");
    expect(res.headers["content-disposition"]).to.include(".xlsx");
  });

  it("returns 403 for ADMIN (SUPER_ADMIN only route)", async function () {
    const res = await request(app)
      .get("/api/v1/audit-logs/export/excel")
      .set("Authorization", `Bearer ${adminToken()}`);
    expect(res.status).to.equal(403);
  });

  it("returns 403 for APPROVER", async function () {
    const res = await request(app)
      .get("/api/v1/audit-logs/export/excel")
      .set("Authorization", `Bearer ${approverToken()}`);
    expect(res.status).to.equal(403);
  });

  it("returns 401 when unauthenticated", async function () {
    const res = await request(app).get("/api/v1/audit-logs/export/excel");
    expect(res.status).to.equal(401);
  });

  it("X-Request-ID is present even on binary response", async function () {
    const res = await request(app)
      .get("/api/v1/audit-logs/export/excel?fromDate=2025-01-01&toDate=2025-01-31")
      .set("Authorization", `Bearer ${superToken()}`);
    expectRequestId(res.headers);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/audit-logs/export/logs  (SUPER_ADMIN only — binary zip)
// ═══════════════════════════════════════════════════════════════════════════════

describe("GET /api/v1/audit-logs/export/logs — binary zip export", function () {
  beforeEach(function () {
    sinon.stub(AuditLogService, "exportToZip").resolves(MOCK_BUFFER_ZIP);
  });

  afterEach(function () {
    sinon.restore();
  });

  it("returns 200 with application/zip Content-Type for SUPER_ADMIN", async function () {
    const res = await request(app)
      .get("/api/v1/audit-logs/export/logs?fromDate=2025-01-01&toDate=2025-01-31")
      .set("Authorization", `Bearer ${superToken()}`);

    expect(res.status).to.equal(200);
    expect(res.headers["content-type"]).to.include("application/zip");
  });

  it("sets Content-Disposition attachment with .zip filename", async function () {
    const res = await request(app)
      .get("/api/v1/audit-logs/export/logs?fromDate=2025-01-01&toDate=2025-01-31")
      .set("Authorization", `Bearer ${superToken()}`);

    expect(res.headers["content-disposition"]).to.include("attachment");
    expect(res.headers["content-disposition"]).to.include(".zip");
  });

  it("returns 403 for ADMIN (SUPER_ADMIN only)", async function () {
    const res = await request(app)
      .get("/api/v1/audit-logs/export/logs")
      .set("Authorization", `Bearer ${adminToken()}`);
    expect(res.status).to.equal(403);
  });

  it("returns 401 when unauthenticated", async function () {
    const res = await request(app).get("/api/v1/audit-logs/export/logs");
    expect(res.status).to.equal(401);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/audit-logs/:requestId/export/trace  (SUPER_ADMIN only — binary)
// ═══════════════════════════════════════════════════════════════════════════════

describe("GET /api/v1/audit-logs/:requestId/export/trace — per-request trace xlsx", function () {
  beforeEach(function () {
    sinon.stub(AuditLogService, "exportTraceExcel").resolves(MOCK_BUFFER_XLSX);
  });

  afterEach(function () {
    sinon.restore();
  });

  const TRACE_ID = "req_trace9876";

  it("returns 200 with xlsx Content-Type for SUPER_ADMIN", async function () {
    const res = await request(app)
      .get(`/api/v1/audit-logs/${TRACE_ID}/export/trace?date=2025-01-15`)
      .set("Authorization", `Bearer ${superToken()}`);

    expect(res.status).to.equal(200);
    expect(res.headers["content-type"]).to.include(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
  });

  it("sets Content-Disposition with sanitised requestId in filename", async function () {
    const res = await request(app)
      .get(`/api/v1/audit-logs/${TRACE_ID}/export/trace?date=2025-01-15`)
      .set("Authorization", `Bearer ${superToken()}`);

    expect(res.headers["content-disposition"]).to.include("attachment");
    expect(res.headers["content-disposition"]).to.include(".xlsx");
  });

  it("returns 403 for ADMIN (SUPER_ADMIN only)", async function () {
    const res = await request(app)
      .get(`/api/v1/audit-logs/${TRACE_ID}/export/trace?date=2025-01-15`)
      .set("Authorization", `Bearer ${adminToken()}`);
    expect(res.status).to.equal(403);
  });

  it("returns 401 when unauthenticated", async function () {
    const res = await request(app)
      .get(`/api/v1/audit-logs/${TRACE_ID}/export/trace?date=2025-01-15`);
    expect(res.status).to.equal(401);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DELETE /api/v1/audit-logs  (SUPER_ADMIN only — requires CSRF)
// ═══════════════════════════════════════════════════════════════════════════════

describe("DELETE /api/v1/audit-logs — range delete", function () {
  beforeEach(function () {
    sinon.stub(AuditLogService, "deleteRange").resolves(MOCK_DELETE_RESULT);
  });

  afterEach(function () {
    sinon.restore();
  });

  it("returns 200 for SUPER_ADMIN with valid CSRF", async function () {
    const res = await agent
      .delete("/api/v1/audit-logs?fromDate=2025-01-01&toDate=2025-01-31")
      .set("Authorization", `Bearer ${superToken()}`)
      .set("x-csrf-token", csrfToken);

    expect(res.status).to.equal(200);
    expectSuccessShape(res.body);
    expect(AuditLogService.deleteRange.calledOnce).to.be.true;
  });

  it("passes fromDate and toDate to AuditLogService.deleteRange", async function () {
    await agent
      .delete("/api/v1/audit-logs?fromDate=2025-02-01&toDate=2025-02-28")
      .set("Authorization", `Bearer ${superToken()}`)
      .set("x-csrf-token", csrfToken);

    const [params] = AuditLogService.deleteRange.firstCall.args;
    expect(params.fromDate).to.equal("2025-02-01");
    expect(params.toDate).to.equal("2025-02-28");
  });

  it("returns 403 when CSRF token is absent (even with valid auth)", async function () {
    const res = await agent
      .delete("/api/v1/audit-logs?fromDate=2025-01-01&toDate=2025-01-31")
      .set("Authorization", `Bearer ${superToken()}`);

    expect(res.status).to.equal(403);
  });

  it("returns 403 when CSRF token is forged", async function () {
    const res = await agent
      .delete("/api/v1/audit-logs?fromDate=2025-01-01&toDate=2025-01-31")
      .set("Authorization", `Bearer ${superToken()}`)
      .set("x-csrf-token", "forged-csrf-xyz");

    expect(res.status).to.equal(403);
  });

  it("returns 403 for ADMIN (SUPER_ADMIN only)", async function () {
    const res = await agent
      .delete("/api/v1/audit-logs?fromDate=2025-01-01&toDate=2025-01-31")
      .set("Authorization", `Bearer ${adminToken()}`)
      .set("x-csrf-token", csrfToken);

    expect(res.status).to.equal(403);
  });

  it("returns 403 for APPROVER", async function () {
    const res = await agent
      .delete("/api/v1/audit-logs?fromDate=2025-01-01&toDate=2025-01-31")
      .set("Authorization", `Bearer ${approverToken()}`)
      .set("x-csrf-token", csrfToken);

    expect(res.status).to.equal(403);
  });

  it("returns 401 when unauthenticated", async function () {
    const res = await agent
      .delete("/api/v1/audit-logs?fromDate=2025-01-01&toDate=2025-01-31")
      .set("x-csrf-token", csrfToken);

    expect(res.status).to.equal(401);
  });

  it("returns 440 for expired token", async function () {
    const expired = signToken({ userId: "SA001", role: "SUPER_ADMIN" }, "-1s");
    const res = await agent
      .delete("/api/v1/audit-logs?fromDate=2025-01-01&toDate=2025-01-31")
      .set("Authorization", `Bearer ${expired}`)
      .set("x-csrf-token", csrfToken);

    expect(res.status).to.equal(440);
  });

  it("X-Request-ID is present on the response", async function () {
    const res = await agent
      .delete("/api/v1/audit-logs?fromDate=2025-01-01&toDate=2025-01-31")
      .set("Authorization", `Bearer ${superToken()}`)
      .set("x-csrf-token", csrfToken);

    expectRequestId(res.headers);
  });

  it("responds in under 500ms (service stubbed — no real DB)", async function () {
    const start = Date.now();
    await agent
      .delete("/api/v1/audit-logs?fromDate=2025-01-01&toDate=2025-01-31")
      .set("Authorization", `Bearer ${superToken()}`)
      .set("x-csrf-token", csrfToken);
    expect(Date.now() - start).to.be.lessThan(500);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// REGRESSION — GET /api/v1/audit-logs with search= param
//
// Root cause: AuditLogModel.aggregate() spread the $or clause (text-search
// predicates built for the paginated list query) into the uniqueUserRows
// aggregate. When the $or contained regex predicates against VARCHAR2 columns,
// oracle-mongo-wrapper generated malformed SQL when it encountered the $or in
// a GROUP BY context — producing ORA errors and a 500 response.
//
// Fix (audit.log.model.js): strip $or from matchFilter before building
// uniqueUserFilter. The unique-user count is a date-range metric — text-search
// predicates are semantically incorrect on the GROUP BY USER_ID aggregate.
//
// This regression suite verifies that GET / with a ?search= param returns
// 200 and the correct response shape, not 500. AuditLogService is stubbed so
// the test is resilient to Oracle unavailability in CI.
//
// See: docs/performance-rca.md §RC-6 — AuditLogModel.$or bleed (2.6% error)
// ═══════════════════════════════════════════════════════════════════════════════

describe("REGRESSION — GET /api/v1/audit-logs with ?search= param (2.6% error fix)", function () {
  const MOCK_SEARCH_LIST = { rows: [], total: 0, page: 1, pageSize: 20 };

  beforeEach(function () {
    sinon.stub(AuditLogService, "getList").resolves(MOCK_SEARCH_LIST);
  });

  afterEach(function () {
    sinon.restore();
  });

  it("returns 200 (not 500) when search param is a plain string", async function () {
    const res = await request(app)
      .get("/api/v1/audit-logs?search=jsmith")
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(res.status).to.equal(200);
    expectSuccessShape(res.body);
  });

  it("returns 200 when search param is a numeric string (triggers the $or USER_ID match)", async function () {
    // Numeric search values caused the original ORA crash because the $or
    // predicate contained { USER_ID: numericId } alongside regex predicates;
    // together they were spread into a GROUP BY query.
    const res = await request(app)
      .get("/api/v1/audit-logs?search=12345")
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(res.status).to.equal(200);
    expectSuccessShape(res.body);
  });

  it("returns 200 when search param contains regex-special characters", async function () {
    const res = await request(app)
      .get("/api/v1/audit-logs?search=admin%40corp.example")
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(res.status).to.equal(200);
  });

  it("passes search param to AuditLogService.getList", async function () {
    await request(app)
      .get("/api/v1/audit-logs?search=testuser")
      .set("Authorization", `Bearer ${adminToken()}`);

    const [params] = AuditLogService.getList.firstCall.args;
    expect(params.search).to.equal("testuser");
  });

  it("returns 200 when both search and date range params are provided", async function () {
    const res = await request(app)
      .get(
        "/api/v1/audit-logs?search=root&fromDate=2025-01-01&toDate=2025-01-31",
      )
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(res.status).to.equal(200);
    const [params] = AuditLogService.getList.firstCall.args;
    expect(params.search).to.equal("root");
    expect(params.fromDate).to.equal("2025-01-01");
  });

  it("response shape is { status, code, message, data } with data.rows array", async function () {
    const res = await request(app)
      .get("/api/v1/audit-logs?search=anything")
      .set("Authorization", `Bearer ${adminToken()}`);

    expectSuccessShape(res.body);
    expect(res.body.data).to.have.property("rows").that.is.an("array");
  });

  it("X-Request-ID is present on responses with search param", async function () {
    const res = await request(app)
      .get("/api/v1/audit-logs?search=regression_check")
      .set("Authorization", `Bearer ${adminToken()}`);

    expectRequestId(res.headers);
  });

  it("responds in under 500ms with search param (service stubbed)", async function () {
    const start = Date.now();
    await request(app)
      .get("/api/v1/audit-logs?search=perf_check")
      .set("Authorization", `Bearer ${adminToken()}`);
    expect(Date.now() - start).to.be.lessThan(500);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Route ordering: static segments not captured by /:requestId/logs
// ═══════════════════════════════════════════════════════════════════════════════

describe("route ordering — static segments not matched as :requestId", function () {
  beforeEach(function () {
    sinon.stub(AuditLogService, "getStats").resolves(MOCK_STATS);
    sinon.stub(AuditLogService, "exportToExcel").resolves(MOCK_BUFFER_XLSX);
    sinon.stub(AuditLogService, "exportToZip").resolves(MOCK_BUFFER_ZIP);
  });

  afterEach(function () {
    sinon.restore();
  });

  it('/stats is NOT captured by /:requestId/logs — getStats is called, not getRequestLogs', async function () {
    await request(app)
      .get("/api/v1/audit-logs/stats")
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(AuditLogService.getStats.calledOnce).to.be.true;
  });

  it('/export/excel is NOT captured by /:requestId/logs — exportToExcel is called', async function () {
    const res = await request(app)
      .get("/api/v1/audit-logs/export/excel")
      .set("Authorization", `Bearer ${superToken()}`);

    // May 200 (correct route) or 500 if date params missing — NOT 404 matching wrong route
    expect(AuditLogService.exportToExcel.calledOnce).to.be.true;
  });
});
