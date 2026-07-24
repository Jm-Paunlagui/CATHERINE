"use strict";

/**
 * @fileoverview ServerAlertLogModel — alert / notification history.
 *
 * TABLE NAME (dynamic): `SERVER_ALERT_LOG_TABLE` env var when set; otherwise
 * `T_SERVER_ALERT_LOG` in production and `T_SERVER_ALERT_LOG_DEV` everywhere
 * else — the same resolution rule the audit-log model uses.
 *
 * WHAT THIS FILE DOES
 * -------------------
 * Thin data-access layer over the alert-history table. Append-only: rows are
 * written by `AlertNotifierService` on state TRANSITIONS and email outcomes,
 * never on every poll tick. The live "current alerts" list is always recomputed
 * from `MetricsService.evaluateAlerts()` — this table is history and audit only.
 *
 * WHY IT BYPASSES OracleCollection
 * --------------------------------
 * One column needs special handling: `DETAILS` is a CLOB holding a sanitised
 * JSON cause payload that can reach 64 KB — past the ~32767-byte ceiling
 * node-oracledb applies to an auto-inferred VARCHAR2 bind. `OracleCollection`
 * infers bind types from plain JS values and would mis-bind (or silently
 * truncate) a value that large, so this file goes through `db.withConnection()`
 * — the sanctioned raw-connection surface — and binds `DETAILS` explicitly as
 * `{ type: db.oracledb.CLOB }`, reading it back with
 * `fetchInfo: { DETAILS: { type: db.oracledb.STRING } }` so callers always get
 * a plain string rather than a Lob stream. Every other column still flows
 * through ordinary named bind variables: only the CLOB TYPE is explicit, so
 * SQL-injection exposure (CWE-89) is unchanged.
 *
 * In DEMO_MODE nothing touches Oracle — rows live in a capped in-memory ring so
 * the alert-history UI renders with no database.
 *
 * HOW IT WORKS
 * ------------
 *   - insertOne(row)          — single-row insert; throws so the caller can
 *                               decide (AlertNotifierService owns the retry
 *                               and queueing layer on top of this).
 *   - findPage(filters, opts) — offset pagination (OFFSET/FETCH NEXT), capped
 *                               at 200 rows/page, DETAILS parsed back to an object.
 *   - findRecent(limit)       — most recent N rows (status endpoint's
 *                               "recent sends" view).
 *   - purgeOlderThan(days)    — retention purge (ALERT_LOG_RETENTION_DAYS).
 *
 * EXAMPLE
 * -------
 *   const ServerAlertLogModel = require("./serverAlertLog.model");
 *   await ServerAlertLogModel.insertOne({
 *       alertKey: "HIGH_HEAP::global", rule: "HIGH_HEAP", severity: "CRITICAL",
 *       transition: "FIRED", valueNum: 0.928, description: "Heap at 92.8%",
 *       channel: "server-system-notification", notificationId: "NTF-123",
 *       emailStatus: "SENT", emailError: null,
 *       details: { value: 0.928, snapshot: { heapUsedMb: 1900 } },
 *   });
 *   const { rows, total } = await ServerAlertLogModel.findPage(
 *       { rule: "HIGH_HEAP" }, { page: 1, limit: 50 },
 *   );
 */

const { createDb } = require("../utils/oracle-mongo-wrapper");
const { isDemoMode } = require("../config/demoMode");

/** @returns {string} Resolved table name (env override or NODE_ENV default). */
function resolveTableName() {
    if (process.env.SERVER_ALERT_LOG_TABLE)
        return process.env.SERVER_ALERT_LOG_TABLE;
    return process.env.NODE_ENV === "production"
        ? "T_SERVER_ALERT_LOG"
        : "T_SERVER_ALERT_LOG_DEV";
}

let _db = null;
/** Lazily resolves the appDb handle (never called in DEMO_MODE). */
function db() {
    if (!_db) _db = createDb("appDb");
    return _db;
}

/** Max rows returned per page — a hard ceiling, not a default. */
const MAX_PAGE_LIMIT = 200;
const DEFAULT_PAGE_LIMIT = 50;

/** Rows retained by the DEMO_MODE ring buffer before the oldest are dropped. */
const DEMO_MAX_ROWS = 500;

/** @type {object[]} DEMO_MODE store, newest last. */
const _demoRows = [];
let _demoNextId = 1;

