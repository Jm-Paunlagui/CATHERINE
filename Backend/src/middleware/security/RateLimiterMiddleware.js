"use strict";

/**
 * @fileoverview Sliding Window Counter rate limiter middleware.
 * O(1) memory per key, ~0.003% error rate, IETF RateLimit-* headers.
 */

const { SlidingWindowCounter } = require("./SlidingWindowCounter");
const { clusterRpc } = require("../../utils/cluster/ClusterRpcClient");
const { validateArgs } = require("../../utils/cluster/ipcSchemas");
const {
  CLUSTER_RPC_METHODS,
  CLUSTER_RPC_TIMEOUTS,
  CLUSTER_RPC_LIMITS,
} = require("../../constants/clusterIpc");
const { clusterMessages } = require("../../constants/messages/cluster.messages");
const { middlewareMessages } = require("../../constants/messages/middleware.messages");
const { RATE_LIMIT_COUNT_MODES } = require("../../constants/authRateLimits");
const { getStatusTitle } = require("../../constants/responses");
const { logger } = require("../../utils/logger");

/**
 * Health-probe paths that bypass rate limiting.
 *
 * This limiter is mounted with a bare `app.use(...)` in app.js (step 13), so
 * `req.path` here is the FULL request path — `/api/v1/health/ready`, never a
 * router-relative `/ready`. The previous literal check (`req.path ===
 * "/api/health"`) matched no route this server has ever exposed (the routes are
 * `/api/v1/health`, `/api/v1/health/live`, `/api/v1/health/ready` — see
 * routes/index.js), so the bypass was dead code and probes shared the default
 * 100-req/15-min per-IP bucket with real traffic. A monitor polling
 * /health/ready every 5s spends 180 requests per window and starts collecting
 * 429s — which reads as "backend unhealthy" to whatever is watching, i.e. the
 * rate limiter manufactures the outage the probe exists to detect.
 *
 * The `(\/|$)` anchor keeps `/api/v1/healthcheck` from bypassing; `v\d+` keeps
 * this working when the API version is bumped.
 *
 * @constant {RegExp}
 */
const HEALTH_PATH_RE = /^\/api\/v\d+\/health(\/|$)/;

class RateLimiterMiddleware {
  constructor(options = {}) {
    this._max =
      options.max ?? parseInt(process.env.RATE_LIMIT_MAX || "100", 10);
    this._windowMs =
      options.windowMs ??
      parseInt(process.env.RATE_LIMIT_WINDOW_MS || "900000", 10);
    this._keyBy = options.keyBy ?? "ip";
    this._skip = options.skip ?? null;
    this._onLimit = options.onLimit ?? null;
    this._dryRun = options.dryRun ?? false;
    this._label = options.label ?? "RateLimit";
    // Counter name on the cluster primary: the label with characters the IPC
    // schema does not allow replaced, capped at 64.
    this._sharedLabel = String(this._label).replace(/[^A-Za-z0-9:_-]/g, "_").slice(0, 64) || "RateLimit";
    this._lastFallbackLog = -Infinity;
    this._lastStoreFullLog = -Infinity;
    // ALL (default): every request counts. FAILURES: a request is counted
    // up-front (reserve) and given back on finish when it succeeded.
    this._countMode = options.countMode ?? RATE_LIMIT_COUNT_MODES.ALL;
    if (!Object.values(RATE_LIMIT_COUNT_MODES).includes(this._countMode)) {
      throw new RangeError("Rate Limit countMode must be 'all' or 'failures'");
    }
    this._maxKeys = options.maxKeys ?? -1;
    // Window math lives in SlidingWindowCounter; `_store` stays the same
    // NodeCache for callers that read it directly.
    this._counter = new SlidingWindowCounter({ store: options.store, maxKeys: this._maxKeys });
    this._store = this._counter.store;

    if (this._max <= 0) throw new RangeError("Rate Limit max must be > 0");
    if (this._windowMs <= 0)
      throw new RangeError("Rate Limit windowMs must be > 0");

    this.handle = this.handle.bind(this);
  }

