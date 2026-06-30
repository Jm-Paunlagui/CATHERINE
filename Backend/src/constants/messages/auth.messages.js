"use strict";

/**
 * @fileoverview Authentication / authorization log messages.
 * Used ONLY in logger calls — never thrown or sent to clients.
 */

const authMessages = {
    JWT_VERIFY_FAILED: (err) => `JWT verification failed: ${err}`,
    JWT_EXPIRED: "JWT token has expired.",
    JWT_MALFORMED: "JWT token is malformed.",
    PERMISSION_DENIED: (userId, resource) =>
        `Permission denied for user ${userId} on resource ${resource}.`,
    AUTH_SUCCESS: (userId) => `USER ${userId} authenticated successfully.`,
    AUTH_LOGOUT: (userId) => `USER ${userId} logged out.`,
    TOKEN_REFRESHED: (userId) => `Token refreshed for user ${userId}.`,
    ACCOUNT_INACTIVE_BLOCKED: (userId) =>
        `Login blocked — account ${userId} is inactive.`,
    HASH_UPGRADED: (userId) =>
        `Password hash for ${userId} upgraded to current Argon2 parameters on login.`,
    PROFILE_FLAG_REFRESH_FAILED: (userId, errMessage) =>
        `Permission-flag refresh failed for /auth/me — user ${userId}, falling back to token payload: ${errMessage}`,
    SYS_SIGNATURE_TAMPERED_BLOCKED: (empId) =>
        `SYSSIGNATURE mismatch for EMP_ID ${empId} — record may have been tampered with. Login blocked.`,
    SYS_SIGNATURE_TAMPERED_ROLE_FALLBACK: (empId) =>
        `SYSSIGNATURE mismatch for EMP_ID ${empId} — record may have been tampered with. Defaulting to USER role.`,
    AUTH_FALLBACK_ADMIN: (userId) =>
        `USER ${userId} not found in primary auth table — falling back to admin table authentication.`,
    AUTH_UA_PRIMARY: (userId) =>
        `Authenticating user ${userId} via userAccount (U_USERS).`,
    AUTH_ADMIN_PASSWORD: (userId) =>
        `USER ${userId} authenticated via admin password (T_ADMINS_DEV) — primary password did not match.`,
    LOGIN_ATTEMPT_FAILED: (userId, failCount, currentMax) =>
        `Failed login attempt for ${userId} (${failCount}/${currentMax}).`,
    LOGIN_LOCKOUT_ENGAGED: (userId, durationMs, cycles) =>
        `USER ${userId} locked out for ${durationMs}ms (cycle ${cycles}).`,
    LOGIN_LOCKOUT_CLEARED: (userId) =>
        `Lockout cleared for user ${userId} after successful login.`,
    LOGIN_LOCKOUT_PERMANENT: (userId) =>
        `USER ${userId} permanently locked after exhausting all retry cycles. HR reset required.`,
    PASSWORD_CHANGED: (userId) =>
        `USER ${userId} changed their password successfully.`,
    DEFAULT_PASSWORD_REJECTED: (userId) =>
        `USER ${userId} attempted to set the system default password as their new password — rejected.`,
};

module.exports = { authMessages };
