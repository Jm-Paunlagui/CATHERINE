"use strict";

/**
 * @fileoverview Service for the /api/v1/client resource.
 *
 * Currently exposes a single capability: receive a structured error report
 * from the frontend ErrorBoundary (via `clientLogger`) and surface it in the
 * server log stream so render-time crashes are visible to operators alongside
 * server-side events.
 *
 * Notes:
 *   - This service never throws — the controller already wraps it in catchAsync,
 *     and an exception here would mask the original client-side error.
 *   - The payload is structured (message, stack, componentStack, url, userAgent,
 *     timestamp). The full object is passed as logger meta so the log pipeline
 *     can index every field.
 */

const { logger } = require("../utils/logger");
const { clientMessages } = require("../constants/messages");

class ClientService {
    /**
     * Logs a client-side ErrorBoundary report to the central log stream.
     *
     * @param {object} payload
     * @param {string} payload.message        - Error message text.
     * @param {string} [payload.stack]        - JS stack trace (when available).
     * @param {string} [payload.componentStack] - React component stack.
     * @param {string} [payload.url]          - URL where the error occurred.
     * @param {string} [payload.userAgent]    - Reporter's user agent string.
     * @param {string} [payload.timestamp]    - ISO-8601 timestamp from the client.
     * @param {object} [user]                 - Authenticated user (req.user); may be undefined.
     * @returns {Promise<void>}
     */
    static async logError(payload, user) {
        const { message, stack, componentStack, url, userAgent, timestamp } =
            payload ?? {};

        logger.error(
            clientMessages.CLIENT_ERROR(user?.userId ?? "unknown"),
            {
                message,
                stack,
                componentStack,
                url,
                userAgent,
                timestamp,
            },
        );
    }

    /**
     * Records a Help-search zero-result event so the misses can be mined to
     * grow the frontend synonym table (a query users type but the corpus cannot
     * answer is a candidate alias or a content gap). Logged at WARNING level —
     * it is not an error, but it IS actionable signal for whoever curates help.
     *
     * Never throws (the controller wraps it in catchAsync, and a telemetry
     * failure must never surface to the user whose search already failed).
     *
     * Input hardening (Cybersecurity — CWE-20 / CWE-400 / CWE-117):
     *   - the query is TRUNCATED to MAX_QUERY_LEN so a crafted megabyte string
     *     cannot flood the log pipeline,
     *   - newlines/control chars are stripped so a query cannot forge fake log
     *     lines (log injection),
     *   - a blank query is dropped (nothing to learn from an empty miss).
     *
     * @param {object} payload
     * @param {string} payload.query   - The normalised search query that missed.
     * @param {string} [payload.surface] - "assistant" | "center" (defaults to "unknown").
     * @param {object} [user]           - Authenticated user (req.user); may be undefined.
     * @returns {Promise<void>}
     */
    static async logHelpMiss(payload, user) {
        const MAX_QUERY_LEN = 120;
        const raw = typeof payload?.query === "string" ? payload.query : "";
        // Strip control chars (log-injection guard) then bound the length.
        // eslint-disable-next-line no-control-regex -- control-char range is the intended log-injection sanitiser target
        const query = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, MAX_QUERY_LEN);
        if (!query) return; // nothing actionable in an empty miss

        const surface = payload?.surface === "assistant" || payload?.surface === "center"
            ? payload.surface
            : "unknown";

        logger.warning(
            clientMessages.HELP_SEARCH_MISS(query, surface),
            {
                query,
                surface,
                userId: user?.userId ?? "unknown",
                role: user?.role ?? "unknown",
            },
        );
    }
}

module.exports = ClientService;