  handle(req, res, next) {
    if (req.method === "OPTIONS" || HEALTH_PATH_RE.test(req.path)) return next();
    if (this._skip?.(req)) return next();

    const key = this._getKey(req);

    // Cluster: the primary owns the counters so the limit is per IP across all
    // workers. Single-process (clusterRpc inactive): the synchronous local path,
    // unchanged.
    if (clusterRpc.active) return this._handleShared(req, res, next, key);

    return this._finish(req, res, next, key, this._slidingWindowCounter(key));
  }

  /**
   * Asks the primary to count this hit, then finishes exactly as the local path
   * does. A primary that times out, overflows or rejects the call is NOT a reason
   * to refuse anyone: the hit is counted locally with the full `max` (per-worker
   * limit, today's behaviour) and `CLUSTER_RL_FALLBACK` is logged at most once a
   * minute per label. Every rejection reaches `next(err)`; `next` is called once.
   */
  _handleShared(req, res, next, key) {
    let settled = false;
    const once = (err) => {
      if (settled) return;
      settled = true;
      next(err);
    };
    this._hitShared(key)
      .then((result) => {
        if (settled) return;
        settled = true;
        this._finish(req, res, next, key, result);
      })
      .catch((err) => {
        // _finish may already have answered; only forward when nothing did.
        if (!settled) return once(err);
        if (!res.headersSent) next(err);
      });
  }

  async _hitShared(key) {
    const args = {
      label: this._sharedLabel,
      key,
      max: this._max,
      windowMs: this._windowMs,
    };
    // Values the IPC schema cannot carry (odd label, huge key, out-of-range
    // limits) are counted locally rather than rejected by the primary.
    if (!validateArgs(CLUSTER_RPC_METHODS.RL_HIT, args).ok) {
      return this._slidingWindowCounter(key);
    }
    try {
      const r = await clusterRpc.call("primary", CLUSTER_RPC_METHODS.RL_HIT, args, {
        timeoutMs: CLUSTER_RPC_TIMEOUTS.RL_HIT_MS,
      });
      if (r.fallback === true) {
        this._warnFallback("primary-declined");
        return this._slidingWindowCounter(key);
      }
      return {
        allowed: r.allowed,
        count: r.count,
        remaining: r.remaining,
        resetAt: r.resetAt,
        bucket: r.bucket,
        retryAt: r.retryAt,
        source: "shared",
      };
    } catch (err) {
      this._warnFallback(err?.code ?? err?.message ?? "error");
      return this._slidingWindowCounter(key);
    }
  }

  /** CLUSTER_RL_FALLBACK, at most once a minute per limiter label. */
  _warnFallback(reason) {
    const now = Date.now();
    if (now - this._lastFallbackLog < CLUSTER_RPC_LIMITS.REJECT_LOG_GAP_MS) return;
    this._lastFallbackLog = now;
    logger.warning(clusterMessages.CLUSTER_RL_FALLBACK(this._label, String(reason)));
  }

  /** Headers, limit refusal and pass log: shared by the local and cluster paths. */
  _finish(req, res, next, key, result) {
    this._setHeaders(res, {
      limit: this._max,
      remaining: result.remaining,
      resetAt: result.resetAt,
      windowMs: this._windowMs,
    });

    if (!result.allowed) {
      // Real earliest admit time (`retryAt`), never less than 1 s.
      const retryAfter = Math.max(
        1,
        Math.ceil(((result.retryAt ?? result.resetAt) - Date.now()) / 1000),
      );
      res.setHeader("Retry-After", retryAfter);
      // Lets an earlier FAILURES-mode limiter on this request give its hit back.
      if (!this._dryRun && res.locals) res.locals.rateLimitedBy = this._label;

      logger.warning(`[${this._label}] Limit exceeded`, {
        key,
        ip: RateLimiterMiddleware.extractIp(req),
        path: req.path,
        method: req.method,
        count: result.count,
        max: this._max,
        windowMs: this._windowMs,
        dryRun: this._dryRun,
      });

      if (this._dryRun) return next();

      if (this._onLimit) {
        return this._onLimit(req, res, {
          ...result,
          retryAfter,
          max: this._max,
          windowMs: this._windowMs,
        });
      }

      return res.status(429).json({
        status: "error",
        code: 429,
        title: getStatusTitle(429),
        message: "Too many requests. Please try again later.",
        error: {
          type: "RateLimitExceeded",
          details: [{ field: "retryAfter", issue: `${retryAfter} seconds` }],
          hint: "Wait before retrying.",
        },
      });
    }

    logger.debug(`[${this._label}] Pass`, {
      key,
      count: result.count,
      remaining: result.remaining,
    });

    if (
      this._countMode === RATE_LIMIT_COUNT_MODES.FAILURES &&
      result.bucket !== undefined
    ) {
      res.once("finish", () => {
        const laterRefused =
          res.locals?.rateLimitedBy !== undefined &&
          res.locals.rateLimitedBy !== this._label;
        if (res.statusCode < 400 || laterRefused) this._refund(key, result);
      });
    }

    next();
  }

