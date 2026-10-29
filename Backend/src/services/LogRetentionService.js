"use strict";

/**
 * @fileoverview Real, unattended retention sweep for the RFC 5424 file logs
 * under `logs/YYYY/MM/DD/`. Replaces `logger.js`'s former `cleanupOldLogs()`,
 * which logged "Log cleanup completed" while deleting nothing and was called
 * from nowhere — this service is the honest mechanism.
 *
 * WHAT THIS DOES
 * --------------
 * A plain `setInterval` (never `node-cron` — in a PKG-compiled exe cron ticks can silently not fire in a
 * compiled exe) checks once every `SWEEP_CHECK_MS` whether today's calendar
 * date has already been swept; if not, it walks `logBaseDir` one `YYYY` ->
 * `MM` -> `DD` level at a time and `fs.rm`s every day-directory whose own
 * midnight is strictly older than `LOG_RETENTION_DAYS` (default
 * `DEFAULT_RETENTION_DAYS`). `LOG_RETENTION_DAYS=0` disables the sweep
 * entirely. Not run on boot — only on the interval — so a large first sweep
 * never competes with startup.
 *
 * DELETION-SAFETY CONTRACT
 * -------------------------
 *  1. `days = _retentionDays()`; `0` -> no-op, nothing is touched.
 *  2. A day-directory is a removal candidate only when its own midnight is
 *     strictly `<` the cutoff (`todayMidnight - days`). With the `days >= 1`
 *     floor enforced by `_retentionDays()`, today's directory — and
 *     yesterday's — can NEVER be a candidate.
 *  3. The currently-written file is excluded STRUCTURALLY, not by name or
 *     open-handle check: `logger.js:665-666` computes its write directory
 *     from `new Date()` at drain time, so the logger only ever appends
 *     inside today's directory, which rule 2 already makes unreachable.
 *  4. No partial-roll state exists to worry about: `logger.js`'s
 *     `#getAvailableFilename` never renames or moves a file across
 *     directories, so a rolled file (`error_1.log`) in a stale day dir is
 *     an ordinary file inside a directory already being removed.
 *  5. Directory-name components are matched against `YEAR_RE`/`MONTH_DAY_RE`
 *     (digits only) before ever being joined into a path — a stray file, an
 *     operator's `archive/`, or any non-numeric directory is skipped and
 *     never counted. The digit-only regex is itself the guard against a
 *     component containing `.` or a path separator.
 *  6. File sizes are summed into `freedBytes` BEFORE removal — the number an
 *     operator actually wants to see.
 *  7. Removal is `fs.rm(dir, { recursive: true, force: true })`; on failure,
 *     wait `RM_RETRY_DELAY_MS` and retry ONCE; then verify with `fs.stat`
 *     that the directory is truly gone — Windows `fs.rm` can resolve
 *     without error and leave the directory behind (AV scanner, indexer, or
 *     an open handle). This is the same retry-once + `fs.stat`-verify
 *     technique as `AuditLogService.js:1217-1262`'s `deleteRange` day-folder
 *     removal, duplicated here deliberately rather than shared — see "vs
 *     AuditLogService.deleteRange" below.
 *  8. A failed day is pushed to `failedDays`, logged once at WARNING, and
 *     the sweep continues. At `MAX_FAILED_DAYS_PER_SWEEP` (5) failures the
 *     sweep logs one `BUDGET_ABORT` and stops — the budget is the circuit-
 *     breaker analogue: a stuck AV/EBUSY lock on Windows must not write
 *     hundreds of warnings into the very directory this sweep exists to
 *     bound. `_lastSweepDay` is already stamped, so the retry happens on
 *     tomorrow's check — a one-day slip in a 90-day policy is immaterial.
 *  9. Empty parents are pruned with a non-recursive `fs.rmdir` at the `MM`
 *     and `YYYY` levels ONLY, with `ENOTEMPTY`/`ENOENT`/`EPERM` swallowed
 *     silently. `logBaseDir` itself is NEVER passed to `rm`/`rmdir`, even
 *     when it is empty. Recursive removal happens at exactly ONE tree
 *     level: `DD`. The `rmdir` failing on a non-empty parent (days still
 *     inside the retention window) IS the safety property, not a bug.
 * 10. One `SWEEP_DONE` notice is logged only when `removedDays > 0` —
 *     mirrors `AlertNotifierService`'s purge-notice pattern
 *     (`AlertNotifierService.js:1006`).
 *
 * vs `AuditLogService.deleteRange` — COMPLEMENT, NOT SHARED
 * -----------------------------------------------------------
 * `deleteRange` is operator-driven (SUPER_ADMIN route), range-bounded,
 * deletes BOTH `T_AUDIT_LOGS` rows AND log day-directories, and throws
 * `AppError` on bad input. This service is unattended, retention-bounded,
 * touches only the filesystem, and never throws. The retry-once +
 * `fs.stat`-verify TECHNIQUE is intentionally duplicated (not extracted
 * into a shared helper) — extracting one would put a SUPER_ADMIN route with
 * an existing test regression surface behind a change made for an
 * unattended sweep, for roughly 20 lines of code. Neither method calls the
 * other; calling `deleteRange` from here would delete `T_AUDIT_LOGS` DB
 * rows on a *file* clock, which is exactly the divergent notion of "old"
 * this service exists to avoid.
 *
 * WHY A SERVICE, NOT A `logger.js` METHOD
 * -----------------------------------------
 * `logger.js` deliberately imports nothing from `src/` except
 * `requestContext` (see the comment at `logger.js:20-27`) — every other
 * module in the codebase requires the logger, so pulling `constants/
 * messages` (or anything else) into it would invert that dependency and
 * invite a require cycle. Living in `src/services/` lets this sweep use
 * `constants/messages/logRetention.messages.js` per the three-bucket rule
 * and keeps the logger's zero-dependency position intact.
 *
 * SECURITY (CWE-459 — Incomplete Cleanup): raw file logs can carry request
 * bodies, computed identifiers, and (pre-R2) once carried bind values — an
 * unattended, verified deletion sweep bounds how long that data survives on
 * disk to a fixed retention window instead of accumulating forever.
 *
 * BIG-O: one sweep visits every `YYYY`/`MM`/`DD` directory and every file
 * inside a candidate `DD` directory exactly once — O(n) in the total number
 * of directories and files under `logBaseDir`, bounded by log volume, not
 * by retention days.
 *
 * EXAMPLE
 * -------
 *   const LogRetentionService = require("./LogRetentionService");
 *   LogRetentionService.start();      // cron-leader only, after AlertNotifierService
 *   // ...
 *   LogRetentionService.stop();       // graceful shutdown
 */

