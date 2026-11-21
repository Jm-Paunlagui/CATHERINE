"use strict";

/**
 * @fileoverview Scheduled DB Backup + Encrypted Email Delivery log message
 * templates.
 *
 * WHAT THIS FILE DOES
 * --------------------
 * Log-only strings for `BackupArchiveService`'s chain-aware manifest builder,
 * `BackupStoreService`'s filesystem/index/materialise/prune machinery, and
 * `BackupScheduleService`'s date-gated detector — the
 * "is a backup due, and for which event" orchestration that
 * `server.js`'s cron-leader-only scheduler wiring calls. Used ONLY in
 * `logger.*` calls — never thrown or sent to clients (throw strings live in
 * `constants/errors/index.js`'s `PURGE_ERRORS`, response strings in
 * `constants/responses/index.js`).
 *
 * HOW IT WORKS
 * ------------
 * Plain object of pure functions, re-exported from `constants/messages/index.js`
 * alongside every other message namespace — see that file's `dataBackupMessages`
 * spread entry.
 *
 * EXAMPLE
 * -------
 *   const { dataBackupMessages } = require("../constants/messages");
 *   logger.notice(dataBackupMessages.ARCHIVE_READ_FALLBACK(archiveId, tables));
 */

const dataBackupMessages = {
    // ── BackupArchiveService.buildScheduledBackup / buildBackup (read path) ──
    /** @param {string} archiveId @param {string} trigger @param {number} tableCount */
    SCHEDULED_BUILD_STARTED: (archiveId, trigger, tableCount) =>
        `Scheduled/manual backup archive build started — archiveId: ${archiveId}, trigger: ${trigger}, ${tableCount} table(s).`,
    /** @param {string} archiveId @param {string} mode @param {number} includedCount @param {number} unchangedCount @param {number} totalRows @param {number} ms */
    SCHEDULED_BUILD_COMPLETE: (
        archiveId,
        mode,
        includedCount,
        unchangedCount,
        totalRows,
        ms,
    ) =>
        `Scheduled/manual backup archive build complete — archiveId: ${archiveId}, mode: ${mode}, ${includedCount} table(s) included, ${unchangedCount} unchanged (pointer only), ${totalRows} row(s) total, ${ms}ms.`,
    /**
     * Logged at `notice` — distinct from `dataPurgeMessages.STREAM_ALL_TABLES_SNAPSHOT_TOO_OLD`'s
     * own `warning`, which already carries the Oracle detail. This line ties the
     * SAME event to the specific archive build it affected (archiveId), and is
     * NOT a duplicate of the model-level warning — see the ORA-01555 critical-log
     * note in `BackupArchiveService`'s file header for why one further log line
     * (a `db.withConnection`-internal `critical`) is deliberately left as-is.
     * @param {string} archiveId @param {string[]} tables
     */
    ARCHIVE_READ_FALLBACK: (archiveId, tables) =>
        `Backup archive ${archiveId}: read-consistent multi-table read hit ORA-01555 — falling back to the per-table streamTable() path for ${tables.length} table(s) [${tables.join(", ")}]. Manifest will be stamped readConsistent:false.`,

    // ── BackupStoreService — filesystem / index ───────────────────────────────
    /** @param {string} archiveId @param {string} filename @param {number} sizeBytes */
    ARCHIVE_WRITTEN: (archiveId, filename, sizeBytes) =>
        `Backup archive written to disk — archiveId: ${archiveId}, file: ${filename}, ${sizeBytes} byte(s).`,
    /** @param {string} archiveId @param {Error|string} err */
    ARCHIVE_WRITE_FAILED: (archiveId, err) =>
        `Backup archive write FAILED — archiveId: ${archiveId}: ${err?.message ?? err}. Any partial ".part" file is left for manual inspection, never renamed into place.`,
    /** @param {number} count @param {number} ms */
    INDEX_REBUILT: (count, ms) =>
        `Backup store index rebuilt from disk — ${count} archive(s) found, ${ms}ms.`,
    /** @param {string} filename @param {Error|string} err */
    INDEX_ENTRY_UNREADABLE: (filename, err) =>
        `Backup store index: "${filename}" could not be read as a valid backup archive and was skipped: ${err?.message ?? err}.`,

    // ── Chain decisions ───────────────────────────────────────────
    /** @param {string} archiveId @param {string} reason */
    CHAIN_FORCED_FULL: (archiveId, reason) =>
        `Backup ${archiveId} forced to mode FULL — reason: ${reason}.`,
    /** @param {string} archiveId @param {string} baseArchiveId @param {number} generation */
    CHAIN_INCREMENTAL: (archiveId, baseArchiveId, generation) =>
        `Backup ${archiveId} written as INCREMENTAL — chain base: ${baseArchiveId}, generation: ${generation}.`,

    // ── materialise() ─────────────────────────────────────────────────────────
    /** @param {string} archiveId */
    MATERIALISE_STARTED: (archiveId) =>
        `Materialising backup ${archiveId} into a self-contained FULL zip.`,
    /** @param {string} archiveId @param {number} tableCount @param {number} ms */
    MATERIALISE_COMPLETE: (archiveId, tableCount, ms) =>
        `Materialised backup ${archiveId} — ${tableCount} table(s) resolved, ${ms}ms.`,
    /** @param {string} archiveId @param {string} table @param {string} sourceArchiveId */
    MATERIALISE_CHAIN_MEMBER_MISSING: (archiveId, table, sourceArchiveId) =>
        `Materialise of ${archiveId} FAILED — table "${table}" points at sourceArchiveId "${sourceArchiveId}", which is missing or fails signature verification.`,

    // ── Chain-safe delete ─────────────────────────────────────────
    /** @param {string} archiveId @param {string[]} dependents */
    PRUNE_REFUSED_DEPENDENTS: (archiveId, dependents) =>
        `Delete of backup ${archiveId} refused — ${dependents.length} retained archive(s) still depend on it for table data: [${dependents.join(", ")}].`,
    /** @param {string} archiveId @param {string} filename */
    PRUNE_DELETED: (archiveId, filename) =>
        `Backup archive deleted — archiveId: ${archiveId}, file: ${filename}.`,

    // ── Path safety (CWE-22) ───────────────────────────────────────────────────
    /** @param {string} rawId */
    PATH_SAFETY_REJECTED: (rawId) =>
        `Backup archive id rejected — fails path-safety validation before any index lookup or path join: "${String(rawId).slice(0, 200)}".`,

    // ── BackupScheduleService — date-gated detector ────────
    /** @param {string} label */
    SCHEDULE_DISABLED: (label) =>
        `Scheduled DB backup trigger (label: ${label}) — DB_BACKUP_ENABLED=false, skipped without reading the schedule.`,
    /** @param {string} label */
    SCHEDULE_ALREADY_RUNNING: (label) =>
        `Scheduled DB backup trigger (label: ${label}) — a run is already in flight in this process, skipped (in-process mutex).`,
    /** @param {string} label @param {number} windowHours */
    SCHEDULE_NO_EVENTS_DUE: (label, windowHours) =>
        `Scheduled DB backup trigger (label: ${label}) — no scheduled backup event fell inside the ${windowHours}h catch-up window.`,
    /** @param {number|string} eventId @param {string} event */
    SCHEDULE_EVENT_ALREADY_BACKED_UP: (eventId, event) =>
        `Scheduled DB backup: event ${eventId} / ${event} already has a matching SCHEDULED archive on disk — skipped (filename-derived idempotency).`,
    /** @param {string} label @param {number|string} eventId @param {string} event @param {string} archiveId @param {string} mode */
    SCHEDULE_BACKUP_RAN: (label, eventId, event, archiveId, mode) =>
        `Scheduled DB backup RAN (label: ${label}) — event ${eventId} / ${event}: archiveId ${archiveId}, mode ${mode}.`,
    /** @param {string} label @param {number|string} eventId @param {string} event @param {Error|string} err */
    SCHEDULE_BACKUP_FAILED: (label, eventId, event, err) =>
        `Scheduled DB backup FAILED (label: ${label}) — event ${eventId} / ${event}: ${err?.message ?? err}.`,
    /** @param {string} label @param {string} archiveId @param {string} baseArchiveId */
    SCHEDULE_PRUNED: (label, archiveId, baseArchiveId) =>
        `Scheduled DB backup retention sweep (label: ${label}) deleted expired archive ${archiveId} (chain base ${baseArchiveId}) — whole chain past DB_BACKUP_RETENTION_DAYS.`,
    /** @param {string} label @param {string} archiveId @param {Error|string} err */
    SCHEDULE_PRUNE_SKIPPED: (label, archiveId, err) =>
        `Scheduled DB backup retention sweep (label: ${label}) could not delete ${archiveId} — left for the next sweep: ${err?.message ?? err}.`,

    // ── Backup tab routes (step 7) ────────────────────────────────────────────
    /** @param {number|string} adminId */
    MANUAL_BACKUP_REQUESTED: (adminId) =>
        `Manual backup requested by ADMIN_ID ${adminId}.`,
    /** @param {string} archiveId @param {number|string} adminId */
    MANUAL_BACKUP_COMPLETE: (archiveId, adminId) =>
        `Manual backup complete — archiveId: ${archiveId}, requested by ADMIN_ID ${adminId}.`,
    /** @param {string} archiveId @param {number|string} adminId */
    DOWNLOAD_REQUESTED: (archiveId, adminId) =>
        `Backup download requested — archiveId: ${archiveId}, ADMIN_ID ${adminId}.`,
    /** @param {string} archiveId @param {boolean} valid @param {number|string} adminId */
    VERIFY_REQUESTED: (archiveId, valid, adminId) =>
        `Backup verify — archiveId: ${archiveId}, signatureValid: ${valid}, ADMIN_ID ${adminId}.`,
    /** @param {string} archiveId @param {number|string} adminId */
    DELETE_REQUESTED: (archiveId, adminId) =>
        `Backup delete requested — archiveId: ${archiveId}, ADMIN_ID ${adminId}.`,
    /** @param {string} archiveId @param {number|string} adminId */
    PURGE_BACKUP_PERSISTED: (archiveId, adminId) =>
        `Purge backup persisted to disk — archiveId: ${archiveId}, triggered by ADMIN_ID ${adminId}.`,

    /** @param {string} archiveId */
    RESTORE_INCREMENTAL_REJECTED: (archiveId) =>
        `Incremental archive upload rejected for restore — archiveId: ${archiveId}. Only self-contained FULL archives can be restored.`,

    // ── Majority-vote delete ──────────────
    /** @param {string} archiveId @param {number|string} adminId @param {number} votesNeeded */
    DELETE_REQUEST_CREATED: (archiveId, adminId, votesNeeded) =>
        `Backup delete request created — archiveId: ${archiveId}, requested by ADMIN_ID ${adminId}, ${votesNeeded} vote(s) needed.`,
    /** @param {string} archiveId @param {number|string} adminId @param {number} votesCast @param {number} votesNeeded */
    DELETE_VOTE_CAST: (archiveId, adminId, votesCast, votesNeeded) =>
        `Backup delete vote cast — archiveId: ${archiveId}, ADMIN_ID ${adminId}, ${votesCast}/${votesNeeded} votes.`,
    /** @param {string} archiveId @param {number|string} adminId */
    DELETE_VOTE_THRESHOLD_MET: (archiveId, adminId) =>
        `Backup delete vote threshold met — archiveId: ${archiveId}, final vote by ADMIN_ID ${adminId}. Executing chain-safe delete.`,
    /** @param {string} archiveId @param {number|string} adminId */
    DELETE_REQUEST_CANCELLED: (archiveId, adminId) =>
        `Backup delete request cancelled — archiveId: ${archiveId}, cancelled by ADMIN_ID ${adminId}.`,

    // ── Backup token consume — replay protection (token replay fix) ──────────
    /** @param {number|string} adminId @param {string} jti */
    TOKEN_CONSUMED: (adminId, jti) =>
        `Backup token consumed — ADMIN_ID ${adminId}, jti ${jti}. This token can never be accepted again.`,
    /** @param {number|string} adminId @param {string} jti */
    TOKEN_REPLAY_BLOCKED: (adminId, jti) =>
        `Backup token REPLAY BLOCKED — ADMIN_ID ${adminId}, jti ${jti} was already consumed. Rejecting (ORA-00001 on T_SERVER_BACKUP_TOKEN_CONSUMED_DEV.JTI).`,

    // ── Pre-scheduled-backup lockout window — BackupScheduleService.getLockoutStatus / describeLockout ──
    /** @param {Error|string} err */
    SCHEDULE_WINDOW_LOOKUP_FAILED: (err) =>
        `Backup lockout-window lookup FAILED — could not read the upcoming backup events: ${err?.message ?? err}. Failing OPEN (lockout treated as inactive) — the FIFO chain-race mutex in BackupStoreService.runBackup is the correctness guarantee, this window is ergonomics only.`,
    /** @param {"running"|"imminent"} reason @param {number|null} msRemaining */
    MANUAL_BACKUP_BLOCKED_SCHEDULE_WINDOW: (reason, msRemaining) =>
        `Manual backup REJECTED — pre-scheduled-backup lockout window active (reason: ${reason}${msRemaining != null ? `, ~${Math.ceil(msRemaining / 1000)}s remaining` : ""}).`,
    /** @param {number|string} adminId @param {"running"|"imminent"} reason @param {number|null} msRemaining */
    PURGE_BLOCKED_SCHEDULE_WINDOW: (adminId, reason, msRemaining) =>
        `Purge execute REJECTED for ADMIN_ID ${adminId} — pre-scheduled-backup lockout window active (reason: ${reason}${msRemaining != null ? `, ~${Math.ceil(msRemaining / 1000)}s remaining` : ""}). This is an ergonomics guard only — the purge's own PURGE-triggered backup call still queues correctly behind BackupStoreService's FIFO mutex regardless of this check.`,

    // ── Backup watchdog + cross-process lease (B-D13) ────────────────────────
    /** @param {string} archiveId @param {number} idleMs @param {string} lastSource */
    BACKUP_WATCHDOG_CANCELLED: (archiveId, idleMs, lastSource) =>
        `Backup CANCELLED by watchdog — archiveId: ${archiveId}, no progress for ${Math.round(idleMs / 1000)}s (last progress: ${lastSource}). Nothing was published; the next run starts fresh.`,
    /** @param {string} archiveId @param {string} filename @param {number} idleMs @param {string} lastSource */
    BACKUP_PUBLISHED_AFTER_CUT: (archiveId, filename, idleMs, lastSource) =>
        `Backup watchdog cut arrived while the archive was being published — archiveId: ${archiveId}, no progress for ${Math.round(idleMs / 1000)}s (last progress: ${lastSource}). The archive WAS published as ${filename} (complete, fsynced, atomically renamed) and is a valid chain member; no backup was lost.`,
    /** @param {number} n */
    BACKUP_STALE_PARTS_REMOVED: (n) =>
        `Removed ${n} stale backup .part file(s) left by an interrupted run.`,
    /** @param {string} name @param {number|null} holderPid */
    BACKUP_LEASE_WAITING: (name, holderPid) =>
        `Backup lease ${name} is held by pid ${holderPid ?? "unknown"} — waiting for it to finish.`,
    /** @param {string} name @param {number|null} pid @param {string|null} hostname */
    BACKUP_LEASE_STOLEN: (name, pid, hostname) =>
        `Stale backup lease ${name} taken over — previous holder pid ${pid ?? "unknown"} on ${hostname ?? "unknown"} was dead or made no progress.`,
};

module.exports = { dataBackupMessages };
