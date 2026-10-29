"use strict";

/**
 * @fileoverview Canonical key for a login identifier.
 *
 * When the login identifier is a NUMBER column and the credential lookup binds
 * the raw string, Oracle's implicit conversion makes "30901", "030901",
 * " 30901" and "3.0901e4" the SAME account. Anything keyed on the raw string
 * (login lockout counters, refresh-token user index) would give every spelling
 * its own budget (CWE-307). Numerals collapse to their numeric value; anything
 * else is trimmed.
 *
 * Moved from LoginLockoutMiddleware (`lockoutKey`, which now re-exports this).
 * Pure function: no state, no side effects. O(len).
 *
 * @author senior-nodejs-engineer
 */

// A plain decimal numeral, optionally signed, with optional fraction/exponent.
const DECIMAL_NUMERAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

/**
 * Canonical store key for a login identifier.
 *
 * @param {unknown} userId
 * @returns {string}
 */
function canonicalUserKey(userId) {
    const raw = String(userId ?? "").trim();
    if (DECIMAL_NUMERAL.test(raw)) {
        const n = Number(raw);
        if (Number.isFinite(n)) return String(n);
    }
    return raw;
}

module.exports = { canonicalUserKey, DECIMAL_NUMERAL };
