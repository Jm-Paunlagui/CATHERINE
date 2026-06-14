"use strict";

/**
 * @fileoverview Integration tests for POST /api/v1/auth/logout
 *                                   and GET  /api/v1/auth/me.
 *
 * Neither route calls AuthService — logout clears cookies only;
 * /me returns req.user from the decoded JWT. No stubs required.
 *
 * Auth tokens are sent via Authorization: Bearer header, which is the
 * mechanism AuthMiddleware reads first (before signedCookies).
 */

const { expect }    = require("chai");
const request       = require("supertest");
const jwt           = require("jsonwebtoken");
const app           = require("../../../../src/app");
const { signToken } = require("../../helpers/auth");
const { HTTP_STATUS } = require("../../../../src/constants");

// ─── Token factory ────────────────────────────────────────────────────────────

function adminToken(overrides = {}) {
  return signToken({ userId: "10001", userLevel: 2, role: "ADMIN", GID: 20001, ...overrides });
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/v1/auth/logout
// ═══════════════════════════════════════════════════════════════════════════════

describe("POST /api/v1/auth/logout — integration", function () {
  let agent;
  let csrfToken;

  before(async function () {
    this.timeout(10_000);
    agent = request.agent(app);
    const tokenRes = await agent.get("/api/v1/csrf/token");
    csrfToken = tokenRes.body?.token ?? "";
  });

  // ── 1. Happy path ───────────────────────────────────────────────────────────

  describe("happy path — authenticated user", function () {
    it("returns 200 with success status", async function () {
      const res = await agent
        .post("/api/v1/auth/logout")
        .set("Authorization", `Bearer ${adminToken()}`)
        .set("x-csrf-token", csrfToken);

      expect(res.status).to.equal(HTTP_STATUS.OK);
      expect(res.body.status).to.equal("success");
    });

    it("response includes status, code, message keys", async function () {
      const res = await agent
        .post("/api/v1/auth/logout")
        .set("Authorization", `Bearer ${adminToken()}`)
        .set("x-csrf-token", csrfToken);

      expect(res.body).to.include.keys("status", "code", "message");
    });

    it("clears the access-token cookie (Max-Age=0 or past Expires)", async function () {
      const res = await agent
        .post("/api/v1/auth/logout")
        .set("Authorization", `Bearer ${adminToken()}`)
        .set("x-csrf-token", csrfToken);

      const cookies = res.headers["set-cookie"] || [];
      const cleared = cookies.find((c) => c.includes("meal.access-token"));
      expect(cleared, "access-token clear instruction not found in Set-Cookie").to.exist;

      const isCleared =
        /Max-Age=0/i.test(cleared) ||
        /Expires=Thu, 01 Jan 1970/i.test(cleared) ||
        /Expires=([^;]+)/.test(cleared) && new Date(cleared.match(/Expires=([^;]+)/)?.[1]) < new Date();
      expect(isCleared, "cookie was not cleared (Max-Age or Expires not set to past)").to.be.true;
    });

    it("X-Request-ID header is present", async function () {
      const res = await agent
        .post("/api/v1/auth/logout")
        .set("Authorization", `Bearer ${adminToken()}`)
        .set("x-csrf-token", csrfToken);

      expect(res.headers).to.have.property("x-request-id");
    });

    it("responds in under 500ms", async function () {
      const start = Date.now();
      await agent
        .post("/api/v1/auth/logout")
        .set("Authorization", `Bearer ${adminToken()}`)
        .set("x-csrf-token", csrfToken);
      expect(Date.now() - start).to.be.lessThan(500);
    });
  });

  // ── 2. Authentication failures ──────────────────────────────────────────────

  describe("authentication failures", function () {
    it("no token → 401", async function () {
      const res = await agent
        .post("/api/v1/auth/logout")
        .set("x-csrf-token", csrfToken);

      expect(res.status).to.equal(401);
      expect(res.body.status).to.equal("error");
    });

    it("expired token → 440 (session timeout — AuthMiddleware code path)", async function () {
      const expired = signToken({ userId: "10001" }, "-1s");
      const res = await agent
        .post("/api/v1/auth/logout")
        .set("Authorization", `Bearer ${expired}`)
        .set("x-csrf-token", csrfToken);

      expect(res.status).to.equal(440);
    });

    it("token signed with wrong secret → 403 (JsonWebTokenError tampered — M-11)", async function () {
      const forged = jwt.sign({ sub: "hacker", userLevel: 99 }, "wrong-secret");
      const res = await agent
        .post("/api/v1/auth/logout")
        .set("Authorization", `Bearer ${forged}`)
        .set("x-csrf-token", csrfToken);

      expect(res.status).to.equal(403);
    });

    it("structurally invalid token string → 401", async function () {
      const res = await agent
        .post("/api/v1/auth/logout")
        .set("Authorization", "Bearer not.a.jwt")
        .set("x-csrf-token", csrfToken);

      expect(res.status).to.equal(401);
    });

    it("tampered payload (valid structure, wrong signature) → 403 (M-11: tampered → 403)", async function () {
      const valid = adminToken();
      const parts = valid.split(".");
      parts[1] = Buffer.from(
        JSON.stringify({ sub: "hacker", userId: "hacker", userLevel: 99 }),
      ).toString("base64url");
      const tampered = parts.join(".");

      const res = await agent
        .post("/api/v1/auth/logout")
        .set("Authorization", `Bearer ${tampered}`)
        .set("x-csrf-token", csrfToken);

      expect(res.status).to.equal(403);
    });
  });

  // ── 3. CSRF gate ────────────────────────────────────────────────────────────

  describe("CSRF protection", function () {
    it("POST without CSRF token → 403 even with valid JWT", async function () {
      const res = await agent
        .post("/api/v1/auth/logout")
        .set("Authorization", `Bearer ${adminToken()}`);

      expect(res.status).to.equal(403);
    });

    it("POST with forged CSRF token → 403", async function () {
      const res = await agent
        .post("/api/v1/auth/logout")
        .set("Authorization", `Bearer ${adminToken()}`)
        .set("x-csrf-token", "forged-csrf-token-xyz");

      expect(res.status).to.equal(403);
    });
  });

  // ── 4. Oversized body ───────────────────────────────────────────────────────

  it("oversized body → 413", async function () {
    const huge = Buffer.alloc(11 * 1024 * 1024, "x").toString();
    const res = await agent
      .post("/api/v1/auth/logout")
      .set("Authorization", `Bearer ${adminToken()}`)
      .set("x-csrf-token", csrfToken)
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ data: huge }));

    expect(res.status).to.equal(413);
  });

  // ── 5. Route method guard ────────────────────────────────────────────────────

  it("GET /api/v1/auth/logout is not a valid route (404 or 405)", async function () {
    const res = await agent.get("/api/v1/auth/logout");
    expect([404, 405]).to.include(res.status);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/auth/me
// ═══════════════════════════════════════════════════════════════════════════════

describe("GET /api/v1/auth/me — integration", function () {
  let agent;

  before(async function () {
    agent = request.agent(app);
  });

  it("authenticated → 200 with full JWT payload in data", async function () {
    const token = signToken({
      userId: "10001", GID: 20001, userLevel: 2, role: "ADMIN",
      firstName: "Juan", lastName: "Cruz", segmentCode: "HQ",
    });

    const res = await agent
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).to.equal(HTTP_STATUS.OK);
    expect(res.body.status).to.equal("success");
    expect(res.body.data.userId).to.equal("10001");
    expect(res.body.data.role).to.equal("ADMIN");
    expect(res.body.data.GID).to.equal(20001);
  });

  it("response conforms to { status, code, message, data } shape", async function () {
    const res = await agent
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(res.body).to.have.all.keys("status", "code", "message", "data");
  });

  it("X-Request-ID header is present", async function () {
    const res = await agent
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(res.headers).to.have.property("x-request-id");
  });

  it("no token → 401", async function () {
    const res = await agent.get("/api/v1/auth/me");
    expect(res.status).to.equal(401);
  });

  it("expired token → 440", async function () {
    const expired = signToken({ userId: "10001" }, "-1s");
    const res = await agent
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${expired}`);
    expect(res.status).to.equal(440);
  });

  it("responds in under 500ms (no DB call — reads from req.user)", async function () {
    const start = Date.now();
    await agent
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${adminToken()}`);
    expect(Date.now() - start).to.be.lessThan(500);
  });
});