const fs = require("fs").promises;
const path = require("path");

const { logger } = require("../utils/logger");
const { logRetentionMessages } = require("../constants/messages");

/**
 * Log directory base — MUST match `logger.js`'s `LOG_BASE_DIR` resolution:
 * in compiled (pkg) builds logs live NEXT TO THE EXE (a Windows service may
 * start with cwd = System32); in normal Node they live under the cwd.
 * Reading from `process.cwd()` here while the logger writes next to the exe
 * would make this sweep silently target an empty directory. Re-derived
 * locally (not imported from `AuditLogService`) to keep this service's
 * import graph limited to `fs`/`path`/`logger`/`logRetentionMessages`.
 */
const LOG_BASE_DIR = process.pkg
    ? path.join(path.dirname(process.execPath), "logs")
    : path.join(process.cwd(), "logs");

/** Sweep check cadence — mirrors `AlertNotifierService._armRetentionSweep`'s 15-min interval (R6: never node-cron). */
const SWEEP_CHECK_MS = 15 * 60 * 1000;

/** Retention window used when `LOG_RETENTION_DAYS` is unset, non-numeric, or < 1. */
const DEFAULT_RETENTION_DAYS = 90;

/** Failed day-directories tolerated in one sweep before it aborts (circuit-breaker analogue). */
const MAX_FAILED_DAYS_PER_SWEEP = 5;

/** Delay before the single retry of a failed `fs.rm`. */
const RM_RETRY_DELAY_MS = 250;

