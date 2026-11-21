"use strict";

/**
 * @fileoverview CacheMiddleware — Express middleware factory for request-level caching.
 *
 * Two concerns are cleanly separated:
 *
 * 1. `CacheMiddleware.read(store, keyFn)`
 *    Intercept GET requests, serve from cache on HIT, or store the JSON response on MISS.
 *
 * 2. `CacheMiddleware.invalidate(store, keyFn | patternFn)`
 *    After a mutating request succeeds (2xx), delete the affected cache entries.
 *
 * Domain-specific key generation belongs to the project's own key-builder modules
 * (passed in as `keyFn`). This class stays domain-agnostic.
 *
 * Usage — read-through on a GET route:
 *
 *   const { CacheMiddleware } = require('../middleware/cache/CacheMiddleware');
 *   const { registry }        = require('../middleware/cache/CacheRegistry');
 *
 *   const usersStore = registry.resolve('users');
 *
 *   router.get('/users',
 *       CacheMiddleware.read(
 *           usersStore,
 *           (req) => CacheKeyBuilder.build('users', { division: req.query.division })
 *       ),
 *       UserController.list,
 *   );
 *
 * Usage — invalidate after mutation:
 *
 *   router.post('/users',
 *       UserController.create,
 *       CacheMiddleware.invalidate(
 *           usersStore,
 *           (req) => 'users'   // delByPattern — removes all keys that contain "users"
 *       ),
 *   );
 */

const { logger } = require("../../utils/logger");
const { cacheMessages } = require("../../constants/messages/cache.messages");
const { currentScope } = require("../../utils/progress/progress");

class CacheMiddleware {
  // ─── Read-through (cache-aside) ───────────────────────────────────────────

  /**
   * In-flight MISS leaders, keyed `${store.name}|${cacheKey}` (anti-stampede).
   * The first request to miss a key becomes the "leader" and runs the
   * controller; concurrent requests for the same key ("followers") await the
   * leader's completion, then serve the freshly cached value instead of each
   * running the controller's DB pipeline. Promises here are resolve-only —
   * they settle when the leader's response closes, never reject.
   *
   * @type {Map<string, Promise<void>>}
   */
  static _inflight = new Map();

