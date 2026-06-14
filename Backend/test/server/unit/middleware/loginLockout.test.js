"use strict";

/**
 * @fileoverview Unit tests for LoginLockoutMiddleware.
 *
 * All tests inject a fresh CacheStore via options.store so the
 * module-level singleton (loginLockout) is never touched.
 * Tests are fully isolated — no HTTP, no DB, no file I/O.
 *
 * Covers:
 *   constructor — defaults, custom options, store injection
 *   check()     — unknown user, active lock, expired lock, HR-reset
 *   recordFailure() — increment, lockout engagement, cycle/duration progression
 *   recordSuccess() — clean slate
 *   Full progressive sequence: 3→2→1 attempts, then permanent HR-reset
 *   Fixed-mode: constant duration across cycles
 *   currentMax floor: never drops below 1
 *
 * Complexity: O(1) per method call (hash-map backed CacheStore).
 */

const { expect } = require("chai");

const {
  LoginLockoutMiddleware,
} = require("../../../../src/middleware/authentication/LoginLockoutMiddleware");
const { CacheStore } = require("../../../../src/middleware/cache/CacheStore");

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _seq = 0;

function makeStore() {
  return new CacheStore(`lockout-test-${++_seq}`, { ttl: 86400, checkPeriod: 3600 });
}

