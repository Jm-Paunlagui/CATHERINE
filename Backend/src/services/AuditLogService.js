"use strict";

const fs = require("fs").promises;
const path = require("path");

const { logger } = require("../utils/logger");
const { AppError, AUDIT_LOG_ERRORS } = require("../constants/errors");
const { auditLogMessages } = require("../constants/messages");
const AuditLogModel = require("../models/audit.log.model");

/**
 * Log directory base — MUST match logger.js's LOG_BASE_DIR resolution: in
 * compiled (pkg) builds logs live NEXT TO THE EXE (a Windows service may
 * start with cwd = System32); in normal Node they live under the cwd.
 * Reading from process.cwd() here while the logger writes next to the exe
 * would make audit-log reads/exports silently target an empty directory.
 */
const LOG_BASE_DIR = process.pkg
    ? path.join(path.dirname(process.execPath), "logs")
    : path.join(process.cwd(), "logs");

/**
 * RFC 5424 level-file names → canonical level name. Legacy `warn.log`
 * (pre-v5 logger) normalizes to WARNING, same as the current `warning.log`.
 * Shared with `SystemLogTailService` (the live-tail poller) so both the
 * browse endpoint and the SSE stream agree on level naming.
 */
const SYSTEM_LOG_LEVEL_NAMES = Object.freeze({
    emergency: "EMERGENCY",
    alert: "ALERT",
    critical: "CRITICAL",
    error: "ERROR",
    warning: "WARNING",
    warn: "WARNING",
    notice: "NOTICE",
    info: "INFO",
    debug: "DEBUG",
});

/** RFC 5424 numeric priority per canonical level name (0 = highest). */
const SYSTEM_LOG_PRIORITY = Object.freeze({
    EMERGENCY: 0,
    ALERT: 1,
    CRITICAL: 2,
    ERROR: 3,
    WARNING: 4,
    NOTICE: 5,
    INFO: 6,
    DEBUG: 7,
});

/** Matches every RFC 5424 level filename, including legacy `warn.log` and `_N` rotation suffixes. */
const SYSTEM_LOG_FILENAME_RE =
    /^(emergency|alert|critical|error|warning|warn|notice|info|debug)(_\d+)?\.log$/;

/** Default tail-window read size per file (bytes) — overridable via SYSTEM_LOG_MAX_READ_BYTES. */
const DEFAULT_SYSTEM_LOG_MAX_READ_BYTES = 5 * 1024 * 1024;

/** 'YYYY-MM-DD' for the current date in Asia/Manila, independent of server process TZ. */
function _todayManilaDateStr() {
    const fmt = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Manila",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    });
    return fmt.format(new Date());
}

// Lazy-loaded to avoid hard dependency at startup
let _ExcelJS = null;
let _archiverMod = null;

const _getExcelJS = () => {
    if (!_ExcelJS) _ExcelJS = require("exceljs");
    return _ExcelJS;
};
const _getArchiver = () => {
    if (!_archiverMod) _archiverMod = require("archiver");
    return _archiverMod;
};

class AuditLogService {
    // Read-only accessor for the module-level LOG_BASE_DIR constant — exposed
    // so SystemLogTailService (the SSE live-tail poller) can default its own
    // `logBaseDir` override to the exact same directory the browse endpoint
    // reads from, without any code being able to accidentally repoint every
    // log read in the process by assigning to it. Deliberately a GETTER with
    // no setter: under "use strict" (top of this file) an assignment attempt
    // now throws instead of silently no-op'ing. `getSystemLogs` — previously
    // the one method that re-read this on every call — now takes its own
    // `logBaseDir` parameter instead (see below); tests point that ONE method
    // at a fixture directory by passing `{ logBaseDir }`, never by mutating a
    // process-wide global.
    static get LOG_BASE_DIR() {
        return LOG_BASE_DIR;
    }
    static SYSTEM_LOG_LEVEL_NAMES = SYSTEM_LOG_LEVEL_NAMES;
    static SYSTEM_LOG_PRIORITY = SYSTEM_LOG_PRIORITY;
    static SYSTEM_LOG_FILENAME_RE = SYSTEM_LOG_FILENAME_RE;

    // ─── Batched fire-and-forget persistence ────────────────────────────────────
    // One INSERT per HTTP request meant a burst of N concurrent requests issued
    // N additional Oracle round-trips, competing with the actual read queries for
    // pool connections and libuv worker threads. Records are buffered and flushed
    // as a single executeMany batch (oracle-mongo-wrapper insertMany) when the
    // buffer reaches FLUSH_MAX or FLUSH_INTERVAL_MS elapses — whichever is first.
    // The timer is unref()'d so an idle buffer never holds the process open;
    // gracefulShutdown calls flushPending() so rows are not lost on SIGTERM.

    /** Max buffered records before an immediate flush. */
    static FLUSH_MAX = 25;

    /** Max milliseconds a record may wait in the buffer. */
    static FLUSH_INTERVAL_MS = 1000;

    /** @type {object[]} */
    static _pending = [];

    /** @type {NodeJS.Timeout|null} */
    static _flushTimer = null;

    /**
     * Fire-and-forget audit log insert. Never throws — all errors are swallowed
     * with a warning log so a DB hiccup never disrupts the HTTP response.
     * Records are batched; see flushPending().
     *
     * @param {object} record - The audit log record to persist.
     * @returns {Promise<void>}
     */
    static async insertAsync(record) {
        AuditLogService._pending.push(record);

        if (AuditLogService._pending.length >= AuditLogService.FLUSH_MAX) {
            return AuditLogService.flushPending();
        }

        if (!AuditLogService._flushTimer) {
            AuditLogService._flushTimer = setTimeout(
                () => AuditLogService.flushPending(),
                AuditLogService.FLUSH_INTERVAL_MS,
            );
            AuditLogService._flushTimer.unref();
        }
    }

