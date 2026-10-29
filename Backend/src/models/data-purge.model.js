"use strict";

/**
 * @fileoverview Data Purge & Restore — Oracle data access layer.
 *
 * WHAT THIS FILE DOES
 * --------------------
 * The ONLY place in this feature that touches `OracleCollection` /
 * `Transaction` for the registered purgeable tables. `DataPurgeService` never issues
 * SQL directly — it calls into this model.
 *
 * HOW IT WORKS
 * ------------
 * `const _db = createDb("appDb");` is bound EXPLICITLY, once, at module top —
 * never a bare `createDb()` (whose default pool is not this app's; see
 * `src/utils/oracle-mongo-wrapper/db.js`) and never a pool name
 * derived from a request or parameter. This is Mitigation 1 of the three
 * belt-and-braces pool-safety mitigations. No dedicated unit test pins this
 * binding yet — keep it a literal so a review catches any change.
 *
 * Every method resolves its table name through
 * `purgeTables.getEntry(table)` FIRST and throws if the name is not a
 * registered purge table — table names never reach a query unless they
 * came from the registry allow-list (CWE-89). `getEntry()` itself asserts
 * `pool === PURGE_POOL` ("appDbBulk") on every call (Mitigation 2) — the
 * sanctioned purge-transaction pool.
 *
 * All queries use the oracle-mongo-wrapper bind-variable pipeline
 * (`OracleCollection` / `Transaction`) for every VALUE — zero string
 * interpolation of caller-supplied data anywhere in this file.
 * `streamTable` is the one method that also builds raw SQL text (via
 * `db.withConnection`), and only to interpolate Oracle IDENTIFIERS — the
 * table name (registry-derived, never client input) and column names read
 * live from `USER_TAB_COLUMNS` (a DB catalog query, also never client
 * input). Oracle has no bind-variable syntax for identifiers.
 *
 * EXAMPLE
 * -------
 *   const DataPurgeModel = require("./data-purge.model");
 *   const counts = await DataPurgeModel.countRows(["T_AUDIT_LOGS_DEV", "T_SERVER_ALERT_LOG_DEV"]);
 *   // → { T_AUDIT_LOGS_DEV: 128031, T_SERVER_ALERT_LOG_DEV: 4021 }
 *
 * SUPPORTED OPERATIONS
 * ---------------------
 *   countRows(tables)                 — live row count per table (GET /scopes, POST /preview)
 *   streamTable(table, opts)          — paginated full-table read (BackupArchiveService)
 *   streamTableFiltered(table, opts)  — paginated OR'd-equality-filtered read (archives only
 *                                       one owner's rows, e.g. an admin revoke-backup)
 *   streamAllTables(tables, opts)     — ONE connection, ONE `SET TRANSACTION READ ONLY`
 *                                       transaction spanning every listed table, so a row
 *                                       cannot be torn between two tables read at different
 *                                       moments (an unattended scheduled backup can otherwise
 *                                       race a job moving rows between two tables mid-read).
 *                                       Reuses the exact same per-table read body
 *                                       as streamTable via `_streamRowsOnConnection` — never
 *                                       a forked copy. Surfaces ORA-01555 (snapshot too old)
 *                                       as a distinguishable, catchable signal rather than
 *                                       retrying or swallowing it.
 *   deleteTable(table, session)       — DELETE all rows of one table, inside a Transaction session
 *   purgeTables(tableNames, onStep)   — orchestrates the WHOLE purge in one Transaction, leaves→roots order
 *   insertRestoreBatch(table, rows, session) — type-normalised, virtual/identity-PK-excluding
 *                                       batch INSERT for one restore table, inside a Transaction
 *                                       session (DataRestoreService)
 *   existsByKey(table, keyColumn, keyValue) — ENTITY-kind restore pre-flight existence check
 */

const db = require("../config");
const {
    createDb,
    OracleCollection,
    Transaction,
} = require("../utils/oracle-mongo-wrapper");
const { getEntry, getDeleteOrder } = require("../constants/purgeTables");
const { logger } = require("../utils/logger");
const { dataPurgeMessages } = require("../constants/messages");

// Explicit "appDb" argument — see file header. NEVER change this to a bare
// createDb() or to a variable/parameter-derived pool name.
// `_db` backs the SMALL, interactive pre-flight/verification lookups on this
// model (countRows, existsByKey) — those stay on the appDb
// (interactive) pool. Do NOT re-bind `_db` to appDbBulk.
const _db = createDb("appDb");

// Separate handle bound to the appDbBulk pool for the LONG-HOLD purge
// transaction (`purgeTables` deletes across many tables in one transaction).
// Kept distinct from `_db` so the bulk purge cannot starve the interactive appDb
// pool, while the small lookups above keep their low latency. The restore
// transaction (DataRestoreService) binds its own appDbBulk handle;
// `insertRestoreBatch` just runs inside the session it passes.
const _bulkDb = createDb("appDbBulk");

