"use strict";

/**
 * @fileoverview Integrity Center HTTP controller.
 *
 * Thin HTTP layer — no business logic, no direct DB calls. Delegates to
 * IntegrityService. `:table` is validated against the registry allow-list in the
 * service (never interpolated into SQL — CWE-89).
 *
 * Routes handled:
 *   GET  /api/v1/integrity/tables
 *   GET  /api/v1/integrity/:table/tamper   (query: <registered filter keys>, from, to, page, limit)
 *   GET  /api/v1/integrity/:table/browse   (same query)
 *   POST /api/v1/integrity/:table/rescan   (same query as body/query — re-sweeps)
 */

const { HTTP_STATUS, AppError, INTEGRITY_ERRORS } = require("../constants");
const { sendSuccess, RESPONSE_MESSAGES } = require("../constants/responses");
const { catchAsync } = require("../utils/catchAsync");
const IntegrityService = require("../services/IntegrityService");

/** Query keys that are never scope filters. */
const NON_FILTER_KEYS = new Set(["from", "to", "page", "limit", "mode", "table"]);

/** A filter key a table registry could declare — anything else is dropped before lookup. */
const FILTER_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,39}$/;

/**
 * Parses a calendar/ISO date from a query value. Returns null when absent,
 * throws a 400 AppError when present but unparseable.
 *
 * @param {string|undefined} raw
 * @param {string} field
 * @returns {Date|null}
 */
function _parseDate(raw, field) {
    if (raw == null || raw === "") return null;
    const d = new Date(raw);
    if (isNaN(d.getTime())) {
        throw new AppError(INTEGRITY_ERRORS.INVALID_DATE_RANGE, HTTP_STATUS.BAD_REQUEST, {
            type: "ValidationError",
            details: [{ field, issue: "Must be an ISO 8601 date." }],
        });
    }
    return d;
}

class IntegrityController {
    /**
     * Builds the filter object from a request's query (and body for POST rescan).
     * Every scalar string value is kept under its own key; only keys the table's
     * registry entry declares are honoured downstream (IntegrityModel._buildMatch),
     * so unknown columns cannot be injected. Exposed statically so the SSE
     * controller reuses it.
     *
     * @param {object} src - req.query (and/or req.body)
     * @returns {object} `{ [filterKey]: string, from: Date|null, to: Date|null }`
     */
    static parseFilters(src = {}) {
        const from = _parseDate(src.from, "from");
        const to = _parseDate(src.to, "to");
        if (from && to && from.getTime() > to.getTime()) {
            throw new AppError(INTEGRITY_ERRORS.INVALID_DATE_RANGE, HTTP_STATUS.BAD_REQUEST, {
                type: "ValidationError",
                details: [{ field: "from", issue: "'from' must be on or before 'to'." }],
            });
        }
        const filters = { from, to };
        for (const [key, value] of Object.entries(src ?? {})) {
            if (NON_FILTER_KEYS.has(key) || !FILTER_KEY_PATTERN.test(key)) continue;
            if (typeof value !== "string" || value === "") continue;
            filters[key] = value;
        }
        return filters;
    }

    // ─── GET /tables ──────────────────────────────────────────────────────────

    /**
     * GET /api/v1/integrity/tables
     * Returns the table catalog (key, label, pk, filters, live) — no SQL surface.
     */
    static getTables = catchAsync(async (_req, res) => {
        const tables = IntegrityService.listTables();
        res.status(HTTP_STATUS.OK).json(
            sendSuccess(RESPONSE_MESSAGES.INTEGRITY_TABLES_FETCHED, { tables }),
        );
    });

    // ─── GET /:table/tamper ───────────────────────────────────────────────────

    /**
     * GET /api/v1/integrity/:table/tamper
     * The headline tampered-only feed (paginated from a cached sweep result).
     */
    static getTamper = catchAsync(async (req, res) => {
        const { table } = req.params;
        const filters = IntegrityController.parseFilters(req.query);
        const page = Number(req.query.page) || 1;
        const limit = Number(req.query.limit) || 50;

        const result = await IntegrityService.getTamperFeed(table, filters, { page, limit });
        res.status(HTTP_STATUS.OK).json(
            sendSuccess(RESPONSE_MESSAGES.INTEGRITY_TAMPER_FETCHED, result),
        );
    });

    // ─── GET /:table/filter-options ───────────────────────────────────────────

    /**
     * GET /api/v1/integrity/:table/filter-options
     * Distinct dropdown options for the table's enum filters.
     */
    static getFilterOptions = catchAsync(async (req, res) => {
        const options = await IntegrityService.getFilterOptions(req.params.table);
        res.status(HTTP_STATUS.OK).json(
            sendSuccess(RESPONSE_MESSAGES.INTEGRITY_FILTER_OPTIONS_FETCHED, { options }),
        );
    });

    // ─── GET /:table/browse ───────────────────────────────────────────────────

    /**
     * GET /api/v1/integrity/:table/browse
     * Browse-all: an offset page over the scoped slice with a per-row verdict.
     */
    static browse = catchAsync(async (req, res) => {
        const { table } = req.params;
        const filters = IntegrityController.parseFilters(req.query);
        const page = Number(req.query.page) || 1;
        const limit = Number(req.query.limit) || 50;

        const result = await IntegrityService.browsePage(table, filters, { page, limit });
        res.status(HTTP_STATUS.OK).json(
            sendSuccess(RESPONSE_MESSAGES.INTEGRITY_BROWSE_FETCHED, result),
        );
    });

    // ─── GET /:table/export ───────────────────────────────────────────────────

    /**
     * GET /api/v1/integrity/:table/export
     * Every row in scope for the Data Integrity Excel/CSV export — works for
     * every registered table because the table is addressed by :table exactly
     * as the paged reads are.
     *
     * Query:
     *   mode  {'tamper'|'all'} — defaults to 'tamper', matching the panel's
     *                            default headline view; 'all' mirrors the
     *                            "Show all rows" toggle.
     *   plus the same scope filters as /tamper and /browse.
     *
     * `page`/`limit` are deliberately ignored: the export is the whole scoped
     * set, not one screen. The route stays SUPER_ADMIN-only — the same
     * integrity boundary the rest of the feature enforces, and a bulk dump is
     * the last place to relax it.
     */
    static exportRows = catchAsync(async (req, res) => {
        const { table } = req.params;
        const filters = IntegrityController.parseFilters(req.query);
        const mode = req.query.mode === "all" ? "all" : "tamper";

        const result = await IntegrityService.exportRows(table, filters, { mode });
        res.status(HTTP_STATUS.OK).json(
            sendSuccess(RESPONSE_MESSAGES.INTEGRITY_EXPORT_FETCHED, result),
        );
    });

    // ─── POST /:table/rescan ──────────────────────────────────────────────────

    /**
     * POST /api/v1/integrity/:table/rescan
     * Invalidates the cached sweep for the scope and re-runs it (returns page 1).
     * CSRF token is auto-required (all POST routes are CSRF-covered).
     */
    static rescan = catchAsync(async (req, res) => {
        const { table } = req.params;
        // Scope may come from query or body — accept both.
        const filters = IntegrityController.parseFilters({ ...req.query, ...req.body });
        const limit = Number(req.query.limit ?? req.body?.limit) || 50;
        const actor = req.user?.userId ?? req.user?.sub ?? "SYSTEM";

        const result = await IntegrityService.rescan(table, filters, { limit, actor });
        res.status(HTTP_STATUS.OK).json(
            sendSuccess(RESPONSE_MESSAGES.INTEGRITY_RESCAN_COMPLETE, result),
        );
    });
}

module.exports = IntegrityController;
