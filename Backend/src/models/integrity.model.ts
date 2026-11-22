

/**
 * WHAT THIS FILE DOES
 * ───────────────────
 * Oracle data-access layer for the Integrity Center. A single TABLE_REGISTRY
 * declares every tamper-verifiable (ROW_HASH-signed) table — the allow-list: a
 * `table` key is NEVER interpolated; it only ever indexes this fixed map (CWE-89).
 * Each entry pairs a collection with its numeric PK, its filterable columns, a
 * row projection, and the matching row-verify function.
 *
 * Three read shapes, all bind-variable-safe and all bounded by an indexed slice:
 *   • sweepTampered — keyset-batched scan of a scoped slice; runs the per-row
 *     HMAC verify and returns ONLY the failing rows. O(scanned) time chunked,
 *     O(batch) memory. The headline "tampered-only" feed.
 *   • listPage      — offset page over the same scoped slice (browse-all).
 *   • getMaxPk / listSince — global MAX(pk) cursor + delta rows for the SSE
 *     live-tail of append-only tables (`live: true`).
 *
 * PROJECTION RULE: every projection includes the EXACT HMAC-signed fields +
 * ROW_HASH so verify recomputes correctly. Display-only columns may be added —
 * verify reads only its own fields. Never project secrets (password hashes):
 * tampered rows are returned to the client verbatim.
 *
 * SECURITY: filter VALUES flow through the oracle-mongo-wrapper bind system;
 * filter KEYS are mapped through each table's fixed `filters` dict (allow-list).
 */

import { createDb, OracleCollection } from "../utils/oracle-mongo-wrapper";

const _db = createDb("appDb");

/** Lazily-built OracleCollection cache (one per physical table). */
const _collections = new Map<string, InstanceType<typeof OracleCollection>>();
function _col(name: string) {
    let c = _collections.get(name);
    if (!c) {
        c = new OracleCollection(name, _db);
        _collections.set(name, c);
    }
    return c;
}

/** One tamper-verifiable table in the Integrity Center registry. */
export interface TableConfig {
    /** Stable client/route key. */
    key: string;
    /** Human label for the catalog. */
    label: string;
    /** Physical Oracle table name. */
    table: string;
    /** Numeric primary key column (keyset + live-tail). */
    pk: string;
    /** oracle-mongo-wrapper projection (verify ∪ display ∪ pk ∪ ROW_HASH). */
    project: Record<string, 0 | 1>;
    /** row → verified? e.g. `(row) => TamperDetectionService.verifyRow("T_ORDERS", row)` */
    verifyFn: (row: Record<string, unknown>) => Promise<boolean>;
    /** Client filter key → column (allow-list); `date` is the from/to range column. */
    filters: Record<string, string>;
    /** Filter keys whose values are bound as numbers. */
    numericFilters?: string[];
    /** Dropdown filters. */
    enums?: Record<string, { column: string; source?: string; label?: string }>;
    /** Exposes an SSE live-tail. */
    live: boolean;
}

/**
 * Registry of every tamper-verifiable table (see TableConfig).
 */
// Projects register their ROW_HASH-signed tables here. The table's domain must
// first be added to TamperDetectionService's _FIELD_BUILDERS (only
// T_SYSTEM_CONFIG ships with the template), e.g.
//   orders: {
//       key: "orders", label: "Orders", table: "T_ORDERS", pk: "ORDER_ID",
//       project: { ORDER_ID: 1, CUSTOMER_ID: 1, AMOUNT: 1, CREATED_AT: 1, ROW_HASH: 1 },
//       verifyFn: (row) => TamperDetectionService.verifyRow("T_ORDERS", row),
//       filters: { customer: "CUSTOMER_ID", date: "CREATED_AT" },
//       numericFilters: ["customer"],
//       live: true,
//   },
const TABLE_REGISTRY: Readonly<Record<string, TableConfig>> = Object.freeze({});

/** Hard ceiling on rows a single tamper sweep will scan (safety vs. runaway). */
const DEFAULT_SWEEP_CAP = 200_000;
/** Keyset batch size per sweep iteration. */
const DEFAULT_SWEEP_BATCH = 5_000;

class IntegrityModel {
    /** The frozen registry (catalog source of truth). */
    static REGISTRY = TABLE_REGISTRY;
    declare static TABLE_REGISTRY: typeof TABLE_REGISTRY;

    /**
     * Resolves a table config from the allow-list. Returns null for unknown keys
     * so callers can throw a clean 400 (the key is NEVER used to build SQL).
     * @param {string} key
     * @returns {TableConfig|null}
     */
    static getTableConfig(key: string): TableConfig | null {
        return Object.prototype.hasOwnProperty.call(TABLE_REGISTRY, key)
            ? TABLE_REGISTRY[key]
            : null;
    }

