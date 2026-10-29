"use strict";

/**
 * @fileoverview ServerRunMarker - the cron-leader process keeps a tiny
 * JSON file so the NEXT boot can tell a clean stop from an unclean one.
 *
 * LIFECYCLE
 *   boot      readPrevious()  -> verdict (MUST run before start(): start()
 *                                overwrites the previous record)
 *             start()         -> writes RUNNING, heartbeats every 30 s (timer
 *                                unref'd), registers the synchronous `exit` hook
 *   stopping  noteStopping()  -> STOPPING (immediate write)
 *   forced    noteForcedExit()-> remembers FORCED_EXIT for the exit hook
 *   unsent    noteStopUnreported() -> the crash / forced-exit email was NOT sent
 *   exit      _onExit()       -> STOPPED + exit code + reason, SYNCHRONOUSLY
 *
 * WHY THIS DETECTS UNCLEAN RESTARTS: the `exit` event fires on every
 * `process.exit` (clean, crash, forced) and never on TerminateProcess, a
 * service kill or a host reset - exactly the boundary we need. A record still
 * RUNNING or STOPPING at the next boot means the previous process never ran its
 * exit hook. No DB is involved, so it works when the DB is what died.
 *
 * RULES THAT MATTER
 *   - The `exit` hook is registered only in start(), so a boot-fatal exit
 *     BEFORE start() leaves the previous record untouched.
 *   - The hook does sync I/O only and makes NO logger call (the logger is async
 *     and the line would be lost).
 *   - Writes are atomic: write `<file>.<pid>.tmp`, then rename over the target.
 *     On EPERM/EBUSY/EACCES from the rename (Windows antivirus / indexer lock)
 *     fall back to a direct write. Each tmp / fallback write is followed by a
 *     best-effort fsync (open r+, fsync, close; no `flush: true` because the pkg target is
 *     node18) so a power cut right after the call is less likely to leave an empty marker. A
 *     failing fsync is ignored and an empty file still reads UNREADABLE. Nothing here ever
 *     throws; a write failure logs one warning per process.
 *   - No secrets, env values or identifiers other than pid/host/version.
 *
 * May import fs, path, os, constants and message templates only - never the DB,
 * AlertNotifierService or Express.
 *
 * Security: CWE-377 (tmp file next to the target, pid-suffixed, same directory
 * ACL), CWE-22 (path comes from config/override, never from a request).
 */

const nodeFs = require("fs");
const os = require("os");
const path = require("path");
const { SERVER_RUN_MARKER } = require("../../constants/serverRunMarker");
const { serverMessages } = require("../../constants/messages/server.messages");

const { STATES, VERDICTS, STOP_REASONS } = SERVER_RUN_MARKER;
const RENAME_FALLBACK_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

/**
 * Resolves the marker file path. Same project-root rule as `changelog.model.js`:
 * next to the exe under pkg, the repo root otherwise; then `data/server-run.json`.
 * `SERVER_RUN_MARKER_PATH` (tests only) wins when it is an absolute path AND the
 * process is not a production one (`NODE_ENV !== "production"`):
 * a stray variable in a production .env must not move the marker (CWE-15).
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {{ path: string, ignoredOverride: string|null, ignoredReason: "relative"|"production"|null }}
 *   `ignoredOverride` is the rejected override value (so the caller can log it) and
 *   `ignoredReason` says why.
 */
