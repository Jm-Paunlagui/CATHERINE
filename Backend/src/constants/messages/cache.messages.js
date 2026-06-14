"use strict";

/**
 * @fileoverview Cache subsystem log message templates.
 * Used ONLY in logger calls — never thrown or sent to clients.
 */

const cacheMessages = {
    /**
     * @param {string} storeName
     * @param {string} key
     * @returns {string}
     */
    CACHE_HIT: (storeName, key) =>
        `Cache HIT — store: ${storeName}, key: ${key}`,

    /**
     * @param {string} storeName
     * @param {string} key
     * @returns {string}
     */
    CACHE_MISS: (storeName, key) =>
        `Cache MISS — store: ${storeName}, key: ${key}`,

    /**
     * @param {string} storeName
     * @param {string} reason
     * @returns {string}
     */
    CACHE_BYPASS: (storeName, reason) =>
        `Cache BYPASS — store: ${storeName}, keyFn threw, falling through to controller: ${reason}`,

    /**
     * @param {string} storeName
     * @param {string} key
     * @returns {string}
     */
    CACHE_STORE: (storeName, key) =>
        `Cache STORE — store: ${storeName}, key: ${key}`,

    /**
     * @param {string} storeName
     * @param {string} keys
     * @param {number} count
     * @returns {string}
     */
    CACHE_INVALIDATE: (storeName, keys, count) =>
        `Cache INVALIDATE — store: ${storeName}, keys: [${keys}], ${count} key(s) removed`,

    /**
     * @param {string} storeName
     * @param {string} pattern
     * @param {number} count
     * @returns {string}
     */
    CACHE_INVALIDATE_PATTERN: (storeName, pattern, count) =>
        `Cache INVALIDATE — store: ${storeName}, pattern: "${pattern}", ${count} key(s) removed`,

    /**
     * @param {string} storeName
     * @param {number} count
     * @returns {string}
     */
    CACHE_INVALIDATE_WHERE: (storeName, count) =>
        `Cache INVALIDATE — store: ${storeName}, predicate match, ${count} key(s) removed`,

    /**
     * @param {string} storeName
     * @param {string} key
     * @returns {string}
     */
    CACHE_COALESCED: (storeName, key) =>
        `Cache COALESCED — store: ${storeName}, key: ${key} (awaited in-flight leader, served from cache)`,

    /**
     * @param {string} reason
     * @returns {string}
     */
    CACHE_ERROR: (reason) =>
        `Cache INVALIDATE ERROR — keyFn threw: ${reason}`,

    /**
     * @param {string} reason
     * @returns {string}
     */
    CACHE_PREDICATE_ERROR: (reason) =>
        `Cache INVALIDATE ERROR — predicateFn threw: ${reason}`,

    /**
     * @param {string} storeName - Store the relayed invalidation targeted
     * @param {string} op        - Operation applied (del / delByPattern / flush)
     * @param {*}      arg       - Keys or pattern, null for flush
     * @returns {string}
     */
    CACHE_CLUSTER_SYNC_APPLIED: (storeName, op, arg) =>
        `Cache cluster-sync applied — store: ${storeName}, op: ${op}, arg: ${JSON.stringify(arg)}`,

    /**
     * @returns {string}
     */
    CACHE_CLUSTER_SYNC_WORKER_READY: () =>
        `Cache cluster-sync listener installed — invalidations from sibling workers will be applied locally.`,

    /**
     * @returns {string}
     */
    CACHE_CLUSTER_SYNC_PRIMARY_READY: () =>
        `Cache cluster-sync relay installed on primary — worker invalidations will be broadcast to all siblings.`,
};

module.exports = { cacheMessages };
