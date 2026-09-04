"use strict";

/**
 * Unit tests for IdempotencyMiddleware (src/middleware/security/IdempotencyMiddleware.js).
 * Pure — mocked req/res, no HTTP server, no DB. (Plan §3.5.)
 */

const {
    IdempotencyMiddleware,
    HEADER,
} = require("../../src/middleware/security/IdempotencyMiddleware");
const { registry } = require("../../src/middleware/cache/CacheRegistry");

/** Minimal mock Express request. */
function mockReq({ method = "POST", headers = {}, body = {}, path = "/credit", user } = {}) {
    const lower = {};
    for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
    return {
        method,
        body,
        path,
        baseUrl: "/api/v1/money",
        route: { path },
        originalUrl: "/api/v1/money" + path,
        ip: "127.0.0.1",
        user,
        get(name) {
            return lower[name.toLowerCase()];
        },
    };
}

/** Minimal mock Express response that records the JSON outcome. */
function mockRes() {
    return {
        statusCode: 200,
        headers: {},
        jsonBody: undefined,
        setHeader(k, v) {
            this.headers[k] = v;
        },
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.jsonBody = body;
            return this;
        },
    };
}

describe("IdempotencyMiddleware", function () {
    let mw;
    let storeName;

    beforeEach(function () {
        // Unique store per test so state does not leak between cases.
        storeName = `idem-test-${Math.random().toString(36).slice(2)}`;
        mw = new IdempotencyMiddleware({ storeName, ttl: 60 });
    });

    afterEach(function () {
        if (registry.has(storeName)) registry.resolve(storeName).flush?.();
    });

    it("passes non-guarded methods straight through", function () {
        const req = mockReq({ method: "GET" });
        const res = mockRes();
        let called = false;
        mw.handle(req, res, () => {
            called = true;
        });
        expect(called).toBe(true);
    });

    it("rejects a guarded request missing the Idempotency-Key with 400", function () {
        const req = mockReq({ method: "POST", headers: {} });
        const res = mockRes();
        let err;
        mw.handle(req, res, (e) => {
            err = e;
        });
        expect(err).toBeDefined();
        expect(err.statusCode).toBe(400);
    });

    it("runs the handler on first use and stores the 2xx outcome", function () {
        const req = mockReq({ headers: { [HEADER]: "key-1" }, body: { amount: "10.0000" } });
        const res = mockRes();
        let nextCalled = false;
        mw.handle(req, res, () => {
            nextCalled = true;
        });
        expect(nextCalled).toBe(true);
        // Simulate the handler responding.
        res.status(201).json({ ok: true, id: 99 });
        expect(res.jsonBody).toEqual({ ok: true, id: 99 });
    });

    it("replays the stored response for the same key + body without re-running", function () {
        // First request.
        const req1 = mockReq({ headers: { [HEADER]: "key-2" }, body: { amount: "10.0000" } });
        const res1 = mockRes();
        mw.handle(req1, res1, () => {});
        res1.status(201).json({ ok: true, id: 100 });

        // Replay.
        const req2 = mockReq({ headers: { [HEADER]: "key-2" }, body: { amount: "10.0000" } });
        const res2 = mockRes();
        let nextCalled = false;
        mw.handle(req2, res2, () => {
            nextCalled = true;
        });
        expect(nextCalled).toBe(false); // handler must NOT run again
        expect(res2.statusCode).toBe(201);
        expect(res2.jsonBody).toEqual({ ok: true, id: 100 });
        expect(res2.headers["Idempotent-Replay"]).toBe("true");
    });

    it("returns 409 for the same key with a DIFFERENT body", function () {
        const req1 = mockReq({ headers: { [HEADER]: "key-3" }, body: { amount: "10.0000" } });
        const res1 = mockRes();
        mw.handle(req1, res1, () => {});
        res1.status(201).json({ ok: true });

        const req2 = mockReq({ headers: { [HEADER]: "key-3" }, body: { amount: "20.0000" } });
        const res2 = mockRes();
        let err;
        mw.handle(req2, res2, (e) => {
            err = e;
        });
        expect(err).toBeDefined();
        expect(err.statusCode).toBe(409);
    });

    it("treats a reordered-but-equal body as the SAME request (canonical hash)", function () {
        const req1 = mockReq({ headers: { [HEADER]: "key-4" }, body: { a: 1, b: 2 } });
        const res1 = mockRes();
        mw.handle(req1, res1, () => {});
        res1.status(200).json({ ok: true });

        const req2 = mockReq({ headers: { [HEADER]: "key-4" }, body: { b: 2, a: 1 } });
        const res2 = mockRes();
        let nextCalled = false;
        mw.handle(req2, res2, () => {
            nextCalled = true;
        });
        expect(nextCalled).toBe(false); // recognised as a replay, not a conflict
        expect(res2.jsonBody).toEqual({ ok: true });
    });

    it("does NOT store a non-2xx outcome (retryable)", function () {
        const req1 = mockReq({ headers: { [HEADER]: "key-5" }, body: { amount: "10.0000" } });
        const res1 = mockRes();
        mw.handle(req1, res1, () => {});
        res1.status(500).json({ error: "boom" });

        // A retry with the same key must run again (nothing stored).
        const req2 = mockReq({ headers: { [HEADER]: "key-5" }, body: { amount: "10.0000" } });
        const res2 = mockRes();
        let nextCalled = false;
        mw.handle(req2, res2, () => {
            nextCalled = true;
        });
        expect(nextCalled).toBe(true);
    });

    it("scopes keys by caller — same key, different user, no collision", function () {
        const req1 = mockReq({
            headers: { [HEADER]: "key-6" },
            body: { amount: "10.0000" },
            user: { id: "alice" },
        });
        const res1 = mockRes();
        mw.handle(req1, res1, () => {});
        res1.status(200).json({ who: "alice" });

        const req2 = mockReq({
            headers: { [HEADER]: "key-6" },
            body: { amount: "10.0000" },
            user: { id: "bob" },
        });
        const res2 = mockRes();
        let nextCalled = false;
        mw.handle(req2, res2, () => {
            nextCalled = true;
        });
        expect(nextCalled).toBe(true); // bob's first use, not alice's replay
    });
});
