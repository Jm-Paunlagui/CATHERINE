"use strict";

/**
 * @fileoverview App-wide error messages, codes, types, and AppError class.
 */

// ─── AppError ─────────────────────────────────────────────────────────────────

/**
 * Operational error — throw from services/controllers.
 * The global errorHandler middleware formats these for the client.
 */
class AppError extends Error {
    /**
     * @param {string} message  - Human-readable message
     * @param {number} statusCode - HTTP status code (default 500)
     * @param {object} [opts]
     * @param {string} [opts.type]    - Error type label (e.g. 'ValidationError')
     * @param {Array}  [opts.details] - Field-level error details
     * @param {string} [opts.hint]    - Helpful hint for the consumer
     * @param {number} [opts.retryAfterSec] - Seconds to wait before retrying (Retry-After header).
     * @param {string[]} [opts.reasons] - Machine reason codes; surfaced as
     *   `error.reasons` on the response
     */
    constructor(message, statusCode = 500, opts = {}) {
        super(message);
        this.name = opts.type || "AppError";
        this.statusCode = statusCode;
        this.isOperational = true;
        this.details = opts.details || undefined;
        this.hint = opts.hint || undefined;
        // Only well-formed machine codes survive (UPPER_SNAKE, <= 40 chars,
        // at most 10) so an untyped value can never reach the response body.
        this.reasons = Array.isArray(opts.reasons)
            ? opts.reasons
                  .filter((r) => typeof r === "string" && /^[A-Z][A-Z0-9_]{0,39}$/.test(r))
                  .slice(0, 10)
            : undefined;
        // Seconds a client should wait before retrying (shutdown gate);
        // ErrorHandlerMiddleware turns it into a Retry-After header. Integers 1..3600 only.
        this.retryAfterSec =
            Number.isInteger(opts.retryAfterSec) && opts.retryAfterSec >= 1 && opts.retryAfterSec <= 3600
                ? opts.retryAfterSec
                : undefined;
        Error.captureStackTrace(this, this.constructor);
    }
}

// ─── Auth error messages ──────────────────────────────────────────────────────

const AUTH_ERRORS = {
    USER_NOT_FOUND: "Please sign in to continue.",
    /**
     * 401 on an SSE route's pre-upgrade check. Kept distinct from
     * USER_NOT_FOUND, whose wording ("Please sign in to continue") is aimed at
     * a person looking at a page; an SSE refusal is read by a client's stream
     * handler, and the existing text is what those clients already log.
     */
    AUTHENTICATION_REQUIRED: "Authentication required.",
    FORBIDDEN_ACCESS:
        "You don't have access to this page or action. If you believe you should, please reach out to your administrator.",
    TOKEN_EXPIRED:
        "Your session has expired. Please sign in again to pick up where you left off.",
    TOKEN_INVALID: "Your session is no longer valid. Please sign in again.",
    /** 401 - a token of the wrong kind (e.g. a refresh token) was presented as an access token. */
    TOKEN_TYPE_INVALID: "This token cannot be used to access this resource.",
    /** 401 - the refresh token was revoked (logout / password change / reset) or is unknown. */
    REFRESH_TOKEN_REVOKED: "Your session has ended. Please sign in again.",
    /** 401 - the refresh request carried no usable signed refresh cookie (absent / unsigned / tampered). */
    REFRESH_TOKEN_MISSING: "Your session has ended. Please sign in again.",
    /** 440 - the access token belongs to a session that was ended (sign-out, password change/reset, reuse). */
    ACCESS_SESSION_REVOKED: "Your session has ended. Please sign in again.",
    /** 401 - an already-rotated refresh token was replayed; the whole session family is ended. */
    REFRESH_TOKEN_REUSED:
        "This session was ended for your security. Please sign in again.",
    MISSING_CREDENTIALS: "Please enter both your username and password.",
    INVALID_CREDENTIALS:
        "That username and password don't match our records. Please try again.",
    ACCOUNT_INTEGRITY_FAILED:
        "We couldn't verify your account right now. Please contact support so we can help.",
    ACCOUNT_LOCKED:
        "Too many sign-in attempts. Please wait a few minutes and try again.",
    ACCOUNT_LOCKED_PERMANENTLY:
        "Your account has been locked for security. Please contact an administrator to reset your password and restore access.",
    ACCOUNT_INACTIVE:
        "Your account is currently inactive. Please contact an administrator to restore access.",
    /** 401 — the temporary password matched but its 72 hours are up. Shown only after the password is proved. */
    TEMP_PASSWORD_EXPIRED:
        "Your temporary password has expired. Ask an administrator to send you a new one.",
    /** 403 — a session opened with a temporary (or legacy default) password may only change it. */
    PASSWORD_CHANGE_REQUIRED:
        "Set a new password before continuing.",
    /** 400 — the new password must differ from the temporary one being replaced. */
    NEW_PASSWORD_SAME_AS_TEMPORARY:
        "Choose a new password that is different from your temporary password.",
};