function resolveMarkerPath(env = process.env) {
    const override = env[SERVER_RUN_MARKER.PATH_OVERRIDE_ENV];
    let ignoredOverride = null;
    let ignoredReason = null;
    if (override) {
        const allowed = env.NODE_ENV !== "production";
        if (!path.isAbsolute(override)) {
            ignoredOverride = override;
            ignoredReason = "relative";
        } else if (!allowed) {
            ignoredOverride = override;
            ignoredReason = "production";
        } else {
            return { path: override, ignoredOverride: null, ignoredReason: null };
        }
    }
    /* c8 ignore next 3 -- the process.pkg arm runs only inside the PKG binary. */
    const root = process.pkg ? path.dirname(process.execPath) : path.resolve(__dirname, "../../..");
    return { path: path.join(root, "data", SERVER_RUN_MARKER.FILE_NAME), ignoredOverride, ignoredReason };
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isTime = (v) => v === undefined || v === null || Number.isFinite(v);

/**
 * Shape check for a record read back from disk: an own STATES
 * key (never an inherited one such as "toString"), an integer pid, finite times
 * and a string version when present. Anything else reads UNREADABLE.
 * @param {object} rec
 * @returns {boolean}
 */
function isWellFormed(rec) {
    if (typeof rec.state !== "string" || !Object.hasOwn(STATES, rec.state)) return false;
    if (rec.pid !== undefined && !Number.isInteger(rec.pid)) return false;
    if (rec.version !== undefined && typeof rec.version !== "string") return false;
    for (const k of ["bootedAt", "lastHeartbeatAt", "lastStartNoticeAt", "stoppingAt", "stoppedAt"]) {
        if (!isTime(rec[k])) return false;
    }
    if (rec.stopEmailUnsent !== undefined && typeof rec.stopEmailUnsent !== "boolean") return false;
    const okList = (p) => p === undefined || isPlainObject(p) || (Array.isArray(p) && p.every(isPlainObject));
    return okList(rec.pendingUnclean) && okList(rec.pendingLeaderLost);
}

/** Most unreported unclean restarts kept in the record (oldest dropped first). */
const PENDING_UNCLEAN_MAX = 5;

/**
 * A record's pendingUnclean as a list (an rc.3 record held one object).
 * Capped on read too (CWE-770): a tampered record must not make one boot send hundreds of emails.
 */
function pendingList(p) {
    if (Array.isArray(p)) return p.filter(isPlainObject).slice(-PENDING_UNCLEAN_MAX);
    return isPlainObject(p) ? [p] : [];
}

/** Stable identity of one pending entry: the run's pid and boot time. */
function pendingKey(entry) {
    return `${entry?.pid ?? "?"}:${entry?.bootedAt ?? "?"}`;
}

/**
 * What the next boot needs to report an unclean restart that was not emailed.
 * @param {object} rec - the record that read UNCLEAN
 * @returns {object}
 */
function uncleanSnapshot(rec) {
    return {
        pid: rec.pid,
        version: rec.version,
        bootedAt: rec.bootedAt,
        lastHeartbeatAt: rec.lastHeartbeatAt,
        state: rec.state,
        stoppingAt: rec.stoppingAt,
        stopSignal: rec.stopSignal,
    };
}

class ServerRunMarker {
    /**
     * @param {object} deps
     * @param {string} deps.filePath - absolute marker path
     * @param {string} deps.runId - identity of this cluster run (see ClusterSupervisor)
     * @param {string} deps.version - package version, informational
     * @param {{warning: Function}} deps.logger
     * @param {number} [deps.intervalMs] - heartbeat period
     * @param {() => number} [deps.now]
     * @param {typeof import("fs")} [deps.fs]
     * @param {NodeJS.EventEmitter & {pid: number}} [deps.processRef]
     * @param {string} [deps.hostname]
     */
    constructor({
        filePath,
        runId,
        version,
        logger,
        intervalMs = SERVER_RUN_MARKER.HEARTBEAT_INTERVAL_MS,
        now = Date.now,
        fs = nodeFs,
        processRef = process,
        hostname = os.hostname(),
    }) {
        this._filePath = filePath;
        this._runId = runId;
        this._version = version;
        this._logger = logger;
        this._intervalMs = intervalMs;
        this._now = now;
        this._fs = fs;
        this._process = processRef;
        this._hostname = hostname;

        this._started = false;
        this._timer = null;
        this._warned = false;
        this._previous = null;
        this._lastStartNoticeAt = null;

        // Mutable record fields
        this._state = STATES.RUNNING;
        this._bootedAt = null;
        this._lastHeartbeatAt = null;
        this._stoppingAt = undefined;
        this._stopSignal = undefined;
        this._forcedAfterMs = undefined;
        this._reason = null;
        this._unreported = undefined;
        // The crash / forced-exit email itself failed (separate from `unreported`,
        // which a PRIMARY_DISCONNECT stop also sets), so the next notice never claims a sent email failed.
        this._stopEmailUnsent = undefined;
        // The highest exit code a crash raised during the stop (always wins),
        // when the record first said STOPPED, and an unclean restart not yet emailed.
        this._raisedExitCode = 0;
        this._stoppedAt = undefined;
        this._stoppedExitCode = undefined;
        this._verdict = null;
        this._pendingUnclean = undefined;
        // Cron-leader losses (HANDOVER + RUNNING) whose email failed; re-sent by a later boot.
        this._pendingLeaderLost = undefined;
    }

    /**
     * Reads the previous process's record. Synchronous; never throws.
     * MUST be called before start().
     *
     * @returns {{ verdict: string, previous: object|null, cause?: string }}
     */
    readPrevious() {
        let raw;
        try {
            raw = this._fs.readFileSync(this._filePath, "utf8");
        } catch (err) {
            if (err && err.code === "ENOENT") return { verdict: VERDICTS.FIRST_BOOT, previous: null };
            return { verdict: VERDICTS.UNREADABLE, previous: null, cause: err?.message ?? String(err) };
        }

        let rec;
        try {
            rec = JSON.parse(raw);
        } catch (err) {
            return { verdict: VERDICTS.UNREADABLE, previous: null, cause: err.message };
        }
        if (!rec || typeof rec !== "object" || rec.schema !== SERVER_RUN_MARKER.SCHEMA || !isWellFormed(rec)) {
            return { verdict: VERDICTS.UNREADABLE, previous: null, cause: "unexpected record shape" };
        }

        this._previous = rec;
        this._lastStartNoticeAt = Number.isFinite(rec.lastStartNoticeAt) ? rec.lastStartNoticeAt : null;

        // A record written on ANOTHER host (e.g. the build machine's smoke run, packaged
        // into dist\data by mistake) says nothing about this host's last run: FIRST_BOOT,
        // never a false CRITICAL. Its lastStartNoticeAt is not trusted either.
        if (rec.hostname && rec.hostname !== this._hostname) {
            this._previous = null;
            this._lastStartNoticeAt = null;
            return { verdict: VERDICTS.FIRST_BOOT, previous: null, cause: "record from another host" };
        }

        let verdict = VERDICTS.UNCLEAN;
        if (rec.state === STATES.STOPPED) verdict = VERDICTS.CLEAN;
        else if (rec.runId && rec.runId === this._runId) verdict = VERDICTS.HANDOVER;
        this._verdict = verdict;
        // Unclean restarts stay "pending" until their email was sent:
        // every one carried from the previous record PLUS this boot's own UNCLEAN
        // verdict, so none is dropped (review of ff794a36, M). Capped, oldest first out.
        const list = [...pendingList(rec.pendingUnclean), ...(verdict === VERDICTS.UNCLEAN ? [uncleanSnapshot(rec)] : [])];
        this._pendingUnclean = list.length ? list.slice(-PENDING_UNCLEAN_MAX) : undefined;
        // Same rule for a lost cron-leader worker: its WARNING email failing must not lose it.
        const lost = [
            ...pendingList(rec.pendingLeaderLost),
            ...(verdict === VERDICTS.HANDOVER && rec.state === STATES.RUNNING ? [uncleanSnapshot(rec)] : []),
        ];
        this._pendingLeaderLost = lost.length ? lost.slice(-PENDING_UNCLEAN_MAX) : undefined;
        return { verdict, previous: rec };
    }

    /** @returns {string} the marker file path */
    get filePath() {
        return this._filePath;
    }

    /** @returns {number|null} when the last "Server started" notice was sent (from the previous record). */
    lastStartNoticeAt() {
        return this._lastStartNoticeAt;
    }

    /** Writes RUNNING, starts the heartbeat and registers the exit hook. Idempotent. */
    start() {
        try {
            if (this._started) return;
            this._started = true;
            try {
                this._fs.mkdirSync(path.dirname(this._filePath), { recursive: true });
            } catch {
                /* the write below reports it once */
            }
            const t = this._now();
            this._state = STATES.RUNNING;
            this._bootedAt = t;
            this._lastHeartbeatAt = t;
            if (!this._write(this._record())) {
                // The previous run's record would otherwise survive: a STOPPED from an
                // earlier run would read CLEAN after this run is hard-killed.
                // Without it the next boot reads FIRST_BOOT ("previous run unknown").
                try {
                    this._fs.unlinkSync(this._filePath);
                } catch {
                    /* best effort */
                }
            }

            this._timer = setInterval(() => this._heartbeat(), this._intervalMs);
            if (this._timer && typeof this._timer.unref === "function") this._timer.unref();
            this._process.once("exit", (code) => this._onExit(code));
        } catch {
            /* never throws */
        }
    }

    /**
     * The graceful shutdown began. The reason is SIGNAL when the exit will be 0,
     * CRASH otherwise.
     *
     * @param {string} signal
     * @param {number} exitCode - the exit code the shutdown will end with
     * @param {{unreported?: boolean, reason?: string}} [opts] - `unreported`: this stop sent NO email at the time
     *   (e.g. PRIMARY_DISCONNECT), so the next boot must not say it was already reported.
     *   `reason`: a STOP_REASONS value that replaces the SIGNAL/CRASH default.
     */
    noteStopping(signal, exitCode, { unreported = false, reason } = {}) {
        try {
            if (!this._started) return;
            const t = this._now();
            this._state = STATES.STOPPING;
            this._stoppingAt = t;
            this._stopSignal = signal;
            this._lastHeartbeatAt = t;
            // A crash already raised the code (its email in flight): it stays CRASH
            // and reported, whatever stop follows.
            const crashed = this._raisedExitCode > 0;
            this._reason = !crashed && reason ? reason : exitCode === 0 && !crashed ? STOP_REASONS.SIGNAL : STOP_REASONS.CRASH;
            if (unreported && !crashed) this._unreported = true;
            this._write(this._record());
        } catch {
            /* never throws */
        }
    }

    /**
     * The shutdown failsafe fired; the process is about to exit(1). The next boot
     * must not raise a CRITICAL (the exit hook still writes STOPPED). Whether the
     * forced-exit email was actually sent is recorded separately: when it was not,
     * `noteStopUnreported()` is called and the next "Server started" copy says so.
     *
     * @param {number} ms - the failsafe delay that elapsed
     */
    noteForcedExit(ms) {
        try {
            if (!this._started) return;
            this._reason = STOP_REASONS.FORCED_EXIT;
            this._forcedAfterMs = ms;
            // After noteTeardownComplete the record is already STOPPED; keep it a
            // complete STOPPED record (a forced exit always ends with code 1).
            this._write(this._state === STATES.STOPPED ? this._stoppedRecord(1) : this._record());
        } catch {
            /* never throws */
        }
    }

    /**
     * The crash / forced-exit email for this stop was NOT sent (send failed, timed out or mail
     * is down). Marks the record `unreported` so the next boot's "Server started" notice says
     * the email could not be sent at the time and is not held back by the 15-minute throttle.
     * Works in every state; after STOPPED the complete STOPPED record is rewritten. Never throws.
     */
    noteStopUnreported() {
        try {
            if (!this._started) return;
            this._unreported = true;
            this._stopEmailUnsent = true;
            this._write(this._state === STATES.STOPPED ? this._stoppedRecord(this._stoppedExitCode) : this._record());
        } catch {
            /* never throws */
        }
    }

    /**
     * The shutdown's data work is done: audit rows flushed and the database
     * pools closed. Writes STOPPED now, BEFORE the last waits (the "Server
     * shutting down" email, the final alert flush), so a host reboot that kills
     * the process during those waits still reads CLEAN on the next boot. The
     * exit hook rewrites the record with the final exit code and reason, so a
     * crash or forced exit after this point is still recorded.
     *
     * @param {number} exitCode - the exit code the shutdown will end with
     */
    noteTeardownComplete(exitCode) {
        try {
            if (!this._started) return;
            this.stop();
            this._state = STATES.STOPPED;
            this._write(this._stoppedRecord(exitCode));
        } catch {
            /* never throws */
        }
    }

    /**
     * The exit code rose (a crash) AFTER noteTeardownComplete wrote STOPPED.
     * The crash handlers call this synchronously, before their EMERGENCY email
     * (up to 5 s), so a host reboot that kills the process in that window still
     * leaves a record saying the run ended after a crash, not a clean stop.
     * Does nothing while RUNNING or STOPPING: those already read UNCLEAN, and the
     * exit hook writes the final record.
     *
     * A raise that comes with `unreported` / `reason` (a PRIMARY_DISCONNECT that
     * arrived during a clean stop) keeps that: the
     * stop is recorded as the disconnect, not as a crash "reported when it happened".
     * The reason only replaces a clean SIGNAL stop, never a CRASH or FORCED_EXIT.
     *
     * @param {number} exitCode - the raised exit code
     * @param {{unreported?: boolean, reason?: string}} [opts]
     */
    noteExitCodeRaised(exitCode, { unreported = false, reason } = {}) {
        try {
            if (!this._started) return;
            // Only a still-clean stop takes the reason / unreported: a
            // crash that already raised the code (its EMERGENCY email in flight)
            // must stay CRASH and "reported", even if a disconnect follows.
            const wasClean = this._reason === STOP_REASONS.SIGNAL && this._raisedExitCode === 0;
            if (wasClean && reason) this._reason = reason;
            if (wasClean && unreported) this._unreported = true;
            // Remembered in every state, so a later noteTeardownComplete or the exit
            // hook can never record a lower code.
            this._raisedExitCode = Math.max(this._raisedExitCode, Number(exitCode) || 0);
            if (this._state === STATES.STOPPED) this._write(this._stoppedRecord(exitCode));
            else if (this._state === STATES.STOPPING && (unreported || reason)) this._write(this._record());
        } catch {
            /* never throws */
        }
    }

    /**
     * Pending unclean restarts were emailed: drop them from the record (all, or
     * only those whose `pendingKey` is in `keys`). Never throws.
     * @param {string[]} [keys]
     */
    clearPendingUnclean(keys) {
        try {
            if (this._pendingUnclean === undefined) return;
            // No keys: everything was reported. Keys: drop only the entries that were sent.
            const keep = Array.isArray(keys) ? this._pendingUnclean.filter((e) => !keys.includes(pendingKey(e))) : [];
            this._pendingUnclean = keep.length ? keep : undefined;
            if (this._started) {
                this._write(this._state === STATES.STOPPED ? this._stoppedRecord(this._stoppedExitCode) : this._record());
            }
        } catch {
            /* never throws */
        }
    }

    /**
     * Pending leader-lost entries were emailed: drop them (all, or only those whose `pendingKey`
     * is in `keys`). Mirrors clearPendingUnclean. Never throws.
     * @param {string[]} [keys]
     */
    clearPendingLeaderLost(keys) {
        try {
            if (this._pendingLeaderLost === undefined) return;
            const keep = Array.isArray(keys) ? this._pendingLeaderLost.filter((e) => !keys.includes(pendingKey(e))) : [];
            this._pendingLeaderLost = keep.length ? keep : undefined;
            if (this._started) {
                this._write(this._state === STATES.STOPPED ? this._stoppedRecord(this._stoppedExitCode) : this._record());
            }
        } catch {
            /* never throws */
        }
    }

    /** @param {number} atMs - when a "Server started" notice was sent */
    recordStartNotice(atMs) {
        try {
            this._lastStartNoticeAt = atMs;
            // After the data teardown the record must stay a complete STOPPED record.
            if (this._started) {
                this._write(this._state === STATES.STOPPED ? this._stoppedRecord(this._stoppedExitCode) : this._record());
            }
        } catch {
            /* never throws */
        }
    }

    /** Clears the heartbeat timer (tests only; the exit hook does the same). */
    stop() {
        try {
            if (this._timer) clearInterval(this._timer);
        } catch {
            /* never throws */
        }
        this._timer = null;
    }

    /**
     * The STOPPED record for exit code `code` (shared by the exit hook,
     * noteTeardownComplete, noteForcedExit, noteExitCodeRaised, recordStartNotice
     * and clearPendingUnclean). The code is never lower than one a crash raised,
     * and stoppedAt keeps the time the record first said STOPPED. A crash that arrived mid graceful-stop raises the
     * exit code after the reason was chosen: a non-zero exit is never a plain
     * SIGNAL stop.
     * @param {number|undefined} code
     * @returns {object}
     */
    _stoppedRecord(code) {
        const exitCode = Math.max(Number(code) || 0, this._raisedExitCode);
        let reason = this._reason ?? STOP_REASONS.EXIT;
        if (exitCode && reason === STOP_REASONS.SIGNAL) reason = STOP_REASONS.CRASH;
        if (this._stoppedAt === undefined) this._stoppedAt = this._now();
        this._stoppedExitCode = exitCode;
        return { ...this._record(), state: STATES.STOPPED, stoppedAt: this._stoppedAt, exitCode, stopReason: reason };
    }

    /** @returns {object} the record as it would be written now */
    _record() {
        return {
            schema: SERVER_RUN_MARKER.SCHEMA,
            state: this._state,
            pid: this._process.pid,
            hostname: this._hostname,
            version: this._version,
            runId: this._runId,
            bootedAt: this._bootedAt,
            lastHeartbeatAt: this._lastHeartbeatAt,
            lastStartNoticeAt: this._lastStartNoticeAt,
            stoppingAt: this._stoppingAt,
            stopSignal: this._stopSignal,
            forcedAfterMs: this._forcedAfterMs,
            unreported: this._unreported,
            stopEmailUnsent: this._stopEmailUnsent,
            pendingUnclean: this._pendingUnclean,
            pendingLeaderLost: this._pendingLeaderLost,
        };
    }

    /** @private heartbeat tick: only while RUNNING, so a STOPPING record is never overwritten. */
    _heartbeat() {
        try {
            if (this._state !== STATES.RUNNING) return;
            this._lastHeartbeatAt = this._now();
            this._write(this._record());
        } catch {
            /* never throws */
        }
    }

    /**
     * @private Synchronous `exit` hook. No logger calls: the logger is async.
     * @param {number} code
     */
    _onExit(code) {
        try {
            this.stop();
            this._write(this._stoppedRecord(code), { silent: true });
        } catch {
            /* never throws */
        }
    }

    /**
     * @private Best-effort flush of a just-written file to disk: open r+, fsync, close.
     * Any failure (missing fs method, EPERM, ...) is ignored. No directory fsync.
     * @param {string} p
     */
    _fsyncBestEffort(p) {
        let fd;
        try {
            fd = this._fs.openSync(p, "r+");
            this._fs.fsyncSync(fd);
        } catch {
            /* best effort */
        } finally {
            if (fd !== undefined) {
                try {
                    this._fs.closeSync(fd);
                } catch {
                    /* best effort */
                }
            }
        }
    }

    /**
     * @private Atomic write with the Windows rename-lock fallback.
     * @param {object} record
     * @param {{silent?: boolean}} [opts] - silent: no logging (exit hook)
     * @returns {boolean}
     */
    _write(record, { silent = false } = {}) {
        const json = JSON.stringify(record);
        const tmp = `${this._filePath}.${this._process.pid}.tmp`;
        try {
            // Owner read/write only, whatever the process umask (CWE-732).
            this._fs.writeFileSync(tmp, json, { mode: 0o600 });
            this._fsyncBestEffort(tmp);
            try {
                this._fs.renameSync(tmp, this._filePath);
            } catch (err) {
                if (!RENAME_FALLBACK_CODES.has(err && err.code)) throw err;
                this._fs.writeFileSync(this._filePath, json, { mode: 0o600 });
                this._fsyncBestEffort(this._filePath);
                try {
                    this._fs.unlinkSync(tmp);
                } catch {
                    /* best effort */
                }
            }
            return true;
        } catch (err) {
            try {
                this._fs.unlinkSync(tmp);
            } catch {
                /* best effort */
            }
            if (!silent && !this._warned) {
                this._warned = true;
                try {
                    this._logger.warning(
                        serverMessages.RUN_MARKER_WRITE_FAILED(this._filePath, err?.message ?? String(err)),
                        { _noNotify: true },
                    );
                } catch {
                    /* logging must never break the marker */
                }
            }
            return false;
        }
    }
}

module.exports = ServerRunMarker;
module.exports.resolveMarkerPath = resolveMarkerPath;
module.exports.pendingKey = pendingKey;
module.exports.pendingList = pendingList;
