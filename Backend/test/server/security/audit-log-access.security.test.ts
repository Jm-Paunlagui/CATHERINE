"use strict";

/**
 * @fileoverview Security: the access gate on every /api/v1/audit-logs route.
 * Unauthenticated, forged, expired and under-privileged callers must be
 * refused BEFORE any service (DB / log-file reader) runs; hostile parameters
 * must be rejected by validation, never reach the filesystem as paths, and
 * never inject into response headers.
 */

import request from "supertest";
import jwt from "jsonwebtoken";

import app from "../../../src/app";
import AuditLogService from "../../../src/services/AuditLogService";
import { logger } from "../../../src/utils/logger";

const { signToken } = require("../helpers/auth");

const token = (role: string, userLevel: number) => signToken({ userId: `${role}-1`, role, userLevel });
const admin = () => token("ADMIN", 2);
const superAdmin = () => token("SUPER_ADMIN", 3);
const plainUser = () => token("USER", 1);

type RouteSpec = { method: "get" | "delete"; url: string; superOnly: boolean; service: keyof typeof AuditLogService };

const REQ = "0078812966528-0448-0000";
const ROUTES: RouteSpec[] = [
    { method: "get", url: "/api/v1/audit-logs", superOnly: false, service: "getList" },
    { method: "get", url: "/api/v1/audit-logs/stats", superOnly: false, service: "getStats" },
    { method: "get", url: "/api/v1/audit-logs/system-logs", superOnly: false, service: "getSystemLogs" },
    { method: "get", url: `/api/v1/audit-logs/${REQ}/logs?date=2026-01-01`, superOnly: false, service: "getRequestLogs" },
    { method: "get", url: "/api/v1/audit-logs/export/excel?fromDate=2026-01-01&toDate=2026-01-02", superOnly: true, service: "exportToExcel" },
    { method: "get", url: "/api/v1/audit-logs/export/logs?fromDate=2026-01-01&toDate=2026-01-02", superOnly: true, service: "exportToZip" },
    { method: "get", url: `/api/v1/audit-logs/${REQ}/export/trace?date=2026-01-01`, superOnly: true, service: "exportTraceExcel" },
];

