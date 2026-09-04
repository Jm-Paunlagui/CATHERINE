"use strict";

/**
 * @fileoverview Canonical row-outcome ledger for every bulk / Excel upload save
 * endpoint a project builds on this template.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * When several save services each grow their own summary shape, `total` comes to
 * mean a different thing in each one (submitted rows / actionable rows / parsed
 * rows), buckets overlap (a skipped row also appears in `failed[]`), and some
 * outcomes are never counted at all. The visible symptom is a Step-3 review
 * screen reading "total 18, inserted 7" with no account of the other 11 — or
 * "total 1302, inserted 0, updated 0, skipped 0" sitting directly above a table
 * listing 1302 skipped rows. This module gives every upload one shape and one
 * arithmetic that cannot silently lose a row.
 *
 * ── The invariant ────────────────────────────────────────────────────────────
 *   inserted + updated + skipped + failed + pending === total
 *
 * `total` is ALWAYS the number of rows the client submitted in this request —
 * nothing else. Every submitted row lands in exactly one terminal bucket. The
 * builder computes the remainder as `unaccounted`; a non-zero remainder is a
 * bug in the calling service, is reported as `balanced: false`, and is logged
 * at CRITICAL so it surfaces in monitoring rather than silently in a user's
 * face.
 *
 * ── The five terminal buckets ────────────────────────────────────────────────
 *   inserted — a new database row was written
 *   updated  — an existing database row was modified
 *   skipped  — deliberately not written; NOT an error (retain, duplicate,
 *              already exists, blocked by a business rule, client-excluded)
 *   failed   — a write was attempted and rejected (constraint, validation, DB)
 *   pending  — outcome genuinely unknown; the row needs a re-upload
 *
 * Pure module: no state beyond the builder instance, no I/O other than logging.
 *
 * @example
 *   const { UploadOutcome, SKIP_REASON } = require("../utils/uploadOutcome");
 *
 *   const ledger = UploadOutcome.for("records", rows.length);
 *   for (const row of rows) {
 *       if (row.status === "Retain") {
 *           ledger.skip(row.ID, row.NAME, "Already up to date", SKIP_REASON.NOT_ACTIONABLE);
 *           continue;
 *       }
 *       ledger.insert(row.ID, row.NAME);
 *   }
 *   return ledger.build({ archived });
 */

const { logger } = require("./logger");
const { uploadMessages } = require("../constants/messages");

// ─── Vocabulary ───────────────────────────────────────────────────────────────

/**
 * The five terminal buckets. Every submitted row ends in exactly one.
 * @readonly
 */
const OUTCOME = Object.freeze({
    INSERTED: "inserted",
    UPDATED: "updated",
    SKIPPED: "skipped",
    FAILED: "failed",
    PENDING: "pending",
});

/**
 * Machine-readable categories for a SKIPPED row. The frontend renders a
 * human sentence from `reason`; automation scripts branch on `category`.
 * @readonly
 */
const SKIP_REASON = Object.freeze({
    /** Row's verify status is not actionable (Retain / Conflict / Duplicate). */
    NOT_ACTIONABLE: "NOT_ACTIONABLE",
    /** Another upload committed the same key while this batch held the lock. */
    ALREADY_EXISTS: "ALREADY_EXISTS",
    /** Operator excluded the row in review, but it was still submitted. */
    EXCLUDED: "EXCLUDED",
    /** A business rule blocked the write. */
    BLOCKED: "BLOCKED",
});

/**
 * Machine-readable categories for a FAILED row.
 * @readonly
 */
const FAIL_REASON = Object.freeze({
    /** Unique / check / FK constraint rejected the write. */
    CONSTRAINT: "CONSTRAINT",
    /** Row failed server-side validation before the write. */
    VALIDATION: "VALIDATION",
    /** Integrity signing (ROW_HASH / HMAC) could not be produced. */
    INTEGRITY: "INTEGRITY",
    /** Database error that is neither a constraint nor validation. */
    DATABASE: "DATABASE",
});

