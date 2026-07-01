"use strict";

/**
 * Integration tests for the /api/v1/metrics resource.
 *
 * Fires real HTTP requests through the full middleware stack (auth, CSRF, rate
 * limiting, response shaping). Verifies:
 *   - access control on each route (401 unauth, 403 under-privileged, 200 ok)
 *   - the snapshot carries the new memory ceiling + GC/leak instrumentation
 *   - the standard { status, code, message, data } envelope + X-Request-ID
 *   - frontend ingestion happy/sad paths (CSRF-protected POST)
 */

const request = require("supertest");
const agent = require("../helpers/request");
const app = require("../../../src/app");
const { signToken } = require("../helpers/auth");

const adminToken = signToken({ userLevel: 2 });
const userToken = signToken({ userLevel: 1 });

describe("GET /api/v1/metrics (snapshot, userLevel >= 2)", function () {
    it("returns 401 without a token", async function () {
        const res = await agent.get("/api/v1/metrics");
        expect(res.status).toBe(401);
    });

    it("returns 403 for an under-privileged user (level 1)", async function () {
        const res = await agent
            .get("/api/v1/metrics")
            .set("Authorization", `Bearer ${userToken}`);
        expect(res.status).toBe(403);
    });

    it("returns 200 with the standard envelope for an admin", async function () {
        const res = await agent
            .get("/api/v1/metrics")
            .set("Authorization", `Bearer ${adminToken}`);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            status: expect.anything(),
            code: expect.anything(),
            message: expect.anything(),
            data: expect.anything(),
        });
        expect(res.body.status).toBe("success");
    });

    it("snapshot exposes the real heap ceiling (heapSizeLimit)", async function () {
        const res = await agent
            .get("/api/v1/metrics")
            .set("Authorization", `Bearer ${adminToken}`);
        const { memory } = res.body.data.system;
        expect(memory).toHaveProperty("heapSizeLimit");
        expect(memory["heapSizeLimit"]).toEqual(expect.any(Number));
        expect(memory.heapSizeLimit).toBeGreaterThan(memory.heapTotal);
    });

    it("snapshot exposes GC breakdown, overhead, and the memoryTrend leak detector", async function () {
        const res = await agent
            .get("/api/v1/metrics")
            .set("Authorization", `Bearer ${adminToken}`);
        const { gc, memoryTrend } = res.body.data.system;
        expect(gc).toMatchObject({
            major: expect.anything(),
            minor: expect.anything(),
            incremental: expect.anything(),
            weakcb: expect.anything(),
            overheadPct: expect.anything(),
            recent: expect.anything(),
        });
        expect(memoryTrend).toMatchObject({
            suspected: expect.anything(),
            growthBytesPerMin: expect.anything(),
            windowMs: expect.anything(),
            sampleCount: expect.anything(),
        });
        expect(memoryTrend.suspected).toEqual(expect.any(Boolean));
    });

    it("sets X-Request-ID on the response", async function () {
        const res = await agent
            .get("/api/v1/metrics")
            .set("Authorization", `Bearer ${adminToken}`);
        expect(res.headers).toHaveProperty("x-request-id");
    });
});

describe("GET /api/v1/metrics/summary (userLevel >= 1)", function () {
    it("returns 401 without a token", async function () {
        expect((await agent.get("/api/v1/metrics/summary")).status).toBe(401);
    });

    it("returns 200 for a standard user and includes heapLimitMb", async function () {
        const res = await agent
            .get("/api/v1/metrics/summary")
            .set("Authorization", `Bearer ${userToken}`);
        expect(res.status).toBe(200);
        expect(res.body.data.system).toMatchObject({
            heapUsedMb: expect.anything(),
            heapTotalMb: expect.anything(),
            heapLimitMb: expect.anything(),
        });
    });
});

describe("GET /api/v1/metrics/alerts (userLevel >= 2)", function () {
    it("returns 403 for an under-privileged user", async function () {
        const res = await agent
            .get("/api/v1/metrics/alerts")
            .set("Authorization", `Bearer ${userToken}`);
        expect(res.status).toBe(403);
    });

    it("returns an alerts array + count for an admin", async function () {
        const res = await agent
            .get("/api/v1/metrics/alerts")
            .set("Authorization", `Bearer ${adminToken}`);
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveProperty("alerts");
        expect(res.body.data).toHaveProperty("count");
        expect(res.body.data["count"]).toEqual(expect.any(Number));
    });
});

describe("POST /api/v1/metrics/frontend (CSRF-exempt, no auth)", function () {
    // This endpoint is intentionally CSRF-exempt: it is a pre-auth web-vitals
    // telemetry sink delivered via fetch+keepalive (page-unload path) which
    // cannot attach the x-csrf-token header. CSRF protects authenticated
    // session-riding mutations — this endpoint has no session to ride.
    // Abuse is bounded by the route's dedicated 30 req/min rate limiter.
    let csrfAgent;
    let csrfToken;

    beforeEach(async function () {
        const {
            frontendIngestLimiter,
        } = require("../../../src/routes/metrics.route");
        frontendIngestLimiter.flushAll();

        csrfAgent = request.agent(app);
        const tokenRes = await csrfAgent.get("/api/v1/csrf/token");
        csrfToken = tokenRes.body.token;
    });

    it("accepts a POST without a CSRF token (CSRF-exempt endpoint)", async function () {
        const res = await csrfAgent
            .post("/api/v1/metrics/frontend")
            .send([{ type: "vital", name: "LCP", value: 1 }]);
        expect(res.status).toBe(200);
        expect(res.body.status).toBe("success");
    });

    it("accepts a valid vitals batch with a CSRF token (200)", async function () {
        const res = await csrfAgent
            .post("/api/v1/metrics/frontend")
            .set("x-csrf-token", csrfToken)
            .send([
                { type: "vital", name: "LCP", value: 1234, rating: "good" },
            ]);
        expect(res.status).toBe(200);
        expect(res.body.status).toBe("success");
    });

    it("rejects a non-array payload with 400 (not CSRF)", async function () {
        const res = await csrfAgent
            .post("/api/v1/metrics/frontend")
            .set("x-csrf-token", csrfToken)
            .send({ not: "an array" });
        expect(res.status).toBe(400);
    });

    it("rejects an oversized batch (>50 events) with 400", async function () {
        const payload = Array.from({ length: 51 }, () => ({
            type: "vital",
            name: "CLS",
            value: 0.1,
        }));
        const res = await csrfAgent
            .post("/api/v1/metrics/frontend")
            .set("x-csrf-token", csrfToken)
            .send(payload);
        expect(res.status).toBe(400);
    });
});
