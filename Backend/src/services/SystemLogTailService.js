"use strict";

/**
 * @fileoverview SystemLogTailService — live-tail poller backing
 * `GET /api/v1/audit-logs/system-logs/stream` (the Logging & Observability
 * "System" sub-tab's live mode).
 *
 * WHAT THIS FILE DOES
 * --------------------
 * Maintains ONE shared `setInterval` poller for the entire process (never one
 * timer per SSE connection) that watches today's RFC 5424 level files
 * (`logs/YYYY/MM/DD/<level>.log`) for growth, reads only the newly-appended
 * bytes since the last tick, parses each new line via
 * `AuditLogService._parseSystemLine`, and fans the parsed rows out to every
 * connected SSE client — filtered per-connection by that client's requested
 * `maxPriority` ceiling, or by an exact `level` when the client asked for one
 * single level instead of a ceiling (mirrors the browse endpoint's `level`
 * param overriding `maxPriority` — see `AuditLogService.getSystemLogs`).
 *
 * HOW IT WORKS
 * ------------
 *   - `addConnection(connId, res, maxPriority, level?)` registers an SSE
 *     client and starts the poller if this is the first connection
 *     (idempotent). Every file is still tailed/read for every connection
 *     regardless of its filter — only what gets DISPATCHED to a given
 *     connection is filtered, by `level` when set, else by `maxPriority`.
 *   - `removeConnection(connId)` unregisters a client and stops the poller
 *     once no connections remain (offsets are discarded on stop — a fresh
 *     `addConnection` after an idle period starts tailing from "now", never
 *     replays a backlog).
 *   - Every tick: re-lists today's level files (rotation/midnight aware),
 *     `fs.stat`s each one, and for any file that grew, reads the delta
 *     `[storedOffset, currentSize)` — never the whole file. A file seen for
 *     the FIRST time in a tail session starts at `offset = size` (skip
 *     existing backlog — this is a *live* tail); a file that appears
 *     mid-session (e.g. a fresh `_N` rotation file) starts at `offset = 0`
 *     (it did not exist before, so its entire content is new). A file whose
 *     size drops below its stored offset (truncation/external rotation) is
 *     defensively reset to `offset = 0`.
 *   - Midnight rollover: when today's resolved directory path changes, all
 *     offsets are discarded and re-initialized as if this were a fresh
 *     `addConnection` (skip whatever the new day's files already contain at
 *     that instant).
 *   - Per connection, per tick: rows are capped at `MAX_ROWS_PER_TICK` (200);
 *     the remainder is reported via a `dropped` count rather than silently
 *     lost. Ticks with nothing new for a connection send a `heartbeat` event
 *     instead of an empty `lines` event.
 *
 * EXAMPLE
 * -------
 *   const systemLogTail = require("./SystemLogTailService");
 *   systemLogTail.addConnection("user-42", res, 5); // NOTICE and above
 *   // ... later, on socket close:
 *   systemLogTail.removeConnection("user-42");
 */

const fs = require("fs").promises;
const path = require("path");

const { logger } = require("../utils/logger");
const { auditLogMessages } = require("../constants/messages");
const AuditLogService = require("./AuditLogService");

/** Max parsed rows delivered to one connection in a single tick — the rest are reported via `dropped`. */
const MAX_ROWS_PER_TICK = 200;

/** Consecutive tick failures before the poller stops and notifies every connection. */
const MAX_CONSECUTIVE_ERRORS = 5;

class SystemLogTailService {
    /**
     * @param {object} [opts]
     * @param {string} [opts.logBaseDir] - Override for `AuditLogService.LOG_BASE_DIR`,
     *   used only by tests to point the poller at a fixture directory.
     */
    constructor(opts = {}) {
        /** @type {string} */
        this._logBaseDir = opts.logBaseDir || AuditLogService.LOG_BASE_DIR;

        /** @type {Map<string, { res: import('express').Response, maxPriority: number, level: string|null, pollCount: number }>} */
        this._connections = new Map();

        /** @type {NodeJS.Timeout|null} */
        this._timer = null;

        /** Per-filename byte offsets for the directory currently being tailed. @type {Map<string, number>} */
        this._offsets = new Map();

        /** Resolved directory path currently being tailed (recomputed every tick for midnight rollover). @type {string|null} */
        this._currentDir = null;

        /** True once at least one tick has populated `_offsets` for `_currentDir`. */
        this._initializedDir = false;

        /** @type {number} */
        this._consecutiveErrors = 0;
    }

    /**
     * Poll interval in milliseconds — read live from env on every start so
     * tests can override it via `process.env` without restarting the module.
     * @returns {number}
     */
    _pollIntervalMs() {
        return Number(process.env.SYSTEM_LOG_STREAM_POLL_MS) || 5000;
    }

