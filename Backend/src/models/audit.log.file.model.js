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
 * There is no indexing on a text file, so the read/query methods
 * (`findPaginated`, `countTotal`, `aggregate`, `getLatestCreatedAt`,
 * `deleteMany`) return empty/zero stub shapes — file-based storage is a
 * write-only durability fallback, not a queryable store.
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
        formatter.formatToParts(new Date()).map(({ type, value }) => [type, value]),
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
        if ((await getFileSize(fullPath)) < CONFIG.MAX_FILE_SIZE) return fullPath;
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

    // ─── Read/query stubs — file storage is write-only ─────────────────────
    // A flat text file has no indexes; querying it would mean scanning every
    // rotated file for every request. The UI degrades to empty result sets
    // instead.

    /** @returns {Promise<object[]>} Always empty. */
    static async findPaginated(_filter, _page, _pageSize) {
        return [];
    }

    /** @returns {Promise<number>} Always 0. */
    static async countTotal(_filter) {
        return 0;
    }

    /** @returns {Promise<{rowsAffected: number}>} Never deletes anything. */
    static async deleteMany(_filter) {
        return { rowsAffected: 0 };
    }

    /** @returns {Promise<number>} Always 0 (epoch ms sentinel for "no rows"). */
    static async getLatestCreatedAt() {
        return 0;
    }

    /**
     * Zeroed stats shape matching AuditLogModel.aggregate's contract.
     *
     * @returns {Promise<object>}
     */
    static async aggregate(_matchFilter) {
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
