"use strict";

const {
    CsrfMiddleware,
} = require("../../../../src/middleware/security/CsrfMiddleware");

describe("CsrfMiddleware (unit)", function () {
    describe("constructor", function () {
        it("creates an instance with a provided secret", function () {
            const csrf = new CsrfMiddleware({
                secret: "test-secret-32chars-abcdefghij",
            });
            expect(csrf).toBeInstanceOf(Object);
            expect(csrf.handle).toBeInstanceOf(Function);
            expect(csrf.tokenHandler).toBeInstanceOf(Function);
            expect(csrf.refreshHandler).toBeInstanceOf(Function);
            expect(csrf.statusHandler).toBeInstanceOf(Function);
        });

        it("throws in ALL environments when no secret is provided (CWE-352 fail-fast fix)", function () {
            // Security fix: CSRF_SECRET is now required regardless of NODE_ENV.
            // The previous "dev fallback" was a vulnerability — a missing secret in
            // production was only caught at startup, and dev environments used a
            // predictable static secret that could be exploited if accidentally deployed.
            const origEnv = process.env.NODE_ENV;
            const origSecret = process.env.CSRF_SECRET;
            process.env.NODE_ENV = "production";
            delete process.env.CSRF_SECRET;
            try {
                expect(
                    () => new CsrfMiddleware({ secret: undefined }),
                ).toThrow(/CSRF_SECRET environment variable is required/);
            } finally {
                process.env.NODE_ENV = origEnv;
                if (origSecret !== undefined)
                    process.env.CSRF_SECRET = origSecret;
            }
        });

        it("throws in development too when no CSRF_SECRET is configured (fail-fast — no dev fallback)", function () {
            // Security fix: the dev-secret fallback ("dev-csrf-secret-...") was removed.
            // Even in development, CSRF_SECRET must be explicitly set.
            const origEnv = process.env.NODE_ENV;
            const origSecret = process.env.CSRF_SECRET;
            process.env.NODE_ENV = "development";
            delete process.env.CSRF_SECRET;
            try {
                expect(
                    () => new CsrfMiddleware({ secret: undefined }),
                ).toThrow(/CSRF_SECRET environment variable is required/);
            } finally {
                process.env.NODE_ENV = origEnv;
                if (origSecret !== undefined)
                    process.env.CSRF_SECRET = origSecret;
            }
        });
    });

    describe("cookie name", function () {
        it("uses __Host- prefix when secure", function () {
            const csrf = new CsrfMiddleware({
                secret: "test-secret",
                forceSecure: true,
            });
            // Access via statusHandler to check cookie name
            const req = { ip: "127.0.0.1", cookies: {}, get: () => undefined };
            const body = {};
            const res = {
                json(b) {
                    Object.assign(body, b);
                },
            };
            csrf.statusHandler(req, res);
            expect(body.status.cookieName).toBe("__Host-psifi.x-csrf-token");
        });

        it("uses non-prefixed name when not secure", function () {
            const csrf = new CsrfMiddleware({
                secret: "test-secret",
                forceSecure: false,
            });
            const req = { ip: "127.0.0.1", cookies: {}, get: () => undefined };
            const body = {};
            const res = {
                json(b) {
                    Object.assign(body, b);
                },
            };
            csrf.statusHandler(req, res);
            expect(body.status.cookieName).toBe("psifi.x-csrf-token");
        });
    });

    describe("statusHandler", function () {
        it("returns status with enabled=true, methods, tokenSources", function () {
            const csrf = new CsrfMiddleware({
                secret: "test-secret",
                forceSecure: false,
            });
            const req = { ip: "127.0.0.1", cookies: {}, get: () => undefined };
            const body = {};
            const res = {
                json(b) {
                    Object.assign(body, b);
                },
            };
            csrf.statusHandler(req, res);

            expect(body.success).toBe(true);
            expect(body.status.enabled).toBe(true);
            expect(body.status.methods.protected).toContain("POST");
            expect(body.status.methods.safe).toContain("GET");
            expect(body.status.tokenSources).toBeInstanceOf(Array);
            expect(body.status.headerName).toBe("x-csrf-token");
        });

        it("detects when CSRF cookie is present", function () {
            const csrf = new CsrfMiddleware({
                secret: "test-secret",
                forceSecure: false,
            });
            const cookieName = "psifi.x-csrf-token";
            const req = {
                ip: "127.0.0.1",
                cookies: { [cookieName]: "some-value" },
                get: () => undefined,
            };
            const body = {};
            const res = {
                json(b) {
                    Object.assign(body, b);
                },
            };
            csrf.statusHandler(req, res);

            expect(body.status.hasSecret).toBe(true);
            expect(body.message).toContain(
                "active with a valid secret cookie",
            );
        });

        it("detects when CSRF cookie is missing", function () {
            const csrf = new CsrfMiddleware({
                secret: "test-secret",
                forceSecure: false,
            });
            const req = { ip: "127.0.0.1", cookies: {}, get: () => undefined };
            const body = {};
            const res = {
                json(b) {
                    Object.assign(body, b);
                },
            };
            csrf.statusHandler(req, res);

            expect(body.status.hasSecret).toBe(false);
            expect(body.message).toContain("no secret cookie found");
        });
    });

    describe("refreshHandler", function () {
        it("returns 400 when no existing CSRF cookie is present", function () {
            const csrf = new CsrfMiddleware({
                secret: "test-secret",
                forceSecure: false,
            });
            const req = { ip: "127.0.0.1", cookies: {}, get: () => undefined };
            let statusCode;
            const body = {};
            const res = {
                status(c) {
                    statusCode = c;
                    return this;
                },
                json(b) {
                    Object.assign(body, b);
                },
            };
            csrf.refreshHandler(req, res);

            expect(statusCode).toBe(400);
            expect(body.success).toBe(false);
            expect(body.code).toBe("NO_CSRF_SESSION");
        });
    });
});
