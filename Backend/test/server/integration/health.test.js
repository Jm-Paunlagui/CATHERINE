"use strict";

const agent = require("../helpers/request");

describe("GET /api/v1/health", function () {
    it('returns 200 with status "success"', async function () {
        const res = await agent.get("/api/v1/health");
        expect(res.status).toBe(200);
        expect(res.body.status).toBe("success");
    });

    it("response body includes uptime, timestamp, environment, and host", async function () {
        const res = await agent.get("/api/v1/health");
        const { data } = res.body;
        expect(data).toHaveProperty("uptime");
        expect(data["uptime"]).toEqual(expect.any(Number));
        expect(data).toHaveProperty("timestamp");
        expect(data).toHaveProperty("environment");
        expect(data).toHaveProperty("host");
    });

    it("responds in under 500ms", async function () {
        const start = Date.now();
        await agent.get("/api/v1/health");
        expect(Date.now() - start).toBeLessThan(500);
    });

    it("sets X-Request-ID header on every response", async function () {
        const res = await agent.get("/api/v1/health");
        expect(res.headers).toHaveProperty("x-request-id");
        expect(res.headers["x-request-id"]).toMatch(
            /^(\d{13}-\d{4}-\d{4}|req_.+)$/,
        );
    });
});
