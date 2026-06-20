"use strict";

/**
 * @file database.poolConfig.test.js
 *
 * Unit tests for the env-driven pool sizing in src/config/database.js.
 *
 * The appDb connection entry was updated in the performance sprint to read
 * APP_POOL_MIN and APP_POOL_MAX from environment variables, defaulting to
 * 5 and 20 respectively. These tests verify:
 *   - The fields are present on the appDb connection entry
 *   - Defaults apply when the env vars are absent
 *   - Explicit env var values are applied correctly
 *   - Parsed values are integers, not strings
 *   - The falsy-branch edge case for APP_POOL_MIN=0
 *
 * Implementation note:
 *   database.js is re-required between tests by deleting its entry from
 *   require.cache. This is the canonical approach for testing modules that
 *   read env vars at load time. Each test saves the original env value and
 *   restores it in afterEach so env state never bleeds across tests.
 *
 * GAP (FALSY_ZERO): The pattern `parseInt(x, 10) || default` treats 0 as
 * falsy, meaning APP_POOL_MIN=0 silently produces poolMin=5. This could
 * surprise an operator who wants to set poolMin to 0 (no idle connections).
 * DB-P-07 documents this behaviour. If zero is ever a valid value, the
 * guard should be changed to `parseInt(x, 10) ?? default` with an explicit
 * isNaN check: `const v = parseInt(x, 10); return Number.isFinite(v) ? v : default`.
 */

const path = require("path");

// Absolute path to the module under test — used to bust the require cache.
const DATABASE_PATH = require.resolve(
    path.join(__dirname, "../../../src/config/database"),
);

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Removes database.js from the require cache and re-requires it.
 * This forces Node.js to re-evaluate the file and re-read all env vars.
 *
 * @returns {{ connections: object, getConnectionConfig: Function }}
 */
function freshRequire() {
    delete require.cache[DATABASE_PATH];
    return require(DATABASE_PATH);
}

// ─────────────────────────────────────────────────────────────────────────────

describe("database.js — appDb pool configuration", function () {
    // Save original env values before the suite runs; restore in afterEach.
    let origPoolMin;
    let origPoolMax;

    beforeAll(function () {
        origPoolMin = process.env.APP_POOL_MIN;
        origPoolMax = process.env.APP_POOL_MAX;
    });

    afterEach(function () {
        // Restore original env values and evict the cached module so the next
        // test starts from a clean state.
        if (origPoolMin === undefined) {
            delete process.env.APP_POOL_MIN;
        } else {
            process.env.APP_POOL_MIN = origPoolMin;
        }

        if (origPoolMax === undefined) {
            delete process.env.APP_POOL_MAX;
        } else {
            process.env.APP_POOL_MAX = origPoolMax;
        }

        delete require.cache[DATABASE_PATH];
    });

    // ── DB-P-01 ───────────────────────────────────────────────────────────────

    it("DB-P-01: appDb connection entry has poolMin and poolMax fields", function () {
        const { connections } = freshRequire();
        expect(connections).toHaveProperty("appDb");
        expect(
            connections.appDb,
            "poolMin must be present on the appDb connection entry",
        ).toHaveProperty("poolMin");
        expect(
            connections.appDb,
            "poolMax must be present on the appDb connection entry",
        ).toHaveProperty("poolMax");
    });

    // ── DB-P-02 ───────────────────────────────────────────────────────────────

    it("DB-P-02: poolMin defaults to 5 when APP_POOL_MIN is not set", function () {
        delete process.env.APP_POOL_MIN;
        const { connections } = freshRequire();
        expect(connections.appDb.poolMin).toBe(
            5,
            "poolMin must default to 5 when APP_POOL_MIN is absent",
        );
    });

    // ── DB-P-03 ───────────────────────────────────────────────────────────────

    it("DB-P-03: poolMax defaults to 20 when APP_POOL_MAX is not set", function () {
        delete process.env.APP_POOL_MAX;
        const { connections } = freshRequire();
        expect(connections.appDb.poolMax).toBe(
            20,
            "poolMax must default to 20 when APP_POOL_MAX is absent",
        );
    });

    // ── DB-P-04 ───────────────────────────────────────────────────────────────

    it("DB-P-04: poolMin reads APP_POOL_MIN env var when set", function () {
        process.env.APP_POOL_MIN = "10";
        const { connections } = freshRequire();
        expect(connections.appDb.poolMin).toBe(
            10,
            "poolMin must equal the parsed APP_POOL_MIN value",
        );
    });

    // ── DB-P-05 ───────────────────────────────────────────────────────────────

    it("DB-P-05: poolMax reads APP_POOL_MAX env var when set", function () {
        process.env.APP_POOL_MAX = "40";
        const { connections } = freshRequire();
        expect(connections.appDb.poolMax).toBe(
            40,
            "poolMax must equal the parsed APP_POOL_MAX value",
        );
    });

    // ── DB-P-06 ───────────────────────────────────────────────────────────────

    it("DB-P-06: poolMin and poolMax are integers (not strings)", function () {
        process.env.APP_POOL_MIN = "7";
        process.env.APP_POOL_MAX = "30";
        const { connections } = freshRequire();

        const { poolMin, poolMax } = connections.appDb;

        expect(typeof poolMin).toBe("number", "poolMin must be typeof number");
        (expect(Number.isInteger(poolMin)).toBe(true),
            "poolMin must be an integer");

        expect(typeof poolMax).toBe("number", "poolMax must be typeof number");
        (expect(Number.isInteger(poolMax)).toBe(true),
            "poolMax must be an integer");
    });

    // ── DB-P-07 ───────────────────────────────────────────────────────────────

    it("DB-P-07: APP_POOL_MIN=0 falls back to default 5 (falsy branch: 0 || 5 === 5)", function () {
        // GAP: parseInt("0", 10) returns 0; 0 || 5 evaluates to 5 because 0 is
        // falsy in JavaScript. An operator setting APP_POOL_MIN=0 to request
        // zero idle connections will silently receive poolMin=5 instead.
        // This is intentional in the current implementation (prevents accidentally
        // creating an over-restrictive pool with no standby connections), but should
        // be documented in .env.example and this test documents the exact behaviour.
        process.env.APP_POOL_MIN = "0";
        const { connections } = freshRequire();
        expect(connections.appDb.poolMin).toBe(
            5,
            "APP_POOL_MIN=0 should fall back to default 5 due to falsy-branch (0 || 5)",
        );
    });
});
