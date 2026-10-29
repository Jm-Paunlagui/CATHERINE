"use strict";

/**
 * @fileoverview Scheduled DB Backup — filesystem store, chain index,
 * materialisation, and chain-safe pruning.
 *
 * WHAT THIS FILE DOES
 * --------------------
 * Owns everything about WHERE backup archives live on disk and HOW the
 * "which tables changed since the last run" chain is resolved. It never
 * touches Oracle directly — {@link BackupArchiveService.buildScheduledBackup}
 * does the reading/hashing/signing; this file decides FULL-vs-INCREMENTAL,
 * writes the result to disk atomically, and rebuilds an in-memory index by
 * reading every archive's OWN `manifest.json` back out — there is
 * deliberately no database table for backup state (a
 * `SERVER_BACKUP_LOG` table would sit inside `purgeTables.js`'s purge blast
 * radius, so purging the database would make the scheduler forget the very
 * backup that made that purge safe).
 *
 * HOW IT WORKS
 * ------------
 * `runBackup()` is the "take one backup right now and store it" primitive —
 * `BackupScheduleService` (a LATER step, not built here) is what decides
 * WHEN to call it. Every archive that isn't `trigger: "PURGE"` participates
 * in ONE ongoing chain: `runBackup` looks at the most-recently-created
 * SCHEDULED/MANUAL archive (`_chainHead`), decides whether the new one can
 * be `INCREMENTAL` off it or must be a forced `FULL` (no
 * previous archive, generation cap, a broken/missing/tampered chain member,
 * or `trigger === "PURGE"`), resolves the per-table `previousTableState` a
 * dedup decision needs, and hands all of that to
 * `BackupArchiveService.buildScheduledBackup`.
 *
 * `materialise(archiveId)` walks the chain for one archive and reassembles a
 * SELF-CONTAINED `FULL` zip with every table's JSONL pulled from wherever it
 * actually lives (the archive itself, or — for an `UNCHANGED` table — the
 * ONE `sourceArchiveId` its manifest already points at; pointers are always
 * exactly one hop by construction, see `BackupArchiveService._streamAndHashTables`)
 * plus a freshly computed signature. This is what `GET /backups/:id/download`
 * calls — an operator never has to reason about the chain. (The purge email is
 * a notification only — `BackupEmailService.sendPurgeNotification` — and
 * carries no archive.)
 *
 * `deleteArchive(archiveId)` is the MECHANICAL chain-safe delete: it refuses
 * (409, naming the dependents) when any OTHER retained archive still points
 * at this one for table data. Deciding WHICH archives are past
 * retention and should be swept is `BackupScheduleService`'s job — this
 * method just guarantees a single delete can never orphan a chain.
 *
 * Every method that accepts an `archiveId` validates it against an
 * allow-list pattern and rejects path separators / `..` / absolute paths
 * BEFORE doing anything else — and even then, the id is only ever used to
 * look the archive up in the in-memory index (`Array.find`), never
 * interpolated into a filesystem path directly (CWE-22). The path actually
 * used for any file operation always comes from the index entry's own
 * `.path`, which this file generated itself when it wrote the archive.
 *
 * `runBackup({ trigger: "MANUAL" })` is additionally gated by the
 * pre-scheduled-backup LOCKOUT WINDOW (a deliberate design choice) — refused with a
 * 409 BEFORE the FIFO mutex when a scheduled backup is imminent or already
 * running. `SCHEDULED`/`PURGE` triggers are never subject to it. See
 * `BackupScheduleService.getLockoutStatus`'s doc comment for the full
 * rationale, and `runBackup`'s own `@throws` for the mechanics.
 *
 * EXAMPLE
 * -------
 *   const BackupStoreService = require("./services/BackupStoreService");
 *   const { getAllTableNames } = require("./constants/purgeTables");
 *
 *   const run = await BackupStoreService.runBackup({
 *       trigger: "SCHEDULED",
 *       event: "NIGHTLY",
 *       eventId: 142,
 *       tables: getAllTableNames(),
 *   });
 *   // run -> { archiveId, filename, path, sizeBytes, mode, chain, ... }
 *
 *   const { zipBuffer, filename } = await BackupStoreService.materialise(run.archiveId);
 */

const fsPromises = require("fs").promises;
const path = require("path");
const crypto = require("crypto");
const { PassThrough } = require("stream");
const archiver = require("archiver");
const JSZip = require("jszip");
const ExcelJS = require("exceljs");

const { logger } = require("../utils/logger");
const { dataBackupMessages, watchdogMessages } = require("../constants/messages");
const { AppError, PURGE_ERRORS } = require("../constants/errors");
const { HTTP_STATUS } = require("../constants");
const { CryptoVault } = require("../utils/encryption/CryptoVault");
const { addNormalizedRow } = require("../utils/excelFormat");
const { runGuarded, currentScope } = require("../utils/progress/progress");
const { FileLease } = require("../utils/locks/FileLease");
const BackupArchiveService = require("./BackupArchiveService");

/** Default backup directory name when `DB_BACKUP_DIR` is unset. */
const DEFAULT_BACKUP_DIR = "db-backup";

/**
 * How long a rebuilt index is trusted before the next call re-reads the
 * directory. Deliberately short (this is a convenience cache for repeated
 * reads within one request burst, NOT a durability mechanism — the
 * filesystem is always the source of truth) and deliberately NOT an env
 * var: it is an internal cache-freshness knob, not a deployment concern.
 * Every write/delete calls {@link BackupStoreService.invalidateIndex}
 * explicitly, so correctness never depends on this TTL expiring.
 */
const INDEX_CACHE_TTL_MS = 15_000;

/** Forced-FULL generation cap fallback when `DB_BACKUP_FULL_EVERY` is unset. */
const DEFAULT_FULL_EVERY = 6;

/** Row cap per xlsx sheet fallback when `BACKUP_XLSX_ROW_CAP` is unset — mirrors `BackupArchiveService`'s own default so both summary workbooks behave identically. */
const DEFAULT_XLSX_ROW_CAP = 5000;

/** Cross-process run lease file (lives in the resolved backup dir). */
const BACKUP_LEASE_NAME = ".backup-run.lease";

/**
 * `archiveId` allow-list (CWE-22): matches exactly what
 * `BackupArchiveService.buildArchiveId` generates (`bk_<ISO>...`) — letters,
 * digits, underscore, hyphen, colon. No `/`, `\`, `.`, or whitespace, so a
 * value that passes this can never traverse a directory even if some future
 * code path mistakenly joined it into a path directly.
 */
const ARCHIVE_ID_PATTERN = /^[A-Za-z0-9_:-]+$/;

class BackupStoreService {
    /** @type {Array<object>|null} */
    static _indexCache = null;
    /** @type {number} */
    static _indexCacheAt = 0;

    // ─── Backup directory resolution (PKG-safe, never __dirname) ──

    /**
     * Resolves `DB_BACKUP_DIR` to an ABSOLUTE path. Mirrors
     * `src/utils/logger.js`'s `LOG_BASE_DIR` resolution exactly: under PKG
     * the snapshot filesystem is read-only and `__dirname` points inside it,
     * so the directory is always resolved relative to the compiled
     * executable's location (`process.execPath`) rather than the source
     * tree, and relative to `process.cwd()` otherwise (a Windows service can
     * start the exe with its working directory anywhere).
     *
     * @returns {string}
     */
    static _resolveBackupDir() {
        const dir = process.env.DB_BACKUP_DIR || DEFAULT_BACKUP_DIR;
        if (path.isAbsolute(dir)) return dir;
        return path.resolve(
            process.pkg ? path.dirname(process.execPath) : process.cwd(),
            dir,
        );
    }

    /**
     * Ensures the backup directory exists and returns its absolute path.
     *
     * @returns {Promise<string>}
     */
    static async _ensureDir() {
        const dir = BackupStoreService._resolveBackupDir();
        await fsPromises.mkdir(dir, { recursive: true });
        return dir;
    }

