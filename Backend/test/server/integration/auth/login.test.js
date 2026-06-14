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

const { expect }  = require("chai");
const sinon       = require("sinon");
const request     = require("supertest");
const app         = require("../../../../src/app");
const AuthService = require("../../../../src/services/auth.service");
const { AppError, AUTH_ERRORS } = require("../../../../src/constants/errors");
const { HTTP_STATUS }           = require("../../../../src/constants");
const {
  authRateLimiter,
} = require("../../../../src/middleware/security/RateLimiterMiddleware");

// ── Mock data ──────────────────────────────────────────────────────────────────

const MOCK_USER = {
  userId:                 "10001",
  GID:                    20001,
  userLevel:              2,
  role:                   "ADMIN",
  firstName:              "Juan",
  lastName:               "Cruz",
  segmentCode:            "HQ",
  segmentDesc:            "Headquarters",
  email:                  "jcruz@corp.com",
  loginSource:            "ua",
  isDefaultPassword:      false,
  requiresPasswordChange: false,
};

const MOCK_TOKENS = {
  user:         MOCK_USER,
  accessToken:  "mock.access.token",
  refreshToken: "mock.refresh.token",
};

// ─── Suite ────────────────────────────────────────────────────────────────────

describe("POST /api/v1/auth/login — integration", function () {
  let agent;
  let csrfToken;

  before(async function () {
    this.timeout(10_000);
    agent = request.agent(app);
    const tokenRes = await agent.get("/api/v1/csrf/token");
    csrfToken = tokenRes.body?.token ?? "";
  });

  beforeEach(function () {
    authRateLimiter.flushAll();
  });

  afterEach(function () {
    sinon.restore();
  });

  // ── 1. Happy path ───────────────────────────────────────────────────────────

  describe("happy path — valid credentials", function () {
    beforeEach(function () {
      sinon.stub(AuthService, "login").resolves(MOCK_TOKENS);
    });

    it("returns 200 with user object in data", async function () {
      const res = await agent
        .post("/api/v1/auth/login")
        .set("x-csrf-token", csrfToken)
        .send({ userId: "10001", password: "Correct@1234" });

      expect(res.status).to.equal(HTTP_STATUS.OK);
      expect(res.body.status).to.equal("success");
      expect(res.body.data).to.have.property("user");
      expect(res.body.data.user.userId).to.equal("10001");
      expect(res.body.data.user.role).to.equal("ADMIN");
    });

    it("sets HttpOnly access-token and refresh-token cookies (CWE-287)", async function () {
      const res = await agent
        .post("/api/v1/auth/login")
        .set("x-csrf-token", csrfToken)
        .send({ userId: "10001", password: "Correct@1234" });

      const cookies = res.headers["set-cookie"] || [];
      const accessCookie  = cookies.find((c) => c.includes("meal.access-token"));
      const refreshCookie = cookies.find((c) => c.includes("meal.refresh-token"));

      expect(accessCookie,  "access cookie missing").to.exist;
      expect(refreshCookie, "refresh cookie missing").to.exist;
      expect(accessCookie).to.include("HttpOnly");
      expect(refreshCookie).to.include("HttpOnly");
    });

    it("response conforms to { status, code, message, data } contract", async function () {
      const res = await agent
        .post("/api/v1/auth/login")
        .set("x-csrf-token", csrfToken)
        .send({ userId: "10001", password: "Correct@1234" });

      expect(res.body).to.have.all.keys("status", "code", "message", "data");
    });

    it("X-Request-ID header is present on every response", async function () {
      const res = await agent
        .post("/api/v1/auth/login")
        .set("x-csrf-token", csrfToken)
        .send({ userId: "10001", password: "Correct@1234" });

      expect(res.headers).to.have.property("x-request-id");
    });

    it("responds in under 500ms (hot path budget)", async function () {
      const start = Date.now();
      await agent
        .post("/api/v1/auth/login")
        .set("x-csrf-token", csrfToken)
        .send({ userId: "10001", password: "Correct@1234" });
      expect(Date.now() - start).to.be.lessThan(500);
    });

    it("does not expose the raw token values in the response body", async function () {
      const res = await agent
        .post("/api/v1/auth/login")
        .set("x-csrf-token", csrfToken)
        .send({ userId: "10001", password: "Correct@1234" });

      const body = JSON.stringify(res.body);
      expect(body).to.not.include("mock.access.token");
      expect(body).to.not.include("mock.refresh.token");
    });
  });

  // ── 2. Required field validation ────────────────────────────────────────────

  describe("required field validation — 400 responses", function () {
    it("missing userId → 400 with ValidationError and field details", async function () {
      const res = await agent
        .post("/api/v1/auth/login")
        .set("x-csrf-token", csrfToken)
        .send({ password: "some-password" });

      expect(res.status).to.equal(400);
      expect(res.body.error.type).to.equal("ValidationError");
      expect(res.body.error.details).to.be.an("array").that.is.not.empty;
      expect(res.body.error.details.some((d) => d.field === "userId")).to.be.true;
    });

    it("missing password → 400 with 'password' in details", async function () {
      const res = await agent
        .post("/api/v1/auth/login")
        .set("x-csrf-token", csrfToken)
        .send({ userId: "10001" });

      expect(res.status).to.equal(400);
      expect(res.body.error.details.some((d) => d.field === "password")).to.be.true;
    });

    it("empty body → 400 with both userId and password in details", async function () {
      const res = await agent
        .post("/api/v1/auth/login")
        .set("x-csrf-token", csrfToken)
        .send({});

      expect(res.status).to.equal(400);
      const fields = res.body.error.details.map((d) => d.field);
      expect(fields).to.include("userId");
      expect(fields).to.include("password");
    });

    it("oversized body → 413 (CWE-400 resource exhaustion)", async function () {
      const huge = Buffer.alloc(11 * 1024 * 1024, "x").toString();
      const res = await agent
        .post("/api/v1/auth/login")
        .set("x-csrf-token", csrfToken)
        .set("Content-Type", "application/json")
        .send(JSON.stringify({ userId: huge, password: "pw" }));

      expect(res.status).to.equal(413);
    });
  });

  // ── 3. Authentication failures ──────────────────────────────────────────────

  describe("authentication failures", function () {
    it("invalid credentials → 401 AuthenticationError", async function () {
      sinon.stub(AuthService, "login").rejects(
        new AppError(AUTH_ERRORS.INVALID_CREDENTIALS, 401, {
          type: "AuthenticationError",
        }),
      );

      const res = await agent
        .post("/api/v1/auth/login")
        .set("x-csrf-token", csrfToken)
        .send({ userId: "10001", password: "wrong-password" });

      expect(res.status).to.equal(401);
      expect(res.body.error.type).to.equal("AuthenticationError");
    });

    it("account locked (lockout window active) → 429 AccountLockedError", async function () {
      sinon.stub(AuthService, "login").rejects(
        new AppError(AUTH_ERRORS.ACCOUNT_LOCKED, 429, {
          type: "AccountLockedError",
          details: [{ field: "retryAfter", issue: "30" }],
        }),
      );

      const res = await agent
        .post("/api/v1/auth/login")
        .set("x-csrf-token", csrfToken)
        .send({ userId: "10001", password: "any" });

      expect(res.status).to.equal(429);
      expect(res.body.error.type).to.equal("AccountLockedError");
    });

    it("permanent lockout (all cycles exhausted, HR-reset) → 423", async function () {
      sinon.stub(AuthService, "login").rejects(
        new AppError(AUTH_ERRORS.ACCOUNT_LOCKED_PERMANENTLY, 423, {
          type: "AccountLockedError",
        }),
      );

      const res = await agent
        .post("/api/v1/auth/login")
        .set("x-csrf-token", csrfToken)
        .send({ userId: "10001", password: "any" });

      expect(res.status).to.equal(423);
    });

    it("account integrity failure (tampered record) → 422", async function () {
      sinon.stub(AuthService, "login").rejects(
        new AppError("Account integrity check failed.", 422, {
          type: "DataIntegrityError",
        }),
      );

      const res = await agent
        .post("/api/v1/auth/login")
        .set("x-csrf-token", csrfToken)
        .send({ userId: "10001", password: "any" });

      expect(res.status).to.equal(422);
    });
  });

  // ── 4. CSRF gate ────────────────────────────────────────────────────────────

  describe("CSRF protection", function () {
    it("POST without CSRF token → 403", async function () {
      const res = await agent
        .post("/api/v1/auth/login")
        .send({ userId: "10001", password: "pw" });

      expect(res.status).to.equal(403);
    });

    it("POST with a forged CSRF token → 403", async function () {
      const res = await agent
        .post("/api/v1/auth/login")
        .set("x-csrf-token", "forged-token-xyz-abc")
        .send({ userId: "10001", password: "pw" });

      expect(res.status).to.equal(403);
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
        sinon.stub(AuthService, "login").rejects(
          new AppError(AUTH_ERRORS.INVALID_CREDENTIALS, 401, {
            type: "AuthenticationError",
          }),
        );

        const res = await agent
          .post("/api/v1/auth/login")
          .set("x-csrf-token", csrfToken)
          .send({ userId: payload, password: payload });

        expect(res.status).to.not.equal(500);
        expect(res.body.status).to.equal("error");
      });
    });
  });

  // ── 6. Route not accessible via GET ─────────────────────────────────────────

  it("GET /api/v1/auth/login is not a valid route (405 or 404)", async function () {
    const res = await agent.get("/api/v1/auth/login");
    expect([404, 405]).to.include(res.status);
  });
});
