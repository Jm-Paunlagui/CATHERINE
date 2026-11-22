"use strict";

/**
 * @file corsProductionMode.test.js
 *
 * Tests for CWE-942 fix: In production (NODE_ENV=production),
 * broad wildcard patterns for private networks and intranet TLDs must be
 * disabled unless CORS_ALLOW_BROAD_PATTERNS=true.
 *
 * These tests manipulate NODE_ENV and require a fresh CorsMiddleware instance
 * per test to pick up the env change.
 */


function mockReq(origin) {
    return {
        method: "GET",
        headers: origin ? { origin } : {},
        get(key) {
            return this.headers[key.toLowerCase()];
        },
    };
}

function mockRes() {
    const headers = {};
    return {
        setHeader(k, v) {
            headers[k] = v;
        },
        getHeader(k) {
            return headers[k];
        },
        _headers: headers,
        statusCode: 200,
        end() {},
    };
}

/** Saves and restores a set of env vars, returns a restore function. */
function setEnv(vars) {
    const saved = {};
    for (const [k, v] of Object.entries(vars)) {
        saved[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    return () => {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    };
}

/** Re-requires CorsMiddleware with a clean module cache. */
function freshCors(opts) {
    const key =
        require.resolve("../../../../src/middleware/security/CorsMiddleware");
    delete require.cache[key];
    const {
        CorsMiddleware,
    } = require("../../../../src/middleware/security/CorsMiddleware");
    return new CorsMiddleware(opts);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("CorsMiddleware — production mode (CWE-942)", function () {
    describe("non-production (NODE_ENV=development)", function () {
        let restore;
        beforeEach(function () {
            restore = setEnv({
                NODE_ENV: "development",
                CORS_ALLOW_BROAD_PATTERNS: undefined,
            });
        });
        afterEach(function () {
            restore();
        });

        it("allows 192.168.x.x private network origin in development", () => new Promise((resolve, reject) => {
            const done = (e) => e ? reject(e) : resolve();

            const cors = freshCors();
            cors.handle(
                mockReq("http://192.168.1.50:3000"),
                mockRes(),
                (err) => {
                    expect(err).toBeUndefined();
                    done();
                },
            );
        
            }));

        it("allows .vpn intranet origin in development", () => new Promise((resolve, reject) => {
            const done = (e) => e ? reject(e) : resolve();

            const cors = freshCors();
            cors.handle(
                mockReq("https://host.vpn.company.com"),
                mockRes(),
                (err) => {
                    expect(err).toBeUndefined();
                    done();
                },
            );
        
            }));

        it("allows .local origin in development", () => new Promise((resolve, reject) => {
            const done = (e) => e ? reject(e) : resolve();

            const cors = freshCors();
            cors.handle(mockReq("http://mypc.local:8080"), mockRes(), (err) => {
                expect(err).toBeUndefined();
                done();
            });
        
            }));

        it("allows 10.x.x.x origin in development", () => new Promise((resolve, reject) => {
            const done = (e) => e ? reject(e) : resolve();

            const cors = freshCors();
            cors.handle(mockReq("http://10.0.1.100:4000"), mockRes(), (err) => {
                expect(err).toBeUndefined();
                done();
            });
        
            }));
    });

    describe("production (NODE_ENV=production, CORS_ALLOW_BROAD_PATTERNS not set)", function () {
        let restore;
        beforeEach(function () {
            restore = setEnv({
                NODE_ENV: "production",
                CORS_ALLOW_BROAD_PATTERNS: undefined,
            });
        });
        afterEach(function () {
            restore();
        });

        it("BLOCKS 192.168.x.x private network origin in production", () => new Promise((resolve, reject) => {
            const done = (e) => e ? reject(e) : resolve();

            const cors = freshCors();
            cors.handle(
                mockReq("http://192.168.1.50:3000"),
                mockRes(),
                (err) => {
                    expect(err).toBeInstanceOf(Error);
                    expect(err.message).toContain("not allowed by CORS");
                    done();
                },
            );
        
            }));

        it("BLOCKS .vpn intranet origin in production", () => new Promise((resolve, reject) => {
            const done = (e) => e ? reject(e) : resolve();

            const cors = freshCors();
            cors.handle(
                mockReq("https://host.vpn.company.com"),
                mockRes(),
                (err) => {
                    expect(err).toBeInstanceOf(Error);
                    done();
                },
            );
        
            }));

        it("BLOCKS .local origin in production", () => new Promise((resolve, reject) => {
            const done = (e) => e ? reject(e) : resolve();

            const cors = freshCors();
            cors.handle(mockReq("http://mypc.local:8080"), mockRes(), (err) => {
                expect(err).toBeInstanceOf(Error);
                done();
            });
        
            }));

        it("BLOCKS 10.x.x.x origin in production", () => new Promise((resolve, reject) => {
            const done = (e) => e ? reject(e) : resolve();

            const cors = freshCors();
            cors.handle(mockReq("http://10.0.1.100:4000"), mockRes(), (err) => {
                expect(err).toBeInstanceOf(Error);
                done();
            });
        
            }));

        it("STILL allows localhost origin in production (safe loopback)", () => new Promise((resolve, reject) => {
            const done = (e) => e ? reject(e) : resolve();

            const cors = freshCors();
            cors.handle(mockReq("http://localhost:5173"), mockRes(), (err) => {
                expect(err).toBeUndefined();
                done();
            });
        
            }));

        it("STILL allows 127.0.0.1 origin in production (safe loopback)", () => new Promise((resolve, reject) => {
            const done = (e) => e ? reject(e) : resolve();

            const cors = freshCors();
            cors.handle(mockReq("http://127.0.0.1:3000"), mockRes(), (err) => {
                expect(err).toBeUndefined();
                done();
            });
        
            }));

        it("STILL allows explicit CORS_ORIGINS entry in production", () => new Promise((resolve, reject) => {
            const done = (e) => e ? reject(e) : resolve();

            const origOrigins = process.env.CORS_ORIGINS;
            process.env.CORS_ORIGINS = "https://app.example.com";
            const cors = freshCors();
            cors.handle(
                mockReq("https://app.example.com"),
                mockRes(),
                (err) => {
                    if (origOrigins !== undefined)
                        process.env.CORS_ORIGINS = origOrigins;
                    else delete process.env.CORS_ORIGINS;
                    expect(err).toBeUndefined();
                    done();
                },
            );
        
            }));
    });

    describe("production with CORS_ALLOW_BROAD_PATTERNS=true (opt-in override)", function () {
        let restore;
        beforeEach(function () {
            restore = setEnv({
                NODE_ENV: "production",
                CORS_ALLOW_BROAD_PATTERNS: "true",
            });
        });
        afterEach(function () {
            restore();
        });

        it("allows 192.168.x.x when opt-in flag is set in production", () => new Promise((resolve, reject) => {
            const done = (e) => e ? reject(e) : resolve();

            const cors = freshCors();
            cors.handle(
                mockReq("http://192.168.1.50:3000"),
                mockRes(),
                (err) => {
                    expect(err).toBeUndefined();
                    done();
                },
            );
        
            }));

        it("allows .vpn when opt-in flag is set in production", () => new Promise((resolve, reject) => {
            const done = (e) => e ? reject(e) : resolve();

            const cors = freshCors();
            cors.handle(
                mockReq("https://host.vpn.company.com"),
                mockRes(),
                (err) => {
                    expect(err).toBeUndefined();
                    done();
                },
            );
        
            }));
    });
});
