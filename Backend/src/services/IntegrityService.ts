

/**
 * @fileoverview Integrity Center business logic.
 *
 * Orchestrates the generic per-table tamper engine (IntegrityModel) over its
 * SUPER_ADMIN allow-list (IntegrityModel.TABLE_REGISTRY — empty in the
 * template; projects register their ROW_HASH-signed tables there). Owns the
 * cache-aside sweep, per-row verdict annotation, and the SSE delta-verify helper.
 *
 * Layering: controllers call this; this calls IntegrityModel + the cache store.
 * Never sends HTTP responses — throws AppError on bad input.
 *
 * Performance: the tampered SET is tiny, so a sweep result is cached whole and
 * paged in memory. Callers bound a sweep with filters (e.g. a date range);
 * IntegrityModel caps any single sweep.
 */

import { AppError, INTEGRITY_ERRORS, HTTP_STATUS } from "../constants";
import { logger } from "../utils/logger";
import { integrityMessages } from "../constants/messages";
import { CacheKeyBuilder, registry } from "../middleware/cache";
import IntegrityModel from "../models/integrity.model";
import type { TableConfig } from "../models/integrity.model";

const _store = registry.resolve("integrity");

class IntegrityService {
    /**
     * The FE table catalog (no SQL surface).
     * @returns {Array<object>}
     */
    static listTables(): Array<Record<string, unknown>> {
        return IntegrityModel.listTables();
    }

    /**
     * Distinct dropdown options for a table's enum filters. Cache-aside — the
     * enum domain rarely changes.
     *
     * @param {string} key
     * @returns {Promise<Object<string, Array<{ value, label }>>>}
     */
    static async getFilterOptions(key: string): ReturnType<typeof IntegrityModel.getFilterOptions> {
        const cfg = IntegrityService._requireTable(key);
        if (!cfg.enums) return {};
        const cacheKey = CacheKeyBuilder.build("integrity", { table: key, resource: "filterOptions" });
        return _store.getOrSet(cacheKey, () => IntegrityModel.getFilterOptions(key));
    }

    /**
     * Resolves the table config or throws a clean 400. `key` only ever indexes
     * the frozen registry — never builds SQL (CWE-89).
     *
     * @param {string} key
     * @returns {import('../models/integrity.model').TableConfig}
     */
    static _requireTable(key: string): import('../models/integrity.model').TableConfig {
        const cfg = IntegrityModel.getTableConfig(key);
        if (!cfg) {
            throw new AppError(INTEGRITY_ERRORS.UNKNOWN_TABLE, HTTP_STATUS.BAD_REQUEST, {
                type: "ValidationError",
                details: [{ field: "table", issue: "Unknown integrity table key." }],
            });
        }
        return cfg;
    }

    /**
     * Cache key for a sweep result — the table plus every allow-listed filter
     * value (unset → "none") and the date range.
     *
     * @param {string} key
     * @param {object} cfg
     * @param {object} filters
     * @returns {string}
     * @private
     */
    static _sweepKey(key: string, cfg: TableConfig, filters: Record<string, unknown>): string {
        const parts: Record<string, unknown> = { table: key, mode: "tamper" };
        for (const name of Object.keys(cfg.filters ?? {})) {
            if (name === "date") continue;
            parts[name] = filters[name] ?? "none";
        }
        parts.from = filters.from instanceof Date ? filters.from.toISOString() : "none";
        parts.to = filters.to instanceof Date ? filters.to.toISOString() : "none";
        return CacheKeyBuilder.build("integrity", parts);
    }

    /**
     * Runs (or reads from cache) the tamper sweep, then returns one page of the
     * tampered set — the headline "tampered-only" feed.
     *
     * @param {string} key
     * @param {object} filters
     * @param {object} [opts] - { page, limit, forceRescan }
     * @returns {Promise<{ rows: object[], total: number, page: number, limit: number, rowsScanned: number, truncated: boolean, scannedAt: string }>}
     */
    static async getTamperFeed(key: string, filters: Record<string, unknown> = {}, opts: Record<string, unknown> = {}): Promise<{ rows: Record<string, unknown>[]; total: number; page: number; limit: number; rowsScanned: number; truncated: boolean; scannedAt: string; }> {
        const cfg = IntegrityService._requireTable(key);
        const page = Math.max(1, Number(opts.page) || 1);
        const limit = Math.min(200, Math.max(1, Number(opts.limit) || 50));

        const result = await IntegrityService._sweptTampered(key, cfg, filters, opts.forceRescan === true);

        const start = (page - 1) * limit;
        return {
            rows: result.tampered.slice(start, start + limit),
            total: result.tampered.length,
            page,
            limit,
            rowsScanned: result.rowsScanned,
            truncated: result.truncated,
            scannedAt: result.scannedAt,
        };
    }

