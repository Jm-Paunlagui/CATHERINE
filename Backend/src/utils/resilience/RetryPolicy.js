"use strict";

/**
 * @fileoverview Transient-failure retry primitive with exponential backoff.
 *
 * WHAT THIS FILE DOES
 * -------------------
 * `RetryPolicy` retries a caller-supplied async operation when it fails with a
 * transient error, using exponential backoff with jitter. It is the single
 * source of truth for the DB / SMTP error classification table used across
 * the Data Protection + Email Protection reliability layer (batch write
 * paths, budgeted email dispatch).
 *
 * HOW IT WORKS
 * ------------
 * `execute(fn, hooks)` calls `fn(attempt)` (attempt starts at 1). On failure,
 * the error is classified via the `classifier` supplied to the constructor
 * (typically `RetryPolicy.classifyDbError` or `RetryPolicy.classifySmtpError`).
 * Each classification has an attempt cap (see `CLASSIFICATION_ATTEMPT_CAPS`)
 * — most permanent classes (DUPLICATE, PERMANENT_DB, PERMANENT_SMTP) fail
 * immediately with zero retries; FATAL_SESSION gets exactly one retry on the
 * assumption a fresh connection may recover; TRANSIENT_DB / TRANSIENT_SMTP
 * use the configured `maxAttempts`.
 *
 * Before giving up (and on every failed attempt), `hooks.onRetry(err, attempt)`
 * is awaited if supplied. Returning `{ resolved: value }` from `onRetry`
 * short-circuits the retry loop and resolves `execute()` with `value` — this
 * is the idempotency-probe escape hatch for the "commit-ack-lost" scenario:
 * a row insert may have actually committed before the network ack was lost,
 * so the very next thing a caller should do before retrying the write is
 * check whether it already landed.
 *
 * On exhaustion, the last error is re-thrown with `.attempts` (number of
 * attempts made) and `.classification` (string) attached, so callers
 * (`BatchGuard`, services) never need to re-derive either value.
 *
 * Backoff formula: `min(baseDelayMs * 2^(attempt-1), maxDelayMs) + jitter`,
 * where `jitter` is a uniform random value in `[0, baseDelayMs)`.
 *
 * Defaults are env-driven so an app built on this template tunes the whole
 * retry layer centrally from `.env` without touching call sites:
 * `DB_ROW_RETRY_MAX` (10), `DB_RETRY_BASE_DELAY_MS` (200),
 * `DB_RETRY_MAX_DELAY_MS` (5000).
 *
 * Complexity: O(k) time where k = attempts actually made (bounded by
 * `maxAttempts`), O(1) space — no per-attempt allocation beyond the backoff
 * delay computation.
 *
 * EXAMPLE
 * -------
 *   const policy = new RetryPolicy({
 *       classifier: RetryPolicy.classifyDbError,
 *       label: "batch-row",
 *   });
 *
 *   const row = await policy.execute(
 *       () => SomeModel.insertRow(payload),
 *       {
 *           onRetry: async (err, attempt) => {
 *               const existing = await SomeModel.findByKey(payload.key);
 *               if (existing) return { resolved: existing }; // ack-lost, already committed
 *           },
 *       },
 *   );
 *
 * SUPPORTED CLASSIFICATIONS
 * --------------------------
 * | Class          | Match (checked across err + err.originalError chain)        | Attempt cap        |
 * |----------------|---------------------------------------------------------------|--------------------|
 * | TRANSIENT_DB   | ORA-03113/03114/12170/12541/12514/12560/01013; NJS-040/500/  | configured maxAttempts |
 * |                | 501/503/510; /timed out getting connection/i; ECONNRESET/    |                    |
 * |                | ETIMEDOUT                                                     |                    |
 * | FATAL_SESSION  | ORA-00028/00031                                               | 2 (one retry)      |
 * | DUPLICATE      | ORA-00001                                                     | 1 (no retry)       |
 * | PERMANENT_DB   | any other ORA-XXXXX                                           | 1 (no retry)       |
 * | TRANSIENT_SMTP | nodemailer err.code ETIMEDOUT/ECONNECTION/ESOCKET/ECONNRESET/ | configured maxAttempts |
 * |                | EDNS/EPIPE; responseCode 421-499                              |                    |
 * | PERMANENT_SMTP | responseCode >= 500; anything unclassified                    | 1 (no retry)       |
 */

