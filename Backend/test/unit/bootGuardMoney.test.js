"use strict";

/**
 * bootGuardMoney.test.js — the base-currency invariant at boot (plan §5.2, §3.7.10).
 *
 * validateMoneyConfig(violations, isProduction) is a pure env-reader that pushes
 * human-readable strings onto `violations`. It never exits. The rules under test:
 *
 *   1. Unset MONEY_BASE_CURRENCY → no-op (the bare template ships no money domain).
 *   2. An unregistered base code → a violation.
 *   3. The base-CHANGE guard is ARMED only once MONEY_LEDGER_TABLES is non-empty
 *      (a copier has declared real ledgers). When armed and a PREVIOUS base is
 *      recorded, an in-place change is REFUSED — a functional-currency change is a
 *      new prospective epoch (IAS 21), not an edit that restates history — UNLESS
 *      MONEY_BASE_CURRENCY_MIGRATION=true is set deliberately.
 *
 * Pure — no DB, no HTTP.
 */

const { validateMoneyConfig } = require("../../src/config/bootGuard");

// Snapshot every money env var we touch, restore after each test.
const KEYS = [
    "MONEY_BASE_CURRENCY",
    "MONEY_LEDGER_TABLES",
    "MONEY_BASE_CURRENCY_PREVIOUS",
    "MONEY_BASE_CURRENCY_MIGRATION",
];
let snapshot;

beforeEach(function () {
    snapshot = {};
    for (const k of KEYS) {
        snapshot[k] = process.env[k];
        delete process.env[k];
    }
});
afterEach(function () {
    for (const k of KEYS) {
        if (snapshot[k] === undefined) delete process.env[k];
        else process.env[k] = snapshot[k];
    }
});

function run(isProduction = false) {
    const violations = [];
    validateMoneyConfig(violations, isProduction);
    return violations;
}

describe("validateMoneyConfig — base currency validity", function () {
    it("is a no-op when MONEY_BASE_CURRENCY is unset (bare template)", function () {
        expect(run()).toEqual([]);
    });

    it("accepts a registered ISO 4217 base code", function () {
        process.env.MONEY_BASE_CURRENCY = "PHP";
        expect(run()).toEqual([]);
    });

    it("rejects an unregistered base code", function () {
        process.env.MONEY_BASE_CURRENCY = "ZZZ";
        const v = run();
        expect(v.length).toBe(1);
        expect(v[0]).toMatch(/not a registered ISO 4217 code/i);
    });
});

describe("validateMoneyConfig — base-change guard (§3.7.10)", function () {
    it("is DISARMED when no ledger tables are declared (no refusal even on a change)", function () {
        process.env.MONEY_BASE_CURRENCY = "USD";
        process.env.MONEY_BASE_CURRENCY_PREVIOUS = "PHP";
        // No MONEY_LEDGER_TABLES → guard not armed.
        expect(run()).toEqual([]);
    });

    it("REFUSES an in-place base change once ledger tables exist and a previous base is recorded", function () {
        process.env.MONEY_BASE_CURRENCY = "USD";
        process.env.MONEY_BASE_CURRENCY_PREVIOUS = "PHP";
        process.env.MONEY_LEDGER_TABLES = "T_LEDGER_DEV";
        const v = run(true);
        expect(v.length).toBe(1);
        expect(v[0]).toMatch(/changed in place/i);
        expect(v[0]).toMatch(/IAS 21|prospective/i);
    });

    it("ACCEPTS the change behind the explicit migration flag", function () {
        process.env.MONEY_BASE_CURRENCY = "USD";
        process.env.MONEY_BASE_CURRENCY_PREVIOUS = "PHP";
        process.env.MONEY_LEDGER_TABLES = "T_LEDGER_DEV";
        process.env.MONEY_BASE_CURRENCY_MIGRATION = "true";
        expect(run(true)).toEqual([]);
    });

    it("does NOT refuse when the base is unchanged (previous === current)", function () {
        process.env.MONEY_BASE_CURRENCY = "PHP";
        process.env.MONEY_BASE_CURRENCY_PREVIOUS = "PHP";
        process.env.MONEY_LEDGER_TABLES = "T_LEDGER_DEV";
        expect(run(true)).toEqual([]);
    });

    it("does NOT refuse when there is no previous base recorded (first-time set)", function () {
        process.env.MONEY_BASE_CURRENCY = "USD";
        process.env.MONEY_LEDGER_TABLES = "T_LEDGER_DEV";
        // No MONEY_BASE_CURRENCY_PREVIOUS.
        expect(run(true)).toEqual([]);
    });

    it("is fatal in every environment when armed (not gated on production)", function () {
        process.env.MONEY_BASE_CURRENCY = "USD";
        process.env.MONEY_BASE_CURRENCY_PREVIOUS = "PHP";
        process.env.MONEY_LEDGER_TABLES = "T_LEDGER_DEV";
        // isProduction=false still yields the violation.
        expect(run(false).length).toBe(1);
    });
});