    /**
     * Registers a new SSE connection and (idempotently) starts the shared poller.
     *
     * @param {string} connId       - Unique key for this connection (e.g. userId).
     * @param {import('express').Response} res
     * @param {number} maxPriority  - RFC 5424 priority ceiling this connection
     *   wants (0-7). Ignored for dispatch when `level` is set.
     * @param {string|null} [level] - Exact canonical level name (one of
     *   {@link AuditLogService.SYSTEM_LOG_LEVEL_NAMES}' values, e.g.
     *   "DEBUG") this connection wants — overrides `maxPriority` entirely
     *   for dispatch when set. Mirrors `AuditLogService.getSystemLogs`'
     *   `level` param overriding `maxPriority` on the browse endpoint.
     */
    addConnection(connId, res, maxPriority, level = null) {
        this._connections.set(connId, {
            res,
            maxPriority: Number.isInteger(maxPriority) ? maxPriority : 5,
            level: level || null,
            pollCount: 0,
        });
        logger.info(auditLogMessages.SYSTEM_TAIL_CONNECTED(connId));
        this._start();
    }

    /**
     * Unregisters an SSE connection. Stops the shared poller (and discards
     * all tail offsets) once no connections remain.
     *
     * @param {string} connId
     */
    removeConnection(connId) {
        if (this._connections.delete(connId)) {
            logger.info(auditLogMessages.SYSTEM_TAIL_DISCONNECTED(connId));
        }
        this._stop();
    }

    /** @returns {boolean} */
    hasConnection(connId) {
        return this._connections.has(connId);
    }

    /** Starts the shared poller. Idempotent — safe to call on every new connection. */
    _start() {
        if (this._timer !== null) return;
        this._consecutiveErrors = 0;
        this._timer = setInterval(
            () => this._tick().catch((err) => this._onTickError(err)),
            this._pollIntervalMs(),
        );
        this._timer.unref();
        logger.notice(auditLogMessages.SYSTEM_TAIL_STARTED());
    }

    /** Stops the shared poller once no connections remain and resets tail state. */
    _stop() {
        if (this._connections.size > 0 || this._timer === null) return;
        clearInterval(this._timer);
        this._timer = null;
        this._offsets = new Map();
        this._currentDir = null;
        this._initializedDir = false;
        logger.notice(auditLogMessages.SYSTEM_TAIL_STOPPED());
    }

    /**
     * Resolves today's log directory (Asia/Manila calendar day), matching
     * the exact path convention `AuditLogService.getSystemLogs` reads from.
     * @returns {string}
     */
    _todayDir() {
        const fmt = new Intl.DateTimeFormat("en-CA", {
            timeZone: "Asia/Manila",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
        });
        const [{ value: year }, , { value: month }, , { value: day }] =
            fmt.formatToParts(new Date());
        return path.join(this._logBaseDir, year, month, day);
    }

    /**
     * One poll tick: detects midnight rollover, re-lists level files, reads
     * any growth since the last tick, parses new lines, and dispatches them
     * to every connection whose `maxPriority` accepts that line's level.
     * Never throws — a tick failure is caught by the interval callback in
     * `_start()` and counted toward `MAX_CONSECUTIVE_ERRORS`.
     * @returns {Promise<void>}
     */
    async _tick() {
        if (this._connections.size === 0) return;

        const dir = this._todayDir();
        if (dir !== this._currentDir) {
            this._currentDir = dir;
            this._offsets = new Map();
            this._initializedDir = false;
            logger.notice(auditLogMessages.SYSTEM_TAIL_DIR_ROLLOVER(dir));
        }

        let filenames;
        try {
            filenames = (await fs.readdir(dir))
                .filter((f) => AuditLogService.SYSTEM_LOG_FILENAME_RE.test(f))
                .sort();
        } catch {
            // No log directory yet for today (fresh install / pre-midnight boot) — nothing to tail.
            this._initializedDir = true;
            this._consecutiveErrors = 0;
            this._sendHeartbeats();
            return;
        }

        const isFirstScan = !this._initializedDir;
        /** @type {Map<string, Array<object>>} connId -> parsed rows this tick */
        const perConnRows = new Map();
        for (const connId of this._connections.keys()) perConnRows.set(connId, []);

        for (const filename of filenames) {
            const filePath = path.join(dir, filename);
            let stat;
            try {
                stat = await fs.stat(filePath);
            } catch {
                continue;
            }

            let offset = this._offsets.get(filename);
            if (offset === undefined) {
                // First sighting of this file. On the very first scan of a (new)
                // directory, skip existing backlog (live tail). A file that
                // appears mid-session (e.g. a fresh rotation `_N` file) is
                // brand new — read it from the start.
                offset = isFirstScan ? stat.size : 0;
                this._offsets.set(filename, offset);
            }

            if (stat.size < offset) {
                logger.warning(
                    auditLogMessages.SYSTEM_TAIL_ROTATION_DETECTED(filename),
                );
                offset = 0;
            }

            if (stat.size > offset) {
                const delta = await this._readDelta(filePath, offset, stat.size);
                this._offsets.set(filename, stat.size);

                const levelKey = filename.match(
                    AuditLogService.SYSTEM_LOG_FILENAME_RE,
                )[1];
                const fileLevel = AuditLogService.SYSTEM_LOG_LEVEL_NAMES[levelKey];
                const priority = AuditLogService.SYSTEM_LOG_PRIORITY[fileLevel];

                for (const line of delta.split("\n")) {
                    if (!line.trim()) continue;
                    const parsed = AuditLogService._parseSystemLine(line, fileLevel);
                    if (!parsed) continue;

                    for (const [connId, conn] of this._connections) {
                        // An exact-level connection ignores maxPriority
                        // entirely (mirrors AuditLogService.getSystemLogs'
                        // `level` overriding `maxPriority`) and is filtered
                        // at the same FILE granularity the browse endpoint
                        // uses — never the line's own (possibly divergent)
                        // embedded [LEVEL] bracket. Reading files themselves
                        // is unaffected: every connection's file, regardless
                        // of its own level/maxPriority, is still tailed —
                        // only what gets DISPATCHED differs per connection.
                        const matches = conn.level
                            ? fileLevel === conn.level
                            : priority <= conn.maxPriority;
                        if (matches) {
                            perConnRows.get(connId).push(parsed);
                        }
                    }
                }
            } else {
                this._offsets.set(filename, stat.size);
            }
        }

        this._initializedDir = true;
        this._consecutiveErrors = 0;
        this._dispatch(perConnRows);
    }