    // ─── Filename conventions ────────────────────────────────────────

    /**
     * Colon-free, millisecond-free ISO instant safe for a Windows filename —
     * `2026-07-02T06:14:59.123Z` -> `2026-07-02T06-14-59Z`.
     *
     * @param {Date} [at]
     * @returns {string}
     * @private
     */
    static _filenameTimestamp(at = new Date()) {
        return at
            .toISOString()
            .replace(/\.\d{3}Z$/, "Z")
            .replace(/:/g, "-");
    }

    /**
     * Builds the on-disk filename for one archive, per the three
     * filename patterns. Distinct from `archiveId` (which keeps colons and is never
     * used as a path segment directly) — this IS a path segment.
     *
     * @param {object} params
     * @param {"SCHEDULED"|"MANUAL"|"PURGE"} params.trigger
     * @param {string|null} [params.event]
     * @param {number|string|null} [params.eventId]
     * @param {Date} [params.at]
     * @returns {string}
     *
     * @example
     * BackupStoreService._buildFilename({ trigger: "SCHEDULED", event: "NIGHTLY", eventId: 142 });
     * // -> "app-backup_142_NIGHTLY_2026-07-02T06-14-59Z.zip"
     */
    static _buildFilename({
        trigger,
        event = null,
        eventId = null,
        at = new Date(),
    }) {
        const ts = BackupStoreService._filenameTimestamp(at);
        if (trigger === "SCHEDULED" && eventId != null && event) {
            return `app-backup_${eventId}_${event}_${ts}.zip`;
        }
        if (trigger === "MANUAL") return `app-backup_manual_${ts}.zip`;
        if (trigger === "PURGE") return `app-backup_purge_${ts}.zip`;
        // Defensive fallback — unreachable in practice because every real
        // call path validates `trigger` against BackupArchiveService.BACKUP_TRIGGERS first.
        return `app-backup_${String(trigger).toLowerCase()}_${ts}.zip`;
    }

    // ─── Atomic write (a crash mid-write must never publish a truncated file) ──

    /**
     * Streams `buffer` to `<filePath>.part`, `fsync`s it, then `fs.rename`s
     * it into place. A process crash between the write and the rename
     * leaves only a `.part` file — {@link BackupStoreService._loadIndex}
     * only ever globs `*.zip`, so a `.part` file is structurally invisible
     * to the index and can never be treated as a valid chain member.
     *
     * @param {string} filePath - Final destination — MUST already be inside the resolved backup dir (callers only ever pass a path this file itself built).
     * @param {Buffer} buffer
     * @param {object} [opts]
     * @param {AbortSignal} [opts.signal] - If aborted right before the rename, the `.part` is removed and the abort reason thrown, so an abandoned (watchdog-cancelled) build that resumes later can never publish.
     * @returns {Promise<void>}
     */
    static async _atomicWrite(filePath, buffer, { signal } = {}) {
        await BackupStoreService._ensureDir();
        const partPath = `${filePath}.part`;
        try {
            const handle = await fsPromises.open(partPath, "w");
            try {
                await handle.writeFile(buffer);
                await handle.sync();
            } finally {
                await handle.close();
            }
            if (signal?.aborted) {
                throw signal.reason instanceof Error
                    ? signal.reason
                    : new Error("Backup write aborted.");
            }
            await fsPromises.rename(partPath, filePath);
        } catch (err) {
            // Best effort (ENOENT or otherwise) — the next lease holder's sweep removes leftovers.
            await fsPromises.unlink(partPath).catch(() => {});
            throw err;
        }
    }

    /**
     * Deletes every `*.zip.part` in the backup dir. ONLY safe inside the
     * cross-process lease (no writer can exist then).
     *
     * @returns {Promise<number>} Files removed.
     * @private
     */
    static async _sweepStaleParts() {
        const dir = await BackupStoreService._ensureDir();
        let names;
        try {
            names = await fsPromises.readdir(dir);
        } catch (err) {
            if (err.code === "ENOENT") return 0;
            throw err;
        }
        let removed = 0;
        for (const name of names) {
            if (!name.endsWith(".zip.part")) continue;
            try {
                await fsPromises.unlink(path.join(dir, name));
                removed += 1;
            } catch (err) {
                if (err.code !== "ENOENT") throw err;
            }
        }
        if (removed > 0) {
            logger.notice(dataBackupMessages.BACKUP_STALE_PARTS_REMOVED(removed));
        }
        return removed;
    }

    /** Idle-limit bounds (ms) — the floor stays above the 60 s single-call DB timeout. */
    static IDLE_LIMIT_MIN_MS = 65_000;
    static IDLE_LIMIT_MAX_MS = 3_600_000;
    static IDLE_LIMIT_DEFAULT_MS = 600_000;

    /**
     * Backup idle limit (ms) from `DB_BACKUP_IDLE_TIMEOUT_MS`, default
     * 600000, clamped to [65000, 3600000]. An out-of-range or non-numeric
     * value is clamped / defaulted AND reported once per call through
     * `WATCHDOG_LIMIT_CLAMPED` (same template as `REQUEST_IDLE_*`) so a
     * misconfigured `.env` is visible. A method so tests can stub it.
     * (`requestWatchdog._clamp` is module-private; kept local rather than
     * editing that file.)
     *
     * @returns {number}
     * @private
     */
    static _idleLimitMs() {
        const name = "DB_BACKUP_IDLE_TIMEOUT_MS";
        const rawEnv = process.env[name];
        const { IDLE_LIMIT_MIN_MS: min, IDLE_LIMIT_MAX_MS: max, IDLE_LIMIT_DEFAULT_MS: dflt } = BackupStoreService;
        if (rawEnv === undefined || rawEnv === "") return dflt;
        const parsed = Number.parseInt(rawEnv, 10);
        const applied = Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : dflt;
        if (!Number.isFinite(parsed) || applied !== parsed) {
            logger.warning(watchdogMessages.WATCHDOG_LIMIT_CLAMPED(name, rawEnv, applied));
        }
        return applied;
    }

    // ─── Path safety (CWE-22) ───────────────────────────────────────────────────

    /**
     * Validates an `archiveId` BEFORE it is used for anything — including
     * the index lookup. Rejects any value that is not a plain string
     * matching {@link ARCHIVE_ID_PATTERN}, or that contains a path
     * separator, `..`, or is an absolute path outright.
     *
     * @param {unknown} rawId
     * @returns {string} The same value, now trusted to look up in the index.
     * @throws {AppError} 400 `BACKUP_ARCHIVE_ID_INVALID` — never leaks the rejected value into the error itself (only into the log line, truncated).
     */
    static _validateArchiveId(rawId) {
        const invalid =
            typeof rawId !== "string" ||
            rawId.length === 0 ||
            rawId.length > 200 ||
            rawId.includes("..") ||
            rawId.includes("/") ||
            rawId.includes("\\") ||
            rawId.includes("\0") ||
            path.isAbsolute(rawId) ||
            !ARCHIVE_ID_PATTERN.test(rawId);

        if (invalid) {
            logger.warning(dataBackupMessages.PATH_SAFETY_REJECTED(rawId));
            throw new AppError(
                PURGE_ERRORS.BACKUP_ARCHIVE_ID_INVALID,
                HTTP_STATUS.BAD_REQUEST,
                {
                    type: "ValidationError",
                    details: [
                        {
                            field: "archiveId",
                            issue: 'Must not contain "/", "\\", "..", or be an absolute path.',
                        },
                    ],
                },
            );
        }
        return rawId;
    }

    // ─── Index (no DB table, derived from manifests on disk) ──────

