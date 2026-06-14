"use strict";

/**
 * @fileoverview Cache reliability + chaos integration tests.
 *
 * These are HTTP-level tests that exercise the full Express middleware stack
 * via Supertest. AuditLogService is stubbed with Sinon so no real Oracle
 * connection is required.
 *
 * Target route: the audit-log feature (a kept, cached read route). This suite
 * was retargeted from the removed /rfid-management feature; the cache concerns
 * under test are feature-agnostic and apply to any CacheMiddleware.read route.
 *
 * What is under test:
 *   - X-Cache HIT / MISS / EXPIRED header behaviour on real GET routes
 *   - Cache key isolation between GET / (list) and GET /stats
 *   - Invalidation after a mutating DELETE (namespace wipe via delByPattern)
 *   - Auth guard runs BEFORE cache read — unauthenticated/unauthorised callers
 *     never receive a cached 200 (CWE-639 IDOR / BOLA protection)
 *   - Error responses from the service layer are never persisted in the cache
 *   - Thundering herd: 20 concurrent GETs all resolve to 200; cache is populated
 *   - Store flush during in-flight requests does not cause 500 errors
 *
 * Specialisations active:
 *   Senior Test Engineer · Senior Chaos & Resilience Engineer
 *   Senior Cybersecurity Engineer (CWE-639 cache-auth ordering)
 */

const { expect }  = require("chai");
const sinon       = require("sinon");
const request     = require("supertest");

const app                = require("../../../src/app");
const { signToken }      = require("../helpers/auth");
const AuditLogService    = require("../../../src/services/AuditLogService");
const { AppError }       = require("../../../src/constants/errors");
const { HTTP_STATUS }    = require("../../../src/constants");
const { registry }       = require("../../../src/middleware/cache");

// ─── Token factories ──────────────────────────────────────────────────────────

const adminToken      = () => signToken({ userId: "20001", role: "ADMIN",       userLevel: 2 });
const superAdminToken = () => signToken({ userId: "20002", role: "SUPER_ADMIN", userLevel: 3 });
const userToken       = () => signToken({ userId: "20005", role: "USER",        userLevel: 1 });

// ─── Mock payloads ────────────────────────────────────────────────────────────

const MOCK_LIST = {
  rows:     [{ REQUEST_ID: "req_aaa", METHOD: "GET", STATUS_CODE: 200, URL: "/api/v1/health" }],
  total:    1,
  page:     1,
  pageSize: 20,
};

const MOCK_STATS = {
  totalRequests: 42,
  errorRate:     0.05,
  topEndpoints:  [{ url: "/api/v1/health", count: 30 }],
};

// ── Service method aliases (actual static method names on AuditLogService) ──
//   getList    → called by GET /api/v1/audit-logs
//   getStats   → called by GET /api/v1/audit-logs/stats
//   deleteRange → called by DELETE /api/v1/audit-logs (SUPER_ADMIN only)

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve the auditLog CacheStore from the application registry.
 * @returns {import('../../../src/middleware/cache/CacheStore').CacheStore}
 */
