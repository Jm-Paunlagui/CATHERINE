"use strict";

/**
 * @fileoverview Temporary admin passwords — generation and the stored-hash marker.
 *
 * A temporary password (issued on Access Control "Add" and "Reset Password")
 * is stored in T_ADMINS_DEV.PASSWORD as its normal strong hash behind a short
 * prefix that carries its expiry:
 *
 *     $t$<expiry: epoch SECONDS, base36><argon2id | bcrypt hash>
 *     $t$tmfwxs$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>
 *
 * Why a prefix and not a new column:
 *   - PASSWORD is inside SYSSIGNATURE, so the expiry is tamper-evident for free —
 *     editing it in the database breaks the row signature and login refuses
 *     the row as TAMPERED.
 *   - No schema change: no migration, no purge-registry change, and
 *     backup/restore carry the value byte-for-byte.
 *
 * THIS MODULE IS THE ONLY CODE THAT KNOWS THE FORMAT. CryptoVault's admin
 * verifier unwraps through `parseStoredAdminPassword`; nothing else should
 * inspect the stored hash's prefix.
 *
 * Pure functions — no I/O, no state. The clock is a parameter so tests (and the
 * boundary cases) never depend on wall time.
 */

const crypto = require("crypto");

/** A temporary password lives 72 hours. */
const TEMP_PASSWORD_TTL_MS = 72 * 60 * 60 * 1000;

/**
 * Byte cap for a wrapped value. Deliberately conservative: T_ADMINS_DEV.PASSWORD
 * is VARCHAR2(255), and 128 also fits a copier schema with a narrower column.
 */
const STORED_PASSWORD_MAX_BYTES = 128;

const MARKER_PREFIX = "$t$";

/**
 * `$t$`, a base36 expiry, then an inner hash that must itself be a strong
 * admin hash — argon2 or bcrypt. A marker around anything else (legacy
 * TripleDES, plain text, empty) is malformed and never verifies.
 */
const MARKER_RE = /^\$t\$([0-9a-z]{1,11})(\$(?:argon2(?:id|i|d)\$|2[aby]\$).+)$/;

/**
 * 56 characters: A–Z and a–z without I, O, l, o, and 2–9. No character a
 * reader can confuse with another when copying it out of an email.
 */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
const GROUPS = 4;
const GROUP_LEN = 4;

/**
 * Generates a temporary password: four groups of four from {@link ALPHABET},
 * joined by hyphens (`Xk7m-Pq4v-Rt9w-Hc3z`) — 16 random characters, ≈93 bits.
 * Guarantees at least one upper, one lower and one digit by rejection sampling,
 * so the value satisfies any character-class policy a reader might assume.
 *
 * Randomness is `crypto.randomInt` (CSPRNG) — never Math.random (CWE-338).
 *
 * @param {(max: number) => number} [randomInt=crypto.randomInt] - injectable for tests
 * @returns {string}
 */
function generateTemporaryPassword(randomInt = crypto.randomInt) {
    for (;;) {
        const chars = [];
        for (let i = 0; i < GROUPS * GROUP_LEN; i++) {
            chars.push(ALPHABET[randomInt(ALPHABET.length)]);
        }
        const body = chars.join("");
        if (/[A-Z]/.test(body) && /[a-z]/.test(body) && /[0-9]/.test(body)) {
            const groups = [];
            for (let g = 0; g < GROUPS; g++) {
                groups.push(body.slice(g * GROUP_LEN, (g + 1) * GROUP_LEN));
            }
            return groups.join("-");
        }
    }
}