  /**
   * Returns an Express middleware that:
   *   - On HIT  → responds immediately with the cached value.
   *   - On MISS → calls next(), then captures the JSON response and stores it.
   *     Concurrent misses on the same key are coalesced: only the first
   *     request executes the controller; the rest wait and serve the cached
   *     result (X-Cache: COALESCED). If the leader fails (non-2xx / error),
   *     one waiting request becomes the new leader and the rest wait on it
   *     (one extra controller run, not one per follower); a follower whose
   *     second wait also fails runs the controller itself.
   *
   * @param {import('./CacheStore').CacheStore} store
   *   The target cache store (from `registry.resolve(...)`).
   *
   * @param {(req: import('express').Request) => string} keyFn
   *   Pure function: given the request, return the cache key string.
   *
   * @param {Object} [options={}]
   * @param {string[]} [options.bypassMethods=['POST','PUT','PATCH','DELETE']]
   *   HTTP methods that skip caching entirely.
   * @param {number}   [options.ttl]
   *   Per-route TTL override (seconds). Omit to use the store's default.
   * @param {boolean}  [options.setHeaders=true]
   *   Attach X-Cache, X-Cache-Key headers to the response.
   * @param {boolean}  [options.coalesce=true]
   *   Coalesce concurrent misses on the same key (single-flight).
   * @param {(req: import('express').Request, resBody: *) => boolean} [options.shouldCache]
   *   Called with the outgoing response body just before a MISS would be
   *   stored. Return false to skip caching this particular response even
   *   though it was a 2xx — e.g. an in-flight/preview payload that must never
   *   be served stale for the store's TTL. Defaults to `() => true` (cache
   *   every successful response, the pre-existing behaviour).
   *
   * Stale-write guard: the store generation is captured at MISS and the
   * response is NOT stored if the store was invalidated while the controller ran.
   *
   * @returns {import('express').RequestHandler}
   */
  static read(store, keyFn, options = {}) {
    const bypass = new Set(
      options.bypassMethods ?? ["POST", "PUT", "PATCH", "DELETE"],
    );
    const setHeaders = options.setHeaders !== false;
    const ttl = options.ttl; // may be undefined → use store default
    const coalesce = options.coalesce !== false;
    const shouldCache = options.shouldCache ?? (() => true);

    return async (req, res, next) => {
      // Skip write verbs — they should never be cached.
      if (bypass.has(req.method)) return next();

      let key;
      try {
        key = keyFn(req);
      } catch (err) {
        logger.warning(cacheMessages.CACHE_BYPASS(store.name, err.message));
        return next();
      }

      const cached = store.get(key);

      if (cached !== undefined) {
        if (setHeaders) {
          res.set("X-Cache", "HIT");
          res.set("X-Cache-Key", key);
        }
        logger.info(cacheMessages.CACHE_HIT(store.name, key));
        return res.json(cached);
      }

      // MISS — coalesce concurrent identical requests behind one leader.
      const flightKey = store.name + "|" + key;

      if (coalesce) {
        const serveCoalesced = (value) => {
          if (setHeaders) {
            res.set("X-Cache", "COALESCED");
            res.set("X-Cache-Key", key);
          }
          logger.info(cacheMessages.CACHE_COALESCED(store.name, key));
          return res.json(value);
        };

        const leader = CacheMiddleware._inflight.get(flightKey);
        if (leader) {
          // Follower: wait for the in-flight leader, then re-check the cache.
          // Waiting is not progress by itself: the follower's scope FOLLOWS the
          // leader's, so it stays alive exactly while the leader progresses
          // and is cut with it when the leader goes quiet (B-D9).
          const myScope = currentScope();
          if (leader.scope) myScope?.follow(leader.scope);
          try {
            await leader; // resolve-only — never rejects
          } finally {
            myScope?.unfollow();
            myScope?.touch("coalesce-wake");
          }
          const after = store.get(key);
          if (after !== undefined) return serveCoalesced(after);

          // Leader failed to populate (error / non-2xx). Every follower wakes
          // together; if each became a leader at once, one failure would cost
          // N controller runs. Re-check ONCE: if a sibling follower already
          // became the new leader, wait on it instead. Bounded at two waits so
          // a run of slow failures is never serialised across N followers.
          const newLeader = CacheMiddleware._inflight.get(flightKey);
          if (newLeader) {
            if (newLeader.scope) myScope?.follow(newLeader.scope);
            try {
              await newLeader;
            } finally {
              myScope?.unfollow();
              myScope?.touch("coalesce-wake");
            }
            const afterRetry = store.get(key);
            if (afterRetry !== undefined) return serveCoalesced(afterRetry);
          }
          // Still nothing cached — fall through and run the controller
          // ourselves, becoming the leader below.
        }

        let settle;
        const flight = new Promise((resolve) => {
          settle = resolve;
        });
        // The leader's scope rides on the promise object (value stays a
        // Promise) so followers can follow its progress.
        flight.scope = currentScope();
        CacheMiddleware._inflight.set(flightKey, flight);

        const release = () => {
          if (CacheMiddleware._inflight.get(flightKey) === flight) {
            CacheMiddleware._inflight.delete(flightKey);
          }
          settle();
        };

        // 'close' fires on both successful completion and client abort /
        // upstream error — guarantees followers are always released.
        res.once("close", release);
      }

      if (setHeaders) {
        res.set("X-Cache", "MISS");
        res.set("X-Cache-Key", key);
      }
      logger.info(cacheMessages.CACHE_MISS(store.name, key));

      const generation = store.generation;
      const originalJson = res.json.bind(res);
      res.json = function (data) {
        // Only cache successful responses whose body passes shouldCache
        // (e.g. never cache an in-flight/preview payload — see options.shouldCache).
        if (
          res.statusCode >= 200 &&
          res.statusCode < 300 &&
          shouldCache(req, data)
        ) {
          if (store.generation === generation) {
            store.set(key, data, ttl);
          } else {
            logger.debug(cacheMessages.CACHE_SET_SKIPPED_STALE(store.name, key));
          }
        }
        return originalJson(data);
      };

      next();
    };
  }

  // ─── Invalidation ────────────────────────────────────────────────────────

  /**
   * Returns an Express middleware that deletes cache entries **after** the
   * handler responds successfully (2xx).
   *
   * The `keyFn` can return:
   *   - A single key string        → exact delete (or `delByPattern` in pattern mode)
   *   - An array of key strings    → multi-delete (or one `delByPattern` call
   *     PER entry in pattern mode — the same "invalidate several namespaces
   *     in one route" shape `invalidateOnFinish()` already supports, e.g.
   *     `(req) => [`userId=${req.user.userId}:`, "reports:downloadRequests"]`)
   *   - null / undefined           → no-op (useful when nothing needs invalidation)
   *
   * @param {import('./CacheStore').CacheStore | import('./CacheStore').CacheStore[]} store
   *   One or multiple stores to invalidate from.
   *
   * @param {(req: import('express').Request, res: import('express').Response) => string | string[] | null} keyFn
   *   Returns the key(s)/pattern(s) to delete. Called after a successful response.
   *
   * @param {Object}  [options={}]
   * @param {boolean} [options.usePattern=false]
   *   If true, treat each returned value as a pattern for `delByPattern()`.
   *
   * @returns {import('express').RequestHandler}
   */
  static invalidate(store, keyFn, options = {}) {
    const stores = Array.isArray(store) ? store : [store];
    const usePattern = options.usePattern === true;

    return (req, res, next) => {
      const originalJson = res.json.bind(res);
      res.json = function (data) {
        const result = originalJson(data);

        // Fire-and-forget invalidation only on success.
        if (res.statusCode >= 200 && res.statusCode < 300) {
          setImmediate(() => {
            try {
              const target = keyFn(req, res);
              if (target == null) return;

              for (const s of stores) {
                if (usePattern) {
                  // One delByPattern() per entry; String(array) would build a comma-joined pattern that never matches.
                  const patterns = Array.isArray(target) ? target : [target];
                  for (const pattern of patterns) {
                    const count = s.delByPattern(String(pattern));
                    logger.info(cacheMessages.CACHE_INVALIDATE_PATTERN(s.name, String(pattern), count));
                  }
                } else {
                  const keys = Array.isArray(target) ? target : [target];
                  const count = s.del(keys);
                  logger.info(cacheMessages.CACHE_INVALIDATE(s.name, keys.join(", "), count));
                }
              }
            } catch (err) {
              logger.error(cacheMessages.CACHE_ERROR(err.message));
            }
          });
        }

        return result;
      };

      next();
    };
  }

