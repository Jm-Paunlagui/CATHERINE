"use strict";

const request = require("supertest");
const app = require("../../../src/app");

describe("CSRF Integration", function () {
    let agent;

    beforeEach(function () {
        agent = request.agent(app);
    });

    describe("GET /api/v1/csrf/token", function () {
        it("returns a token with success: true", async function () {
            const res = await agent.get("/api/v1/csrf/token");
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.token).toEqual(expect.any(String)).with.length.greaterThan(0);
        });

        it("returns cookieName, headerName, expiresIn, expiresAt", async function () {
            const res = await agent.get("/api/v1/csrf/token");
            expect(res.body).toHaveProperty("cookieName");
            expect(res.body["cookieName"]).toEqual(expect.any(String));
            expect(res.body).toHaveProperty("headerName", "x-csrf-token");
            expect(res.body).toHaveProperty("expiresIn");
            expect(res.body["expiresIn"]).toEqual(expect.any(Number));
            expect(res.body).toHaveProperty("expiresAt");
            expect(res.body["expiresAt"]).toEqual(expect.any(String));
        });

        it("sets a CSRF cookie in the response", async function () {
            const res = await agent.get("/api/v1/csrf/token");
            const cookies = res.headers["set-cookie"] || [];
            expect(cookies.some((c) => c.includes("csrf"))).toBe(true);
        });
    });

    describe("GET /api/v1/csrf/status", function () {
        it("returns status with enabled: true", async function () {
            const res = await agent.get("/api/v1/csrf/status");
            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.status.enabled).toBe(true);
        });

        it("reports protected and safe methods", async function () {
            const res = await agent.get("/api/v1/csrf/status");
            expect(res.body.status.methods.protected).toContain("POST");
            expect(res.body.status.methods.safe).toContain("GET");
        });

        it("reports token sources", async function () {
            const res = await agent.get("/api/v1/csrf/status");
            expect(res.body.status.tokenSources).toBeInstanceOf(Array);
            expect(res.body.status.tokenSources).toContain(
                "header:x-csrf-token",
            );
        });
    });

    describe("POST /api/v1/csrf/refresh", function () {
        it("returns 401 when no JWT is provided (AuthMiddleware.authenticate runs before CSRF handler)", async function () {
            const res = await agent.post("/api/v1/csrf/refresh");
            // /csrf/refresh has AuthMiddleware.authenticate first, then the CSRF
            // refresh handler. A request with no JWT is rejected by authenticate
            // with 401 before the CSRF handler is reached.
            expect(res.status).toBe(401);
        });

        it("refreshes token when a valid JWT and CSRF session exist", async function () {
            const jwt = require("jsonwebtoken");
            const validToken = jwt.sign(
                { sub: "test-user", userId: "test-user", userLevel: 1 },
                process.env.JWT_SECRET || "test-secret",
                { expiresIn: "1h" },
            );

            // First obtain a CSRF token (sets the secret cookie)
            const tokenRes = await agent.get("/api/v1/csrf/token");
            const originalToken = tokenRes.body.token;

            // Now refresh — agent retains cookie; JWT provided via Authorization header
            const refreshRes = await agent
                .post("/api/v1/csrf/refresh")
                .set("Authorization", `Bearer ${validToken}`)
                .set("x-csrf-token", originalToken);

            expect(refreshRes.status).toBe(200);
            expect(refreshRes.body.success).toBe(true);
            expect(refreshRes.body.token).toEqual(expect.any(String));
            expect(refreshRes.body.message).toContain("refreshed");
        });
    });
});
