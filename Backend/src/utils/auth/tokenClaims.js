"use strict";

/**
 * @fileoverview Pure helpers over JWT claims.
 *
 * `classifyAccessClaims` decides whether a signature-verified payload may be
 * used as an ACCESS credential. Access and refresh tokens share JWT_SECRET and
 * HS256, so `type` / `aud` / `iss` are the only thing that tells them apart
 * (CWE-287 / token-type confusion). `hashJti` is the only form of a refresh
 * token id that is ever stored or compared server-side (CWE-312).
 *
 * Imports: node:crypto and constants/authTokens only. O(1).
 *
 * @author senior-nodejs-engineer
 */

const crypto = require("crypto");
const {
    TOKEN_TYPES,
    TOKEN_ISSUER,
    TOKEN_AUDIENCES,
    ACCESS_TOKEN_DEFAULT_EXPIRES_IN,
} = require("../../constants/authTokens");

const DURATION_MS = Object.freeze({ s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 });

/**
 * Classifies a verified JWT payload for use as an access token.
 *
 * - `access`     : type === "access", aud === "app-api:access" (a STRING;
 *                  an array is rejected), iss === "app-api".
 * - `legacy`     : type, aud and iss are ALL undefined - a token minted by a
 *                  build that predates typed claims (the caller answers 440 so
 *                  the UI re-logs in).
 * - `wrong-type` : anything else (refresh token, other audience, partial claims).
 *
 * @param {object|null|undefined} payload - Output of jwt.verify.
 * @returns {"access"|"legacy"|"wrong-type"}
 */
function classifyAccessClaims(payload) {
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
        return "wrong-type";
    }
    const { type, aud, iss } = payload;
    if (type === undefined && aud === undefined && iss === undefined) return "legacy";
    if (
        type === TOKEN_TYPES.ACCESS &&
        typeof aud === "string" &&
        aud === TOKEN_AUDIENCES.ACCESS &&
        iss === TOKEN_ISSUER
    ) {
        return "access";
    }
    return "wrong-type";
}

/**
 * SHA-256 hex digest (64 chars) of a token id.
 *
 * @param {string} jti
 * @returns {string}
 */
function hashJti(jti) {
    return crypto.createHash("sha256").update(String(jti), "utf8").digest("hex");
}

/** HKDF `info` label: the single purpose of the derived credential-epoch key. */
const CREDENTIAL_EPOCH_KDF_LABEL = "app-api:auth:credential-epoch:v1";

/**
 * Credential epoch (`pwv` claim): first 16 hex chars of HMAC-SHA256 over the
 * stored admin password hash. The key is HKDF-derived from JWT_SECRET under a
 * purpose label, so the raw secret is never reused for a second purpose and no
 * new env var is needed. A refresh token minted before a password change
 * carries the old epoch and is refused after it (CWE-367 / CWE-613). The value
 * is a one-way truncated MAC of a hash: never log it.
 *
 * @param {string} storedHash - T_ADMINS_DEV.PASSWORD as stored
 * @returns {string|null} 16 hex chars, or null when no hash / no secret
 */
function credentialEpoch(storedHash) {
    const secret = process.env.JWT_SECRET;
    if (typeof storedHash !== "string" || storedHash === "" || !secret) return null;
    const key = Buffer.from(
        crypto.hkdfSync("sha256", secret, Buffer.alloc(0), CREDENTIAL_EPOCH_KDF_LABEL, 32),
    );
    return crypto.createHmac("sha256", key).update(storedHash, "utf8").digest("hex").slice(0, 16);
}

/**
 * Converts a JWT-style duration ("30m", "8h", "7d", "60s") to milliseconds.
 *
 * @param {string} str
 * @returns {number}
 * @throws {Error} when the format is not <digits><s|m|h|d>
 */
function parseDuration(str) {
    const match = /^(\d+)([smhd])$/.exec(String(str).trim());
    if (!match) {
        throw new Error(`Unrecognised duration format: "${str}". Expected e.g. "30m", "8h", "7d".`);
    }
    return parseInt(match[1], 10) * DURATION_MS[match[2]];
}

/**
 * Access-token lifetime as signed by AuthService._issueTokens.
 *
 * @param {string|undefined} [raw=process.env.JWT_EXPIRES_IN]
 * @returns {{ttlMs: number|null, raw: string}} `ttlMs` is null when `raw` is
 *   set but not in the s/m/h/d form (jsonwebtoken may still accept it)
 */
function accessTokenTtl(raw = process.env.JWT_EXPIRES_IN) {
    const value = raw || ACCESS_TOKEN_DEFAULT_EXPIRES_IN;
    try {
        return { ttlMs: parseDuration(value), raw: value };
    } catch {
        return { ttlMs: null, raw: value };
    }
}

module.exports = { classifyAccessClaims, hashJti, credentialEpoch, parseDuration, accessTokenTtl };
