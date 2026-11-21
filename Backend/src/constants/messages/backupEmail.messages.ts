"use strict";

/**
 * @fileoverview Purge Backup — notification email log message templates.
 * Used ONLY in `logger.*` calls —
 * never thrown or sent to clients (throw strings live in
 * `constants/errors/index.js`, response strings in `constants/responses/index.js`).
 *
 * WHAT THIS FILE DOES
 * --------------------
 * Log-only strings for `BackupEmailService` (the purge-backup email sender)
 * and the fire-and-forget dispatch site in `DataPurgeService.backup()`.
 * Distinct from `dataBackup.messages.js`, which covers the SCHEDULED DB
 * BACKUP archive-building/filesystem machinery (`BackupArchiveService` /
 * `BackupStoreService`) — this file covers ONLY the purge-gating backup's
 * email notification (purge backups are the only ones that ever email;
 * scheduled/manual backups write to disk silently).
 *
 * HOW IT WORKS
 * ------------
 * Plain object of pure functions, re-exported from `constants/messages/index.js`
 * alongside every other message namespace.
 *
 * EXAMPLE
 * -------
 *   const { backupEmailMessages } = require("../constants/messages");
 *   logger.warning(backupEmailMessages.SEND_FAILED(adminId, err.message));
 */

const backupEmailMessages = {
    /**
     * Logged at `info` when the master switch is off (env `BACKUP_EMAIL_ENABLED`
     * is `"false"`).
     * @param {number|string} adminId
     * @returns {string}
     */
    SEND_SKIPPED_DISABLED: (adminId) =>
        `Purge backup email skipped for ADMIN_ID ${adminId} — backup email delivery is disabled (BACKUP_EMAIL_ENABLED=false).`,

    /**
     * Logged at `warning` when neither the opted-in SUPER_ADMIN distribution
     * list nor the acting operator resolves to a usable email address.
     * @param {number|string} adminId
     * @returns {string}
     */
    SEND_SKIPPED_NO_RECIPIENTS: (adminId) =>
        `Purge backup email skipped for ADMIN_ID ${adminId} — no resolvable recipient email address (no opted-in active SUPER_ADMIN, and the acting operator has no resolvable email).`,

    /**
     * Logged at `warning` when the `AdminModel` recipient lookup throws while
     * resolving the recipient list. Never re-thrown — whatever could be resolved (which may be just
     * the acting operator, or nothing) is still attempted.
     * @param {Error|string} err
     * @returns {string}
     */
    RECIPIENT_LOOKUP_FAILED: (err) =>
        `Purge backup email recipient lookup failed — falling back to whatever could be resolved: ${err?.message ?? err}`,

    /**
     * Logged at `info` after a successful SMTP send.
     * @param {number|string} adminId
     * @param {number} recipientCount
     * @returns {string}
     */
    SEND_SUCCESS: (adminId, recipientCount) =>
        `Purge notification email sent — triggered by ADMIN_ID ${adminId}, ${recipientCount} recipient(s) (notification only, no attachment).`,

    /**
     * Logged at `warning` on any failure inside `sendPurgeBackup` (recipient
     * resolution or the SMTP send itself). Never thrown —
     * `sendPurgeBackup` NEVER throws (mirrors `ServerNotificationService`).
     * @param {number|string} adminId
     * @param {string} cause
     * @returns {string}
     */
    SEND_FAILED: (adminId, cause) =>
        `Purge backup email failed for ADMIN_ID ${adminId}: ${cause}`,

    /**
     * Logged at `warning` ONLY at the fire-and-forget call site in
     * `DataPurgeService.backup()` — belt-and-braces in case
     * `BackupEmailService.sendPurgeBackup()` itself somehow rejects (it is
     * documented to never throw). The purge backup response itself was
     * already built and returned before this can ever fire (established
     * convention: "Email send failed in fire-and-forget `.catch()` → `warning`").
     * @param {number|string} adminId
     * @param {Error|string} err
     * @returns {string}
     */
    DISPATCH_REJECTED: (adminId, err) =>
        `Purge backup email dispatch rejected at the fire-and-forget call site (ADMIN_ID ${adminId}) — the purge backup response itself was NOT affected: ${err?.message ?? err}`,
};

module.exports = { backupEmailMessages };