const { logger } = require("../logger");
const { resilienceMessages } = require("../../constants/messages");

// ─── Env-driven defaults (centralized tuning for the whole template) ────────

/**
 * Parses a positive-integer env var, falling back when unset or invalid.
 *
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function envInt(name, fallback) {
    const parsed = parseInt(process.env[name], 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// ─── Classification tables (single source of truth) ────────────────────────

/** ORA codes that are transient (network/session churn) — safe to retry. */
const TRANSIENT_DB_ORA_CODES = new Set([3113, 3114, 12170, 12541, 12514, 12560, 1013]);

/** ORA codes indicating the session itself was killed — one retry on a fresh connection. */
const FATAL_SESSION_ORA_CODES = new Set([28, 31]);

/** ORA code for a unique-constraint violation — not RetryPolicy's job (callers own regeneration). */
const DUPLICATE_ORA_CODE = 1;

/** Node.js system error codes that indicate a transient network failure. */
const TRANSIENT_DB_SYSTEM_CODES = new Set(["ECONNRESET", "ETIMEDOUT"]);

/** String patterns matched against the message chain for transient DB failures without an ORA/NJS code. */
const TRANSIENT_DB_STRING_PATTERNS = [
    /timed out getting connection/i,
    /NJS-(040|500|501|503|510)/,
];

/** nodemailer `err.code` values that indicate a transient SMTP/network failure. */
const TRANSIENT_SMTP_CODES = new Set([
    "ETIMEDOUT",
    "ECONNECTION",
    "ESOCKET",
    "ECONNRESET",
    "EDNS",
    "EPIPE",
]);

const CLASSIFICATIONS = Object.freeze({
    TRANSIENT_DB: "TRANSIENT_DB",
    FATAL_SESSION: "FATAL_SESSION",
    DUPLICATE: "DUPLICATE",
    PERMANENT_DB: "PERMANENT_DB",
    TRANSIENT_SMTP: "TRANSIENT_SMTP",
    PERMANENT_SMTP: "PERMANENT_SMTP",
});

/**
 * Attempt cap per classification. `null` means "use the RetryPolicy
 * instance's configured `maxAttempts`". Everything else is a hard cap that
 * overrides `maxAttempts` (e.g. FATAL_SESSION always gets exactly one retry
 * regardless of how high `maxAttempts` is configured).
 */
const CLASSIFICATION_ATTEMPT_CAPS = Object.freeze({
    [CLASSIFICATIONS.TRANSIENT_DB]: null,
    [CLASSIFICATIONS.FATAL_SESSION]: 2,
    [CLASSIFICATIONS.DUPLICATE]: 1,
    [CLASSIFICATIONS.PERMANENT_DB]: 1,
    [CLASSIFICATIONS.TRANSIENT_SMTP]: null,
    [CLASSIFICATIONS.PERMANENT_SMTP]: 1,
});

// ─── Error-chain helpers ─────────────────────────────────────────────────────

/**
 * Walks `err.originalError` links (the Oracle adapter attaches exactly one,
 * but the walk is capped at 5 to stay defensive against accidental cycles)
 * and returns every error object in the chain, including `err` itself.
 *
 * @param {*} err
 * @returns {Array<object>}
 */
function errorChain(err) {
    const chain = [];
    let current = err;
    let guard = 0;
    while (current && typeof current === "object" && guard < 5) {
        chain.push(current);
        current = current.originalError;
        guard += 1;
    }
    return chain;
}

