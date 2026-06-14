"use strict";

/**
 * @fileoverview Wallet reset-type taxonomy — single source of truth.
 * @description
 * Canonical `RESET_TYPE` values written to `TAP_WALLET_RESET_LOG`. These
 * replace the legacy scattered magic strings (`INIT`, `AUTO_EMEAL`,
 * `MID_PERIOD`). Writes use the canonical set below; reads normalise legacy
 * values for display via {@link normalizeResetType}.
 *
 * | Event                              | Legacy        | Canonical       |
 * | ---------------------------------- | ------------- | --------------- |
 * | New-hire wallet seed (RFID add)    | `INIT`        | `ONBOARD`       |
 * | Scheduled load, 17th (period start)| `AUTO_EMEAL`  | `FIRST_HALF`    |
 * | Scheduled load, 2nd (mid-period)   | *(none)*      | `SECOND_HALF`   |
 * | Admin-approved reset request       | `MID_PERIOD`  | `RESET_REQUEST` |
 *
 * History is **forward-only**: pre-migration rows keep their legacy value
 * (their signed `ROW_HASH` covers `RESET_TYPE`, so rewriting them would flag
 * the immutable audit log as tampered). The DB CHECK accepts both sets.
 */

/** Canonical reset-type values used for all new writes. */
const RESET_TYPES = Object.freeze({
    ONBOARD: "ONBOARD", // new-hire wallet seed (RFID management)
    FIRST_HALF: "FIRST_HALF", // scheduled load on the 17th (period start)
    SECOND_HALF: "SECOND_HALF", // scheduled load on the 2nd (mid-period)
    RESET_REQUEST: "RESET_REQUEST", // admin-approved mid-period reset request
});

/** Legacy → canonical mapping for display/reporting of pre-migration rows. */
const LEGACY_RESET_TYPE_MAP = Object.freeze({
    INIT: RESET_TYPES.ONBOARD,
    AUTO_EMEAL: RESET_TYPES.FIRST_HALF,
    MID_PERIOD: RESET_TYPES.RESET_REQUEST,
});

/**
 * Normalises a stored RESET_TYPE to its canonical form. Canonical values and
 * unknown values pass through unchanged.
 *
 * @param {string} value - Raw RESET_TYPE as stored in TAP_WALLET_RESET_LOG.
 * @returns {string} Canonical RESET_TYPE.
 */
function normalizeResetType(value) {
    return LEGACY_RESET_TYPE_MAP[value] ?? value;
}

module.exports = { RESET_TYPES, LEGACY_RESET_TYPE_MAP, normalizeResetType };
