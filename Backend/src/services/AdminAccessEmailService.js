"use strict";

/**
 * @fileoverview Access Control — who receives a temporary admin password, and
 * the email that carries it.
 *
 * WHAT THIS FILE DOES
 * -------------------
 *   resolveRecipient(username, overrideEmail)
 *       Decides the ONE mailbox a new temporary password may go to, before
 *       anything is written. The address on file (T_ADMINS_DEV.EMAIL, else
 *       T_USERS_DEV.EMAIL for the same username) first; an address typed by
 *       the operator is accepted only when there is no usable one on file.
 *       Throws an AppError when there is no acceptable recipient, so the
 *       caller never creates an account nobody can claim.
 *
 *   sendTemporaryPassword({...})
 *       Sends the "access granted" / "password reset" email. NEVER throws —
 *       every outcome is logged and returned (mirrors BackupEmailService),
 *       because by the time it runs the account row is already written and the
 *       caller must still answer the request.
 *
 * CREDENTIAL HANDLING
 * -------------------
 * The plaintext temporary password is a parameter of sendTemporaryPassword and
 * nothing else: it is never logged, never returned, never placed in the subject
 * line. Log lines name the account, the recipient SOURCE and the outcome — never
 * the address (PII) and never the password.
 */

const fs = require("fs");
const path = require("path");

const { AppError, ADMIN_ERRORS } = require("../constants/errors");
const { HTTP_STATUS } = require("../constants");
const { logger } = require("../utils/logger");
const { adminMessages } = require("../constants/messages");
const { dbTimezoneOffsetMinutes } = require("../utils/dbTimezone");
const { singleAddress, maskAddress, credentialAddressOf } = require("../utils/emailAddress");
const AdminModel = require("../models/admin.model");
const UserModel = require("../models/user.model");
const SharedTransporter = require("./email/SharedTransporter");

const TEMPLATE_PATH = path.join(
    __dirname,
    "..",
    "utils",
    "email-templates",
    "admin-access",
    "temporary-password.html",
);

const ASSETS_DIR = path.join(__dirname, "..", "utils", "email-templates", "assets");

/** Product name shown in the email. */
const PRODUCT_NAME = process.env.APP_NAME || "CATHERINE";

/** Where a recipient address came from — returned to the caller and logged. */
const RECIPIENT_SOURCE = Object.freeze({ PROFILE: "PROFILE", OVERRIDE: "OVERRIDE" });

/** Which email to send. */
const EMAIL_KIND = Object.freeze({ GRANTED: "granted", RESET: "reset" });

const ROLE_LABELS = Object.freeze({
    SUPER_ADMIN: "Super Admin",
    ADMIN: "Admin",
    USER: "User",
});

/**
 * HTML-escapes a template value (CWE-79). Each email service in this codebase
 * owns its own copy by convention — see BackupEmailService._escapeHtml.
 *
 * @param {*} value
 * @returns {string}
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
 * Normalises the optional override input: absent, null, "" and whitespace-only
 * all mean "not supplied". A non-string (object/array — an injection-shaped
 * body) is kept as-is so resolveRecipient can refuse it as invalid rather than
 * silently treating it as absent.
 *
 * @param {*} raw
 * @returns {string|null|object}
 */
function _normaliseOverride(raw) {
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== "string") return raw;
    const trimmed = raw.trim();
    return trimmed === "" ? null : trimmed;
}

class AdminAccessEmailService {
    static RECIPIENT_SOURCE = RECIPIENT_SOURCE;
    static EMAIL_KIND = EMAIL_KIND;

    /**
     * The address on file for an account: the admin row's EMAIL, else the
     * EMAIL of the T_USERS_DEV row with the same username. `conflict` is kept
     * for the API shape and is always false — each table holds one address.
     *
     * @param {string} username
     * @returns {Promise<{ address: string|null, conflict: boolean }>}
     * @throws whatever the account read throws — callers decide how to degrade
     */
    static async profileContactFor(username) {
        const admin = await AdminModel.findByUsername(String(username));
        let address = credentialAddressOf(admin);
        if (!address) {
            address = credentialAddressOf(await UserModel.findByUsername(String(username)));
        }
        return { address, conflict: false };
    }

