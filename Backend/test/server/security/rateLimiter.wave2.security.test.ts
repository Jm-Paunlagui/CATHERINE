/**
 * @fileoverview Security + integration: rate limit headers and 429 envelope
 * through a real Express app; spoofed X-Forwarded-For cannot rotate buckets;
 * health probes cannot be used to exhaust the budget.
 */
import express from "express";
import request from "supertest";

vi.mock("../../../src/utils/logger", () => ({
    logger: { notice: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { RateLimiterMiddleware } from "../../../src/middleware/security/RateLimiterMiddleware";

function appWith(rl: RateLimiterMiddleware) {
    const app = express();
    app.use(rl.handle);
    app.get("/api/v1/things", (_req, res) => { res.json({ ok: true }); });
    app.get("/api/v1/health/ready", (_req, res) => { res.json({ ready: true }); });
    return app;
}

describe("RateLimiter over HTTP", () => {
    it("advertises RateLimit-* headers and decrements remaining", async () => {
        const app = appWith(new RateLimiterMiddleware({ max: 3, windowMs: 60_000 }));
        const a = await request(app).get("/api/v1/things");
        const b = await request(app).get("/api/v1/things");
        expect(a.headers["ratelimit-limit"]).toBe("3");
        expect(a.headers["ratelimit-policy"]).toBe("3;w=60");
        expect(Number(a.headers["ratelimit-remaining"])).toBe(2);
        expect(Number(b.headers["ratelimit-remaining"])).toBe(1);
        expect(Number(a.headers["ratelimit-reset"])).toBeGreaterThan(0);
    });

    it("returns a 429 envelope with Retry-After and no internals", async () => {
        const app = appWith(new RateLimiterMiddleware({ max: 1, windowMs: 60_000 }));
        await request(app).get("/api/v1/things");
        const res = await request(app).get("/api/v1/things");
        expect(res.status).toBe(429);
        expect(Number(res.headers["retry-after"])).toBeGreaterThanOrEqual(1);
        expect(res.body).toMatchObject({ status: "error", code: 429, error: { type: "RateLimitExceeded" } });
        expect(res.text).not.toMatch(/rl:ip|stack|node_modules/);
    });

    it("rotating X-Forwarded-For does not grant a fresh bucket", async () => {
        const app = appWith(new RateLimiterMiddleware({ max: 2, windowMs: 60_000 }));
        await request(app).get("/api/v1/things").set("X-Forwarded-For", "1.1.1.1");
        await request(app).get("/api/v1/things").set("X-Forwarded-For", "2.2.2.2");
        const res = await request(app).get("/api/v1/things").set("X-Forwarded-For", "3.3.3.3");
        expect(res.status).toBe(429);
    });

    it("health probes are exempt and never consume the budget", async () => {
        const app = appWith(new RateLimiterMiddleware({ max: 1, windowMs: 60_000 }));
        for (let i = 0; i < 5; i++) expect((await request(app).get("/api/v1/health/ready")).status).toBe(200);
        expect((await request(app).get("/api/v1/things")).status).toBe(200);
    });

    it("CORS preflights are never counted", async () => {
        const app = appWith(new RateLimiterMiddleware({ max: 1, windowMs: 60_000 }));
        for (let i = 0; i < 3; i++) await request(app).options("/api/v1/things");
        expect((await request(app).get("/api/v1/things")).status).toBe(200);
    });
});