// ─── Validation error messages ────────────────────────────────────────────────

const VALIDATION_ERRORS = {
    MISSING_FIELDS: "Missing required fields.",
    INVALID_INPUT: "Invalid input data.",
    INVALID_ID: "Invalid ID format.",
};

// ─── General error messages ───────────────────────────────────────────────────

const GENERAL_ERRORS = {
    /** 503 - the server is draining for a stop or restart (ShutdownGateMiddleware). */
    SERVER_SHUTTING_DOWN: "Service is restarting. Please retry.",
    /** 429 - too many open readiness streams (GET /health/stream) from one client or in total. */
    TOO_MANY_HEALTH_STREAMS: "Too many open status connections. Close some tabs and try again.",
    INTERNAL_SERVER_ERROR:
        "An unexpected error occurred. Please try again later.",
    NOT_FOUND: "The requested resource was not found.",
    CONFLICT: "A resource with the same identifier already exists.",
    SERVICE_UNAVAILABLE: "Service temporarily unavailable.",
    // Thrown when BatchGuard.httpStatusFor(report) returns null — zero rows
    // in a guarded batch succeeded, so the request must fail loud (503)
    // instead of masquerading as success.
    BATCH_SAVE_ALL_FAILED: "Batch save failed — no rows were saved.",
};

// ─── Admin Management error messages ─────────────────────────────────────────

const ADMIN_ERRORS = {
    ADMIN_NOT_FOUND:
        "Admin record not found. Verify the username and try again.",
    ADMIN_ALREADY_EXISTS: "This account is already registered as an admin.",
    DEFAULT_PASSWORD_FORBIDDEN:
        "The new password cannot be the same as the system default password. Choose a unique password.",
    SIGNATURE_RESET_REQUIRED:
        "Admin record integrity check failed. A signature reset is required before this record can be modified.",
    /** Raised when an inactive admin tries to log in. */
    ACCOUNT_INACTIVE:
        "Your admin account is currently inactive. Please contact a Super Admin to restore access.",

    // ── Access Control revoke ──────────────────────────────────────────────────────
    /** 428 — no backupToken was supplied on /revoke-backup, /revoke, or DELETE. */
    BACKUP_TOKEN_REQUIRED:
        "A backup token is required. Download the revoke backup archive first — this action is locked until you do.",
    /** 428 — token missing/expired/tampered/wrong-admin/wrong-target; reason is logged server-side only (never echoed to the client). */
    BACKUP_TOKEN_INVALID:
        "That backup token is invalid, expired, or does not match this admin record. Download a fresh backup and try again.",
    CANNOT_REVOKE_SELF:
        "You cannot revoke your own admin access. Ask another SUPER_ADMIN to perform this action.",
    CANNOT_DELETE_SELF:
        "You cannot delete your own admin account. Ask another SUPER_ADMIN to perform this action.",
    LAST_ACTIVE_SUPER_ADMIN:
        "This is the last active SUPER_ADMIN account. At least one other active SUPER_ADMIN must exist before this action can proceed.",
    /** 400 — the unblock-ip body is not a literal IPv4/IPv6 address. */
    INVALID_IP:
        "Enter a valid IPv4 or IPv6 address.",

    // ── Temporary-password onboarding ──
    /** 400 — the server generates the password now; a typed one is refused rather than silently dropped. */
    PASSWORD_FIELDS_NOT_ACCEPTED:
        "Passwords are no longer set here. A temporary password is generated and emailed to the account holder.",
    /** 400 — Edit no longer sets a password; Reset Password emails a temporary one. */
    EDIT_PASSWORD_NOT_ACCEPTED:
        "Passwords can't be set from Edit. Use Reset Password to email the account holder a new temporary password.",

    // ── Role policy — 403 AuthorizationError ───────────────────────────────────
    ADMIN_CREATE_USER_ONLY:
        "An Admin can only add User accounts. Ask a Super Admin to add an Admin or Super Admin account.",
    ADMIN_RESET_USER_ONLY:
        "An Admin can only reset the password of a User account. Ask a Super Admin for any other account.",
    ROLE_CHANGE_SUPER_ADMIN_ONLY:
        "Only a Super Admin can change an account's role.",
    RESET_SIGNATURE_SUPER_ADMIN_ONLY:
        "Only a Super Admin can repair an account's signature.",
    ROLE_ACTION_FORBIDDEN:
        "You don't have permission to manage admin accounts.",
    /** 400 — the profile already has an address for this account; a typed one could redirect the credential. */
    EMAIL_OVERRIDE_NOT_ALLOWED:
        "This account already has an email address on file. The temporary password can only be sent there.",
    /** 400 — the typed address is not exactly one plain email address. */
    INVALID_EMAIL:
        "Enter one valid email address.",
    /** 422 — no usable address on file and none was typed. */
    EMAIL_REQUIRED:
        "This account has no email address on file. Enter the address the temporary password should be sent to.",
    /** 503 — the address lookup failed, so the recipient cannot be decided; nothing was saved. */
    RECIPIENT_LOOKUP_UNAVAILABLE:
        "We couldn't look up this account's email address right now. Nothing was saved. Please try again shortly.",
    /** 500 — the wrapped temporary hash would not fit the admin PASSWORD column (ARGON2_HASH_LENGTH too large). */
    TEMP_PASSWORD_STORAGE_MISCONFIGURED:
        "Temporary passwords cannot be stored with the current password-hash settings. Contact the system administrator.",
};