    /**
     * Rebuilds (or returns the cached copy of) the in-memory archive index —
     * one entry per `*.zip` file in the backup directory, each entry being
     * that archive's OWN `manifest.json` content plus `filename`/`path`/
     * `sizeBytes`. A `.zip` that cannot be read as a valid archive (corrupt,
     * mid-copy, foreign file) is skipped with a `warning` log, never thrown —
     * one bad file must not take the whole Backup tab down.
     *
     * @param {object} [opts]
     * @param {boolean} [opts.force=false] - Bypass the TTL cache and re-read the directory now.
     * @returns {Promise<Array<object>>} Every field of each archive's manifest, plus `filename`/`path`/`sizeBytes`.
     */
    static async _loadIndex({ force = false } = {}) {
        const now = Date.now();
        if (
            !force &&
            BackupStoreService._indexCache &&
            now - BackupStoreService._indexCacheAt < INDEX_CACHE_TTL_MS
        ) {
            return BackupStoreService._indexCache;
        }

        const startedAt = Date.now();
        const dir = await BackupStoreService._ensureDir();

        let filenames;
        try {
            filenames = await fsPromises.readdir(dir);
        } catch (err) {
            if (err.code === "ENOENT") filenames = [];
            else throw err;
        }
        // `.zip.part` files never match `.endsWith(".zip")` — a crash
        // mid-write is structurally invisible here, no extra filtering needed.
        const zipFilenames = filenames.filter((f) => f.endsWith(".zip"));

        const entries = [];
        for (const filename of zipFilenames) {
            const filePath = path.join(dir, filename);
            try {
                // Sequential index rebuild; bounded by archive count and only runs on TTL expiry.
                const stat = await fsPromises.stat(filePath);
                const buffer = await fsPromises.readFile(filePath);
                const zip = await JSZip.loadAsync(buffer);
                const manifestEntry = zip.file("manifest.json");
                if (!manifestEntry)
                    throw new Error("manifest.json missing from archive");
                const manifestText = await manifestEntry.async("string");
                const manifest = JSON.parse(manifestText);
                entries.push({
                    ...manifest,
                    filename,
                    path: filePath,
                    sizeBytes: stat.size,
                });
            } catch (err) {
                logger.warning(
                    dataBackupMessages.INDEX_ENTRY_UNREADABLE(filename, err),
                );
            }
        }

        BackupStoreService._indexCache = entries;
        BackupStoreService._indexCacheAt = now;
        logger.debug(
            dataBackupMessages.INDEX_REBUILT(
                entries.length,
                Date.now() - startedAt,
            ),
        );

        return entries;
    }

    /**
     * Forces the next {@link BackupStoreService._loadIndex} call to re-read
     * the directory instead of serving the TTL cache. Called after every
     * write and every delete — correctness never depends on the TTL
     * expiring on its own.
     *
     * @returns {void}
     */
    static invalidateIndex() {
        BackupStoreService._indexCache = null;
        BackupStoreService._indexCacheAt = 0;
    }

    /**
     * Active SUPER_ADMIN count — the population the backup delete-vote
     * majority is computed over.
     *
     * @returns {Promise<number>}
     */
    static async countActiveSuperAdmins() {
        const AdminModel = require("../models/admin.model");
        return AdminModel.countActiveByRole("SUPER_ADMIN", null);
    }

    /**
     * Public listing — every archive currently on disk, newest first.
     * Enriches each entry with pending vote status from
     * `BackupVoteModel.findAllPendingVotes()`.
     *
     * @returns {Promise<Array<object>>}
     */
    static async listArchives() {
        const BackupVoteModel = require("../models/backup-vote.model");

        const index = await BackupStoreService._loadIndex();
        const sorted = index
            .slice()
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        // Enrich with vote status — O(archives * pendingVotes), both small.
        const pendingVotes = await BackupVoteModel.findAllPendingVotes();
        const activeSuperAdmins = await BackupStoreService.countActiveSuperAdmins();
        const votesNeeded = Math.floor(activeSuperAdmins / 2) + 1;

        const voteMap = new Map(pendingVotes.map((v) => [v.archiveId, v]));

        return sorted.map((entry) => {
            const pending = voteMap.get(entry.archiveId);
            return {
                ...entry,
                deleteVote: pending
                    ? {
                          requestedBy: pending.requestedBy,
                          votesNeeded,
                          votesCast: pending.votes.length,
                          voters: pending.votes,
                      }
                    : null,
            };
        });
    }

    /**
     * @param {string} archiveIdRaw
     * @returns {Promise<object>}
     * @throws {AppError} 400 invalid id, 404 not found.
     */
    static async getArchive(archiveIdRaw) {
        const archiveId = BackupStoreService._validateArchiveId(archiveIdRaw);
        const index = await BackupStoreService._loadIndex();
        const entry = index.find((e) => e.archiveId === archiveId);
        if (!entry) {
            throw new AppError(
                PURGE_ERRORS.BACKUP_ARCHIVE_NOT_FOUND,
                HTTP_STATUS.NOT_FOUND,
                { type: "NotFoundError" },
            );
        }
        return entry;
    }

    // ─── Signature re-verification (chain integrity + materialise) ────────────

    /**
     * Re-verifies one archive buffer's signature — the SAME recompute-then-
     * `CryptoVault.verifyRecord` procedure `DataRestoreService._verifyAndParseArchive`
     * uses, reduced to a boolean (no throwing, no row parsing — this is a
     * cheap "is this file still trustworthy" check used while resolving the
     * chain and before materialising, not a restore).
     *
     * @param {Buffer} buffer
     * @returns {Promise<boolean>}
     * @private
     */
    static async _verifyZipBuffer(buffer) {
        try {
            const zip = await JSZip.loadAsync(buffer);
            const manifestEntry = zip.file("manifest.json");
            const signatureEntry = zip.file("signature.json");
            if (!manifestEntry || !signatureEntry) return false;

            const manifestBuffer = Buffer.from(
                await manifestEntry.async("nodebuffer"),
            );
            const signatureBuffer = Buffer.from(
                await signatureEntry.async("nodebuffer"),
            );
            const signatureDoc = JSON.parse(signatureBuffer.toString("utf8"));

            const dataFileNames = Object.keys(zip.files).filter(
                (name) =>
                    name.startsWith("data/") &&
                    name.endsWith(".jsonl") &&
                    !zip.files[name].dir,
            );
            const dataBuffers = {};
            for (const name of dataFileNames) {
                // Sequential zip entry extraction, archives are small in entry count.
                dataBuffers[name] = Buffer.from(
                    await zip.file(name).async("nodebuffer"),
                );
            }

            const filesToHash = {
                "manifest.json": manifestBuffer,
                ...dataBuffers,
            };
            const recomputed = {};
            for (const [name, buf] of Object.entries(filesToHash)) {
                recomputed[name] = crypto
                    .createHash("sha256")
                    .update(buf)
                    .digest("hex");
            }

            const declared =
                signatureDoc &&
                typeof signatureDoc.files === "object" &&
                signatureDoc.files !== null
                    ? signatureDoc.files
                    : {};
            const declaredNames = Object.keys(declared).sort();
            const recomputedNames = Object.keys(recomputed).sort();
            const setMatches =
                declaredNames.length === recomputedNames.length &&
                declaredNames.every((n, i) => n === recomputedNames[i]);
            if (!setMatches) return false;
            const contentMatches = recomputedNames.every(
                (n) => declared[n] === recomputed[n],
            );
            if (!contentMatches) return false;

            return await CryptoVault.verifyRecord(
                "APP_BACKUP_ARCHIVE",
                recomputed,
                signatureDoc?.digest,
            );
        } catch {
            return false;
        }
    }

    /**
     * @param {object} entry - An index entry (has `.path`).
     * @returns {Promise<boolean>}
     * @private
     */
    static async _verifyArchiveFile(entry) {
        try {
            const buffer = await fsPromises.readFile(entry.path);
            return await BackupStoreService._verifyZipBuffer(buffer);
        } catch {
            return false;
        }
    }