/** Canonical text form of a signed TIMESTAMP(6) column (shared with TamperDetectionService). */
const CANONICAL_TS_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.FF6';

/**
 * Resolves and validates a table name against the purgeTables registry.
 * Throws for any name that is not a registered purge table (including a
 * syntactically valid Oracle identifier that simply isn't in scope for this
 * feature) — this is the CWE-89 choke point for every method below.
 *
 * @param {string} table
 * @param {string} callerLabel - Method name, used only in the thrown message.
 * @returns {import('../constants/purgeTables').PurgeTableEntry}
 * @throws {Error}
 * @private
 */
function _requireEntry(table, callerLabel) {
    const entry = getEntry(table);
    if (!entry) {
        throw new Error(
            `DataPurgeModel.${callerLabel}: "${table}" is not a registered purge table.`,
        );
    }
    return entry;
}

/**
 * Builds the WHERE filter for a count/delete. An append-only log table with a
 * high-water mark is bounded to `pk <= highWater`; anything else is the whole
 * table. A high-water supplied for a non-append-only table is ignored so a
 * real-data purge can never be narrowed (and leave rows behind) by it.
 *
 * @param {import('../constants/purgeTables').PurgeTableEntry} entry
 * @param {string|number|null|undefined} highWater - Exact-digit PK string.
 * @returns {object}
 * @private
 */
function _boundedFilter(entry, highWater) {
    if (!entry.appendOnlyLog || highWater == null || highWater === "") return {};
    return { [entry.pk]: { $lte: String(highWater) } };
}

class DataPurgeModel {
    // ─── Reads ──────────────────────────────────────────────────────────────

    /**
     * Returns live row counts for a set of tables. Table names are resolved
     * through the registry — a name that is not registered throws rather
     * than silently returning 0 or being skipped.
     *
     * @param {string[]} tables - Table names (already registry-validated by the caller).
     * @param {Record<string, string>} [highWater] - Optional per-table PK high-water; only honoured for `appendOnlyLog` tables (counts `pk <= hw`).
     * @returns {Promise<Record<string, number>>} table name -> row count
     * @throws {Error} When any name in `tables` is not a registered purge table.
     *
     * @example
     * const counts = await DataPurgeModel.countRows(["T_AUDIT_LOGS_DEV", "T_SERVER_ALERT_ACK_DEV"]);
     */
    static async countRows(tables, highWater = {}) {
        const counts = {};
        await Promise.all(
            (tables ?? []).map(async (table) => {
                const entry = _requireEntry(table, "countRows");
                const col = new OracleCollection(entry.table, _db);
                counts[entry.table] = await col.countDocuments(_boundedFilter(entry, highWater?.[entry.table]));
            }),
        );
        return counts;
    }

    /**
     * Streams every row of one table in `pageSize`-sized batches, calling
     * `opts.onBatch(rows)` for each batch, ordered by the table's primary
     * key for a deterministic, resumable read order. Never loads an entire
     * table into memory at once — used by `BackupArchiveService` to build
     * the backup archive's `data/<TABLE>.jsonl` files.
     *
     * PRECISION: every column listed in the registry entry's
     * `identifierColumns` (FK columns, the PK when numeric, …) is
     * `TO_CHAR()`'d in the SELECT list, so the value is
     * already an exact-digit STRING by the time it reaches the oracledb
     * driver — it is NEVER round-tripped through a JS `number` first. This
     * is required, not optional: a `NUMBER(38,0)` identifier can exceed
     * `Number.MAX_SAFE_INTEGER`'s ~15.95 significant digits. Once a value
     * has passed through oracledb's default NUMBER→JS-number conversion the
     * original digits cannot be recovered by any later `String()` call —
     * the `TO_CHAR` MUST happen in the SQL itself.
     *
     * Uses raw `db.withConnection` SQL (not the wrapper's generic
     * `.find()`) specifically to control this per-column `TO_CHAR`
     * projection — the wrapper's `SELECT *` has no way to express it. The
     * full column list is discovered once per call from `USER_TAB_COLUMNS`
     * (a live catalog query — not a hardcoded list here, so this registry
     * never has to mirror every column of every table).
     *
     * @param {string} table
     * @param {object} [opts]
     * @param {number} [opts.pageSize=1000] - Rows fetched per round trip.
     * @param {(rows: object[]) => (Promise<void>|void)} [opts.onBatch] - Called once per batch, in PK order.
     * @returns {Promise<number>} Total rows streamed.
     * @throws {Error} When `table` is not a registered purge table, or when
     *   `USER_TAB_COLUMNS` returns no columns (privilege/typo bug — fails
     *   loudly rather than silently streaming zero rows forever).
     *
     * @example
     * const total = await DataPurgeModel.streamTable("T_AUDIT_LOGS_DEV", {
     *     pageSize: 2000,
     *     onBatch: async (rows) => archive.append(toJsonl(rows), { name: "data/T_AUDIT_LOGS_DEV.jsonl" }),
     * });
     */
    static async streamTable(table, opts = {}) {
        return DataPurgeModel._streamRows(table, opts, "streamTable");
    }

