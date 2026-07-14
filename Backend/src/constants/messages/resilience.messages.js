"use strict";

/**
 * @fileoverview Resilience layer (RetryPolicy / BatchGuard / email
 * protection) log message templates.
 * Used ONLY in logger calls — never thrown or sent to clients.
 */

const resilienceMessages = {
    // ── RetryPolicy ──────────────────────────────────────────────────────────

    /**
     * Logged before every attempt is invoked (logger.debug) — the granular
     * per-attempt trace, invisible unless `LOG_LEVEL=DEBUG`.
     * @param {string} label - RetryPolicy label identifying the guarded operation.
     * @param {number} attempt - 1-indexed attempt number about to run.
     * @param {number} max - The policy's configured `maxAttempts` ceiling (the
     *   classification-specific cap is not yet known — classification only
     *   happens after a failure).
     * @returns {string}
     */
    ATTEMPT_START: (label, attempt, max) =>
        `[${label}] Attempt ${attempt}/${max} starting`,

    /**
     * Logged when an attempt resolves successfully (logger.debug).
     * @param {string} label
     * @param {number} attempt - 1-indexed attempt number that succeeded.
     * @param {number} ms - Elapsed time for the attempt, in milliseconds.
     * @returns {string}
     */
    ATTEMPT_OK: (label, attempt, ms) =>
        `[${label}] Attempt ${attempt} succeeded in ${ms}ms`,

    /**
     * Logged the moment an attempt throws — BEFORE the retry/abort/rethrow
     * decision is made (logger.debug). Complements `RETRYING`/`RETRY_EXHAUSTED`,
     * which log the decision itself; this line is the raw per-attempt trace.
     * @param {string} label
     * @param {number} attempt - 1-indexed attempt number that just failed.
     * @param {string|null} classification - The error's classification (or `null` when no classifier was configured).
     * @param {string} cause - `err.message` of the failure.
     * @returns {string}
     */
    ATTEMPT_FAIL: (label, attempt, classification, cause) =>
        `[${label}] Attempt ${attempt} failed (classification=${classification ?? "none"}): ${cause}`,

    /**
     * Logged immediately before the backoff sleep actually happens (logger.debug).
     * @param {string} label
     * @param {number} attempt - 1-indexed attempt number that is about to be retried.
     * @param {number} delayMs - The actual computed backoff delay (exponential + jitter), in milliseconds.
     * @returns {string}
     */
    BACKOFF: (label, attempt, delayMs) =>
        `[${label}] Backing off ${delayMs}ms before retrying attempt ${attempt + 1}`,

    /**
     * Logged when the `onRetry` hook resolves `{ resolved }` — a prior attempt
     * had actually committed and the network ack was lost (the "commit-ack-lost"
     * recovery). Operationally important, so this is `logger.info` (visible by
     * default, unlike the DEBUG-only attempt trace).
     * @param {string} label
     * @param {string|number|null} key - Identifying key for the recovered
     *   record (e.g. a primary-key value), when the `onRetry` hook or its resolved value exposes one.
     * @returns {string}
     */
    IDEMPOTENT_RESOLVE: (label, key) =>
        `[${label}] Idempotency probe found a prior committed result — ack-lost recovery${key ? ` (key=${key})` : ""}, retry loop short-circuited`,

    /**
     * Logged on every retried attempt (logger.warning) — before the backoff sleep.
     * @param {string} label - RetryPolicy label identifying the guarded operation.
     * @param {number} attempt - 1-indexed attempt number that just failed.
     * @param {number} max - Effective attempt cap for this error's classification.
     * @param {string} cause - `err.message` of the failure that triggered the retry.
     * @returns {string}
     */
    RETRYING: (label, attempt, max, cause) =>
        `[${label}] Retry ${attempt}/${max} after transient failure: ${cause}`,

    /**
     * Logged when the attempt budget for an error's classification is exhausted (logger.error).
     * @param {string} label
     * @param {number} attempts - Total attempts made before giving up.
     * @param {string} cause - `err.message` of the final failure.
     * @returns {string}
     */
    RETRY_EXHAUSTED: (label, attempts, cause) =>
        `[${label}] Retry budget exhausted after ${attempts} attempt(s): ${cause}`,

    // ── BatchGuard ───────────────────────────────────────────────────────────

    /**
     * Logged at the start of a guarded batch run (logger.debug).
     * @param {string} label - BatchGuard label identifying the batch operation.
     * @param {number} total - Total item count in the batch.
     * @param {number} concurrency - Configured max concurrent in-flight items.
     * @returns {string}
     */
    BATCH_START: (label, total, concurrency) =>
        `[${label}] Batch starting — ${total} item(s), concurrency ${concurrency}`,

    /**
     * Logged once a batch run has fully settled (logger.info) — the
     * segregation summary, visible by default.
     * @param {string} label
     * @param {number} succeeded - Count of items in `succeeded[]`.
     * @param {number} failed - Count of items in `failed[]`.
     * @param {number} pending - Count of items in `pending[]`.
     * @param {number} ms - Total elapsed wall-clock time for the batch, in milliseconds.
     * @returns {string}
     */
    BATCH_DONE: (label, succeeded, failed, pending, ms) =>
        `[${label}] Batch done in ${ms}ms — succeeded=${succeeded} failed=${failed} pending=${pending}`,

    /**
     * Logged when a FATAL_SESSION exhaustion aborts the remaining un-started
     * items in a batch (logger.error).
     * @param {string} label - BatchGuard label identifying the batch operation.
     * @param {number} remaining - Count of un-started items moved to `pending`.
     * @param {string} cause - `err.message` of the fatal-session failure that triggered the abort.
     * @returns {string}
     */
    BATCH_ABORTED: (label, remaining, cause) =>
        `[${label}] Batch aborted after a fatal session error — ${remaining} remaining item(s) moved to pending: ${cause}`,

    // ── Generic phase marker ─────────────────────────────────────────────────

    /**
     * Generic DEBUG phase-boundary marker for reliability-layer call sites that
     * don't warrant a dedicated template (e.g. "email dispatch phase start").
     * @param {string} label - Identifies the phase/operation.
     * @param {string} detail - Human-readable detail (e.g. "12 item(s)").
     * @returns {string}
     */
    PHASE: (label, detail) => `[${label}] ${detail}`,

    // ── Email protection ─────────────────────────────────────────────────────

    /**
     * Logged on every successful send — primary or fallback tier (logger.debug).
     * @param {string} label - Identifies the email flow (e.g. "welcome-email").
     * @param {string|null} recipient - The resolved `to` address(es) for the send that succeeded.
     * @param {"primary"|"fallback"} tier - Which tier delivered the email.
     * @param {number} attempt - 1-indexed attempt number that succeeded within its tier.
     * @returns {string}
     */
    EMAIL_ATTEMPT_OK: (label, recipient, tier, attempt) =>
        `[${label}] Email delivered via ${tier} tier on attempt ${attempt} to ${recipient ?? "unknown"}`,

    /**
     * Logged once per `sendProtected()` call with the final outcome counts
     * (logger.info) — a high-value operational summary, visible by default.
     * @param {string} label
     * @param {number} delivered - 1 when the primary tier delivered, else 0.
     * @param {number} fallbackDelivered - 1 when the fallback tier delivered, else 0.
     * @param {number} failed - 1 when both tiers failed (or no fallback was usable), else 0.
     * @returns {string}
     */
    EMAIL_DELIVERY_SUMMARY: (label, delivered, fallbackDelivered, failed) =>
        `[${label}] Email delivery summary — delivered=${delivered} fallbackDelivered=${fallbackDelivered} failed=${failed}`,

    /**
     * Logged on every retried email send attempt (logger.warning).
     * @param {string} label - Identifies the email flow (e.g. "welcome-email").
     * @param {number} attempt
     * @param {number} max
     * @param {string} cause
     * @returns {string}
     */
    EMAIL_RETRYING: (label, attempt, max, cause) =>
        `[${label}] Email retry ${attempt}/${max} after transient SMTP failure: ${cause}`,

    /**
     * Logged when primary delivery fails and the flow falls back to the
     * configured fallback recipients (logger.warning).
     * @param {string[]|string} recipients - Fallback recipient address(es).
     * @returns {string}
     */
    EMAIL_FALLBACK: (recipients) =>
        `Primary email delivery failed — falling back to: ${Array.isArray(recipients) ? recipients.join(", ") : recipients}`,

    /**
     * Logged when both the primary and fallback tiers are exhausted (logger.error).
     * @param {string} label
     * @param {string} cause
     * @returns {string}
     */
    EMAIL_FAILED: (label, cause) =>
        `[${label}] Email delivery failed on both primary and fallback tiers: ${cause}`,

    /**
     * Logged when a send is skipped because the wall-clock budget for the whole
     * email-dispatch phase of a batch operation is already exhausted
     * (logger.warning — the outcome is recorded as a structured failure in the
     * batch report, never silently dropped).
     * @param {string} label - Identifies the specific recipient/message skipped.
     * @returns {string}
     */
    EMAIL_BUDGET_EXHAUSTED: (label) =>
        `[${label}] Email phase budget exhausted — skipping remaining send(s).`,
};

module.exports = { resilienceMessages };