    // ─── Chain resolution + forceFull decision ─────────────────────

    /**
     * Finds the current chain head — the most-recently-created archive
     * whose `trigger` is NOT `"PURGE"` (purge backups never join the chain).
     * Assumes at most one live lineage at a time: once a new
     * `FULL` archive starts a fresh `baseArchiveId`, it immediately becomes
     * the head (it is, by definition, the most recent), and the previous
     * lineage simply stops being extended (its members remain on disk until
     * pruned, but are no longer the head).
     *
     * @param {Array<object>} index
     * @returns {object|null}
     * @private
     */
    static _chainHead(index) {
        const candidates = index.filter(
            (e) => e.trigger !== "PURGE" && e.chain,
        );
        if (candidates.length === 0) return null;
        return candidates
            .slice()
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
    }

    /**
     * Decides `mode`/`chain`/`previousTableState` for a new archive about to
     * be built, per the forced-FULL rules, evaluated in order:
     *   1. `trigger === "PURGE"` — never joins the chain.
     *   2. No previous (non-purge) archive exists.
     *   3. The generation the new archive WOULD get (`head.chain.generation + 1`)
     *      has reached `DB_BACKUP_FULL_EVERY`.
     *   4. Any archive the head's manifest actually references (its own
     *      file, plus every distinct `sourceArchiveId` an `UNCHANGED` table
     *      points at) is missing from the index or fails signature
     *      verification.
     * Otherwise: `INCREMENTAL`, continuing the head's chain, with
     * `previousTableState` resolved for every table the head covered.
     *
     * @param {object} params
     * @param {"SCHEDULED"|"MANUAL"|"PURGE"} params.trigger
     * @param {Array<object>} params.index
     * @returns {Promise<{
     *   mode: "FULL"|"INCREMENTAL",
     *   chain: { baseArchiveId: string, generation: number }|null,
     *   previousTableState: Record<string, { sha256: string, sourceArchiveId: string }>,
     *   forcedFullReason: string|null,
     * }>}
     */
    static async _decideChain({ trigger, index }) {
        if (trigger === "PURGE") {
            return {
                mode: "FULL",
                chain: null,
                previousTableState: {},
                forcedFullReason:
                    "trigger is PURGE — purge backups never join the scheduled-backup chain",
            };
        }

        const head = BackupStoreService._chainHead(index);
        if (!head) {
            return {
                mode: "FULL",
                chain: null,
                previousTableState: {},
                forcedFullReason: "no previous archive exists",
            };
        }

        const fullEvery =
            Number(process.env.DB_BACKUP_FULL_EVERY) || DEFAULT_FULL_EVERY;
        const nextGeneration = (head.chain?.generation ?? 0) + 1;
        if (nextGeneration >= fullEvery) {
            return {
                mode: "FULL",
                chain: null,
                previousTableState: {},
                forcedFullReason: `chain generation cap reached (next generation ${nextGeneration} >= DB_BACKUP_FULL_EVERY=${fullEvery})`,
            };
        }

        // Every archive the head's manifest actually points at must be
        // present and signature-valid — its own file (INCLUDED tables live
        // there) plus every distinct sourceArchiveId an UNCHANGED table names.
        const referencedIds = new Set([head.archiveId]);
        for (const state of Object.values(head.tables ?? {})) {
            if (state.state === "UNCHANGED" && state.sourceArchiveId)
                referencedIds.add(state.sourceArchiveId);
        }

        for (const refId of referencedIds) {
            const refEntry = index.find((e) => e.archiveId === refId);
            if (!refEntry) {
                return {
                    mode: "FULL",
                    chain: null,
                    previousTableState: {},
                    forcedFullReason: `chain member "${refId}" is missing from disk`,
                };
            }
            // referencedIds is small and bounded (chain pointers are always exactly 1 hop by construction).
            const valid = await BackupStoreService._verifyArchiveFile(refEntry);
            if (!valid) {
                return {
                    mode: "FULL",
                    chain: null,
                    previousTableState: {},
                    forcedFullReason: `chain member "${refId}" failed signature verification`,
                };
            }
        }

        const previousTableState = {};
        for (const [table, state] of Object.entries(head.tables ?? {})) {
            previousTableState[table] = {
                sha256: state.sha256,
                sourceArchiveId:
                    state.state === "INCLUDED"
                        ? head.archiveId
                        : state.sourceArchiveId,
            };
        }

        return {
            mode: "INCREMENTAL",
            chain: {
                baseArchiveId: head.chain.baseArchiveId,
                generation: nextGeneration,
            },
            previousTableState,
            forcedFullReason: null,
        };
    }

    // ─── Chain-race mutex (backup chain race fix) ──────────────────────────────

    /**
     * FIFO promise-chain mutex tail. Every {@link BackupStoreService.runBackup}
     * call — regardless of `trigger` (`SCHEDULED`, `MANUAL`, or `PURGE`) —
     * queues onto this SAME tail before it may read the chain head, so two
     * calls can never both decide `INCREMENTAL` off the same generation and
     * fork the lineage.
     *
     * Why this lives HERE and not in a caller: `BackupScheduleService._backupRunning`
     * only guards `triggerScheduledBackup` (the `SCHEDULED` path). `MANUAL`
     * ("Back Up Now") goes through `DataPurgeController.manualBackup` and
     * `PURGE` goes through `DataPurgeService.executePurge` — both call
     * `BackupStoreService.runBackup` directly, bypassing that flag entirely.
     * A cron `SCHEDULED` backup racing an admin's `MANUAL` click both read
     * the same `_chainHead` and both decide `INCREMENTAL` off generation
     * *N*; whichever `_atomicWrite` lands second silently orphans the
     * other's `UNCHANGED` pointers, surfacing weeks later as
     * `BACKUP_CHAIN_MEMBER_MISSING` on restore. Locking inside `runBackup`
     * itself is the only place that covers every trigger uniformly.
     *
     * **Cross-process scope.** This mutex only serialises ONE Node process.
     * Across cluster workers, {@link BackupStoreService.runBackup} also takes
     * a {@link FileLease} (`.backup-run.lease` in the backup dir): `wx`
     * create, token-checked release, heartbeat that advances only while the
     * holder makes progress, stale = dead pid OR no progress for
     * `DB_BACKUP_IDLE_TIMEOUT_MS + 60 s`. The chain head is re-read
     * (`_loadIndex({ force: true })`) inside the lease so a worker never
     * decides off a stale cached index.
     *
     * @type {Promise<void>}
     * @private
     */
    static _runBackupLockTail = Promise.resolve();

