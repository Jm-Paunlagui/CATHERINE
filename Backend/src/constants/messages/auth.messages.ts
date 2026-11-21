

/**
 * @fileoverview Authentication / authorization log messages.
 * Used ONLY in logger calls — never thrown or sent to clients.
 */

const authMessages = {
    AUTH_SUCCESS: (userId: any) => `USER ${userId} authenticated successfully.`,
    AUTH_LOGOUT: (userId: any) => `USER ${userId} logged out.`,
    TOKEN_REFRESHED: (userId: any) => `Token refreshed for user ${userId}.`,
    ACCOUNT_INACTIVE_BLOCKED: (userId: any) =>
        `Login blocked — account ${userId} is inactive.`,
    HASH_UPGRADED: (userId: any) =>
        `Password hash for ${userId} upgraded to current Argon2 parameters on login.`,
    PROFILE_FLAG_REFRESH_FAILED: (userId: any, errMessage: any) =>
        `Permission-flag refresh failed for /auth/me — user ${userId}, falling back to token payload: ${errMessage}`,
    SYS_SIGNATURE_TAMPERED_BLOCKED: (username: any) =>
        `SYSSIGNATURE mismatch for USERNAME: ${username} — record may have been tampered with. Login blocked.`,
    LOGIN_ATTEMPT_FAILED: (userId: any, failCount: any, currentMax: any) =>
        `Failed login attempt for USER ${userId} (${failCount}/${currentMax}).`,
    LOGIN_LOCKOUT_ENGAGED: (userId: any, durationMs: any, cycles: any) =>
        `USER ${userId} locked out for ${durationMs}ms (cycle ${cycles}).`,
    LOGIN_LOCKOUT_CLEARED: (userId: any) =>
        `Lockout cleared for user ${userId} after successful login.`,
    LOGIN_LOCKOUT_PERMANENT: (userId: any) =>
        `USER ${userId} permanently locked after exhausting all retry cycles. HR reset required.`,
    /**
     * Machine-readable authentication trace segment for the Request Log Trace.
     *
     * Mirrors the `[PARAMS @ …]` / `[BODY @ …]` convention in
     * TraceabilityMiddleware.createRequestMessage so the frontend can lift it out
     * of the timeline into its own "Authentication" panel with one regex.
     *
     * ⚠ NEVER add a token, a cookie VALUE, or a raw Authorization header to this
     * string. Log files are rendered in the Logs UI and shipped out via Export
     * Trace / the log ZIP — a JWT written here is a replayable credential handed
     * to anyone with read access to either (CWE-522 / CWE-532). Every field below
     * is derived metadata: presence, cookie NAMES, verification outcome, and
     * non-secret registered claims.
     *
     * @param {string} summary - Pre-assembled `key=value` pairs.
     * @returns {string}
     */
    AUTH_TRACE: (summary: string): string => `[AUTH @ ${summary}]`,

    PASSWORD_CHANGED: (userId: any) =>
        `USER ${userId} changed their password successfully.`,
    DEFAULT_PASSWORD_REJECTED: (userId: any) =>
        `USER ${userId} attempted to set the system default password as their new password — rejected.`,

    // ── Temporary passwords ──────────────────────────────────────────────────
    // Identifiers are labelled `USERNAME:` so logRedaction pseudonymises numeric usernames.
    /** @param {string|number} userId */
    TEMP_PASSWORD_LOGIN: (userId: string | number) =>
        `Temporary-password sign-in — USERNAME: ${userId}; session restricted to setting a new password.`,
    /** @param {string|number} userId @param {string} stage — 'login' | 'refresh' | 'change-password' */
    TEMP_PASSWORD_EXPIRED: (userId: string | number, stage: string) =>
        `Expired temporary password refused at ${stage} — USERNAME: ${userId}.`,
    /** @param {string|number} userId */
    TEMP_PASSWORD_REPLACED: (userId: string | number) =>
        `Temporary password replaced by the account holder — USERNAME: ${userId}.`,
    /** @param {string|number} userId @param {string} method @param {string} path */
    PASSWORD_CHANGE_GATE_BLOCKED: (userId: string | number, method: string, path: string) =>
        `Restricted session refused — USERNAME: ${userId} must set a new password before ${method} ${path}.`,

    // ── Refresh-token revocation ─────────────────────────────────────────────
    // NEVER log a token, a jti or a full family id - only the first 8 chars (CWE-532).
    /** @param {string|number} userId @param {string} fidPrefix8 */
    REFRESH_TOKEN_REUSE_DETECTED: (userId: string | number, fidPrefix8: string) =>
        `Refresh-token reuse detected - USERNAME: ${userId}, family ${fidPrefix8}; the whole session family was revoked.`,
    /** @param {string} title @param {string} detail */
    AUTH_DOWNLOAD_REJECTED: (title: string, detail: string) => `${title} - ${detail}`,
    /** @param {string|number} userId @param {string} outcome - revoked | reused | absent | unknown */
    REFRESH_TOKEN_REJECTED: (userId: string | number, outcome: string) =>
        `Refresh refused - USERNAME: ${userId}, outcome ${outcome}.`,
    /** @param {string} fidPrefix8 @param {string} reason */
    REFRESH_FAMILY_REVOKED: (fidPrefix8: string, reason: string) =>
        `Refresh-token family ${fidPrefix8} revoked (${reason}).`,
    /** @param {string|number} userId @param {string} reason */
    REFRESH_USER_SESSIONS_REVOKED: (userId: string | number, reason: string) =>
        `All refresh sessions revoked - USERNAME: ${userId} (${reason}).`,
    /** @param {string} what - family | user @param {string} err */
    REFRESH_REVOKE_PERSIST_FAILED: (what: string, err: string) =>
        `Could not persist refresh-token revocation (${what}): ${err}.`,
    /** @param {string} err */
    REFRESH_PURGE_FAILED: (err: string) =>
        `Expired refresh-token purge failed (best effort, ignored): ${err}.`,
    /** @param {string|number} userId @param {string} fidPrefix8 */
    ACCESS_SESSION_REVOKED_REFUSED: (userId: string | number, fidPrefix8: string) =>
        `Access token refused - USERNAME: ${userId}, session family ${fidPrefix8} was ended.`,
    /** @param {number} count */
    ACCESS_REVOCATIONS_LOADED: (count: number) =>
        `Revoked access sessions loaded at boot: ${count}.`,
    /** @param {string} err */
    ACCESS_REVOCATIONS_LOAD_FAILED: (err: string) =>
        `Could not load revoked access sessions at boot - sessions ended before this start may keep working until their access token expires: ${err}.`,
    /** @param {number} max */
    ACCESS_REVOCATIONS_FULL: (max: number) =>
        `Revoked access-session set is full (${max}); the soonest-expiring entry was dropped.`,
    /** @param {number} count */
    ACCESS_REVOCATION_BROADCAST_FAILED: (count: number) =>
        `Could not tell the other server workers about ${count} ended session(s); they keep accepting those access tokens until they expire.`,
    /** @param {string} raw */
    ACCESS_TTL_UNPARSEABLE: (raw: string) =>
        `JWT_EXPIRES_IN "${raw}" is not in the s/m/h/d form; revoked sessions are kept for the refresh lifetime instead.`,
    /** @param {string|number} userId */
    LOGIN_FAILURE_IGNORED_LOCKED: (userId: string | number) =>
        `Failed login for USER ${userId} not counted - account is already locked.`,
};

export { authMessages };