    /**
     * Decides the recipient for a temporary password. Runs BEFORE any write.
     *
     * | address on file     | override | result                             |
     * |---------------------|----------|------------------------------------|
     * | usable              | absent   | PROFILE                            |
     * | usable              | present  | 400 EMAIL_OVERRIDE_NOT_ALLOWED     |
     * | none                | valid    | OVERRIDE                           |
     * | none                | invalid  | 400 INVALID_EMAIL                  |
     * | none                | absent   | 422 EMAIL_REQUIRED                 |
     * | lookup fails        | any      | 503 RECIPIENT_LOOKUP_UNAVAILABLE   |
     *
     * @param {string} username
     * @param {*} overrideEmail - operator-typed address, optional
     * @returns {Promise<{ address: string, source: 'PROFILE'|'OVERRIDE', hint: string }>}
     * @throws {AppError}
     */
    static async resolveRecipient(username, overrideEmail) {
        const override = _normaliseOverride(overrideEmail);

        let profileAddress;
        try {
            ({ address: profileAddress } =
                await AdminAccessEmailService.profileContactFor(username));
        } catch (err) {
            logger.warning(
                adminMessages.TEMP_PASSWORD_RECIPIENT_LOOKUP_FAILED(username, err?.message ?? String(err)),
            );
            // Type deliberately NOT one of the frontend's outage types — this
            // must render inline in the dialog, not take over the screen.
            throw new AppError(ADMIN_ERRORS.RECIPIENT_LOOKUP_UNAVAILABLE, HTTP_STATUS.SERVICE_UNAVAILABLE, {
                type: "RecipientLookupError",
            });
        }

        if (profileAddress) {
            if (override != null) {
                logger.warning(adminMessages.TEMP_PASSWORD_RECIPIENT_REFUSED(username, "override supplied but an address is on file"));
                throw new AppError(ADMIN_ERRORS.EMAIL_OVERRIDE_NOT_ALLOWED, HTTP_STATUS.BAD_REQUEST, {
                    type: "ValidationError",
                    details: [{ field: "overrideEmail", issue: "An email address is already on file for this account." }],
                });
            }
            return { address: profileAddress, source: RECIPIENT_SOURCE.PROFILE, hint: maskAddress(profileAddress) };
        }

        if (override == null) {
            logger.warning(adminMessages.TEMP_PASSWORD_RECIPIENT_REFUSED(username, "no address on file and no override"));
            throw new AppError(ADMIN_ERRORS.EMAIL_REQUIRED, HTTP_STATUS.UNPROCESSABLE, {
                type: "ValidationError",
                details: [{ field: "overrideEmail", issue: "Required — no email address on file for this account." }],
            });
        }

        // singleAddress accepts strings only — an array or object body value
        // is refused here rather than coerced (CWE-843).
        const address = singleAddress(override);
        if (!address) {
            logger.warning(adminMessages.TEMP_PASSWORD_RECIPIENT_REFUSED(username, "override is not one valid address"));
            throw new AppError(ADMIN_ERRORS.INVALID_EMAIL, HTTP_STATUS.BAD_REQUEST, {
                type: "ValidationError",
                details: [{ field: "overrideEmail", issue: "Must be exactly one plain email address." }],
            });
        }
        return { address, source: RECIPIENT_SOURCE.OVERRIDE, hint: maskAddress(address) };
    }

    /**
     * Sends the temporary-password email. NEVER throws.
     *
     * @param {object} params
     * @param {string} params.to            - a resolveRecipient() address
     * @param {'PROFILE'|'OVERRIDE'} params.source
     * @param {string} params.username      - the account's sign-in username
     * @param {string} params.role
     * @param {string} params.tempPassword  - plaintext; used for the body only
     * @param {number} params.expiresAt     - epoch ms
     * @param {'granted'|'reset'} params.kind
     * @returns {Promise<{ delivered: boolean, reason?: string, cause?: string }>}
     */
    static async sendTemporaryPassword({ to, source, username, role, tempPassword, expiresAt, kind }) {
        try {
            const vars = AdminAccessEmailService._buildVars({ username, role, tempPassword, expiresAt, kind });
            const mailOptions = {
                from: SharedTransporter.getDefaultFrom(),
                to,
                subject: vars.subject,
                text: AdminAccessEmailService._buildPlainText(vars),
                html: AdminAccessEmailService._buildHtml(vars),
                attachments: AdminAccessEmailService._logoAttachments(),
            };

            try {
                await SharedTransporter.getTransporter().sendMail(mailOptions);
            } catch (err) {
                const cause = err?.message ?? String(err);
                logger.warning(adminMessages.TEMP_PASSWORD_EMAIL_FAILED(username, kind, cause));
                return { delivered: false, reason: "send-error", cause };
            }

            logger.info(adminMessages.TEMP_PASSWORD_EMAIL_SENT(username, kind, source));
            return { delivered: true };
        } catch (err) {
            // Template read / render failure — still never throws.
            const cause = err?.message ?? String(err);
            logger.warning(adminMessages.TEMP_PASSWORD_EMAIL_FAILED(username, kind, cause));
            return { delivered: false, reason: "unexpected-error", cause };
        }
    }

    // ─── Private helpers ────────────────────────────────────────────────────