function auditStore() {
  return registry.resolve("auditLog");
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe("Cache reliability — integration", function () {
  let agent;
  let csrfToken;

  before(async function () {
    this.timeout(15_000);
    agent = request.agent(app);
    const tokenRes = await agent.get("/api/v1/csrf/token");
    csrfToken = tokenRes.body?.token ?? "";
  });

  afterEach(function () {
    sinon.restore();
    // Wipe the auditLog store after each test so cache state from one
    // test cannot contaminate the next.
    auditStore().flush();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 1. HIT / MISS / MISS-after-flush header cycle
  // ─────────────────────────────────────────────────────────────────────────

  describe("HIT / MISS / EXPIRED headers", function () {
    it("first GET returns X-Cache: MISS (cold store)", async function () {
      sinon.stub(AuditLogService, "getList").resolves(MOCK_LIST);

      const res = await agent
        .get("/api/v1/audit-logs")
        .set("Authorization", `Bearer ${adminToken()}`);

      expect(res.status).to.equal(HTTP_STATUS.OK);
      expect(res.headers["x-cache"]).to.equal("MISS");
    });

    it("second GET on the same route (same agent, same token) returns X-Cache: HIT", async function () {
      sinon.stub(AuditLogService, "getList").resolves(MOCK_LIST);

      // First request populates the cache.
      await agent
        .get("/api/v1/audit-logs")
        .set("Authorization", `Bearer ${adminToken()}`);

      // Second request must be served from cache.
      const res = await agent
        .get("/api/v1/audit-logs")
        .set("Authorization", `Bearer ${adminToken()}`);

      expect(res.status).to.equal(HTTP_STATUS.OK);
      expect(res.headers["x-cache"]).to.equal("HIT");
    });

    it("GET after manual store flush returns X-Cache: MISS again", async function () {
      sinon.stub(AuditLogService, "getList").resolves(MOCK_LIST);

      // Populate cache.
      await agent
        .get("/api/v1/audit-logs")
        .set("Authorization", `Bearer ${adminToken()}`);

      // Manually flush the store (simulating TTL expiry or admin cache clear).
      auditStore().flush();

      // Must be a MISS after flush.
      const res = await agent
        .get("/api/v1/audit-logs")
        .set("Authorization", `Bearer ${adminToken()}`);

      expect(res.headers["x-cache"]).to.equal("MISS");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 2. Cache key isolation — different routes do NOT cross-contaminate
  // ─────────────────────────────────────────────────────────────────────────

  describe("cache key isolation", function () {
    it("GET / (list) and GET /stats use independent keys", async function () {
      const listStub  = sinon.stub(AuditLogService, "getList").resolves(MOCK_LIST);
      const statsStub = sinon.stub(AuditLogService, "getStats").resolves(MOCK_STATS);

      // Warm the list.
      const r1 = await agent
        .get("/api/v1/audit-logs")
        .set("Authorization", `Bearer ${adminToken()}`);
      expect(r1.headers["x-cache"]).to.equal("MISS");

      // First stats request must also be a MISS (different key).
      const r2 = await agent
        .get("/api/v1/audit-logs/stats")
        .set("Authorization", `Bearer ${adminToken()}`);
      expect(r2.headers["x-cache"]).to.equal("MISS");

      // Second calls to each should now be HITs.
      const r3 = await agent
        .get("/api/v1/audit-logs")
        .set("Authorization", `Bearer ${adminToken()}`);
      expect(r3.headers["x-cache"]).to.equal("HIT");

      const r4 = await agent
        .get("/api/v1/audit-logs/stats")
        .set("Authorization", `Bearer ${adminToken()}`);
      expect(r4.headers["x-cache"]).to.equal("HIT");

      // Response bodies must correspond to the correct dataset.
      expect(r3.body.data).to.have.property("rows");
      expect(r4.body.data).to.have.property("totalRequests");

      void listStub, statsStub;
    });

    it("HIT on GET / does not serve stats data (no cross-key pollution)", async function () {
      sinon.stub(AuditLogService, "getList").resolves(MOCK_LIST);
      sinon.stub(AuditLogService, "getStats").resolves(MOCK_STATS);

      // Warm stats first, then list.
      await agent
        .get("/api/v1/audit-logs/stats")
        .set("Authorization", `Bearer ${adminToken()}`);
      await agent
        .get("/api/v1/audit-logs")
        .set("Authorization", `Bearer ${adminToken()}`);

      // HIT on list must return list data.
      const hit = await agent
        .get("/api/v1/audit-logs")
        .set("Authorization", `Bearer ${adminToken()}`);

      expect(hit.headers["x-cache"]).to.equal("HIT");
      expect(hit.body.data).to.have.property("rows");
      expect(hit.body.data).to.not.have.property("totalRequests");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3. Invalidation after mutation
  //
  // In audit-log.route.js the CacheMiddleware.invalidate() handler is registered
  // BEFORE the controller on DELETE /:
  //
  //     router.delete("/",
  //       authenticate, requireAccess(isSuperAdmin),
  //       CacheMiddleware.invalidate(auditStore, () => "auditLog", { usePattern: true }),
  //       AuditLogController.deleteRange,            ← sends res.json() here
  //     );
  //
  // CacheMiddleware.invalidate() wraps res.json BEFORE calling next(), so placed
  // before the controller it fires on the controller's successful response and
  // wipes the namespace via delByPattern. The next GET is therefore a MISS.
  // ─────────────────────────────────────────────────────────────────────────

  describe("invalidation after DELETE mutation", function () {
    it("DELETE / returns 2xx (service layer works correctly with stubbed deleteRange)", async function () {
      this.timeout(10_000);

      sinon.stub(AuditLogService, "deleteRange").resolves({ deleted: 5 });

      const delRes = await agent
        .delete("/api/v1/audit-logs")
        .set("Authorization", `Bearer ${superAdminToken()}`)
        .set("x-csrf-token", csrfToken)
        .query({ fromDate: "2026-01-01", toDate: "2026-01-31" });

      expect(delRes.status).to.be.oneOf([200, 201, 202, 204]);
      expect(delRes.body.status).to.equal("success");
    });

    it("GET → MISS, GET → HIT, DELETE, GET → MISS (invalidation fires after successful mutation)", async function () {
      this.timeout(10_000);

      sinon.stub(AuditLogService, "getList").resolves(MOCK_LIST);
      sinon.stub(AuditLogService, "deleteRange").resolves({ deleted: 5 });

      // Step 1: Populate cache.
      const miss = await agent
        .get("/api/v1/audit-logs")
        .set("Authorization", `Bearer ${adminToken()}`);
      expect(miss.headers["x-cache"]).to.equal("MISS");

      // Step 2: Cache is warm.
      const hit = await agent
        .get("/api/v1/audit-logs")
        .set("Authorization", `Bearer ${adminToken()}`);
      expect(hit.headers["x-cache"]).to.equal("HIT");

      // Step 3: Mutate via DELETE.
      const delRes = await agent
        .delete("/api/v1/audit-logs")
        .set("Authorization", `Bearer ${superAdminToken()}`)
        .set("x-csrf-token", csrfToken)
        .query({ fromDate: "2026-01-01", toDate: "2026-01-31" });
      expect(delRes.status).to.be.oneOf([200, 201, 202, 204]);

      // Wait for any setImmediate callbacks.
      await new Promise((resolve) => setImmediate(resolve));

      // Step 4: Cache was invalidated by the successful DELETE — next GET is a MISS.
      const afterMutation = await agent
        .get("/api/v1/audit-logs")
        .set("Authorization", `Bearer ${adminToken()}`);

      expect(afterMutation.headers["x-cache"]).to.equal("MISS");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 4. Auth guard runs BEFORE cache read (CWE-639)
  // ─────────────────────────────────────────────────────────────────────────

  describe("auth guard before cache read (CWE-639)", function () {
    beforeEach(function () {
      // Pre-warm the cache so every GET route has a cached response.
      sinon.stub(AuditLogService, "getList").resolves(MOCK_LIST);
    });

    it("unauthenticated request returns 401, not 200 from cache", async function () {
      // Warm the cache with a valid admin call.
      await agent
        .get("/api/v1/audit-logs")
        .set("Authorization", `Bearer ${adminToken()}`);

      // Request with NO token must still be rejected by auth.
      const res = await agent.get("/api/v1/audit-logs");
      expect(res.status).to.equal(401);
    });

    it("wrong role (USER) returns 403, not 200 from cache", async function () {
      // Warm the cache.
      await agent
        .get("/api/v1/audit-logs")
        .set("Authorization", `Bearer ${adminToken()}`);

      // USER is excluded from isAdminOrSuperAdmin — must be 403.
      const res = await agent
        .get("/api/v1/audit-logs")
        .set("Authorization", `Bearer ${userToken()}`);
      expect(res.status).to.equal(403);
    });

    it("cache HIT body is never returned to an unauthenticated caller", async function () {
      // Warm the cache.
      await agent
        .get("/api/v1/audit-logs")
        .set("Authorization", `Bearer ${adminToken()}`);

      // Unauthenticated call — response body must be an error shape, not a data shape.
      const res = await agent.get("/api/v1/audit-logs");
      expect(res.body.status).to.equal("error");
      expect(res.body).to.not.have.property("data");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 5. Error responses never cached
  // ─────────────────────────────────────────────────────────────────────────

  describe("error responses not cached", function () {
    it("service throwing AppError (404): response is 404, not cached", async function () {
      sinon
        .stub(AuditLogService, "getList")
        .rejects(new AppError("Record not found", HTTP_STATUS.NOT_FOUND));

      const errRes = await agent
        .get("/api/v1/audit-logs")
        .set("Authorization", `Bearer ${adminToken()}`);

      expect(errRes.status).to.equal(HTTP_STATUS.NOT_FOUND);
    });

    it("subsequent GET after an error response is still a MISS (error was not stored)", async function () {
      // First call: service throws.
      sinon
        .stub(AuditLogService, "getList")
        .rejects(new AppError("Not found", HTTP_STATUS.NOT_FOUND));

      await agent
        .get("/api/v1/audit-logs")
        .set("Authorization", `Bearer ${adminToken()}`);

      sinon.restore();

      // Second call: service now works — must be MISS, not HIT on the error body.
      sinon.stub(AuditLogService, "getList").resolves(MOCK_LIST);

      const res = await agent
        .get("/api/v1/audit-logs")
        .set("Authorization", `Bearer ${adminToken()}`);

      expect(res.status).to.equal(HTTP_STATUS.OK);
      expect(res.headers["x-cache"]).to.equal("MISS");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 6. Thundering herd — 20 concurrent GETs on a cold cache
  // ─────────────────────────────────────────────────────────────────────────

  describe("thundering herd — concurrent GETs on cold cache", function () {
    it("all 20 concurrent GETs return 200 with valid data", async function () {
      this.timeout(15_000);

      const serviceStub = sinon.stub(AuditLogService, "getList").resolves(MOCK_LIST);

      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          agent
            .get("/api/v1/audit-logs")
            .set("Authorization", `Bearer ${adminToken()}`),
        ),
      );

      const errors   = results.filter((r) => r.status !== HTTP_STATUS.OK);
      const valid    = results.filter((r) => r.status === HTTP_STATUS.OK);

      expect(errors.length).to.equal(0);
      expect(valid.length).to.equal(20);

      // Service was called at least once (genuine DB hit on the cold path).
      expect(serviceStub.callCount).to.be.greaterThanOrEqual(1);
    });

    it("after the concurrent burst the next GET is a HIT (cache was populated)", async function () {
      this.timeout(15_000);

      sinon.stub(AuditLogService, "getList").resolves(MOCK_LIST);

      // Fire 20 concurrent requests.
      await Promise.all(
        Array.from({ length: 20 }, () =>
          agent
            .get("/api/v1/audit-logs")
            .set("Authorization", `Bearer ${adminToken()}`),
        ),
      );

      // Give any trailing setImmediate callbacks a chance to settle.
      await new Promise((resolve) => setImmediate(resolve));

      // The 21st request must be a HIT (at least one of the 20 stored the result).
      const follow = await agent
        .get("/api/v1/audit-logs")
        .set("Authorization", `Bearer ${adminToken()}`);

      expect(follow.headers["x-cache"]).to.equal("HIT");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 7. Store flush during in-flight requests does not crash the server
  // ─────────────────────────────────────────────────────────────────────────

  describe("store flush during in-flight requests", function () {
    it("flushing the store mid-burst: all requests complete with 200, no 500 errors", async function () {
      this.timeout(15_000);

      sinon.stub(AuditLogService, "getList").resolves(MOCK_LIST);

      // Start 10 concurrent requests without awaiting them.
      const inflightPromises = Array.from({ length: 10 }, () =>
        agent
          .get("/api/v1/audit-logs")
          .set("Authorization", `Bearer ${adminToken()}`),
      );

      // Flush the store while requests are in flight.
      auditStore().flush();

      const results = await Promise.all(inflightPromises);

      const crashes = results.filter((r) => r.status >= 500);
      expect(crashes.length).to.equal(0);

      // Every response must be valid JSON with the documented shape.
      results.forEach((r) => {
        expect(r.status).to.equal(HTTP_STATUS.OK);
        expect(r.body).to.have.property("status", "success");
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 8. X-Cache-Key header is present on every cached route response
  // ─────────────────────────────────────────────────────────────────────────

  describe("X-Cache-Key header presence", function () {
    it("X-Cache-Key is set on MISS response", async function () {
      sinon.stub(AuditLogService, "getList").resolves(MOCK_LIST);

      const res = await agent
        .get("/api/v1/audit-logs")
        .set("Authorization", `Bearer ${adminToken()}`);

      expect(res.headers).to.have.property("x-cache-key");
      expect(res.headers["x-cache-key"]).to.be.a("string").and.not.equal("");
    });

    it("X-Cache-Key is set on HIT response and matches the MISS key", async function () {
      sinon.stub(AuditLogService, "getList").resolves(MOCK_LIST);

      const miss = await agent
        .get("/api/v1/audit-logs")
        .set("Authorization", `Bearer ${adminToken()}`);

      const hit = await agent
        .get("/api/v1/audit-logs")
        .set("Authorization", `Bearer ${adminToken()}`);

      expect(hit.headers["x-cache-key"]).to.equal(miss.headers["x-cache-key"]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 9. Response shape contract preserved on HIT
  // ─────────────────────────────────────────────────────────────────────────

  describe("response shape on cache HIT", function () {
    it("cached response retains the full { status, code, message, data } shape", async function () {
      sinon.stub(AuditLogService, "getList").resolves(MOCK_LIST);

      // Prime the cache.
      await agent
        .get("/api/v1/audit-logs")
        .set("Authorization", `Bearer ${adminToken()}`);

      // Retrieve from cache.
      const res = await agent
        .get("/api/v1/audit-logs")
        .set("Authorization", `Bearer ${adminToken()}`);

      expect(res.headers["x-cache"]).to.equal("HIT");
      expect(res.body).to.have.all.keys("status", "code", "message", "data");
      expect(res.body.status).to.equal("success");
    });
  });
});
