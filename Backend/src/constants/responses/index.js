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
    409: "Conflict Detected",
    410: "Gone Permanently",
    413: "Payload Too Large",
    422: "Unprocessable Entity",
    423: "Locked Resource",
    429: "Too Many Requests",
    440: "Session Timeout",
    498: "Invalid Token",
    // 5xx Server Errors
    500: "Internal Server Error",
    502: "Bad Gateway",
    503: "Service Unavailable",
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
 * @param {{ type?: string, details?: Array, hint?: string, stack?: string }} [opts]
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
            ...(opts.stack && process.env.NODE_ENV !== "production"
                ? { stack: opts.stack }
                : {}),
        },
    };
}

// ─── Response message strings ─────────────────────────────────────────────────

const RESPONSE_MESSAGES = {
    // Auth
    LOGIN_SUCCESS: "Login successful.",
    LOGOUT_SUCCESS: "Logged out successfully.",
    TOKEN_REFRESHED: "Token refreshed successfully.",
    PASSWORD_CHANGED: "Password changed successfully.",

    // Generic CRUD
    FETCHED: "Data fetched successfully.",
    CREATED: "Resource created successfully.",
    UPDATED: "Resource updated successfully.",
    DELETED: "Resource deleted successfully.",

    // Admin Management
    ADMIN_CREATED: "Admin created successfully.",
    ADMIN_UPDATED: "Admin updated successfully.",
    ADMIN_DELETED: "Admin removed successfully.",
    PASSWORD_RESET: "Password reset to default successfully.",
    SIGNATURE_RESET: "Record signature recomputed successfully.",
    ADMIN_PERMISSIONS_UPDATED: "Admin permissions updated successfully.",
    BILLING_AUTO_SENT: "Billing report sent to opted-in admins.",

    // Audit Log
    AUDIT_LOG_LIST_FETCHED: "Audit log records fetched successfully.",
    AUDIT_LOG_STATS_FETCHED: "Audit log statistics fetched successfully.",
    AUDIT_LOG_DELETED:
        "Audit log records and server log files permanently deleted.",
    AUDIT_LOG_TRACE_FETCHED: "Request log trace fetched successfully.",

    // Metrics
    METRICS_FETCHED: "Metrics snapshot retrieved successfully.",
    METRICS_SUMMARY_FETCHED: "Metrics summary retrieved successfully.",
    METRICS_ALERTS_FETCHED: "Alert evaluations retrieved successfully.",
    METRICS_FRONTEND_INGESTED: "Frontend metrics received.",

    // Client-side error ingestion (ErrorBoundary → POST /client/errors)
    CLIENT_ERROR_LOGGED: "Error logged successfully.",

    // Changelog
    CHANGELOG_LIST_FETCHED: "Changelog entries fetched successfully.",
    CHANGELOG_ENTRY_CREATED: "Changelog entry created successfully.",
    CHANGELOG_ENTRY_UPDATED: "Changelog entry updated successfully.",
    CHANGELOG_ENTRY_DELETED: "Changelog entry deleted successfully.",

    // Release train (read-only — transitions are written via the changelog create path)
    RELEASE_STATE_FETCHED: "Release state retrieved successfully.",
};

module.exports = {
    sendSuccess,
    sendError,
    RESPONSE_MESSAGES,
    HTTP_STATUS_TITLES,
    getStatusTitle,
};