    /**
     * Runs `fn` exclusively, queueing FIFO behind every previously-queued
     * caller — never a spin/poll loop. Fair because each call synchronously
     * chains onto whatever `_runBackupLockTail` currently is at the moment
     * it is called, and JS's single-threaded run-to-completion semantics
     * mean two `runBackup()` invocations started back-to-back always chain
     * in the order they were called.
     *
     * The lock is released whether `fn` resolves OR rejects — `_runBackupLockTail`
     * is reassigned to a version of the result that NEVER rejects
     * (`.then(() => undefined, () => undefined)`), so one backup throwing
     * can never wedge every later queued backup. The actual outcome
     * (including a rejection) is still returned to the ORIGINAL caller via
     * `result`, unaffected by that swallow.
     *
     * @param {() => Promise<any>} fn
     * @returns {Promise<any>}
     * @private
     */
    static _withRunBackupLock(fn) {
        const waiterScope = currentScope();
        const queued = BackupStoreService._runLockDepth > 0;
        BackupStoreService._runLockDepth += 1;
        // A caller queued behind a running backup follows the holder's scope:
        // it is alive exactly while the holder progresses (same pattern as the
        // CacheMiddleware coalescing follower) and is cut with it when the
        // holder goes quiet, never while a progressing backup holds the lock.
        if (queued && waiterScope) {
            waiterScope.follow({
                get lastProgressAt() {
                    return BackupStoreService._runHolderScope?.lastProgressAt ?? 0;
                },
            });
        }
        const run = async () => {
            if (queued && waiterScope) waiterScope.unfollow();
            BackupStoreService._runHolderScope = waiterScope ?? null;
            try {
                return await fn();
            } finally {
                BackupStoreService._runHolderScope = null;
                BackupStoreService._runLockDepth -= 1;
            }
        };
        const result = BackupStoreService._runBackupLockTail.then(run, run);
        BackupStoreService._runBackupLockTail = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    /** Callers currently holding or queued on the in-process run lock. @type {number} @private */
    static _runLockDepth = 0;

    /**
     * Scope whose progress a queued caller follows: the holder's caller scope
     * while it takes the lease, then the guarded backup scope. @type {object|null} @private
     */
    static _runHolderScope = null;

    // ─── Orchestration — build ONE archive right now and store it ─────────────

    /**
     * Builds one backup archive (chain-aware, per {@link BackupStoreService._decideChain})
     * and writes it to disk atomically. This is the mechanical "take a
     * backup now" primitive — deciding WHETHER now is the right time
     * (schedule, catch-up window) is `BackupScheduleService`'s job (a later
     * step), not this method's. The chain-decision + build + write sequence
     * below runs under {@link BackupStoreService._withRunBackupLock} so
     * concurrent calls from ANY trigger (cron, "Back Up Now", a purge
     * backup) serialise instead of racing the chain head — see that
     * method's doc comment for the full rationale and the
     * cross-process lease description.
     *
     * @param {object} params
     * @param {"SCHEDULED"|"MANUAL"|"PURGE"} params.trigger
     * @param {string|null} [params.event]
     * @param {number|string|null} [params.eventId]
     * @param {string[]} params.tables - Registry table names, e.g. `getAllTableNames()`.
     * @param {string|null} [params.requestId]
     * @param {number|string|null} [params.createdBy]
     * @param {Date} [params.at] - Defaults to `new Date()`. Override in tests for determinism — `archiveId`/filename are second-granularity, so two real calls within the same wall-clock second would otherwise collide.
     * @returns {Promise<{
     *   archiveId: string, filename: string, path: string, sizeBytes: number,
     *   mode: "FULL"|"INCREMENTAL", chain: {baseArchiveId:string,generation:number}|null,
     *   totalRows: number, tableCount: number, includedCount: number, unchangedCount: number,
     *   forcedFullReason: string|null,
     * }>}
     * @throws {Error} When `trigger` is not one of `BackupArchiveService.BACKUP_TRIGGERS`, or `tables` is empty.
     * @throws {AppError} 409 — `trigger === "MANUAL"` AND a scheduled backup
     *   is imminent or currently running (pre-scheduled-backup lockout
     *   window — see
     *   {@link BackupScheduleService.getLockoutStatus}'s doc comment).
     *   `SCHEDULED` and `PURGE` triggers are NEVER rejected by this check —
     *   see that same doc comment for why.
     *
     * @example
     * const run = await BackupStoreService.runBackup({
     *     trigger: "MANUAL", tables: getAllTableNames(), createdBy: 10234,
     * });
     */
    static async runBackup({
        trigger,
        event = null,
        eventId = null,
        tables,
        requestId = null,
        createdBy = null,
        at = new Date(),
    }) {
        if (!BackupArchiveService.BACKUP_TRIGGERS.includes(trigger)) {
            throw new Error(
                `BackupStoreService.runBackup: trigger must be one of [${BackupArchiveService.BACKUP_TRIGGERS.join(", ")}].`,
            );
        }
        if (!Array.isArray(tables) || tables.length === 0) {
            throw new Error(
                "BackupStoreService.runBackup: `tables` must be a non-empty array.",
            );
        }

        // Pre-scheduled-backup lockout window — MANUAL
        // ("Back Up Now") ONLY. Deliberately OUTSIDE/BEFORE the mutex below:
        // the whole point is to refuse up front instead of silently
        // queueing behind an imminent scheduled run and firing at an
        // unpredictable moment. `SCHEDULED` (this file's own scheduler
        // caller) and `PURGE` (the purge-gating backup,
        // `DataPurgeService.backup`) are NEVER subject to this check — a
        // scheduled backup can never lock itself out, and a purge that
        // already has an operator's go-ahead still needs its own
        // pre-purge backup to succeed regardless of the window; both still
        // correctly SERIALISE behind a concurrently-running backup via the
        // FIFO mutex a few lines down, unaffected by this early return.
        // Lazy require — BackupScheduleService requires THIS file at
        // module top, so an eager top-level require here would be
        // circular.
        if (trigger === "MANUAL") {
            const BackupScheduleService = require("./BackupScheduleService");
            const lockout = await BackupScheduleService.getLockoutStatus();
            if (lockout.active) {
                logger.warning(
                    dataBackupMessages.MANUAL_BACKUP_BLOCKED_SCHEDULE_WINDOW(
                        lockout.reason,
                        lockout.msRemaining,
                    ),
                );
                throw new AppError(
                    PURGE_ERRORS.MANUAL_BACKUP_SCHEDULE_WINDOW,
                    HTTP_STATUS.CONFLICT,
                    {
                        type: "ConflictError",
                        hint: BackupScheduleService.describeLockout(lockout),
                    },
                );
            }
        }

        // Everything from here on — chain-head read through the atomic
        // write — is the critical section (backup chain race fix). Argument
        // validation above deliberately stays OUTSIDE the lock: a caller
        // with a bad `trigger`/`tables` should fail immediately, not queue
        // behind an unrelated in-flight backup.
        const idleLimitMs = BackupStoreService._idleLimitMs();
        const archiveId = BackupArchiveService.buildArchiveId({
            trigger,
            event,
            eventId,
            at,
        });
        // The stall callback only RECORDS the cut; the outcome is logged by
        // `_resolveCut` once it is known whether a publish raced the cut (a
        // complete .zip can land after the watchdog fired).
        const stall = { error: null, idleMs: 0, lastSource: "unknown" };
        const onStall = (scope, idleMs) => {
            stall.idleMs = idleMs;
            stall.lastSource = scope.lastSource;
            stall.error = new AppError(PURGE_ERRORS.BACKUP_STALLED, HTTP_STATUS.SERVICE_UNAVAILABLE, {
                type: "BackupStalledError",
            });
            return stall.error;
        };
        /** Shared with `_runBackupLocked`: its publish promise survives the cut. */
        const state = { publishing: null };

        return BackupStoreService._withRunBackupLock(async () => {
            const dir = await BackupStoreService._ensureDir();
            return FileLease.withLease(
                {
                    dir,
                    name: BACKUP_LEASE_NAME,
                    staleMs: idleLimitMs + 60_000,
                },
                (lease) =>
                    runGuarded(
                        { label: `backup:${archiveId}`, idleLimitMs, onStall },
                        () => {
                            const scope = currentScope();
                            lease.bindScope(scope);
                            BackupStoreService._runHolderScope = scope ?? null;
                            return BackupStoreService._runBackupLocked({
                                trigger,
                                event,
                                eventId,
                                tables,
                                requestId,
                                createdBy,
                                at,
                                archiveId,
                                signal: scope?.signal,
                                state,
                            });
                        },
                    ).catch((err) => {
                        // Still inside the lease: a late publish finishes (or
                        // fails) before another worker can fork the chain.
                        if (stall.error && err === stall.error) {
                            return BackupStoreService._resolveCut({
                                err,
                                stall,
                                state,
                                archiveId,
                                trigger,
                                filePath: path.join(
                                    dir,
                                    BackupStoreService._buildFilename({ trigger, event, eventId, at }),
                                ),
                            });
                        }
                        throw err;
                    }),
            );
        });
    }

    /** Max wait (ms) for a publish that raced a watchdog cut to settle. Overridable in tests. */
    static CUT_SETTLE_MS = 5000;

    /**
     * A watchdog cut ended a backup. The write may have been mid-rename: the
     * complete, fsynced `.zip` is then published even though the guard
     * rejected. Decide the true outcome BEFORE logging "nothing published":
     *  - publish settled with a result -> the archive exists and is a valid
     *    chain member: log `BACKUP_PUBLISHED_AFTER_CUT` (warning) and RETURN
     *    the result (success; the caller must not retry a backup that exists);
     *  - the `.zip` exists but no result is known (publish timed out) -> same
     *    warning, index invalidated, the stall error is thrown;
     *  - otherwise nothing was published: `BACKUP_WATCHDOG_CANCELLED`
     *    (critical for SCHEDULED, error otherwise) and the stall error.
     *
     * @param {object} p
     * @param {Error} p.err - The BackupStalledError built by `onStall`.
     * @param {{idleMs: number, lastSource: string}} p.stall
     * @param {{publishing: Promise<object>|null}} p.state
     * @param {string} p.archiveId
     * @param {"SCHEDULED"|"MANUAL"|"PURGE"} p.trigger
     * @param {string} p.filePath - Final `.zip` path the run would publish.
     * @returns {Promise<object>} runBackup's result when published after the cut.
     * @throws {Error} `err` when nothing (usable) was published.
     * @private
     */
    static async _resolveCut({ err, stall, state, archiveId, trigger, filePath }) {
        let result = null;
        if (state.publishing) {
            let timer;
            try {
                result = await Promise.race([
                    state.publishing.catch(() => null),
                    new Promise((resolve) => {
                        timer = setTimeout(() => resolve(null), BackupStoreService.CUT_SETTLE_MS);
                        timer.unref?.();
                    }),
                ]);
            } finally {
                clearTimeout(timer);
            }
        }
        const exists = await fsPromises
            .access(filePath)
            .then(() => true)
            .catch(() => false);
        if (exists) {
            BackupStoreService.invalidateIndex();
            logger.warning(
                dataBackupMessages.BACKUP_PUBLISHED_AFTER_CUT(
                    archiveId,
                    path.basename(filePath),
                    stall.idleMs,
                    stall.lastSource,
                ),
            );
            if (result) return result;
            throw err;
        }
        const msg = dataBackupMessages.BACKUP_WATCHDOG_CANCELLED(archiveId, stall.idleMs, stall.lastSource);
        // A missed scheduled backup must page once; a caller-visible 503 needs only error.
        if (trigger === "SCHEDULED") logger.critical(msg);
        else logger.error(msg);
        throw err;
    }

    /**
     * The chain-decision + build + write body of {@link BackupStoreService.runBackup}.
     * MUST run inside both the in-process mutex and the {@link FileLease}.
     *
     * @param {object} p - runBackup params plus the precomputed `archiveId` and the guarded scope's `signal`.
     * @returns {Promise<object>} runBackup's result.
     * @private
     */
    static async _runBackupLocked({
        trigger,
        event,
        eventId,
        tables,
        requestId,
        createdBy,
        at,
        archiveId,
        signal,
        state = { publishing: null },
    }) {
        await BackupStoreService._sweepStaleParts();
        const index = await BackupStoreService._loadIndex({ force: true });
        const decision = await BackupStoreService._decideChain({
            trigger,
            index,
        });

        // `archiveId` is built by runBackup from the caller-overridable
        // `at` (tests inject distinct instants a second apart to keep
        // archiveId/filename — both second-granularity — collision-free).

        if (decision.forcedFullReason) {
            logger.notice(
                dataBackupMessages.CHAIN_FORCED_FULL(
                    archiveId,
                    decision.forcedFullReason,
                ),
            );
        } else {
            logger.info(
                dataBackupMessages.CHAIN_INCREMENTAL(
                    archiveId,
                    decision.chain.baseArchiveId,
                    decision.chain.generation,
                ),
            );
        }

        const built = await BackupArchiveService.buildScheduledBackup({
            tables,
            trigger,
            event,
            eventId,
            mode: decision.mode,
            archiveId,
            chain: decision.mode === "FULL" ? null : decision.chain,
            previousTableState: decision.previousTableState,
            createdBy,
            requestId,
        });

        const filename = BackupStoreService._buildFilename({
            trigger,
            event,
            eventId,
            at,
        });
        const dir = await BackupStoreService._ensureDir();
        const filePath = path.join(dir, filename);

        // The publish is a promise shared through `state`: a watchdog cut
        // rejects the guard but cannot stop an in-flight rename, and
        // `_resolveCut` needs the outcome of exactly that write.
        const publish = async () => {
            try {
                await BackupStoreService._atomicWrite(filePath, built.zipBuffer, {
                    signal,
                });
            } catch (err) {
                logger.error(
                    dataBackupMessages.ARCHIVE_WRITE_FAILED(archiveId, err),
                );
                throw err;
            }
            logger.info(
                dataBackupMessages.ARCHIVE_WRITTEN(
                    archiveId,
                    filename,
                    built.zipBuffer.length,
                ),
            );

            BackupStoreService.invalidateIndex();

            return {
                archiveId,
                filename,
                path: filePath,
                sizeBytes: built.zipBuffer.length,
                mode: built.manifest.mode,
                chain: built.manifest.chain,
                totalRows: built.totalRows,
                tableCount: built.tableCount,
                includedCount: built.includedCount,
                unchangedCount: built.unchangedCount,
                forcedFullReason: decision.forcedFullReason,
            };
        };
        state.publishing = publish();
        return state.publishing;
    }

    // ─── materialise() — self-contained FULL zip for download/email ──

    /**
     * Resolves the chain for one archive and emits a SELF-CONTAINED `FULL`
     * zip with a freshly computed signature — every table's JSONL pulled
     * from wherever it actually lives (this archive, or its resolved
     * `sourceArchiveId` for an `UNCHANGED` table), each source re-verified
     * before being trusted. The incremental storage format never leaves the
     * server in incremental form — this is the ONLY code path
     * that produces a downloadable/emailable artifact.
     *
     * Does NOT persist the materialised zip back to disk or the index — it
     * is a read-time transform, generated fresh on every call, and never
     * itself becomes a chain member.
     *
     * @param {string} archiveIdRaw
     * @returns {Promise<{ zipBuffer: Buffer, filename: string, manifest: object }>}
     * @throws {AppError} 400 invalid id, 404 not found, 422 a chain member is missing or fails signature verification.
     *
     * @example
     * const { zipBuffer, filename } = await BackupStoreService.materialise("bk_2026-07-28T05:59:59Z_e142_NIGHTLY");
     */
    static async materialise(archiveIdRaw) {
        const archiveId = BackupStoreService._validateArchiveId(archiveIdRaw);
        const startedAt = Date.now();
        logger.info(dataBackupMessages.MATERIALISE_STARTED(archiveId));

        const index = await BackupStoreService._loadIndex();
        const entry = index.find((e) => e.archiveId === archiveId);
        if (!entry) {
            throw new AppError(
                PURGE_ERRORS.BACKUP_ARCHIVE_NOT_FOUND,
                HTTP_STATUS.NOT_FOUND,
                { type: "NotFoundError" },
            );
        }

        const headBuffer = await fsPromises.readFile(entry.path);
        const headValid = await BackupStoreService._verifyZipBuffer(headBuffer);
        if (!headValid) {
            throw new AppError(
                PURGE_ERRORS.BACKUP_CHAIN_MEMBER_MISSING,
                HTTP_STATUS.UNPROCESSABLE,
                {
                    type: "IntegrityError",
                    details: [
                        {
                            field: "archive",
                            issue: `"${archiveId}" failed signature verification.`,
                        },
                    ],
                },
            );
        }
        const headZip = await JSZip.loadAsync(headBuffer);
        const zipCache = new Map([[entry.archiveId, headZip]]);

        const rowCap =
            parseInt(process.env.BACKUP_XLSX_ROW_CAP, 10) ||
            DEFAULT_XLSX_ROW_CAP;
        const tableNames = Object.keys(entry.tables ?? {});
        const dataBuffers = {};
        const rowsByTableForXlsx = {};

        for (const table of tableNames) {
            const state = entry.tables[table];
            const ownerArchiveId =
                state.state === "INCLUDED"
                    ? entry.archiveId
                    : state.sourceArchiveId;

            let ownerZip = zipCache.get(ownerArchiveId);
            if (!ownerZip) {
                const ownerEntry = index.find(
                    (e) => e.archiveId === ownerArchiveId,
                );
                if (!ownerEntry) {
                    logger.error(
                        dataBackupMessages.MATERIALISE_CHAIN_MEMBER_MISSING(
                            archiveId,
                            table,
                            ownerArchiveId,
                        ),
                    );
                    throw new AppError(
                        PURGE_ERRORS.BACKUP_CHAIN_MEMBER_MISSING,
                        HTTP_STATUS.UNPROCESSABLE,
                        {
                            type: "IntegrityError",
                            details: [
                                {
                                    field: table,
                                    issue: `Source archive "${ownerArchiveId}" is missing.`,
                                },
                            ],
                        },
                    );
                }
                // Sequential chain-member reads, bounded by distinct sourceArchiveIds referenced (small).
                const ownerBuffer = await fsPromises.readFile(ownerEntry.path);
                const ownerValid =
                    await BackupStoreService._verifyZipBuffer(ownerBuffer);
                if (!ownerValid) {
                    logger.error(
                        dataBackupMessages.MATERIALISE_CHAIN_MEMBER_MISSING(
                            archiveId,
                            table,
                            ownerArchiveId,
                        ),
                    );
                    throw new AppError(
                        PURGE_ERRORS.BACKUP_CHAIN_MEMBER_MISSING,
                        HTTP_STATUS.UNPROCESSABLE,
                        {
                            type: "IntegrityError",
                            details: [
                                {
                                    field: table,
                                    issue: `Source archive "${ownerArchiveId}" failed signature verification.`,
                                },
                            ],
                        },
                    );
                }
                ownerZip = await JSZip.loadAsync(ownerBuffer);
                zipCache.set(ownerArchiveId, ownerZip);
            }

            const fileEntry = ownerZip.file(`data/${table}.jsonl`);
            if (!fileEntry) {
                throw new AppError(
                    PURGE_ERRORS.BACKUP_CHAIN_MEMBER_MISSING,
                    HTTP_STATUS.UNPROCESSABLE,
                    {
                        type: "IntegrityError",
                        details: [
                            {
                                field: table,
                                issue: `"data/${table}.jsonl" not found in archive "${ownerArchiveId}".`,
                            },
                        ],
                    },
                );
            }
            // Sequential per-table extraction from already-loaded in-memory zips.
            const buf = Buffer.from(await fileEntry.async("nodebuffer"));
            dataBuffers[`data/${table}.jsonl`] = buf;

            // Capped row parse for the summary workbook only — cheap even
            // for a huge table since parsing stops at rowCap lines.
            const rows = [];
            for (const line of buf.toString("utf8").split("\n")) {
                if (rows.length >= rowCap) break;
                const trimmed = line.trim();
                if (!trimmed) continue;
                rows.push(JSON.parse(trimmed));
            }
            rowsByTableForXlsx[table] = rows;
        }

        const tableRowCounts = Object.fromEntries(
            tableNames.map((t) => [t, entry.tables[t].rows]),
        );

        const manifest = {
            archiveId: entry.archiveId,
            trigger: entry.trigger,
            event: entry.event,
            eventId: entry.eventId,
            mode: "FULL",
            readConsistent: entry.readConsistent,
            chain: null, // materialised copies are self-contained — no longer a stored chain member
            tables: Object.fromEntries(
                tableNames.map((t) => [
                    t,
                    {
                        state: "INCLUDED",
                        rows: entry.tables[t].rows,
                        sha256: entry.tables[t].sha256,
                    },
                ]),
            ),
            kind: "FULL_SCOPE",
            scope: {
                requestedGroups: [],
                requestedTables: tableNames,
                autoIncludedGroups: [],
                tables: tableNames,
            },
            scopeHash: entry.scopeHash,
            tableRowCounts,
            schemaVersion: entry.schemaVersion,
            createdBy: entry.createdBy,
            createdAt: entry.createdAt, // original backup time — materialisation is a lossless transform, not a new backup event
            materialisedAt: new Date().toISOString(),
            requestId: entry.requestId,
            appVersion: entry.appVersion,
            fidelityNotes: entry.fidelityNotes ?? [],
        };
        const manifestBuffer = Buffer.from(
            JSON.stringify(manifest, null, 2),
            "utf8",
        );

        const xlsxBuffer = await BackupStoreService._buildSummaryWorkbook(
            tableNames,
            rowsByTableForXlsx,
            tableRowCounts,
        );

        const filesToHash = { "manifest.json": manifestBuffer, ...dataBuffers };
        const fileHashes = {};
        for (const [name, buf] of Object.entries(filesToHash)) {
            fileHashes[name] = crypto
                .createHash("sha256")
                .update(buf)
                .digest("hex");
        }
        const digest = await CryptoVault.signRecord(
            "APP_BACKUP_ARCHIVE",
            fileHashes,
        );
        const signature = {
            algorithm: "HMAC-SHA256",
            domain: "APP_BACKUP_ARCHIVE",
            files: fileHashes,
            digest,
            createdAt: new Date().toISOString(),
        };
        const signatureBuffer = Buffer.from(
            JSON.stringify(signature, null, 2),
            "utf8",
        );

        const zipBuffer = await BackupStoreService._zipFiles({
            "manifest.json": manifestBuffer,
            "signature.json": signatureBuffer,
            ...dataBuffers,
            "readable/backup-summary.xlsx": xlsxBuffer,
        });

        logger.info(
            dataBackupMessages.MATERIALISE_COMPLETE(
                archiveId,
                tableNames.length,
                Date.now() - startedAt,
            ),
        );

        return {
            zipBuffer,
            filename: entry.filename.replace(/\.zip$/, "_materialised.zip"),
            manifest,
        };
    }

    /**
     * Minimal summary workbook for a materialised archive — one "Summary"
     * sheet plus one capped per-table sheet, same visual style as
     * `BackupArchiveService`'s own readable workbook (bold white-on-orange
     * header row) for consistency across every archive an operator opens.
     * Deliberately a SEPARATE small implementation rather than reaching into
     * `BackupArchiveService`'s private workbook builders across a module
     * boundary — those stream directly from Oracle (this file never touches
     * Oracle) and already have two callers of their own.
     *
     * @param {string[]} tables
     * @param {Record<string, object[]>} rowsByTable - Already row-cap-limited by the caller.
     * @param {Record<string, number>} rowCounts - TRUE total row count per table (may exceed `rowsByTable[t].length`).
     * @returns {Promise<Buffer>}
     * @private
     */
    static async _buildSummaryWorkbook(tables, rowsByTable, rowCounts) {
        const rowCap =
            parseInt(process.env.BACKUP_XLSX_ROW_CAP, 10) ||
            DEFAULT_XLSX_ROW_CAP;

        const workbook = new ExcelJS.Workbook();
        workbook.creator = `${process.env.APP_NAME || "CATHERINE"} System`;
        workbook.created = new Date();

        const summary = workbook.addWorksheet("Summary");
        summary.columns = [
            { header: "Table", key: "table", width: 32 },
            { header: "Row Count", key: "rowCount", width: 14 },
            { header: "Included in this sheet", key: "capped", width: 24 },
        ];
        summary.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
        summary.getRow(1).fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FFFF4208" },
        };

        for (const table of tables) {
            const totalRows = rowCounts[table] ?? 0;
            const rows = rowsByTable[table] ?? [];
            summary.addRow({
                table,
                rowCount: totalRows,
                capped:
                    totalRows > rowCap
                        ? `First ${rowCap} of ${totalRows}`
                        : "All rows",
            });

            const sheet = workbook.addWorksheet(
                table.length > 31 ? table.slice(0, 31) : table,
            );
            if (rows.length > 0) {
                sheet.columns = Object.keys(rows[0]).map((col) => ({
                    header: col,
                    key: col,
                    width: 18,
                }));
                sheet.getRow(1).font = { bold: true };
                // Date columns re-based to the stored wall clock — see
                // `excelFormat.toExcelDate`. The JSONL restore source is
                // untouched; this is the human-eyeball copy only.
                for (const row of rows) addNormalizedRow(sheet, row);
            }
        }

        return workbook.xlsx.writeBuffer();
    }