/**
 * Machine-readable categories for a PENDING row.
 * @readonly
 */
const PENDING_REASON = Object.freeze({
    /** Retries exhausted without a definitive commit/reject answer. */
    RETRY_EXHAUSTED: "RETRY_EXHAUSTED",
    /** Connection dropped after the write; commit acknowledgement was lost. */
    COMMIT_ACK_LOST: "COMMIT_ACK_LOST",
});

/** Bucket order used by every consumer (frontend grid, JSON, logs). */
const BUCKET_ORDER = Object.freeze([
    OUTCOME.INSERTED,
    OUTCOME.UPDATED,
    OUTCOME.SKIPPED,
    OUTCOME.FAILED,
    OUTCOME.PENDING,
]);

// ─── Builder ──────────────────────────────────────────────────────────────────

/**
 * Accumulates per-row outcomes for one save batch and emits the canonical
 * contract. One instance per request — never share across batches.
 */
class UploadOutcomeBuilder {
    /**
     * @param {string} feature - Short feature slug identifying the upload.
     * @param {number} total   - Number of rows the client submitted in this request.
     */
    constructor(feature, total) {
        this._feature = String(feature);
        this._total = Number.isFinite(Number(total)) ? Number(total) : 0;

        this._counts = {
            [OUTCOME.INSERTED]: 0,
            [OUTCOME.UPDATED]: 0,
            [OUTCOME.SKIPPED]: 0,
            [OUTCOME.FAILED]: 0,
            [OUTCOME.PENDING]: 0,
        };
        this._rows = {
            [OUTCOME.SKIPPED]: [],
            [OUTCOME.FAILED]: [],
            [OUTCOME.PENDING]: [],
        };

        /** @type {Map<string, string>} row key → bucket it was first recorded in. */
        this._seen = new Map();
    }

    /**
     * Normalises a row identifier into the `{ key, label }` pair every detail
     * table renders. `key` is the stable business identifier; `label` is the
     * human-friendly secondary (name, code).
     *
     * @param {*} key
     * @param {*} [label]
     * @returns {{ key: string, label: string|null }}
     * @private
     */
    static _identity(key, label) {
        const k = key === null || key === undefined || key === "" ? "—" : String(key);
        const l = label === null || label === undefined || label === "" ? null : String(label);
        return { key: k, label: l };
    }

    /**
     * Records that a row was bucketed, warning when the same key lands twice —
     * the double-count defect that makes a Skipped and a Failed cell overlap.
     *
     * @param {string} key
     * @param {string} bucket
     * @private
     */
    _track(key, bucket) {
        if (key === "—") return; // unidentifiable rows cannot be de-duplicated
        const first = this._seen.get(key);
        if (first !== undefined) {
            logger.warning(
                uploadMessages.LEDGER_DUPLICATE_KEY(this._feature, key, first, bucket),
            );
            return;
        }
        this._seen.set(key, bucket);
    }

    /**
     * Records a row that was written as a new database row.
     * @param {*} key
     * @param {*} [label]
     * @returns {this}
     */
    insert(key, label) {
        const id = UploadOutcomeBuilder._identity(key, label);
        this._counts[OUTCOME.INSERTED]++;
        this._track(id.key, OUTCOME.INSERTED);
        return this;
    }

    /**
     * Records a row that modified an existing database row.
     * @param {*} key
     * @param {*} [label]
     * @returns {this}
     */
    update(key, label) {
        const id = UploadOutcomeBuilder._identity(key, label);
        this._counts[OUTCOME.UPDATED]++;
        this._track(id.key, OUTCOME.UPDATED);
        return this;
    }

