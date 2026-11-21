"use strict";

/**
 * @fileoverview Per-user login lockout with configurable fixed/incremental mode.
 *
 * WHAT THIS FILE DOES
 *   Tracks failed login attempts per userId and enforces a progressive lockout
 *   policy (the arithmetic lives in `LoginLockoutPolicy`):
 *     - Each lockout cycle reduces the number of allowed attempts by LOGIN_RETRY_DECREMENT.
 *     - In incremental mode each lockout duration multiplies by LOGIN_LOCKOUT_MULTIPLIER.
 *     - After LOGIN_MAX_LOCKOUT_CYCLES completed cycles the account enters HR-reset state
 *       where every subsequent attempt is rejected with 423 until HR clears the record.
 *     - A failure that arrives while the account is ALREADY locked is not counted
 *       (race fix).
 *
 * WHERE THE STATE LIVES
 *   - Single process: a per-instance CacheStore (24h TTL) - the sync API below.
 *   - Cluster worker (`clusterRpc.active`): the counters live on the PRIMARY
 *     (`LoginLockoutState`, reached over IPC with `lockout.check|fail|clear`) so
 *     the threshold is per user across ALL workers. The *Async methods choose the
 *     path. If the primary is unreachable the worker falls back to its LOCAL
 *     lockout (per-worker threshold, today's behaviour) and logs
 *     CLUSTER_LOCKOUT_FALLBACK at most once a minute.
 *   The WORKER writes the log lines (LOGIN_ATTEMPT_FAILED, LOGIN_LOCKOUT_ENGAGED,
 *   ...) in both paths so they keep the serving worker's [PID].
 *
 * PUBLIC API
 *   check / recordFailure / recordSuccess            - sync, local CacheStore
 *   checkAsync / recordFailureAsync / recordSuccessAsync - cluster-aware
 *
 * EXAMPLE
 *   const { loginLockout } = require('./LoginLockoutMiddleware');
 *
 *   // In AuthService.login():
 *   const lockState = await loginLockout.checkAsync(userId);
 *   if (lockState.hrReset) throw new AppError(AUTH_ERRORS.ACCOUNT_LOCKED_PERMANENTLY, 423, ...);
 *   if (lockState.locked)  throw new AppError(AUTH_ERRORS.ACCOUNT_LOCKED, 429, ...);
 *
 *   // On credential failure (await BEFORE throwing the 401):
 *   await loginLockout.recordFailureAsync(userId);
 *
 *   // On successful authentication:
 *   await loginLockout.recordSuccessAsync(userId);
 */

const { CacheStore } = require("../cache");
const { logger } = require("../../utils/logger");
const { authMessages } = require("../../constants/messages");
const { clusterMessages } = require("../../constants/messages/cluster.messages");
const { canonicalUserKey } = require("../../utils/auth/userKey");
const { clusterRpc } = require("../../utils/cluster/ClusterRpcClient");
const { validateArgs } = require("../../utils/cluster/ipcSchemas");
const {
  CLUSTER_RPC_METHODS,
  CLUSTER_RPC_TIMEOUTS,
  CLUSTER_RPC_LIMITS,
} = require("../../constants/clusterIpc");
const { LoginLockoutPolicy } = require("./LoginLockoutPolicy");

/**
 * Canonical store key for a login identifier. Kept as an alias of
 * `canonicalUserKey` (lives in utils/auth/userKey.js so the refresh
 * token registry and the lockout share ONE spelling-collapse rule, CWE-307).
 */
const lockoutKey = canonicalUserKey;

class LoginLockoutMiddleware {
  /**
   * @param {object} [options]
   * @param {number}  [options.maxAttempts]      - LOGIN_MAX_ATTEMPTS. Default 3.
   * @param {string}  [options.lockoutMode]      - 'fixed' | 'incremental'. Default 'incremental'.
   * @param {number}  [options.lockoutDurationMs] - Base lockout duration in ms. Default 30000.
   * @param {number}  [options.lockoutMultiplier] - Incremental multiplier per cycle. Default 2.
   * @param {number}  [options.maxLockoutCycles]  - Cycles before HR-reset state. Default 3.
   * @param {number}  [options.retryDecrement]    - Attempts removed each cycle. Default 1.
   * @param {CacheStore} [options.store]           - Override the CacheStore instance (for testing).
   */
  constructor(options = {}) {
    this._policy = new LoginLockoutPolicy(options);
    this._maxAttempts = this._policy.maxAttempts;
    this._lockoutMode = this._policy.lockoutMode;
    this._lockoutDurationMs = this._policy.lockoutDurationMs;
    this._lockoutMultiplier = this._policy.lockoutMultiplier;
    this._maxLockoutCycles = this._policy.maxLockoutCycles;
    this._retryDecrement = this._policy.retryDecrement;

    this._store =
      options.store ??
      new CacheStore("loginLockout", { ttl: 86400, checkPeriod: 600 });
    this._lastFallbackLog = -Infinity;
  }

  // ── Public API (sync, local CacheStore) ───────────────────────────────────

  /**
   * Checks the current lockout state for a userId without counting anything.
   *
   * @param {string} userId
   * @returns {{ locked: boolean, retryAfter?: number, hrReset?: boolean }}
   *   locked     — true if still within a lockout window
   *   retryAfter — seconds remaining in the lockout (only when locked)
   *   hrReset    — true when all cycles have been consumed (permanent block)
   */
  check(userId) {
    const r = this._policy.evaluate(this._readState(userId), Date.now());
    if (r.changed) this._writeState(userId, r.state);

    if (r.locked) return { locked: true, retryAfter: r.retryAfter };
    if (r.hrReset) {
      logger.warning(authMessages.LOGIN_LOCKOUT_PERMANENT(userId));
      return { locked: false, hrReset: true };
    }
    return { locked: false };
  }

