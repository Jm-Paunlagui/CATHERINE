"use strict";

/**
 * @fileoverview AuditLogFileModel — text-file fallback storage for the audit
 * trail.
 *
 * WHAT THIS FILE DOES
 * -------------------
 * Persists audit records as JSON lines (one JSON object per line, same fields
 * as the Oracle row: REQUEST_ID, USER_ID, USERNAME, METHOD, ENDPOINT, PARAMS,
 * STATUS_CODE, STATUS_CATEGORY, RESPONSE_TIME_MS, CLIENT_IP, SERVER_IP,
 * CREATED_AT) under `logs/Main/YYYY/MM/DD/audit.log`. It exists so a template
 * deployment WITHOUT a T_AUDIT_LOGS / T_AUDIT_LOGS_DEV table never loses its
 * audit trail — `AuditLogModel` transparently delegates writes here when
 * `AUDIT_LOG_STORAGE=file`, or when `AUDIT_LOG_STORAGE=auto` and the Oracle
 * write path fails.
 *
 * HOW IT WORKS
 * ------------
 * Mirrors the logger.js file-writing pattern:
 *   - Date components resolved in the Asia/Manila timezone (same as logger).
 *   - Directories created lazily with `fs.mkdir({ recursive: true })`.
 *   - 50 MB size-based rotation: `audit.log` → `audit_1.log` → … → `audit_999.log`,
 *     then a timestamped `audit_<epoch>.log` as the final escape hatch.
 *   - A sequential write queue (promise chain) so concurrent inserts never
 *     interleave partial lines in the file.
 *
 * READ/QUERY SUPPORT
 * ------------------
 * Read methods (`findPaginated`, `countTotal`, `aggregate`, `getLatestCreatedAt`)
 * scan the JSON-lines files under `logs/Main/YYYY/MM/DD/` for the date range
 * implied by the filter's CREATED_AT `$gte`/`$lte` bounds. When no date filter
 * is present, only today's directory is scanned (bounded default to avoid
 * unbounded full-history scans).
 *
 * Performance characteristics:
 *   - O(n) per file where n = line count — no indexing.
 *   - Files > 50 MB are skipped (same cap as the write rotation).
 *   - Suitable for development and low-traffic deployments. High-traffic
 *     production deployments should use `AUDIT_LOG_STORAGE=db`.
 *
 * DELETE SUPPORT
 * --------------
 * `deleteMany` removes entire day directories that fall within the filter's
 * CREATED_AT range. Individual record deletion within a file is not supported
 * (append-only log semantics).
 */

const fs = require("fs").promises;
const path = require("path");
const { logger } = require("../utils/logger");

const CONFIG = Object.freeze({
    /**
     * Root of the fallback store: `logs/Main` under the log base — next to
     * the exe in compiled (pkg) builds (services may start the exe with cwd
     * anywhere), the working directory otherwise. Mirrors logger.js.
     */
    BASE_DIR: process.pkg
        ? path.join(path.dirname(process.execPath), "logs", "Main")
        : path.join(process.cwd(), "logs", "Main"),
    /** Base filename — rotates to `audit_1.log`, `audit_2.log`, … */
    BASE_NAME: "audit",
    /** Rotation threshold — same 50 MB cap logger.js uses. */
    MAX_FILE_SIZE: 50 * 1024 * 1024,
    /** Same timezone the logger derives its YYYY/MM/DD folders from. */
    DATE_OPTIONS: {
        timeZone: "Asia/Manila",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    },
});

/** Sequential write chain — serializes appends so lines never interleave. */
let writeChain = Promise.resolve();

/**
 * Resolves `{ year, month, day }` strings for the current instant in the
 * configured timezone (en-CA locale yields zero-padded numeric parts).
 *
 * @returns {{year: string, month: string, day: string}}
 */
function getDateComponents() {
    const formatter = new Intl.DateTimeFormat("en-CA", CONFIG.DATE_OPTIONS);
    const partsMap = Object.fromEntries(
        formatter
            .formatToParts(new Date())
            .map(({ type, value }) => [type, value]),
    );
    return { year: partsMap.year, month: partsMap.month, day: partsMap.day };
}