  /**
   * Gives one counted hit back. Shared hits are refunded on the primary
   * (fire-and-forget: a lost refund only makes the limit stricter); hits counted
   * locally (single process or fallback) are refunded locally. Never throws.
   */
  _refund(key, result) {
    try {
      if (result.source === "shared") {
        const args = {
          label: this._sharedLabel,
          key,
          windowMs: this._windowMs,
          bucket: result.bucket,
        };
        if (clusterRpc.active && validateArgs(CLUSTER_RPC_METHODS.RL_REFUND, args).ok) {
          clusterRpc.notify(CLUSTER_RPC_METHODS.RL_REFUND, args);
        }
        return;
      }
      this._counter.refund(key, result.bucket, this._windowMs);
    } catch {
      // Best effort: a failed refund only makes the limit stricter.
    }
  }

  getStats() {
    return this._store.getStats();
  }

  clearKey(key) {
    const n = this._store.del(key);
    logger.info("Rate Limit Key cleared", { key, deleted: n });
    this._notifyClear(key);
    return n;
  }

  flushAll() {
    this._store.flushAll();
    logger.warning("Rate Limit All data flushed");
    this._notifyClear(null);
  }

  /** Cluster only: tells the primary to clear its counters for this limiter. */
  _notifyClear(key) {
    if (!clusterRpc.active) return;
    const args = { label: this._sharedLabel, key };
    if (validateArgs(CLUSTER_RPC_METHODS.RL_CLEAR, args).ok) {
      clusterRpc.notify(CLUSTER_RPC_METHODS.RL_CLEAR, args);
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────

  _getKey(req) {
    if (typeof this._keyBy === "function") return this._keyBy(req);
    return (
      RateLimiterMiddleware.keyGenerators[this._keyBy] ??
      RateLimiterMiddleware.keyGenerators.ip
    )(req);
  }

  _slidingWindowCounter(key) {
    try {
      return { ...this._counter.hit(key, this._max, this._windowMs), source: "local" };
    } catch (err) {
      // Local store full (maxKeys): fail OPEN - lockout stays the brute-force
      // control, and the cluster primary answers `{fallback:true}` the same way.
      if (this._maxKeys > 0 && (err?.name === "ECACHEFULL" || err?.errorcode === "ECACHEFULL")) {
        this._warnStoreFull();
        return {
          allowed: true,
          count: 0,
          remaining: this._max,
          resetAt: Date.now() + this._windowMs,
          source: "local",
        };
      }
      throw err;
    }
  }

  /** RATE_LIMIT_STORE_FULL, at most once a minute per limiter label. */
  _warnStoreFull() {
    const now = Date.now();
    if (now - this._lastStoreFullLog < CLUSTER_RPC_LIMITS.REJECT_LOG_GAP_MS) return;
    this._lastStoreFullLog = now;
    logger.warning(middlewareMessages.RATE_LIMIT_STORE_FULL(this._label));
  }

  _setHeaders(res, { limit, remaining, resetAt, windowMs }) {
    const resetSec = Math.ceil(resetAt / 1000);
    const windowSec = Math.ceil(windowMs / 1000);
    res.setHeader("RateLimit-Limit", limit);
    res.setHeader("RateLimit-Remaining", remaining);
    res.setHeader("RateLimit-Reset", resetSec);
    res.setHeader("RateLimit-Policy", `${limit};w=${windowSec}`);
  }

  // ── Static helpers ────────────────────────────────────────────────────

  /**
   * Extracts the client IP for rate-limit key generation.
   *
   * Security: CWE-290 (Spoofed X-Forwarded-For bypass) mitigation.
   * When TRUST_PROXY is enabled, Express must be configured with
   * `app.set('trust proxy', N)` (N = number of trusted hops) so that
   * `req.ip` already reflects the rightmost *untrusted* hop — making
   * direct header parsing unnecessary and unsafe.
   *
   * We always use `req.ip` (Express's resolved value) rather than parsing
   * X-Forwarded-For ourselves.  `req.ip` is:
   *   - The direct connection address when trust proxy is disabled.
   *   - The rightmost untrusted hop when trust proxy is configured via
   *     `app.set('trust proxy', N)`.
   *
   * Raw X-Forwarded-For parsing is intentionally removed because the
   * first (leftmost) hop is fully client-controlled and allows trivial
   * bucket-rotation bypasses.
   *
   * @param {import('express').Request} req
   * @returns {string}
   */
  static extractIp(req) {
    return req.ip || req.socket?.remoteAddress || "unknown";
  }

  static keyGenerators = {
    ip: (req) => `rl:ip:${RateLimiterMiddleware.extractIp(req)}`,
    user: (req) =>
      req.user?.sub
        ? `rl:user:${req.user.sub}`
        : `rl:ip:${RateLimiterMiddleware.extractIp(req)}`,
    apiKey: (req) => {
      const key = req.headers["x-api-key"];
      return key
        ? `rl:apikey:${key}`
        : `rl:ip:${RateLimiterMiddleware.extractIp(req)}`;
    },
    ipAndRoute: (req) =>
      `rl:ip+route:${RateLimiterMiddleware.extractIp(req)}:${req.route?.path || req.path}`,
    userAndRoute: (req) => {
      const id = req.user?.sub || RateLimiterMiddleware.extractIp(req);
      return `rl:user+route:${id}:${req.route?.path || req.path}`;
    },
  };
}

// ── Preset instances ──────────────────────────────────────────────────────────

const defaultRateLimiter = new RateLimiterMiddleware({
  label: "RateLimit:default",
});

const burstRateLimiter = new RateLimiterMiddleware({
  max: 5,
  windowMs: 60_000,
  keyBy: "user",
  label: "RateLimit:burst",
});

const perRouteRateLimiter = new RateLimiterMiddleware({
  max: 30,
  windowMs: 60_000,
  keyBy: "ipAndRoute",
  label: "RateLimit:perRoute",
});

/**
 * Access Control "Reset Password" — every admitted call emails a new temporary
 * password (a credential) to an account holder. 5 per minute per signed-in
 * caller: enough for an operator working through a list, too few to bomb a
 * mailbox. Keyed by user, not IP, because the route is authenticated and two
 * admins behind one NAT must not share a budget. Mount AFTER authenticate.
 */
const credentialEmailRateLimiter = new RateLimiterMiddleware({
  max: 5,
  windowMs: 60_000,
  keyBy: "user",
  label: "RateLimit:credential-email",
});

/**
 * @class RateLimiterGroup
 * @description A fixed set of limiters that are flushed and inspected together
 * (the four auth limiters). Holds state (its members), so it is a class.
 */
class RateLimiterGroup {
  /** @param {RateLimiterMiddleware[]} members */
  constructor(members) {
    this._members = Object.freeze([...members]);
  }

  /** @returns {ReadonlyArray<RateLimiterMiddleware>} */
  get members() {
    return this._members;
  }

  /** Flushes every member's counters (local and, in a cluster, the primary's). */
  flushAll() {
    for (const m of this._members) m.flushAll();
  }

  /** @returns {Object<string, object>} NodeCache stats keyed by member label */
  getStats() {
    const out = {};
    for (const m of this._members) out[m._label] = m.getStats();
    return out;
  }
}

module.exports = {
  RateLimiterMiddleware,
  RateLimiterGroup,
  defaultRateLimiter,
  burstRateLimiter,
  perRouteRateLimiter,
  credentialEmailRateLimiter,
};
