"use strict";

/**
 * @fileoverview AuditLogModel — per-request audit trail.
 *
 * TABLE NAME (dynamic): `AUDIT_LOG_TABLE` env var when set; otherwise
 * `T_AUDIT_LOGS` in production and `T_AUDIT_LOGS_DEV` everywhere else.
 *
 * STORAGE ROUTING (`AUDIT_LOG_STORAGE` env var):
 *   - `db`   — always Oracle (throws on failure, current classic behavior).
 *   - `file` — always the JSON-lines text fallback (audit.log.file.model.js,
 *              `logs/Main/YYYY/MM/DD/audit.log`).
 *   - `auto` — (default) writes try Oracle first; on the FIRST write failure
 *              (missing table, pool down, any DB-layer error) the model
 *              silently and permanently switches to the file fallback for
 *              the rest of the process lifetime, and the failed batch is
 *              re-routed to the file so no record is lost. Restart the
 *              process to retry Oracle.
 *
 * Read/query methods route the same way — in file mode they return the file
 * model's empty stub shapes (a flat text file is not queryable).
 *
 * In DEMO_MODE every method reads/writes the in-memory demo store; no Oracle
 * connection is opened. In normal mode the model uses the `appDb` connection.
 */

const { createDb, OracleCollection } = require("../utils/oracle-mongo-wrapper");
const { isDemoMode } = require("../config/demoMode");
const demo = require("./demo/demoStore");
const AuditLogFileModel = require("./audit.log.file.model");

/** @returns {string} Resolved audit table name (env override or NODE_ENV default). */
function resolveTableName() {
    if (process.env.AUDIT_LOG_TABLE) return process.env.AUDIT_LOG_TABLE;
    return process.env.NODE_ENV === "production"
        ? "T_AUDIT_LOGS"
        : "T_AUDIT_LOGS_DEV";
}

let _col = null;
/** Lazily resolves the audit-table collection (never called in DEMO_MODE / file mode). */
function col() {
    if (!_col) _col = new OracleCollection(resolveTableName(), createDb("appDb"));
    return _col;
}

/**
 * Storage-mode state machine:
 *   "db"           — AUDIT_LOG_STORAGE=db (Oracle only, failures propagate)
 *   "file"         — AUDIT_LOG_STORAGE=file (file only)
 *   "auto-pending" — AUDIT_LOG_STORAGE=auto, Oracle not yet known-bad
 *   "auto-file"    — auto mode after an Oracle write failure (permanent for
 *                    the process lifetime; the switch is silent by design)
 */
let _storageMode = null;

function storageMode() {
    if (_storageMode === null) {
        const raw = (process.env.AUDIT_LOG_STORAGE || "auto").toLowerCase();
        if (raw === "db") _storageMode = "db";
        else if (raw === "file") _storageMode = "file";
        else _storageMode = "auto-pending";
    }
    return _storageMode;
}

/** @returns {boolean} True when reads/writes should hit the file model. */
function useFile() {
    const mode = storageMode();
    return mode === "file" || mode === "auto-file";
}

/**
 * Runs an Oracle write, downgrading auto mode to the file fallback on
 * failure. In `db` mode the error propagates untouched.
 *
 * @template T
 * @param {() => Promise<T>} dbWrite - The Oracle write to attempt.
 * @param {() => Promise<T>} fileWrite - Re-routes the same payload to the file model.
 * @returns {Promise<T>}
 */
async function writeWithFallback(dbWrite, fileWrite) {
    if (useFile()) return fileWrite();
    try {
        return await dbWrite();
    } catch (err) {
        if (storageMode() !== "auto-pending") throw err;
        // Silent, permanent downgrade (per template design decision): the
        // deployment has no usable audit table — every subsequent record
        // goes to logs/Main so nothing is lost.
        _storageMode = "auto-file";
        return fileWrite();
    }
}

