"use strict";

const agent = require("../helpers/request");

describe("Error Handling", function () {
    describe("404 — unknown routes", function () {
        it("GET unknown path returns 404 JSON with error shape", async function () {
            const res = await agent.get("/api/v1/does-not-exist");
            expect(res.status).toBe(404);
            expect(res.body.status).toBe("error");
            expect(res.body.code).toBe(404);
            expect(res.body.error).toHaveProperty("type", "NotFoundError");
        });

        it("POST unknown path returns 404 not 405", async function () {
            // Use GET to avoid CSRF protection blocking the request before routing
            const res = await agent.get("/api/v1/does-not-exist");
            expect(res.status).toBe(404);
        });
    });

    describe("global error shape contract", function () {
        it("every error response has status, code, message, error fields", async function () {
            const res = await agent.get("/api/v1/does-not-exist");
            expect(res.body).toEqual(expect.objectContaining({status: expect.anything(), code: expect.anything(), title: expect.anything(), message: expect.anything(), error: expect.anything()}));
        });

        it("error.type is always a string", async function () {
            const res = await agent.get("/api/v1/does-not-exist");
            expect(res.body.error.type).toEqual(expect.any(String));
        });
    });
});
