"use strict";

/**
 * @fileoverview Register route — intentionally absent.
 *
 * There is no /api/v1/auth/register endpoint. User provisioning is handled via
 * the AdminManagement routes:
 *   POST /api/v1/admin-management      — creates a new admin record
 *
 * These tests assert the route's ABSENCE instead of skipping, so the contract is
 * enforced: if anyone re-adds /auth/register the suite turns red and forces a
 * deliberate decision. See test/server/integration/admin-management/ for the
 * provisioning coverage.
 *
 * GET is used (not POST) so the assertion reaches the 404 handler directly —
 * a POST to any unknown path is rejected by the CSRF middleware (403) before
 * routing, which would not prove route absence.
 */

const request = require("supertest");
const app = require("../../../../src/app");

describe("Auth — Register (no route exists)", function () {
    it("GET /api/v1/auth/register returns 404 — the route is intentionally absent", async function () {
        const res = await request(app).get("/api/v1/auth/register");

        expect(res.status).toBe(404);
        expect(res.body.status).toBe("error");
        expect(res.body.error).toHaveProperty("type", "NotFoundError");
    });

    it("user provisioning lives on the admin-management router, not /auth/register", async function () {
        // The admin-management router IS mounted: an unauthenticated GET returns
        // 401 (auth required), NOT 404 — proving the provisioning path exists
        // exactly where the register route does not.
        const res = await request(app).get("/api/v1/admin-management");

        expect(res.status).toBe(401);
        expect(res.status).not.toBe(404);
    });
});