    /**
     * Flushes all buffered audit records in one executeMany batch. Never throws.
     * Called automatically by insertAsync (size/interval triggers) and by
     * server.js during graceful shutdown.
     *
     * @returns {Promise<void>}
     */
    static async flushPending() {
        if (AuditLogService._flushTimer) {
            clearTimeout(AuditLogService._flushTimer);
            AuditLogService._flushTimer = null;
        }

        const batch = AuditLogService._pending;
        if (batch.length === 0) return;
        AuditLogService._pending = [];

        try {
            if (batch.length === 1) {
                await AuditLogModel.insert(batch[0]);
            } else {
                await AuditLogModel.insertBatch(batch);
            }
        } catch (err) {
            logger.warning(
                auditLogMessages.BATCH_INSERT_FAILED(batch.length, err.message),
            );
        }
    }

    /**
     * Retrieve a paginated list of audit log entries with optional filters.
     *
     * @param {object} params
     * @param {number} params.page              - Page number (1-based).
     * @param {number} params.pageSize          - Rows per page (capped at 100).
     * @param {string} [params.fromDate]        - ISO date string lower bound (inclusive).
     * @param {string} [params.toDate]          - ISO date string upper bound (inclusive, end-of-day).
     * @param {string} [params.method]          - HTTP method filter (e.g. 'GET').
     * @param {string} [params.statusCategory]  - Status category filter (e.g. '4xx').
     * @param {string} [params.search]          - Partial text search across USERNAME, CLIENT_IP, and GID.
     * @returns {Promise<{ rows: object[], total: number, page: number, pageSize: number, totalPages: number }>}
     * @throws {AppError} 400 when fromDate is not before toDate.
     */
    static async getList({
        page,
        pageSize,
        fromDate,
        toDate,
        method,
        statusCategory,
        search,
    }) {
        const cappedPageSize = Math.min(pageSize, 100);

        if (fromDate && toDate) {
            const from = new Date(fromDate);
            const to = new Date(toDate);
            if (isNaN(from.getTime()) || isNaN(to.getTime()) || from >= to) {
                throw new AppError(AUDIT_LOG_ERRORS.INVALID_DATE_RANGE, 400);
            }
        }

        const filter = {};

        if (fromDate && toDate) {
            filter.CREATED_AT = {
                $gte: new Date(fromDate),
                $lte: new Date(new Date(toDate).setHours(23, 59, 59, 999)),
            };
        }

        if (method) filter.METHOD = method;
        if (statusCategory) filter.STATUS_CATEGORY = statusCategory;

        if (search) {
            // CWE-1333: Escape regex metacharacters and cap length to prevent ReDoS.
            // User input must never flow directly into a $regex operator.
            const MAX_SEARCH_LENGTH = 100;
            const safeSearch = search
                .trim()
                .slice(0, MAX_SEARCH_LENGTH)
                .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

            const orClauses = [
                { USERNAME: { $regex: safeSearch } },
                { CLIENT_IP: { $regex: safeSearch } },
                { REQUEST_ID: { $regex: safeSearch } },
            ];
            // USER_ID is NUMBER (stores GID/EMP_ID); $regex is invalid on NUMBER columns —
            // add an exact equality match only when the search term is a valid integer.
            const numericId = /^\d+$/.test(search.trim())
                ? parseInt(search.trim(), 10)
                : null;
            if (numericId !== null) orClauses.push({ USER_ID: numericId });
            filter.$or = orClauses;
        }

        const [rows, total] = await Promise.all([
            AuditLogModel.findPaginated(filter, page, cappedPageSize),
            AuditLogModel.countTotal(filter),
        ]);

        logger.info(auditLogMessages.LIST_FETCHED(rows.length, page));

        return {
            rows,
            total,
            page,
            pageSize: cappedPageSize,
            totalPages: Math.ceil(total / cappedPageSize),
        };
    }

    /**
     * Retrieve aggregate statistics for audit log entries within a date range.
     *
     * @param {object} params
     * @param {string} [params.fromDate] - ISO date string. Defaults to 30 days ago.
     * @param {string} [params.toDate]   - ISO date string. Defaults to today 23:59:59.
     * @returns {Promise<object>} Aggregate statistics including successRate.
     */
    static async getStats({ fromDate, toDate }) {
        const resolvedToDate = toDate
            ? new Date(new Date(toDate).setHours(23, 59, 59, 999))
            : new Date(new Date().setHours(23, 59, 59, 999));
        const resolvedFromDate = fromDate
            ? new Date(fromDate)
            : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

        const matchFilter = {
            CREATED_AT: {
                $gte: resolvedFromDate,
                $lte: resolvedToDate,
            },
        };

        const agg = await AuditLogModel.aggregate(matchFilter);

        // ── Availability SLI (health) ─────────────────────────────────────────────
        // Client errors (4xx) are EXCLUDED from the denominator — a 4xx means the
        // service correctly rejected bad input, not that it failed. Availability
        // answers: "of the requests the server was responsible for, what fraction
        // were served correctly?"
        //   serviced     = total − clientError          (= success + redirect + serverError)
        //   availability = (success + redirect) / serviced
        const serviced = agg.total - agg.clientError;

        const successRate =
            serviced > 0
                ? parseFloat(
                      (((agg.success + agg.redirect) / serviced) * 100).toFixed(
                          1,
                      ),
                  )
                : 100.0; // no serviced requests → nothing failed → fully available

        // ── Error rates (traffic breakdown) ───────────────────────────────────────
        // Each error class as an INDEPENDENT share of TOTAL traffic, so Client and
        // Server rates are symmetric and directly comparable. NOTE: these are a
        // traffic breakdown, not the availability SLI — availability deliberately
        // ignores 4xx, so availability is NOT 1 − serverErrorRate.
        //   clientErrorRate = clientError / total
        //   serverErrorRate = serverError / total
        const clientErrorRate =
            agg.total > 0
                ? parseFloat(((agg.clientError / agg.total) * 100).toFixed(1))
                : 0.0;

        const serverErrorRate =
            agg.total > 0
                ? parseFloat(((agg.serverError / agg.total) * 100).toFixed(1))
                : 0.0;

        logger.info(
            auditLogMessages.STATS_FETCHED(
                resolvedFromDate.toISOString(),
                resolvedToDate.toISOString(),
            ),
        );

        return {
            total: agg.total,
            success: agg.success,
            redirect: agg.redirect,
            clientError: agg.clientError,
            serverError: agg.serverError,
            uniqueUsers: agg.uniqueUsers,
            avgResponseTime: agg.avgResponseTime,
            successRate, // Availability (SLI) — 4xx excluded from denominator
            clientErrorRate, // 4xx / total — independent traffic share
            serverErrorRate, // 5xx / total — independent traffic share
            fromDate: resolvedFromDate.toISOString(),
            toDate: resolvedToDate.toISOString(),
        };
    }