    /**
     * Runs (or reads from cache) the scope-wide tamper sweep for one table +
     * filter set. Shared by the tamper feed, browse and export so toggling
     * modes and paginating never re-sweeps within the TTL.
     *
     * @param {string}  key
     * @param {object}  cfg
     * @param {object}  filters
     * @param {boolean} [forceRescan=false]
     * @returns {Promise<{ tampered: object[], rowsScanned: number, truncated: boolean, scannedAt: string }>}
     * @private
     */
    static async _sweptTampered(key: string, cfg: TableConfig, filters: Record<string, unknown>, forceRescan: boolean = false): Promise<{ tampered: Record<string, unknown>[]; rowsScanned: number; truncated: boolean; scannedAt: string; }> {
        const cacheKey = IntegrityService._sweepKey(key, cfg, filters);

        if (forceRescan) _store.del(cacheKey);

        return _store.getOrSet(cacheKey, async () => {
            logger.info(integrityMessages.SWEEP_STARTED(key, cacheKey));
            const swept = await IntegrityModel.sweepTampered(key, filters);
            const tampered = swept.tampered.map((r) => ({
                ...r,
                id: Number(r[cfg.pk]),
                integrity: "TAMPERED",
            }));
            logger.info(
                integrityMessages.SWEEP_COMPLETE(key, swept.rowsScanned, tampered.length, swept.truncated),
            );
            if (tampered.length > 0) logger.security("INTEGRITY_TAMPER_FOUND", { table: key, count: tampered.length });
            if (swept.truncated) logger.warning(integrityMessages.SWEEP_TRUNCATED(key, swept.rowsScanned));
            return {
                tampered,
                rowsScanned: swept.rowsScanned,
                truncated: swept.truncated,
                scannedAt: new Date().toISOString(),
            };
        });
    }

    /**
     * Forces a fresh sweep (invalidates the cached result) and returns page 1.
     *
     * @param {string} key
     * @param {object} filters
     * @param {object} [opts] - { limit, actor }
     * @returns {Promise<object>}
     */
    static async rescan(key: string, filters: Record<string, unknown> = {}, opts: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
        const cfg = IntegrityService._requireTable(key);
        logger.notice(
            integrityMessages.RESCAN_REQUESTED(key, IntegrityService._sweepKey(key, cfg, filters), opts.actor ?? "SYSTEM"),
        );
        return IntegrityService.getTamperFeed(key, filters, { page: 1, limit: opts.limit, forceRescan: true });
    }

    /**
     * Browse-all: an offset page over the scoped slice with a per-row verdict.
     * Verifies only the page's rows (≤ limit HMAC recomputes). Also reports the
     * scope-wide tamper count so a clean page cannot hide an alarm elsewhere.
     *
     * @param {string} key
     * @param {object} filters
     * @param {object} [opts] - { page, limit }
     * @returns {Promise<{ rows: object[], total: number, page: number, limit: number, tamperedInScope: number, sweepTruncated: boolean }>}
     */
    static async browsePage(key: string, filters: Record<string, unknown> = {}, opts: Record<string, unknown> = {}): Promise<{ rows: Record<string, unknown>[]; total: number; page: number; limit: number; tamperedInScope: number; sweepTruncated: boolean; }> {
        const cfg = IntegrityService._requireTable(key);
        const page = Math.max(1, Number(opts.page) || 1);
        const limit = Math.min(200, Math.max(1, Number(opts.limit) || 50));

        logger.info(integrityMessages.BROWSE_PAGE(key, page, limit));
        const { rows, total } = await IntegrityModel.listPage(key, filters, { page, limit });
        const annotated = await IntegrityService._annotate(cfg, rows);
        const sweep = await IntegrityService._sweptTampered(key, cfg, filters);

        return {
            rows: annotated,
            total,
            page,
            limit,
            tamperedInScope: sweep.tampered.length,
            sweepTruncated: sweep.truncated,
        };
    }