  /**
   * Records a failed login attempt for a userId.
   * Engages a lockout when failCount reaches currentMax. A failure arriving
   * while the account is already locked is ignored (state unchanged).
   *
   * @param {string} userId
   * @returns {object} The updated state object (for logging / testing).
   */
  recordFailure(userId) {
    const r = this._policy.fail(this._readState(userId), Date.now());
    this._logFailure(userId, r);
    if (!r.ignored) this._writeState(userId, r.state);
    return r.state;
  }

  /**
   * Clears the lockout state for a userId on successful authentication.
   * The CacheStore `del` is relayed to sibling workers (ClusterCacheSync).
   *
   * @param {string} userId
   */
  recordSuccess(userId) {
    this._store.del(lockoutKey(userId));
    logger.info(authMessages.LOGIN_LOCKOUT_CLEARED(userId));
  }

  // ── Public API (cluster-aware) ────────────────────────────────────────────

  /**
   * Cluster-wide `check`. Outside a cluster worker this IS `check`.
   *
   * @param {string} userId
   * @returns {Promise<{ locked: boolean, retryAfter?: number, hrReset?: boolean }>}
   */
  async checkAsync(userId) {
    if (!clusterRpc.active) return this.check(userId);

    const r = await this._rpc(CLUSTER_RPC_METHODS.LOCKOUT_CHECK, userId);
    if (r === null) return this.check(userId);

    if (r.hrReset) {
      logger.warning(authMessages.LOGIN_LOCKOUT_PERMANENT(userId));
      return { locked: false, hrReset: true };
    }
    if (r.locked) return { locked: true, retryAfter: r.retryAfter };
    return { locked: false };
  }

  /**
   * Cluster-wide `recordFailure`. Outside a cluster worker this IS
   * `recordFailure`. AWAIT it before answering the 401: the next attempt (on any
   * worker) must see this failure.
   *
   * @param {string} userId
   * @returns {Promise<void>}
   */
  async recordFailureAsync(userId) {
    if (!clusterRpc.active) {
      this.recordFailure(userId);
      return;
    }
    const r = await this._rpc(CLUSTER_RPC_METHODS.LOCKOUT_FAIL, userId);
    if (r === null) {
      this.recordFailure(userId);
      return;
    }
    this._logFailure(userId, r);
  }

  /**
   * Cluster-wide `recordSuccess`: clears this worker's store (with the sibling
   * `del` broadcast) AND the primary's counters.
   *
   * @param {string} userId
   * @returns {Promise<void>}
   */
  async recordSuccessAsync(userId) {
    this.recordSuccess(userId);
    if (!clusterRpc.active) return;
    await this._rpc(CLUSTER_RPC_METHODS.LOCKOUT_CLEAR, userId);
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * One primary round trip. Resolves `null` when the caller must use its local
   * lockout instead (primary declined, timed out, errored, or the key does not
   * fit the IPC schema); never throws.
   *
   * @param {string} method - CLUSTER_RPC_METHODS.LOCKOUT_*
   * @param {string} userId
   * @returns {Promise<object|null>}
   * @private
   */
  async _rpc(method, userId) {
    const args = { key: lockoutKey(userId) };
    if (!validateArgs(method, args).ok) {
      this._warnFallback("bad-key");
      return null;
    }
    try {
      const r = await clusterRpc.call("primary", method, args, {
        timeoutMs: CLUSTER_RPC_TIMEOUTS.LOCKOUT_MS,
      });
      if (r !== null && r?.fallback === true) {
        this._warnFallback("primary-declined");
        return null;
      }
      return r ?? {};
    } catch (err) {
      this._warnFallback(err?.code ?? err?.message ?? "error");
      return null;
    }
  }

  /** CLUSTER_LOCKOUT_FALLBACK, at most once a minute. */
  _warnFallback(reason) {
    const now = Date.now();
    if (now - this._lastFallbackLog < CLUSTER_RPC_LIMITS.REJECT_LOG_GAP_MS) return;
    this._lastFallbackLog = now;
    logger.warning(clusterMessages.CLUSTER_LOCKOUT_FALLBACK(String(reason)));
  }

  /**
   * The log lines for one counted/ignored failure (written by the worker in
   * both the local and the cluster path).
   *
   * @param {string} userId
   * @param {{ignored: boolean, failCount: number, currentMax: number, engaged: boolean, lockDurationMs: number|null, cycles: number}} r
   * @private
   */
  _logFailure(userId, r) {
    if (r.ignored) {
      logger.warning(authMessages.LOGIN_FAILURE_IGNORED_LOCKED(userId));
      return;
    }
    logger.warning(
      authMessages.LOGIN_ATTEMPT_FAILED(userId, r.failCount, r.currentMax),
    );
    if (r.engaged) {
      logger.warning(
        authMessages.LOGIN_LOCKOUT_ENGAGED(userId, r.lockDurationMs, r.cycles),
      );
    }
  }

  /**
   * Returns the current state for a userId, initialising defaults if absent.
   * @param {string} userId
   * @returns {{ cycles: number, currentMax: number, failCount: number, lockUntil: number|null }}
   * @private
   */
  _readState(userId) {
    return this._store.get(lockoutKey(userId)) ?? this._policy.initial();
  }

  /**
   * Persists state back into the cache with a 24h TTL.
   * @param {string} userId
   * @param {object} state
   * @private
   */
  _writeState(userId, state) {
    this._store.set(lockoutKey(userId), state, 86400);
  }
}

// ── Singleton export ──────────────────────────────────────────────────────────

const loginLockout = new LoginLockoutMiddleware();

module.exports = { LoginLockoutMiddleware, loginLockout, lockoutKey };