    /**
     * Streams a set of in-memory buffers into one zip archive buffer, via
     * `archiver`'s PassThrough-collect pattern — the same shape as
     * `BackupArchiveService._buildZip`, duplicated here (small, generic, no
     * business logic) rather than reused across the module boundary.
     *
     * @param {Record<string, Buffer>} files
     * @returns {Promise<Buffer>}
     * @private
     */
    static async _zipFiles(files) {
        return new Promise((resolve, reject) => {
            const chunks = [];
            const pass = new PassThrough();
            pass.on("data", (chunk) => chunks.push(chunk));
            pass.on("end", () => resolve(Buffer.concat(chunks)));
            pass.on("error", reject);

            const archive = archiver("zip", { zlib: { level: 9 } });
            archive.on("error", reject);
            archive.pipe(pass);

            for (const [name, buffer] of Object.entries(files)) {
                archive.append(buffer, { name });
            }

            archive.finalize();
        });
    }

    // ─── Chain-safe delete ──────────────────────────────────────────

    /**
     * Deletes ONE archive from disk — but only when no OTHER retained
     * archive's `UNCHANGED` pointer still names it as `sourceArchiveId`.
     * Refuses with a `409` naming every dependent otherwise. Deciding WHICH
     * archives are past retention and should be swept as whole chains is
     * `BackupScheduleService`'s job (a later step) — this method is the
     * mechanical guarantee that a single delete (automatic retention, or the
     * majority-vote delete via `POST /backups/:id/vote`) can never orphan a chain.
     *
     * @param {string} archiveIdRaw
     * @returns {Promise<{ archiveId: string, filename: string }>}
     * @throws {AppError} 400 invalid id, 404 not found, 409 has dependents (details name every dependent archiveId).
     *
     * @example
     * await BackupStoreService.deleteArchive("bk_2026-07-02T06:14:59Z_e140_NIGHTLY");
     */
    static async deleteArchive(archiveIdRaw) {
        const archiveId = BackupStoreService._validateArchiveId(archiveIdRaw);
        const index = await BackupStoreService._loadIndex();
        const entry = index.find((e) => e.archiveId === archiveId);
        if (!entry) {
            throw new AppError(
                PURGE_ERRORS.BACKUP_ARCHIVE_NOT_FOUND,
                HTTP_STATUS.NOT_FOUND,
                { type: "NotFoundError" },
            );
        }

        const dependents = index
            .filter((e) => e.archiveId !== archiveId)
            .filter((e) =>
                Object.values(e.tables ?? {}).some(
                    (s) =>
                        s.state === "UNCHANGED" &&
                        s.sourceArchiveId === archiveId,
                ),
            )
            .map((e) => e.archiveId);

        if (dependents.length > 0) {
            logger.warning(
                dataBackupMessages.PRUNE_REFUSED_DEPENDENTS(
                    archiveId,
                    dependents,
                ),
            );
            throw new AppError(
                PURGE_ERRORS.BACKUP_DELETE_HAS_DEPENDENTS,
                HTTP_STATUS.CONFLICT,
                {
                    type: "ConflictError",
                    details: dependents.map((d) => ({
                        field: "archive",
                        issue: `"${d}" still depends on this archive for table data.`,
                    })),
                },
            );
        }

        // Containment check — `entry.path` is always internally generated by
        // this file, never user input, but assert it stays inside the
        // resolved backup dir anyway (defense in depth, CWE-22).
        const backupDir = path.resolve(BackupStoreService._resolveBackupDir());
        const resolvedPath = path.resolve(entry.path);
        if (resolvedPath !== path.join(backupDir, entry.filename)) {
            throw new Error(
                `BackupStoreService.deleteArchive: refusing to delete a path outside the backup directory: ${resolvedPath}`,
            );
        }

        await fsPromises.unlink(resolvedPath);
        logger.notice(
            dataBackupMessages.PRUNE_DELETED(archiveId, entry.filename),
        );
        BackupStoreService.invalidateIndex();

        return { archiveId, filename: entry.filename };
    }