    /**
     * Catalog for the FE: one descriptor per table (no SQL surface).
     * @returns {Array<{ key:string, label:string, pk:string, filters:string[], live:boolean }>}
     */
    static listTables(): Array<{ key: string; label: string; pk: string; filters: string[]; live: boolean; }> {
        return Object.values(TABLE_REGISTRY).map((c) => ({
            key: c.key,
            label: c.label,
            pk: c.pk,
            filters: Object.keys(c.filters),
            enums: Object.keys(c.enums ?? {}),
            live: c.live,
        }));
    }

    /**
     * Distinct dropdown options for a table's low-cardinality (enum) filters.
     * An enum with a `label` reads a small lookup table (`source`); other enums
     * are DISTINCT over the table column. Result is tiny and
     * cached at the service layer, so the underlying scan runs at most once per
     * cache window.
     *
     * @param {string} key
     * @returns {Promise<Object<string, Array<{ value:string, label:string }>>>}
     */
    static async getFilterOptions(key: string): Promise<{ [s: string]: Array<{ value: string; label: string; }>; }> {
        const cfg = TABLE_REGISTRY[key];
        if (!cfg || !cfg.enums) return {};

        const entries = await Promise.all(
            Object.entries(cfg.enums).map(async ([fk, def]) => {
                const source = def.source ?? cfg.table;
                const labelCol = def.label; // a const so the closures below keep the narrowing
                if (labelCol) {
                    // Labeled list from a small lookup table.
                    const rows = await _col(source)
                        .find({})
                        .project({ [def.column]: 1, [labelCol]: 1 })
                        .sort({ [def.column]: 1 })
                        .limit(1000)
                        .toArray();
                    const opts = (rows ?? [])
                        .filter((r) => r[def.column] != null)
                        .map((r) => ({
                            value: String(r[def.column]),
                            label: r[labelCol] ? `#${r[def.column]} · ${r[labelCol]}` : `#${r[def.column]}`,
                        }));
                    return [fk, opts];
                }
                // DISTINCT values over the table column. The wrapper emits a
                // single-column group key under its SOURCE column name, never
                // `_id` — so sort and read by `def.column` (sorting on `_id`
                // compiled to ORDER BY "_ID" → ORA-00904 in production).
                const rows = await _col(source).aggregate([
                    { $group: { _id: `$${def.column}` } },
                    { $sort: { [def.column]: 1 } },
                ]);
                const opts = (rows ?? [])
                    .map((r) => r[def.column])
                    .filter((v: unknown) => v != null && v !== "")
                    .map((v: unknown) => ({ value: String(v), label: String(v) }));
                return [fk, opts];
            }),
        );

        return Object.fromEntries(entries);
    }

    /**
     * Builds a bind-safe match object from client filters using the table's
     * allow-listed filter dict. Unknown filter keys are ignored. `from`/`to`
     * map to a [$gte,$lte] range on the table's `date` column.
     *
     * @param {TableConfig} cfg
     * @param {object} filters - { <filter key>: value, from?: Date, to?: Date }
     * @returns {object} oracle-mongo-wrapper match
     */
    static _buildMatch(cfg: TableConfig, filters: Record<string, unknown> = {}): Record<string, unknown> {
        const f = cfg.filters;
        const numeric = cfg.numericFilters ?? [];
        const match: Record<string, unknown> = {};

        for (const [fk, column] of Object.entries(f)) {
            if (fk === "date" || filters[fk] == null) continue;
            match[column] = numeric.includes(fk) ? Number(filters[fk]) : String(filters[fk]);
        }

        if (f.date && (filters.from instanceof Date || filters.to instanceof Date)) {
            const range: Record<string, unknown> = {};
            if (filters.from instanceof Date) range.$gte = filters.from;
            if (filters.to instanceof Date) range.$lte = filters.to;
            match[f.date] = range;
        }

        return match;
    }