    /**
     * Same precision-safe streaming as {@link DataPurgeModel.streamTable}, but
     * restricted to rows matching `opts.whereColumns[i] = opts.whereValue` for
     * ANY of the listed columns (an OR'd equality — e.g. "this admin generated
     * it OR requested it OR resolved it"). Used by an admin revoke-backup to
     * archive only the rows that belong to ONE admin, rather than the whole table.
     *
     * `whereColumns` is NEVER derived from the HTTP request — every call site
     * in this codebase passes a small, hardcoded column list from server code
     * (`AdminManagementService`) — but is still validated against the live
     * `USER_TAB_COLUMNS` catalog before being interpolated as a SQL identifier,
     * exactly like the SELECT list already is (CWE-89 defense in depth). The
     * bound VALUE itself always flows through `:whereValue` — never
     * interpolated into the SQL string.
     *
     * @param {string} table
     * @param {object} opts
     * @param {number} [opts.pageSize=1000]
     * @param {(rows: object[]) => (Promise<void>|void)} [opts.onBatch]
     * @param {string[]} opts.whereColumns - Non-empty; column names OR'd together, e.g. `["REQUESTED_BY", "ASSIGNED_TO", "RESOLVED_BY"]`.
     * @param {string|number} opts.whereValue - The single value compared against every column in `whereColumns`.
     * @returns {Promise<number>} Total matching rows streamed.
     * @throws {Error} When `table` is not registered, `whereColumns` is empty, or names a column that does not exist on the table.
     *
     * @example
     * const count = await DataPurgeModel.streamTableFiltered("T_SERVER_ALERT_ACK_DEV", {
     *     whereColumns: ["ACKED_BY"],
     *     whereValue: 10234,
     *     onBatch: (rows) => rows.forEach((r) => collected.push(r)),
     * });
     */
    static async streamTableFiltered(table, opts = {}) {
        if (!Array.isArray(opts.whereColumns) || opts.whereColumns.length === 0) {
            throw new Error(`DataPurgeModel.streamTableFiltered: "${table}" requires a non-empty opts.whereColumns array.`);
        }
        return DataPurgeModel._streamRows(table, opts, "streamTableFiltered");
    }

