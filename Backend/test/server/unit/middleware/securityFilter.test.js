"use strict";

const {
    SecurityFilterMiddleware,
} = require("../../../../src/middleware/security/SecurityFilterMiddleware");

function mockReq(options = {}) {
    const path = options.path || "/test";
    return {
        ip: options.ip || "127.0.0.1",
        path,
        originalUrl: options.originalUrl || path,
        method: options.method || "GET",
        connection: { remoteAddress: options.ip || "127.0.0.1" },
    };
}

function mockRes() {
    let _status, _body;
    return {
        get _status() {
            return _status;
        },
        get _body() {
            return _body;
        },
        status(c) {
            _status = c;
            return this;
        },
        json(b) {
            _body = b;
            return this;
        },
    };
}

describe("SecurityFilterMiddleware (unit)", function () {
    describe("whitelisted paths", function () {
        it("allows root path /", () =>
            new Promise((resolve, reject) => {
                const done = (e) => (e ? reject(e) : resolve());

                const filter = new SecurityFilterMiddleware();
                filter.handle(mockReq({ path: "/" }), mockRes(), done);
            }));

        it("allows /health", () =>
            new Promise((resolve, reject) => {
                const done = (e) => (e ? reject(e) : resolve());

                const filter = new SecurityFilterMiddleware();
                filter.handle(mockReq({ path: "/health" }), mockRes(), done);
            }));

        it("allows /api/ prefixed paths", () =>
            new Promise((resolve, reject) => {
                const done = (e) => (e ? reject(e) : resolve());

                const filter = new SecurityFilterMiddleware();
                filter.handle(
                    mockReq({ path: "/api/v1/users" }),
                    mockRes(),
                    done,
                );
            }));

        it("allows /api-docs paths", () =>
            new Promise((resolve, reject) => {
                const done = (e) => (e ? reject(e) : resolve());

                const filter = new SecurityFilterMiddleware();
                filter.handle(
                    mockReq({ path: "/api-docs/swagger" }),
                    mockRes(),
                    done,
                );
            }));
    });

    describe("blocked HTTP methods", function () {
        it("blocks TRACE with 405", function () {
            const filter = new SecurityFilterMiddleware();
            const res = mockRes();
            filter.handle(
                mockReq({ method: "TRACE", path: "/something" }),
                res,
                () => {
                    throw new Error("should not call next");
                },
            );
            expect(res._status).toBe(405);
            expect(res._body.error.type).toBe("MethodNotAllowed");
        });

        it("blocks PROPFIND with 405", function () {
            const filter = new SecurityFilterMiddleware();
            const res = mockRes();
            filter.handle(
                mockReq({ method: "PROPFIND", path: "/something" }),
                res,
                () => {
                    throw new Error("should not call next");
                },
            );
            expect(res._status).toBe(405);
        });

        it("blocks SEARCH with 405", function () {
            const filter = new SecurityFilterMiddleware();
            const res = mockRes();
            filter.handle(
                mockReq({ method: "SEARCH", path: "/something" }),
                res,
                () => {
                    throw new Error("should not call next");
                },
            );
            expect(res._status).toBe(405);
        });
    });

    describe("malicious patterns (path-only → 404)", function () {
        const MALICIOUS_PATHS = [
            "/robots.txt",
            "/wp-admin/admin.php",
            "/weblogic/login",
            "/_layouts/15/error.aspx",
            "/login.php",
            "/test.jsp",
            "/script.cgi",
            "/page.asp",
        ];

        MALICIOUS_PATHS.forEach((path) => {
            it(`blocks ${path} with 404`, function () {
                const filter = new SecurityFilterMiddleware();
                const res = mockRes();
                filter.handle(mockReq({ path }), res, () => {
                    throw new Error("should not call next");
                });
                expect(res._status).toBe(404);
                expect(res._body.error.type).toBe("NotFound");
            });
        });

        it("blocks /../etc/passwd with 403 (traversal → injection pattern)", function () {
            const filter = new SecurityFilterMiddleware();
            const res = mockRes();
            filter.handle(mockReq({ path: "/../etc/passwd" }), res, () => {
                throw new Error("should not call next");
            });
            expect(res._status).toBe(403);
            expect(res._body.error.type).toBe("ForbiddenError");
        });

        it("blocks script injection in path", function () {
            const filter = new SecurityFilterMiddleware();
            const res = mockRes();
            filter.handle(
                mockReq({ path: "/<script>alert(1)</script>" }),
                res,
                () => {
                    throw new Error("should not call next");
                },
            );
            // Injection patterns return 403 (checked against full URL)
            expect(res._status).toBe(403);
        });

        it("blocks path traversal with ..", function () {
            const filter = new SecurityFilterMiddleware();
            const res = mockRes();
            filter.handle(
                mockReq({ path: "/foo/../../../etc/shadow" }),
                res,
                () => {
                    throw new Error("should not call next");
                },
            );
            expect(res._status).toBe(403);
        });
    });

    describe("injection patterns (query string)", function () {
        it("blocks SQL injection OR '1'='1 in query string", function () {
            const filter = new SecurityFilterMiddleware();
            const res = mockRes();
            filter.handle(
                mockReq({
                    path: "/api/v1/health/live",
                    originalUrl: "/api/v1/health/live?id=1' OR '1'='1",
                }),
                res,
                () => {
                    throw new Error("should not call next");
                },
            );
            expect(res._status).toBe(403);
            expect(res._body.error.type).toBe("ForbiddenError");
        });

        it("blocks UNION SELECT in query string", function () {
            const filter = new SecurityFilterMiddleware();
            const res = mockRes();
            filter.handle(
                mockReq({
                    path: "/api/v1/users",
                    originalUrl:
                        "/api/v1/users?id=1 UNION SELECT * FROM admins--",
                }),
                res,
                () => {
                    throw new Error("should not call next");
                },
            );
            expect(res._status).toBe(403);
        });

        it("blocks stacked query ;DROP TABLE in query string", function () {
            const filter = new SecurityFilterMiddleware();
            const res = mockRes();
            filter.handle(
                mockReq({
                    path: "/api/v1/users",
                    originalUrl: "/api/v1/users?id=1;DROP TABLE users;--",
                }),
                res,
                () => {
                    throw new Error("should not call next");
                },
            );
            expect(res._status).toBe(403);
        });

        it("blocks XSS <script> in query string", function () {
            const filter = new SecurityFilterMiddleware();
            const res = mockRes();
            filter.handle(
                mockReq({
                    path: "/api/v1/search",
                    originalUrl: "/api/v1/search?q=<script>alert(1)</script>",
                }),
                res,
                () => {
                    throw new Error("should not call next");
                },
            );
            expect(res._status).toBe(403);
        });

        it("blocks onerror= in query string", function () {
            const filter = new SecurityFilterMiddleware();
            const res = mockRes();
            filter.handle(
                mockReq({
                    path: "/api/v1/test",
                    originalUrl: "/api/v1/test?img=x onerror=alert(1)",
                }),
                res,
                () => {
                    throw new Error("should not call next");
                },
            );
            expect(res._status).toBe(403);
        });

        it("blocks command injection in query string", function () {
            const filter = new SecurityFilterMiddleware();
            const res = mockRes();
            filter.handle(
                mockReq({
                    path: "/api/v1/ping",
                    originalUrl: "/api/v1/ping?host=127.0.0.1; cat /etc/passwd",
                }),
                res,
                () => {
                    throw new Error("should not call next");
                },
            );
            expect(res._status).toBe(403);
        });

        it("allows clean query strings through", () =>
            new Promise((resolve, reject) => {
                const done = (e) => (e ? reject(e) : resolve());
                const filter = new SecurityFilterMiddleware();
                filter.handle(
                    mockReq({
                        path: "/api/v1/users",
                        originalUrl: "/api/v1/users?page=1&limit=20&sort=name",
                    }),
                    mockRes(),
                    done,
                );
            }));
    });

    describe("IP auto-blocking", function () {
        it("blocks an IP after exceeding the suspicious threshold", function () {
            const filter = new SecurityFilterMiddleware({
                suspiciousThreshold: 3,
                blockDurationMs: 60000,
            });

            const ip = "10.99.99.99";
            // Generate enough suspicious activity to trigger auto-block
            for (let i = 0; i < 3; i++) {
                const res = mockRes();
                filter.handle(
                    mockReq({ ip, method: "TRACE", path: "/x" }),
                    res,
                    () => {},
                );
            }

            // Next request from same IP (even to non-malicious path) should be 403
            const res = mockRes();
            filter.handle(mockReq({ ip, path: "/normal" }), res, () => {
                throw new Error("should be blocked");
            });
            expect(res._status).toBe(403);
            expect(res._body.error.type).toBe("ForbiddenError");
        });
    });

    describe("getStats()", function () {
        it("returns stats object with required properties", function () {
            const filter = new SecurityFilterMiddleware();
            const stats = filter.getStats();
            expect(stats).toHaveProperty("totalTracked");
            expect(stats).toHaveProperty("blocked");
            expect(stats).toHaveProperty("suspicious");
            expect(stats).toHaveProperty("blockedIPs");
            expect(stats).toHaveProperty("suspiciousIPs");
        });

        it("tracks suspicious IPs after malicious requests", function () {
            const filter = new SecurityFilterMiddleware();
            const res = mockRes();
            filter.handle(
                mockReq({ ip: "5.5.5.5", path: "/robots.txt" }),
                res,
                () => {},
            );
            const stats = filter.getStats();
            expect(stats.totalTracked).toBeGreaterThan(0);
        });
    });

    describe("clean paths pass through", function () {
        it("allows normal non-whitelisted, non-malicious paths", () =>
            new Promise((resolve) => {
                const filter = new SecurityFilterMiddleware();
                filter.handle(
                    mockReq({ path: "/some/custom/endpoint" }),
                    mockRes(),
                    resolve,
                );
            }));
    });
});
