"use strict";

/**
 * @fileoverview Scheduled DB Backup — event-driven detector + orchestration.
 *
 * WHAT THIS FILE DOES
 * --------------------
 * Decides WHEN a scheduled backup should run. `BackupStoreService.runBackup`
 * is the mechanical "take one backup right now and store it" primitive; this
 * file answers "is a backup due, and for which schedule event".
 *
 * Schedule events come from a registered EVENT SOURCE (see
 * {@link BackupScheduleService.registerEventSource}). The template registers
 * none, so scheduled backups stay idle until a project registers one — "Back
 * Up Now" and purge-gating backups work regardless. An event is
 * `{ eventId, event, at }`: a stable id, a short name, and the instant it
 * occurred / will occur.
 *
 * HOW IT WORKS
 * ------------
 * `triggerScheduledBackup(label)` (called by `server.js`'s cron-leader-only
 * wiring from exact-time timers, a boot catch-up and an interval sweep):
 *   1. `{ skipped: "disabled" }` when `DB_BACKUP_ENABLED === "false"`.
 *   2. `{ skipped: "already-running" }` on the in-process `_backupRunning`
 *      mutex — overlapping triggers never overlap a backup with itself.
 *   3. Reads every event that occurred inside the
 *      `DB_BACKUP_CATCHUP_WINDOW_HOURS` look-back window from the source.
 *   4. Decides "already backed up" purely from what is on disk
 *      (`BackupStoreService.listArchives()`), never a second index.
 *   5. Runs a backup for every due-and-missing event — one failure is
 *      isolated per event and collected, never aborting the sweep.
 *   6. Prunes retention-expired chains (newest generation first);
 *      `BackupStoreService.deleteArchive`'s dependents check is what
 *      GUARANTEES a delete never orphans a retained incremental.
 *
 * PURGE-triggered archives never join the scheduled-backup chain and are
 * excluded from the retention sweep — they gate an irreversible DELETE.
 *
 * PRE-SCHEDULED-BACKUP LOCKOUT WINDOW
 * -----------------------------------
 * `getLockoutStatus()` answers: "should an OPERATOR-INITIATED manual backup
 * or purge be refused RIGHT NOW because a scheduled backup is imminent or
 * running?" — an ergonomics rejection (409 naming the wait). The actual
 * correctness guarantee stays `BackupStoreService`'s FIFO mutex
 * (`_withRunBackupLock`), which every trigger queues on regardless. A purge
 * that starts just outside the window can still overlap a scheduled backup;
 * the mutex handles that, not this window.
 *
 * EXAMPLE
 * -------
 *   BackupScheduleService.registerEventSource({
 *       getDueEvents: async (windowHours) => [{ eventId: 42, event: "NIGHTLY", at: new Date() }],
 *       getUpcomingEvents: async (horizonMs) => [],
 *   });
 *   const result = await BackupScheduleService.triggerScheduledBackup("cron");
 *   // result -> { skipped: false, due: 1, ran: [...], failed: [], pruned: [...] }
 */

const { logger } = require("../utils/logger");
const { dataBackupMessages } = require("../constants/messages");
const BackupStoreService = require("./BackupStoreService");
const { getAllTableNames } = require("../constants/purgeTables");

/** Default catch-up look-back window (hours) when `DB_BACKUP_CATCHUP_WINDOW_HOURS` is unset. */
const DEFAULT_CATCHUP_WINDOW_HOURS = 72;

/** Default chain-safe retention window (days) when `DB_BACKUP_RETENTION_DAYS` is unset. */
const DEFAULT_RETENTION_DAYS = 180;

/** Default pre-scheduled-backup lockout window (ms) when `DB_BACKUP_LOCKOUT_WINDOW_MS` is unset. */
const DEFAULT_LOCKOUT_WINDOW_MS = 60_000;

/**
 * Default delay (ms) after a schedule event before its exact-time timer fires
 * when `DB_BACKUP_EVENT_DELAY_MS` is unset — MUST mirror `server.js`'s
 * `_scheduleDbBackup()` default (both read the same env var).
 */
const DEFAULT_EVENT_DELAY_MS = 900_000;

/**
 * @typedef {object} BackupScheduleEvent
 * @property {number|string} eventId - stable id; part of the archive id and the idempotency key
 * @property {string} event          - short name, e.g. "NIGHTLY"
 * @property {Date} at               - when the event occurred / will occur
 */

/**
 * @typedef {object} BackupEventSource
 * @property {(windowHours: number) => Promise<BackupScheduleEvent[]>} getDueEvents - events inside the look-back window
 * @property {(horizonMs?: number) => Promise<BackupScheduleEvent[]>} getUpcomingEvents - future events, soonest first
 */

/** No events: scheduled backups stay idle until a project registers a source. */
const EMPTY_EVENT_SOURCE = Object.freeze({
    getDueEvents: async () => [],
    getUpcomingEvents: async () => [],
});

class BackupScheduleService {
    /**
     * In-process mutex — `true` while a scheduled backup run is in flight in
     * THIS process. Cross-process / cross-restart idempotency is the on-disk
     * check in step 4, not this flag.
     *
     * @type {boolean}
     */
    static _backupRunning = false;