/**
 * @param {string} dirPath
 * @returns {Promise<void>}
 */
async function ensureDirectoryExists(dirPath) {
    try {
        await fs.mkdir(dirPath, { recursive: true });
    } catch (error) {
        if (error.code !== "EEXIST") throw error;
    }
}

/**
 * @param {string} filePath
 * @returns {Promise<number>} Size in bytes, 0 when the file doesn't exist.
 */
async function getFileSize(filePath) {
    try {
        return (await fs.stat(filePath)).size;
    } catch (error) {
        if (error.code === "ENOENT") return 0;
        throw error;
    }
}

/**
 * Next writable file path under `baseDir`, rolling over past the size cap —
 * same rollover ladder as logger.js `#getAvailableFilename`.
 *
 * @param {string} baseDir
 * @returns {Promise<string>}
 */
async function getAvailableFilePath(baseDir) {
    let fullPath = path.join(baseDir, `${CONFIG.BASE_NAME}.log`);
    if ((await getFileSize(fullPath)) < CONFIG.MAX_FILE_SIZE) return fullPath;

    for (let counter = 1; counter < 1000; counter++) {
        fullPath = path.join(baseDir, `${CONFIG.BASE_NAME}_${counter}.log`);
        if ((await getFileSize(fullPath)) < CONFIG.MAX_FILE_SIZE)
            return fullPath;
    }

    return path.join(baseDir, `${CONFIG.BASE_NAME}_${Date.now()}.log`);
}

/**
 * Serializes one audit record to a single JSON line. Dates become ISO
 * strings via JSON.stringify's native Date handling.
 *
 * @param {object} record
 * @returns {string}
 */
function toJsonLine(record) {
    return `${JSON.stringify(record)}\n`;
}

/**
 * Appends `content` to today's audit file through the sequential write
 * chain. Never rejects — a failed append is logged (WARNING) and swallowed
 * so audit persistence can never take a request down with it.
 *
 * @param {string} content
 * @returns {Promise<void>}
 */
function enqueueAppend(content) {
    writeChain = writeChain.then(async () => {
        try {
            const { year, month, day } = getDateComponents();
            const dir = path.join(CONFIG.BASE_DIR, year, month, day);
            await ensureDirectoryExists(dir);
            const filePath = await getAvailableFilePath(dir);
            await fs.appendFile(filePath, content, "utf8");
        } catch (error) {
            logger.warning("Audit log file write failed", {
                error: error.message,
            });
        }
    });
    return writeChain;
}

// ─── File-reading helpers ──────────────────────────────────────────────────────

/** Safety cap — skip files larger than this to avoid OOM on huge rotated logs. */
const MAX_READ_FILE_BYTES = CONFIG.MAX_FILE_SIZE;

/**
 * Builds the day directory path for a given Date using the configured timezone.
 *
 * @param {Date} date
 * @returns {string} Absolute path to `logs/Main/YYYY/MM/DD`.
 */
function _dayDirPath(date) {
    const formatter = new Intl.DateTimeFormat("en-CA", CONFIG.DATE_OPTIONS);
    const parts = Object.fromEntries(
        formatter.formatToParts(date).map(({ type, value }) => [type, value]),
    );
    return path.join(CONFIG.BASE_DIR, parts.year, parts.month, parts.day);
}

/**
 * Extracts `{ fromDate: Date, toDate: Date }` from a filter's CREATED_AT
 * `$gte`/`$lte` bounds. Returns nulls when the filter has no date range.
 *
 * @param {object} filter
 * @returns {{ fromDate: Date|null, toDate: Date|null }}
 */
function _extractDateRange(filter) {
    const ca = filter?.CREATED_AT;
    if (!ca) return { fromDate: null, toDate: null };
    const fromDate = ca.$gte ? new Date(ca.$gte) : null;
    const toDate = ca.$lte ? new Date(ca.$lte) : null;
    return { fromDate, toDate };
}

/**
 * Enumerates every day directory between `fromDate` and `toDate` (inclusive).
 * Iterates calendar days, not filesystem entries, so missing directories are
 * silently skipped downstream.
 *
 * @param {Date} fromDate
 * @param {Date} toDate
 * @returns {Promise<string[]>} Absolute paths to day directories.
 */