    /**
     * Reads MANY tables inside ONE read-consistent Oracle transaction — the
     * fix for the "torn snapshot" hazard of a multi-table backup.
     *
     * `SET TRANSACTION READ ONLY` is issued as the very FIRST statement on a
     * single, freshly-acquired connection, before any table's SELECT runs.
     * Oracle then serves every later SELECT on this connection from the same
     * System Change Number (SCN) for the lifetime of the transaction. This
     * matters because {@link DataPurgeModel.streamTable} does NOT provide
     * that guarantee: it opens a fresh connection per table and pages with
     * independent `OFFSET … FETCH NEXT` statements. At human pace during a
     * manual purge that is tolerable; an UNATTENDED scheduled backup can fire
     * while a background job is mid-flight moving rows from one table into
     * another — a row can then land in the target AFTER the source was read
     * and BEFORE the target was read, appearing in NEITHER (or
     * the reverse, appearing in both). Both corrupt the backup undetectably.
     * `streamAllTables` closes that gap for exactly the multi-table backup
     * use case; `streamTable` / `streamTableFiltered` are UNCHANGED and keep
     * serving the manual purge and the single-admin
     * revoke-backup, which do not need this guarantee.
     *
     * The per-table read body (column-catalog lookup, `TO_CHAR()` identifier
     * projection so large identifiers survive as exact
     * strings, CLOB `fetchInfo`, PK-ordered paging) is NOT duplicated here —
     * every table is read via the exact same
     * {@link DataPurgeModel._streamRowsOnConnection} helper that
     * `streamTable`/`streamTableFiltered` call too, just reusing the ONE
     * connection this method already opened instead of opening a new one per
     * table. A second copy of that logic would inevitably drift from the
     * first (e.g. one copy gets a precision fix the other doesn't).
     *
     * **`ORA-01555` contract.** A long-lived read-only transaction can be
     * invalidated by undo-segment reuse on a busy database (`ORA-01555
     * snapshot too old`). This method does NOT retry — retrying mid-tear
     * just produces a different torn snapshot, and a backup that silently
     * retries into a still-torn read is worse than one that fails loudly.
     * Instead it:
     *   1. Catches ONLY this specific Oracle error — checked against both the
     *      driver's numeric `errorNum` (1555) and the message text, read off
     *      `err.originalError` because `db.withConnection` rewraps every
     *      error its callback throws into a new `Error` (see
     *      `src/config/adapters/oracle.js#withConnection`). Every other
     *      error propagates completely unchanged — this is a specific catch,
     *      not a bare one.
     *   2. Logs `logger.warning` — this is the "expected business error"
     *      bucket per `Backend/CLAUDE.md`'s logging decision table (a busy
     *      DB invalidating a long read is an expected, non-fatal condition
     *      for this feature, not a system failure), not `error`/`crit`.
     *   3. Throws a NEW error with `.code === "ORA_01555_SNAPSHOT_TOO_OLD"`
     *      and `.isSnapshotTooOld === true` so a later caller
     *      (`BackupArchiveService`) can
     *      distinguish "torn snapshot — fall back to the per-table
     *      `streamTable` path and stamp `readConsistent: false` on the
     *      manifest" from every other failure mode, which should abort the
     *      backup outright rather than silently downgrading it.
     *
     * @param {string[]} tables - Table names. Every name is resolved through
     *   the purgeTables registry via `_requireEntry` BEFORE any connection is
     *   opened — a bad name at any position rejects the WHOLE call with zero
     *   rows read from any table (same CWE-89 choke point as every other
     *   method in this file).
     * @param {object} [opts]
     * @param {number} [opts.pageSize=1000] - Rows fetched per round trip, per table.
     * @param {(table: string, rows: object[]) => (Promise<void>|void)} [opts.onBatch] -
     *   Called once per batch, PK-ordered within each table. Unlike
     *   `streamTable`'s `onBatch(rows)`, the table name is the FIRST argument
     *   here because one call spans many tables.
     * @returns {Promise<Record<string, number>>} Total rows streamed, per table.
     * @throws {Error} When any name in `tables` is not a registered purge
     *   table, or when `USER_TAB_COLUMNS` returns no columns for a table. On
     *   `ORA-01555` specifically, throws an error carrying
     *   `.code === "ORA_01555_SNAPSHOT_TOO_OLD"` / `.isSnapshotTooOld ===
     *   true` — see the ORA-01555 contract above.
     *
     * @example
     * const counts = await DataPurgeModel.streamAllTables(
     *     ["T_AUDIT_LOGS_DEV", "T_SERVER_ALERT_LOG_DEV"],
     *     { onBatch: (table, rows) => archive.append(table, toJsonl(rows)) },
     * );
     * // → { T_AUDIT_LOGS_DEV: 12031, T_SERVER_ALERT_LOG_DEV: 88420 }
     */
    static async streamAllTables(tables, opts = {}) {
        if (!Array.isArray(tables) || tables.length === 0) {
            throw new Error('DataPurgeModel.streamAllTables: "tables" must be a non-empty array.');
        }
        // Registry validation for EVERY table happens BEFORE the connection
        // is opened — a bad name at position N must not leave tables[0..N-1]
        // already streamed against a transaction that is doomed to fail.
        const entries = tables.map((table) => _requireEntry(table, "streamAllTables"));

        const pageSize = Number.isInteger(opts.pageSize) && opts.pageSize > 0 ? opts.pageSize : 1000;
        const onBatch = typeof opts.onBatch === "function" ? opts.onBatch : () => {};

        try {
            // Long-hold multi-table read-only stream — routed to the appDbBulk
            // pool so it cannot starve interactive traffic on the appDb pool.
            return await db.withConnection("appDbBulk", async (conn) => {
                // MUST be the first statement issued on this connection —
                // Oracle only accepts SET TRANSACTION as the first statement
                // of a transaction (ORA-01453 otherwise). Every table read
                // below therefore shares this one read-only transaction/SCN.
                await conn.execute("SET TRANSACTION READ ONLY");

                const perTable = {};
                for (const entry of entries) {
                    perTable[entry.table] = await DataPurgeModel._streamRowsOnConnection(
                        conn,
                        entry,
                        { pageSize, onBatch: (rows) => onBatch(entry.table, rows) },
                        "streamAllTables",
                    );
                }
                return perTable;
            });
        } catch (err) {
            // db.withConnection rewraps every callback error into a NEW Error
            // (message via oracleMessages.DB_OP_FAILED) with the original
            // driver error attached as `.originalError` — inspect both so
            // this check survives either shape.
            const original = err?.originalError ?? err;
            const combinedMessage = `${err?.message ?? ""} ${original?.message ?? ""}`;
            const isSnapshotTooOld = original?.errorNum === 1555 || /ORA-01555/.test(combinedMessage);
            if (!isSnapshotTooOld) throw err;

            logger.warning(
                dataPurgeMessages.STREAM_ALL_TABLES_SNAPSHOT_TOO_OLD(
                    entries.map((e) => e.table),
                    original?.message ?? err.message,
                ),
            );

            const snapshotErr = new Error(
                `DataPurgeModel.streamAllTables: ORA-01555 snapshot too old across ${entries.length} table(s) — read-only transaction invalidated mid-read. Caller must fall back to the per-table streamTable() path and mark readConsistent:false.`,
            );
            snapshotErr.code = "ORA_01555_SNAPSHOT_TOO_OLD";
            snapshotErr.isSnapshotTooOld = true;
            snapshotErr.originalError = err;
            throw snapshotErr;
        }
    }

