"use strict";

/**
 * @fileoverview Purge Backup — notification-only email.
 *
 * WHAT THIS FILE DOES
 * --------------------
 * Sends ONE plain HTML notification email — NO attachment — to every ACTIVE
 * SUPER_ADMIN with an EMAIL on file, plus the admin who actually triggered
 * the purge backup (always included — they took the backup). This is the ONLY
 * backup flow that ever emails: scheduled backups and the Backup tab's
 * "Back Up Now" write to disk silently, never through this service.
 *
 * The email tells recipients:
 *   - Who triggered the purge
 *   - What scope was purged (groups/tables, row count)
 *   - When it happened
 *   - Where to find the archive (Backup tab → Purge Backups section)
 *
 * No archive attachment, no encryption, no passphrase. The archive is
 * downloaded from the Backup tab only.
 *
 * NEVER THROWS (mirrors `ServerNotificationService`). Every outcome —
 * disabled, no recipients, SMTP failure, success — is logged via
 * `backupEmailMessages` and returned as a result object.
 *
 * EXAMPLE
 * -------
 *   const result = await BackupEmailService.sendPurgeNotification({
 *       scopeLabel: "T_",
 *       totalRows: 4213,
 *       tableCount: 3,
 *       adminId: 7,
 *       requestId: "req-abc123",
 *   });
 *   // { sent: true, recipientCount: 2 }
 */

const fs = require("fs");
const path = require("path");

const { logger } = require("../utils/logger");
const { dbTimezoneOffsetMinutes } = require("../utils/dbTimezone");
const { backupEmailMessages } = require("../constants/messages");
const { credentialAddressOf } = require("../utils/emailAddress");
const AdminModel = require("../models/admin.model");
const SharedTransporter = require("./email/SharedTransporter");

/** Product name shown in the subject line and body. */
const PRODUCT_NAME = process.env.APP_NAME || "CATHERINE";

/** Absolute path to this feature's single HTML template. */
const TEMPLATE_PATH = path.join(
    __dirname,
    "..",
    "utils",
    "email-templates",
    "db-backup",
    "db-backup-notification.html",
);

/** Absolute path to the shared logo assets directory (reused across every email service). */
const ASSETS_DIR = path.join(
    __dirname,
    "..",
    "utils",
    "email-templates",
    "assets",
);

/**
 * HTML-escapes a string to prevent HTML/email injection (CWE-79). Every
 * dynamic value substituted into the template via {@link BackupEmailService._fill}
 * passes through this first. Mirrors the identical private helper duplicated
 * in every other email service in this codebase (`ServerNotificationService`,
 * `AdminAccessEmailService`) — there is deliberately no shared util;
 * each email-sending file owns its own copy.
 *
 * @param {string|number|null|undefined} value
 * @returns {string}
 * @private
 */
function _escapeHtml(value) {
    if (value == null) return "";
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#x27;");
}