async function _resolveDayDirectories(fromDate, toDate) {
    const dirs = [];
    const cursor = new Date(fromDate);
    cursor.setHours(0, 0, 0, 0);
    const end = new Date(toDate);
    end.setHours(23, 59, 59, 999);

    while (cursor <= end) {
        dirs.push(_dayDirPath(cursor));
        cursor.setDate(cursor.getDate() + 1);
    }
    return dirs;
}

/**
 * Lists all audit log files (`audit.log`, `audit_1.log`, …) in a directory.
 * Returns an empty array when the directory does not exist.
 *
 * @param {string} dirPath
 * @returns {Promise<string[]>} Absolute file paths sorted alphabetically.
 */
async function _listAuditFiles(dirPath) {
    try {
        const entries = await fs.readdir(dirPath);
        return entries
            .filter(
                (f) =>
                    /^audit(_\d+)?\.log$/.test(f) ||
                    /^audit_\d{10,}\.log$/.test(f),
            )
            .sort()
            .map((f) => path.join(dirPath, f));
    } catch (err) {
        if (err.code === "ENOENT") return [];
        throw err;
    }
}

/**
 * Reads a single audit log file and parses each line as JSON. Malformed lines
 * are silently skipped (a partial write during a crash is expected). Files
 * exceeding `MAX_READ_FILE_BYTES` are skipped entirely.
 *
 * @param {string} filePath
 * @returns {Promise<object[]>} Parsed audit records.
 */
async function _readJsonLines(filePath) {
    try {
        const stat = await fs.stat(filePath);
        if (stat.size > MAX_READ_FILE_BYTES) return [];

        const content = await fs.readFile(filePath, "utf8");
        const records = [];
        for (const line of content.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                records.push(JSON.parse(trimmed));
            } catch {
                // Malformed line — skip (partial write from crash)
            }
        }
        return records;
    } catch (err) {
        if (err.code === "ENOENT") return [];
        throw err;
    }
}

/**
 * Tests whether a single record matches the oracle-mongo-wrapper-style filter.
 * Supports:
 *   - Exact equality: `{ METHOD: "GET" }`
 *   - Date range:     `{ CREATED_AT: { $gte: Date, $lte: Date } }`
 *   - Regex:          `{ USERNAME: { $regex: "john" } }`
 *   - Numeric eq:     `{ USER_ID: 12345 }`
 *   - $or:            `{ $or: [ { USERNAME: { $regex: "x" } }, { USER_ID: 5 } ] }`
 *   - $gt:            `{ USER_ID: { $gt: 0 } }`
 *
 * @param {object} record
 * @param {object} filter
 * @returns {boolean}
 */
function _matchesFilter(record, filter) {
    for (const [key, condition] of Object.entries(filter)) {
        if (key === "$or") {
            if (!Array.isArray(condition)) return false;
            const anyMatch = condition.some((sub) =>
                _matchesFilter(record, sub),
            );
            if (!anyMatch) return false;
            continue;
        }

        const value = record[key];

        // Operator object: { $gte, $lte, $regex, $gt }
        if (
            condition !== null &&
            typeof condition === "object" &&
            !(condition instanceof Date)
        ) {
            if ("$gte" in condition) {
                const cmp =
                    condition.$gte instanceof Date
                        ? condition.$gte.getTime()
                        : condition.$gte;
                const val =
                    value instanceof Date
                        ? value.getTime()
                        : new Date(value).getTime();
                if (isNaN(val) || val < cmp) return false;
            }
            if ("$lte" in condition) {
                const cmp =
                    condition.$lte instanceof Date
                        ? condition.$lte.getTime()
                        : condition.$lte;
                const val =
                    value instanceof Date
                        ? value.getTime()
                        : new Date(value).getTime();
                if (isNaN(val) || val > cmp) return false;
            }
            if ("$gt" in condition) {
                if (
                    value === undefined ||
                    value === null ||
                    value <= condition.$gt
                )
                    return false;
            }
            if ("$regex" in condition) {
                try {
                    const re = new RegExp(condition.$regex, "i");
                    if (!re.test(String(value ?? ""))) return false;
                } catch {
                    return false;
                }
            }
            continue;
        }

        // Direct equality (string, number, Date)
        if (condition instanceof Date) {
            const val = new Date(value).getTime();
            if (isNaN(val) || val !== condition.getTime()) return false;
        } else if (value !== condition) {
            return false;
        }
    }
    return true;
}