    /** @type {BackupEventSource} */
    static _eventSource = EMPTY_EVENT_SOURCE;

    /**
     * Registers the schedule a project backs up on. Call once at boot, before
     * `server.js` arms its backup timers.
     *
     * @param {BackupEventSource} source
     * @returns {void}
     * @throws {TypeError} When either method is missing.
     */
    static registerEventSource(source) {
        if (typeof source?.getDueEvents !== "function" || typeof source?.getUpcomingEvents !== "function") {
            throw new TypeError("BackupScheduleService.registerEventSource: source must implement getDueEvents and getUpcomingEvents.");
        }
        BackupScheduleService._eventSource = source;
    }

    /**
     * Future schedule events, soonest first — what `server.js` arms its
     * exact-time timers from.
     *
     * @param {number} [horizonMs]
     * @returns {Promise<BackupScheduleEvent[]>}
     */
    static async getUpcomingEvents(horizonMs) {
        return BackupScheduleService._eventSource.getUpcomingEvents(horizonMs);
    }

    /**
     * @returns {boolean} `false` only when `DB_BACKUP_ENABLED` is the exact
     *   string `"false"`.
     */
    static isEnabled() {
        return process.env.DB_BACKUP_ENABLED !== "false";
    }

    /**
     * Event-gated, idempotent, mutex-guarded scheduled-backup trigger. Cheap
     * and safe to call when nothing is due: it still runs the (also cheap)
     * retention prune before returning.
     *
     * @param {string} [label] - scheduler source label for logging only
     * @returns {Promise<{
     *   skipped: false|"disabled"|"already-running",
     *   due: number,
     *   ran: Array<{ eventId: number|string, event: string, archiveId: string, mode: "FULL"|"INCREMENTAL" }>,
     *   failed: Array<{ eventId: number|string, event: string, error: string }>,
     *   pruned: string[],
     * }>}
     */
    static async triggerScheduledBackup(label = "cron") {
        if (!BackupScheduleService.isEnabled()) {
            logger.info(dataBackupMessages.SCHEDULE_DISABLED(label));
            return { skipped: "disabled", due: 0, ran: [], failed: [], pruned: [] };
        }

        if (BackupScheduleService._backupRunning) {
            logger.info(dataBackupMessages.SCHEDULE_ALREADY_RUNNING(label));
            return { skipped: "already-running", due: 0, ran: [], failed: [], pruned: [] };
        }

        BackupScheduleService._backupRunning = true;
        try {
            return await BackupScheduleService._runDueBackups(label);
        } finally {
            BackupScheduleService._backupRunning = false;
        }
    }

    /**
     * Body of one scheduled-backup sweep; only called while holding the mutex.
     *
     * @param {string} label
     * @returns {Promise<{ skipped: false, due: number, ran: Array<object>, failed: Array<object>, pruned: string[] }>}
     * @private
     */
    static async _runDueBackups(label) {
        const windowHours = Number(process.env.DB_BACKUP_CATCHUP_WINDOW_HOURS) || DEFAULT_CATCHUP_WINDOW_HOURS;
        const due = await BackupScheduleService._eventSource.getDueEvents(windowHours);

        const ran = [];
        const failed = [];

        if (due.length === 0) {
            logger.info(dataBackupMessages.SCHEDULE_NO_EVENTS_DUE(label, windowHours));
        } else {
            const existing = await BackupStoreService.listArchives();
            for (const ev of due) {
                const already = existing.some(
                    (a) => a.trigger === "SCHEDULED" && String(a.eventId) === String(ev.eventId) && a.event === ev.event,
                );
                if (already) {
                    logger.debug(dataBackupMessages.SCHEDULE_EVENT_ALREADY_BACKED_UP(ev.eventId, ev.event));
                    continue;
                }
                try {
                    // Sequential whole-DB backups are deliberate; concurrent streaming reads of every table are not the goal.
                    const run = await BackupStoreService.runBackup({
                        trigger: "SCHEDULED",
                        event: ev.event,
                        eventId: ev.eventId,
                        tables: getAllTableNames(),
                    });
                    ran.push({ eventId: ev.eventId, event: ev.event, archiveId: run.archiveId, mode: run.mode });
                    logger.notice(dataBackupMessages.SCHEDULE_BACKUP_RAN(label, ev.eventId, ev.event, run.archiveId, run.mode));
                } catch (err) {
                    failed.push({ eventId: ev.eventId, event: ev.event, error: err.message ?? String(err) });
                    logger.error(dataBackupMessages.SCHEDULE_BACKUP_FAILED(label, ev.eventId, ev.event, err));
                }
            }
        }

        const pruned = await BackupScheduleService._pruneExpiredChains(label);
        return { skipped: false, due: due.length, ran, failed, pruned };
    }