/** Milliseconds in one day — used to compute the retention cutoff. */

/** Matches a 4-digit `YYYY` directory name. Digit-only by construction — rejects any component containing `.` or a path separator. */
const YEAR_RE = /^\d{4}$/;

/** Matches a 2-digit `MM` or `DD` directory name. Same digit-only guarantee as `YEAR_RE`. */
const MONTH_DAY_RE = /^\d{2}$/;

/**
 * Formats a byte count as a short human-readable string (`"12.34 MB"`).
 * Pure transformation — no state, no side effects. Mirrors
 * `BackupEmailService.js`'s local `_formatBytes` helper.
 *
 * @param {number} bytes
 * @returns {string}
 */
function _formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let value = n;
    let unitIndex = -1;
    do {
        value /= 1024;
        unitIndex += 1;
    } while (value >= 1024 && unitIndex < units.length - 1);
    return `${value.toFixed(2)} ${units[unitIndex]}`;
}

class LogRetentionService {
    /**
     * @param {object} [opts]
     * @param {string} [opts.logBaseDir] - Override for `LOG_BASE_DIR`, used
     *   only by tests to point the sweep at a fixture directory (mirrors
     *   `SystemLogTailService.js:73-78`).
     */
    constructor({ logBaseDir } = {}) {
        /** @type {string} */
        this._logBaseDir = logBaseDir || LOG_BASE_DIR;

        /** @type {NodeJS.Timeout|null} */
        this._timer = null;

        /** @type {string|null} toDateString() of the last day this instance swept. */
        this._lastSweepDay = null;
    }

    // ─── Lifecycle ────────────────────────────────────────────────────────────

    /**
     * Arms the sweep interval. Idempotent — calling twice while already
     * running is a no-op. Never runs a sweep synchronously (not on boot —
     * only on the interval) so a large first sweep never competes with
     * startup. No-op (one notice) when `LOG_RETENTION_DAYS` is literally
     * `"0"`.
     *
     * @returns {{ started: boolean, reason?: string }}
     */
    start() {
        if (this._timer) return { started: false, reason: "already-started" };

        if (process.env.LOG_RETENTION_DAYS === "0") {
            logger.notice(logRetentionMessages.LOG_RETENTION_DISABLED());
            return { started: false, reason: "disabled" };
        }

        this._timer = setInterval(() => {
            const today = new Date().toDateString();
            if (this._lastSweepDay === today) return;
            this._lastSweepDay = today;
            this._runSweep().catch(() => {
                /* _runSweep never throws — defensive only */
            });
        }, SWEEP_CHECK_MS);
        if (typeof this._timer.unref === "function") this._timer.unref();

        logger.notice(logRetentionMessages.LOG_RETENTION_STARTED(this._retentionDays(), SWEEP_CHECK_MS));
        return { started: true };
    }

