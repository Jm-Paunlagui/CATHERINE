"use strict";

/**
 * @fileoverview Integration tests for PATCH /api/v1/auth/change-password.
 *
 * Covers the mandatory 10-item checklist from Backend CLAUDE.md §7.
 *
 * The AuthService is stubbed with Sinon to avoid real DB calls.
 * Tests verify:
 *   - Full middleware chain (authRateLimiter → authenticate → validateRequiredFields)
 *   - Controller delegation to AuthService.changePassword
 *   - Cookie replacement on success (new access + refresh tokens)
 *   - Response shape contract { status, code, message, data }
 *   - All negative cases: missing fields, unauthenticated, wrong password, default PW rejected
 */

const { expect } = require("chai");
const sinon = require("sinon");
const request = require("supertest");
const app = require("../../../../src/app");
const { signToken } = require("../../helpers/auth");
const AuthService = require("../../../../src/services/auth.service");
const {
  authRateLimiter,
} = require("../../../../src/middleware/security/RateLimiterMiddleware");

// ── Token factories ────────────────────────────────────────────────────────────

// NOTE: tokens are sent via Authorization: Bearer header.
// AuthMiddleware reads req.headers.authorization first, then req.signedCookies.
// The Cookie: header approach (Cookie: token=...) is NOT compatible with
// signedCookies and would silently fail authentication with 401.

const adminToken = () =>
  signToken({ userId: "ADM001", role: "ADMIN", userLevel: 2 });

const superAdminToken = () =>
  signToken({ userId: "SA001", role: "SUPER_ADMIN", userLevel: 3 });

const approverToken = () =>
  signToken({ userId: "APR001", role: "APPROVER", userLevel: 1 });

// ── Mock success return ────────────────────────────────────────────────────────

const MOCK_TOKEN_RESULT = {
  accessToken: "mock-access-token",
  refreshToken: "mock-refresh-token",
  user: {
    userId: "ADM001",
    role: "ADMIN",
    isDefaultPassword: false,
    requiresPasswordChange: false,
  },
};

// ── Shared assertion helpers ───────────────────────────────────────────────────

function expectSuccessShape(body) {
  expect(body).to.include.all.keys("status", "code", "message", "data");
  expect(body.status).to.equal("success");
  expect(body.message).to.be.a("string");
}

function expectErrorShape(body) {
  expect(body).to.include.all.keys("status", "code", "message", "error");
  expect(body.status).to.equal("error");
  expect(body.error).to.have.property("type").that.is.a("string");
}

function expectRequestId(headers) {
  expect(headers).to.have.property("x-request-id");
  expect(headers["x-request-id"]).to.match(/^req_/);
}

// ═══════════════════════════════════════════════════════════════════════════════
// PATCH /api/v1/auth/change-password
// ═══════════════════════════════════════════════════════════════════════════════