    /**
     * Reads the byte range `[start, end)` from a file as a UTF-8 string.
     * @param {string} filePath
     * @param {number} start
     * @param {number} end
     * @returns {Promise<string>}
     * @private
     */
    async _readDelta(filePath, start, end) {
        const length = end - start;
        if (length <= 0) return "";
        let handle;
        try {
            handle = await fs.open(filePath, "r");
            const buffer = Buffer.alloc(length);
            await handle.read(buffer, 0, length, start);
            return buffer.toString("utf8");
        } catch {
            return "";
        } finally {
            if (handle) await handle.close().catch(() => {});
        }
    }

    /**
     * Sends the accumulated rows (or a heartbeat when a connection has none)
     * to every connection, capping each connection's per-tick payload.
     * @param {Map<string, Array<object>>} perConnRows
     * @private
     */
    _dispatch(perConnRows) {
        const ts = new Date().toISOString();
        for (const [connId, conn] of this._connections) {
            conn.pollCount++;
            const rows = perConnRows.get(connId) ?? [];
            if (rows.length === 0) {
                this._safeSend(conn.res, "heartbeat", {
                    timestamp: ts,
                    pollCount: conn.pollCount,
                });
                continue;
            }
            const lines = rows.slice(0, MAX_ROWS_PER_TICK);
            const dropped = Math.max(0, rows.length - MAX_ROWS_PER_TICK);
            this._safeSend(conn.res, "lines", { timestamp: ts, lines, dropped });
        }
    }

    /** Heartbeat-only dispatch used when the directory read itself failed/was absent. @private */
    _sendHeartbeats() {
        const ts = new Date().toISOString();
        for (const conn of this._connections.values()) {
            conn.pollCount++;
            this._safeSend(conn.res, "heartbeat", {
                timestamp: ts,
                pollCount: conn.pollCount,
            });
        }
    }

    /**
     * Writes a named SSE event and flushes immediately. Swallows write
     * errors — a closed socket is cleaned up by the controller's
     * `req.on("close")` handler calling `removeConnection`.
     * @param {import('express').Response} res
     * @param {string} eventName
     * @param {object} payload
     * @private
     */
    _safeSend(res, eventName, payload) {
        try {
            res.write(`event: ${eventName}\n`);
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
            if (typeof res.flush === "function") res.flush();
        } catch {
            // Socket already closed — caller's close handler removes the connection.
        }
    }

    /**
     * Handles a thrown tick error: logs, counts, and — past
     * {@link MAX_CONSECUTIVE_ERRORS} — notifies every client and clears all
     * connections (mirrors `AuditLogController`'s shared audit-log poller).
     * @param {Error} err
     * @private
     */
    _onTickError(err) {
        this._consecutiveErrors++;
        logger.error(
            auditLogMessages.SYSTEM_TAIL_TICK_ERROR(err?.message ?? String(err)),
        );

        if (this._consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            logger.warning(
                auditLogMessages.SYSTEM_TAIL_MAX_ERRORS(
                    this._connections.size,
                    MAX_CONSECUTIVE_ERRORS,
                ),
            );
            for (const conn of this._connections.values()) {
                this._safeSend(conn.res, "error", {
                    message:
                        "Live tail polling failed repeatedly. Please refresh your page.",
                    code: "POLL_FAILED",
                });
            }
            this._connections.clear();
            if (this._timer) clearInterval(this._timer);
            this._timer = null;
        }
    }
}

const instance = new SystemLogTailService();
module.exports = instance;
module.exports.SystemLogTailService = SystemLogTailService;