    /**
     * Tears down the sweep interval. Safe to call when never started.
     */
    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    }

    // ─── Env-driven configuration (read live, not frozen at construction) ────

    /**
     * Resolves the current retention window, reading `LOG_RETENTION_DAYS`
     * live on every call (not cached at `start()`) so an operator's env
     * change is honored on the next sweep without a restart. `"0"` means
     * disabled. Unset/empty falls back to `DEFAULT_RETENTION_DAYS` silently
     * (the documented default, not an error). Non-numeric or `< 1` falls
     * back to `DEFAULT_RETENTION_DAYS` WITH one WARNING — `days >= 1` is a
     * safety floor, never a nicety: it is what keeps today's directory out
     * of candidacy.
     *
     * @returns {number} `0` (disabled) or a positive integer number of days.
     */
    _retentionDays() {
        const raw = process.env.LOG_RETENTION_DAYS;
        if (raw === undefined || raw === "") return DEFAULT_RETENTION_DAYS;
        if (raw === "0") return 0;

        const n = Number(raw);
        if (!Number.isFinite(n) || n < 1) {
            logger.warning(logRetentionMessages.LOG_RETENTION_INVALID_DAYS(raw, DEFAULT_RETENTION_DAYS));
            return DEFAULT_RETENTION_DAYS;
        }
        return Math.floor(n);
    }

    // ─── Sweep ────────────────────────────────────────────────────────────────

    /**
     * Runs one retention sweep. NEVER throws or rejects — every failure
     * mode (a bad day-directory, a missing `logBaseDir`, an unexpected
     * exception) is caught, logged, and folded into the returned summary.
     * See the deletion-safety contract in the file header.
     *
     * @returns {Promise<{ removedDays: number, freedBytes: number, failedDays: string[] }>}
     */
    async _runSweep() {
        const result = { removedDays: 0, freedBytes: 0, failedDays: [] };
        const days = this._retentionDays();
        if (days === 0) return result;

        try {
            const now = new Date();
            // Calendar arithmetic, NOT `days * 24h`: on a DST host a 25-hour day
            // moved the cutoff an hour late and made YESTERDAY a candidate,
            // breaking contract #2 above. The Date constructor normalises
            // `getDate() - days` across month/year boundaries.
            const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days);

            let yearEntries;
            try {
                yearEntries = await fs.readdir(this._logBaseDir, { withFileTypes: true });
            } catch {
                return result; // No logs directory yet — nothing to sweep.
            }

            let budgetHit = false;

            for (const yearEnt of yearEntries) {
                if (budgetHit) break;
                if (!yearEnt.isDirectory() || !YEAR_RE.test(yearEnt.name)) continue;
                const yearPath = path.join(this._logBaseDir, yearEnt.name);

                let monthEntries;
                try {
                    monthEntries = await fs.readdir(yearPath, { withFileTypes: true });
                } catch {
                    continue;
                }

                for (const monthEnt of monthEntries) {
                    if (budgetHit) break;
                    if (!monthEnt.isDirectory() || !MONTH_DAY_RE.test(monthEnt.name)) continue;
                    const monthPath = path.join(yearPath, monthEnt.name);

                    let dayEntries;
                    try {
                        dayEntries = await fs.readdir(monthPath, { withFileTypes: true });
                    } catch {
                        continue;
                    }

                    for (const dayEnt of dayEntries) {
                        if (budgetHit) break;
                        if (!dayEnt.isDirectory() || !MONTH_DAY_RE.test(dayEnt.name)) continue;

                        const y = Number(yearEnt.name);
                        const m = Number(monthEnt.name);
                        const d = Number(dayEnt.name);
                        const dirMidnight = new Date(y, m - 1, d);
                        // Only a name the logger could have written is a log day.
                        // `new Date()` silently rolls 2026/00/15 into Dec 2025 and
                        // maps years 0000-0099 to 1900+, which made numeric but
                        // impossible directories "old" and deleted them. The
                        // round-trip check rejects every rolled-over value.
                        const isCalendarDay =
                            !isNaN(dirMidnight.getTime()) &&
                            dirMidnight.getFullYear() === y &&
                            dirMidnight.getMonth() === m - 1 &&
                            dirMidnight.getDate() === d;
                        if (!isCalendarDay || !(dirMidnight < cutoff)) continue;

                        const dayLabel = `${yearEnt.name}-${monthEnt.name}-${dayEnt.name}`;
                        const dayPath = path.join(monthPath, dayEnt.name);

                        const removal = await this._removeDayDir(dayPath, dayLabel);
                        if (removal.vanished) continue; // someone else removed it first
                        if (removal.ok) {
                            result.removedDays++;
                            result.freedBytes += removal.freedBytes;
                        } else {
                            result.failedDays.push(dayLabel);
                            if (result.failedDays.length >= MAX_FAILED_DAYS_PER_SWEEP) budgetHit = true;
                        }
                    }

                    // Prune the month dir if now empty — best-effort, non-recursive.
                    // ENOTEMPTY (days remain inside the retention window) is the
                    // expected, common case and IS the safety property.
                    try {
                        await fs.rmdir(monthPath);
                    } catch {
                        /* ENOTEMPTY / ENOENT / EPERM — swallowed silently by design */
                    }
                }

                // Prune the year dir if now empty — same non-recursive rule.
                // `this._logBaseDir` itself is NEVER passed to rm/rmdir.
                try {
                    await fs.rmdir(yearPath);
                } catch {
                    /* ENOTEMPTY / ENOENT / EPERM — swallowed silently by design */
                }
            }

            if (budgetHit) {
                logger.warning(
                    logRetentionMessages.LOG_RETENTION_BUDGET_ABORT(
                        result.failedDays.length,
                        MAX_FAILED_DAYS_PER_SWEEP,
                    ),
                );
            }

            if (result.removedDays > 0) {
                logger.notice(
                    logRetentionMessages.LOG_RETENTION_SWEEP_DONE(
                        result.removedDays,
                        _formatBytes(result.freedBytes),
                        days,
                    ),
                );
            }

            return result;
        } catch (err) {
            logger.warning(logRetentionMessages.LOG_RETENTION_SWEEP_FAILED(err?.message ?? String(err)));
            return result;
        }
    }

    /**
     * Removes one `DD` day-directory: sums its file sizes, attempts
     * `fs.rm`, retries once after `RM_RETRY_DELAY_MS` on failure, then
     * verifies with `fs.stat` that it is truly gone (Windows `fs.rm` can
     * resolve without error and leave the directory behind). Never throws.
     *
     * @param {string} dirPath - Absolute path to the `DD` directory.
     * @param {string} dayLabel - `YYYY-MM-DD` label used in log messages.
     * @returns {Promise<{ ok: boolean, freedBytes: number, vanished?: boolean }>}
     *   `vanished` — the directory was already gone; neither removed nor failed.
     */
    async _removeDayDir(dirPath, dayLabel) {
        // Gone before we started (a concurrent sweep, or an operator) — not
        // ours to count. `fs.rm` runs with `force: true`, so without this check
        // a missing directory came back `ok` and inflated removedDays.
        try {
            await fs.stat(dirPath);
        } catch {
            return { ok: false, vanished: true, freedBytes: 0 };
        }

        let freedBytes = 0;
        try {
            freedBytes = await this._sumDirBytes(dirPath);
        } catch {
            freedBytes = 0; // Best-effort size accounting only — never blocks removal.
        }

        const attemptRemove = async () => {
            try {
                await fs.rm(dirPath, { recursive: true, force: true });
                return null;
            } catch (err) {
                return err;
            }
        };

        let rmError = await attemptRemove();
        if (rmError) {
            await new Promise((resolve) => setTimeout(resolve, RM_RETRY_DELAY_MS));
            rmError = await attemptRemove();
        }

        // Do not "simplify" this away — Windows fs.rm can return without
        // error and leave the directory (AV/indexer/open handle). Copied
        // from AuditLogService.js:1217-1262.
        let stillThere = false;
        try {
            await fs.stat(dirPath);
            stillThere = true;
        } catch {
            // Expected — directory is gone.
        }

        if (rmError || stillThere) {
            logger.warning(
                logRetentionMessages.LOG_RETENTION_DAY_FAILED(
                    dayLabel,
                    rmError ? rmError.message : "directory still present after rm",
                ),
            );
            return { ok: false, freedBytes: 0 };
        }

        return { ok: true, freedBytes };
    }

    /**
     * Recursively sums file sizes under `dirPath` (bounded to one `DD`
     * subtree). A file that vanishes between `readdir` and `stat` (e.g. a
     * concurrent delete) is skipped, not fatal — this number is a
     * best-effort operator metric, not a correctness input.
     *
     * @param {string} dirPath
     * @returns {Promise<number>}
     */
    async _sumDirBytes(dirPath) {
        let total = 0;
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            const entryPath = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
                total += await this._sumDirBytes(entryPath);
            } else if (entry.isFile()) {
                try {
                    const st = await fs.stat(entryPath);
                    total += st.size;
                } catch {
                    // Vanished between readdir and stat — skip.
                }
            }
        }
        return total;
    }
}

const instance = new LogRetentionService();
module.exports = instance;
module.exports.LogRetentionService = LogRetentionService;
