"use strict";

/**
 * @fileoverview API response helpers and success message strings.
 *
 * Rule:
 *   sendSuccess / sendError → used in res.json(sendSuccess(...))
 *   RESPONSE_MESSAGES       → string constants used as message arguments
 *   Log messages            → belong in constants/messages/ instead
 *   Thrown error strings    → belong in constants/errors/ instead
 */

// ─── HTTP status title map ─────────────────────────────────────────────────────

/**
 * Human-readable title for each HTTP status code, aligned with RFC 9110.
 * Used to populate the `title` field of every error response so clients
 * always receive a machine-stable label alongside the free-text message.
 */
const HTTP_STATUS_TITLES = {
    // 2xx Success
    207: "Multi-Status",
    // 4xx Client Errors
    400: "Bad Request",
    401: "Unauthorized Access",
    403: "Forbidden Access",
    404: "Not Found",
    405: "Method Not Allowed",
    408: "Request Timeout",
    409: "Conflict Detected",
    410: "Gone Permanently",
    413: "Payload Too Large",
    422: "Unprocessable Entity",
    423: "Locked Resource",
    428: "Precondition Required",
    429: "Too Many Requests",
    440: "Session Timeout",
    498: "Invalid Token",
    // 5xx Server Errors
    500: "Internal Server Error",
    502: "Bad Gateway",
    503: "Service Unavailable",
    504: "Gateway Timeout",
    507: "Insufficient Storage",
    523: "Origin Unreachable",
};

/**
 * Returns the standard title for an HTTP status code.
 * Falls back to a broad category label for unmapped codes.
 *
 * @param {number} code
 * @returns {string}
 */
function getStatusTitle(code) {
    if (HTTP_STATUS_TITLES[code]) return HTTP_STATUS_TITLES[code];
    if (code >= 500) return "Server Error";
    if (code >= 400) return "Client Error";
    if (code >= 300) return "Redirect";
    return "Error";
}

// ─── Response helpers ─────────────────────────────────────────────────────────

/**
 * Build a standard success response body.
 * @param {string} message
 * @param {*} [data]
 * @param {number} [code=200]
 * @returns {{ status: string, code: number, message: string, data: * }}
 */
function sendSuccess(message, data = null, code = 200, requestId = null) {
    return {
        status: "success",
        code,
        message,
        requestId,
        data,
    };
}

/**
 * Build a standard error response body.
 * The global ErrorHandlerMiddleware builds its own response inline,
 * but this helper is available for controllers that need to return
 * a non-throwing error shape.
 *
 * `title` is auto-derived from `code` via `getStatusTitle()` — callers
 * do not need to supply it.
 *
 * @param {string} message
 * @param {number} [code=500]
 * @param {{ type?: string, details?: Array, hint?: string, reasons?: string[], stack?: string }} [opts]
 */
function sendError(message, code = 500, opts = {}) {
    return {
        status: "error",
        code,
        title: getStatusTitle(code),
        message,
        requestId: opts.requestId ?? null,
        error: {
            type: opts.type ?? "AppError",
            ...(opts.details ? { details: opts.details } : {}),
            ...(opts.hint ? { hint: opts.hint } : {}),
            ...(opts.reasons ? { reasons: opts.reasons } : {}),
            ...(opts.stack && process.env.NODE_ENV !== "production"
                ? { stack: opts.stack }
                : {}),
        },
    };
}

// ─── Response message strings ─────────────────────────────────────────────────

