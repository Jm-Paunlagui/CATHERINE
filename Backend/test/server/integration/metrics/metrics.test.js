"use strict";

/**
 * @fileoverview Integration tests for the /api/v1/metrics resource.
 *
 * Route map (from metrics.route.js):
 *   GET  /api/v1/metrics           Full snapshot  (auth: userLevel >= 2)
 *   GET  /api/v1/metrics/summary   Summary        (auth: userLevel >= 1)
 *   GET  /api/v1/metrics/alerts    Alert evals    (auth: userLevel >= 2)
 *   POST /api/v1/metrics/frontend  FE ingestion   (no auth — rate-limited)
 *
 * MetricsService is stubbed for all tests to keep assertions deterministic
 * and independent of in-process accumulation during the test run.
 *
 * Covers:
 *   - Happy paths for all 4 endpoints
 *   - Auth enforcement (401 / 403) on authenticated routes
 *   - Response shape contract { status, code, message, data }
 *   - X-Request-ID on every response
 *   - CSRF gate on POST /frontend
 *   - Oversized body → 413
 *   - Expired token → 440
 */

const request = require("supertest");
const app = require("../../../../src/app");
const { signToken } = require("../../helpers/auth");
const MetricsService = require("../../../../src/services/MetricsService");
const {
    defaultRateLimiter,
} = require("../../../../src/middleware/security/RateLimiterMiddleware");

// ── Rate-limit isolation ───────────────────────────────────────────────────────
// When the full suite runs, other test files fire many requests against the same
// loopback IP (127.0.0.1) and exhaust the sliding-window counter in the shared
// in-process defaultRateLimiter store before this file executes.  Flushing the
// store at the start of this file gives these tests a clean slate without
// weakening the production limiter in any way (the store is in-memory only).
beforeAll(function () {
    defaultRateLimiter.flushAll();
});

// ── Token factories ───────────────────────────────────────────────────────────

const adminToken = () =>
    signToken({ userId: "ADM001", role: "ADMIN", userLevel: 2 });
const superToken = () =>
    signToken({ userId: "SA001", role: "SUPER_ADMIN", userLevel: 3 });
const approverToken = () =>
    signToken({ userId: "APR001", role: "APPROVER", userLevel: 1 });

// ── Stub return values ────────────────────────────────────────────────────────

const MOCK_SNAPSHOT = { requests: { total: 200, errors: 4 }, uptime: 3600 };
const MOCK_SUMMARY = { total: 200, errorRate: 0.02, topSlowRoutes: [] };
const MOCK_ALERTS = [];

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

function expectRequestId(headers) {
    expect(headers["x-request-id"]).toMatch(/^(\d{13}-\d{4}-\d{4}|req_.+)$/);
}

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/metrics  (userLevel >= 2)
// ═══════════════════════════════════════════════════════════════════════════════