/**
 * Wraps a strong admin hash as a temporary one expiring at `expiresAtMs`.
 * Expiry is stored at whole-second resolution, rounded DOWN, so the stored
 * value never outlives what the caller asked for.
 *
 * @param {string} hash        - output of CryptoVault.hashAdminPassword
 * @param {number} expiresAtMs - epoch milliseconds
 * @returns {string} value for the PASSWORD column
 * @throws {TypeError}  hash is not an argon2/bcrypt hash, or expiry is not a positive finite number
 * @throws {RangeError} the wrapped value would exceed STORED_PASSWORD_MAX_BYTES — raised BEFORE any
 *   write, so an oversized ARGON2_HASH_LENGTH surfaces as a configuration error
 *   rather than ORA-12899 halfway through an admin creation
 */
function wrapTemporaryHash(hash, expiresAtMs) {
    if (typeof hash !== "string" || !/^\$(?:argon2(?:id|i|d)\$|2[aby]\$)/.test(hash)) {
        throw new TypeError("[adminTempPassword] Only an argon2 or bcrypt hash can be wrapped.");
    }
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= 0) {
        throw new TypeError("[adminTempPassword] expiresAtMs must be a positive finite number.");
    }
    const wrapped = `${MARKER_PREFIX}${Math.floor(expiresAtMs / 1000).toString(36)}${hash}`;
    const bytes = Buffer.byteLength(wrapped, "utf8");
    if (bytes > STORED_PASSWORD_MAX_BYTES) {
        throw new RangeError(
            `[adminTempPassword] Wrapped hash is ${bytes} bytes; the cap is ${STORED_PASSWORD_MAX_BYTES}. ` +
                "Lower ARGON2_HASH_LENGTH (at most 48 fits).",
        );
    }
    return wrapped;
}

/**
 * Splits a stored admin password value into its hash and temporary-password metadata.
 *
 * @param {string} stored
 * @returns {{
 *   hash: string|null,
 *   temporary: boolean,
 *   expiresAt: number|null,
 *   malformed: boolean,
 * }} `hash` is what the hash library verifies against. A value that starts
 *   with the marker prefix but does not parse is `malformed` with `hash: null`
 *   — callers must treat it as unverifiable (fail closed), never fall back to
 *   verifying the raw string.
 */
function parseStoredAdminPassword(stored) {
    if (typeof stored !== "string" || !stored.startsWith(MARKER_PREFIX)) {
        return { hash: typeof stored === "string" ? stored : null, temporary: false, expiresAt: null, malformed: false };
    }
    const m = MARKER_RE.exec(stored);
    if (!m) return { hash: null, temporary: true, expiresAt: null, malformed: true };
    const seconds = parseInt(m[1], 36);
    if (!Number.isSafeInteger(seconds) || seconds <= 0) {
        return { hash: null, temporary: true, expiresAt: null, malformed: true };
    }
    return { hash: m[2], temporary: true, expiresAt: seconds * 1000, malformed: false };
}

/**
 * True once `now` has reached the expiry. The boundary instant itself counts as
 * expired — "valid for 72 hours" means strictly less than 72 hours.
 *
 * @param {{ temporary: boolean, expiresAt: number|null }} parsed
 * @param {number} [now=Date.now()]
 * @returns {boolean}
 */
function isTemporaryExpired(parsed, now = Date.now()) {
    if (!parsed?.temporary) return false;
    if (parsed.expiresAt == null) return true;
    return now >= parsed.expiresAt;
}

/**
 * Expiry of a stored admin password value as an ISO string, or null when it is not a
 * (well-formed) temporary password. For display only — never a security check.
 *
 * @param {string} stored
 * @returns {string|null}
 */
function temporaryExpiryIso(stored) {
    const parsed = parseStoredAdminPassword(stored);
    return parsed.temporary && parsed.expiresAt != null ? new Date(parsed.expiresAt).toISOString() : null;
}

module.exports = {
    TEMP_PASSWORD_TTL_MS,
    STORED_PASSWORD_MAX_BYTES,
    ALPHABET,
    generateTemporaryPassword,
    wrapTemporaryHash,
    parseStoredAdminPassword,
    isTemporaryExpired,
    temporaryExpiryIso,
};