/**
 * Extracts an Oracle error number from a single error object — prefers the
 * driver's own `errorNum` field, falling back to parsing `ORA-XXXXX` out of
 * the message.
 *
 * @param {*} err
 * @returns {number|null}
 */
function extractOraCode(err) {
    if (typeof err.errorNum === "number") return err.errorNum;
    if (typeof err.message === "string") {
        const match = err.message.match(/ORA-0*(\d+)/i);
        if (match) return parseInt(match[1], 10);
    }
    return null;
}

// ─── RetryPolicy ─────────────────────────────────────────────────────────────

class RetryPolicy {
    /**
     * @param {object} [options]
     * @param {number} [options.maxAttempts=DB_ROW_RETRY_MAX|10] - Attempt cap for classifications whose cap is `null` (e.g. TRANSIENT_DB/TRANSIENT_SMTP).
     * @param {number} [options.baseDelayMs=DB_RETRY_BASE_DELAY_MS|200] - Base backoff delay in ms.
     * @param {number} [options.maxDelayMs=DB_RETRY_MAX_DELAY_MS|5000] - Backoff ceiling in ms.
     * @param {(err: *) => string} [options.classifier] - Classifies a caught error into one of the `RetryPolicy.CLASSIFICATIONS` strings. Defaults to "always retryable up to maxAttempts" when omitted.
     * @param {string} [options.label="operation"] - Human-readable label used in log messages.
     * @throws {RangeError} When numeric options are invalid.
     */
    constructor({
        maxAttempts = envInt("DB_ROW_RETRY_MAX", 10),
        baseDelayMs = envInt("DB_RETRY_BASE_DELAY_MS", 200),
        maxDelayMs = envInt("DB_RETRY_MAX_DELAY_MS", 5000),
        classifier = null,
        label = "operation",
    } = {}) {
        if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
            throw new RangeError(
                "RetryPolicy: maxAttempts must be a positive integer.",
            );
        }
        if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) {
            throw new RangeError(
                "RetryPolicy: baseDelayMs must be a non-negative number.",
            );
        }
        if (!Number.isFinite(maxDelayMs) || maxDelayMs < baseDelayMs) {
            throw new RangeError(
                "RetryPolicy: maxDelayMs must be a number >= baseDelayMs.",
            );
        }
        if (classifier !== null && typeof classifier !== "function") {
            throw new TypeError(
                "RetryPolicy: classifier must be a function when provided.",
            );
        }

        this._maxAttempts = maxAttempts;
        this._baseDelayMs = baseDelayMs;
        this._maxDelayMs = maxDelayMs;
        this._classifier = classifier;
        this._label = label;
    }

    /**
     * Runs `fn`, retrying on classified-transient failures with exponential
     * backoff + jitter.
     *
     * @template T
     * @param {(attempt: number) => Promise<T>} fn - Operation to run. Receives the 1-indexed attempt number.
     * @param {object} [hooks]
     * @param {(err: *, attempt: number) => Promise<{resolved: T}|void>} [hooks.onRetry] -
     *   Invoked after every failed attempt (including the last). Returning
     *   `{ resolved: value }` resolves `execute()` immediately with `value`
     *   without consuming another attempt — the idempotency-probe escape hatch.
     * @returns {Promise<T>}
     * @throws {*} The last caught error, with `.attempts` (number) and
     *   `.classification` (string|null) attached, when the attempt budget for
     *   its classification is exhausted.
     */
    async execute(fn, hooks = {}) {
        let attempt = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
            attempt += 1;

            logger.debug(
                resilienceMessages.ATTEMPT_START(this._label, attempt, this._maxAttempts),
                { label: this._label, attempt, max: this._maxAttempts },
            );
            const startedAt = Date.now();

            try {
                const result = await fn(attempt);
                logger.debug(
                    resilienceMessages.ATTEMPT_OK(this._label, attempt, Date.now() - startedAt),
                    { label: this._label, attempt, ms: Date.now() - startedAt },
                );
                return result;
            } catch (err) {
                const classification = this._classifier
                    ? this._classifier(err)
                    : null;
                const cap = this._attemptCapFor(classification);
                const cause = err?.message ?? String(err);

                // Raw per-attempt trace — fires BEFORE the retry/abort/rethrow
                // decision below. RETRYING/RETRY_EXHAUSTED log the decision
                // itself; this is the DEBUG-only granular trace.
                logger.debug(
                    resilienceMessages.ATTEMPT_FAIL(this._label, attempt, classification, cause),
                    { label: this._label, attempt, classification, cause },
                );

                if (typeof hooks.onRetry === "function") {
                    const probe = await hooks.onRetry(err, attempt);
                    if (probe && Object.prototype.hasOwnProperty.call(probe, "resolved")) {
                        const key =
                            probe.key ??
                            probe.resolved?.id ??
                            probe.resolved?.ID ??
                            null;
                        // Operationally important — a prior attempt actually
                        // committed and the ack was lost. INFO, not DEBUG:
                        // this must be visible without flipping LOG_LEVEL.
                        logger.info(
                            resilienceMessages.IDEMPOTENT_RESOLVE(this._label, key),
                            { label: this._label, attempt, key },
                        );
                        return probe.resolved;
                    }
                }

                if (attempt >= cap) {
                    logger.error(
                        resilienceMessages.RETRY_EXHAUSTED(
                            this._label,
                            attempt,
                            err.message,
                        ),
                    );
                    throw Object.assign(err, { attempts: attempt, classification });
                }

                logger.warning(
                    resilienceMessages.RETRYING(
                        this._label,
                        attempt,
                        cap,
                        err.message,
                    ),
                );

                const delayMs = this._computeBackoff(attempt);
                logger.debug(
                    resilienceMessages.BACKOFF(this._label, attempt, delayMs),
                    { label: this._label, attempt, delayMs },
                );
                await this._sleep(delayMs);
            }
        }
    }

    /**
     * Resolves the effective attempt cap for a classification, falling back
     * to the configured `maxAttempts` for classifications whose cap is `null`
     * (or for `null`/unrecognised classifications — the "always retry up to
     * maxAttempts" default when no classifier was supplied).
     *
     * @param {string|null} classification
     * @returns {number}
     */
    _attemptCapFor(classification) {
        if (
            classification &&
            Object.prototype.hasOwnProperty.call(
                CLASSIFICATION_ATTEMPT_CAPS,
                classification,
            )
        ) {
            const cap = CLASSIFICATION_ATTEMPT_CAPS[classification];
            return cap === null ? this._maxAttempts : cap;
        }
        return this._maxAttempts;
    }

    /**
     * Computes backoff delay for the given (1-indexed) attempt.
     * `min(baseDelayMs * 2^(attempt-1), maxDelayMs) + jitter[0, baseDelayMs)`.
     *
     * @param {number} attempt
     * @returns {number} Delay in milliseconds.
     */
    _computeBackoff(attempt) {
        const exp = Math.min(
            this._baseDelayMs * Math.pow(2, attempt - 1),
            this._maxDelayMs,
        );
        const jitter = Math.random() * this._baseDelayMs;
        return exp + jitter;
    }

    /**
     * @param {number} ms
     * @returns {Promise<void>}
     */
    _sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    // ─── Static classifiers ────────────────────────────────────────────────

    /** Classification string constants — exposed so callers (BatchGuard, services) never hardcode magic strings. */
    static get CLASSIFICATIONS() {
        return CLASSIFICATIONS;
    }

    /** Attempt-cap table — exposed for tests and documentation; not mutated at runtime. */
    static get CLASSIFICATION_ATTEMPT_CAPS() {
        return CLASSIFICATION_ATTEMPT_CAPS;
    }

    /**
     * Classifies a caught DB-layer error per the table in the file header.
     * Unwraps `err.originalError` (and further links) so wrapped adapter
     * errors classify correctly without callers needing to know the wrapping
     * shape.
     *
     * @param {*} err
     * @returns {"TRANSIENT_DB"|"FATAL_SESSION"|"DUPLICATE"|"PERMANENT_DB"}
     */
    static classifyDbError(err) {
        if (!err || typeof err !== "object") return CLASSIFICATIONS.PERMANENT_DB;
        const chain = errorChain(err);

        for (const e of chain) {
            if (extractOraCode(e) === DUPLICATE_ORA_CODE) return CLASSIFICATIONS.DUPLICATE;
        }
        for (const e of chain) {
            const code = extractOraCode(e);
            if (code !== null && FATAL_SESSION_ORA_CODES.has(code)) {
                return CLASSIFICATIONS.FATAL_SESSION;
            }
        }
        for (const e of chain) {
            const code = extractOraCode(e);
            if (code !== null && TRANSIENT_DB_ORA_CODES.has(code)) {
                return CLASSIFICATIONS.TRANSIENT_DB;
            }
        }
        for (const e of chain) {
            if (typeof e.code === "string" && TRANSIENT_DB_SYSTEM_CODES.has(e.code)) {
                return CLASSIFICATIONS.TRANSIENT_DB;
            }
            if (
                typeof e.message === "string" &&
                TRANSIENT_DB_STRING_PATTERNS.some((re) => re.test(e.message))
            ) {
                return CLASSIFICATIONS.TRANSIENT_DB;
            }
        }
        for (const e of chain) {
            if (extractOraCode(e) !== null) return CLASSIFICATIONS.PERMANENT_DB;
        }
        return CLASSIFICATIONS.PERMANENT_DB;
    }

    /**
     * Classifies a caught nodemailer send error per the table in the file
     * header. Unclassifiable errors (no transient `code`, no `responseCode`
     * in range) default to PERMANENT_SMTP — most unlisted nodemailer codes
     * (e.g. `EAUTH`, `EENVELOPE`, `EMESSAGE`) are configuration errors, not
     * transient network blips, so retrying them wastes the retry budget.
     *
     * @param {*} err
     * @returns {"TRANSIENT_SMTP"|"PERMANENT_SMTP"}
     */
    static classifySmtpError(err) {
        if (!err || typeof err !== "object") return CLASSIFICATIONS.PERMANENT_SMTP;
        const chain = errorChain(err);

        for (const e of chain) {
            if (typeof e.code === "string" && TRANSIENT_SMTP_CODES.has(e.code)) {
                return CLASSIFICATIONS.TRANSIENT_SMTP;
            }
        }
        for (const e of chain) {
            const responseCode = Number(e.responseCode);
            if (Number.isFinite(responseCode)) {
                if (responseCode >= 421 && responseCode <= 499) {
                    return CLASSIFICATIONS.TRANSIENT_SMTP;
                }
                if (responseCode >= 500) return CLASSIFICATIONS.PERMANENT_SMTP;
            }
        }
        return CLASSIFICATIONS.PERMANENT_SMTP;
    }

    /**
     * @param {*} err
     * @returns {boolean} True when `classifyDbError(err) === "TRANSIENT_DB"`.
     */
    static isTransientDbError(err) {
        return RetryPolicy.classifyDbError(err) === CLASSIFICATIONS.TRANSIENT_DB;
    }

    /**
     * @param {*} err
     * @returns {boolean} True when `classifySmtpError(err) === "TRANSIENT_SMTP"`.
     */
    static isTransientSmtpError(err) {
        return RetryPolicy.classifySmtpError(err) === CLASSIFICATIONS.TRANSIENT_SMTP;
    }
}

module.exports = { RetryPolicy };