    /**
     * Every row in scope for the current table + filters + mode — the source
     * behind "Export Excel / Export CSV". "tamper" (default) returns the cached
     * tampered set; "all" returns every row in scope with its verdict.
     *
     * `maxRows` is a hard ceiling, NOT a page ("all" re-verifies an HMAC per
     * row); hitting it returns `truncated: true`. `sweepTruncated` means
     * tampered rows may exist beyond the sweep's own cap.
     *
     * Time: O(n) verifications in "all" mode; O(1) extra in "tamper" mode.
     *
     * @param {string} key
     * @param {object} [filters]
     * @param {object} [opts] - { mode: 'tamper'|'all', maxRows }
     * @returns {Promise<{ rows: object[], total: number, mode: 'tamper'|'all', truncated: boolean, sweepTruncated: boolean, rowsScanned: number, scannedAt: string|null }>}
     */
    static async exportRows(key: string, filters: Record<string, unknown> = {}, opts: Record<string, unknown> = {}): Promise<{ rows: Record<string, unknown>[]; total: number; mode: 'tamper' | 'all'; truncated: boolean; sweepTruncated: boolean; rowsScanned: number; scannedAt: string | null; }> {
        const cfg = IntegrityService._requireTable(key);
        const mode = opts.mode === "all" ? "all" : "tamper";
        const maxRows = Math.min(50_000, Math.max(1, Number(opts.maxRows) || 10_000));

        logger.info(integrityMessages.BROWSE_PAGE(key, 1, maxRows));

        const sweep = await IntegrityService._sweptTampered(key, cfg, filters);

        if (mode === "tamper") {
            const rows = sweep.tampered.slice(0, maxRows);
            return {
                rows,
                total: sweep.tampered.length,
                mode,
                truncated: sweep.tampered.length > rows.length,
                sweepTruncated: sweep.truncated,
                rowsScanned: sweep.rowsScanned,
                scannedAt: sweep.scannedAt,
            };
        }

        const { rows, total } = await IntegrityModel.listPage(key, filters, { page: 1, limit: maxRows });
        const annotated = await IntegrityService._annotate(cfg, rows);

        return {
            rows: annotated,
            total,
            mode,
            truncated: total > annotated.length,
            sweepTruncated: sweep.truncated,
            rowsScanned: sweep.rowsScanned,
            scannedAt: sweep.scannedAt,
        };
    }

    /**
     * Annotates raw rows with `id` + integrity verdict (VERIFIED | TAMPERED).
     *
     * @param {object} cfg
     * @param {object[]} rows
     * @returns {Promise<object[]>}
     */
    static async _annotate(cfg: TableConfig, rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
        const verdicts = await Promise.all((rows ?? []).map((r) => cfg.verifyFn(r)));
        return (rows ?? []).map((r, i) => ({
            ...r,
            id: Number(r[cfg.pk]),
            integrity: verdicts[i] ? "VERIFIED" : "TAMPERED",
        }));
    }

    // ── SSE live-tail helpers (tables registered with `live: true`) ──────────

    /**
     * MAX(pk) baseline/cursor for the live-tail.
     *
     * @param {string} key
     * @param {object} [filters]
     * @returns {Promise<number|null>}
     */
    static async getMaxPk(key: string, filters: Record<string, unknown> = {}): Promise<number | null> {
        IntegrityService._requireTable(key);
        return IntegrityModel.getMaxPk(key, filters);
    }

    /**
     * Delta rows after `afterPk`, annotated with their verdict. The SSE poller
     * pushes the count + any tampered rows.
     *
     * @param {string} key
     * @param {object} filters
     * @param {number} afterPk
     * @param {number} [cap=500]
     * @returns {Promise<{ newCount: number, maxPk: number|null, tampered: object[] }>}
     */
    static async getLiveDelta(key: string, filters: Record<string, unknown> = {}, afterPk: number, cap: number = 500): Promise<{ newCount: number; maxPk: number | null; tampered: Record<string, unknown>[]; }> {
        const cfg = IntegrityService._requireTable(key);
        const rows = await IntegrityModel.listSince(key, filters, afterPk, cap);
        if (!rows.length) return { newCount: 0, maxPk: afterPk ?? null, tampered: [] };
        const annotated = await IntegrityService._annotate(cfg, rows);
        const tampered = annotated.filter((r) => r.integrity === "TAMPERED");
        const maxPk = Number(rows[rows.length - 1][cfg.pk]);
        return { newCount: rows.length, maxPk, tampered };
    }
}

export default IntegrityService;