const RESPONSE_MESSAGES = {
    // Auth
    LOGIN_SUCCESS: "Welcome back! You're signed in.",
    LOGOUT_SUCCESS: "You've been signed out. See you next time!",
    TOKEN_REFRESHED: "Your session has been refreshed.",
    PASSWORD_CHANGED: "Your password has been updated.",

    // Generic CRUD
    FETCHED: "Data fetched successfully.",
    CREATED: "Resource created successfully.",
    UPDATED: "Resource updated successfully.",
    DELETED: "Resource deleted successfully.",

    // Guarded batch writes (BatchGuard.httpStatusFor → 207 Multi-Status)
    BATCH_SAVE_PARTIAL:
        "Saved with some issues — see the failed/pending rows for details.",

    // Admin Management
    ADMIN_CREATED: "Admin created successfully.",
    ADMIN_UPDATED: "Admin updated successfully.",
    ADMIN_DELETED: "Admin removed successfully.",
    PASSWORD_RESET: "A new temporary password was issued.",
    SIGNATURE_RESET: "Record signature recomputed successfully.",
    ADMIN_PERMISSIONS_UPDATED: "Admin permissions updated successfully.",
    ADMIN_REVOKED: "Admin access revoked successfully.",

    // Audit Log
    AUDIT_LOG_LIST_FETCHED: "Audit log records fetched successfully.",
    AUDIT_LOG_STATS_FETCHED: "Audit log statistics fetched successfully.",
    AUDIT_LOG_DELETED:
        "Audit log records and server log files permanently deleted.",
    AUDIT_LOG_TRACE_FETCHED: "Request log trace fetched successfully.",
    SYSTEM_LOGS_FETCHED: "System log entries fetched successfully.",

    // Metrics
    METRICS_FETCHED: "Metrics snapshot retrieved successfully.",
    METRICS_SUMMARY_FETCHED: "Metrics summary retrieved successfully.",
    METRICS_ALERTS_FETCHED: "Alert evaluations retrieved successfully.",
    METRICS_FRONTEND_INGESTED: "Frontend metrics received.",

    // Server email notifications
    NOTIFICATION_STATUS_FETCHED: "Notification status fetched successfully.",
    NOTIFICATION_TEST_SENT: "Test notification email sent successfully.",
    NOTIFICATION_HISTORY_FETCHED:
        "Alert notification history fetched successfully.",
    ALERT_ACKNOWLEDGED: "Alert acknowledged.",
    ALERT_UNACKNOWLEDGED: "Acknowledgement cleared.",

    // Client-side error ingestion (ErrorBoundary → POST /client/errors)
    CLIENT_ERROR_LOGGED: "Error logged successfully.",

    // Help-search miss telemetry (zero-result query → POST /client/help-miss)
    HELP_SEARCH_MISS_LOGGED: "Recorded.",

    // Changelog
    CHANGELOG_LIST_FETCHED: "Changelog entries fetched successfully.",
    CHANGELOG_LATEST_FETCHED: "Latest changelog entry fetched successfully.",
    DEV_DOCS_TREE_FETCHED: "Developer documentation index fetched successfully.",
    DEV_DOCS_DOC_FETCHED: "Developer document fetched successfully.",
    DEV_DOCS_SEARCH_COMPLETED: "Developer documentation search completed.",
    ARCHITECTURE_MAP_FETCHED: "Architecture map fetched successfully.",
    RUNTIME_MAP_FETCHED: "Runtime map fetched successfully.",
    CHANGELOG_ENTRY_CREATED: "Changelog entry created successfully.",
    CHANGELOG_ENTRY_UPDATED: "Changelog entry updated successfully.",
    CHANGELOG_ENTRY_DELETED: "Changelog entry deleted successfully.",

    // Release train (read-only — transitions are written via the changelog create path)
    RELEASE_STATE_FETCHED: "Release state retrieved successfully.",

    // Integrity Center (SUPER_ADMIN only — per-table tamper monitoring)
    INTEGRITY_TAMPER_FETCHED: "Integrity tamper feed fetched successfully.",
    INTEGRITY_BROWSE_FETCHED: "Integrity rows fetched successfully.",
    INTEGRITY_RESCAN_COMPLETE:
        "Integrity rescan complete. See summary for details.",
    INTEGRITY_EXPORT_FETCHED: "Integrity export rows fetched successfully.",
    INTEGRITY_TABLES_FETCHED: "Integrity table catalog fetched successfully.",
    INTEGRITY_FILTER_OPTIONS_FETCHED: "Filter options fetched successfully.",

    // Data Purge & Restore (SUPER_ADMIN only)
    PURGE_SCOPES_FETCHED: "Purge scope catalogue fetched successfully.",
    PURGE_PREVIEW_FETCHED: "Purge preview generated successfully.",
    PURGE_BACKUP_READY: "Backup archive generated successfully.",
    PURGE_AUTHORISED:
        "Password verified. You may proceed to the final confirmation.",
    PURGE_EXECUTED:
        "Purge completed successfully. See the report for per-table results.",
    RESTORE_PREVIEW_FETCHED:
        "Restore pre-flight report generated successfully.",
    RESTORE_EXECUTED:
        "Restore completed successfully. See the report for per-table results.",

    // Backup tab
    BACKUP_LIST_FETCHED: "Backup archive list fetched successfully.",
    BACKUP_MANUAL_STARTED:
        "Manual backup completed. See the archive details for results.",
    BACKUP_DOWNLOADED: "Backup archive download ready.",
    BACKUP_VERIFIED: "Backup archive integrity verified successfully.",
    BACKUP_DELETED: "Backup archive deleted successfully.",

    // Backup vote
    BACKUP_DELETE_REQUESTED:
        "Delete request submitted. Other admins will be notified to vote.",
    BACKUP_DELETE_VOTED: "Vote recorded.",
    BACKUP_DELETE_CANCELLED: "Delete request cancelled.",
    BACKUP_VOTE_STATUS_FETCHED: "Vote status fetched successfully.",
};

module.exports = {
    sendSuccess,
    sendError,
    RESPONSE_MESSAGES,
    HTTP_STATUS_TITLES,
    getStatusTitle,
};
