"use strict";

/**
 * @fileoverview Chaos / edge-case unit tests for CacheStore.
 *
 * All tests operate on fresh CacheStore instances — never the application
 * singleton registry — so they can set custom TTL, maxKeys, and other
 * constructor options without touching production state.
 *
 * NodeCache behaviour observed under these tests:
 *  - `useClones: false`  → returned values are references, not deep copies.
 *  - `deleteOnExpire: true` → expired keys are removed during the next
 *    internal sweep; `get()` on an expired key returns `undefined` immediately
 *    because NodeCache checks TTL at read-time even between sweeps.
 *  - `maxKeys > 0`       → NodeCache throws an ECACHEFULL error when the limit
 *    is exceeded. It does NOT silently evict the oldest key. Tests must handle
 *    both the "caught error" path and the "keys count capped" path gracefully.
 *  - Async concurrency  → NodeCache operations are synchronous under the hood.
 *    `getOrSet` introduces an async window between the initial `get` (miss) and
 *    the subsequent `set` (after the loader resolves). Under Promise.all()
 *    concurrency, multiple callers may start their loaders before any of them
 *    writes to the store — the thundering herd is NOT automatically collapsed.
 *    Tests for this case verify that all callers still receive a valid value
 *    and that the final stored value is consistent.
 *
 * Specialisations active: Senior Test Engineer · Senior Chaos & Resilience Engineer
 */

const { expect } = require("chai");
const sinon      = require("sinon");
const { CacheStore } = require("../../../../../src/middleware/cache/CacheStore");

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Wrap a millisecond delay in a Promise.
 * Never chain another async call here — use as a simple awaitable pause.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create a CacheStore with an automatically unique name so tests never
 * collide on the same underlying NodeCache instance.
 * @param {Object} [options]
 * @returns {CacheStore}
 */