function makeLockout(opts = {}) {
  return new LoginLockoutMiddleware({ store: makeStore(), ...opts });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe("LoginLockoutMiddleware — unit tests", function () {

  // ── Constructor ─────────────────────────────────────────────────────────────

  describe("constructor", function () {
    it("initialises with sane positive defaults", function () {
      const l = makeLockout();
      expect(l._maxAttempts).to.be.a("number").and.greaterThan(0);
      expect(l._lockoutDurationMs).to.be.a("number").and.greaterThan(0);
      expect(l._maxLockoutCycles).to.be.a("number").and.greaterThan(0);
      expect(l._retryDecrement).to.be.a("number").and.greaterThanOrEqual(0);
    });

    it("accepts custom maxAttempts", function () {
      const l = makeLockout({ maxAttempts: 7 });
      expect(l._maxAttempts).to.equal(7);
    });

    it("accepts custom lockoutDurationMs", function () {
      const l = makeLockout({ lockoutDurationMs: 120_000 });
      expect(l._lockoutDurationMs).to.equal(120_000);
    });

    it("accepts 'fixed' lockoutMode", function () {
      const l = makeLockout({ lockoutMode: "fixed" });
      expect(l._lockoutMode).to.equal("fixed");
    });

    it("accepts 'incremental' lockoutMode", function () {
      const l = makeLockout({ lockoutMode: "incremental" });
      expect(l._lockoutMode).to.equal("incremental");
    });

    it("accepts custom CacheStore via options.store (injected store is used)", function () {
      const store = makeStore();
      const l = new LoginLockoutMiddleware({ store });
      expect(l._store).to.equal(store);
    });
  });

  // ── check() ─────────────────────────────────────────────────────────────────

  describe("check()", function () {
    it("unknown userId → { locked: false }", function () {
      const l = makeLockout();
      expect(l.check("unknown-user-xyz")).to.deep.equal({ locked: false });
    });

    it("active lockout window → { locked: true, retryAfter: N } where N > 0", function () {
      const l = makeLockout({ maxAttempts: 1, lockoutDurationMs: 60_000 });
      l.recordFailure("user-A");
      const result = l.check("user-A");
      expect(result.locked).to.be.true;
      expect(result.retryAfter).to.be.a("number").and.greaterThan(0);
    });

    it("expired lockout window → { locked: false } (window cleared on check)", async function () {
      const l = makeLockout({ maxAttempts: 1, lockoutDurationMs: 5 });
      l.recordFailure("user-B");
      await sleep(15);
      const result = l.check("user-B");
      expect(result.locked).to.be.false;
    });

    it("check() on an expired lock resets failCount to 0 (next failure starts fresh)", async function () {
      // maxAttempts: 1 so the first failure immediately engages the lock.
      // After the lock expires, check() clears it and resets failCount → 0.
      const l = makeLockout({ maxAttempts: 1, lockoutDurationMs: 5 });
      l.recordFailure("user-C"); // failCount hits max → lockout engaged, failCount resets to 0
      await sleep(15);           // wait for the 5ms lock to expire
      l.check("user-C");         // expired lock → clears state
      const state = l._readState("user-C");
      expect(state.failCount).to.equal(0);
    });

    it("HR-reset state (all cycles exhausted) → { locked: false, hrReset: true }", async function () {
      const l = makeLockout({
        maxAttempts:       1,
        lockoutDurationMs: 5,
        maxLockoutCycles:  1,
        retryDecrement:    0,
      });
      l.recordFailure("user-D"); // cycle 1 engaged immediately
      await sleep(15);
      const result = l.check("user-D");
      expect(result.hrReset).to.be.true;
      expect(result.locked).to.be.false;
    });

    it("check() is read-only — calling it does not increment failCount", function () {
      const l = makeLockout({ maxAttempts: 5 });
      l.check("user-E");
      l.check("user-E");
      l.check("user-E");
      const state = l._readState("user-E");
      expect(state.failCount).to.equal(0);
    });
  });

  // ── recordFailure() ─────────────────────────────────────────────────────────

  describe("recordFailure()", function () {
    it("increments failCount by 1 on each call", function () {
      const l = makeLockout({ maxAttempts: 5 });
      l.recordFailure("user-F");
      expect(l._readState("user-F").failCount).to.equal(1);
      l.recordFailure("user-F");
      expect(l._readState("user-F").failCount).to.equal(2);
    });

    it("engages lockout when failCount reaches currentMax", function () {
      const l = makeLockout({ maxAttempts: 2, lockoutDurationMs: 30_000 });
      l.recordFailure("user-G");
      l.recordFailure("user-G"); // hits maxAttempts = 2
      const state = l._readState("user-G");
      expect(state.lockUntil).to.be.a("number").and.greaterThan(Date.now());
    });

    it("increments cycles counter when lockout engages", function () {
      const l = makeLockout({ maxAttempts: 1, lockoutDurationMs: 30_000 });
      l.recordFailure("user-H");
      expect(l._readState("user-H").cycles).to.equal(1);
    });

    it("resets failCount to 0 after lockout engages", function () {
      const l = makeLockout({ maxAttempts: 1, lockoutDurationMs: 30_000 });
      l.recordFailure("user-I");
      expect(l._readState("user-I").failCount).to.equal(0);
    });

    it("lockout duration increases each cycle in incremental mode", async function () {
      const BASE = 10;
      const l = makeLockout({
        maxAttempts:       1,
        lockoutDurationMs: BASE,
        lockoutMode:       "incremental",
        lockoutMultiplier: 2,
        maxLockoutCycles:  5,
        retryDecrement:    0,
      });

      // Cycle 1 — base duration
      l.recordFailure("user-J");
      const state1 = l._readState("user-J");
      const dur1 = state1.lockUntil - Date.now();
      expect(dur1).to.be.approximately(BASE, 15);

      await sleep(20); // let lock expire

      // Cycle 2 — doubled duration
      l.check("user-J");         // clears expired lock
      l.recordFailure("user-J");
      const state2 = l._readState("user-J");
      const dur2 = state2.lockUntil - Date.now();
      expect(dur2).to.be.approximately(BASE * 2, 20);
    });

    it("lockout duration is constant across cycles in fixed mode", async function () {
      const FIXED = 10;
      const l = makeLockout({
        maxAttempts:       1,
        lockoutDurationMs: FIXED,
        lockoutMode:       "fixed",
        maxLockoutCycles:  5,
        retryDecrement:    0,
      });

      l.recordFailure("user-K");
      const dur1 = l._readState("user-K").lockUntil - Date.now();

      await sleep(20);
      l.check("user-K");
      l.recordFailure("user-K");
      const dur2 = l._readState("user-K").lockUntil - Date.now();

      // Both durations should be within ±15ms of the fixed value
      expect(dur1).to.be.approximately(FIXED, 15);
      expect(dur2).to.be.approximately(FIXED, 15);
    });

    it("currentMax decrements by retryDecrement after each lockout cycle", async function () {
      const l = makeLockout({
        maxAttempts:       3,
        lockoutDurationMs: 5,
        retryDecrement:    1,
        maxLockoutCycles:  5,
        lockoutMode:       "fixed",
      });

      // Cycle 1: 3 failures → currentMax becomes 2
      l.recordFailure("user-L");
      l.recordFailure("user-L");
      l.recordFailure("user-L");
      expect(l._readState("user-L").currentMax).to.equal(2);

      await sleep(15);
      l.check("user-L"); // clear lock

      // Cycle 2: 2 failures → currentMax becomes 1
      l.recordFailure("user-L");
      l.recordFailure("user-L");
      expect(l._readState("user-L").cycles).to.equal(2);
      expect(l._readState("user-L").currentMax).to.equal(1);
    });

    it("currentMax never drops below 1 (max(1, ...) floor enforced)", async function () {
      const l = makeLockout({
        maxAttempts:       1,
        lockoutDurationMs: 5,
        retryDecrement:    99, // would go negative without the floor
        maxLockoutCycles:  5,
      });
      l.recordFailure("user-M");
      await sleep(15);
      l.check("user-M");
      l.recordFailure("user-M");
      expect(l._readState("user-M").currentMax).to.be.greaterThanOrEqual(1);
    });
  });

  // ── recordSuccess() ─────────────────────────────────────────────────────────

  describe("recordSuccess()", function () {
    it("deletes userId state — _readState returns factory defaults", function () {
      const l = makeLockout({ maxAttempts: 2, lockoutDurationMs: 30_000 });
      l.recordFailure("user-N");
      l.recordSuccess("user-N");
      const state = l._readState("user-N");
      expect(state.failCount).to.equal(0);
      expect(state.cycles).to.equal(0);
      expect(state.lockUntil).to.equal(null);
    });

    it("subsequent check() after recordSuccess → { locked: false }", function () {
      const l = makeLockout({ maxAttempts: 1, lockoutDurationMs: 30_000 });
      l.recordFailure("user-O"); // engage lock
      l.recordSuccess("user-O"); // clear
      expect(l.check("user-O").locked).to.be.false;
    });

    it("recordSuccess on an unknown userId does not throw", function () {
      const l = makeLockout();
      expect(() => l.recordSuccess("never-seen-user")).to.not.throw();
    });
  });

  // ── Full progressive lockout sequence ───────────────────────────────────────

  describe("full progressive lockout sequence (incremental mode, 3 cycles → HR-reset)", function () {
    it("3 fails → lock → 2 fails → lock → 1 fail → lock → HR-reset", async function () {
      this.timeout(600);

      const l = makeLockout({
        maxAttempts:       3,
        lockoutDurationMs: 15,
        lockoutMode:       "incremental",
        lockoutMultiplier: 2,
        maxLockoutCycles:  3,
        retryDecrement:    1,
      });
      const USER = "progressive-user";

      // ── Cycle 1: 3 failures ──────────────────────────────────────────────────
      l.recordFailure(USER);
      l.recordFailure(USER);
      l.recordFailure(USER);
      expect(l.check(USER).locked, "cycle 1: should be locked").to.be.true;

      await sleep(25); // let 15ms lock expire

      // ── Cycle 2: 2 failures (currentMax decremented to 2) ───────────────────
      l.check(USER);    // clears expired lock
      l.recordFailure(USER);
      l.recordFailure(USER);
      expect(l.check(USER).locked, "cycle 2: should be locked").to.be.true;
      expect(l._readState(USER).cycles).to.equal(2);

      await sleep(50); // 15 * 2^1 = 30ms lock; wait 50ms

      // ── Cycle 3: 1 failure (currentMax decremented to 1) ────────────────────
      l.check(USER);
      l.recordFailure(USER);
      expect(l.check(USER).locked, "cycle 3: should be locked").to.be.true;
      expect(l._readState(USER).cycles).to.equal(3);

      await sleep(100); // 15 * 2^2 = 60ms lock; wait 100ms

      // ── All cycles exhausted → HR-reset ──────────────────────────────────────
      const final = l.check(USER);
      expect(final.hrReset,  "should be hrReset after all cycles").to.be.true;
      expect(final.locked,   "should not be locked in hrReset state").to.be.false;
    });
  });

  // ── Isolation: one user's state does not affect another ─────────────────────

  describe("user state isolation", function () {
    it("locking user-A does not lock user-B", function () {
      const l = makeLockout({ maxAttempts: 1, lockoutDurationMs: 30_000 });
      l.recordFailure("iso-user-A");
      expect(l.check("iso-user-A").locked).to.be.true;
      expect(l.check("iso-user-B").locked).to.be.false;
    });

    it("recordSuccess on user-A does not clear user-B's state", function () {
      const l = makeLockout({ maxAttempts: 1, lockoutDurationMs: 30_000 });
      l.recordFailure("iso-user-C");
      l.recordFailure("iso-user-D");
      l.recordSuccess("iso-user-C");
      expect(l.check("iso-user-D").locked).to.be.true;
    });
  });
});
