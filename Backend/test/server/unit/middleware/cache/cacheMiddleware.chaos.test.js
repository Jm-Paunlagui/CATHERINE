"use strict";

/**
 * @fileoverview Chaos / edge-case unit tests for CacheMiddleware.
 *
 * Tests exercise the static factory methods:
 *   - `CacheMiddleware.read(store, keyFn, options)`
 *   - `CacheMiddleware.invalidate(store, keyFn, options)`
 *   - `CacheMiddleware.invalidateWhere(store, predicateFn)`
 *
 * All tests use manually constructed req/res/next mocks — no Supertest, no HTTP.
 * Sinon is used to spy on store operations and verify call counts.
 *
 * Important implementation details mirrored in the tests:
 *  - Invalidation fires inside `setImmediate` → tests use a `setImmediate`
 *    wrapper (via `await new Promise(setImmediate)`) to flush the callback
 *    queue before asserting on store state.
 *  - `CacheMiddleware.read()` intercepts `res.json` during the MISS path;
 *    tests simulate controller execution by calling the captured `res.json`
 *    directly after `next()` fires.
 *  - `setHeaders: false` suppresses all X-Cache / X-Cache-Key headers.
 *
 * Specialisations active: Senior Test Engineer · Senior Chaos & Resilience Engineer
 *                         Senior Cybersecurity Engineer (CWE-639 auth-before-cache)
 */

const { expect } = require("chai");
const sinon      = require("sinon");

const { CacheStore }      = require("../../../../../src/middleware/cache/CacheStore");
const { CacheMiddleware } = require("../../../../../src/middleware/cache/CacheMiddleware");

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Flush the setImmediate queue once so that fire-and-forget invalidation
 * callbacks inside CacheMiddleware.invalidate() have a chance to execute.
 * @returns {Promise<void>}
 */
function flushImmediate() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Unique name counter so each makeStore() call gets a fresh NodeCache. */
let _storeSeq = 0;
function makeStore(opts = {}) {
  return new CacheStore(`mw-chaos-${++_storeSeq}`, opts);
}

/**
 * Build a minimal Express req mock.
 * @param {string} [method="GET"]
 * @returns {object}
 */
function mockReq(method = "GET") {
  return { method, path: "/test", headers: {}, query: {} };
}

/**
 * Build a minimal Express res mock that records header sets and json calls.
 * The `json` method is writable so CacheMiddleware can replace it.
 *
 * `once`/`emit` mimic the EventEmitter surface a real Express res has —
 * CacheMiddleware.read()'s MISS path registers `res.once("close", release)`
 * for single-flight coalescing, so a mock without `.once` throws inside the
 * async middleware and `next()` never fires (the pre-fix 60s timeouts).
 * `json()` emits "close" after writing, mirroring Express finishing the
 * response, so the in-flight leader is always released.
 *
 * @param {number} [statusCode=200]
 * @returns {object}
 */