// ─── Metrics error messages ───────────────────────────────────────────────────

const METRICS_ERRORS = {
    METRICS_UNAVAILABLE: "Metrics data is temporarily unavailable.",
    INVALID_PAYLOAD:
        "Invalid metrics payload. Expected a non-empty array of events.",
    PAYLOAD_TOO_LARGE:
        "Metrics payload exceeds the maximum of 50 events per request.",
};

// ─── Audit Log error messages ─────────────────────────────────────────────────

const AUDIT_LOG_ERRORS = {
    INVALID_DATE_RANGE:
        "Invalid date range. fromDate must be before toDate and both must be valid ISO dates.",
    AUDIT_LOG_TRACE_NOT_FOUND: (requestId) =>
        `No audit log record found for request ID: ${requestId}`,
    AUDIT_LOG_INVALID_REQUEST_ID: "Invalid request ID format.",
    AUDIT_LOG_INVALID_DATE_FORMAT: "Invalid date — expected YYYY-MM-DD",
    SYSTEM_LOG_INVALID_LEVEL:
        "Invalid level. Accepted values: emergency, alert, critical, error, warning, notice, info, debug.",
    SYSTEM_LOG_INVALID_PRIORITY:
        "Invalid maxPriority. Provide an integer between 0 (emergency) and 7 (debug).",
};

// ─── Changelog error messages ─────────────────────────────────────────────────

const CHANGELOG_ERRORS = {
    ENTRY_NOT_FOUND: "Changelog entry not found.",
    STORE_UNAVAILABLE: "Changelog data store is temporarily unavailable.",
    INVALID_ENTRY: "Invalid changelog entry data.",
};

// ─── Server Email Notifications error messages ───────────────────────────────

const NOTIFICATION_ERRORS = {
    TEST_SEND_FAILED:
        "We couldn't send the test notification email. Check the SMTP configuration and recipient list, then try again.",
    CHANNEL_UNKNOWN:
        "Unknown notification channel. Provide one of the four server notification channel keys.",
    INVALID_DATE_RANGE:
        "Invalid date range. 'from' must be on or before 'to' and both must be valid ISO dates.",
    INVALID_SEVERITY:
        "Invalid severity. Accepted values: WARNING, CRITICAL, RESOLVED.",

    // ── Phase 4: Alert Acknowledgement ────────────────────────────────────────
    ALERT_KEY_REQUIRED: "alertKey is required.",
    ALERT_NOT_FOUND:
        "Unknown alert key. It may have already recovered or never fired.",
    ALERT_NOT_ACTIVE:
        "This alert is not currently active. Only active (non-OK) alerts can be acknowledged.",
    ACK_NOT_FOUND: "No active acknowledgement found for this alert.",
    ACK_WRITE_FAILED: "We couldn't save the acknowledgement. Please try again.",
};

// ─── Integrity Center error messages ──────────────────────────────────────────

const INTEGRITY_ERRORS = {
    UNKNOWN_TABLE:
        "Unknown integrity table. Provide a table key from the catalog.",
    INVALID_DATE_RANGE:
        "Invalid date range. Provide ISO dates with 'from' on or before 'to'.",
};

// ─── Request watchdog ───────────────────────────────────────────────────────────

const REQUEST_ERRORS = {
    /** 504 — the request made no progress for longer than its idle limit. */
    STALLED:
        "The request stopped making progress and was cancelled by the server. Please try again.",
    /** Hint sent with the 504. */
    STALLED_HINT:
        "Check whether the action completed before retrying it, especially for bulk actions.",
};