/**
 * Core read pipeline: resolve day directories from the filter's date range,
 * read all audit files, parse JSON lines, and apply the filter in memory.
 *
 * When no CREATED_AT range is present in the filter, defaults to today only
 * to avoid unbounded full-history scans.
 *
 * @param {object} filter - oracle-mongo-wrapper-style filter.
 * @returns {Promise<object[]>} All matching records (unsorted).
 */
async function _readAndFilter(filter) {
    let { fromDate, toDate } = _extractDateRange(filter);

    // Default to today when no date range is specified
    if (!fromDate || !toDate) {
        const now = new Date();
        fromDate =
            fromDate ||
            new Date(now.getFullYear(), now.getMonth(), now.getDate());
        toDate =
            toDate ||
            new Date(
                now.getFullYear(),
                now.getMonth(),
                now.getDate(),
                23,
                59,
                59,
                999,
            );
    }

    const dayDirs = await _resolveDayDirectories(fromDate, toDate);
    const matched = [];

    for (const dir of dayDirs) {
        const files = await _listAuditFiles(dir);
        for (const file of files) {
            const lines = await _readJsonLines(file);
            for (const record of lines) {
                if (_matchesFilter(record, filter)) {
                    matched.push(record);
                }
            }
        }
    }

    return matched;
}

// ─── Class ─────────────────────────────────────────────────────────────────────

class AuditLogFileModel {
    /** Exposed for tests and for AuditLogModel's storage-mode diagnostics. */
    static get CONFIG() {
        return CONFIG;
    }

    /**
     * Appends one audit record as a JSON line.
     *
     * @param {object} record
     * @returns {Promise<{rowsAffected: number}>}
     */
    static async insert(record) {
        await enqueueAppend(toJsonLine(record));
        return { rowsAffected: 1 };
    }

    /**
     * Appends a buffered batch as consecutive JSON lines in ONE queued append
     * so a batch is never split across a rotation boundary mid-flush.
     *
     * @param {object[]} records
     * @returns {Promise<{rowsAffected: number}>}
     */
    static async insertBatch(records) {
        const list = Array.isArray(records) ? records : [];
        if (list.length === 0) return { rowsAffected: 0 };
        await enqueueAppend(list.map(toJsonLine).join(""));
        return { rowsAffected: list.length };
    }

    // ─── Read/query — file-based scanning ─────────────────────────────────

    /**
     * Paginated query over JSON-lines audit files. Scans day directories
     * implied by the filter's CREATED_AT range, applies all filter predicates
     * in memory, sorts descending by CREATED_AT, and returns the requested page.
     *
     * O(n) time where n = total lines across scanned files. O(m) space where
     * m = matched records (held in memory for sort + pagination).
     *
     * @param {object} filter  - oracle-mongo-wrapper-style filter object.
     * @param {number} page    - 1-based page number.
     * @param {number} pageSize - Rows per page.
     * @returns {Promise<object[]>} Matching records for the requested page.
     */
    static async findPaginated(filter, page, pageSize) {
        try {
            const records = await _readAndFilter(filter);
            records.sort(
                (a, b) => new Date(b.CREATED_AT) - new Date(a.CREATED_AT),
            );
            return records.slice((page - 1) * pageSize, page * pageSize);
        } catch (err) {
            logger.warning("Audit log file read failed (findPaginated)", {
                error: err.message,
            });
            return [];
        }
    }

    /**
     * Total count of records matching the filter across all scanned files.
     *
     * @param {object} filter - oracle-mongo-wrapper-style filter object.
     * @returns {Promise<number>}
     */
    static async countTotal(filter) {
        try {
            const records = await _readAndFilter(filter);
            return records.length;
        } catch (err) {
            logger.warning("Audit log file read failed (countTotal)", {
                error: err.message,
            });
            return 0;
        }
    }

