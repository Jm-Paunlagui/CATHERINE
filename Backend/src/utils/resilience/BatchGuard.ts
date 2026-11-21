"use strict";

/**
 * @fileoverview Guarded-batch runner — the Data Protection layer.
 *
 * WHAT THIS FILE DOES
 * -------------------
 * `BatchGuard` runs a per-item async `worker` over a list with bounded
 * concurrency (via `mapWithConcurrency`), wrapping every item in a
 * `RetryPolicy` and segregating outcomes into `succeeded` / `failed` /
 * `pending` buckets instead of letting a single item's failure — or a total
 * outage — silently masquerade as a full success (the real incident this
 * layer fixes: a DB timeout mid-batch produced `inserted: 0` yet still
 * returned HTTP 200).
 *
 * Deliberately NOT Express middleware — batch writes live in the service
 * layer, so `BatchGuard` is a plain class instantiated and awaited from
 * inside a service method.
 *
 * HOW IT WORKS
 * ------------
 * Each item is run through `retryPolicy.execute(() => worker(item, index))`.
 * `mapWithConcurrency`'s worker function NEVER throws here — every outcome
 * (success, classified failure, or abort) is captured into a plain result
 * object, so `mapWithConcurrency` itself never rejects and always returns a
 * dense, index-ordered array. `BatchGuard` alone owns interpreting the retry
 * policy's `.classification` / `.attempts` metadata into the report shape.
 *
 * If any item exhausts its retry budget with classification `FATAL_SESSION`
 * (session was killed — retrying more of the same batch on a corrupted
 * session is pointless), the batch sets an `aborted` flag. Items that have
 * NOT yet been dequeued by a worker slot short-circuit into `pending` rather
 * than being attempted at all. Items already in flight at the moment of
 * abort are allowed to finish naturally (they were already committed to an
 * attempt) — at most `concurrency - 1` extra items may still run after the
 * abort signal, which is an acceptable, bounded blast radius.
 *
 * Complexity: O(n) time over n items with wall-clock time roughly
 * O(n / concurrency) assuming uniform per-item cost (dominated by the
 * network round-trip, not CPU), O(n) space for the three report arrays.
 *
 * EXAMPLE
 * -------
 *   const guard = new BatchGuard({
 *       retryPolicy: new RetryPolicy({
 *           maxAttempts: 10,
 *           classifier: RetryPolicy.classifyDbError,
 *           label: "batch-row",
 *       }),
 *       concurrency: 16,
 *       label: "batch-save",
 *   });
 *
 *   const report = await guard.run(rows, (row) => insertOneRow(row));
 *   const status = BatchGuard.httpStatusFor(report);
 *   if (status === null) throw new AppError(GENERAL_ERRORS.BATCH_SAVE_ALL_FAILED, 503, { ... });
 *   res.status(status).json(sendSuccess(..., report, status));
 */

const { mapWithConcurrency } = require("../concurrency");
const { logger } = require("../logger");
const { resilienceMessages } = require("../../constants/messages");
const { RetryPolicy } = require("./RetryPolicy");
const { currentScope } = require("../progress/progress");

class BatchGuard {
    /**
     * @param {object} options
     * @param {import("./RetryPolicy").RetryPolicy} options.retryPolicy - Retry policy applied to every item.
     * @param {number} [options.concurrency=16] - Max concurrent in-flight items.
     * @param {string} [options.label="batch"] - Human-readable label used in log messages.
     * @param {number} [options.retryBudget=Infinity] - Cumulative ceiling on retries spent across FAILED items before the batch aborts remaining un-started items to `pending`. `Infinity` (the default) disables the budget. Must otherwise be a positive integer.
     * @throws {TypeError} When `retryPolicy` is not a usable RetryPolicy-shaped object, or `retryBudget` is neither `Infinity` nor a positive integer.
     */
    constructor({
        retryPolicy,
        concurrency = 16,
        label = "batch",
        retryBudget = Infinity,
    } = {}) {
        if (!retryPolicy || typeof retryPolicy.execute !== "function") {
            throw new TypeError(
                "BatchGuard: retryPolicy must be a RetryPolicy instance (or an object exposing an execute() method).",
            );
        }
        if (
            retryBudget !== Infinity &&
            !(Number.isInteger(retryBudget) && retryBudget > 0)
        ) {
            throw new TypeError(
                "BatchGuard: retryBudget must be Infinity or a positive integer.",
            );
        }
        this._retryPolicy = retryPolicy;
        this._concurrency = Math.max(1, Number(concurrency) || 1);
        this._label = label;
        this._retryBudget = retryBudget;
    }