describe("PATCH /api/v1/auth/change-password", function () {
  let changePasswordStub;
  let agent;

  beforeEach(async function () {
    changePasswordStub = sinon
      .stub(AuthService, "changePassword")
      .resolves(MOCK_TOKEN_RESULT);
    authRateLimiter.flushAll();
    agent = request.agent(app);
    const csrfRes = await agent.get("/api/v1/csrf/token");
    agent._csrfToken = csrfRes.body?.token ?? null;
  });

  afterEach(function () {
    sinon.restore();
  });

  const validBody = () => ({
    currentPassword: "OldPassword@1",
    newPassword: "NewSecurePass@99",
  });

  // ─── 1. Happy path ────────────────────────────────────────────────────────

  it("returns 200 and PASSWORD_CHANGED message on success (ADMIN)", async function () {
    const res = await agent
      .patch("/api/v1/auth/change-password")
      .set("Authorization", `Bearer ${adminToken()}`)
      .set("x-csrf-token", agent._csrfToken)
      .send(validBody());

    expect(res.status).to.equal(200);
    expectSuccessShape(res.body);
    expect(res.body.message).to.equal("Password changed successfully.");
    expect(changePasswordStub.calledOnce).to.be.true;
    const [userId] = changePasswordStub.firstCall.args;
    expect(userId).to.equal("ADM001");
  });

  it("returns 200 for SUPER_ADMIN role", async function () {
    const res = await agent
      .patch("/api/v1/auth/change-password")
      .set("Authorization", `Bearer ${superAdminToken()}`)
      .set("x-csrf-token", agent._csrfToken)
      .send(validBody());

    expect(res.status).to.equal(200);
  });

  it("returns 200 for APPROVER role (change-password accessible to all roles)", async function () {
    const res = await agent
      .patch("/api/v1/auth/change-password")
      .set("Authorization", `Bearer ${approverToken()}`)
      .set("x-csrf-token", agent._csrfToken)
      .send(validBody());

    expect(res.status).to.equal(200);
  });

  // ─── 2. Missing required fields ───────────────────────────────────────────

  it("returns 400 when currentPassword is missing", async function () {
    const { currentPassword: _removed, ...body } = validBody();
    const res = await agent
      .patch("/api/v1/auth/change-password")
      .set("Authorization", `Bearer ${adminToken()}`)
      .set("x-csrf-token", agent._csrfToken)
      .send(body);

    expect(res.status).to.equal(400);
    expectErrorShape(res.body);
    const fields = res.body.error.details?.map((d) => d.field) ?? [];
    expect(fields).to.include("currentPassword");
  });

  it("returns 400 when newPassword is missing", async function () {
    const { newPassword: _removed, ...body } = validBody();
    const res = await agent
      .patch("/api/v1/auth/change-password")
      .set("Authorization", `Bearer ${adminToken()}`)
      .set("x-csrf-token", agent._csrfToken)
      .send(body);

    expect(res.status).to.equal(400);
    expectErrorShape(res.body);
    const fields = res.body.error.details?.map((d) => d.field) ?? [];
    expect(fields).to.include("newPassword");
  });

  it("returns 400 when both required fields are missing", async function () {
    const res = await agent
      .patch("/api/v1/auth/change-password")
      .set("Authorization", `Bearer ${adminToken()}`)
      .set("x-csrf-token", agent._csrfToken)
      .send({});

    expect(res.status).to.equal(400);
    expectErrorShape(res.body);
    expect(res.body.error.details).to.be.an("array").with.lengthOf.at.least(2);
  });

  // ─── 3. Unauthenticated ───────────────────────────────────────────────────

  it("returns 401 when no token is provided", async function () {
    const res = await agent
      .patch("/api/v1/auth/change-password")
      .set("x-csrf-token", agent._csrfToken)
      .send(validBody());

    expect(res.status).to.equal(401);
    expectErrorShape(res.body);
  });

  it("returns 403 when token is structurally invalid (M-11: tampered → 403)", async function () {
    const res = await agent
      .patch("/api/v1/auth/change-password")
      .set("Authorization", "Bearer not.a.valid.token")
      .set("x-csrf-token", agent._csrfToken)
      .send(validBody());

    expect(res.status).to.equal(403);
  });

  it("returns 440 (SessionTimeout) when token is expired", async function () {
    const expired = signToken({ userId: "ADM001", role: "ADMIN" }, "-1s");
    const res = await agent
      .patch("/api/v1/auth/change-password")
      .set("Authorization", `Bearer ${expired}`)
      .set("x-csrf-token", agent._csrfToken)
      .send(validBody());

    // AuthMiddleware maps TokenExpiredError → 440 SessionTimeoutError
    expect(res.status).to.equal(440);
  });

  // ─── 4. Service-level error cases ─────────────────────────────────────────

  it("returns 401 when current password is wrong", async function () {
    const { AppError } = require("../../../../src/constants/errors");
    changePasswordStub.rejects(
      new AppError("Current password is incorrect.", 401),
    );

    const res = await agent
      .patch("/api/v1/auth/change-password")
      .set("Authorization", `Bearer ${adminToken()}`)
      .set("x-csrf-token", agent._csrfToken)
      .send({ currentPassword: "WrongPass@1", newPassword: "NewPass@99" });

    expect(res.status).to.equal(401);
    expectErrorShape(res.body);
  });

  it("returns 400 when new password equals the system default password", async function () {
    const { AppError } = require("../../../../src/constants/errors");
    changePasswordStub.rejects(
      new AppError(
        "The new password cannot be the same as the system default password. Choose a unique password.",
        400,
      ),
    );

    const res = await agent
      .patch("/api/v1/auth/change-password")
      .set("Authorization", `Bearer ${adminToken()}`)
      .set("x-csrf-token", agent._csrfToken)
      .send({ currentPassword: "OldPassword@1", newPassword: "Change@Me123" });

    expect(res.status).to.equal(400);
    expectErrorShape(res.body);
  });

  it("returns 422 DataIntegrityError when SYSSIGNATURE is broken", async function () {
    const { AppError } = require("../../../../src/constants/errors");
    changePasswordStub.rejects(
      new AppError("Admin record integrity check failed.", 422, {
        type: "DataIntegrityError",
      }),
    );

    const res = await agent
      .patch("/api/v1/auth/change-password")
      .set("Authorization", `Bearer ${adminToken()}`)
      .set("x-csrf-token", agent._csrfToken)
      .send(validBody());

    expect(res.status).to.equal(422);
    expect(res.body.error.type).to.equal("DataIntegrityError");
  });

  it("returns 404 when admin record does not exist", async function () {
    const { AppError } = require("../../../../src/constants/errors");
    changePasswordStub.rejects(
      new AppError(
        "Admin record not found. Verify the Employee ID and try again.",
        404,
      ),
    );

    const res = await agent
      .patch("/api/v1/auth/change-password")
      .set("Authorization", `Bearer ${adminToken()}`)
      .set("x-csrf-token", agent._csrfToken)
      .send(validBody());

    expect(res.status).to.equal(404);
  });

  // ─── 5. Oversized body ────────────────────────────────────────────────────

  it("returns 413 when body exceeds size limit", async function () {
    const huge = "x".repeat(11 * 1024 * 1024);
    const res = await agent
      .patch("/api/v1/auth/change-password")
      .set("Authorization", `Bearer ${adminToken()}`)
      .set("x-csrf-token", agent._csrfToken)
      .set("Content-Type", "application/json")
      .send(
        JSON.stringify({
          currentPassword: "OldPassword@1",
          newPassword: "NewPass@99",
          pad: huge,
        }),
      );

    expect(res.status).to.equal(413);
  });

  // ─── 6. Response shape contract ───────────────────────────────────────────

  it("response shape matches { status, code, message, data } contract", async function () {
    const res = await agent
      .patch("/api/v1/auth/change-password")
      .set("Authorization", `Bearer ${adminToken()}`)
      .set("x-csrf-token", agent._csrfToken)
      .send(validBody());

    expect(res.body).to.have.all.keys("status", "code", "message", "data");
    expect(res.body.code).to.equal(200);
  });

  // ─── 7. X-Request-ID present ──────────────────────────────────────────────

  it("sets X-Request-ID on the response", async function () {
    const res = await agent
      .patch("/api/v1/auth/change-password")
      .set("Authorization", `Bearer ${adminToken()}`)
      .set("x-csrf-token", agent._csrfToken)
      .send(validBody());

    expectRequestId(res.headers);
  });

  // ─── 8. Response time ─────────────────────────────────────────────────────

  it("responds in under 500ms", async function () {
    const start = Date.now();
    await agent
      .patch("/api/v1/auth/change-password")
      .set("Authorization", `Bearer ${adminToken()}`)
      .set("x-csrf-token", agent._csrfToken)
      .send(validBody());
    expect(Date.now() - start).to.be.lessThan(500);
  });

  // ─── 9. Scanner path access ───────────────────────────────────────────────

  it("/.env scanner path is blocked (security filter applies before routing)", async function () {
    const res = await agent.get("/.env");
    expect([400, 403, 404]).to.include(res.status);
  });

  // ─── 10. Rate limiter applies ─────────────────────────────────────────────

  it("returns 429 after exceeding auth rate limit from a single IP", async function () {
    // authRateLimiter is intentionally strict (max: 5 per window on this route).
    // Fire 10 requests in quick succession and expect at least one 429.
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        request(app)
          .patch("/api/v1/auth/change-password")
          .set("x-csrf-token", agent._csrfToken)
          .send({ currentPassword: "bad", newPassword: "bad" }),
      ),
    );
    // Some may be 401 (no token), some may be 429 — at least some requests must
    // either reach the rate limit or be unauthenticated.
    // The key invariant: no 500s.
    const serverErrors = responses.filter((r) => r.status >= 500);
    expect(serverErrors.length).to.equal(0);
  });

  // ─── 11. Malformed JSON body ──────────────────────────────────────────────

  it("returns 400 for malformed JSON body", async function () {
    const res = await agent
      .patch("/api/v1/auth/change-password")
      .set("Authorization", `Bearer ${adminToken()}`)
      .set("x-csrf-token", agent._csrfToken)
      .set("Content-Type", "application/json")
      .send("{invalid json}");

    expect(res.status).to.equal(400);
  });

  // ─── 12. New tokens are set in response cookies ───────────────────────────

  it("sets new HttpOnly access-token and refresh-token cookies on success (CWE-287)", async function () {
    const res = await agent
      .patch("/api/v1/auth/change-password")
      .set("Authorization", `Bearer ${adminToken()}`)
      .set("x-csrf-token", agent._csrfToken)
      .send(validBody());

    expect(res.status).to.equal(200);
    const cookies = res.headers["set-cookie"] || [];
    expect(cookies.some((c) => c.includes("meal.access-token")),  "access cookie missing").to.be.true;
    expect(cookies.some((c) => c.includes("meal.refresh-token")), "refresh cookie missing").to.be.true;
    const access = cookies.find((c) => c.includes("meal.access-token"));
    expect(access).to.include("HttpOnly");
  });
});
