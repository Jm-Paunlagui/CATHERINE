"use strict";

/**
 * @fileoverview AuditLogModel — per-request audit trail (T_AUDIT_LOGS).
 *
 * In DEMO_MODE every method reads/writes the in-memory demo store; no Oracle
 * connection is opened. In normal mode the model uses the `appDb` connection.
 */

const { createDb, OracleCollection } = require("../utils/oracle-mongo-wrapper");
const { isDemoMode } = require("../config/demoMode");
const demo = require("./demo/demoStore");

let _col = null;
/** Lazily resolves the T_AUDIT_LOGS collection (never called in DEMO_MODE). */
function col() {
    if (!_col) _col = new OracleCollection("T_AUDIT_LOGS", createDb("appDb"));
    return _col;
}

class AuditLogModel {
    static async insert(record) {
        if (isDemoMode()) return demo.auditInsert(record);
        return col().insertOne(record);
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
        return col().insertMany(records);
    }

    static async findPaginated(filter, page, pageSize) {
        if (isDemoMode()) {
            const all = demo.auditLogs().filter((r) => demo.match(r, filter));
            all.sort((a, b) => new Date(b.CREATED_AT) - new Date(a.CREATED_AT));
            return all.slice((page - 1) * pageSize, page * pageSize);
        }
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
        const rows = await col()
            .find({})
            .sort({ CREATED_AT: -1 })
            .limit(1)
            .toArray();
        return rows.length > 0 ? new Date(rows[0].CREATED_AT).getTime() : 0;
    }

    static async aggregate(matchFilter) {
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
}

module.exports = AuditLogModel;