    /**
     * Deletes entire day directories that fall within the filter's CREATED_AT
     * range. Individual record deletion within a file is not supported
     * (append-only log semantics).
     *
     * @param {object} filter - Must contain CREATED_AT with $gte/$lte bounds.
     * @returns {Promise<{rowsAffected: number}>} Count of records in deleted directories.
     */
    static async deleteMany(filter) {
        try {
            const { fromDate, toDate } = _extractDateRange(filter);
            if (!fromDate || !toDate) return { rowsAffected: 0 };

            const dayDirs = await _resolveDayDirectories(fromDate, toDate);
            let totalDeleted = 0;

            for (const dir of dayDirs) {
                try {
                    // Count records before deleting so we can report rowsAffected
                    const files = await _listAuditFiles(dir);
                    for (const file of files) {
                        const lines = await _readJsonLines(file);
                        totalDeleted += lines.length;
                    }
                    await fs.rm(dir, { recursive: true, force: true });
                } catch {
                    // Directory may not exist — skip silently
                }
            }

            return { rowsAffected: totalDeleted };
        } catch (err) {
            logger.warning("Audit log file delete failed", {
                error: err.message,
            });
            return { rowsAffected: 0 };
        }
    }

    /**
     * Returns the epoch-millisecond timestamp of the most recent audit log
     * record by scanning today's directory (and yesterday's as a fallback
     * around midnight). Used by the SSE poller to detect new records.
     *
     * @returns {Promise<number>} Epoch ms of latest CREATED_AT, or 0 if empty.
     */
    static async getLatestCreatedAt() {
        try {
            // Scan today and yesterday to handle timezone boundary
            const today = new Date();
            const yesterday = new Date(today);
            yesterday.setDate(yesterday.getDate() - 1);

            const dirs = [_dayDirPath(today), _dayDirPath(yesterday)];

            let latestMs = 0;

            for (const dir of dirs) {
                const files = await _listAuditFiles(dir);
                for (const file of files) {
                    const lines = await _readJsonLines(file);
                    for (const record of lines) {
                        const ts = new Date(record.CREATED_AT).getTime();
                        if (!isNaN(ts) && ts > latestMs) latestMs = ts;
                    }
                }
            }

            return latestMs;
        } catch (err) {
            logger.warning("Audit log file read failed (getLatestCreatedAt)", {
                error: err.message,
            });
            return 0;
        }
    }

    /**
     * Aggregate statistics matching AuditLogModel.aggregate's contract.
     * Scans files in the date range and computes counts, unique users, and
     * average response time in a single pass — O(n) time, O(u) space where
     * u = unique user count.
     *
     * @param {object} matchFilter - Filter with CREATED_AT $gte/$lte bounds.
     * @returns {Promise<object>} Aggregate statistics.
     */
    static async aggregate(matchFilter) {
        try {
            const records = await _readAndFilter(matchFilter);

            const buckets = { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 };
            const userSet = new Set();
            let totalRespTime = 0;

            for (const r of records) {
                const cat = (r.STATUS_CATEGORY ?? "").trim();
                if (Object.prototype.hasOwnProperty.call(buckets, cat)) {
                    buckets[cat] += 1;
                }
                if (r.USER_ID && r.USER_ID > 0) userSet.add(r.USER_ID);
                totalRespTime += r.RESPONSE_TIME_MS ?? 0;
            }

            return {
                total: records.length,
                success: buckets["2xx"],
                redirect: buckets["3xx"],
                clientError: buckets["4xx"],
                serverError: buckets["5xx"],
                uniqueUsers: userSet.size,
                avgResponseTime:
                    records.length > 0
                        ? Math.round(totalRespTime / records.length)
                        : 0,
            };
        } catch (err) {
            logger.warning("Audit log file read failed (aggregate)", {
                error: err.message,
            });
            return {
                total: 0,
                success: 0,
                redirect: 0,
                clientError: 0,
                serverError: 0,
                uniqueUsers: 0,
                avgResponseTime: 0,
            };
        }
    }

    /**
     * Awaits every append queued so far — used by graceful shutdown (via
     * AuditLogService.flushPending) and by tests to observe completed writes.
     *
     * @returns {Promise<void>}
     */
    static async drain() {
        await writeChain;
    }
}

module.exports = AuditLogFileModel;
