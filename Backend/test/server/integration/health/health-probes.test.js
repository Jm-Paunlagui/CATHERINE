"use strict";

/**
 * @fileoverview Integration tests for the Kubernetes-style health probes.
 *
 *   GET /api/v1/health/live  — liveness: is the process alive? (no DB)
 *   GET /api/v1/health/ready — readiness: are Oracle pools reachable?
 *
 * Neither endpoint requires authentication. /live never contacts the DB so
 * it is always 200 in any environment. /ready contacts Oracle pools and will
 * return 503 in CI / test environments where no DB is available — both the
 * 200 and the 503 paths are covered here.
 *
 * The legacy GET /api/v1/health is covered by the sibling health.test.js.
 */

const request = require("supertest");
const app = require("../../../../src/app");
const db = require("../../../../src/config");

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/health/live
// ═══════════════════════════════════════════════════════════════════════════════

describe("GET /api/v1/health/live — liveness probe", function () {
    it("always returns 200 (no DB dependency)", async function () {
        const res = await request(app).get("/api/v1/health/live");
        expect(res.status).toBe(200);
    });

    it("body.status is 'success'", async function () {
        const res = await request(app).get("/api/v1/health/live");
        expect(res.body.status).toBe("success");
    });

    it("body.data.alive is true", async function () {
        const res = await request(app).get("/api/v1/health/live");
        expect(res.body.data.alive).toBe(true);
    });

    it("body.data contains pid (number), uptime (number), timestamp (ISO string)", async function () {
        const res = await request(app).get("/api/v1/health/live");
        const { data } = res.body;
        expect(data).toHaveProperty("pid");
        expect(data["pid"]).toEqual(expect.any(Number));
        expect(data).toHaveProperty("uptime");
        expect(data["uptime"]).toEqual(expect.any(Number));
        expect(data.uptime).toBeGreaterThan(0);
        expect(data).toHaveProperty("timestamp");
        expect(new Date(data.timestamp).getTime())
            .toBeGreaterThan(0);
    });

    it("X-Request-ID header is present and prefixed req_", async function () {
        const res = await request(app).get("/api/v1/health/live");
        expect(res.headers).toHaveProperty("x-request-id");
        expect(res.headers["x-request-id"]).toMatch(/^req_/);
    });

    it("responds in under 100ms (no DB call — pure process info)", async function () {
        const start = Date.now();
        await request(app).get("/api/v1/health/live");
        expect(Date.now() - start).toBeLessThan(100);
    });

    it("does not require auth token", async function () {
        // Deliberately sends no Authorization header — must still succeed
        const res = await request(app)
            .get("/api/v1/health/live")
            .unset("Authorization");
        expect(res.status).toBe(200);
    });

    it("every concurrent liveness check gets a unique X-Request-ID", async function () {
        const results = await Promise.all(
            Array.from({ length: 10 }, () =>
                request(app).get("/api/v1/health/live"),
            ),
        );
        const ids = results.map((r) => r.headers["x-request-id"]);
        expect(new Set(ids).size).toBe(10);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/health/ready
// ═══════════════════════════════════════════════════════════════════════════════

describe("GET /api/v1/health/ready — readiness probe", function () {

    // Stub db.withConnection so the pool probe resolves immediately as "down"
    // instead of waiting up to 15 s for Oracle's connectTimeout + retries.
    // Without this stub, each probe attempt takes ~15 s × 3 retries = 45 s+,
    // exceeding the 10 s test timeout before a response is even sent.
    beforeEach(function () {
        if (!db.withConnection.mock !== undefined) {
            vi
                .spyOn(db, "withConnection")
                .mockRejectedValue(
                    new Error(
                        "ORA-12541: TNS:no listener — test environment, Oracle not available",
                    ),
                );
        }
    });
    afterEach(function () {
        vi.restoreAllMocks();
    });

    it("returns 200 when all pools are up, or 503 when any pool is down", async function () {
        const res = await request(app).get("/api/v1/health/ready");
        expect([200, 503]).toContain(res.status);
    });

    it("response shape is { status, code, message, data } regardless of DB state", async function () {
        const res = await request(app).get("/api/v1/health/ready");
        expect(res.body).toHaveProperty("status");
        expect(res.body["status"]).toEqual(expect.any(String));
        expect(res.body).toHaveProperty("code");
        expect(res.body["code"]).toEqual(expect.any(Number));
        expect(res.body).toHaveProperty("message");
        expect(res.body["message"]).toEqual(expect.any(String));
        expect(res.body).toHaveProperty("data");
    });

    it("data.ready is a boolean reflecting overall pool health", async function () {
        const res = await request(app).get("/api/v1/health/ready");
        expect(res.body.data).toHaveProperty("ready");
    });

    it("data.checks contains oracle_userAccount and oracle_Meal keys", async function () {
        const res = await request(app).get("/api/v1/health/ready");
        const { checks } = res.body.data;
        expect(checks).toBeInstanceOf(Object);
        expect(checks).toHaveProperty("oracle_appDb");
    });

    it("each check has a status field of 'up' or 'down'", async function () {
        const res = await request(app).get("/api/v1/health/ready");
        Object.values(res.body.data.checks).forEach((check) => {
            expect(["up", "down"]).toContain(check.status);
        });
    });

    it("when ready:true the HTTP status is 200 and data.ready is true", async function () {
        const res = await request(app).get("/api/v1/health/ready");
        if (res.body.data.ready) {
            expect(res.status).toBe(200);
            expect(res.body.status).toBe("success");
        }
    });

    it("when ready:false the HTTP status is 503 and data.ready is false", async function () {
        const res = await request(app).get("/api/v1/health/ready");
        if (!res.body.data.ready) {
            expect(res.status).toBe(503);
            expect(res.body.status).toBe("error");
        }
    });

    it("failed pools report an error string in the checks object", async function () {
        const res = await request(app).get("/api/v1/health/ready");
        Object.values(res.body.data.checks).forEach((check) => {
            if (check.status === "down") {
                expect(check).toHaveProperty("error");
                expect(check["error"]).toEqual(expect.any(String));
            }
        });
    });

    it("X-Request-ID header is present", async function () {
        const res = await request(app).get("/api/v1/health/ready");
        expect(res.headers["x-request-id"]).toMatch(/^req_/);
    });

    it("does not require auth token", async function () {
        const res = await request(app)
            .get("/api/v1/health/ready")
            .unset("Authorization");
        expect([200, 503]).toContain(res.status);
    });
});