    /**
     * Records a row that was deliberately not written. Not an error.
     *
     * @param {*} key
     * @param {*} label
     * @param {string} reason   - Human sentence shown in the detail table.
     * @param {string} [category=SKIP_REASON.NOT_ACTIONABLE] - One of SKIP_REASON.
     * @returns {this}
     */
    skip(key, label, reason, category = SKIP_REASON.NOT_ACTIONABLE) {
        const id = UploadOutcomeBuilder._identity(key, label);
        this._counts[OUTCOME.SKIPPED]++;
        this._rows[OUTCOME.SKIPPED].push({
            ...id,
            reason: reason ? String(reason) : "Not applicable for this upload.",
            category,
        });
        this._track(id.key, OUTCOME.SKIPPED);
        return this;
    }

    /**
     * Records a row whose write was attempted and rejected.
     *
     * @param {*} key
     * @param {*} label
     * @param {string} reason   - Human sentence shown in the detail table.
     * @param {string} [category=FAIL_REASON.DATABASE] - One of FAIL_REASON.
     * @param {object} [extra]  - Additional fields merged into the detail row
     *   (e.g. `{ attempts: 3 }`). Never overrides key/label/reason/category.
     * @returns {this}
     */
    fail(key, label, reason, category = FAIL_REASON.DATABASE, extra = {}) {
        const id = UploadOutcomeBuilder._identity(key, label);
        this._counts[OUTCOME.FAILED]++;
        this._rows[OUTCOME.FAILED].push({
            ...extra,
            ...id,
            reason: reason ? String(reason) : "Row could not be saved.",
            category,
        });
        this._track(id.key, OUTCOME.FAILED);
        return this;
    }

    /**
     * Records a row whose outcome is genuinely unknown and needs a re-upload.
     *
     * @param {*} key
     * @param {*} label
     * @param {string} reason
     * @param {string} [category=PENDING_REASON.RETRY_EXHAUSTED] - One of PENDING_REASON.
     * @param {object} [extra]
     * @returns {this}
     */
    pend(key, label, reason, category = PENDING_REASON.RETRY_EXHAUSTED, extra = {}) {
        const id = UploadOutcomeBuilder._identity(key, label);
        this._counts[OUTCOME.PENDING]++;
        this._rows[OUTCOME.PENDING].push({
            ...extra,
            ...id,
            reason: reason ? String(reason) : "Outcome unknown — re-upload this row.",
            category,
        });
        this._track(id.key, OUTCOME.PENDING);
        return this;
    }

    /** @returns {number} Terminal outcomes recorded so far. */
    get recorded() {
        return BUCKET_ORDER.reduce((sum, b) => sum + this._counts[b], 0);
    }