    /**
     * Opens ONE connection and delegates to
     * {@link DataPurgeModel._streamRowsOnConnection} — the single-table entry
     * point behind {@link DataPurgeModel.streamTable} (no filter) and
     * {@link DataPurgeModel.streamTableFiltered} (OR'd equality filter).
     *
     * @param {string} table
     * @param {object} opts
     * @param {number} [opts.pageSize=1000]
     * @param {(rows: object[]) => (Promise<void>|void)} [opts.onBatch]
     * @param {string[]} [opts.whereColumns]
     * @param {string|number} [opts.whereValue]
     * @param {string} callerLabel
     * @returns {Promise<number>}
     * @private
     */
    static async _streamRows(table, opts, callerLabel) {
        const entry = _requireEntry(table, callerLabel);
        // Per-table row stream (used by backup/export) — long-hold read routed
        // to the appDbBulk pool so it never competes with interactive traffic.
        return db.withConnection("appDbBulk", (conn) => DataPurgeModel._streamRowsOnConnection(conn, entry, opts, callerLabel));
    }

    /**
     * The per-table read body shared by every caller that streams table rows
     * on an ALREADY-ACQUIRED connection: {@link DataPurgeModel._streamRows}
     * (opens its own connection, used by `streamTable`/`streamTableFiltered`)
     * and {@link DataPurgeModel.streamAllTables} (opens ONE connection for
     * many tables, inside a single `SET TRANSACTION READ ONLY` transaction).
     * Column-catalog lookup, `TO_CHAR()` identifier handling, CLOB
     * `fetchInfo`, and PK-ordered paging live HERE and only here — do not
     * fork this logic into a second copy; a second copy will drift from this
     * one (see `streamTable`'s doc comment for the full precision rationale).
     *
     * @param {import('oracledb').Connection} conn - Already-acquired connection; this method never opens or closes one.
     * @param {import('../constants/purgeTables').PurgeTableEntry} entry - Already registry-validated by the caller.
     * @param {object} opts
     * @param {number} [opts.pageSize=1000]
     * @param {(rows: object[]) => (Promise<void>|void)} [opts.onBatch]
     * @param {string[]} [opts.whereColumns]
     * @param {string|number} [opts.whereValue]
     * @param {string} callerLabel - Used only in thrown/logged messages.
     * @returns {Promise<number>} Total rows streamed for this table.
     * @private
     */
    static async _streamRowsOnConnection(conn, entry, opts, callerLabel) {
        const outFormat = { outFormat: _db.oracledb.OUT_FORMAT_OBJECT };
        const pageSize = Number.isInteger(opts.pageSize) && opts.pageSize > 0 ? opts.pageSize : 1000;
        const onBatch = typeof opts.onBatch === "function" ? opts.onBatch : () => {};
        const whereColumns = Array.isArray(opts.whereColumns) && opts.whereColumns.length > 0 ? opts.whereColumns : null;
        const whereValue = opts.whereValue;

        const colResult = await conn.execute(
            `SELECT COLUMN_NAME, DATA_TYPE FROM USER_TAB_COLUMNS WHERE TABLE_NAME = :tableName ORDER BY COLUMN_ID`,
            { tableName: entry.table },
            outFormat,
        );
        const columnRows = colResult.rows ?? [];
        if (columnRows.length === 0) {
            throw new Error(
                `DataPurgeModel.${callerLabel}: USER_TAB_COLUMNS returned no columns for "${entry.table}" — verify the app database user (appDb/appDbBulk pools) has read access and the table name is correct.`,
            );
        }
        const columns = columnRows.map((r) => r.COLUMN_NAME);
        const clobColumns = columnRows.filter((r) => r.DATA_TYPE === "CLOB").map((r) => r.COLUMN_NAME);

        // whereColumns is server-code-only input, but validated against the
        // live catalog before being interpolated as a SQL identifier —
        // never trust a hardcoded list to still match the schema (CWE-89
        // defense in depth, same posture as the SELECT list below).
        if (whereColumns) {
            const invalid = whereColumns.filter((c) => !columns.includes(c));
            if (invalid.length > 0) {
                throw new Error(
                    `DataPurgeModel.${callerLabel}: whereColumns [${invalid.join(", ")}] are not columns of "${entry.table}".`,
                );
            }
        }

        const identifierSet = new Set(entry.identifierColumns);
        // Identifiers below are never client input: `entry.table` comes
        // from the purgeTables registry (CWE-89 allow-list) and `columns`
        // come from USER_TAB_COLUMNS — Oracle has no bind-variable syntax
        // for identifiers.
        // Signed TIMESTAMP columns leave Oracle as the canonical FF6 string
        // (a JS Date would drop microseconds and break the ROW_HASH check on restore).
        const canonicalTsSet = new Set(entry.canonicalTimestampColumns ?? []);
        const selectList = columns
            .map((col) => {
                if (canonicalTsSet.has(col)) return `TO_CHAR("${col}",'${CANONICAL_TS_FORMAT}') AS "${col}"`;
                return identifierSet.has(col) ? `TO_CHAR("${col}") AS "${col}"` : `"${col}"`;
            })
            .join(", ");

        // A CLOB column (e.g. SERVER_ALERT_LOG.DETAILS) fetches as a Lob
        // stream by default — JSON.stringify
        // on a Lob object serialises to "{}", silently losing the content.
        // fetchInfo forces the driver to return a plain JS string instead —
        // same sanctioned pattern as serverAlertLog.model.js.
        const fetchInfo = {};
        for (const col of clobColumns) fetchInfo[col] = { type: _db.oracledb.STRING };

        const whereClause = whereColumns ? `WHERE ${whereColumns.map((c) => `"${c}" = :whereValue`).join(" OR ")}` : "";

        let skip = 0;
        let total = 0;

        for (;;) {
            const sql = `
                SELECT ${selectList}
                FROM "${entry.table}"
                ${whereClause}
                ORDER BY "${entry.pk}"
                OFFSET :skip ROWS FETCH NEXT :pageSize ROWS ONLY
            `;
            const binds = whereColumns ? { whereValue, skip, pageSize } : { skip, pageSize };
            const result = await conn.execute(
                sql,
                binds,
                clobColumns.length > 0 ? { ...outFormat, fetchInfo } : outFormat,
            );
            const rows = result.rows ?? [];

            if (rows.length === 0) break;

            await onBatch(rows);
            total += rows.length;
            skip += rows.length;

            if (rows.length < pageSize) break; // last page
        }

        return total;
    }