/**
 * Formats a byte count as a human-readable string (`"12.43 MB"`). Pure
 * function — no state, no side effects — kept at module scope rather than as
 * a class method.
 *
 * @param {number} bytes
 * @returns {string}
 * @private
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

class BackupEmailService {
    /**
     * Whether the master switch for purge-backup email notification is on.
     * Defaults to `true` — only the literal string `"false"` disables it.
     *
     * @returns {boolean}
     */
    static isEnabled() {
        return (
            String(process.env.BACKUP_EMAIL_ENABLED).toLowerCase() !== "false"
        );
    }

    /**
     * Sends a notification-only email about a completed purge. NO archive
     * attachment — the email directs recipients to the Backup tab.
     *
     * NEVER throws; every outcome is returned as a result object.
     *
     * @param {object} params
     * @param {string} [params.scopeLabel] - Human-readable scope (e.g. `"T_"` or `"custom (3 tables)"`).
     * @param {number} [params.totalRows] - Total row count purged.
     * @param {number} [params.tableCount] - Table count purged.
     * @param {number|string} params.adminId - Acting admin's numeric id (T_ADMINS_DEV.ID).
     * @param {string|null} [params.requestId]
     * @returns {Promise<{ sent: boolean, reason?: string, cause?: string, recipientCount?: number }>}
     *
     * @example
     * const result = await BackupEmailService.sendPurgeNotification({
     *     scopeLabel: "T_",
     *     totalRows: 4213,
     *     tableCount: 3,
     *     adminId: 7,
     *     requestId: "req-abc123",
     * });
     */
    static async sendPurgeNotification({
        scopeLabel,
        totalRows,
        tableCount,
        adminId,
        requestId = null,
    }) {
        try {
            if (!BackupEmailService.isEnabled()) {
                logger.info(
                    backupEmailMessages.SEND_SKIPPED_DISABLED(adminId),
                );
                return { sent: false, reason: "disabled" };
            }

            const recipients =
                await BackupEmailService._resolveRecipientEmails(adminId);
            if (recipients.length === 0) {
                logger.warning(
                    backupEmailMessages.SEND_SKIPPED_NO_RECIPIENTS(adminId),
                );
                return { sent: false, reason: "no-recipients" };
            }

            const tblCount = tableCount ?? 0;
            const rowCount = totalRows ?? 0;

            const html = BackupEmailService._buildHtml({
                adminId,
                requestId,
                scopeLabel: scopeLabel || "(scope not provided)",
                tableCount: tblCount,
                rowCount,
            });

            const subject = `[${PRODUCT_NAME}] Data purge completed — ${tblCount} table(s), ${rowCount} row(s) deleted`;

            const mailOptions = {
                from: SharedTransporter.getDefaultFrom(),
                to: recipients.join(", "),
                subject,
                text: BackupEmailService._buildPlainText({
                    adminId,
                    requestId,
                    scopeLabel: scopeLabel || "(scope not provided)",
                    tableCount: tblCount,
                    rowCount,
                }),
                html,
                attachments: BackupEmailService._logoAttachments(),
            };

            try {
                await SharedTransporter.getTransporter().sendMail(mailOptions);
                logger.info(
                    backupEmailMessages.SEND_SUCCESS(
                        adminId,
                        recipients.length,
                    ),
                );
                return { sent: true, recipientCount: recipients.length };
            } catch (err) {
                const cause = err?.message ?? String(err);
                logger.warning(
                    backupEmailMessages.SEND_FAILED(adminId, cause),
                );
                return {
                    sent: false,
                    reason: "send-error",
                    cause,
                    recipientCount: recipients.length,
                };
            }
        } catch (err) {
            const cause = err?.message ?? String(err);
            logger.warning(backupEmailMessages.SEND_FAILED(adminId, cause));
            return { sent: false, reason: "unexpected-error", cause };
        }
    }

    // ─── Private helpers ────────────────────────────────────────────────────

    /**
     * Resolves the deduplicated recipient list: every ACTIVE SUPER_ADMIN with
     * an EMAIL on file, UNIONED with the acting admin (always included — they
     * took the backup). One T_ADMINS_DEV read; a lookup failure is logged and
     * yields no recipients rather than throwing.
     *
     * @param {number|string} adminId - acting admin's numeric id
     * @returns {Promise<string[]>} Deduplicated recipient email addresses.
     * @private
     */
    static async _resolveRecipientEmails(adminId) {
        let admins = [];
        try {
            admins = await AdminModel.findAll();
        } catch (err) {
            logger.warning(backupEmailMessages.RECIPIENT_LOOKUP_FAILED(err));
        }

        const seen = new Set();
        const emails = [];
        for (const admin of admins) {
            const isActor = String(admin.ID) === String(adminId);
            const isActiveSuperAdmin =
                admin.ROLE === "SUPER_ADMIN" && String(admin.IS_ACTIVE ?? "Y") === "Y";
            if (!isActor && !isActiveSuperAdmin) continue;
            const email = credentialAddressOf(admin);
            if (email && !seen.has(email)) {
                seen.add(email);
                emails.push(email);
            }
        }
        return emails;
    }

    /**
     * Formats the current local time using `DB_TIMEZONE_OFFSET_MINUTES`.
     * Identical convention to every other email service's `_formatLocalTime()`.
     *
     * @returns {string} e.g. "Jul 28, 2026, 2:02 PM UTC+08:00"
     * @private
     */
    static _formatLocalTime() {
        const offsetMin = dbTimezoneOffsetMinutes();
        const localMs = Date.now() + offsetMin * 60_000;
        const shifted = new Date(localMs);
        const sign = offsetMin >= 0 ? "+" : "-";
        const absMin = Math.abs(offsetMin);
        const hh = String(Math.floor(absMin / 60)).padStart(2, "0");
        const mm = String(absMin % 60).padStart(2, "0");
        const label = `UTC${sign}${hh}:${mm}`;
        return (
            shifted.toLocaleString("en-US", {
                timeZone: "UTC",
                dateStyle: "medium",
                timeStyle: "short",
            }) + ` ${label}`
        );
    }

    /**
     * Returns Nodemailer attachment descriptors for the AUMOVIO logo `cid:`
     * embeddings (dark/light CSS swap). Returns `[]` when a logo file is
     * absent so the email still sends. Mirrors `ServerNotificationService`.
     *
     * @returns {Array<{ filename: string, path: string, cid: string }>}
     * @private
     */
    static _logoAttachments() {
        const logoPathDark = path.join(
            ASSETS_DIR,
            "AUMOVIO_Logo_orange_white_RGB.png",
        );
        const logoPathLight = path.join(
            ASSETS_DIR,
            "AUMOVIO_Logo_orange_black_RGB.png",
        );

        if (!fs.existsSync(logoPathDark) || !fs.existsSync(logoPathLight)) {
            return [];
        }

        return [
            {
                filename: "AUMOVIO_Logo_orange_black_RGB.png",
                path: logoPathLight,
                cid: "app-logo-light",
            },
            {
                filename: "AUMOVIO_Logo_orange_white_RGB.png",
                path: logoPathDark,
                cid: "app-logo-dark",
            },
        ];
    }

    /**
     * Renders `db-backup-notification.html`, filling every `{{key}}`
     * placeholder with an HTML-escaped value (CWE-79).
     *
     * @param {object} opts
     * @returns {string} Rendered HTML.
     * @private
     */
    static _buildHtml({
        adminId,
        requestId,
        scopeLabel,
        tableCount,
        rowCount,
    }) {
        const template = fs.readFileSync(TEMPLATE_PATH, "utf8");
        const firedAt = BackupEmailService._formatLocalTime();

        const vars = {
            subject: `Data purge completed — ${tableCount} table(s), ${rowCount} row(s) deleted`,
            preheader: `Data purge triggered by admin #${adminId}.`,
            triggeredBy: `Admin #${adminId}`,
            firedAt,
            scopeLabel,
            tableCount: String(tableCount),
            rowCount: String(rowCount),
            requestId: requestId ?? "n/a",
            downloadNote:
                "Go to System Admin \u2192 Data Purge, Backup & Restore \u2192 Backup tab \u2192 Purge Backups to download the full pre-purge archive.",
        };

        return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
            if (!Object.prototype.hasOwnProperty.call(vars, key)) return match;
            return _escapeHtml(vars[key]);
        });
    }

    /**
     * Builds the plain-text alternative body.
     *
     * @param {object} opts
     * @returns {string}
     * @private
     */
    static _buildPlainText({
        adminId,
        requestId,
        scopeLabel,
        tableCount,
        rowCount,
    }) {
        const lines = [
            `[${PRODUCT_NAME}] Data purge completed — ${tableCount} table(s), ${rowCount} row(s) deleted`,
            "",
            `Triggered by: Admin #${adminId}`,
            `Scope: ${scopeLabel}`,
            `Tables: ${tableCount}`,
            `Rows deleted: ${rowCount}`,
            "",
            "Download the pre-purge backup archive from:",
            "System Admin \u2192 Data Purge, Backup & Restore \u2192 Backup tab \u2192 Purge Backups",
            "",
            `Request ID: ${requestId ?? "n/a"}`,
        ];
        return lines.join("\n");
    }
}

module.exports = BackupEmailService;
