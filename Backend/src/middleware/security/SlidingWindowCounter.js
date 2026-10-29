"use strict";

/**
 * @fileoverview Sliding Window Counter - the rate-limit math, extracted
 * unchanged from `RateLimiterMiddleware._slidingWindowCounter` so the cluster
 * primary can own the same counters the workers use in single-process mode.
 *
 * Two adjacent fixed windows are kept per key; the estimate is
 * `prev * (1 - elapsed/window) + curr` (O(1) memory per key, ~0.003% error).
 *
 * Complexity: O(1) per hit.
 *
 * @author senior-nodejs-engineer
 */

const NodeCache = require("node-cache");

/**
 * @class SlidingWindowCounter
 * @description Holds a NodeCache of window counters.
 */
class SlidingWindowCounter {
    /**
     * @param {object} [opts]
     * @param {import("node-cache")} [opts.store] - Injected store (tests).
     * @param {number} [opts.maxKeys=-1] - NodeCache key cap (-1 = unlimited); a `set` past it throws.
     */
    constructor({ store, maxKeys = -1 } = {}) {
        this._store =
            store ??
            new NodeCache({
                stdTTL: 3600,
                checkperiod: 120,
                useClones: false,
                deleteOnExpire: true,
                maxKeys,
            });
    }

    /** @returns {import("node-cache")} the backing store */
    get store() {
        return this._store;
    }

    /**
     * Counts one hit for `key` unless the estimate already reached `max`.
     *
     * @param {string} key
     * @param {number} max
     * @param {number} windowMs
     * @param {number} [now=Date.now()]
     * @returns {{allowed: boolean, count: number, remaining: number, resetAt: number, bucket?: number, retryAt?: number}}
     *   `bucket` (allowed): the window start the hit was counted in, for `refund`.
     *   `retryAt` (refused): integer epoch ms of the earliest admit with no further hits.
     */
    hit(key, max, windowMs, now = Date.now()) {
        const windowSec = windowMs / 1000;
        const windowStart = Math.floor(now / windowMs) * windowMs;
        const prevKey = `${key}:${windowStart - windowMs}`;
        const currKey = `${key}:${windowStart}`;

        const prevCount = this._store.get(prevKey) ?? 0;
        const currCount = this._store.get(currKey) ?? 0;

        const elapsed = now - windowStart;
        const weight = (windowMs - elapsed) / windowMs;

        const estimated = prevCount * weight + currCount;
        const resetAt = windowStart + windowMs;

        // Integer form of `estimated >= max` (multiplied by windowMs): no float
        // rounding at the boundary, and `retryAt` below is its exact inverse.
        if (prevCount * (windowMs - elapsed) + currCount * windowMs >= max * windowMs) {
            return {
                allowed: false,
                count: Math.ceil(estimated),
                remaining: 0,
                resetAt,
                retryAt: SlidingWindowCounter._retryAt(prevCount, currCount, max, windowMs, windowStart),
            };
        }

        this._store.set(currKey, currCount + 1, windowSec * 2);
        const newEstimate = prevCount * weight + (currCount + 1);

        return {
            allowed: true,
            count: Math.ceil(newEstimate),
            remaining: Math.max(0, Math.floor(max - newEstimate)),
            resetAt,
            bucket: windowStart,
        };
    }

    /**
     * Earliest integer ms at which a hit is admitted again (no hits in between).
     *
     * @param {number} prev - previous-window count
     * @param {number} curr - current-window count
     * @param {number} max
     * @param {number} W - windowMs
     * @param {number} windowStart
     * @returns {number}
     */
    static _retryAt(prev, curr, max, W, windowStart) {
        if (curr < max) {
            // prev > 0 here, otherwise the estimate would be curr < max.
            return windowStart + W - Math.floor(((max - curr) * W - 1) / prev);
        }
        // Whole current window is spent; next window's prev is `curr`.
        return windowStart + W + (W - Math.floor((max * W - 1) / curr));
    }

    /**
     * Gives back one hit counted by `hit()` (a successful sign-in is not a
     * failure). No-op when the bucket has aged out of the two live windows or
     * the count is already 0.
     *
     * @param {string} key
     * @param {number} bucket - `bucket` returned by `hit()`
     * @param {number} windowMs
     * @param {number} [now=Date.now()]
     * @returns {boolean} true when a hit was given back
     */
    refund(key, bucket, windowMs, now = Date.now()) {
        const windowStart = Math.floor(now / windowMs) * windowMs;
        if (!Number.isFinite(bucket) || bucket < windowStart - windowMs) return false;
        const bucketKey = `${key}:${bucket}`;
        const count = this._store.get(bucketKey) ?? 0;
        if (count <= 0) return false;
        if (count === 1) {
            this._store.del(bucketKey);
            return true;
        }
        const ttlSec = Math.max(1, Math.ceil((bucket + 2 * windowMs - now) / 1000));
        this._store.set(bucketKey, count - 1, ttlSec);
        return true;
    }

    /**
     * @param {string|string[]} key
     * @returns {number} entries deleted
     */
    del(key) {
        return this._store.del(key);
    }

    /** Drops every counter. */
    flushAll() {
        this._store.flushAll();
    }

    /** @returns {object} NodeCache stats */
    getStats() {
        return this._store.getStats();
    }

    /** @returns {number} number of stored window keys */
    get size() {
        return this._store.keys().length;
    }

    /** Stops the store's expiry timer. */
    close() {
        this._store.close?.();
    }
}

module.exports = { SlidingWindowCounter };