    /**
     * Read log files for a given date and return all lines that reference requestId.
     * Searches ALL RFC 5424 level files (emergency/alert/critical/error/warning/
     * notice/info/debug, legacy warn, including _N rotation files) in the daily log
     * directory. Lines are merged across every level file and sorted
     * chronologically by their embedded [YYYY-MM-DD HH:MM:SS(.mmm)] timestamp,
     * with a phase-aware tiebreak ([Incoming Request] first, [Request Complete]
     * last) so legacy second-precision lines still order Incoming → FUNC → Complete.
     *
     * @param {string} requestId  - Request ID (e.g. "0078812966528-0448-0000").
     * @param {string} dateStr    - ISO date string YYYY-MM-DD (the day to search).
     * @returns {Promise<{ requestId: string, lines: string[] }>}
     */
    static async getRequestLogs(requestId, dateStr) {
        // Accepts both Snowflake format (0078812966528-0448-0000) and legacy (req_UvNZUayhzL)
        if (
            !requestId ||
            !(
                /^\d{13}-\d{4}-\d{4}$/.test(requestId) ||
                /^req_[A-Za-z0-9_-]{1,30}$/.test(requestId)
            )
        ) {
            throw new AppError(
                AUDIT_LOG_ERRORS.AUDIT_LOG_INVALID_REQUEST_ID,
                400,
            );
        }
        if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
            throw new AppError(
                AUDIT_LOG_ERRORS.AUDIT_LOG_INVALID_DATE_FORMAT,
                400,
            );
        }

        const [year, month, day] = dateStr.split("-");
        const logDir = path.join(LOG_BASE_DIR, year, month, day);
        const token = `[${requestId}]`;
        const matched = [];

        let files;
        try {
            const all = await fs.readdir(logDir);
            // Every RFC 5424 level writes its own daily file — the trace must
            // sweep all of them or WARNING/NOTICE/CRITICAL/DEBUG lines vanish
            // from the Request Log Trace.
            files = all
                .filter((f) =>
                    /^(emergency|alert|critical|error|warning|warn|notice|info|debug)(_\d+)?\.log$/.test(
                        f,
                    ),
                )
                .sort();
        } catch {
            return { requestId, lines: [] };
        }

        const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB safety cap per file

        for (const file of files) {
            try {
                const filePath = path.join(logDir, file);
                const stat = await fs.stat(filePath);
                if (stat.size > MAX_FILE_BYTES) continue; // skip oversized files

                const content = await fs.readFile(filePath, "utf8");
                for (const line of content.split("\n")) {
                    if (line.includes(token)) matched.push(line.trim());
                }
            } catch {
                // Skip files that fail to read
            }
        }

