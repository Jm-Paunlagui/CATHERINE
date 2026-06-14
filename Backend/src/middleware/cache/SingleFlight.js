"use strict";

/**
 * @fileoverview SingleFlight — in-flight call coalescing (anti-stampede).
 *
 * When N concurrent callers request the same key while the first call is
 * still pending, all N share the one in-flight promise instead of issuing
 * N duplicate loads. This is the standard "single-flight" pattern (named
 * after Go's golang.org/x/sync/singleflight) and is the primary defence
 * against cache-stampede latency spikes: without it, a burst of identical
 * requests on a cold cache key each runs the full DB query pipeline,
 * saturating the connection pool and multiplying P95 by the burst size.
 *
 * Domain-agnostic — knows nothing about caches, HTTP, or Oracle. Used by
 * CacheStore.getOrSet(), CacheMiddleware.read(), and service-layer hot
 * paths that need coalescing without a TTL cache.
 *
 * Error semantics: if the loader rejects, every coalesced caller receives
 * the same rejection (identical to each having called the loader and failed
 * individually), and the key is cleared so the next caller retries fresh.
 */

class SingleFlight {
  constructor() {
    /** @type {Map<string, Promise<*>>} */
    this._inflight = new Map();
  }

  /**
   * Runs `loader` for `key`, coalescing concurrent calls: while a call for
   * the same key is pending, subsequent callers receive the same promise.
   *
   * @param {string}            key    - Coalescing key (callers with the same key share one flight).
   * @param {() => Promise<*>}  loader - Async function that produces the value.
   * @returns {Promise<*>}
   */
  run(key, loader) {
    const existing = this._inflight.get(key);
    if (existing) return existing;

    const flight = Promise.resolve()
      .then(loader)
      .finally(() => this._inflight.delete(key));

    this._inflight.set(key, flight);
    return flight;
  }

  /**
   * True while a call for `key` is pending.
   * @param {string} key
   * @returns {boolean}
   */
  isInFlight(key) {
    return this._inflight.has(key);
  }

  /**
   * Number of keys currently in flight (observability/tests).
   * @returns {number}
   */
  size() {
    return this._inflight.size;
  }
}

module.exports = { SingleFlight };