const SELECT_COLUMNS = `
    ID, ALERT_KEY, RULE, SEVERITY, TRANSITION, VALUE_NUM, DESCRIPTION,
    CHANNEL, NOTIFICATION_ID, EMAIL_STATUS, EMAIL_ERROR, DETAILS, CREATED_AT
`;

/**
 * Best-effort parse of a DETAILS JSON string. Never throws — a malformed or
 * missing value degrades to `null` rather than failing the whole read.
 * @param {string|null} raw
 * @returns {object|null}
 */
function parseDetails(raw) {
    if (raw == null) return null;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

/**
 * Builds a `{ whereSql, binds }` pair from history filters. Column names are
 * fixed literals (never interpolated); only VALUES flow through bind variables.
 * @param {{ rule?: string, severity?: string, from?: Date, to?: Date }} [filters]
 * @returns {{ whereSql: string, binds: object }}
 */
function buildWhere(filters = {}) {
    const clauses = [];
    const binds = {};
    if (filters.rule) {
        clauses.push("RULE = :rule");
        binds.rule = filters.rule;
    }
    if (filters.severity) {
        clauses.push("SEVERITY = :severity");
        binds.severity = filters.severity;
    }
    if (filters.from instanceof Date) {
        clauses.push("CREATED_AT >= :fromDate");
        binds.fromDate = filters.from;
    }
    if (filters.to instanceof Date) {
        clauses.push("CREATED_AT <= :toDate");
        binds.toDate = filters.to;
    }
    return {
        whereSql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
        binds,
    };
}

/** Applies the same filters to the DEMO_MODE array. */
function demoFilter(filters = {}) {
    return _demoRows.filter((r) => {
        if (filters.rule && r.RULE !== filters.rule) return false;
        if (filters.severity && r.SEVERITY !== filters.severity) return false;
        if (filters.from instanceof Date && r.CREATED_AT < filters.from)
            return false;
        if (filters.to instanceof Date && r.CREATED_AT > filters.to)
            return false;
        return true;
    });
}

class ServerAlertLogModel {
    /**
     * Inserts one alert-log row. Never retried here — best-effort queueing and
     * retry-on-recovery is `AlertNotifierService`'s responsibility; this method
     * either succeeds or throws so the caller can decide.
     *
     * @param {object} row
     * @param {string} row.alertKey - Identity key, e.g. "HIGH_HEAP::global" or "critical-log"
     * @param {string} row.rule - Alert rule identifier, or the log level for critical events
     * @param {"WARNING"|"CRITICAL"|"RESOLVED"} row.severity
     * @param {"FIRED"|"ESCALATED"|"RENOTIFIED"|"RECOVERED"|"SUPPRESSED"} row.transition
     * @param {number|null} [row.valueNum]
     * @param {string|null} [row.description]
     * @param {string} row.channel
     * @param {string|null} [row.notificationId]
     * @param {"SENT"|"FAILED"|"SKIPPED"|"DISABLED"} row.emailStatus
     * @param {string|null} [row.emailError]
     * @param {object|null} [row.details] - Already-sanitised object; JSON-stringified here
     * @returns {Promise<void>}
     */
    static async insertOne(row) {
        const record = {
            alertKey: String(row.alertKey ?? "").slice(0, 200),
            rule: String(row.rule ?? "").slice(0, 64),
            severity: row.severity,
            transition: row.transition,
            valueNum: row.valueNum ?? null,
            description:
                row.description != null
                    ? String(row.description).slice(0, 1000)
                    : null,
            channel: String(row.channel ?? "").slice(0, 64),
            notificationId: row.notificationId ?? null,
            emailStatus: row.emailStatus,
            emailError:
                row.emailError != null
                    ? String(row.emailError).slice(0, 1000)
                    : null,
        };

        if (isDemoMode()) {
            _demoRows.push({
                ID: _demoNextId++,
                ALERT_KEY: record.alertKey,
                RULE: record.rule,
                SEVERITY: record.severity,
                TRANSITION: record.transition,
                VALUE_NUM: record.valueNum,
                DESCRIPTION: record.description,
                CHANNEL: record.channel,
                NOTIFICATION_ID: record.notificationId,
                EMAIL_STATUS: record.emailStatus,
                EMAIL_ERROR: record.emailError,
                DETAILS: row.details ?? null,
                CREATED_AT: new Date(),
            });
            if (_demoRows.length > DEMO_MAX_ROWS)
                _demoRows.splice(0, _demoRows.length - DEMO_MAX_ROWS);
            return;
        }

        const handle = db();
        return handle.withConnection(async (conn) => {
            await conn.execute(
                `INSERT INTO ${resolveTableName()} (
                     ALERT_KEY, RULE, SEVERITY, TRANSITION, VALUE_NUM, DESCRIPTION,
                     CHANNEL, NOTIFICATION_ID, EMAIL_STATUS, EMAIL_ERROR, DETAILS
                 ) VALUES (
                     :alertKey, :rule, :severity, :transition, :valueNum, :description,
                     :channel, :notificationId, :emailStatus, :emailError, :details
                 )`,
                {
                    ...record,
                    details: {
                        val:
                            row.details != null
                                ? JSON.stringify(row.details)
                                : null,
                        type: handle.oracledb.CLOB,
                    },
                },
                { autoCommit: true },
            );
        });
    }

    /**
     * Offset-paginated history read (OFFSET/FETCH NEXT). DETAILS is parsed back
     * to a JS object for every row.
     *
     * @param {{ rule?: string, severity?: string, from?: Date, to?: Date }} [filters]
     * @param {{ page?: number, limit?: number }} [opts]
     * @returns {Promise<{ rows: object[], total: number, page: number, limit: number }>}
     */
    static async findPage(filters = {}, opts = {}) {
        const page = Math.max(1, Number(opts.page) || 1);
        const limit = Math.min(
            MAX_PAGE_LIMIT,
            Math.max(1, Number(opts.limit) || DEFAULT_PAGE_LIMIT),
        );
        const skip = (page - 1) * limit;

        if (isDemoMode()) {
            const matched = demoFilter(filters).sort(
                (a, b) => b.CREATED_AT - a.CREATED_AT || b.ID - a.ID,
            );
            return {
                rows: matched.slice(skip, skip + limit),
                total: matched.length,
                page,
                limit,
            };
        }

        const { whereSql, binds } = buildWhere(filters);
        const handle = db();
        const table = resolveTableName();

        return handle.withConnection(async (conn) => {
            const countResult = await conn.execute(
                `SELECT COUNT(*) AS CNT FROM ${table} ${whereSql}`,
                binds,
                { outFormat: handle.oracledb.OUT_FORMAT_OBJECT },
            );
            const total = Number(countResult.rows[0]?.CNT ?? 0);

            const rowsResult = await conn.execute(
                `SELECT ${SELECT_COLUMNS}
                 FROM ${table}
                 ${whereSql}
                 ORDER BY CREATED_AT DESC, ID DESC
                 OFFSET :skip ROWS FETCH NEXT :fetchLimit ROWS ONLY`,
                { ...binds, skip, fetchLimit: limit },
                {
                    outFormat: handle.oracledb.OUT_FORMAT_OBJECT,
                    fetchInfo: { DETAILS: { type: handle.oracledb.STRING } },
                },
            );

            const rows = (rowsResult.rows ?? []).map((r) => ({
                ...r,
                DETAILS: parseDetails(r.DETAILS),
            }));

            return { rows, total, page, limit };
        });
    }

    /**
     * Returns the most recent `limit` rows (newest first) — backs the status
     * endpoint's "recent sends" view.
     *
     * @param {number} [limit=20]
     * @returns {Promise<object[]>}
     */
    static async findRecent(limit = 20) {
        const { rows } = await ServerAlertLogModel.findPage(
            {},
            { page: 1, limit },
        );
        return rows;
    }

    /**
     * Deletes every row older than `days` days (retention purge).
     *
     * @param {number} days
     * @returns {Promise<number>} Rows deleted
     */
    static async purgeOlderThan(days) {
        const cutoffDays = Math.max(1, Number(days) || 180);

        if (isDemoMode()) {
            const cutoff = Date.now() - cutoffDays * 86_400_000;
            const before = _demoRows.length;
            for (let i = _demoRows.length - 1; i >= 0; i--) {
                if (_demoRows[i].CREATED_AT.getTime() < cutoff)
                    _demoRows.splice(i, 1);
            }
            return before - _demoRows.length;
        }

        return db().withConnection(async (conn) => {
            const result = await conn.execute(
                `DELETE FROM ${resolveTableName()} WHERE CREATED_AT < SYSTIMESTAMP - :cutoffDays`,
                { cutoffDays },
                { autoCommit: true },
            );
            return result.rowsAffected ?? 0;
        });
    }
}

module.exports = ServerAlertLogModel;
module.exports.resolveTableName = resolveTableName;
