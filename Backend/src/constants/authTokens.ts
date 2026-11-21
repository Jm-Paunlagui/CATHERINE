"use strict";

/**
 * @fileoverview Token-type, issuer, audience and refresh-session constants.
 * No imports: safe to require from
 * pure utils, middleware, services and tests alike.
 *
 * - Access and refresh tokens share JWT_SECRET/HS256, so they are told apart by
 *   `type` + `aud` + `iss` (CWE-287 token confusion).
 * - REFRESH_REVOKE_REASONS must match the CHK_TARTD_REVOKE_PAIR list in
 *   sql/01_schema.sql (section 6) and sql/04_platform_tables.sql.
 *
 * @author senior-nodejs-engineer
 */

/** Auth cookie names (single source of truth; AuthService re-exports it). */
const COOKIE_NAMES = Object.freeze({
    ACCESS: "app.access-token",
    REFRESH: "app.refresh-token",
});

/** Value of the `type` claim. */
const TOKEN_TYPES = Object.freeze({
    ACCESS: "access",
    REFRESH: "refresh",
});

/** Value of the `iss` claim on every token this server signs. */
const TOKEN_ISSUER = "app-api";

/** Value of the `aud` claim (a string; arrays are rejected). */
const TOKEN_AUDIENCES = Object.freeze({
    ACCESS: "app-api:access",
    REFRESH: "app-api:refresh",
});

/** T_AUTH_REFRESH_TOKEN_DEV.REVOKE_REASON values (VARCHAR2(16)). */
const REFRESH_REVOKE_REASONS = Object.freeze({
    LOGOUT: "LOGOUT",
    PASSWORD_CHANGE: "PASSWORD_CHANGE",
    PASSWORD_RESET: "PASSWORD_RESET",
    ADMIN_READD: "ADMIN_READD",
    REUSE: "REUSE",
});

/**
 * Why an administrator's sessions were ended by Access Control.
 * Logged only: the CHK_TARTD_REVOKE_PAIR list is fixed (deliberately no
 * schema change), so these sessions are stored with REVOKE_REASON 'LOGOUT' - a
 * forced sign-out - and the cause below goes into the log line.
 */
const SESSION_END_CAUSES = Object.freeze({
    ACCESS_REVOKED: "ACCESS_REVOKED",
    ADMIN_DELETED: "ADMIN_DELETED",
    DEACTIVATED: "DEACTIVATED",
    ROLE_CHANGED: "ROLE_CHANGED",
});

/** Bound on the per-process revocation registry (CWE-400). */
const REFRESH_REGISTRY_LIMITS = Object.freeze({
    MAX_ENTRIES: 100_000,
});

/**
 * Access-token lifetime when JWT_EXPIRES_IN is unset. Matches the access
 * cookie's maxAge, so token and cookie expire together (a longer
 * token default than the cookie would outlive it).
 */
const ACCESS_TOKEN_DEFAULT_EXPIRES_IN = "30m";

/**
 * Revoked access sessions: every authenticated request checks the
 * token's `fid` against an in-memory set (no DB call). An entry lives for the
 * access-token lifetime plus CLOCK_SKEW_MS; after that every access token of
 * the family has expired on its own.
 * - MAX_ENTRIES bounds the set (CWE-400); at the cap the soonest-expiring entry
 *   is dropped and logged.
 * - FALLBACK_TTL_MS is used when JWT_EXPIRES_IN cannot be parsed: the refresh
 *   lifetime, the longest an access token of the family could still be minted.
 * - MAX_TTL_MS caps the retention (and what IPC accepts): a year, so any sane
 *   JWT_EXPIRES_IN fits; a longer one is clamped (and logged at boot reload).
 * - BOOT_LOAD_LIMIT bounds the rows read back at boot.
 */
const ACCESS_REVOCATION_LIMITS = Object.freeze({
    MAX_ENTRIES: 200_000,
    CLOCK_SKEW_MS: 60_000,
    FALLBACK_TTL_MS: 7 * 86_400_000,
    MAX_TTL_MS: 366 * 86_400_000,
    BOOT_LOAD_LIMIT: 200_000,
    /** Families carried by one IPC notify / broadcast. */
    MAX_FIDS_PER_MESSAGE: 1000,
    /** Entries carried by one sync message to a worker that just started listening. */
    MAX_SYNC_ENTRIES: 50_000,
});

/** Session family id (`fid`) format: crypto.randomUUID(). */
const FAMILY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Expired-row purge after a successful login. */
const REFRESH_PURGE = Object.freeze({
    GRACE_MS: 86_400_000,
    BATCH_LIMIT: 500,
});

module.exports = {
    COOKIE_NAMES,
    TOKEN_TYPES,
    TOKEN_ISSUER,
    TOKEN_AUDIENCES,
    REFRESH_REVOKE_REASONS,
    SESSION_END_CAUSES,
    REFRESH_REGISTRY_LIMITS,
    REFRESH_PURGE,
    ACCESS_TOKEN_DEFAULT_EXPIRES_IN,
    ACCESS_REVOCATION_LIMITS,
    FAMILY_ID_RE,
};