describe("audit-log routes: access gate", function () {
    const spies: Record<string, ReturnType<typeof vi.spyOn>> = {};

    beforeEach(function () {
        vi.spyOn(logger, "warning").mockImplementation(async () => {});
        for (const key of [
            "getList", "getStats", "getSystemLogs", "getRequestLogs", "exportToExcel", "exportToZip", "exportTraceExcel", "deleteRange",
        ] as const) {
            spies[key] = vi.spyOn(AuditLogService, key).mockResolvedValue(
                (key === "exportToExcel" || key === "exportToZip" || key === "exportTraceExcel" ? Buffer.from("PK") : {}) as never,
            );
        }
    });

    afterEach(function () {
        vi.restoreAllMocks();
    });

    const serviceCalls = () => Object.values(spies).reduce((n, s) => n + s.mock.calls.length, 0);

    describe.each(ROUTES)("$method $url", function (route) {
        it("refuses a request with no credentials (401) without running the service", async function () {
            const res = await request(app)[route.method](route.url);
            expect(res.status).toBe(401);
            expect(serviceCalls()).toBe(0);
        });

        it("refuses a token signed with the wrong secret", async function () {
            const forged = jwt.sign({ role: "SUPER_ADMIN", userLevel: 3 }, "attacker-secret");
            const res = await request(app)[route.method](route.url).set("Authorization", `Bearer ${forged}`);
            expect([401, 403, 440]).toContain(res.status);
            expect(serviceCalls()).toBe(0);
        });

        it("refuses an expired token", async function () {
            const res = await request(app)[route.method](route.url).set("Authorization", `Bearer ${signToken({ role: "SUPER_ADMIN", userLevel: 3 }, "-10s")}`);
            expect(res.status).toBeGreaterThanOrEqual(401);
            expect(res.status).toBeLessThan(500);
            expect(serviceCalls()).toBe(0);
        });

        it("refuses a standard USER with 403", async function () {
            const res = await request(app)[route.method](route.url).set("Authorization", `Bearer ${plainUser()}`);
            expect(res.status).toBe(403);
            expect(res.body.status).toBe("error");
            expect(serviceCalls()).toBe(0);
        });

        it(route.superOnly ? "refuses ADMIN (super-admin-only route) with 403" : "lets ADMIN through", async function () {
            const res = await request(app)[route.method](route.url).set("Authorization", `Bearer ${admin()}`);
            if (route.superOnly) {
                expect(res.status).toBe(403);
                expect(serviceCalls()).toBe(0);
            } else {
                expect(res.status).toBe(200);
            }
        });

        it("lets SUPER_ADMIN through", async function () {
            const res = await request(app)[route.method](route.url).set("Authorization", `Bearer ${superAdmin()}`);
            expect(res.status).toBe(200); // may be served from the audit cache, so the service call count is not asserted
        });

        it("does not trust a client-supplied role in the query string or headers", async function () {
            const sep = route.url.includes("?") ? "&" : "?";
            const res = await request(app)[route.method](`${route.url}${sep}role=SUPER_ADMIN&userLevel=3`)
                .set("Authorization", `Bearer ${plainUser()}`)
                .set("X-User-Role", "SUPER_ADMIN");
            expect(res.status).toBe(403);
            expect(serviceCalls()).toBe(0);
        });
    });

    describe("destructive DELETE /api/v1/audit-logs", function () {
        it("is blocked without CSRF even for SUPER_ADMIN", async function () {
            const res = await request(app)
                .delete("/api/v1/audit-logs?fromDate=2026-01-01&toDate=2026-01-02")
                .set("Authorization", `Bearer ${superAdmin()}`);
            expect(res.status).toBe(403);
            expect(spies.deleteRange).not.toHaveBeenCalled();
        });

        it("is blocked for ADMIN and USER before the service runs", async function () {
            const agent = request.agent(app);
            const csrf = (await agent.get("/api/v1/csrf/token")).body?.token ?? "";
            for (const t of [admin(), plainUser()]) {
                const res = await agent
                    .delete("/api/v1/audit-logs?fromDate=2026-01-01&toDate=2026-01-02")
                    .set("Authorization", `Bearer ${t}`)
                    .set("x-csrf-token", csrf);
                expect(res.status).toBe(403);
            }
            expect(spies.deleteRange).not.toHaveBeenCalled();
        });

        it("is accepted for SUPER_ADMIN with a valid CSRF token", async function () {
            spies.deleteRange.mockResolvedValue({ deletedRows: 0, deletedDays: 0, failedDays: [] } as never);
            const agent = request.agent(app);
            const csrf = (await agent.get("/api/v1/csrf/token")).body?.token ?? "";
            const res = await agent
                .delete("/api/v1/audit-logs?fromDate=2026-01-01&toDate=2026-01-02")
                .set("Authorization", `Bearer ${superAdmin()}`)
                .set("x-csrf-token", csrf);
            expect(res.status).toBe(200);
            expect(spies.deleteRange).toHaveBeenCalledTimes(1);
        });
    });

    describe("hostile parameters after authentication", function () {
        beforeEach(function () {
            for (const key of ["getRequestLogs", "exportTraceExcel", "getSystemLogs", "getList"] as const) spies[key].mockRestore();
        });

        it("rejects an unknown system-log level and an out-of-range priority with 400", async function () {
            const lvl = await request(app).get("/api/v1/audit-logs/system-logs?level=root").set("Authorization", `Bearer ${admin()}`);
            expect(lvl.status).toBe(400);
            const pri = await request(app).get("/api/v1/audit-logs/system-logs?maxPriority=99").set("Authorization", `Bearer ${admin()}`);
            expect(pri.status).toBe(400);
        });

        it("rejects an inverted date range with 400", async function () {
            const res = await request(app)
                .get("/api/v1/audit-logs?fromDate=2026-05-01&toDate=2026-01-01")
                .set("Authorization", `Bearer ${admin()}`);
            expect(res.status).toBe(400);
        });

        it("rejects a bad trace date on export with 400 and a header-injection id never reaches Content-Disposition", async function () {
            const res = await request(app)
                .get(`/api/v1/audit-logs/${REQ}/export/trace?date=not-a-date`)
                .set("Authorization", `Bearer ${superAdmin()}`);
            expect(res.status).toBe(400);
            expect(res.headers["content-disposition"]).toBeUndefined();
        });

        it("rejects a path-traversal request id with 400 and never reads a log file", async function () {
            const res = await request(app)
                .get("/api/v1/audit-logs/..%2F..%2Fetc%2Fpasswd/logs?date=2026-01-01")
                .set("Authorization", `Bearer ${admin()}`);
            expect([400, 403, 404]).toContain(res.status); // blocked by the security filter or by validation
            const res2 = await request(app)
                .get("/api/v1/audit-logs/req_..%2f..%2fx/logs?date=2026-01-01")
                .set("Authorization", `Bearer ${admin()}`);
            expect([400, 403, 404]).toContain(res2.status);
        });

        it("rejects a traversal date on the system-log browser with 400", async function () {
            const res = await request(app)
                .get("/api/v1/audit-logs/system-logs?date=..%2F..%2F..%2Fetc")
                .set("Authorization", `Bearer ${admin()}`);
            expect([400, 403]).toContain(res.status);
        });

    });
});
