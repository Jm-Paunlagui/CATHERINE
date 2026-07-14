"use strict";

/**
 * @fileoverview Budgeted, self-healing email dispatch — the Email Protection
 * layer.
 *
 * WHAT THIS FILE DOES
 * -------------------
 * `EmailProtectionService.sendProtected()` wraps a single outbound email in
 * a two-tier resilience policy: retried primary delivery followed by an
 * optional fallback tier (e.g. admin recipients) when the primary tier is
 * exhausted. It NEVER throws — every outcome (delivered, delivered-via-
 * fallback, or fully failed) resolves a structured result object so callers
 * can fold the outcome into their HTTP response instead of losing it to a
 * fire-and-forget `setImmediate()` (the failure mode this layer fixes — a
 * DB timeout mid-batch produced a "successful" response with zero emails
 * sent and no record of the failure).
 *
 * This is the template's global email handler: every email flow in a
 * consuming application should dispatch through `sendProtected()` rather
 * than calling `transporter.sendMail()` directly.
 *
 * HOW IT WORKS
 * ------------
 * 1. **Primary tier** — a `RetryPolicy` (classifier=
 *    `RetryPolicy.classifySmtpError`, `maxAttempts=EMAIL_RETRY_ATTEMPTS`)
 *    drives `SharedTransporter.getTransporter().sendMail(buildMailOptions())`.
 *    `buildMailOptions` is re-invoked on *every* attempt (including the
 *    first) so attachments/buffers that may need regeneration are always
 *    fresh. A `PERMANENT_SMTP` classification (e.g. a 550 hard bounce) caps
 *    the primary tier at exactly one attempt — see
 *    `RetryPolicy.CLASSIFICATION_ATTEMPT_CAPS` — so a permanent rejection
 *    skips straight to the fallback tier instead of wasting the retry
 *    budget on a failure that will never succeed.
 * 2. **Fallback tier** — triggered only when the primary tier is exhausted
 *    AND a `fallback` was supplied. `fallback.resolveRecipients()` is
 *    awaited first; if it yields at least one address, a second
 *    `RetryPolicy` (`maxAttempts=EMAIL_FALLBACK_RETRY_ATTEMPTS`) drives
 *    `fallback.buildMailOptions(recipients)`.
 * 3. Both tiers exhausted — or no fallback configured, or the fallback
 *    resolved zero recipients — resolves `status: "FAILED"` with a
 *    human-readable `cause` and the last observed `smtpErrorCode`.
 *
 * Classification and backoff are entirely delegated to `RetryPolicy`
 * (`../../utils/resilience`) — this file adds no SMTP error-matching logic
 * of its own. The `onRetry` hook re-derives the *effective attempt cap* for
 * a classification via the same public tables `RetryPolicy` exposes
 * (`RetryPolicy.CLASSIFICATION_ATTEMPT_CAPS`) purely so the
 * `EMAIL_RETRYING` log line can report an accurate "`attempt/max`" — it
 * does not re-implement classification.
 *
 * SECURITY (CWE-312): log lines never include mail body/HTML/attachments —
 * only the label, attempt counters, and `err.message` (which nodemailer
 * populates with protocol-level text, never message content).
 *
 * Complexity: O(a + b) time where `a`/`b` are the primary/fallback attempt
 * counts actually made (bounded by `EMAIL_RETRY_ATTEMPTS` +
 * `EMAIL_FALLBACK_RETRY_ATTEMPTS`), O(1) space.
 *
 * EXAMPLE
 * -------
 *   const EmailProtectionService = require("./EmailProtectionService");
 *
 *   const result = await EmailProtectionService.sendProtected({
 *       label: "welcome-email",
 *       buildMailOptions: () => ({
 *           from: SharedTransporter.getDefaultFrom(),
 *           to: userEmail,
 *           subject: "Welcome",
 *           html: renderedHtml,
 *       }),
 *       fallback: {
 *           resolveRecipients: () => AdminService.resolveNotificationEmails(),
 *           buildMailOptions: (recipients) => ({
 *               from: SharedTransporter.getDefaultFrom(),
 *               to: recipients.join(", "),
 *               subject: "Welcome email — undeliverable to user",
 *               html: fallbackHtml,
 *           }),
 *       },
 *   });
 *   // result: { status, recipient, fallbackRecipients, attempts,
 *   //           fallbackAttempts, cause, smtpErrorCode }
 *
 * SUPPORTED RESULT STATUSES
 * --------------------------
 * | Status     | Meaning                                                    |
 * |------------|------------------------------------------------------------|
 * | DELIVERED  | Primary tier succeeded (attempt 1..EMAIL_RETRY_ATTEMPTS).   |
 * | FALLBACK   | Primary tier exhausted; fallback tier succeeded.           |
 * | FAILED     | Both tiers exhausted, or no usable fallback was available. |
 */

