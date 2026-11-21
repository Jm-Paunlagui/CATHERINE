

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
    CACHE_HIT: (storeName: string, key: string): string =>
        `Cache HIT — store: ${storeName}, key: ${key}`,

    /**
     * @param {string} storeName
     * @param {string} key
     * @returns {string}
     */
    CACHE_MISS: (storeName: string, key: string): string =>
        `Cache MISS — store: ${storeName}, key: ${key}`,

    /**
     * @param {string} storeName
     * @param {string} reason
     * @returns {string}
     */
    CACHE_BYPASS: (storeName: string, reason: string): string =>
        `Cache BYPASS — store: ${storeName}, keyFn threw, falling through to controller: ${reason}`,

    /**
     * @param {string} storeName
     * @param {string} key
     * @returns {string}
     */
    CACHE_STORE: (storeName: string, key: string): string =>
        `Cache STORE — store: ${storeName}, key: ${key}`,

    /**
     * @param {string} storeName
     * @param {string} key
     * @returns {string}
     */
    CACHE_SET_SKIPPED_STALE: (storeName: string, key: string): string =>
        `Cache SET skipped — store: ${storeName}, key: ${key} (store was invalidated while this value was being built; next read reloads)`,

    /**
     * @param {string} storeName
     * @param {string} keys
     * @param {number} count
     * @returns {string}
     */
    CACHE_INVALIDATE:(storeName: string, keys: string, count: number): string =>
        `Cache INVALIDATE — store: ${storeName}, keys: [${keys}], ${count} key(s) removed`,

    /**
     * @param {string} storeName
     * @param {string} pattern
     * @param {number} count
     * @returns {string}
     */
    CACHE_INVALIDATE_PATTERN: (storeName: string, pattern: string, count: number): string =>
        `Cache INVALIDATE — store: ${storeName}, pattern: "${pattern}", ${count} key(s) removed`,

    /**
     * @param {string} storeName
     * @param {number} count
     * @returns {string}
     */
    CACHE_INVALIDATE_WHERE: (storeName: string, count: number): string =>
        `Cache INVALIDATE — store: ${storeName}, predicate match, ${count} key(s) removed`,

    /**
     * @param {string} storeName
     * @param {string} key
     * @returns {string}
     */
    CACHE_COALESCED: (storeName: string, key: string): string =>
        `Cache COALESCED — store: ${storeName}, key: ${key} (awaited in-flight leader, served from cache)`,

    /**
     * @param {string} reason
     * @returns {string}
     */
    CACHE_ERROR: (reason: string): string =>
        `Cache INVALIDATE ERROR — keyFn threw: ${reason}`,

    /**
     * @param {string} reason
     * @returns {string}
     */
    CACHE_PREDICATE_ERROR: (reason: string): string =>
        `Cache INVALIDATE ERROR — predicateFn threw: ${reason}`,

    /**
     * @param {string} storeName - Store the relayed invalidation targeted
     * @param {string} op        - Operation applied (del / delByPattern / flush)
     * @param {*}      arg       - Keys or pattern, null for flush
     * @returns {string}
     */
    CACHE_CLUSTER_SYNC_APPLIED: (storeName: string, op: string, arg: any): string =>
        `Cache cluster-sync applied — store: ${storeName}, op: ${op}, arg: ${JSON.stringify(arg)}`,

    /**
     * @returns {string}
     */
    CACHE_CLUSTER_SYNC_WORKER_READY: (): string =>
        `Cache cluster-sync listener installed — invalidations from sibling workers will be applied locally.`,

    /**
     * @returns {string}
     */
    CACHE_CLUSTER_SYNC_PRIMARY_READY: (): string =>
        `Cache cluster-sync relay installed on primary — worker invalidations will be broadcast to all siblings.`,
};

export { cacheMessages };
