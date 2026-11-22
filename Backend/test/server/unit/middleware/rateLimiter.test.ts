"use strict";

const {
    RateLimiterMiddleware,
} = require("../../../../src/middleware/security/RateLimiterMiddleware");

function mockReq(ip = "127.0.0.1", path = "/api/v1/users") {
    return { ip, path, method: "GET", headers: {}, route: null };
}

function mockRes() {
    const headers = {};
    return {
        headersSent: false,
        setHeader(k, v) {
            headers[k] = v;
        },
        getHeader(k) {
            return headers[k];
        },
        status(code) {
            this._status = code;
            return this;
        },
        json(body) {
            this._body = body;
            return this;
        },
        _headers: headers,
    };
}

describe("RateLimiterMiddleware", function () {
    describe("constructor validation", function () {
        it("throws RangeError when max <= 0", function () {
            expect(() => new RateLimiterMiddleware({ max: 0 })).toThrow(
                RangeError,
            );
            expect(() => new RateLimiterMiddleware({ max: -1 })).toThrow(
                RangeError,
            );
        });

        it("throws RangeError when windowMs <= 0", function () {
            expect(
                () => new RateLimiterMiddleware({ max: 10, windowMs: 0 }),
            ).toThrow(RangeError);
        });

        it("initializes with valid options", function () {
            expect(
                () => new RateLimiterMiddleware({ max: 10, windowMs: 60000 }),
            ).not.toThrow();
        });
    });

    describe("handle()", function () {
        it("calls next() when under the limit", () => new Promise((resolve, reject) => {
            const done = (e) => e ? reject(e) : resolve();

            const limiter = new RateLimiterMiddleware({
                max: 5,
                windowMs: 60000,
            });
            const req = mockReq();
            const res = mockRes();
            limiter.handle(req, res, done);
        
            }));

        it("responds 429 after exceeding max requests", () => new Promise((resolve, reject) => {
            const done = (e) => e ? reject(e) : resolve();

            const limiter = new RateLimiterMiddleware({
                max: 2,
                windowMs: 60000,
            });
            const req = mockReq("10.0.0.1");
            const res = mockRes();
            const noop = () => {};

            limiter.handle(req, mockRes(), noop);
            limiter.handle(req, mockRes(), noop);

            limiter.handle(req, res, () => {
                done(
                    new Error(
                        "next() should not be called when limit is exceeded",
                    ),
                );
            });

            setTimeout(() => {
                expect(res._status).toBe(429);
                expect(res._body.status).toBe("error");
                done();
            }, 10);
        
            }));

        it("sets RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset headers", () => new Promise((resolve) => {
            const limiter = new RateLimiterMiddleware({
                max: 100,
                windowMs: 60000,
            });
            const res = mockRes();
            limiter.handle(mockReq(), res, () => {
                expect(res._headers).toHaveProperty("RateLimit-Limit");
                expect(res._headers).toHaveProperty("RateLimit-Remaining");
                expect(res._headers).toHaveProperty("RateLimit-Reset");
                resolve();
            });
        }));

        it("bypasses OPTIONS requests", () => new Promise((resolve, reject) => {
            const done = (e) => e ? reject(e) : resolve();

            const limiter = new RateLimiterMiddleware({
                max: 1,
                windowMs: 60000,
            });
            const req = { ...mockReq(), method: "OPTIONS" };
            let callCount = 0;
            const next = () => {
                callCount++;
            };
            limiter.handle(req, mockRes(), next);
            limiter.handle(req, mockRes(), next);
            expect(callCount).toBe(2);
            done();
        
            }));

        it("clears all keys with flushAll()", () => new Promise((resolve, reject) => {
            const done = (e) => e ? reject(e) : resolve();

            const limiter = new RateLimiterMiddleware({
                max: 1,
                windowMs: 60000,
            });
            const req = mockReq("192.168.1.5");
            limiter.handle(req, mockRes(), () => {}); // exhaust
            limiter.flushAll();

            // Should pass after flush
            limiter.handle(req, mockRes(), done);
        
            }));
    });

    describe("getStats()", function () {
        it("returns a NodeCache stats object", function () {
            const limiter = new RateLimiterMiddleware({
                max: 10,
                windowMs: 60000,
            });
            const stats = limiter.getStats();
            expect(stats).toBeInstanceOf(Object);
            expect(stats).toHaveProperty("hits");
            expect(stats).toHaveProperty("misses");
        });
    });
});