    /**
     * Retention sweep — prunes a WHOLE chain lineage (grouped by
     * `chain.baseArchiveId`) only when its NEWEST member is past
     * `DB_BACKUP_RETENTION_DAYS`; deleting an old member of a fresh chain
     * would orphan every later `UNCHANGED` pointer into it. Deletes run newest
     * generation first. Never throws: a failed delete is left for the next sweep.
     *
     * @param {string} label
     * @returns {Promise<string[]>} `archiveId`s deleted this run.
     * @private
     */
    static async _pruneExpiredChains(label) {
        const retentionDays = Number(process.env.DB_BACKUP_RETENTION_DAYS) || DEFAULT_RETENTION_DAYS;
        const oldestKeptMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

        const index = await BackupStoreService.listArchives();

        /** @type {Map<string, object[]>} */
        const chains = new Map();
        for (const entry of index) {
            if (entry.trigger === "PURGE" || !entry.chain) continue;
            const key = entry.chain.baseArchiveId;
            if (!chains.has(key)) chains.set(key, []);
            chains.get(key).push(entry);
        }

        const pruned = [];
        for (const [baseArchiveId, members] of chains) {
            const newest = members.reduce((a, b) => (new Date(a.createdAt) > new Date(b.createdAt) ? a : b));
            if (new Date(newest.createdAt).getTime() >= oldestKeptMs) continue;

            const orderedNewestFirst = members
                .slice()
                .sort((a, b) => (b.chain?.generation ?? 0) - (a.chain?.generation ?? 0));

            for (const member of orderedNewestFirst) {
                try {
                    // Sequential: each delete invalidates the on-disk index the next one reads.
                    await BackupStoreService.deleteArchive(member.archiveId);
                    pruned.push(member.archiveId);
                    logger.notice(dataBackupMessages.SCHEDULE_PRUNED(label, member.archiveId, baseArchiveId));
                } catch (err) {
                    logger.warning(dataBackupMessages.SCHEDULE_PRUNE_SKIPPED(label, member.archiveId, err));
                }
            }
        }

        return pruned;
    }

    // ─── Pre-scheduled-backup lockout window ─────────────────────────────────

    /** @returns {number} `DB_BACKUP_LOCKOUT_WINDOW_MS`, or the 60 s default. */
    static getLockoutWindowMs() {
        return Number(process.env.DB_BACKUP_LOCKOUT_WINDOW_MS) || DEFAULT_LOCKOUT_WINDOW_MS;
    }

    /**
     * Ms until the SOONEST upcoming scheduled backup FIRES — the soonest
     * upcoming event offset by `DB_BACKUP_EVENT_DELAY_MS` (the same source and
     * offset `server.js`'s timers use). Fails OPEN on a lookup error (null):
     * this window is ergonomics, never the reason a legitimate action fails.
     *
     * @param {number} [lookaheadMs] - horizon override (tests)
     * @returns {Promise<number|null>} null when nothing is scheduled in the horizon
     */
    static async msUntilNextScheduledBackup(lookaheadMs) {
        const eventDelayMs = parseInt(process.env.DB_BACKUP_EVENT_DELAY_MS, 10) || DEFAULT_EVENT_DELAY_MS;
        const lockoutWindowMs = BackupScheduleService.getLockoutWindowMs();
        // The horizon must clear both the lockout window and the event delay.
        const horizon = lookaheadMs ?? Math.max(lockoutWindowMs + eventDelayMs, 26 * 60 * 60 * 1000);

        let events;
        try {
            events = await BackupScheduleService.getUpcomingEvents(horizon);
        } catch (err) {
            logger.warning(dataBackupMessages.SCHEDULE_WINDOW_LOOKUP_FAILED(err));
            return null;
        }
        if (!events || events.length === 0) return null;

        const fireAt = events[0].at.getTime() + eventDelayMs;
        return fireAt - Date.now();
    }

    /**
     * @typedef {object} LockoutStatus
     * @property {boolean} active
     * @property {"running"|"imminent"|null} reason
     * @property {number|null} msRemaining
     * @property {number} lockoutWindowMs
     */

    /**
     * Single entry point every operator-initiated-action gate calls before
     * deciding whether to reject with 409. Never throws.
     *
     * @returns {Promise<LockoutStatus>}
     */
    static async getLockoutStatus() {
        const lockoutWindowMs = BackupScheduleService.getLockoutWindowMs();

        if (BackupScheduleService._backupRunning) {
            return { active: true, reason: "running", msRemaining: null, lockoutWindowMs };
        }

        const msUntil = await BackupScheduleService.msUntilNextScheduledBackup();
        if (msUntil !== null && msUntil > 0 && msUntil <= lockoutWindowMs) {
            return { active: true, reason: "imminent", msRemaining: msUntil, lockoutWindowMs };
        }
        return { active: false, reason: null, msRemaining: msUntil, lockoutWindowMs };
    }

    /**
     * The ONE human-readable "try again in ~Ns" hint every lockout caller uses.
     *
     * @param {LockoutStatus} status
     * @returns {string|null} null when `status.active` is false
     */
    static describeLockout(status) {
        if (!status?.active) return null;
        if (status.reason === "running") {
            return "A scheduled backup is currently running. Try again once it completes.";
        }
        const seconds = Math.max(1, Math.ceil((status.msRemaining ?? 0) / 1000));
        return `A scheduled backup starts in ~${seconds}s. Try again after it completes.`;
    }
}

module.exports = BackupScheduleService;