    // ─── Verify — signature + chain integrity ─────────────

    /**
     * Re-verifies one archive's HMAC signature AND checks that every chain
     * member it depends on (every distinct `sourceArchiveId` an `UNCHANGED`
     * table points at) is present on disk and signature-valid.
     *
     * Returns a structured result; throws `BACKUP_VERIFY_FAILED` (422) when
     * either the archive's own signature or any chain member fails.
     *
     * @param {string} archiveIdRaw
     * @returns {Promise<{ archiveId: string, signatureValid: boolean, chainHealth: { valid: boolean, missing: string[], invalid: string[] } }>}
     * @throws {AppError} 400 invalid id, 404 not found, 422 verification failed.
     */
    static async verifyArchive(archiveIdRaw) {
        const entry = await BackupStoreService.getArchive(archiveIdRaw);

        const signatureValid =
            await BackupStoreService._verifyArchiveFile(entry);

        const chainHealth = { valid: true, missing: [], invalid: [] };
        if (entry.tables) {
            const referencedIds = new Set();
            for (const state of Object.values(entry.tables)) {
                if (state.state === "UNCHANGED" && state.sourceArchiveId) {
                    referencedIds.add(state.sourceArchiveId);
                }
            }
            const index = await BackupStoreService._loadIndex();
            for (const refId of referencedIds) {
                const refEntry = index.find((e) => e.archiveId === refId);
                if (!refEntry) {
                    chainHealth.valid = false;
                    chainHealth.missing.push(refId);
                    continue;
                }
                // Bounded by distinct sourceArchiveIds (small).
                const refValid =
                    await BackupStoreService._verifyArchiveFile(refEntry);
                if (!refValid) {
                    chainHealth.valid = false;
                    chainHealth.invalid.push(refId);
                }
            }
        }

        const overallValid = signatureValid && chainHealth.valid;

        if (!overallValid) {
            throw new AppError(
                PURGE_ERRORS.BACKUP_VERIFY_FAILED,
                HTTP_STATUS.UNPROCESSABLE,
                {
                    type: "IntegrityError",
                    details: [
                        ...(!signatureValid
                            ? [
                                  {
                                      field: "signature",
                                      issue: "Archive signature verification failed.",
                                  },
                              ]
                            : []),
                        ...chainHealth.missing.map((id) => ({
                            field: "chain",
                            issue: `Chain member "${id}" is missing.`,
                        })),
                        ...chainHealth.invalid.map((id) => ({
                            field: "chain",
                            issue: `Chain member "${id}" failed signature verification.`,
                        })),
                    ],
                },
            );
        }

        return { archiveId: entry.archiveId, signatureValid, chainHealth };
    }
}

module.exports = BackupStoreService;
// Exported so tests (and a later BackupScheduleService) can point the store
// at a temp directory without mutating process.env for the whole suite.
module.exports.DEFAULT_BACKUP_DIR = DEFAULT_BACKUP_DIR;
module.exports.INDEX_CACHE_TTL_MS = INDEX_CACHE_TTL_MS;