const { RetryPolicy } = require("../../utils/resilience");
const { logger } = require("../../utils/logger");
const { resilienceMessages } = require("../../constants/messages");
const SharedTransporter = require("./SharedTransporter");

/** Result status constants — exposed so callers never hardcode magic strings. */
const STATUS = Object.freeze({
    DELIVERED: "DELIVERED",
    FALLBACK: "FALLBACK",
    FAILED: "FAILED",
});

/** SMTP retry backoff ceiling in ms — see RetryPolicy.js header ("SMTP base 500ms cap 8s"). */
const SMTP_MAX_DELAY_MS = 8000;

/**
 * Reads a positive-integer env var, falling back to `fallbackValue` when
 * unset, non-numeric, or non-positive.
 *
 * @param {string} name
 * @param {number} fallbackValue
 * @returns {number}
 */
function envInt(name, fallbackValue) {
    const raw = Number(process.env[name]);
    return Number.isInteger(raw) && raw > 0 ? raw : fallbackValue;
}

/**
 * Extracts a caller-facing SMTP error code from a caught send error —
 * prefers nodemailer's numeric `responseCode`, falls back to the system
 * `code` (e.g. `"ETIMEDOUT"`, `"ECONNECTION"`).
 *
 * @param {*} err
 * @returns {string|null}
 */
function extractSmtpErrorCode(err) {
    if (!err || typeof err !== "object") return null;
    if (err.responseCode !== undefined && err.responseCode !== null) {
        return String(err.responseCode);
    }
    if (typeof err.code === "string") return err.code;
    return null;
}

/**
 * Resolves the effective attempt cap for a classification using
 * `RetryPolicy`'s own public tables (reused, not duplicated) — falls back to
 * `maxAttempts` for `TRANSIENT_SMTP` (cap `null` in the table) or an
 * unrecognised classification.
 *
 * @param {string|null} classification
 * @param {number} maxAttempts
 * @returns {number}
 */
function effectiveCap(classification, maxAttempts) {
    const capsTable = RetryPolicy.CLASSIFICATION_ATTEMPT_CAPS;
    if (
        classification &&
        Object.prototype.hasOwnProperty.call(capsTable, classification)
    ) {
        const cap = capsTable[classification];
        return cap === null ? maxAttempts : cap;
    }
    return maxAttempts;
}

