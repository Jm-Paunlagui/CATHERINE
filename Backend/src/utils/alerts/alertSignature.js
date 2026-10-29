"use strict";

/**
 * @fileoverview Keyed fingerprint of an alert finding.
 *
 * A periodic alert sweep must remember "the finding I last emailed" across
 * restarts without storing the affected record ids anywhere in the DB or in
 * mail (F2). A plain SHA-256 of a one-id set is reversible with a dictionary
 * over a small id space (CWE-327, CWE-359); an HMAC under a key derived from
 * DATA_SIGNING_SECRET is not.
 *
 * Pure function module (stateless transform); the only state is the lazily
 * memoised HKDF key, the same precedent as `logRedaction.getKey`.
 *
 * Complexity: O(n log n) in the member count (one sort).
 */

const crypto = require("crypto");

/** HKDF info string - distinct from every other derived key in the app. */
const KEY_INFO = "app-alert-signature-v1";

/** @type {Buffer|null} */
let _cachedKey = null;

/** @returns {Buffer} 32-byte HMAC key derived from DATA_SIGNING_SECRET. */
function getKey() {
    if (_cachedKey) return _cachedKey;
    const secret = process.env.DATA_SIGNING_SECRET || "unkeyed-dev";
    _cachedKey = Buffer.from(crypto.hkdfSync("sha256", secret, "", KEY_INFO, 32));
    return _cachedKey;
}

/**
 * HMAC-SHA256 over "<kind>|<sorted members comma-joined>".
 *
 * Members are sorted on a copy (the input is never mutated): numerically when
 * every member is numeric, otherwise as strings. Including `kind` means a
 * switch between two FAIL kinds over the same set still re-alerts.
 *
 * @param {string} kind - Finding kind, e.g. "UPLOAD_MISSING" | "CLOSED_NO_UPLOAD".
 * @param {Array<number|string>} members - Identifiers in the finding (e.g. GIDs).
 * @returns {string} 64 lowercase hex characters.
 */
function computeAlertSignature(kind, members) {
    const copy = Array.from(members ?? []);
    const numeric = copy.every((m) => m !== "" && Number.isFinite(Number(m)));
    copy.sort(numeric ? (a, b) => Number(a) - Number(b) : (a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0));
    return crypto
        .createHmac("sha256", getKey())
        .update(`${kind}|${copy.join(",")}`)
        .digest("hex");
}

module.exports = { computeAlertSignature };