/** Test-only escape hatch — resets the lazily-resolved storage mode + collection. */
function _resetStorageForTests() {
    _storageMode = null;
    _col = null;
}

class AuditLogModel {
    static async insert(record) {
        if (isDemoMode()) return demo.auditInsert(record);
        return writeWithFallback(
            () => col().insertOne(record),
            () => AuditLogFileModel.insert(record),
        );
    }

    /**
     * Bulk-inserts buffered audit records in one Oracle executeMany round-trip.
     * All records must share the same column set (guaranteed by
     * AuditLogMiddleware._buildRecord, the single producer).
     *
     * @param {object[]} records
     * @returns {Promise<object>} insertMany result
     */
    static async insertBatch(records) {
        if (isDemoMode()) {
            for (const r of records) demo.auditInsert(r);
            return { rowsAffected: records.length };
        }
        return writeWithFallback(
            () => col().insertMany(records),
            () => AuditLogFileModel.insertBatch(records),
        );
    }

    static async findPaginated(filter, page, pageSize) {
        if (isDemoMode()) {
            const all = demo.auditLogs().filter((r) => demo.match(r, filter));
            all.sort((a, b) => new Date(b.CREATED_AT) - new Date(a.CREATED_AT));
            return all.slice((page - 1) * pageSize, page * pageSize);
        }
        if (useFile()) return AuditLogFileModel.findPaginated(filter, page, pageSize);
        return col()
            .find(filter)
            .sort({ CREATED_AT: -1 })
            .skip((page - 1) * pageSize)
            .limit(pageSize)
            .toArray();
    }

    static async countTotal(filter) {
        if (isDemoMode()) {
            return demo.auditLogs().filter((r) => demo.match(r, filter)).length;
        }
        if (useFile()) return AuditLogFileModel.countTotal(filter);
        return col().find(filter).count();
        // .count() is the terminal method on QueryBuilder — NOT countDocuments()
    }

    /**
     * Permanently delete all audit log records matching the supplied filter.
     *
     * @param {object} filter - oracle-mongo-wrapper filter object.
     * @returns {Promise<object>} Raw oracle-mongo-wrapper deleteMany result.
     */
    static async deleteMany(filter) {
        if (isDemoMode()) {
            const logs = demo.auditLogs();
            const before = logs.length;
            const keep = logs.filter((r) => !demo.match(r, filter));
            logs.length = 0;
            logs.push(...keep);
            return { rowsAffected: before - keep.length };
        }
        if (useFile()) return AuditLogFileModel.deleteMany(filter);
        return col().deleteMany(filter);
    }

    /**
     * Returns the epoch-millisecond timestamp of the most recent audit log record.
     * Used by the SSE poller to detect new records without a full COUNT(*).
     * O(log n) via descending index scan on CREATED_AT.
     *
     * No user input flows into this query — the filter is a constant empty object,
     * so there are no bind variables and no injection surface.
     *
     * @returns {Promise<number>} Epoch ms of latest CREATED_AT, or 0 if table is empty.
     */
    static async getLatestCreatedAt() {
        if (isDemoMode()) {
            const logs = demo.auditLogs();
            if (logs.length === 0) return 0;
            return Math.max(
                ...logs.map((r) => new Date(r.CREATED_AT).getTime()),
            );
        }
        if (useFile()) return AuditLogFileModel.getLatestCreatedAt();
        const rows = await col()
            .find({})
            .sort({ CREATED_AT: -1 })
            .limit(1)
            .toArray();
        return rows.length > 0 ? new Date(rows[0].CREATED_AT).getTime() : 0;
    }

