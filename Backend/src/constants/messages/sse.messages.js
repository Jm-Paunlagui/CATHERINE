"use strict";

/**
 * @fileoverview Generic Server-Sent Events (SSE) poller log message templates —
 * used by every `ScopedSsePoller` instance (`src/utils/sse/ScopedSsePoller.js`),
 * regardless of which feature owns it.
 *
 * Every template is parameterised by the poller's own `name` (set at
 * construction — e.g. "live-feed", "report") so one log line always identifies
 * which stream it came from without a second lookup.
 *
 * Used ONLY in logger calls — never thrown or sent to clients.
 */

const sseMessages = {
    /**
     * @param {string} name - Poller instance name (e.g. "live-feed").
     * @param {string} scope - Scope key.
     * @returns {string}
     */
    SSE_SCOPE_OPENED: (name, scope) =>
        `${name} SSE stream opened — scope: ${scope}.`,

    /**
     * @param {string} name
     * @param {string} scope
     * @returns {string}
     */
    SSE_SCOPE_CLOSED: (name, scope) =>
        `${name} SSE stream closed — scope: ${scope}.`,

    /**
     * @param {string} name
     * @param {string} scope
     * @param {number} connectionCount
     * @returns {string}
     */
    SSE_SCOPE_CONNECTED: (name, scope, connectionCount) =>
        `${name} SSE connection joined scope "${scope}" — ${connectionCount} connection(s) now sharing it.`,

    /**
     * @param {string} name
     * @returns {string}
     */
    SSE_SHARED_POLL_STARTED: (name) =>
        `${name} SSE shared poller started (per-scope, one query per distinct scope per tick).`,

    /**
     * @param {string} name
     * @returns {string}
     */
    SSE_SHARED_POLL_STOPPED: (name) =>
        `${name} SSE shared poller stopped — no scopes remain.`,

    /**
     * @param {string} name
     * @param {string} scope
     * @param {string} err
     * @returns {string}
     */
    SSE_POLL_ERROR: (name, scope, err) =>
        `${name} SSE poll error for scope "${scope}": ${err}.`,

    /**
     * @param {string} name
     * @param {string} scope
     * @param {number} connCount
     * @param {number} threshold
     * @returns {string}
     */
    SSE_SCOPE_MAX_ERRORS: (name, scope, connCount, threshold) =>
        `${name} SSE scope "${scope}" hit ${threshold} consecutive poll errors — notifying ${connCount} connection(s) and dropping the scope.`,

    /**
     * @param {string} name
     * @param {string} scope
     * @returns {string}
     */
    SSE_UPDATE_SENT: (name, scope) =>
        `${name} SSE update pushed for scope "${scope}" — cursor changed, onChange ran.`,
};

module.exports = { sseMessages };