// ─── Data Purge & Restore error messages (SUPER_ADMIN only) ─────────────────

const PURGE_ERRORS = {
    BACKUP_STALLED:
        "The backup stopped making progress and was cancelled. Nothing was saved. It will start over on the next run.",
    INVALID_SCOPE: "Select at least one group or table to purge.",
    UNKNOWN_TABLE:
        "One or more selected tables are not recognised. Refresh the page and try again.",
    PROTECTED_TABLE:
        "This table is protected and can never be purged or restored.",
    BACKUP_TOKEN_REQUIRED:
        "A backup token is required. Download the backup archive first — the Execute step is locked until you do.",
    BACKUP_TOKEN_INVALID:
        "That backup token is invalid. Download a fresh backup and try again.",
    BACKUP_TOKEN_EXPIRED:
        "That backup token has expired. Download a fresh backup and try again.",
    BACKUP_TOKEN_WRONG_ADMIN:
        "This backup token was issued to a different admin account. Download your own backup before purging.",
    BACKUP_TOKEN_SCOPE_MISMATCH:
        "This backup token does not cover the full scope you are about to purge. Download a backup that covers the entire selected scope.",
    /** 401 — this token's jti was already consumed by an earlier verify/purge attempt (replay). */
    BACKUP_TOKEN_REPLAYED:
        "This backup token has already been used and cannot be used again. Download a fresh backup and try again.",
    ROW_COUNT_CHANGED:
        "The data has changed since this backup was taken, so the backup is now stale. Download a fresh backup and try again.",
    CONFIRM_PHRASE_REQUIRED:
        "Type the confirmation phrase exactly as shown to proceed.",
    CONFIRM_PHRASE_MISMATCH:
        "The confirmation phrase does not match. Please type it exactly as shown, including capitalisation.",
    ADMIN_PASSWORD_REQUIRED:
        "Enter your admin password to confirm this action.",
    INVALID_ADMIN_PASSWORD:
        "That password doesn't match our records. Please try again.",
    ADMIN_NOT_FOUND:
        "We couldn't verify your admin account. Please sign in again.",
    LOCKOUT_ACK_REQUIRED:
        "This scope includes the Access Control admin table. You must acknowledge the full-lockout warning before proceeding.",

    // ── Restore ─────────────────────────────────────────────────────────────────
    RESTORE_NO_FILE:
        "No archive file was uploaded. Choose a .zip backup archive and try again.",
    RESTORE_INVALID_FILE_TYPE:
        "Only .zip files exported by this system's backup feature are accepted.",
    RESTORE_ARCHIVE_UNREADABLE:
        "We couldn't read this file as a .zip archive. Make sure it's an unmodified backup exported by this system.",
    RESTORE_ARCHIVE_INCOMPLETE:
        "This archive is missing manifest.json or signature.json and cannot be restored.",
    RESTORE_ARCHIVE_MALFORMED:
        "This archive's manifest or signature file could not be parsed.",
    RESTORE_SIGNATURE_INVALID:
        "This archive failed integrity verification — it may be corrupted, edited, or from a different system. Download a fresh backup and try again.",
    RESTORE_SCHEMA_MISMATCH:
        "This archive was created against a different schema version and cannot be restored here.",
    RESTORE_EMPTY_SCOPE: "This archive does not declare any tables to restore.",
    RESTORE_UNKNOWN_TABLE:
        "This archive references one or more tables that are not recognised and cannot be restored.",
    RESTORE_INVALID_KIND: "This archive's restore type is not recognised.",
    RESTORE_TARGET_NOT_EMPTY:
        "One or more target tables already contain data. A full-scope restore requires empty target tables — purge first, or use an entity-scoped archive.",
    RESTORE_ENTITY_METADATA_MISSING:
        "This entity-scoped archive is missing its entity identification metadata.",
    RESTORE_ENTITY_KEY_INVALID:
        "This entity-scoped archive's key column does not match the table's primary key and cannot be trusted.",
    RESTORE_ENTITY_KEY_PRESENT:
        "A record with this key already exists. Remove or rename the existing record before restoring this entity.",

    // ── Scheduled DB Backup ────────────────────────────────────────────────────
    BACKUP_ARCHIVE_ID_INVALID: "That backup archive ID is not valid.",
    BACKUP_ARCHIVE_NOT_FOUND:
        "That backup archive could not be found. It may have been pruned or deleted.",
    BACKUP_CHAIN_MEMBER_MISSING:
        "This backup can't be reconstructed — a table's data lives in an earlier backup in its chain that is missing or failed signature verification. Take a fresh full backup.",
    BACKUP_DELETE_HAS_DEPENDENTS:
        "This backup can't be deleted — one or more retained backups still depend on it for table data. Delete the dependent backups first, or delete the whole chain from its most recent member.",
    BACKUP_VERIFY_FAILED:
        "This backup archive failed signature and chain integrity verification. It may be corrupted or tampered with.",

    // ── Majority-vote delete ────────────────────────────────────────────────────
    BACKUP_DELETE_ALREADY_REQUESTED:
        "A delete request already exists for this archive. Vote on the existing request or cancel it first.",
    BACKUP_DELETE_ALREADY_VOTED:
        "You have already voted to delete this archive.",
    BACKUP_DELETE_NO_REQUEST:
        "No pending delete request exists for this archive.",
    BACKUP_DELETE_VOTES_INSUFFICIENT:
        "Not enough votes to delete this archive yet. More approvals are needed.",

    RESTORE_INCREMENTAL_UPLOAD:
        "This archive is an incremental backup and cannot be restored directly. Download the self-contained version from the Backup tab instead.",

    // Temporal gate: a scheduled backup is imminent or running; the wait time goes in the AppError `hint`.
    MANUAL_BACKUP_SCHEDULE_WINDOW:
        "A scheduled backup is about to run (or is currently running). Manual backups are paused during this window — try again once it completes.",
    PURGE_SCHEDULE_WINDOW:
        "A scheduled backup is about to run (or is currently running). Purges are paused during this window to avoid overlapping with it — try again once it completes.",
};

