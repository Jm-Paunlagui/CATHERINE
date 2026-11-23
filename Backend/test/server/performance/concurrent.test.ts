"use strict";

const agent = require("../helpers/request");

describe("Concurrent Request Correctness", function () {
    it("handles 50 concurrent health checks without error", async function () {
        const results = await Promise.all(
            Array.from({ length: 50 }, () => agent.get("/api/v1/health")),
        );
        const errors = results.filter((r) => r.status >= 500);
        expect(errors.length).toBe(0);
    });

    it("every concurrent response has a unique X-Request-ID", async function () {
        const results = await Promise.all(
            Array.from({ length: 20 }, () => agent.get("/api/v1/health")),
        );
        const ids = results.map((r) => r.headers["x-request-id"]);
        const unique = new Set(ids);
        expect(unique.size).toBe(20);
    });

    it("50 concurrent POSTs to login all receive a valid JSON error (not crash)", async function () {
        const results = await Promise.all(
            Array.from({ length: 50 }, () =>
                agent
                    .post("/api/v1/auth/login")
                    .send({ username: "x", password: "x" }),
            ),
        );
        const crashes = results.filter((r) => r.status >= 500);
        expect(crashes.length).toBe(0);
    });
});