describe("GET /api/v1/metrics — full snapshot", function () {
    beforeEach(function () {
        vi.spyOn(MetricsService, "getSnapshot").mockReturnValue(MOCK_SNAPSHOT);
    });

    afterEach(function () {
        vi.restoreAllMocks();
    });

    it("returns 200 with snapshot in data (ADMIN, userLevel 2)", async function () {
        const res = await request(app)
            .get("/api/v1/metrics")
            .set("Authorization", `Bearer ${adminToken()}`);

        expect(res.status).toBe(200);
        expectSuccessShape(res.body);
        expect(MetricsService.getSnapshot).toHaveBeenCalledTimes(1);
    });

    it("returns 200 for SUPER_ADMIN (userLevel 3)", async function () {
        const res = await request(app)
            .get("/api/v1/metrics")
            .set("Authorization", `Bearer ${superToken()}`);
        expect(res.status).toBe(200);
    });

    it("returns 401 when no Authorization header is provided", async function () {
        const res = await request(app).get("/api/v1/metrics");
        expect(res.status).toBe(401);
        expectErrorShape(res.body);
    });

    it("returns 403 for APPROVER (userLevel 1 < 2 required)", async function () {
        const res = await request(app)
            .get("/api/v1/metrics")
            .set("Authorization", `Bearer ${approverToken()}`);
        expect(res.status).toBe(403);
        expectErrorShape(res.body);
    });

    it("returns 440 for expired token (AuthMiddleware maps TokenExpiredError → 440)", async function () {
        const expired = signToken({ userId: "ADM001" }, "-1s");
        const res = await request(app)
            .get("/api/v1/metrics")
            .set("Authorization", `Bearer ${expired}`);
        expect(res.status).toBe(440);
    });

    it("X-Request-ID is present on success", async function () {
        const res = await request(app)
            .get("/api/v1/metrics")
            .set("Authorization", `Bearer ${adminToken()}`);
        expectRequestId(res.headers);
    });

    it("responds in under 500ms", async function () {
        const start = Date.now();
        await request(app)
            .get("/api/v1/metrics")
            .set("Authorization", `Bearer ${adminToken()}`);
        expect(Date.now() - start).toBeLessThan(500);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/metrics/summary  (userLevel >= 1)
// ═══════════════════════════════════════════════════════════════════════════════

describe("GET /api/v1/metrics/summary — summary", function () {
    beforeEach(function () {
        vi.spyOn(MetricsService, "getSummary").mockReturnValue(MOCK_SUMMARY);
    });

    afterEach(function () {
        vi.restoreAllMocks();
    });

    it("returns 200 for APPROVER (userLevel 1 meets threshold)", async function () {
        const res = await request(app)
            .get("/api/v1/metrics/summary")
            .set("Authorization", `Bearer ${approverToken()}`);
        expect(res.status).toBe(200);
        expectSuccessShape(res.body);
    });

    it("returns 200 for ADMIN (userLevel 2 > 1 required)", async function () {
        const res = await request(app)
            .get("/api/v1/metrics/summary")
            .set("Authorization", `Bearer ${adminToken()}`);
        expect(res.status).toBe(200);
    });

    it("returns 401 when unauthenticated", async function () {
        const res = await request(app).get("/api/v1/metrics/summary");
        expect(res.status).toBe(401);
        expectErrorShape(res.body);
    });

    it("X-Request-ID is present", async function () {
        const res = await request(app)
            .get("/api/v1/metrics/summary")
            .set("Authorization", `Bearer ${adminToken()}`);
        expectRequestId(res.headers);
    });

    it("responds in under 500ms", async function () {
        const start = Date.now();
        await request(app)
            .get("/api/v1/metrics/summary")
            .set("Authorization", `Bearer ${adminToken()}`);
        expect(Date.now() - start).toBeLessThan(500);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/metrics/alerts  (userLevel >= 2)
// ═══════════════════════════════════════════════════════════════════════════════

describe("GET /api/v1/metrics/alerts — alert evaluations", function () {
    beforeEach(function () {
        vi.spyOn(MetricsService, "evaluateAlerts").mockReturnValue(MOCK_ALERTS);
    });

    afterEach(function () {
        vi.restoreAllMocks();
    });

    it("returns 200 with { alerts, count } in data (ADMIN)", async function () {
        const res = await request(app)
            .get("/api/v1/metrics/alerts")
            .set("Authorization", `Bearer ${adminToken()}`);

        expect(res.status).toBe(200);
        expectSuccessShape(res.body);
        expect(res.body.data).toHaveProperty("alerts");
        expect(res.body.data).toHaveProperty("count");
        expect(res.body.data["count"]).toEqual(expect.any(Number));
        expect(MetricsService.evaluateAlerts).toHaveBeenCalledTimes(1);
    });

    it("returns 401 when unauthenticated", async function () {
        const res = await request(app).get("/api/v1/metrics/alerts");
        expect(res.status).toBe(401);
    });

    it("returns 403 for APPROVER (userLevel 1 < 2 required)", async function () {
        const res = await request(app)
            .get("/api/v1/metrics/alerts")
            .set("Authorization", `Bearer ${approverToken()}`);
        expect(res.status).toBe(403);
    });

    it("X-Request-ID is present", async function () {
        const res = await request(app)
            .get("/api/v1/metrics/alerts")
            .set("Authorization", `Bearer ${adminToken()}`);
        expectRequestId(res.headers);
    });

    it("responds in under 500ms", async function () {
        const start = Date.now();
        await request(app)
            .get("/api/v1/metrics/alerts")
            .set("Authorization", `Bearer ${adminToken()}`);
        expect(Date.now() - start).toBeLessThan(500);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/v1/metrics/frontend  (no auth — pre-auth telemetry ingestion)
// ═══════════════════════════════════════════════════════════════════════════════

describe("POST /api/v1/metrics/frontend — frontend ingestion", function () {
    let agent;
    let csrfToken;

    beforeAll(async function () {
        agent = request.agent(app);
        const tokenRes = await agent.get("/api/v1/csrf/token");
        csrfToken = tokenRes.body?.token ?? "";
    });

    beforeEach(function () {
        // Flush the module-level frontend ingest limiter (30 req/min per IP) —
        // it persists across the whole mocha process, so earlier suites hitting
        // /frontend from 127.0.0.1 can exhaust the window and cause spurious 429s.
        const {
            frontendIngestLimiter,
        } = require("../../../../src/routes/metrics.route");
        frontendIngestLimiter.flushAll();

        vi.spyOn(MetricsService, "ingestFrontendMetrics").mockResolvedValue();
    });

    afterEach(function () {
        vi.restoreAllMocks();
    });

    const validPayload = () => ({
        events: [
            {
                type: "web-vital",
                name: "LCP",
                value: 1200,
                timestamp: new Date().toISOString(),
            },
        ],
    });

    it("returns 200 with success shape when payload is valid (no auth required)", async function () {
        const res = await agent
            .post("/api/v1/metrics/frontend")
            .set("x-csrf-token", csrfToken)
            .send(validPayload());

        expect(res.status).toBe(200);
        expectSuccessShape(res.body);
        expect(MetricsService.ingestFrontendMetrics).toHaveBeenCalledTimes(1);
    });

    it("works without an Authorization header (pre-auth endpoint)", async function () {
        const res = await agent
            .post("/api/v1/metrics/frontend")
            .set("x-csrf-token", csrfToken)
            .send(validPayload());

        expect(res.status).toBe(200);
    });

    // This endpoint is intentionally CSRF-exempt: it is a pre-auth web-vitals
    // telemetry sink delivered via fetch+keepalive (page-unload path) which
    // cannot attach the x-csrf-token header. Abuse is bounded by the route's
    // dedicated 30 req/min rate limiter.
    it("accepts request without CSRF token (CSRF-exempt endpoint)", async function () {
        const res = await agent
            .post("/api/v1/metrics/frontend")
            .send(validPayload());

        expect(res.status).toBe(200);
    });

    it("accepts request with any CSRF token (CSRF-exempt endpoint)", async function () {
        const res = await agent
            .post("/api/v1/metrics/frontend")
            .set("x-csrf-token", "forged-csrf-xyz")
            .send(validPayload());

        expect(res.status).toBe(200);
    });

    it("returns 413 when body exceeds size limit", async function () {
        const huge = "x".repeat(11 * 1024 * 1024);
        const res = await agent
            .post("/api/v1/metrics/frontend")
            .set("x-csrf-token", csrfToken)
            .set("Content-Type", "application/json")
            .send(JSON.stringify({ pad: huge }));

        expect(res.status).toBe(413);
    });

    it("returns 400 for malformed JSON body", async function () {
        const res = await agent
            .post("/api/v1/metrics/frontend")
            .set("x-csrf-token", csrfToken)
            .set("Content-Type", "application/json")
            .send("{bad json}");

        expect(res.status).toBe(400);
    });

    it("X-Request-ID is present", async function () {
        const res = await agent
            .post("/api/v1/metrics/frontend")
            .set("x-csrf-token", csrfToken)
            .send(validPayload());

        expectRequestId(res.headers);
    });

    it("responds in under 500ms", async function () {
        const start = Date.now();
        await agent
            .post("/api/v1/metrics/frontend")
            .set("x-csrf-token", csrfToken)
            .send(validPayload());
        expect(Date.now() - start).toBeLessThan(500);
    });

    it("GET /api/v1/metrics/frontend is not a valid route (404 or 405)", async function () {
        const res = await agent.get("/api/v1/metrics/frontend");
        expect([404, 405]).toContain(res.status);
    });
});
