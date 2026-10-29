"use strict";

/**
 * @fileoverview Log message templates for client-side error reports.
 * Used ONLY in logger.* calls — never thrown or sent to clients.
 *
 * Rule: all logger.info/logger.warning/logger.error strings for the
 * `/client/errors` ingestion endpoint must reference a named template
 * from this file.
 */

const clientMessages = {
    /**
     * Logged when an authenticated client posts an ErrorBoundary report.
     * @param {string|number} userId - The reporting user's identifier (JWT userId).
     * @returns {string}
     */
    CLIENT_ERROR: (userId) =>
        `Client-side render error reported by user ${userId}`,

    /**
     * Logged (at warning level) when a Help search returns zero results. These
     * are mined periodically to grow the frontend synonym table — a query that
     * users type but the corpus cannot answer is a candidate alias or a content
     * gap. Deterministic, non-PII: the query text is help-topic vocabulary.
     * @param {string} query - The normalised, zero-result search query.
     * @param {string} surface - "assistant" (launcher) or "center" (full page).
     * @returns {string}
     */
    HELP_SEARCH_MISS: (query, surface) =>
        `Help search miss (${surface}): "${query}" returned no results`,
};

module.exports = { clientMessages };