    // ─── Writes ─────────────────────────────────────────────────────────────

    /**
     * Deletes every row of one table, inside the caller-supplied
     * `Transaction` session — this is DELETE DML, never TRUNCATE
     * (`TRG_SCHEMA_DDL_GUARD` blocks TRUNCATE in production, and DELETE
     * inside a transaction is what makes the whole purge atomically
     * rollback-able). The caller (`DataPurgeService.executePurge`) is
     * responsible for calling this once per table in `purgeTables`'
     * `deleteOrderTier` order, inside one shared `Transaction`.
     *
     * @param {string} table
     * @param {import('../utils/oracle-mongo-wrapper/Transaction').Session} session
     * @param {string} [highWater] - Optional PK high-water; only honoured for `appendOnlyLog` tables (deletes `pk <= hw`, keeps rows appended after the backup).
     * @returns {Promise<number>} Rows deleted from this table.
     * @throws {Error} When `table` is not a registered purge table.
     *
     * @example
     * await txManager.withTransaction(async (session) => {
     *     for (const entry of getDeleteOrder(scope.tables)) {
     *         const n = await DataPurgeModel.deleteTable(entry.table, session);
     *         onStep(entry.table, n);
     *     }
     * });
     */
    static async deleteTable(table, session, highWater) {
        const entry = _requireEntry(table, "deleteTable");
        const result = await session.collection(entry.table).deleteMany(_boundedFilter(entry, highWater));
        return result.deletedCount ?? 0;
    }

