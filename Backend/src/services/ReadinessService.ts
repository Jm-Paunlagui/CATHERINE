"use strict";

/**
 * @fileoverview ReadinessService — the ONE readiness rule, shared by
 * `GET /health/ready` and the readiness push stream (`GET /health/stream`).
 *
 * READY means the app can serve a request end to end, right now:
 *   1. every registered pool (appDb, appDbBulk — POOL_NAMES) answers
 *      `SELECT 1 FROM DUAL` within HEALTH_PROBE_TIMEOUT_MS, and
 *   2. every pool's circuit breaker in withConnection is closed.
 * Rule 2 is what makes "Back online" honest: without it /ready said 200 as
 * soon as the gating pools answered while the health monitor still had a
 * breaker open, so sign-in failed fast with a 503 for up to 30 s after the
 * banner said the service was back. A successful probe now closes that pool's
 * breaker at once (`recordProbeSuccess`), and a pool whose breaker is still
 * open keeps readiness false.
 *
 * The bulk pool votes too, but its SATURATION is not an outage: an NJS-076
 * acquire-queue rejection (`state: "saturated"`) means the bulkhead is shedding
 * load and the pool is reachable, so for appDbBulk it counts as up. A saturated
 * gating pool (READINESS_GATING_POOLS) still means not ready.
 *
 * Probes are coalesced: concurrent callers share one in-flight evaluation, so a
 * burst of /ready calls (or many stream clients) costs one probe per pool.
 *
 * SECURITY (CWE-209): the raw driver error is logged server-side only; the
 * returned `error` is a static string.
 */

const db = require("../config");
const { POOL_NAMES, READINESS_GATING_POOLS } = require("../config/database");
const { logger } = require("../utils/logger");

/**
 * Reads a positive-integer env var, falling back to `fallbackValue`.
 * @param {string} name
 * @param {number} fallbackValue
 * @returns {number}
 */
function _envInt(name, fallbackValue) {
    const n = Number(process.env[name]);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallbackValue;
}

/** Upper bound (ms) for a single pool probe. */
const HEALTH_PROBE_TIMEOUT_MS = _envInt("HEALTH_PROBE_TIMEOUT_MS", 2500);

/**
 * True when a raw driver error indicates NJS-076 acquire-queue back-pressure.
 * @param {string} raw
 * @returns {boolean}
 */
function _isSaturationError(raw) {
    return /NJS-076/.test(raw || "");
}

/**
 * Pings one pool with `SELECT 1 FROM DUAL`, bypassing the circuit breaker (this
 * IS the signal that reports pool health) and bounded by a timeout.
 *
 * @param {string} poolName
 * @returns {Promise<{ status: "up"|"down", state: "up"|"saturated"|"down", latencyMs?: number, error?: string }>}
 */
async function probePool(poolName) {
    const start = Date.now();
    let timer;
    try {
        const probe = db.withConnection(
            poolName,
            async (conn) => {
                await conn.execute("SELECT 1 FROM DUAL");
            },
            { bypassBreaker: true },
        );
        const timeout = new Promise((resolve) => {
            timer = setTimeout(
                () =>
                    resolve({
                        status: "down",
                        state: "down",
                        error: "probe timeout",
                        latencyMs: HEALTH_PROBE_TIMEOUT_MS,
                    }),
                HEALTH_PROBE_TIMEOUT_MS,
            );
        });
        // A probe that loses the race must not surface as an unhandled rejection.
        probe.catch(() => {});
        return await Promise.race([
            probe.then(() => ({
                status: "up",
                state: "up",
                latencyMs: Date.now() - start,
            })),
            timeout,
        ]);
    } catch (err) {
        const raw = err.message || String(err);
        logger.warn(`Health probe failed for pool "${poolName}": ${raw}`);
        const state = _isSaturationError(raw) ? "saturated" : "down";
        return { status: "down", state, error: "probe failed" };
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * Does this pool's probe count as up for the verdict? A gating pool
 * (READINESS_GATING_POOLS) must answer. A non-gating pool (appDbBulk) may also
 * be "saturated": it answered the network and shed the probe by design.
 * @param {string} name
 * @param {{ status: string, state: string }} check
 */
const _countsUp = (name, check) =>
    check?.status === "up" ||
    (!READINESS_GATING_POOLS.includes(name) && check?.state === "saturated");

let _inFlight = null;

/**
 * Probes every pool, closes the breaker of each pool that answered, and returns
 * the verdict. Concurrent callers share one evaluation.
 *
 * @returns {Promise<{ ready: boolean, checks: Record<string, object> }>}
 */
function evaluate() {
    if (_inFlight) return _inFlight;
    _inFlight = (async () => {
        const results = await Promise.all(POOL_NAMES.map(probePool));
        const checks = {};
        let ready = true;
        POOL_NAMES.forEach((name, i) => {
            const check = results[i];
            if (check.status === "up") {
                // A real round trip just succeeded: the breaker must not keep
                // failing requests fast for another monitor interval.
                db.recordProbeSuccess?.(name);
            }
            const breakerClosed = db.isPoolHealthy
                ? db.isPoolHealthy(name)
                : true;
            if (!_countsUp(name, check) || !breakerClosed) ready = false;
            checks[`oracle_${name}`] = check;
        });
        return { ready, checks };
    })().finally(() => {
        _inFlight = null;
    });
    return _inFlight;
}

module.exports = {
    evaluate,
    probePool,
    HEALTH_PROBE_TIMEOUT_MS,
    _isSaturationError,
};