/**
 * Server-Sent Events — pre-upgrade refusals only. Once a connection is upgraded
 * a failure is reported as an SSE `event: error` frame, never as one of these.
 */
const STREAM_ERRORS = {
    TABLE_NOT_STREAMABLE: "This table does not support a real-time stream.",
    /** 500 — the pre-upgrade baseline lookup failed; the cause is logged server-side only (CWE-209). */
    BASELINE_UNAVAILABLE: "The live stream could not be started. Please try again shortly.",
    DUPLICATE_STREAM: "Stream already open for this account.",
};

/**
 * Dev-docs viewer — ADMIN / SUPER_ADMIN only (DevDocsService).
 *
 * Every message here is deliberately incurious about the filesystem. The corpus
 * layout is not the caller's business and echoing it back would hand an
 * attacker the map this feature exists to protect (CWE-209).
 */
const DEV_DOCS_ERRORS = {
    /** 404 — the id is not a key in the manifest. Thrown before any filesystem call. */
    DOC_NOT_FOUND: "That document could not be found.",
    /** 500 — the document is in the manifest but could not be read from disk. */
    DOC_READ_FAILED: "That document could not be read. Try again, or contact a Super Admin.",
    /** 500 — the dev-docs directory itself is missing or unreadable. */
    CORPUS_UNAVAILABLE: "Developer documentation is unavailable on this server.",
    /** 400 — search query absent or below the minimum length. */
    INVALID_QUERY: "Enter at least 2 characters to search.",
};

/**
 * Support system maps (Architecture, Runtime) — SUPER_ADMIN only (ArchitectureService).
 *
 * Deliberately generic: the validator's detail names nodes and edges and goes
 * to the server log only (CWE-209).
 */
const ARCHITECTURE_ERRORS = {
    /** 500 — a system-map model (architectureModel.js / runtimeModel.js) failed validation. */
    MAP_UNAVAILABLE: "This system map is unavailable on this server.",
};

/**
 * Cluster shared-state coordination (ENABLE_CLUSTERING). Thrown as
 * `AppError(..., 503, { type: "ClusterError" })` - the type is deliberately
 * not an outage type, so the frontend shows the error inline.
 */
const CLUSTER_ERRORS = {
    /** 503 - alert ack/status needs the cron leader and it did not answer. */
    LEADER_UNAVAILABLE:
        "The alert service is briefly unavailable. Please try again in a moment.",
};

module.exports = {
    AppError,
    CLUSTER_ERRORS,
    AUTH_ERRORS,
    STREAM_ERRORS,
    VALIDATION_ERRORS,
    GENERAL_ERRORS,
    ADMIN_ERRORS,
    AUDIT_LOG_ERRORS,
    METRICS_ERRORS,
    CHANGELOG_ERRORS,
    DEV_DOCS_ERRORS,
    ARCHITECTURE_ERRORS,
    INTEGRITY_ERRORS,
    NOTIFICATION_ERRORS,
    PURGE_ERRORS,
    REQUEST_ERRORS,
};
