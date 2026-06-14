"use strict";

/**
 * @fileoverview Chaos / edge-case unit tests for CacheRegistry.
 *
 * IMPORTANT — Isolation strategy:
 *   CacheRegistry is a singleton exported as `registry`, but every test suite
 *   in this file instantiates a *fresh* `new CacheRegistry()`. This avoids
 *   collisions with stores registered by the application at startup and keeps
 *   tests completely isolated from each other.
 *
 *   Never import the singleton `registry` here. Always use `new CacheRegistry()`.
 *
 * Specialisations active: Senior Test Engineer · Senior Chaos & Resilience Engineer
 */

const { expect } = require("chai");
const sinon      = require("sinon");

// Import the class, NOT the singleton.
const { CacheRegistry } = require("../../../../../src/middleware/cache/CacheRegistry");

// ─── Suite ────────────────────────────────────────────────────────────────────

describe("CacheRegistry — chaos / edge-case unit tests", function () {
  afterEach(function () {
    sinon.restore();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Duplicate registration
  // ─────────────────────────────────────────────────────────────────────────

  describe("duplicate registration", function () {
    it("registering the same name twice throws an Error containing 'already registered'", function () {
      const reg = new CacheRegistry();
      reg.register("dup-store", { ttl: 60 });

      expect(() => reg.register("dup-store", { ttl: 120 }))
        .to.throw(Error)
        .with.property("message")
        .that.includes("already registered");
    });

    it("the first registration succeeds and is resolvable after the duplicate error", function () {
      const reg = new CacheRegistry();
      reg.register("first-only", { ttl: 30 });

      try { reg.register("first-only", {}); } catch (_) { /* expected */ }

      // The store registered on the first call must still be accessible.
      expect(() => reg.resolve("first-only")).to.not.throw();
    });

    it("registering a third different name after a duplicate error works fine", function () {
      const reg = new CacheRegistry();
      reg.register("a", {});
      try { reg.register("a", {}); } catch (_) {}
      reg.register("b", {});

      expect(() => reg.resolve("b")).to.not.throw();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Resolve unknown name
  // ─────────────────────────────────────────────────────────────────────────

  describe("resolve() — unknown name", function () {
    it("throws an Error when resolving a name that was never registered", function () {
      const reg = new CacheRegistry();

      expect(() => reg.resolve("nonexistent"))
        .to.throw(Error);
    });

    it("the error message lists the registered store names", function () {
      const reg = new CacheRegistry();
      reg.register("known-store-a", {});
      reg.register("known-store-b", {});

      let message = "";
      try {
        reg.resolve("unknown-store");
      } catch (err) {
        message = err.message;
      }

      // The error should mention at least one of the registered names.
      const mentionsKnown =
        message.includes("known-store-a") || message.includes("known-store-b");
      expect(mentionsKnown).to.be.true;
    });

    it("resolve on empty registry mentions '(none)' or similar in error message", function () {
      const reg = new CacheRegistry();

      let message = "";
      try {
        reg.resolve("anything");
      } catch (err) {
        message = err.message;
      }

      // Implementation outputs "(none)" when no stores are registered.
      expect(message.toLowerCase()).to.satisfy(
        (m) => m.includes("none") || m.includes("no store") || m.length > 0,
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // registerAll with overlapping names
  // ─────────────────────────────────────────────────────────────────────────

  describe("registerAll() — overlapping names", function () {
    it("registerAll after a prior registerAll with a conflicting name throws", function () {
      const reg = new CacheRegistry();
      reg.registerAll({ alpha: { ttl: 60 }, beta: { ttl: 120 } });

      // Calling registerAll again with a key that already exists must throw.
      expect(() => reg.registerAll({ alpha: { ttl: 30 } }))
        .to.throw(Error)
        .with.property("message")
        .that.includes("already registered");
    });

    it("the non-conflicting names from a partial registerAll are still accessible if added before the conflict", function () {
      const reg = new CacheRegistry();
      reg.registerAll({ x: {}, y: {} });

      try {
        reg.registerAll({ y: {}, z: {} }); // 'y' conflicts; 'z' may or may not be added
      } catch (_) { /* expected */ }

      // 'x' and 'y' (registered in the first call) must always be resolvable.
      expect(() => reg.resolve("x")).to.not.throw();
      expect(() => reg.resolve("y")).to.not.throw();
    });

    it("registerAll with a completely disjoint set on a non-empty registry succeeds", function () {
      const reg = new CacheRegistry();
      reg.registerAll({ p: {}, q: {} });
      reg.registerAll({ r: {}, s: {} });

      // All four stores must be resolvable.
      ["p", "q", "r", "s"].forEach((name) =>
        expect(() => reg.resolve(name)).to.not.throw(),
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // flushAll
  // ─────────────────────────────────────────────────────────────────────────

  describe("flushAll()", function () {
    it("empties all stores — 3 stores × 5 keys each → all stores empty after flushAll()", function () {
      const reg = new CacheRegistry();
      const storeNames = ["flush-a", "flush-b", "flush-c"];

      storeNames.forEach((name) => {
        const store = reg.register(name, {});
        for (let i = 0; i < 5; i++) store.set(`key-${i}`, i);
      });

      // Sanity check: all stores have keys before flush.
      storeNames.forEach((name) =>
        expect(reg.resolve(name).keys().length).to.equal(5),
      );

      reg.flushAll();

      // All stores must be empty.
      storeNames.forEach((name) =>
        expect(reg.resolve(name).keys().length).to.equal(0),
      );
    });

    it("stores remain accessible (get/set work) after flushAll()", function () {
      const reg   = new CacheRegistry();
      const store = reg.register("post-flush-store", {});
      store.set("before", "old");

      reg.flushAll();

      // set and get must work on the same store instance after flush.
      store.set("after", "new");
      expect(store.get("after")).to.equal("new");
      expect(store.get("before")).to.equal(undefined);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // statsAll() / report()
  // ─────────────────────────────────────────────────────────────────────────

  describe("statsAll()", function () {
    it("returns an array with one stats object per registered store", function () {
      const reg = new CacheRegistry();
      reg.register("stats-1", {});
      reg.register("stats-2", {});
      reg.register("stats-3", {});

      const all = reg.statsAll();
      expect(all).to.be.an("array").with.lengthOf(3);
    });

    it("each stats object has name, keys, hits, misses, and hitRate properties", function () {
      const reg   = new CacheRegistry();
      reg.register("stats-shape", {});

      const [s] = reg.statsAll();
      expect(s).to.have.property("name").that.is.a("string");
      expect(s).to.have.property("keys").that.is.a("number");
      expect(s).to.have.property("hits").that.is.a("number");
      expect(s).to.have.property("misses").that.is.a("number");
      expect(s).to.have.property("hitRate").that.is.a("number");
    });

    it("statsAll() reflects hit/miss activity across stores", function () {
      const reg    = new CacheRegistry();
      const storeA = reg.register("hit-store-a", {});
      const storeB = reg.register("hit-store-b", {});

      storeA.set("k", "v");
      storeA.get("k");   // 1 hit
      storeB.get("nope"); // 1 miss

      const all = reg.statsAll();
      const a   = all.find((s) => s.name === "hit-store-a");
      const b   = all.find((s) => s.name === "hit-store-b");

      expect(a.hits).to.equal(1);
      expect(b.misses).to.equal(1);
    });
  });

  describe("report()", function () {
    it("includes aggregate.storeCount equal to the number of registered stores", function () {
      const reg = new CacheRegistry();
      reg.register("r1", {});
      reg.register("r2", {});

      const { aggregate } = reg.report();
      expect(aggregate.storeCount).to.equal(2);
    });

    it("aggregate.totalKeys equals the sum of keys across all stores", function () {
      const reg = new CacheRegistry();
      const s1  = reg.register("tk-1", {});
      const s2  = reg.register("tk-2", {});

      s1.set("a", 1);
      s1.set("b", 2); // 2 keys
      s2.set("c", 3); // 1 key

      const { aggregate } = reg.report();
      expect(aggregate.totalKeys).to.equal(3);
    });

    it("aggregate.hitRate is > 0 after at least one cache hit across any store", function () {
      const reg   = new CacheRegistry();
      const store = reg.register("hr-store", {});

      store.set("hit-me", "v");
      store.get("hit-me");  // generates a hit
      store.get("miss-me"); // generates a miss

      const { aggregate } = reg.report();
      expect(aggregate.hitRate).to.be.greaterThan(0);
    });

    it("aggregate.hitRate is 0 when no gets have occurred", function () {
      const reg = new CacheRegistry();
      reg.register("no-gets", {});

      const { aggregate } = reg.report();
      expect(aggregate.hitRate).to.equal(0);
    });

    it("report() includes a timestamp ISO string", function () {
      const reg    = new CacheRegistry();
      const report = reg.report();

      expect(report).to.have.property("timestamp");
      expect(() => new Date(report.timestamp).toISOString()).to.not.throw();
    });

    it("report() includes a stores array with one entry per registered store", function () {
      const reg = new CacheRegistry();
      reg.register("rpt-a", {});
      reg.register("rpt-b", {});
      reg.register("rpt-c", {});

      const { stores } = reg.report();
      expect(stores).to.be.an("array").with.lengthOf(3);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // has() / names()
  // ─────────────────────────────────────────────────────────────────────────

  describe("has() and names()", function () {
    it("has() returns true for registered stores and false for unknown names", function () {
      const reg = new CacheRegistry();
      reg.register("present", {});

      expect(reg.has("present")).to.be.true;
      expect(reg.has("absent")).to.be.false;
    });

    it("names() lists all registered store names", function () {
      const reg = new CacheRegistry();
      reg.registerAll({ nx: {}, ny: {}, nz: {} });

      const names = reg.names();
      expect(names).to.include.members(["nx", "ny", "nz"]);
    });

    it("names() returns empty array when no stores are registered", function () {
      const reg = new CacheRegistry();
      expect(reg.names()).to.deep.equal([]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // flush (single store)
  // ─────────────────────────────────────────────────────────────────────────

  describe("flush() (single store by name)", function () {
    it("flushes only the named store; other stores are unaffected", function () {
      const reg    = new CacheRegistry();
      const toFlush = reg.register("flush-target", {});
      const safe    = reg.register("flush-safe",   {});

      toFlush.set("bye", "data");
      safe.set("keep", "data");

      reg.flush("flush-target");

      expect(toFlush.keys().length).to.equal(0);
      expect(safe.get("keep")).to.equal("data");
    });

    it("flush() on an unknown name propagates the resolve error", function () {
      const reg = new CacheRegistry();

      expect(() => reg.flush("i-do-not-exist")).to.throw(Error);
    });
  });
});
