"use strict";

/**
 * @file rateLimiterExtractIp.test.js
 *
 * Tests for CWE-290 fix: RateLimiterMiddleware.extractIp() must NOT
 * manually parse X-Forwarded-For headers. It must rely exclusively on
 * req.ip (Express-resolved value) so that only the trusted proxy chain
 * configured via app.set('trust proxy', N) influences the resolved IP.
 *
 * This closes the IP spoofing bypass where an attacker could inject a
 * forged X-Forwarded-For header to impersonate any IP address and bypass
 * per-IP rate limiting.
 */

const { expect } = require("chai");
const {
    RateLimiterMiddleware,
} = require("../../../../src/middleware/security/RateLimiterMiddleware");

describe("RateLimiterMiddleware.extractIp() — CWE-290 fix (no XFF manual parsing)", function () {
    describe("relies on req.ip (Express-resolved)", function () {
        it("returns req.ip when it is set", function () {
            const req = {
                ip: "10.0.0.1",
                method: "GET",
                headers: {},
            };
            const ip = RateLimiterMiddleware.extractIp(req);
            expect(ip).to.equal("10.0.0.1");
        });

        it("returns req.ip even when X-Forwarded-For header contains a different IP", function () {
            // Attacker sets XFF to 127.0.0.1 hoping to bypass rate limit
            const req = {
                ip: "203.0.113.5",            // Express-resolved real IP
                method: "GET",
                headers: {
                    "x-forwarded-for": "127.0.0.1", // forged
                },
            };
            const ip = RateLimiterMiddleware.extractIp(req);
            // Must return the Express-resolved IP, NOT the XFF value
            expect(ip).to.equal("203.0.113.5");
            expect(ip).to.not.equal("127.0.0.1");
        });

        it("does NOT return the first hop of X-Forwarded-For", function () {
            const req = {
                ip: "198.51.100.7",
                method: "GET",
                headers: {
                    "x-forwarded-for": "1.2.3.4, 10.0.0.1, 198.51.100.7",
                },
            };
            const ip = RateLimiterMiddleware.extractIp(req);
            expect(ip).to.equal("198.51.100.7");
            expect(ip).to.not.equal("1.2.3.4");
        });

        it("falls back to req.socket.remoteAddress when req.ip is undefined", function () {
            const req = {
                ip: undefined,
                socket: { remoteAddress: "192.168.1.99" },
                method: "GET",
                headers: {},
            };
            const ip = RateLimiterMiddleware.extractIp(req);
            expect(ip).to.equal("192.168.1.99");
        });

        it("returns 'unknown' when both req.ip and socket.remoteAddress are absent", function () {
            const req = {
                ip: undefined,
                socket: {},
                method: "GET",
                headers: {},
            };
            const ip = RateLimiterMiddleware.extractIp(req);
            expect(ip).to.equal("unknown");
        });

        it("returns 'unknown' when req.socket is absent entirely", function () {
            const req = {
                ip: undefined,
                method: "GET",
                headers: {},
            };
            const ip = RateLimiterMiddleware.extractIp(req);
            expect(ip).to.equal("unknown");
        });
    });

    describe("rate limiting uses the correct IP (no XFF bypass)", function () {
        it("rate-limits by req.ip, not by X-Forwarded-For value", function (done) {
            const limiter = new RateLimiterMiddleware({ max: 1, windowMs: 60_000 });

            // Attacker sends two requests with forged XFF but same actual IP
            const realIp = "203.0.113.50";
            function makeReq(forgedXff) {
                return {
                    ip: realIp,
                    method: "GET",
                    path: "/api/test",
                    headers: { "x-forwarded-for": forgedXff },
                    route: null,
                };
            }

            const mockRes = () => {
                const h = {};
                return {
                    _status: null,
                    headersSent: false,
                    setHeader(k, v) { h[k] = v; },
                    getHeader(k) { return h[k]; },
                    status(c) { this._status = c; return this; },
                    json(b) { this._body = b; },
                    _headers: h,
                };
            };

            // First request: should pass
            limiter.handle(makeReq("127.0.0.1"), mockRes(), () => {
                // Second request: same real IP, different forged XFF — should be blocked
                const res2 = mockRes();
                limiter.handle(makeReq("1.2.3.4"), res2, () => {
                    done(new Error("Second request should have been rate-limited"));
                });

                setTimeout(() => {
                    expect(res2._status).to.equal(429);
                    done();
                }, 20);
            });
        });
    });
});