    /**
     * Keyset-batched tamper sweep over a scoped slice. Verifies each row's HMAC
     * and returns ONLY tampered rows. Never loads the whole table — iterates in
     * PK-descending batches until the slice is exhausted or the cap is hit.
     *
     * Time:  O(scanned) chunked.  Memory: O(batch + tampered).
     *
     * @param {string} key
     * @param {object} [filters]
     * @param {object} [opts]
     * @param {number} [opts.batch=5000]
     * @param {number} [opts.cap=200000]
     * @returns {Promise<{ tampered: object[], rowsScanned: number, truncated: boolean }>}
     */
    static async sweepTampered(key: string, filters: Record<string, unknown> = {}, opts: { batch?: number; cap?: number; } = {}): Promise<{ tampered: Record<string, unknown>[]; rowsScanned: number; truncated: boolean; }> {
        const cfg = TABLE_REGISTRY[key];
        if (!cfg) return { tampered: [], rowsScanned: 0, truncated: false };

        const batch = Math.max(1, Number(opts.batch) || DEFAULT_SWEEP_BATCH);
        const cap = Math.max(batch, Number(opts.cap) || DEFAULT_SWEEP_CAP);
        const baseMatch = IntegrityModel._buildMatch(cfg, filters);

        const tampered: Record<string, unknown>[] = [];
        let rowsScanned = 0;
        let cursor: number | null = null; // last PK seen (descending keyset)
        let truncated = false;

        // Loop: WHERE <scope> [AND pk < :cursor] ORDER BY pk DESC LIMIT batch.
        while (true) {
            const match: Record<string, unknown> = cursor == null
                ? baseMatch
                : { ...baseMatch, [cfg.pk]: { $lt: cursor } };

            const rows: Record<string, unknown>[] = await _col(cfg.table)
                .find(match)
                .project(cfg.project)
                .sort({ [cfg.pk]: -1 })
                .limit(batch)
                .toArray();

            if (!rows || rows.length === 0) break;

            // Verify the batch concurrently (HMAC is cheap; this is bounded by `batch`).
            const verdicts = await Promise.all(rows.map((r) => cfg.verifyFn(r)));
            for (let i = 0; i < rows.length; i++) {
                if (!verdicts[i]) tampered.push(rows[i]);
            }

            rowsScanned += rows.length;
            cursor = Number(rows[rows.length - 1][cfg.pk]);

            if (rows.length < batch) break;
            if (rowsScanned >= cap) { truncated = true; break; }
        }

        return { tampered, rowsScanned, truncated };
    }

    /**
     * Offset page over a scoped slice (browse-all). Returns raw rows + a count.
     * The service annotates each row with a per-row integrity verdict.
     *
     * @param {string} key
     * @param {object} [filters]
     * @param {object} [opts]
     * @param {number} [opts.page=1]
     * @param {number} [opts.limit=50]
     * @returns {Promise<{ rows: object[], total: number }>}
     */
    static async listPage(key: string, filters: Record<string, unknown> = {}, opts: { page?: number; limit?: number; } = {}): Promise<{ rows: Record<string, unknown>[]; total: number; }> {
        const cfg = TABLE_REGISTRY[key];
        if (!cfg) return { rows: [], total: 0 };

        const page = Math.max(1, Number(opts.page) || 1);
        const limit = Math.min(200, Math.max(1, Number(opts.limit) || 50));
        const skip = (page - 1) * limit;
        const match = IntegrityModel._buildMatch(cfg, filters);

        const [rows, total] = await Promise.all([
            _col(cfg.table)
                .find(match)
                .project(cfg.project)
                .sort({ [cfg.pk]: -1 })
                .skip(skip)
                .limit(limit)
                .toArray(),
            _col(cfg.table).find(match).count(),
        ]);

        return { rows: rows ?? [], total };
    }

    /**
     * MAX(pk) over a scoped slice — the SSE live-tail baseline/cursor.
     * O(1) via the PK (or scope) index.
     *
     * @param {string} key
     * @param {object} [filters]
     * @returns {Promise<number|null>}
     */
    static async getMaxPk(key: string, filters: Record<string, unknown> = {}): Promise<number | null> {
        const cfg = TABLE_REGISTRY[key];
        if (!cfg) return null;
        const match = IntegrityModel._buildMatch(cfg, filters);
        const row = await _col(cfg.table)
            .find(match)
            .project({ [cfg.pk]: 1 })
            .sort({ [cfg.pk]: -1 })
            .limit(1)
            .next();
        return row ? Number(row[cfg.pk]) : null;
    }

    /**
     * Rows inserted after `afterPk` (ascending) — the SSE delta. Bounded by cap.
     *
     * @param {string} key
     * @param {object} [filters]
     * @param {number} afterPk
     * @param {number} [cap=500]
     * @returns {Promise<object[]>}
     */
    static async listSince(key: string, filters: Record<string, unknown> = {}, afterPk: number, cap: number = 500): Promise<Record<string, unknown>[]> {
        const cfg = TABLE_REGISTRY[key];
        if (!cfg || afterPk == null) return [];
        const match = {
            ...IntegrityModel._buildMatch(cfg, filters),
            [cfg.pk]: { $gt: Number(afterPk) },
        };
        const rows = await _col(cfg.table)
            .find(match)
            .project(cfg.project)
            .sort({ [cfg.pk]: 1 })
            .limit(Math.max(1, Number(cap) || 500))
            .toArray();
        return rows ?? [];
    }
}

const __default = IntegrityModel;
export default __default;
__default.TABLE_REGISTRY = TABLE_REGISTRY;
export { TABLE_REGISTRY };