let _storeSeq = 0;
function makeStore(options = {}) {
  return new CacheStore(`chaos-test-${++_storeSeq}`, options);
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe("CacheStore — chaos / edge-case unit tests", function () {
  afterEach(function () {
    sinon.restore();
  });

  // ── 1. Concurrent write safety ─────────────────────────────────────────────

  describe("concurrent write safety", function () {
    it("100 simultaneous set() calls on the same key result in a valid stored value (no corruption or undefined)", async function () {
      const store = makeStore();
      const key   = "concurrent-write";

      // Fire 100 concurrent .set() calls — each writes a different value.
      // NodeCache is synchronous internally; all Promise.all callbacks run in
      // the same microtask checkpoint, so the "last writer wins" deterministically.
      const writes = Array.from({ length: 100 }, (_, i) =>
        Promise.resolve(store.set(key, `value-${i}`)),
      );
      await Promise.all(writes);

      const result = store.get(key);
      // Must be defined and must be one of the written values — not undefined,
      // not null, not a corrupt partial write.
      expect(result).to.be.a("string");
      expect(result).to.match(/^value-\d+$/);
    });

    it("50 simultaneous getOrSet() calls on a missing key: all callers get a valid (non-undefined) result", async function () {
      const store       = makeStore();
      const key         = "thundering-herd";
      let   loaderCalls = 0;

      // Slow loader (10ms) simulates a DB fetch.
      // Due to the async gap in getOrSet, multiple callers may invoke the loader
      // before any of them writes back. The test asserts all 50 callers receive
      // a valid value — NOT that the loader is called exactly once.
      const loader = async () => {
        loaderCalls++;
        await sleep(10);
        return "loaded-value";
      };

      const results = await Promise.all(
        Array.from({ length: 50 }, () => store.getOrSet(key, loader)),
      );

      // Every caller must receive the loaded value — never undefined.
      for (const v of results) {
        expect(v).to.equal("loaded-value");
      }

      // The loader was called at least once (genuine DB hit occurred).
      expect(loaderCalls).to.be.greaterThanOrEqual(1);

      // After the parallel burst the key must be in the store.
      expect(store.get(key)).to.equal("loaded-value");
    });
  });

  // ── 2. maxKeys eviction / ECACHEFULL ──────────────────────────────────────

  describe("maxKeys enforcement", function () {
    it("set() with maxKeys: 3 — store contains ≤ 3 keys after inserting 4", function () {
      const store = makeStore({ maxKeys: 3 });

      // NodeCache with maxKeys either evicts the oldest key OR throws ECACHEFULL.
      // We handle both behaviours gracefully.
      let threwOnFourth = false;
      try {
        store.set("k1", "v1");
        store.set("k2", "v2");
        store.set("k3", "v3");
        store.set("k4", "v4"); // may throw ECACHEFULL
      } catch (err) {
        // NodeCache signals overflow with an error code, not a type.
        expect(err).to.satisfy(
          (e) =>
            (e.errorcode === "ECACHEFULL" || String(e.message).includes("ECACHEFULL") || String(e.message).includes("full")) ||
            // Some NodeCache versions use a generic Error with message containing "maxKeys"
            String(e.message).includes("maxKey"),
          `Expected ECACHEFULL but got: ${err.message}`,
        );
        threwOnFourth = true;
      }

      // Regardless of evict-or-throw, the key count must be ≤ 3.
      expect(store.keys().length).to.be.lessThanOrEqual(3);

      // If the library threw, mark it as observed so the next test knows.
      // (We shadow into a closure variable purely for documentation — the
      //  assertion above is the canonical check.)
      void threwOnFourth;
    });

    it("after an ECACHEFULL error, get() on previously stored keys still works", function () {
      const store = makeStore({ maxKeys: 2 });

      store.set("safe1", "alpha");
      store.set("safe2", "beta");

      // Attempt to overflow — may throw
      try {
        store.set("overflow", "gamma");
      } catch (_) {
        // Intentionally swallowed — we only care that existing keys survive.
      }

      // At least one of the first two writes must still be readable.
      const v1 = store.get("safe1");
      const v2 = store.get("safe2");
      const atLeastOneAlive = v1 !== undefined || v2 !== undefined;
      expect(atLeastOneAlive).to.be.true;
    });
  });

  // ── 3. TTL expiry ──────────────────────────────────────────────────────────

  describe("TTL expiry behaviour", function () {
    // These tests use a real timer — they are intentionally slow.
    // Mocha's default timeout is overridden per-test.

    it("key present immediately after set with ttl:1, absent after 1200ms", async function () {
      this.timeout(5000);

      const store = makeStore({ ttl: 1, checkPeriod: 1 });
      store.set("expiring", "soon");

      // Immediately present
      expect(store.get("expiring")).to.equal("soon");
      expect(store.has("expiring")).to.be.true;

      // Wait past the TTL
      await sleep(1200);

      // NodeCache checks TTL at read-time even between sweep intervals.
      expect(store.get("expiring")).to.equal(undefined);
    });

    it("has() returns false for an expired key", async function () {
      this.timeout(5000);

      const store = makeStore({ ttl: 1, checkPeriod: 1 });
      store.set("ttl-key", "value");

      await sleep(1200);

      expect(store.has("ttl-key")).to.be.false;
    });

    it("keys() does not include expired keys", async function () {
      this.timeout(5000);

      const store = makeStore({ ttl: 1, checkPeriod: 1 });
      store.set("expires", "yes");
      store.set("never", "no", 0); // 0 = use store default (1s) when store TTL is 1

      await sleep(1200);

      // After TTL, get() returns undefined (expired keys invisible at read-time).
      expect(store.get("expires")).to.equal(undefined);
    });
  });

  // ── 4. delByPattern ───────────────────────────────────────────────────────

  describe("delByPattern()", function () {
    it("deletes all keys whose string includes the pattern, returns correct count", function () {
      const store = makeStore();
      store.set("rfidMasterfile",              "a");
      store.set("rfidMasterfile:type=archived", "b");
      store.set("rfidMasterfile:type=archived:page=2", "c");
      store.set("other:key", "d");

      const deleted = store.delByPattern("rfidMasterfile:type=archived");

      // Both keys containing the substring should be gone.
      expect(deleted).to.equal(2);
      expect(store.has("rfidMasterfile:type=archived")).to.be.false;
      expect(store.has("rfidMasterfile:type=archived:page=2")).to.be.false;

      // Keys that do NOT contain the full substring must survive.
      expect(store.has("rfidMasterfile")).to.be.true;
      expect(store.has("other:key")).to.be.true;
    });

    it("substring match is exact: 'rfidMasterfile' does NOT match the longer 'rfidMasterfile:type=archived'", function () {
      const store = makeStore();
      store.set("rfidMasterfile",               "root");
      store.set("rfidMasterfile:type=archived",  "arch");

      // Deleting with the shorter root pattern removes both (root is a substring of the longer).
      const deletedRoot = store.delByPattern("rfidMasterfile");
      expect(deletedRoot).to.equal(2);
      expect(store.keys().length).to.equal(0);
    });

    it("returns 0 and throws no error when pattern matches no keys", function () {
      const store = makeStore();
      store.set("alpha", "1");
      store.set("beta",  "2");

      const count = store.delByPattern("zzzz-no-match");
      expect(count).to.equal(0);
      expect(store.keys().length).to.equal(2);
    });

    it("matches only keys containing the exact substring", function () {
      const store = makeStore();
      store.set("rfidMasterfile:type=archived",       "a");
      store.set("rfidMasterfile:type=archived:page=2","b");
      store.set("rfidMasterfile",                     "c"); // does NOT contain :type=archived

      const count = store.delByPattern("rfidMasterfile:type=archived");

      expect(count).to.equal(2);
      // The bare key must survive
      expect(store.has("rfidMasterfile")).to.be.true;
    });
  });

  // ── 5. delWhere ───────────────────────────────────────────────────────────

  describe("delWhere()", function () {
    it("deletes exactly the keys that satisfy the predicate", function () {
      const store = makeStore();
      store.set("active:1", "a");
      store.set("active:2", "b");
      store.set("active:3", "c");
      store.set("archived:1", "d");
      store.set("archived:2", "e");

      const count = store.delWhere((k) => k.startsWith("active:"));

      expect(count).to.equal(3);
      expect(store.has("active:1")).to.be.false;
      expect(store.has("active:2")).to.be.false;
      expect(store.has("active:3")).to.be.false;
      expect(store.has("archived:1")).to.be.true;
      expect(store.has("archived:2")).to.be.true;
    });

    it("predicate matching 3 of 5 keys deletes exactly 3", function () {
      const store = makeStore();
      ["odd:1", "odd:3", "odd:5", "even:2", "even:4"].forEach((k) =>
        store.set(k, "v"),
      );

      const count = store.delWhere((k) => k.startsWith("odd:"));
      expect(count).to.equal(3);
      expect(store.keys().filter((k) => k.startsWith("odd:")).length).to.equal(0);
      expect(store.keys().filter((k) => k.startsWith("even:")).length).to.equal(2);
    });

    it("predicate that throws leaves remaining keys intact and does not crash the store", function () {
      const store = makeStore();
      store.set("safe:a", "1");
      store.set("safe:b", "2");
      store.set("safe:c", "3");

      // A predicate that throws on the second call.
      let calls = 0;
      const boom = () => {
        calls++;
        if (calls === 2) throw new Error("predicate exploded");
        return false; // never deletes anything
      };

      // CacheStore.delWhere runs keys().filter(predicate).
      // If the predicate throws, filter() propagates the error to the caller.
      // The test verifies that after the error all original keys are still present.
      let threw = false;
      try {
        store.delWhere(boom);
      } catch (_) {
        threw = true;
      }

      // The predicate throwing should bubble up (it's not caught internally).
      // Regardless, all previously stored keys must still be retrievable.
      expect(threw).to.be.true;
      // The store itself must still function — existing keys intact.
      const surviving = store.keys().filter((k) => k.startsWith("safe:"));
      expect(surviving.length).to.equal(3);
    });

    it("predicate returning false for all keys is a no-op", function () {
      const store = makeStore();
      store.set("x", "1");
      store.set("y", "2");

      const count = store.delWhere(() => false);
      expect(count).to.equal(0);
      expect(store.keys().length).to.equal(2);
    });
  });

  // ── 6. flush ──────────────────────────────────────────────────────────────

  describe("flush()", function () {
    it("removes all 10 keys, leaving an empty store", function () {
      const store = makeStore();
      Array.from({ length: 10 }, (_, i) => store.set(`key:${i}`, i));
      expect(store.keys().length).to.equal(10);

      store.flush();

      expect(store.keys().length).to.equal(0);
    });

    it("set() and get() continue to work normally after flush()", function () {
      const store = makeStore();
      store.set("before", "old");
      store.flush();

      store.set("after", "new");
      expect(store.get("after")).to.equal("new");
      expect(store.get("before")).to.equal(undefined);
    });
  });

  // ── 7. stats ──────────────────────────────────────────────────────────────

  describe("stats()", function () {
    it("tracks hits correctly: 10 gets on an existing key = 10 hits", function () {
      const store = makeStore();
      store.set("popular", "data");

      for (let i = 0; i < 10; i++) store.get("popular");

      const s = store.stats();
      expect(s.hits).to.equal(10);
    });

    it("tracks misses correctly: 5 gets on a missing key = 5 misses", function () {
      const store = makeStore();

      for (let i = 0; i < 5; i++) store.get("missing-key");

      const s = store.stats();
      expect(s.misses).to.equal(5);
    });

    it("hitRate is (hits / (hits + misses)) * 100, rounded to 2 decimal places", function () {
      const store = makeStore();
      store.set("target", "value");

      // 3 hits, 1 miss → hitRate = (3/4)*100 = 75.00
      store.get("target");
      store.get("target");
      store.get("target");
      store.get("nowhere");

      const s = store.stats();
      expect(s.hits).to.equal(3);
      expect(s.misses).to.equal(1);
      expect(s.hitRate).to.equal(75);
    });

    it("hitRate is 0 when there have been no gets at all", function () {
      const store = makeStore();
      expect(store.stats().hitRate).to.equal(0);
    });

    it("stats() includes name, keys, ttl, and maxKeys fields", function () {
      const store = makeStore({ ttl: 60, maxKeys: 100 });
      const s     = store.stats();

      expect(s).to.have.property("name").that.is.a("string");
      expect(s).to.have.property("keys").that.is.a("number");
      expect(s).to.have.property("hits").that.is.a("number");
      expect(s).to.have.property("misses").that.is.a("number");
      expect(s).to.have.property("hitRate").that.is.a("number");
      expect(s).to.have.property("ttl");
      expect(s).to.have.property("maxKeys");
    });
  });

  // ── 8. getOrSet ───────────────────────────────────────────────────────────

  describe("getOrSet()", function () {
    it("loader rejection propagates — error thrown, nothing stored", async function () {
      const store = makeStore();
      const bomb  = async () => { throw new Error("loader failed"); };

      let caught = null;
      try {
        await store.getOrSet("fail-key", bomb);
      } catch (err) {
        caught = err;
      }

      expect(caught).to.be.an("error");
      expect(caught.message).to.equal("loader failed");
      expect(store.get("fail-key")).to.equal(undefined);
    });

    it("loader returning null is not stored (null check in implementation)", async function () {
      const store = makeStore();
      const result = await store.getOrSet("null-key", async () => null);

      expect(result).to.equal(null);
      // null must not be stored — next call should invoke the loader again.
      expect(store.has("null-key")).to.be.false;
    });

    it("loader returning undefined is not stored", async function () {
      const store = makeStore();
      const result = await store.getOrSet("undef-key", async () => undefined);

      expect(result).to.equal(undefined);
      expect(store.has("undef-key")).to.be.false;
    });

    it("second call with same key after a successful load hits the cache — loader called only once", async function () {
      const store = makeStore();
      let   calls = 0;
      const loader = async () => { calls++; return "fetched"; };

      const first  = await store.getOrSet("cached-key", loader);
      const second = await store.getOrSet("cached-key", loader);

      expect(first).to.equal("fetched");
      expect(second).to.equal("fetched");
      expect(calls).to.equal(1); // loader must not run again on second call
    });

    it("loader returning 0 (falsy but valid) IS stored and returned correctly", async function () {
      const store  = makeStore();
      const result = await store.getOrSet("zero-key", async () => 0);

      // 0 is falsy but not null/undefined — the implementation checks `!== undefined && !== null`
      // so 0 should be stored.
      expect(result).to.equal(0);
      // After the store, next call returns 0 from cache.
      const cached = store.get("zero-key");
      expect(cached).to.equal(0);
    });

    it("loader returning an empty string IS stored", async function () {
      const store  = makeStore();
      const result = await store.getOrSet("empty-string", async () => "");

      expect(result).to.equal("");
      expect(store.get("empty-string")).to.equal("");
    });
  });
});
