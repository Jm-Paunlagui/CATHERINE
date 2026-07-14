"use strict";

/**
 * @fileoverview Bounded-concurrency async mapper.
 *
 * WHAT THIS FILE DOES
 * -------------------
 * Runs an async function over a list with at most `limit` operations in flight
 * at once, preserving input order in the returned results array. Used by
 * bulk save paths (e.g. Excel uploads, guarded batches) to drain thousands of
 * independent per-row writes against the Oracle pool concurrently instead of
 * one strictly-serial round-trip at a time — without unbounded fan-out that
 * would exhaust the connection pool.
 *
 * HOW IT WORKS
 * ------------
 * A fixed number of "worker" loops pull the next index off a shared cursor and
 * await `fn(item, index)`. Each result is written back into the output array at
 * its original index, so order is stable regardless of completion order.
 *
 * The mapper itself NEVER rejects: `fn` is expected to handle its own errors
 * (the save paths collect per-row failures into a summary). If `fn` throws, the
 * rejection propagates — callers that need per-item isolation must catch inside
 * `fn`, exactly as the serial loops they replace already do.
 *
 * Complexity: O(n) time over n items, O(n) space for the results array,
 * O(limit) concurrent in-flight promises.
 *
 * EXAMPLE
 * -------
 *   const results = await mapWithConcurrency(rows, 16, async (row) => {
 *     return saveOne(row); // up to 16 saveOne calls run concurrently
 *   });
 */

/**
 * Maps `fn` over `items` with at most `limit` concurrent invocations.
 *
 * @template T, R
 * @param {Array<T>} items - Input list
 * @param {number} limit - Max concurrent invocations (clamped to >= 1)
 * @param {(item: T, index: number) => Promise<R>} fn - Async mapper
 * @returns {Promise<Array<R>>} Results in input order
 */
async function mapWithConcurrency(items, limit, fn) {
    const list = Array.isArray(items) ? items : [];
    const n = list.length;
    const results = new Array(n);
    if (n === 0) return results;

    const workers = Math.max(1, Math.min(Number(limit) || 1, n));
    let cursor = 0;

    const runWorker = async () => {
        while (true) {
            const i = cursor++;
            if (i >= n) return;
            results[i] = await fn(list[i], i);
        }
    };

    await Promise.all(Array.from({ length: workers }, runWorker));
    return results;
}

module.exports = { mapWithConcurrency };
