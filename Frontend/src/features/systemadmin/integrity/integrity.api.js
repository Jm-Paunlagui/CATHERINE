/**
 * @fileoverview HTTP API layer for the Integrity Center feature (SUPER_ADMIN only).
 * All calls go through httpClient — never direct Axios (CWE-352). No state, no React.
 *
 * The SSE live-tail uses the native EventSource API (Axios cannot do SSE); it is
 * opened with withCredentials so the browser attaches the HTTP-only JWT cookie.
 *
 * Backend base: /api/v1/integrity. httpClient prepends /api/v1/, so paths omit it.
 *
 * Endpoints:
 *   GET  integrity/tables                 → { data: { tables: [{ key, label, pk, filters, enums, live }] } }
 *   GET  integrity/:table/filter-options  → { data: { options: { <enumKey>: [{ value, label }] } } }
 *   GET  integrity/:table/tamper?...      → { data: { rows, total, page, limit, rowsScanned, truncated, scannedAt } }
 *   GET  integrity/:table/browse?...      → { data: { rows, total, page, limit, tamperedInScope } }
 *   GET  integrity/:table/export?...      → { data: { rows, total, truncated, sweepTruncated } }
 *   POST integrity/:table/rescan          → { data: { ...same as tamper } }
 *   GET  integrity/stream?table=...       (SSE — tables registered with `live: true`)
 *
 * Query params: the table's registered filter keys, plus `from` / `to` (date
 * range on the table's `date` column), `page`, `limit`.
 */

import httpClient from "../../../middleware/HttpClient";
import { API_BASE_URL_TRIMMED } from "../../../config/apiBase";
import { SERVER_STATUS_KIND, reportServerStatus } from "../../../utils/serverStatus";

/**
 * Strips null/empty values so absent filters are omitted from the query string.
 * @param {object} params
 * @returns {object}
 */
function _clean(params = {}) {
    const out = {};
    for (const [k, v] of Object.entries(params)) {
        if (v != null && v !== "") out[k] = v;
    }
    return out;
}

/**
 * @namespace integrityApi
 */
export const integrityApi = {
    /**
     * Fetch the table catalog (key, label, pk, filters, enums, live).
     * @returns {Promise<import('axios').AxiosResponse>}
     */
    getTables: () => httpClient.get("integrity/tables"),

    /**
     * Distinct dropdown options for a table's enum filters.
     * @param {string} table
     * @returns {Promise<import('axios').AxiosResponse>}
     */
    getFilterOptions: (table) => httpClient.get(`integrity/${table}/filter-options`),

    /**
     * Fetch the tampered-only feed for a table.
     * @param {string} table
     * @param {object} params - registered filter keys, from, to, page, limit
     * @returns {Promise<import('axios').AxiosResponse>}
     */
    getTamper: (table, params = {}) => httpClient.get(`integrity/${table}/tamper`, { params: _clean(params) }),

    /**
     * Fetch an offset page of all rows (each carrying a per-row verdict).
     * @param {string} table
     * @param {object} params
     * @returns {Promise<import('axios').AxiosResponse>}
     */
    browse: (table, params = {}) => httpClient.get(`integrity/${table}/browse`, { params: _clean(params) }),

    /**
     * Fetch EVERY row in scope for the Excel/CSV export — the whole scoped set, not one page.
     * @param {string} table
     * @param {object} params - the same scope filters, plus mode: 'tamper'|'all'
     * @returns {Promise<import('axios').AxiosResponse>}
     */
    exportRows: (table, params = {}) => httpClient.get(`integrity/${table}/export`, { params: _clean(params) }),

    /**
     * Invalidate the cached sweep for a scope and re-run it (returns page 1).
     * CSRF token is auto-injected by httpClient.
     * @param {string} table
     * @param {object} params - scope filters + optional limit
     * @returns {Promise<import('axios').AxiosResponse>}
     */
    rescan: (table, params = {}) => httpClient.post(`integrity/${table}/rescan`, _clean(params)),

    /**
     * Opens an SSE live-tail for a streamable table.
     * The browser sends the HTTP-only JWT cookie via withCredentials.
     *
     * @param {string} table
     * @param {object} [opts]
     * @param {object} [opts.params] - scope filters
     * @param {(data: { table, newCount, maxPk, tampered }) => void} [opts.onUpdate]
     * @param {(data: object) => void} [opts.onHeartbeat]
     * @param {(data: object) => void} [opts.onConnected]
     * @param {(event: Event) => void} [opts.onError]
     * @returns {EventSource} caller must call `.close()` on cleanup
     */
    createStream: (table, { params = {}, onUpdate, onHeartbeat, onConnected, onError } = {}) => {
        const qs = new URLSearchParams(_clean({ table, ...params })).toString();
        const url = `${API_BASE_URL_TRIMMED}/integrity/stream?${qs}`;

        const es = new EventSource(url, { withCredentials: true });

        const safe = (handler) => (e) => {
            try {
                handler?.(e.data ? JSON.parse(e.data) : {});
            } catch {
                /* malformed event payload — ignore */
            }
        };

        es.addEventListener("connected", safe(onConnected));
        es.addEventListener("update", safe(onUpdate));
        es.addEventListener("heartbeat", safe(onHeartbeat));
        es.addEventListener("error", (e) => onError?.(e));
        // Emit only (no auto-reopen): drain notice -> banner; open -> reachable.
        es.addEventListener("shutdown", () => reportServerStatus(SERVER_STATUS_KIND.SHUTDOWN));
        es.addEventListener("open", () => reportServerStatus(SERVER_STATUS_KIND.OK, { sentAt: Date.now() }));

        return es;
    },
};

export default integrityApi;