    /**
     * Seals the ledger and returns the canonical contract.
     *
     * The remainder `total - recorded` becomes `unaccounted`. A non-zero
     * remainder is never hidden: it is returned, flagged via `balanced: false`,
     * and logged at CRITICAL. Over-counting (recorded > total) yields a negative
     * remainder and is logged at WARNING — both cases stay visible rather than
     * being clamped away.
     *
     * @param {object} [extra] - Feature-specific additive fields merged into the
     *   returned object (e.g. `{ archived, emailDelivery, insertedRows }`).
     *   Cannot override `counts`, `rows`, `balanced`, or `feature`.
     * @returns {{
     *   feature: string,
     *   counts: { total: number, inserted: number, updated: number, skipped: number, failed: number, pending: number, unaccounted: number },
     *   rows: { skipped: Array<object>, failed: Array<object>, pending: Array<object> },
     *   balanced: boolean,
     * }}
     */
    build(extra = {}) {
        const recorded = this.recorded;
        const unaccounted = this._total - recorded;

        const counts = {
            total: this._total,
            [OUTCOME.INSERTED]: this._counts[OUTCOME.INSERTED],
            [OUTCOME.UPDATED]: this._counts[OUTCOME.UPDATED],
            [OUTCOME.SKIPPED]: this._counts[OUTCOME.SKIPPED],
            [OUTCOME.FAILED]: this._counts[OUTCOME.FAILED],
            [OUTCOME.PENDING]: this._counts[OUTCOME.PENDING],
            unaccounted,
        };

        const balanced = unaccounted === 0;

        if (!balanced) {
            logger.critical(uploadMessages.LEDGER_UNBALANCED(this._feature, counts));
            if (unaccounted < 0) {
                logger.warning(
                    uploadMessages.LEDGER_OVERCOUNT(this._feature, recorded, this._total),
                );
            }
        } else {
            logger.info(uploadMessages.LEDGER_BALANCED(this._feature, counts));
        }

        const rows = {
            [OUTCOME.SKIPPED]: this._rows[OUTCOME.SKIPPED],
            [OUTCOME.FAILED]: this._rows[OUTCOME.FAILED],
            [OUTCOME.PENDING]: this._rows[OUTCOME.PENDING],
        };

        return {
            ...extra,
            feature: this._feature,
            counts,
            rows,
            balanced,

            // ── DEPRECATED legacy mirror — remove once every consumer reads
            // `counts`/`rows` ─────────────────────────────────────────────────
            // Without these, a backend deployed AHEAD of its frontend serves a
            // response whose top-level `inserted`/`updated`/`skipped`/`total`
            // are all `undefined`. A review screen reading exactly those keys
            // would render 0 / 0 / 0 — silently reintroducing the very defect
            // this module was written to kill, purely as a function of deploy
            // ordering. Any automation calling the save endpoints directly would
            // break the same way.
            //
            // The mirror matches the OLD field TYPES exactly: counts as
            // numbers, `failed`/`pending` as arrays, because that is what the
            // legacy consumers destructure (`result.failed.length`).
            //
            // LIMIT — the mirrored arrays carry canonical detail rows
            // (`{ key, label, reason, category }`), not the old per-feature
            // field names. An old frontend's detail table therefore renders
            // dashes in its identifier columns during the deploy window. That
            // is a deliberate trade: the counts — the numbers an operator acts
            // on — are correct, and a visibly empty cell is self-evidently a
            // display gap rather than a wrong figure quietly presented as right.
            //
            // Consumers must prefer `counts`/`rows`; these keys are additive
            // and carry no information the canonical contract lacks.
            total: counts.total,
            inserted: counts[OUTCOME.INSERTED],
            updated: counts[OUTCOME.UPDATED],
            skipped: counts[OUTCOME.SKIPPED],
            failed: rows[OUTCOME.FAILED],
            pending: rows[OUTCOME.PENDING],
        };
    }
}

// ─── Facade ───────────────────────────────────────────────────────────────────

/**
 * Entry point for the ledger. Services call `UploadOutcome.for(...)`.
 */
class UploadOutcome {
    /**
     * Opens a ledger for one save batch.
     *
     * @param {string} feature - Short feature slug identifying the upload.
     * @param {number} total   - Rows submitted by the client in THIS request.
     *   Never the parsed-file count, never the actionable subset.
     * @returns {UploadOutcomeBuilder}
     */
    static for(feature, total) {
        return new UploadOutcomeBuilder(feature, total);
    }

    /**
     * True when a summary needs the operator's attention — i.e. the controller
     * should answer 207 Multi-Status rather than 200 OK. Skipped rows alone are
     * a normal outcome and do NOT make a batch partial.
     *
     * @param {{ counts?: object, balanced?: boolean }} summary
     * @returns {boolean}
     */
    static isPartial(summary) {
        const c = summary?.counts ?? {};
        return (
            Number(c.failed ?? 0) > 0 ||
            Number(c.pending ?? 0) > 0 ||
            summary?.balanced === false
        );
    }

    /**
     * True when nothing at all was written — every submitted row was skipped,
     * failed, or is pending. Controllers use this to pick the "all failed"
     * response message.
     *
     * @param {{ counts?: object }} summary
     * @returns {boolean}
     */
    static isNoop(summary) {
        const c = summary?.counts ?? {};
        return Number(c.inserted ?? 0) === 0 && Number(c.updated ?? 0) === 0;
    }
}

module.exports = {
    UploadOutcome,
    UploadOutcomeBuilder,
    OUTCOME,
    SKIP_REASON,
    FAIL_REASON,
    PENDING_REASON,
    BUCKET_ORDER,
};