    /**
     * Orchestrates a FULL purge of the given tables inside ONE atomic
     * `Transaction` — every table's `deleteTable` call shares the same
     * connection/transaction, so either every table's rows are deleted or
     * (on any failure) none are (a mid-purge failure
     * leaves every table untouched). Deletes in
     * `purgeTables.getDeleteOrder()` order (leaves→roots) —
     * children are always deleted before the parents they reference, so no
     * `ORA-02292` (child record found) is possible mid-purge.
     *
     * Table names are re-validated against the registry here (via
     * `deleteTable` → `_requireEntry`) even though the caller
     * (`DataPurgeService.executePurge`) already validated them through
     * `resolveScope` — defense in depth, never trust a table name has
     * already been checked by the time it reaches the model layer.
     *
     * @param {string[]} tableNames - Table names to purge (already registry-validated by the caller).
     * @param {(table: string, deletedCount: number) => void} [onStep] - Fired after each table's DELETE commits within the transaction (not yet durable — only true after the whole transaction commits).
     * @param {Record<string, string>} [highWater] - Per-table PK high-water from the backup token (append-only log tables only).
     * @returns {Promise<{ totalDeleted: number, perTable: Array<{ table: string, deletedCount: number }> }>}
     * @throws {Error} Propagates any table-level failure — the whole transaction rolls back.
     *
     * @example
     * const { totalDeleted, perTable } = await DataPurgeModel.purgeTables(
     *     scope.tables,
     *     (table, n) => logger.notice(dataPurgeMessages.EXECUTE_TABLE_STEP(table, n)),
     * );
     */
    static async purgeTables(tableNames, onStep = () => {}, highWater = {}) {
        const orderedEntries = getDeleteOrder(tableNames);
        const perTable = [];
        let totalDeleted = 0;

        // Long-hold multi-table purge — routed through the appDbBulk pool so a
        // full purge cannot exhaust the interactive appDb pool.
        const txManager = new Transaction(_bulkDb);
        await txManager.withTransaction(async (session) => {
            for (const entry of orderedEntries) {
                const deletedCount = await DataPurgeModel.deleteTable(entry.table, session, highWater?.[entry.table]);
                perTable.push({ table: entry.table, deletedCount });
                totalDeleted += deletedCount;
                onStep(entry.table, deletedCount);
            }
        });

        return { totalDeleted, perTable };
    }

    /**
     * Inserts one batch of previously-backed-up rows into `table`, INSIDE the
     * caller-supplied `Transaction` session — the restore-side counterpart of
     * `deleteTable`. Every row in `rows` is a plain object
     * exactly as parsed from a backup archive's `data/<TABLE>.jsonl` file.
     *
     * Three things happen here, all driven by the registry entry and a live
     * `USER_TAB_COLUMNS` catalog read (never a hardcoded per-table column
     * list — same reasoning as `streamTable`'s catalog read):
     *
     *   1. **Virtual + identity-PK exclusion** — `entry.virtualColumns`
     *      (`ORA-54013` if inserted) and, when `entry.isIdentity` is true,
     *      `entry.pk` itself (`ORA-32795` if inserted) are dropped from the
     *      insert column list.
     *   2. **Column-type restoration** — a JSONL round-trip loses Oracle's
     *      DATE/TIMESTAMP-ness (ISO-8601 strings) and would otherwise bind a
     *      TIMESTAMP column as a raw VARCHAR2 literal. Columns the catalog
     *      reports as `DATE`/`TIMESTAMP*` are parsed back into JS `Date`
     *      objects (`insertMany` binds a `Date` instance as
     *      `oracledb.DATE`). NUMBER columns NOT in
     *      `entry.identifierColumns` are coerced to a JS `number` (they were
     *      backed up as plain JSON numbers already, so this is normally a
     *      no-op). NUMBER columns that ARE identifier columns
     *      (FK and large-PK columns) are left exactly as backed up — a
     *      STRING of exact digits — and are NEVER passed through `Number()`,
     *      preserving precision beyond `Number.MAX_SAFE_INTEGER` (same
     *      precedent as `streamTable`'s `TO_CHAR` reads on the way OUT).
     *   3. **Per-batch type consistency** — every row in `rows` is typed
     *      identically for a given column (driven by the SAME catalog
     *      lookup), which is what `insertMany`'s first-non-null-sample bind
     *      inference requires to avoid `NJS-011` losing the whole batch.
     *
     * Callers (`DataRestoreService`) are responsible for: applying FK remap
     * to `rows` BEFORE calling this (this method never rewrites a foreign
     * key), restoring tables in `getRestoreOrder()` order, and re-signing
     * ROW_HASH afterward via `TamperDetectionService.buildSignedFields` +
     * `CryptoVault.signRecord` using the `returning` values this method
     * hands back.
     *
     * @param {string} table
     * @param {object[]} rows - Already FK-remapped rows for this table, in the exact order they should be inserted.
     * @param {import('../utils/oracle-mongo-wrapper/Transaction').Session} session
     * @returns {Promise<{ insertedCount: number, returning: Array<Record<string, number>> }>}
     *   `returning` is `[]` when `entry.isIdentity` is false (the table's
     *   primary key is natural and was inserted as backed up — there is
     *   nothing new to learn back). When `entry.isIdentity` is true,
     *   `returning[i][entry.pk]` is the NEW identity value assigned to
     *   `rows[i]`, in the same order as `rows`.
     * @throws {Error} When `table` is not a registered purge table, or when
     *   `USER_TAB_COLUMNS` returns no columns for it.
     *
     * @example
     * const { insertedCount, returning } = await DataPurgeModel.insertRestoreBatch(
     *     "T_SERVER_ALERT_LOG_DEV",
     *     remappedRows,
     *     session,
     * );
     * // returning[i].ID -> the NEW identity value Oracle assigned to remappedRows[i]
     */
    static async insertRestoreBatch(table, rows, session) {
        const entry = _requireEntry(table, "insertRestoreBatch");
        if (!Array.isArray(rows) || rows.length === 0) {
            return { insertedCount: 0, returning: [] };
        }

        const outFormat = { outFormat: _db.oracledb.OUT_FORMAT_OBJECT };
        const colResult = await session.execute(
            `SELECT COLUMN_NAME, DATA_TYPE FROM USER_TAB_COLUMNS WHERE TABLE_NAME = :tableName`,
            { tableName: entry.table },
            outFormat,
        );
        const columnRows = colResult.rows ?? [];
        if (columnRows.length === 0) {
            throw new Error(
                `DataPurgeModel.insertRestoreBatch: USER_TAB_COLUMNS returned no columns for "${entry.table}" — verify the app database user (appDb/appDbBulk pools) has read access and the table name is correct.`,
            );
        }
        const typeByCol = new Map(columnRows.map((r) => [r.COLUMN_NAME, r.DATA_TYPE]));

        const virtualSet = new Set(entry.virtualColumns);
        const identifierSet = new Set(entry.identifierColumns);
        const skipPk = entry.isIdentity;

        const insertRows = rows.map((row) => {
            const out = {};
            for (const col of Object.keys(row)) {
                if (virtualSet.has(col)) continue; // ORA-54013 guard — never insert into a virtual column
                if (skipPk && col === entry.pk) continue; // ORA-32795 guard — never insert into an identity PK
                if (!typeByCol.has(col)) continue; // defensive: ignore an archived field that no longer exists as a live column

                const rawVal = row[col];
                if (rawVal === null || rawVal === undefined) {
                    out[col] = null;
                    continue;
                }

                const dataType = typeByCol.get(col);
                if (dataType === "DATE" || (typeof dataType === "string" && dataType.startsWith("TIMESTAMP"))) {
                    // A canonical FF6 string ("2026-10-06T12:34:56.123456", no zone) parses as local time, like the driver binds it.
                    out[col] = new Date(rawVal);
                } else if (dataType === "NUMBER" && !identifierSet.has(col)) {
                    out[col] = typeof rawVal === "number" ? rawVal : Number(rawVal);
                } else {
                    // Identifier NUMBER columns (exact-digit strings) and
                    // VARCHAR2/CHAR/CLOB columns are inserted exactly as
                    // backed up — never Number()'d.
                    out[col] = rawVal;
                }
            }
            return out;
        });

        // insertMany requires every row to share the exact same key set (the
        // FIRST row's keys define the INSERT column list) — a row missing an
        // optional/nullable column (e.g. a nullable FK that happened to be
        // NULL and therefore never appeared as a JSONL key) is backfilled
        // with an explicit null rather than silently shifting columns.
        const allCols = [...new Set(insertRows.flatMap((r) => Object.keys(r)))];
        for (const r of insertRows) {
            for (const c of allCols) if (!(c in r)) r[c] = null;
        }

        const returningCols = skipPk ? [entry.pk] : [];
        const result = await session.collection(entry.table).insertMany(insertRows, { returning: returningCols });

        return {
            insertedCount: result.insertedCount ?? 0,
            returning: result.returning ?? [],
        };
    }

