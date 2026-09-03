"use strict";

/**
 * @fileoverview `makeSignedFields` — a factory that produces ONE canonical
 * field-projection function per signed row type, shared verbatim by the signer
 * and the verifier. (Plan §3.4; generalised from MEAL's `subsidySignedFields`.)
 *
 * ============================================================================
 * WHY THIS EXISTS — THE FOUR-COPY DRIFT LESSON
 * ============================================================================
 * An HMAC verifies ONLY when signer and verifier build byte-identical field
 * objects. In the reference system this projection had drifted into four
 * inlined copies. Two used `parseFloat`-with-NaN→0 and two used raw `Number()`.
 * They disagree on `undefined` (`Number(undefined)` is NaN, `parseFloat` path
 * gave 0) and on `"12abc"` (`Number` NaN, `parseFloat` 12). A legitimately
 * corrected row signed one way and verified the other could NEVER match — it
 * read TAMPERED forever, a false positive in the integrity report.
 *
 * The fix is structural: there is exactly ONE builder per row type, and both
 * paths import it. Never inline a copy of a signed projection.
 *
 * ============================================================================
 * MONEY CANONICALISATION — THE SECOND DOOR TO THE SAME FAILURE (§3.4)
 * ============================================================================
 * `CryptoVault.buildPayload` interpolates each field: `` `${k}=${fields[k]}` ``.
 * For a money value that is JavaScript interpolation, which drops trailing
 * zeros and formats floats however the runtime pleases:
 *
 *   1500        -> "1500"
 *   1500.00     -> "1500"        (Number drops trailing zeros)
 *   "1500.5000" -> "1500.5000"
 *   1500.5      -> "1500.5"
 *
 * Four spellings of two amounts → four payloads → four digests. A row signed at
 * write time from a string and verified at read time from a `NUMBER(19,4)`
 * fetched as a number can never match — the same TAMPERED false positive, via a
 * different door.
 *
 * So every field NAMED as a money field passes through `Money.from(...).toStorage()`
 * (fixed scale 4, explicit trailing zeros) before it enters the payload. Signer
 * and verifier share that one canonicaliser because they share this one builder.
 */

const { Money } = require("../money");

/**
 * Canonicalises a single money field to its exact scale-4 storage string, so a
 * value spelled `1500`, `1500.00`, `"1500.0000"` or fetched as an Oracle number
 * all collapse to `"1500.0000"` before hashing.
 *
 * `null`/`undefined`/`""` canonicalise to `"0.0000"` — a missing money field is
 * treated as zero, deterministically, rather than serialising as the literal
 * strings `"null"`/`"undefined"` (which is exactly the drift this module kills).
 *
 * @param {*} v
 * @returns {string}
 */
function canonicalMoney(v) {
    if (v === null || v === undefined || v === "") return Money.zero().toStorage();
    // Accept a string or Oracle-number-as-string; a bare JS number is coerced to
    // its string form first (the fetchTypeHandler in §3.0 rule 3b means money
    // columns already arrive as strings, so this path is the belt to that braces).
    const asStr = typeof v === "number" ? String(v) : v;
    return Money.from(asStr).toStorage();
}

/**
 * Canonicalises a non-money field to a stable string. Distinguishes `null`/
 * `undefined` from the empty string explicitly so the payload is reproducible.
 * @param {*} v
 * @returns {string}
 */
function canonicalPlain(v) {
    if (v === null || v === undefined) return "";
    return String(v);
}

/**
 * Builds a signed-field projector for one row type.
 *
 * @param {Object} spec
 * @param {string} spec.domain - The CryptoVault context/domain key passed to
 *   `signRecord`/`verifyRecord`. Keep it stable forever — changing it
 *   invalidates every existing hash.
 * @param {string[]} spec.fields - Non-money fields to sign, in any order (the
 *   payload is key-sorted by `buildPayload`, so order does not affect output).
 * @param {string[]} [spec.moneyFields=[]] - Fields canonicalised through
 *   `Money.toStorage()` before hashing.
 * @returns {{
 *   domain: string,
 *   project: (row: Object) => Object,
 *   sign: (row: Object) => Promise<string>,
 *   verify: (row: Object, signature: string) => Promise<boolean>,
 * }}
 */
function makeSignedFields({ domain, fields, moneyFields = [] }) {
    if (typeof domain !== "string" || domain.length === 0) {
        throw new Error("makeSignedFields: domain must be a non-empty string.");
    }
    if (!Array.isArray(fields)) {
        throw new Error("makeSignedFields: fields must be an array.");
    }
    if (!Array.isArray(moneyFields)) {
        throw new Error("makeSignedFields: moneyFields must be an array.");
    }

    const moneySet = new Set(moneyFields);
    const allFields = [...new Set([...fields, ...moneyFields])];

    /**
     * THE one projection. Both signer and verifier call this.
     * @param {Object} row
     * @returns {Object}
     */
    function project(row) {
        const out = {};
        for (const key of allFields) {
            const raw = row == null ? undefined : row[key];
            out[key] = moneySet.has(key) ? canonicalMoney(raw) : canonicalPlain(raw);
        }
        return out;
    }

    /**
     * Signs `row`. Lazy-requires CryptoVault to avoid a load-time cycle.
     * @param {Object} row @returns {Promise<string>}
     */
    async function sign(row) {
        const { CryptoVault } = require("../encryption/CryptoVault");
        return CryptoVault.signRecord(domain, project(row));
    }

    /**
     * Verifies `row` against `signature`. Uses the SAME projection as `sign`.
     * @param {Object} row @param {string} signature @returns {Promise<boolean>}
     */
    async function verify(row, signature) {
        const { CryptoVault } = require("../encryption/CryptoVault");
        return CryptoVault.verifyRecord(domain, project(row), signature);
    }

    return { domain, project, sign, verify };
}

module.exports = {
    makeSignedFields,
    canonicalMoney,
    canonicalPlain,
};