        // Sort all lines from all level files chronologically by embedded
        // timestamp (millisecond precision when present). Phase rank breaks
        // timestamp ties so legacy second-precision lines never render as
        // Incoming → Complete → FUNC.
        const TS_RE = /\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{3})?)\]/;
        const _phaseRank = (line) => {
            if (line.includes("[Incoming Request]")) return 0;
            if (line.includes("[Request Complete]")) return 2;
            return 1; // [Handling Request] and [FUNC] lines
        };
        matched.sort((a, b) => {
            // Pad second-precision timestamps so "…:05" sorts with "…:05.000"
            const ta = (a.match(TS_RE)?.[1] ?? "").padEnd(23, ".000");
            const tb = (b.match(TS_RE)?.[1] ?? "").padEnd(23, ".000");
            const cmp = ta.localeCompare(tb);
            return cmp !== 0 ? cmp : _phaseRank(a) - _phaseRank(b);
        });

        logger.info(
            auditLogMessages.LOG_TRACE_FETCHED(requestId, matched.length),
        );
        return { requestId, lines: matched };
    }

    // ─── System log file view (RFC 5424 level files, "System" sub-tab) ─────────

    /**
     * Parses one raw log line into a structured row. Extends the trace-export
     * parsers (`_detectPhase` / `_extractTimestamp` / `_extractMessage` /
     * `_extractLocation` in {@link exportTraceExcel}) with `level` (from the
     * source filename — the request-trace sweep discards it, this one keeps
     * it), `machine`, `pid`, `requestId`, and the raw `meta` string.
     *
     * Never throws. A line that does not match the expected
     * `[MACHINE] [TS] [LEVEL] [PID:n] [fn @ file:line] ... - MESSAGE` shape
     * degrades gracefully: every structured field is `null` except `level`
     * (falls back to the file's level) and `message` (the raw trimmed line).
     *
     * @param {string} line  - One raw log line (already trimmed of trailing `\n`).
     * @param {string} level - Canonical level name for the file this line came
     *   from (one of {@link SYSTEM_LOG_LEVEL_NAMES} values) — used as the
     *   fallback when the line itself carries no `[LEVEL]` bracket.
     * @returns {{ ts: string|null, level: string|null, machine: string|null,
     *   pid: number|null, location: string|null, phase: string|null,
     *   method: string|null, requestId: string|null, message: string,
     *   meta: string|null }|null} `null` only for an empty/non-string line.
     */
    static _parseSystemLine(line, level) {
        if (typeof line !== "string") return null;
        const trimmed = line.trim();
        if (!trimmed) return null;

        const fallbackLevel = level ? String(level).toUpperCase() : null;

        const machineMatch = trimmed.match(/^\[([^\]]+)\]/);
        const machine = machineMatch ? machineMatch[1] : null;

        const tsMatch = trimmed.match(
            /\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{3})?)\]/,
        );
        const ts = tsMatch ? tsMatch[1] : null;

        const levelMatch = trimmed.match(
            /\[(EMERGENCY|ALERT|CRITICAL|ERROR|WARNING|NOTICE|INFO|DEBUG)\]/,
        );
        const parsedLevel = levelMatch ? levelMatch[1] : fallbackLevel;

        const pidMatch = trimmed.match(/\[PID:(\d+)\]/);
        const pid = pidMatch ? Number(pidMatch[1]) : null;

        const locationMatch = trimmed.match(/\[([^\]]+\s@\s[^\]]+:\d+)\]/);
        const location = locationMatch ? locationMatch[1] : null;

        const headerEnd = trimmed.lastIndexOf("] - ");
        let phase = null;
        let method = null;
        let requestId = null;
        let rawAfter;

        if (headerEnd === -1) {
            // Malformed / unexpected line shape — degrade gracefully, keep
            // the raw text as the message rather than dropping the line.
            rawAfter = trimmed;
        } else {
            rawAfter = trimmed.slice(headerEnd + 4); // past "] - "

            if (locationMatch) {
                const afterLocationIdx =
                    trimmed.indexOf(locationMatch[0]) + locationMatch[0].length;
                const trailingSegment = trimmed.slice(
                    afterLocationIdx,
                    headerEnd + 1,
                );
                for (const m of trailingSegment.matchAll(/\[([^\]]*)\]/g)) {
                    const g = m[1];
                    if (!g) continue;
                    if (g === "Incoming Request") phase = "Incoming";
                    else if (g === "Request Complete") phase = "Complete";
                    else if (g === "Handling Request") phase = "Handling";
                    else if (
                        /^\d{13}-\d{4}-\d{4}$/.test(g) ||
                        /^req_[A-Za-z0-9_-]{1,30}$/.test(g)
                    )
                        requestId = g;
                    else method = g;
                }
            }
        }

        const metaMarker = " | META: ";
        const metaIdx = rawAfter.indexOf(metaMarker);
        let message = rawAfter;
        let meta = null;
        if (metaIdx !== -1) {
            message = rawAfter.slice(0, metaIdx);
            meta = rawAfter.slice(metaIdx + metaMarker.length);
        }

        return {
            ts,
            level: parsedLevel,
            machine,
            pid,
            location,
            phase,
            method,
            requestId,
            message: message.trim(),
            meta,
        };
    }

    /**
     * Reads the tail window of every RFC 5424 level file for one calendar day,
     * merges + parses them, and returns an offset-paginated, priority-filtered
     * page — the data source for the Logging & Observability "System" sub-tab.
     *
     * Deliberately reads a **tail window** (last `SYSTEM_LOG_MAX_READ_BYTES`
     * bytes, default 5 MB) per file rather than skipping oversized files
     * outright (the `getRequestLogs` 10 MB skip) — a busy production day's
     * `info.log` can exceed 10 MB, and skipping it would blank exactly the
     * day an operator most needs to see. The first (possibly partial) line of
     * a truncated read is dropped so no line is half-shown.
     *
     * @param {object} params
     * @param {string} [params.date]        - 'YYYY-MM-DD'. Defaults to today (Asia/Manila).
     * @param {number} [params.maxPriority=5] - RFC 5424 priority ceiling (0=emergency..7=debug).
     *   Ignored when `level` is given.
     * @param {string} [params.level]       - Exact single level name (case-insensitive;
     *   `warn` is accepted as an alias for `warning`). Overrides `maxPriority`.
     * @param {number} [params.page=1]
     * @param {number} [params.pageSize=50] - Capped at 200.
     * @param {string} [params.search]      - Case-insensitive substring match on
     *   the parsed message (and raw line as a fallback). Capped at 100 chars.
     * @param {object} [options]
     * @param {string} [options.logBaseDir=LOG_BASE_DIR] - Override for the log
     *   directory root. Defaults to the module's pkg-aware `LOG_BASE_DIR`
     *   constant. Tests point this at a temp fixture directory instead of
     *   mutating a shared global.
     * @returns {Promise<{ rows: object[], total: number, page: number,
     *   pageSize: number, totalPages: number, truncatedFiles: string[] }>}
     * @throws {AppError} 400 on an invalid date, level, or priority.
     */
    static async getSystemLogs(
        { date, maxPriority = 5, level, page = 1, pageSize = 50, search } = {},
        { logBaseDir = LOG_BASE_DIR } = {},
    ) {
        const dateStr = date || _todayManilaDateStr();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
            throw new AppError(AUDIT_LOG_ERRORS.AUDIT_LOG_INVALID_DATE_FORMAT, 400);
        }

        let normalizedLevel = null;
        if (level != null && level !== "") {
            normalizedLevel = SYSTEM_LOG_LEVEL_NAMES[String(level).toLowerCase()];
            if (!normalizedLevel) {
                throw new AppError(AUDIT_LOG_ERRORS.SYSTEM_LOG_INVALID_LEVEL, 400);
            }
        }

        let ceiling = Number(maxPriority);
        if (!Number.isInteger(ceiling) || ceiling < 0 || ceiling > 7) {
            throw new AppError(AUDIT_LOG_ERRORS.SYSTEM_LOG_INVALID_PRIORITY, 400);
        }

        const cappedPageSize = Math.min(Math.max(1, Number(pageSize) || 50), 200);
        const cappedPage = Math.max(1, Number(page) || 1);

        // CWE-22: date is regex-validated above (digits and dashes only) so the
        // joined path can never escape logBaseDir — the explicit prefix check
        // below is defense-in-depth, mirroring exportToZip's guard pattern.
        // Reads the `logBaseDir` parameter (defaults to the module-scope
        // LOG_BASE_DIR const) so tests can point this ONE method at a fixture
        // directory without touching every other file-reading method or any
        // process-wide mutable global.
        const [year, month, day] = dateStr.split("-");
        const logDir = path.join(logBaseDir, year, month, day);
        const resolvedDir = path.resolve(logDir);
        const resolvedBase = path.resolve(logBaseDir);
        if (
            resolvedDir !== resolvedBase &&
            !resolvedDir.startsWith(resolvedBase + path.sep)
        ) {
            throw new AppError(AUDIT_LOG_ERRORS.AUDIT_LOG_INVALID_DATE_FORMAT, 400);
        }

        let filenames;
        try {
            filenames = (await fs.readdir(logDir))
                .filter((f) => SYSTEM_LOG_FILENAME_RE.test(f))
                .sort();
        } catch {
            logger.info(auditLogMessages.SYSTEM_LOG_DIR_MISSING(dateStr));
            return {
                rows: [],
                total: 0,
                page: cappedPage,
                pageSize: cappedPageSize,
                totalPages: 0,
                truncatedFiles: [],
            };
        }

        const maxReadBytes =
            Number(process.env.SYSTEM_LOG_MAX_READ_BYTES) ||
            DEFAULT_SYSTEM_LOG_MAX_READ_BYTES;

        const allRows = [];
        const truncatedFiles = [];

        for (const filename of filenames) {
            const fileLevelKey = filename.match(SYSTEM_LOG_FILENAME_RE)[1];
            const fileLevel = SYSTEM_LOG_LEVEL_NAMES[fileLevelKey];
            const filePriority = SYSTEM_LOG_PRIORITY[fileLevel];

            if (normalizedLevel) {
                if (fileLevel !== normalizedLevel) continue;
            } else if (filePriority > ceiling) {
                continue;
            }

            const filePath = path.join(logDir, filename);
            let handle;
            try {
                handle = await fs.open(filePath, "r");
                const stat = await handle.stat();
                if (stat.size === 0) continue;

                const start = Math.max(0, stat.size - maxReadBytes);
                const truncated = start > 0;
                const length = stat.size - start;
                const buffer = Buffer.alloc(length);
                await handle.read(buffer, 0, length, start);
                let content = buffer.toString("utf8");

                if (truncated) {
                    // Drop the first (possibly partial) line of a tail-window read.
                    const nlIdx = content.indexOf("\n");
                    content = nlIdx !== -1 ? content.slice(nlIdx + 1) : "";
                    truncatedFiles.push(filename);
                }

                for (const line of content.split("\n")) {
                    if (!line.trim()) continue;
                    const parsed = AuditLogService._parseSystemLine(line, fileLevel);
                    if (parsed) allRows.push(parsed);
                }
            } catch {
                // Unreadable file — skip it, never fail the whole page for one bad file.
            } finally {
                if (handle) await handle.close().catch(() => {});
            }
        }

        let filtered = allRows;
        if (search) {
            const MAX_SEARCH_LENGTH = 100;
            const needle = search.trim().slice(0, MAX_SEARCH_LENGTH).toLowerCase();
            if (needle) {
                filtered = allRows.filter((r) =>
                    (r.message || "").toLowerCase().includes(needle),
                );
            }
        }

        // Sort newest-first; rows with no parseable timestamp sort last.
        filtered.sort((a, b) => {
            const ta = (a.ts || "").padEnd(23, ".000");
            const tb = (b.ts || "").padEnd(23, ".000");
            if (!a.ts && !b.ts) return 0;
            if (!a.ts) return 1;
            if (!b.ts) return -1;
            return tb.localeCompare(ta);
        });

        const total = filtered.length;
        const totalPages = Math.ceil(total / cappedPageSize) || 0;
        const offset = (cappedPage - 1) * cappedPageSize;
        const rows = filtered.slice(offset, offset + cappedPageSize);

        logger.info(
            auditLogMessages.SYSTEM_LOGS_FETCHED(dateStr, rows.length, cappedPage),
        );

        return {
            rows,
            total,
            page: cappedPage,
            pageSize: cappedPageSize,
            totalPages,
            truncatedFiles,
        };
    }

    /**
     * Generate an Excel workbook with two sheets:
     *   Sheet 1 — "Audit Records"  (all DB rows in the date range, up to 100 k)
     *   Sheet 2 — "Summary"        (aggregate stats for the range)
     *
     * @param {string} fromDate - ISO date string (YYYY-MM-DD).
     * @param {string} toDate   - ISO date string (YYYY-MM-DD).
     * @returns {Promise<Buffer>} Excel file as a Buffer.
     * @throws {AppError} 400 when either date is missing or range is invalid.
     */
    static async exportToExcel({ fromDate, toDate }) {
        if (!fromDate || !toDate) {
            throw new AppError(AUDIT_LOG_ERRORS.INVALID_DATE_RANGE, 400);
        }

        const resolvedFrom = new Date(fromDate);
        const resolvedTo = new Date(new Date(toDate).setHours(23, 59, 59, 999));

        if (
            isNaN(resolvedFrom.getTime()) ||
            isNaN(resolvedTo.getTime()) ||
            resolvedFrom >= resolvedTo
        ) {
            throw new AppError(AUDIT_LOG_ERRORS.INVALID_DATE_RANGE, 400);
        }

        logger.info(auditLogMessages.EXPORT_EXCEL_STARTED(fromDate, toDate));

        const matchFilter = {
            CREATED_AT: { $gte: resolvedFrom, $lte: resolvedTo },
        };

        const [rows, agg] = await Promise.all([
            AuditLogModel.findPaginated(matchFilter, 1, 100_000),
            AuditLogModel.aggregate(matchFilter),
        ]);

        const ExcelJS = _getExcelJS();
        const workbook = new ExcelJS.Workbook();
        workbook.creator = `${process.env.APP_NAME || "CATHERINE"} System`;
        workbook.created = new Date();

        // ── Sheet 1: Audit Records ──
        const sheet1 = workbook.addWorksheet("Audit Records");
        sheet1.columns = [
            { header: "Date", key: "CREATED_AT", width: 22 },
            { header: "Request ID", key: "REQUEST_ID", width: 26 },
            { header: "Username", key: "USERNAME", width: 20 },
            { header: "Method", key: "METHOD", width: 10 },
            { header: "Endpoint", key: "ENDPOINT", width: 50 },
            { header: "Status Code", key: "STATUS_CODE", width: 14 },
            {
                header: "Response Time (ms)",
                key: "RESPONSE_TIME_MS",
                width: 20,
            },
            { header: "Client IP", key: "CLIENT_IP", width: 18 },
        ];

        // Style header row
        sheet1.getRow(1).font = { bold: true };
        sheet1.getRow(1).fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FFFF4208" },
        };
        sheet1.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };

        rows.forEach((row) => {
            sheet1.addRow({
                CREATED_AT: row.CREATED_AT
                    ? new Date(row.CREATED_AT).toISOString()
                    : "",
                REQUEST_ID: row.REQUEST_ID ?? "",
                USERNAME: row.USERNAME ?? "",
                METHOD: row.METHOD ?? "",
                ENDPOINT: row.ENDPOINT ?? "",
                STATUS_CODE: row.STATUS_CODE ?? "",
                RESPONSE_TIME_MS: row.RESPONSE_TIME_MS ?? 0,
                CLIENT_IP: row.CLIENT_IP ?? "",
            });
        });

        // ── Sheet 2: Summary ──
        const sheet2 = workbook.addWorksheet("Summary");
        sheet2.columns = [
            { header: "Metric", key: "metric", width: 24 },
            { header: "Value", key: "value", width: 20 },
        ];
        sheet2.getRow(1).font = { bold: true };
        sheet2.getRow(1).fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FFFF4208" },
        };
        sheet2.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };

        const summaryRows = [
            { metric: "Date Range From", value: fromDate },
            { metric: "Date Range To", value: toDate },
            { metric: "Total Requests", value: agg.total },
            { metric: "Success (2xx)", value: agg.success },
            { metric: "Redirect (3xx)", value: agg.redirect },
            { metric: "Client Error (4xx)", value: agg.clientError },
            { metric: "Server Error (5xx)", value: agg.serverError },
            { metric: "Unique Users", value: agg.uniqueUsers },
            { metric: "Avg Response Time", value: `${agg.avgResponseTime} ms` },
        ];
        summaryRows.forEach((r) => sheet2.addRow(r));

        return workbook.xlsx.writeBuffer();
    }

    /**
     * Generate an Excel workbook for a single request trace:
     *   Sheet 1 — "Request Summary"  (one row: Method, Status Code, Duration, User, Endpoint, Params)
     *   Sheet 2 — "Log Trace"        (one row per log line: Timestamp, Phase, Message, Location)
     *
     * @param {string} requestId - Request ID (e.g. "0078812966528-0448-0000").
     * @param {string} dateStr   - ISO date string YYYY-MM-DD (the day to search for log lines).
     * @returns {Promise<Buffer>} Excel file as a Buffer.
     * @throws {AppError} 400 when requestId or dateStr format is invalid.
     * @throws {AppError} 404 when no audit record is found for the requestId.
     */
    static async exportTraceExcel(requestId, dateStr) {
        // Accepts both Snowflake format (0078812966528-0448-0000) and legacy (req_UvNZUayhzL)
        if (
            !requestId ||
            !(
                /^\d{13}-\d{4}-\d{4}$/.test(requestId) ||
                /^req_[A-Za-z0-9_-]{1,30}$/.test(requestId)
            )
        ) {
            throw new AppError(
                AUDIT_LOG_ERRORS.AUDIT_LOG_INVALID_REQUEST_ID,
                400,
            );
        }
        if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
            throw new AppError(
                AUDIT_LOG_ERRORS.AUDIT_LOG_INVALID_DATE_FORMAT,
                400,
            );
        }

        logger.info(auditLogMessages.EXPORT_TRACE_STARTED(requestId));

        // Fetch the audit DB row and the file-based log lines in parallel
        const [[dbRow], { lines }] = await Promise.all([
            AuditLogModel.findPaginated({ REQUEST_ID: requestId }, 1, 1),
            AuditLogService.getRequestLogs(requestId, dateStr),
        ]);

        if (!dbRow) {
            throw new AppError(
                AUDIT_LOG_ERRORS.AUDIT_LOG_TRACE_NOT_FOUND(requestId),
                404,
            );
        }

        // ── Phase detection helpers (mirrors frontend detectPhase) ──
        const _detectPhase = (line) => {
            if (line.includes("[Incoming Request]")) return "Incoming";
            if (line.includes("[Request Complete]")) return "Complete";
            if (line.includes("[Handling Request]")) return "Handling";
            return "Function";
        };
        const _extractTimestamp = (line) => {
            const m = line.match(
                /\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{3})?)\]/,
            );
            return m ? m[1] : "";
        };
        const _extractMessage = (line) => {
            const idx = line.lastIndexOf("] - ");
            return idx !== -1 ? line.slice(idx + 4) : line;
        };
        const _extractLocation = (line) => {
            const m = line.match(/\[([^\]]+\s@\s[^\]]+:\d+)\]/);
            return m ? m[1] : "";
        };

        const ExcelJS = _getExcelJS();
        const workbook = new ExcelJS.Workbook();
        workbook.creator = `${process.env.APP_NAME || "CATHERINE"} System`;
        workbook.created = new Date();

        // ── Sheet 1: Request Summary ──
        const sheet1 = workbook.addWorksheet("Request Summary");
        sheet1.columns = [
            { header: "Method", key: "METHOD", width: 12 },
            { header: "Status Code", key: "STATUS_CODE", width: 14 },
            { header: "Duration (ms)", key: "RESPONSE_TIME_MS", width: 16 },
            { header: "User", key: "USERNAME", width: 24 },
            { header: "Endpoint", key: "ENDPOINT", width: 60 },
            { header: "Params", key: "PARAMS", width: 40 },
        ];
        sheet1.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
        sheet1.getRow(1).fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FFFF4208" },
        };
        sheet1.addRow({
            METHOD: dbRow.METHOD ?? "",
            STATUS_CODE: dbRow.STATUS_CODE ?? "",
            RESPONSE_TIME_MS: dbRow.RESPONSE_TIME_MS ?? 0,
            USERNAME: dbRow.USERNAME ?? "",
            ENDPOINT: dbRow.ENDPOINT ?? "",
            PARAMS: dbRow.PARAMS ?? "",
        });

        // ── Sheet 2: Log Trace ──
        const sheet2 = workbook.addWorksheet("Log Trace");
        sheet2.columns = [
            { header: "Timestamp", key: "timestamp", width: 22 },
            { header: "Phase", key: "phase", width: 14 },
            { header: "Message", key: "message", width: 80 },
            { header: "Location", key: "location", width: 50 },
        ];
        sheet2.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
        sheet2.getRow(1).fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FFFF4208" },
        };
        for (const line of lines) {
            sheet2.addRow({
                timestamp: _extractTimestamp(line),
                phase: _detectPhase(line),
                message: _extractMessage(line),
                location: _extractLocation(line),
            });
        }

        return workbook.xlsx.writeBuffer();
    }

    /**
     * Stream log files for the date range as a ZIP archive buffer.
     * Reads logs/YYYY/MM/DD/*.log files for every calendar day in [fromDate, toDate].
     * Days with no log directory are skipped silently.
     *
     * @param {string} fromDate - ISO date string (YYYY-MM-DD).
     * @param {string} toDate   - ISO date string (YYYY-MM-DD).
     * @returns {Promise<Buffer>} ZIP buffer.
     * @throws {AppError} 400 when either date is missing or range is invalid.
     */
    static async exportToZip({ fromDate, toDate }) {
        if (!fromDate || !toDate) {
            throw new AppError(AUDIT_LOG_ERRORS.INVALID_DATE_RANGE, 400);
        }

        const resolvedFrom = new Date(fromDate + "T00:00:00");
        const resolvedTo = new Date(toDate + "T00:00:00");

        if (
            isNaN(resolvedFrom.getTime()) ||
            isNaN(resolvedTo.getTime()) ||
            resolvedFrom > resolvedTo
        ) {
            throw new AppError(AUDIT_LOG_ERRORS.INVALID_DATE_RANGE, 400);
        }

        logger.info(auditLogMessages.EXPORT_ZIP_STARTED(fromDate, toDate));

        const { PassThrough } = require("stream");
        const archiver = _getArchiver();

        return new Promise((resolve, reject) => {
            const chunks = [];
            const pass = new PassThrough();
            pass.on("data", (chunk) => chunks.push(chunk));
            pass.on("end", () => resolve(Buffer.concat(chunks)));
            pass.on("error", reject);

            const archive = archiver("zip", { zlib: { level: 9 } });
            archive.on("error", reject);
            archive.pipe(pass);

            const iter = new Date(resolvedFrom);
            const addNextDay = async () => {
                if (iter > resolvedTo) {
                    archive.finalize();
                    return;
                }

                const yyyy = String(iter.getFullYear());
                const mm = String(iter.getMonth() + 1).padStart(2, "0");
                const dd = String(iter.getDate()).padStart(2, "0");
                const logDir = path.join(LOG_BASE_DIR, yyyy, mm, dd);

                try {
                    const files = await fs.readdir(logDir);
                    for (const file of files) {
                        if (!file.endsWith(".log")) continue;

                        const filePath = path.join(logDir, file);

                        // CWE-22 / CWE-59: Reject symlinks and verify the resolved path
                        // is inside the expected log directory to prevent path traversal.
                        let stat;
                        try {
                            // lstat — does NOT follow symlinks
                            stat = await fs.lstat(filePath);
                        } catch {
                            continue;
                        }
                        if (!stat.isFile()) continue; // skip symlinks, directories, etc.

                        // Verify resolved path starts with logDir (normalised)
                        const resolvedFile = path.resolve(filePath);
                        const resolvedDir = path.resolve(logDir);
                        if (
                            !resolvedFile.startsWith(resolvedDir + path.sep) &&
                            resolvedFile !== resolvedDir
                        ) {
                            logger.warning(
                                `AuditLogService.exportToZip: path traversal attempt blocked — ${file}`,
                            );
                            continue;
                        }

                        archive.file(filePath, {
                            name: `${yyyy}/${mm}/${dd}/${file}`,
                        });
                    }
                } catch {
                    // Directory does not exist for this day — skip silently
                }

                iter.setDate(iter.getDate() + 1);
                setImmediate(addNextDay);
            };

            addNextDay().catch(reject);
        });
    }

    /**
     * Permanently delete all audit DB records and server log files in [fromDate, toDate].
     * DB rows are removed first; then each calendar day's log directory is removed.
     *
     * Each day directory removal is verified: missing directories are skipped
     * (not counted), a failed removal is retried once (~250ms) and, if it still
     * fails or the directory survives the rm (e.g. Windows EPERM/EBUSY from an
     * AV scanner or open handle), the day is reported in `failedDays`.
     *
     * @param {string} fromDate - ISO date string (YYYY-MM-DD).
     * @param {string} toDate   - ISO date string (YYYY-MM-DD).
     * @returns {Promise<{ deletedRows: number, deletedDays: number, failedDays: string[] }>}
     *          `failedDays` contains `YYYY-MM-DD` strings for day folders that
     *          could not be removed.
     * @throws {AppError} 400 when either date is missing or range is invalid.
     */
    static async deleteRange({ fromDate, toDate }) {
        if (!fromDate || !toDate) {
            throw new AppError(AUDIT_LOG_ERRORS.INVALID_DATE_RANGE, 400);
        }

        const resolvedFrom = new Date(fromDate);
        const resolvedTo = new Date(new Date(toDate).setHours(23, 59, 59, 999));

        if (
            isNaN(resolvedFrom.getTime()) ||
            isNaN(resolvedTo.getTime()) ||
            resolvedFrom >= resolvedTo
        ) {
            throw new AppError(AUDIT_LOG_ERRORS.INVALID_DATE_RANGE, 400);
        }

        logger.info(auditLogMessages.DELETE_RANGE_STARTED(fromDate, toDate));

        // Delete DB rows
        const deleteResult = await AuditLogModel.deleteMany({
            CREATED_AT: { $gte: resolvedFrom, $lte: resolvedTo },
        });

        const deletedRows = deleteResult?.rowsAffected ?? 0;

        // Remove log directories for each day in the range
        const iterDate = new Date(fromDate + "T00:00:00");
        const endDate = new Date(toDate + "T00:00:00");
        let deletedDays = 0;
        const failedDays = [];

        while (iterDate <= endDate) {
            const yyyy = String(iterDate.getFullYear());
            const mm = String(iterDate.getMonth() + 1).padStart(2, "0");
            const dd = String(iterDate.getDate()).padStart(2, "0");
            const logDir = path.join(LOG_BASE_DIR, yyyy, mm, dd);
            const dayLabel = `${yyyy}-${mm}-${dd}`;

            // Skip days with no log directory — nothing to delete, nothing to count.
            let dirExists = true;
            try {
                await fs.stat(logDir);
            } catch {
                dirExists = false;
            }

            if (dirExists) {
                // rm with force:true never throws for a missing dir, but CAN throw
                // (or silently leave the dir) on Windows EPERM/EBUSY when an AV
                // scanner, indexer, or open handle holds a file. Retry once, then
                // verify the directory is actually gone before counting.
                let rmError = null;
                try {
                    await fs.rm(logDir, { recursive: true, force: true });
                } catch (firstErr) {
                    await new Promise((resolve) => setTimeout(resolve, 250));
                    try {
                        await fs.rm(logDir, { recursive: true, force: true });
                    } catch (retryErr) {
                        rmError = retryErr;
                    }
                }

                if (rmError) {
                    logger.warning(
                        auditLogMessages.DELETE_DAY_FAILED(
                            dayLabel,
                            rmError.message,
                        ),
                    );
                    failedDays.push(dayLabel);
                } else {
                    // Verify the directory is truly gone — stat must now throw.
                    let stillThere = false;
                    try {
                        await fs.stat(logDir);
                        stillThere = true;
                    } catch {
                        // Expected — directory removed.
                    }
                    if (stillThere) {
                        logger.warning(
                            auditLogMessages.DELETE_DAY_FAILED(
                                dayLabel,
                                "directory still present after rm",
                            ),
                        );
                        failedDays.push(dayLabel);
                    } else {
                        deletedDays++;
                    }
                }
            }

            iterDate.setDate(iterDate.getDate() + 1);
        }

        logger.info(
            auditLogMessages.DELETE_RANGE_DONE(deletedRows, deletedDays),
        );

        return { deletedRows, deletedDays, failedDays };
    }

    /**
     * Returns the epoch-millisecond timestamp of the most recent audit log record.
     * Delegates to AuditLogModel — used only by the SSE shared poller to cheaply
     * detect whether new audit rows have arrived since the last poll tick.
     *
     * @returns {Promise<number>} Epoch ms of latest CREATED_AT, or 0 if empty.
     */
    static async getLatestCreatedAt() {
        return AuditLogModel.getLatestCreatedAt();
    }
}

module.exports = AuditLogService;