class EmailProtectionService {
    /**
     * Sends one email with retried primary delivery and an optional
     * fallback tier. **Never throws.**
     *
     * @param {object} opts
     * @param {() => object} opts.buildMailOptions - Builds nodemailer mail
     *   options for the PRIMARY recipient. Re-invoked on every attempt
     *   (including the first) so per-attempt attachment regeneration is
     *   supported.
     * @param {string} [opts.label="email"] - Human-readable label used in
     *   log messages and `RetryPolicy` labels (e.g. `"welcome-email"`).
     * @param {{
     *   resolveRecipients: () => Promise<string[]>,
     *   buildMailOptions: (recipients: string[]) => object,
     * }} [opts.fallback] - Optional fallback tier. Omit to fail hard once
     *   the primary tier is exhausted.
     * @returns {Promise<{
     *   status: "DELIVERED"|"FALLBACK"|"FAILED",
     *   recipient: string|null,
     *   fallbackRecipients: string[],
     *   attempts: number,
     *   fallbackAttempts: number,
     *   cause: string|null,
     *   smtpErrorCode: string|null,
     * }>}
     */
    async sendProtected({ buildMailOptions, label = "email", fallback = null } = {}) {
        const primaryMaxAttempts = envInt("EMAIL_RETRY_ATTEMPTS", 3);
        const fallbackMaxAttempts = envInt("EMAIL_FALLBACK_RETRY_ATTEMPTS", 3);
        const baseDelayMs = envInt("EMAIL_RETRY_BASE_DELAY_MS", 500);

        const primaryPolicy = new RetryPolicy({
            maxAttempts: primaryMaxAttempts,
            baseDelayMs,
            maxDelayMs: SMTP_MAX_DELAY_MS,
            classifier: RetryPolicy.classifySmtpError,
            label: `${label}:primary`,
        });

        let primaryAttempts = 0;
        let primaryRecipient = null;
        let primaryCause = null;
        let primaryErrorCode = null;

        try {
            await primaryPolicy.execute(
                async (attempt) => {
                    primaryAttempts = attempt;
                    const mailOptions = buildMailOptions();
                    primaryRecipient = mailOptions?.to ?? primaryRecipient;
                    return SharedTransporter.getTransporter().sendMail(mailOptions);
                },
                {
                    onRetry: async (err, attempt) => {
                        const classification = RetryPolicy.classifySmtpError(err);
                        const cap = effectiveCap(classification, primaryMaxAttempts);
                        // Only log a "retrying" line when another attempt will
                        // actually follow — an immediately-exhausting attempt
                        // (e.g. PERMANENT_SMTP, cap=1) is not a retry.
                        if (attempt < cap) {
                            logger.warning(
                                resilienceMessages.EMAIL_RETRYING(
                                    label,
                                    attempt,
                                    cap,
                                    err.message ?? String(err),
                                ),
                            );
                        }
                    },
                },
            );

            logger.debug(
                resilienceMessages.EMAIL_ATTEMPT_OK(label, primaryRecipient, "primary", primaryAttempts),
                { label, recipient: primaryRecipient, tier: "primary", attempt: primaryAttempts },
            );
            logger.info(
                resilienceMessages.EMAIL_DELIVERY_SUMMARY(label, 1, 0, 0),
                { label, delivered: 1, fallbackDelivered: 0, failed: 0 },
            );

            return {
                status: STATUS.DELIVERED,
                recipient: primaryRecipient,
                fallbackRecipients: [],
                attempts: primaryAttempts,
                fallbackAttempts: 0,
                cause: null,
                smtpErrorCode: null,
            };
        } catch (err) {
            primaryAttempts = err.attempts ?? primaryAttempts ?? 1;
            primaryCause = err.message ?? String(err);
            primaryErrorCode = extractSmtpErrorCode(err);
        }

        // ─── Primary tier exhausted — attempt the fallback tier ────────────

        if (
            !fallback ||
            typeof fallback.resolveRecipients !== "function" ||
            typeof fallback.buildMailOptions !== "function"
        ) {
            logger.error(resilienceMessages.EMAIL_FAILED(label, primaryCause));
            logger.info(
                resilienceMessages.EMAIL_DELIVERY_SUMMARY(label, 0, 0, 1),
                { label, delivered: 0, fallbackDelivered: 0, failed: 1 },
            );
            return {
                status: STATUS.FAILED,
                recipient: primaryRecipient,
                fallbackRecipients: [],
                attempts: primaryAttempts,
                fallbackAttempts: 0,
                cause: primaryCause,
                smtpErrorCode: primaryErrorCode,
            };
        }

        let fallbackRecipients = [];
        let resolveError = null;
        try {
            fallbackRecipients = (await fallback.resolveRecipients()) ?? [];
        } catch (err) {
            resolveError = err;
            fallbackRecipients = [];
        }

        if (!fallbackRecipients.length) {
            const cause = resolveError
                ? `${primaryCause}; fallback recipient resolution failed: ${resolveError.message ?? String(resolveError)}`
                : `${primaryCause} (no fallback recipients available)`;
            logger.error(resilienceMessages.EMAIL_FAILED(label, cause));
            logger.info(
                resilienceMessages.EMAIL_DELIVERY_SUMMARY(label, 0, 0, 1),
                { label, delivered: 0, fallbackDelivered: 0, failed: 1 },
            );
            return {
                status: STATUS.FAILED,
                recipient: primaryRecipient,
                fallbackRecipients: [],
                attempts: primaryAttempts,
                fallbackAttempts: 0,
                cause,
                smtpErrorCode: primaryErrorCode,
            };
        }

        logger.warning(resilienceMessages.EMAIL_FALLBACK(fallbackRecipients));

        const fallbackPolicy = new RetryPolicy({
            maxAttempts: fallbackMaxAttempts,
            baseDelayMs,
            maxDelayMs: SMTP_MAX_DELAY_MS,
            classifier: RetryPolicy.classifySmtpError,
            label: `${label}:fallback`,
        });

        let fallbackAttempts = 0;
        try {
            await fallbackPolicy.execute(
                async (attempt) => {
                    fallbackAttempts = attempt;
                    const mailOptions = fallback.buildMailOptions(fallbackRecipients);
                    return SharedTransporter.getTransporter().sendMail(mailOptions);
                },
                {
                    onRetry: async (err, attempt) => {
                        const classification = RetryPolicy.classifySmtpError(err);
                        const cap = effectiveCap(classification, fallbackMaxAttempts);
                        if (attempt < cap) {
                            logger.warning(
                                resilienceMessages.EMAIL_RETRYING(
                                    `${label}:fallback`,
                                    attempt,
                                    cap,
                                    err.message ?? String(err),
                                ),
                            );
                        }
                    },
                },
            );

            logger.debug(
                resilienceMessages.EMAIL_ATTEMPT_OK(
                    label,
                    fallbackRecipients.join(", "),
                    "fallback",
                    fallbackAttempts,
                ),
                {
                    label,
                    recipient: fallbackRecipients.join(", "),
                    tier: "fallback",
                    attempt: fallbackAttempts,
                },
            );
            logger.info(
                resilienceMessages.EMAIL_DELIVERY_SUMMARY(label, 0, 1, 0),
                { label, delivered: 0, fallbackDelivered: 1, failed: 0 },
            );

            return {
                status: STATUS.FALLBACK,
                recipient: primaryRecipient,
                fallbackRecipients,
                attempts: primaryAttempts,
                fallbackAttempts,
                cause: primaryCause,
                smtpErrorCode: primaryErrorCode,
            };
        } catch (err) {
            fallbackAttempts = err.attempts ?? fallbackAttempts ?? 1;
            const fallbackCause = err.message ?? String(err);
            const cause = `primary: ${primaryCause}; fallback: ${fallbackCause}`;
            logger.error(resilienceMessages.EMAIL_FAILED(label, cause));
            logger.info(
                resilienceMessages.EMAIL_DELIVERY_SUMMARY(label, 0, 0, 1),
                { label, delivered: 0, fallbackDelivered: 0, failed: 1 },
            );

            return {
                status: STATUS.FAILED,
                recipient: primaryRecipient,
                fallbackRecipients,
                attempts: primaryAttempts,
                fallbackAttempts,
                cause,
                smtpErrorCode: extractSmtpErrorCode(err) ?? primaryErrorCode,
            };
        }
    }
}

const instance = new EmailProtectionService();
instance.STATUS = STATUS;
instance.EmailProtectionService = EmailProtectionService;
module.exports = instance;