    /**
     * Runs `worker` over every item in `items`, retrying transient failures
     * and segregating the outcome of each item.
     *
     * @template T, R
     * @param {Array<T>} items
     * @param {(item: T, index: number) => Promise<R>} worker - Per-item operation. Its errors are NEVER swallowed silently — they flow into `failed[]`/`pending[]` with full classification metadata.
     * @param {object} [options]
     * @param {object|((item: T, index: number) => object)} [options.hooks] - Retry hooks forwarded to `retryPolicy.execute()` for every item. Pass a function to build per-item hooks (e.g. an idempotency probe closed over that item's deterministic key).
     * @returns {Promise<{
     *   succeeded: Array<{item: T, result: R}>,
     *   failed: Array<{item: T, error: *, attempts: number, classification: string|null}>,
     *   pending: Array<{item: T, reason: string}>
     * }>}
     */
    async run(items, worker, options = {}) {
        const list = Array.isArray(items) ? items : [];
        const n = list.length;
        const succeeded = [];
        const failed = [];
        const pending = [];
        const startedAt = Date.now();

        logger.debug(
            resilienceMessages.BATCH_START(this._label, n, this._concurrency),
            { label: this._label, total: n, concurrency: this._concurrency },
        );

        if (n === 0) {
            const ms = Date.now() - startedAt;
            logger.info(
                resilienceMessages.BATCH_DONE(this._label, 0, 0, 0, ms),
                { label: this._label, succeeded: 0, failed: 0, pending: 0, ms },
            );
            return { succeeded, failed, pending };
        }

        const hooksFor =
            typeof options.hooks === "function"
                ? options.hooks
                : () => options.hooks ?? {};

        let aborted = false;
        let abortReason = null;
        // Cumulative retries spent across FAILED items only. We deliberately do
        // NOT count retries that ended in success (including idempotency-probe
        // "resolved" outcomes): a success-after-retry is RECOVERY, not budget
        // spend — counting it would trip the budget on a batch that is actually
        // healing itself. Do not "fix" this to count all attempts.
        let retriesUsed = 0;

        // Request watchdog (B-D9): the ambient scope, if any. Each settled item
        // is progress; once the request was cut, un-started items go to
        // `pending` instead of running against a request nobody is waiting for.
        const scope = currentScope();

        const outcomes = await mapWithConcurrency(list, this._concurrency, async (item, index) => {
            if (aborted) {
                return { outcome: "pending", item, reason: abortReason };
            }
            if (scope?.aborted) {
                return {
                    outcome: "pending",
                    item,
                    reason: resilienceMessages.BATCH_REQUEST_ABORTED(this._label),
                };
            }

            try {
                const result = await this._retryPolicy.execute(
                    () => worker(item, index),
                    hooksFor(item, index),
                );
                scope?.touch("batch-item");
                return { outcome: "succeeded", item, result };
            } catch (err) {
                scope?.touch("batch-item");
                const classification = err?.classification ?? null;
                const attempts = err?.attempts ?? 1;

                if (classification === RetryPolicy.CLASSIFICATIONS.FATAL_SESSION && !aborted) {
                    aborted = true;
                    abortReason = err.message;
                }

                // Budget accounting fires only on the FAILED path (retries that
                // did not recover). `attempts` is the total attempt count on the
                // exhausted error, so retries = attempts - 1 (never negative).
                retriesUsed += Math.max(0, (attempts ?? 1) - 1);
                if (retriesUsed >= this._retryBudget && !aborted) {
                    aborted = true;
                    abortReason = resilienceMessages.BATCH_BUDGET_EXHAUSTED(
                        this._label,
                        retriesUsed,
                        this._retryBudget,
                    );
                }

                return {
                    outcome: "failed",
                    item,
                    error: err,
                    attempts,
                    classification,
                };
            }
        });

        for (const outcome of outcomes) {
            if (outcome.outcome === "succeeded") {
                succeeded.push({ item: outcome.item, result: outcome.result });
            } else if (outcome.outcome === "failed") {
                failed.push({
                    item: outcome.item,
                    error: outcome.error,
                    attempts: outcome.attempts,
                    classification: outcome.classification,
                });
            } else {
                pending.push({ item: outcome.item, reason: outcome.reason });
            }
        }

        // Logged once, after every in-flight item has settled, so `pending.length`
        // reflects the true count of un-started items aborted by the fatal session
        // error rather than an estimate taken mid-flight.
        if (aborted) {
            logger.error(
                resilienceMessages.BATCH_ABORTED(
                    this._label,
                    pending.length,
                    abortReason,
                ),
            );
        }

        const ms = Date.now() - startedAt;
        logger.info(
            resilienceMessages.BATCH_DONE(
                this._label,
                succeeded.length,
                failed.length,
                pending.length,
                ms,
            ),
            {
                label: this._label,
                succeeded: succeeded.length,
                failed: failed.length,
                pending: pending.length,
                ms,
            },
        );

        return { succeeded, failed, pending };
    }

    /**
     * Maps a segregated batch report to the HTTP status the caller should
     * respond with: full success stays 200, any partial outcome (failed
     * and/or pending rows present) is 207 Multi-Status, and a total wipeout
     * (zero successes) returns `null` so the caller throws a 503
     * DataProtectionError instead of masquerading as success.
     *
     * @param {{succeeded: Array, failed: Array, pending: Array}} report
     * @returns {200|207|null}
     */
    static httpStatusFor(report) {
        const succeededCount = report?.succeeded?.length ?? 0;
        const failedCount = report?.failed?.length ?? 0;
        const pendingCount = report?.pending?.length ?? 0;

        if (succeededCount === 0) return null;
        if (failedCount === 0 && pendingCount === 0) return 200;
        return 207;
    }
}

module.exports = { BatchGuard };