    static async aggregate(matchFilter) {
        if (!isDemoMode() && useFile()) {
            return AuditLogFileModel.aggregate(matchFilter);
        }
        // Total + per-category counts are derived from ONE GROUP BY STATUS_CATEGORY
        // pass so they always reconcile (total === sum of all category buckets).
        const { $or: _ignored, ...dateOnlyFilter } = matchFilter;
        const uniqueUserFilter = { ...dateOnlyFilter, USER_ID: { $gt: 0 } };

        let byCategory, uniqueUserRows;

        if (isDemoMode()) {
            // ── In-memory aggregation for demo mode ─────────────────────────────
            const logs = demo.auditLogs();
            const matched = logs.filter((r) => demo.match(r, matchFilter));
            const catMap = {};
            for (const r of matched) {
                const cat = r.STATUS_CATEGORY ?? "";
                if (!catMap[cat])
                    catMap[cat] = { STATUS_CATEGORY: cat, CNT: 0, RESPTIME: 0 };
                catMap[cat].CNT += 1;
                catMap[cat].RESPTIME += r.RESPONSE_TIME_MS ?? 0;
            }
            byCategory = Object.values(catMap);

            const userMatched = logs.filter((r) =>
                demo.match(r, uniqueUserFilter),
            );
            const userSet = new Set();
            for (const r of userMatched) userSet.add(r.USER_ID);
            uniqueUserRows = [...userSet].map((id) => ({ USER_ID: id, N: 1 }));
        } else {
            [byCategory, uniqueUserRows] = await Promise.all([
                col().aggregate([
                    { $match: matchFilter },
                    {
                        $group: {
                            _id: "$STATUS_CATEGORY",
                            CNT: { $sum: 1 },
                            RESPTIME: { $sum: "$RESPONSE_TIME_MS" },
                        },
                    },
                ]),
                col().aggregate([
                    { $match: uniqueUserFilter },
                    { $group: { _id: "$USER_ID", N: { $sum: 1 } } },
                ]),
            ]);
        }

        const stats = AuditLogModel._reduceCategoryGroups(byCategory);

        return {
            total: stats.total,
            success: stats.buckets["2xx"],
            redirect: stats.buckets["3xx"],
            clientError: stats.buckets["4xx"],
            serverError: stats.buckets["5xx"],
            uniqueUsers: (uniqueUserRows ?? []).length,
            avgResponseTime:
                stats.total > 0
                    ? Math.round(stats.totalRespTime / stats.total)
                    : 0,
        };
    }

    /**
     * Reduce the rows of a `GROUP BY STATUS_CATEGORY` aggregate into a total,
     * total response time, and per-category counts. Pure function — no DB access,
     * so the reconciliation guarantee (total === Σ buckets + uncategorised) is
     * unit-testable in isolation.
     *
     * Rows whose STATUS_CATEGORY is null/blank or outside 2xx–5xx still count
     * toward `total` but match no bucket, so an inflated total (total > Σ known
     * buckets) is a visible signal of uncategorised audit rows rather than a
     * silently dropped request.
     *
     * @param {Array<{ STATUS_CATEGORY?: string, CNT?: number, RESPTIME?: number }>} rows
     * @returns {{ total: number, totalRespTime: number, buckets: { '2xx': number, '3xx': number, '4xx': number, '5xx': number } }}
     */
    static _reduceCategoryGroups(rows) {
        const buckets = { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 };
        let total = 0;
        let totalRespTime = 0;

        for (const r of rows ?? []) {
            const count = Number(r.CNT) || 0;
            total += count;
            totalRespTime += Number(r.RESPTIME) || 0;

            // Trim guards against CHAR-padded columns ('4xx   ' !== '4xx').
            const cat = (r.STATUS_CATEGORY ?? "").trim();
            if (Object.prototype.hasOwnProperty.call(buckets, cat)) {
                buckets[cat] += count;
            }
        }

        return { total, totalRespTime, buckets };
    }

    /**
     * Diagnostics — the effective storage mode ("db" | "file" |
     * "auto-pending" | "auto-file") and resolved table name.
     *
     * @returns {{mode: string, table: string}}
     */
    static storageInfo() {
        return { mode: storageMode(), table: resolveTableName() };
    }
}

module.exports = AuditLogModel;
module.exports._resetStorageForTests = _resetStorageForTests;