    // ─── Restore pre-flight support ─────────────────────────────────────────

    /**
     * Returns whether a row with `keyColumn = keyValue` already exists in
     * `table` — the ENTITY-kind restore pre-flight check: "only
     * that key must be absent". `keyColumn` MUST be exactly the table's own
     * registered primary key (`entry.pk`) — this is a hard requirement, not
     * a convenience default, because `keyColumn` ultimately originates from
     * an UNTRUSTED archive manifest, and accepting an arbitrary column name
     * here would let a crafted manifest probe arbitrary columns (including
     * sensitive ones) via this existence check.
     *
     * @param {string} table
     * @param {string} keyColumn - MUST equal the registered entry's `pk`.
     * @param {string|number} keyValue
     * @returns {Promise<boolean>}
     * @throws {Error} When `table` is not registered, or `keyColumn` is not that table's own primary key.
     *
     * @example
     * const exists = await DataPurgeModel.existsByKey("T_SERVER_ALERT_LOG_DEV", "ID", 10234);
     */
    static async existsByKey(table, keyColumn, keyValue) {
        const entry = _requireEntry(table, "existsByKey");
        if (keyColumn !== entry.pk) {
            throw new Error(
                `DataPurgeModel.existsByKey: keyColumn "${keyColumn}" is not the registered primary key ("${entry.pk}") of "${entry.table}" — refusing an arbitrary column lookup.`,
            );
        }
        const col = new OracleCollection(entry.table, _db);
        const row = await col.findOne({ [keyColumn]: keyValue });
        return row != null;
    }
}

module.exports = DataPurgeModel;