    /**
     * Formats an instant in the deployment's wall-clock zone
     * (DB_TIMEZONE_OFFSET_MINUTES, default UTC+8) — same convention as every
     * other email service's _formatLocalTime.
     *
     * @param {number} ms
     * @returns {string} e.g. "Sep 28, 2026, 2:02 PM UTC+08:00"
     * @private
     */
    static _formatLocalTime(ms) {
        const offsetMin = dbTimezoneOffsetMinutes();
        const shifted = new Date(ms + offsetMin * 60_000);
        const sign = offsetMin >= 0 ? "+" : "-";
        const absMin = Math.abs(offsetMin);
        const hh = String(Math.floor(absMin / 60)).padStart(2, "0");
        const mm = String(absMin % 60).padStart(2, "0");
        return (
            shifted.toLocaleString("en-US", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }) +
            ` UTC${sign}${hh}:${mm}`
        );
    }

    /** @private */
    static _signInUrl() {
        const base = (process.env.FRONTEND_BASE_URL ?? "").replace(/\/$/, "");
        return base ? `${base}/auth` : "";
    }

    /**
     * Every value the HTML and plain-text bodies need. Plain strings only —
     * escaping happens in _buildHtml.
     *
     * @private
     */
    static _buildVars({ username, role, tempPassword, expiresAt, kind }) {
        const isReset = kind === EMAIL_KIND.RESET;
        const roleLabel = ROLE_LABELS[role] ?? String(role);
        const expiresAtLabel = AdminAccessEmailService._formatLocalTime(expiresAt);
        const signInUrl = AdminAccessEmailService._signInUrl();

        const headline = isReset
            ? `Your ${PRODUCT_NAME} password was reset`
            : `You now have access to ${PRODUCT_NAME}`;
        const intro = isReset
            ? `An administrator issued a new temporary password for account ${username}. Your previous password no longer works.`
            : `An administrator granted account ${username} the ${roleLabel} role in ${PRODUCT_NAME}.`;

        return {
            subject: isReset
                ? `[${PRODUCT_NAME}] Your password was reset`
                : `[${PRODUCT_NAME}] Your access and temporary password`,
            preheader: `Temporary password for account ${username} — valid until ${expiresAtLabel}.`,
            badge: isReset ? "Password reset" : "Access granted",
            headline,
            intro,
            username: String(username),
            roleLabel,
            tempPassword,
            expiresAtLabel,
            signInUrl,
            signInLabel: signInUrl || `the ${PRODUCT_NAME} sign-in page`,
            robotNote: "",
            steps: `Sign in with your username and this temporary password. You will be asked to set your own password straight away; until you do, nothing else in ${PRODUCT_NAME} is available.`,
            expiryNote: `This temporary password works until ${expiresAtLabel} and can only be used to set a new password. After that it stops working and an administrator has to send you a new one.`,
            safetyNote: `If you did not expect this email, do not use the password — tell your ${PRODUCT_NAME} administrator.`,
        };
    }

    /** @private */
    static _buildHtml(vars) {
        const template = fs.readFileSync(TEMPLATE_PATH, "utf8");
        return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
            if (!Object.prototype.hasOwnProperty.call(vars, key)) return match;
            return _escapeHtml(vars[key]);
        });
    }

    /** @private */
    static _buildPlainText(vars) {
        const lines = [
            vars.headline,
            "",
            vars.intro,
            "",
            `Sign-in ID:          ${vars.username}`,
            `Role:                ${vars.roleLabel}`,
            `Temporary password:  ${vars.tempPassword}`,
            `Valid until:         ${vars.expiresAtLabel}`,
            "",
            `Sign in at ${vars.signInLabel}.`,
            vars.steps,
            "",
            vars.expiryNote,
        ];
        if (vars.robotNote) lines.push("", vars.robotNote);
        lines.push("", vars.safetyNote, "", `Automated message from ${PRODUCT_NAME}. Do not reply to this email.`);
        return lines.join("\n");
    }

    /**
     * AUMOVIO logo cid attachments (dark/light swap). Returns [] when the files
     * are absent so the email still sends. Mirrors BackupEmailService.
     *
     * @private
     */
    static _logoAttachments() {
        const light = path.join(ASSETS_DIR, "AUMOVIO_Logo_orange_black_RGB.png");
        const dark = path.join(ASSETS_DIR, "AUMOVIO_Logo_orange_white_RGB.png");
        if (!fs.existsSync(light) || !fs.existsSync(dark)) return [];
        return [
            { filename: "AUMOVIO_Logo_orange_black_RGB.png", path: light, cid: "app-logo-light" },
            { filename: "AUMOVIO_Logo_orange_white_RGB.png", path: dark, cid: "app-logo-dark" },
        ];
    }
}

module.exports = AdminAccessEmailService;