function mockRes(statusCode = 200) {
  const hdrs      = {};
  const listeners = new Map();
  const res  = {
    statusCode,
    _body: undefined,
    _headers: hdrs,
    set(key, val) { hdrs[key] = val; },
    get(key)      { return hdrs[key]; },
    once(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
    },
    emit(event) {
      const fns = listeners.get(event) ?? [];
      listeners.set(event, []);
      for (const fn of fns) fn();
    },
    // json will be replaced by CacheMiddleware.read() on MISS path.
    json(data)    {
      this._body = data;
      this.emit("close");
      return this;
    },
  };
  return res;
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe("CacheMiddleware — chaos / edge-case unit tests", function () {
  afterEach(function () {
    sinon.restore();
    // MISS-path tests that never write a response leave their single-flight
    // leader promise in the static map — clear it so no state crosses tests.
    CacheMiddleware._inflight.clear();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // read() — keyFn throws
  // ─────────────────────────────────────────────────────────────────────────

  describe("read() — keyFn throws", function () {
    it("calls next() without error when keyFn throws (BYPASS behaviour)", function (done) {
      const store  = makeStore();
      const badKey = () => { throw new Error("bad key"); };
      const mw     = CacheMiddleware.read(store, badKey);
      const req    = mockReq();
      const res    = mockRes();

      mw(req, res, (err) => {
        expect(err).to.equal(undefined); // next() called with no error
        done();
      });
    });

    it("does not set any X-Cache header when keyFn throws", function (done) {
      const store = makeStore();
      const mw    = CacheMiddleware.read(store, () => { throw new Error("boom"); });
      const res   = mockRes();

      mw(mockReq(), res, () => {
        expect(res._headers).to.not.have.property("X-Cache");
        expect(res._headers).to.not.have.property("X-Cache-Key");
        done();
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // read() — bypass methods
  // ─────────────────────────────────────────────────────────────────────────

  describe("read() — bypass methods", function () {
    ["POST", "PUT", "PATCH", "DELETE"].forEach((method) => {
      it(`${method} request always calls next() and never reads cache or sets X-Cache`, function (done) {
        const store = makeStore();
        store.set("should-be-ignored", { cached: true });
        const mw  = CacheMiddleware.read(store, () => "should-be-ignored");
        const res = mockRes();

        mw(mockReq(method), res, () => {
          expect(res._headers).to.not.have.property("X-Cache");
          expect(res._body).to.equal(undefined);
          done();
        });
      });
    });

    it("GET method proceeds through normal HIT/MISS logic (not bypassed)", function (done) {
      const store = makeStore();
      store.set("the-key", { ok: true });
      const mw  = CacheMiddleware.read(store, () => "the-key");
      const res = mockRes();
      let   nextCalled = false;

      mw(mockReq("GET"), res, () => { nextCalled = true; done(); });

      // On HIT, next() must NOT be called and res.json must fire immediately.
      setImmediate(() => {
        expect(nextCalled).to.be.false;
        expect(res._headers["X-Cache"]).to.equal("HIT");
        expect(res._body).to.deep.equal({ ok: true });
        done();
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // read() — HIT path
  // ─────────────────────────────────────────────────────────────────────────

  describe("read() — HIT path", function () {
    it("responds immediately with cached value and does NOT call next()", function (done) {
      const store   = makeStore();
      const payload = { status: "success", data: [1, 2, 3] };
      store.set("hit-key", payload);

      const mw  = CacheMiddleware.read(store, () => "hit-key");
      const res = mockRes();

      mw(mockReq(), res, () => {
        done(new Error("next() should NOT be called on HIT"));
      });

      // Allow the synchronous HIT path to complete before checking.
      setImmediate(() => {
        expect(res._body).to.deep.equal(payload);
        expect(res._headers["X-Cache"]).to.equal("HIT");
        expect(res._headers["X-Cache-Key"]).to.equal("hit-key");
        done();
      });
    });

    it("X-Cache header is 'HIT' on cache hit", function (done) {
      const store = makeStore();
      store.set("h-key", "data");
      const mw  = CacheMiddleware.read(store, () => "h-key");
      const res = mockRes();

      mw(mockReq(), res, () => done(new Error("should not call next")));

      setImmediate(() => {
        expect(res._headers["X-Cache"]).to.equal("HIT");
        done();
      });
    });

    it("X-Cache-Key header matches the key returned by keyFn", function (done) {
      const store = makeStore();
      const KEY   = "myapp:users:page=1";
      store.set(KEY, { rows: [] });

      const mw  = CacheMiddleware.read(store, () => KEY);
      const res = mockRes();

      mw(mockReq(), res, () => done(new Error("should not call next")));

      setImmediate(() => {
        expect(res._headers["X-Cache-Key"]).to.equal(KEY);
        done();
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // read() — MISS path
  // ─────────────────────────────────────────────────────────────────────────

  describe("read() — MISS path", function () {
    it("calls next() on MISS and sets X-Cache: MISS header", function (done) {
      const store = makeStore(); // empty store
      const mw    = CacheMiddleware.read(store, () => "miss-key");
      const res   = mockRes();

      mw(mockReq(), res, () => {
        expect(res._headers["X-Cache"]).to.equal("MISS");
        done();
      });
    });

    it("stores the response in cache after controller calls res.json() with 200", function (done) {
      const store  = makeStore();
      const KEY    = "miss-then-store";
      const mw     = CacheMiddleware.read(store, () => KEY);
      const res    = mockRes(200);
      const body   = { status: "success", data: "hello" };

      mw(mockReq(), res, () => {
        // Simulate controller writing the response
        res.json(body);

        setImmediate(() => {
          expect(store.get(KEY)).to.deep.equal(body);
          done();
        });
      });
    });

    it("second request after MISS is a HIT (cache was populated)", function (done) {
      const store = makeStore();
      const KEY   = "two-requests";
      const mw    = CacheMiddleware.read(store, () => KEY);
      const body  = { rows: [1, 2] };

      // First request (MISS)
      const res1 = mockRes(200);
      mw(mockReq(), res1, () => {
        res1.json(body);

        setImmediate(() => {
          // Second request — should be HIT
          const res2 = mockRes();
          mw(mockReq(), res2, () => done(new Error("next should not fire on HIT")));

          setImmediate(() => {
            expect(res2._headers["X-Cache"]).to.equal("HIT");
            expect(res2._body).to.deep.equal(body);
            done();
          });
        });
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // read() — error responses NOT cached
  // ─────────────────────────────────────────────────────────────────────────

  describe("read() — error responses never cached", function () {
    [400, 401, 403, 404, 422, 500, 503].forEach((status) => {
      it(`${status} response from controller is NOT stored in cache`, function (done) {
        const store = makeStore();
        const KEY   = `err-${status}`;
        const mw    = CacheMiddleware.read(store, () => KEY);
        const res   = mockRes(status);

        mw(mockReq(), res, () => {
          res.json({ status: "error", code: status });

          setImmediate(() => {
            expect(store.get(KEY)).to.equal(undefined);
            done();
          });
        });
      });
    });

    it("subsequent GET after an error response is still a MISS (error was not cached)", function (done) {
      const store = makeStore();
      const KEY   = "persisted-miss";
      const mw    = CacheMiddleware.read(store, () => KEY);

      // First request: controller responds 404
      const res1 = mockRes(404);
      mw(mockReq(), res1, () => {
        res1.json({ error: "not found" });

        setImmediate(() => {
          // Second request: must still be MISS
          const res2 = mockRes();
          mw(mockReq(), res2, () => {
            expect(res2._headers["X-Cache"]).to.equal("MISS");
            done();
          });
        });
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // read() — setHeaders: false
  // ─────────────────────────────────────────────────────────────────────────

  describe("read() — setHeaders: false", function () {
    it("no X-Cache or X-Cache-Key header on HIT when setHeaders: false", function (done) {
      const store = makeStore();
      store.set("no-header-key", "value");

      const mw  = CacheMiddleware.read(store, () => "no-header-key", { setHeaders: false });
      const res = mockRes();

      mw(mockReq(), res, () => done(new Error("should not call next on HIT")));

      setImmediate(() => {
        expect(res._headers).to.not.have.property("X-Cache");
        expect(res._headers).to.not.have.property("X-Cache-Key");
        // But the body should still be the cached value
        expect(res._body).to.equal("value");
        done();
      });
    });

    it("no X-Cache or X-Cache-Key header on MISS when setHeaders: false", function (done) {
      const store = makeStore(); // empty
      const mw    = CacheMiddleware.read(store, () => "empty", { setHeaders: false });
      const res   = mockRes();

      mw(mockReq(), res, () => {
        expect(res._headers).to.not.have.property("X-Cache");
        expect(res._headers).to.not.have.property("X-Cache-Key");
        done();
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // invalidate() — fires only on 2xx
  // ─────────────────────────────────────────────────────────────────────────

  describe("invalidate() — 2xx gate", function () {
    it("does NOT invalidate when controller responds 400", async function () {
      const store = makeStore();
      store.set("protected-key", "important");

      const keyFn = sinon.stub().returns("protected-key");
      const mw    = CacheMiddleware.invalidate(store, keyFn);
      const req   = mockReq("POST");
      const res   = mockRes(400);

      mw(req, res, () => {});
      res.json({ error: "bad request" });

      await flushImmediate();

      expect(keyFn.called).to.be.false;
      expect(store.get("protected-key")).to.equal("important");
    });

    it("does NOT invalidate when controller responds 500", async function () {
      const store = makeStore();
      store.set("safe", "data");

      const keyFn = sinon.stub().returns("safe");
      const mw    = CacheMiddleware.invalidate(store, keyFn);
      const res   = mockRes(500);

      mw(mockReq(), res, () => {});
      res.json({ error: "internal" });

      await flushImmediate();

      expect(keyFn.called).to.be.false;
      expect(store.get("safe")).to.equal("data");
    });

    it("DOES invalidate when controller responds 200", async function () {
      const store = makeStore();
      store.set("target", "old data");

      const mw  = CacheMiddleware.invalidate(store, () => "target");
      const res = mockRes(200);

      mw(mockReq(), res, () => {});
      res.json({ ok: true });

      await flushImmediate();

      expect(store.get("target")).to.equal(undefined);
    });

    it("DOES invalidate when controller responds 201", async function () {
      const store = makeStore();
      store.set("list-key", "stale");

      const mw  = CacheMiddleware.invalidate(store, () => "list-key");
      const res = mockRes(201);

      mw(mockReq(), res, () => {});
      res.json({ created: true });

      await flushImmediate();

      expect(store.get("list-key")).to.equal(undefined);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // invalidate() — null/undefined keyFn return (no-op)
  // ─────────────────────────────────────────────────────────────────────────

  describe("invalidate() — null keyFn return is a no-op", function () {
    it("keyFn returning null does not touch the store", async function () {
      const store = makeStore();
      store.set("keep", "me");

      const mw  = CacheMiddleware.invalidate(store, () => null);
      const res = mockRes(200);

      mw(mockReq(), res, () => {});
      res.json({});

      await flushImmediate();

      expect(store.get("keep")).to.equal("me");
    });

    it("keyFn returning undefined does not touch the store", async function () {
      const store = makeStore();
      store.set("also-keep", "value");

      const mw  = CacheMiddleware.invalidate(store, () => undefined);
      const res = mockRes(200);

      mw(mockReq(), res, () => {});
      res.json({});

      await flushImmediate();

      expect(store.get("also-keep")).to.equal("value");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // invalidate() — keyFn throws (error caught internally)
  // ─────────────────────────────────────────────────────────────────────────

  describe("invalidate() — keyFn throws", function () {
    it("invalidation error is caught internally; response was already sent successfully", async function () {
      const store = makeStore();
      store.set("survivor", "data");

      const mw    = CacheMiddleware.invalidate(store, () => { throw new Error("keyFn boom"); });
      const res   = mockRes(200);
      let   jsonResult;

      mw(mockReq(), res, () => {});
      // res.json is called by the controller — capture the return value.
      jsonResult = res.json({ ok: true });

      await flushImmediate();

      // The original response must have been sent (json() returns `this`).
      expect(jsonResult).to.equal(res);
      // The store must be unaffected (error was caught, not re-thrown).
      expect(store.get("survivor")).to.equal("data");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // invalidate() — usePattern: true
  // ─────────────────────────────────────────────────────────────────────────

  describe("invalidate() — usePattern: true", function () {
    it("deletes all keys matching the pattern, leaves non-matching keys intact", async function () {
      const store = makeStore();
      store.set("foo:a", "1");
      store.set("foo:b", "2");
      store.set("bar:c", "3");

      const mw  = CacheMiddleware.invalidate(store, () => "foo", { usePattern: true });
      const res = mockRes(200);

      mw(mockReq(), res, () => {});
      res.json({});

      await flushImmediate();

      expect(store.get("foo:a")).to.equal(undefined);
      expect(store.get("foo:b")).to.equal(undefined);
      expect(store.get("bar:c")).to.equal("3"); // must survive
    });

    it("namespace wipe: rfidMasterfile pattern removes all rfidMasterfile:* keys", async function () {
      const store = makeStore();
      store.set("rfidMasterfile",               "active list");
      store.set("rfidMasterfile:type=archived", "archived list");
      store.set("rfidMasterfile:cardNumber=100:gid=1:type=history", "history");
      store.set("other:data", "untouched");

      const mw  = CacheMiddleware.invalidate(store, () => "rfidMasterfile", { usePattern: true });
      const res = mockRes(200);

      mw(mockReq(), res, () => {});
      res.json({});

      await flushImmediate();

      expect(store.get("rfidMasterfile")).to.equal(undefined);
      expect(store.get("rfidMasterfile:type=archived")).to.equal(undefined);
      expect(store.get("rfidMasterfile:cardNumber=100:gid=1:type=history")).to.equal(undefined);
      expect(store.get("other:data")).to.equal("untouched");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // invalidate() — array of keys
  // ─────────────────────────────────────────────────────────────────────────

  describe("invalidate() — keyFn returns array of keys", function () {
    it("deletes exactly the keys in the returned array", async function () {
      const store = makeStore();
      store.set("key1", "v1");
      store.set("key2", "v2");
      store.set("key3", "v3");

      const mw  = CacheMiddleware.invalidate(store, () => ["key1", "key2"]);
      const res = mockRes(200);

      mw(mockReq(), res, () => {});
      res.json({});

      await flushImmediate();

      expect(store.get("key1")).to.equal(undefined);
      expect(store.get("key2")).to.equal(undefined);
      expect(store.get("key3")).to.equal("v3"); // untouched
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // invalidate() — multiple stores
  // ─────────────────────────────────────────────────────────────────────────

  describe("invalidate() — multiple stores", function () {
    it("invalidates matching keys in both storeA and storeB", async function () {
      const storeA = makeStore();
      const storeB = makeStore();

      storeA.set("shared-key", "from A");
      storeB.set("shared-key", "from B");
      storeA.set("a-only", "only in A");

      const mw  = CacheMiddleware.invalidate([storeA, storeB], () => "shared-key");
      const res = mockRes(200);

      mw(mockReq(), res, () => {});
      res.json({});

      await flushImmediate();

      expect(storeA.get("shared-key")).to.equal(undefined);
      expect(storeB.get("shared-key")).to.equal(undefined);
      expect(storeA.get("a-only")).to.equal("only in A"); // untouched
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // invalidateWhere() — predicate
  // ─────────────────────────────────────────────────────────────────────────

  describe("invalidateWhere() — predicate", function () {
    it("deletes only keys matching the predicate", async function () {
      const store = makeStore();
      store.set("old:session:1", "a");
      store.set("old:session:2", "b");
      store.set("new:session:3", "c");
      store.set("new:session:4", "d");

      const mw  = CacheMiddleware.invalidateWhere(store, (key) => key.includes("old"));
      const res = mockRes(200);

      mw(mockReq(), res, () => {});
      res.json({});

      await flushImmediate();

      expect(store.get("old:session:1")).to.equal(undefined);
      expect(store.get("old:session:2")).to.equal(undefined);
      expect(store.get("new:session:3")).to.equal("c");
      expect(store.get("new:session:4")).to.equal("d");
    });

    it("predicate throwing is caught internally; response already sent successfully", async function () {
      const store = makeStore();
      store.set("intact", "data");

      const mw    = CacheMiddleware.invalidateWhere(store, () => { throw new Error("predicate exploded"); });
      const res   = mockRes(200);
      let   result;

      mw(mockReq(), res, () => {});
      result = res.json({ sent: true });

      await flushImmediate();

      // Response was sent; the error was swallowed by the middleware.
      expect(result).to.equal(res);
      // Store is unaffected because the error occurred before any deletion.
      expect(store.get("intact")).to.equal("data");
    });

    it("does NOT invalidate when controller responds with 4xx", async function () {
      const store = makeStore();
      store.set("protected", "safe");

      const predicateSpy = sinon.spy(() => true);
      const mw           = CacheMiddleware.invalidateWhere(store, predicateSpy);
      const res          = mockRes(400);

      mw(mockReq(), res, () => {});
      res.json({ error: "bad" });

      await flushImmediate();

      expect(predicateSpy.called).to.be.false;
      expect(store.get("protected")).to.equal("safe");
    });
  });
});