  /**
   * Like `invalidate()` but fires on the response **`finish`** event instead of
   * wrapping `res.json`. Use this for routes whose success response is NOT JSON
   * — file/streamed downloads (`workbook.xlsx.write(res)` + `res.end()`),
   * `res.send(buffer)`, `res.sendFile`, etc. The `res.json` override used by
   * `invalidate()` never runs for those responses, so a binary export would
   * silently skip cache invalidation and keep serving stale read-cache entries
   * (e.g. an export-once status flag that never flips after the file is served).
   *
   * `finish` fires once the last response byte is handed to the OS with the final
   * `res.statusCode` set, so the 2xx guard is reliable. It fires for BOTH JSON
   * and streamed responses, making this safe to use anywhere `invalidate()` is.
   *
   * `keyFn` may return a single key/pattern, an array of them, or null (no-op).
   * In pattern mode every returned value is passed to `delByPattern` in turn.
   *
   * Placement: register this middleware BEFORE the controller in the route chain
   * (same position as `invalidate()`), so the `finish` listener is attached
   * before the controller starts streaming.
   *
   * @param {import('./CacheStore').CacheStore | import('./CacheStore').CacheStore[]} store
   * @param {(req: import('express').Request, res: import('express').Response) => string | string[] | null} keyFn
   * @param {Object}  [options={}]
   * @param {boolean} [options.usePattern=false]
   * @returns {import('express').RequestHandler}
   */
  static invalidateOnFinish(store, keyFn, options = {}) {
    const stores = Array.isArray(store) ? store : [store];
    const usePattern = options.usePattern === true;

    return (req, res, next) => {
      res.once("finish", () => {
        // Only invalidate on a successful (2xx) response.
        if (res.statusCode < 200 || res.statusCode >= 300) return;
        try {
          const target = keyFn(req, res);
          if (target == null) return;
          const targets = Array.isArray(target) ? target : [target];
          if (targets.length === 0) return;

          for (const s of stores) {
            if (usePattern) {
              for (const pattern of targets) {
                const count = s.delByPattern(String(pattern));
                logger.info(cacheMessages.CACHE_INVALIDATE_PATTERN(s.name, String(pattern), count));
              }
            } else {
              const count = s.del(targets);
              logger.info(cacheMessages.CACHE_INVALIDATE(s.name, targets.join(", "), count));
            }
          }
        } catch (err) {
          logger.error(cacheMessages.CACHE_ERROR(err.message));
        }
      });

      next();
    };
  }

  // ─── Convenience: invalidate by predicate ────────────────────────────────

  /**
   * Like `invalidate()` but deletes every key for which `predicateFn` returns true.
   *
   * @param {import('./CacheStore').CacheStore | import('./CacheStore').CacheStore[]} store
   * @param {(key: string, req: import('express').Request) => boolean} predicateFn
   * @returns {import('express').RequestHandler}
   */
  static invalidateWhere(store, predicateFn) {
    const stores = Array.isArray(store) ? store : [store];

    return (req, res, next) => {
      const originalJson = res.json.bind(res);
      res.json = function (data) {
        const result = originalJson(data);

        if (res.statusCode >= 200 && res.statusCode < 300) {
          setImmediate(() => {
            try {
              for (const s of stores) {
                const count = s.delWhere((key) => predicateFn(key, req));
                logger.info(cacheMessages.CACHE_INVALIDATE_WHERE(s.name, count));
              }
            } catch (err) {
              logger.error(cacheMessages.CACHE_PREDICATE_ERROR(err.message));
            }
          });
        }

        return result;
      };

      next();
    };
  }
}

module.exports = { CacheMiddleware };
