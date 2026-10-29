"use strict";

/**
 * @fileoverview Merges the per-worker `MetricsStore` snapshots of a cluster into
 * ONE snapshot with the same shape `MetricsStore.getSnapshot()` returns (plus
 * additive `cluster` and `system.workers` fields).
 *
 * Why not just sum: percentiles and averages cannot be summed. Each worker sends
 * its raw counters AND, per route / Oracle pool, a quantile sketch (the sorted
 * durations sampled at `QUANTILE_GRID`, ~17 numbers instead of a 1000-sample ring
 * buffer). A merged percentile is the inverse of the n-weighted mix of the
 * workers' piecewise-linear CDFs: accurate to about one grid step.
 *
 * Merge rules per field are in `mergeMetricsSnapshots`. Everything here is pure.
 *
 * Security: CWE-20 (a part that is not a plausible snapshot is skipped and counted
 * missing), CWE-1321 (merged maps are `Map`s, turned into objects with
 * `Object.fromEntries`, never assigned by key), CWE-400 (frontend lists capped at
 * 500, watchdog routes at 200, sketches validated for length).
 *
 * Complexity: O(workers x (routes + pools + 500 vitals)); one percentile is
 * O(60 x workers x log grid).
 *
 * @author senior-nodejs-engineer
 */

const { computeRates } = require("./MetricsStore");

/** Probabilities at which each worker's sorted durations are sampled. */
const QUANTILE_GRID = Object.freeze([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.96, 0.97, 0.98, 0.99, 0.995, 1]);

/** Frontend vitals / errors kept after the merge (same cap as the store). */
const FRONTEND_MERGE_MAX = 500;
/** Watchdog routes kept after the merge. */
const WATCHDOG_ROUTES_MERGE_MAX = 200;
/** Bisection steps when inverting the mixed CDF. */
const BISECT_STEPS = 60;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const maxOf = (values) => values.reduce((m, v) => (v > m ? v : m), 0);
const sumOf = (values) => values.reduce((s, v) => s + v, 0);
const round2 = (v) => Number(v.toFixed(2));

/**
 * Samples a sorted duration array at `QUANTILE_GRID`.
 *
 * @param {number[]} sortedDurations - ascending
 * @returns {{n: number, q: number[]}} `q` is empty when there are no samples
 */
function buildQuantileSketch(sortedDurations) {
    const n = sortedDurations.length;
    if (n === 0) return { n: 0, q: [] };
    const q = QUANTILE_GRID.map((p) => (p >= 1 ? sortedDurations[n - 1] : sortedDurations[Math.min(Math.floor(n * p), n - 1)]));
    return { n, q };
}

/** @returns {boolean} a sketch with finite, ascending values on the full grid */
function isValidSketch(s) {
    if (!isObj(s) || !Number.isFinite(s.n) || s.n < 0 || !Array.isArray(s.q)) return false;
    if (s.n === 0) return s.q.length === 0;
    if (s.q.length !== QUANTILE_GRID.length) return false;
    for (let i = 0; i < s.q.length; i++) {
        if (!Number.isFinite(s.q[i]) || (i > 0 && s.q[i] < s.q[i - 1])) return false;
    }
    return true;
}

/** CDF of one sketch at x: piecewise linear over (q[k], grid[k]). */
function sketchCdf(q, x) {
    const last = q.length - 1;
    if (x < q[0]) return 0;
    if (x >= q[last]) return 1;
    let lo = 0;
    let hi = last;
    while (lo < hi - 1) {
        const mid = (lo + hi) >> 1;
        if (q[mid] <= x) lo = mid;
        else hi = mid;
    }
    const span = q[lo + 1] - q[lo];
    const frac = span > 0 ? (x - q[lo]) / span : 1;
    return QUANTILE_GRID[lo] + frac * (QUANTILE_GRID[lo + 1] - QUANTILE_GRID[lo]);
}

/**
 * Percentile of the union of several workers' samples, from their sketches.
 *
 * @param {Array<{n: number, q: number[]}>} sketches
 * @param {number} p - 0..1
 * @returns {number} 0 when no sketch has samples
 */
function percentileFromSketches(sketches, p) {
    const live = sketches.filter((s) => isValidSketch(s) && s.n > 0);
    if (live.length === 0) return 0;
    const total = sumOf(live.map((s) => s.n));
    const lo0 = Math.min(...live.map((s) => s.q[0]));
    const hi0 = Math.max(...live.map((s) => s.q[s.q.length - 1]));
    if (p <= 0) return lo0;
    if (p >= 1) return hi0;
    const mixed = (x) => sumOf(live.map((s) => s.n * sketchCdf(s.q, x))) / total;
    let lo = lo0;
    let hi = hi0;
    for (let i = 0; i < BISECT_STEPS; i++) {
        const mid = (lo + hi) / 2;
        if (mixed(mid) >= p) hi = mid;
        else lo = mid;
    }
    return round2(hi);
}

/** @returns {boolean} the part looks like `{snapshot, extras}` from getMergeableSnapshot */
function isUsablePart(part) {
    const snap = part?.value?.snapshot;
    return (
        isObj(snap) &&
        isObj(snap.red) &&
        isObj(snap.totals) &&
        isObj(snap.system) &&
        isObj(snap.system.memory) &&
        isObj(snap.dependencies)
    );
}

const latestIso = (a, b) => (a && (!b || a > b) ? a : b ?? null);

/** Merges the red[] maps. */
function mergeRed(snaps, extrasList) {
    const routes = new Map();
    snaps.forEach((snap, i) => {
        const sketches = isObj(extrasList[i]?.routeSketches) ? extrasList[i].routeSketches : {};
        const wSketches = isObj(extrasList[i]?.routeWindowSketches) ? extrasList[i].routeWindowSketches : {};
        for (const [route, r] of Object.entries(snap.red)) {
            if (!isObj(r)) continue;
            let acc = routes.get(route);
            if (!acc) {
                acc = [];
                routes.set(route, acc);
            }
            acc.push({
                r,
                sketch: isValidSketch(sketches[route]) ? sketches[route] : null,
                wSketch: isValidSketch(wSketches[route]) ? wSketches[route] : null,
            });
        }
    });
    const out = new Map();
    for (const [route, entries] of routes) {
        const rows = entries.map((e) => e.r);
        const sketches = entries.map((e) => e.sketch).filter(Boolean);
        const count = sumOf(rows.map((r) => num(r.count)));
        const clientErrorCount = sumOf(rows.map((r) => num(r.clientErrorCount)));
        const serverErrorCount = sumOf(rows.map((r) => num(r.serverErrorCount)));
        const rates = computeRates(count, clientErrorCount, serverErrorCount);
        const wSketches = entries.map((e) => e.wSketch).filter(Boolean);
        const wRows = rows.map((r) => (isObj(r.window) ? r.window : {}));
        const wSketchN = sumOf(wSketches.map((s) => s.n));
        const haveSketches = sumOf(sketches.map((s) => s.n)) > 0;
        const pct = (key, p) => (haveSketches ? percentileFromSketches(sketches, p) : maxOf(rows.map((r) => num(r[key]))));
        // avgMs weighted by the samples each average was computed over; a worker
        // that sent no sketch is weighted by its (ring-buffer capped) count.
        let weight = 0;
        let weighted = 0;
        for (const { r, sketch } of entries) {
            const w = sketch ? sketch.n : Math.min(num(r.count), 1000);
            weight += w;
            weighted += w * num(r.avgMs);
        }
        out.set(route, {
            count,
            redirectCount: sumOf(rows.map((r) => num(r.redirectCount))),
            notModifiedCount: sumOf(rows.map((r) => num(r.notModifiedCount))),
            clientErrorCount,
            serverErrorCount,
            errorRate: rates.errorRate,
            clientErrorRate: rates.clientErrorRate,
            availability: rates.availability,
            p50: pct("p50", 0.5),
            p95: pct("p95", 0.95),
            p99: pct("p99", 0.99),
            avgMs: weight > 0 ? Math.round(weighted / weight) : 0,
            window: {
                windowMs: maxOf(wRows.map((w) => num(w.windowMs))),
                count: sumOf(wRows.map((w) => num(w.count))),
                p99: wSketchN > 0 ? percentileFromSketches(wSketches, 0.99) : maxOf(wRows.map((w) => num(w.p99))),
            },
        });
    }
    return Object.fromEntries(out);
}

/** Merges totals; successTotal, rates and apdex are recomputed from the sums. */
function mergeTotals(snaps, extrasList) {
    const t = snaps.map((s) => s.totals);
    const requestsTotal = sumOf(t.map((x) => num(x.requestsTotal)));
    const redirectsTotal = sumOf(t.map((x) => num(x.redirectsTotal)));
    const notModifiedTotal = sumOf(t.map((x) => num(x.notModifiedTotal)));
    const clientErrorsTotal = sumOf(t.map((x) => num(x.clientErrorsTotal)));
    const serverErrorsTotal = sumOf(t.map((x) => num(x.serverErrorsTotal)));
    const rates = computeRates(requestsTotal, clientErrorsTotal, serverErrorsTotal);

    let satisfied = 0;
    let tolerating = 0;
    let samples = 0;
    let haveCounts = false;
    for (const e of extrasList) {
        const a = e?.apdexCounts;
        if (isObj(a) && Number.isFinite(a.samples)) {
            haveCounts = true;
            satisfied += num(a.satisfied);
            tolerating += num(a.tolerating);
            samples += num(a.samples);
        }
    }
    let apdex;
    if (haveCounts) apdex = samples > 0 ? Number(((satisfied + tolerating / 2) / samples).toFixed(3)) : 1;
    else apdex = t.length ? Number((sumOf(t.map((x) => (Number.isFinite(x.apdex) ? x.apdex : 1))) / t.length).toFixed(3)) : 1;

    const wins = t.map((x) => x.window).filter(isObj);
    const wRequests = sumOf(wins.map((w) => num(w.requests)));
    const wClient = sumOf(wins.map((w) => num(w.clientErrors)));
    const wServer = sumOf(wins.map((w) => num(w.serverErrors)));
    const wRates = computeRates(wRequests, wClient, wServer);

    return {
        requestsTotal,
        successTotal: Math.max(0, requestsTotal - redirectsTotal - notModifiedTotal - clientErrorsTotal - serverErrorsTotal),
        redirectsTotal,
        notModifiedTotal,
        clientErrorsTotal,
        serverErrorsTotal,
        errorsTotal: clientErrorsTotal + serverErrorsTotal,
        errorRate: rates.errorRate,
        clientErrorRate: rates.clientErrorRate,
        availability: rates.availability,
        apdex,
        window: {
            windowMs: maxOf(wins.map((w) => num(w.windowMs))),
            requests: wRequests,
            clientErrors: wClient,
            serverErrors: wServer,
            serviced: wRequests - wClient,
            errorRate: wRates.errorRate,
            availability: wRates.availability,
        },
    };
}

/** Merges the system block and builds the per-worker list. */
function mergeSystem(parts) {
    const sys = parts.map((p) => p.value.snapshot.system);
    const heapRatio = (s) => num(s.memory.heapUsed) / (num(s.memory.heapSizeLimit) || 1);
    let hottest = 0;
    sys.forEach((s, i) => {
        if (heapRatio(s) > heapRatio(sys[hottest])) hottest = i;
    });
    let trendIdx = hottest;
    let trendGrowth = -Infinity;
    sys.forEach((s, i) => {
        const tr = s.memoryTrend;
        if (isObj(tr) && tr.suspected === true && num(tr.growthBytesPerMin) > trendGrowth) {
            trendGrowth = num(tr.growthBytesPerMin);
            trendIdx = i;
        }
    });
    const gcSum = (key) => ({
        count: sumOf(sys.map((s) => num(s.gc?.[key]?.count))),
        pauseMs: sumOf(sys.map((s) => num(s.gc?.[key]?.pauseMs))),
    });
    const recents = sys.map((s) => s.gc?.recent).filter(isObj);
    const recentCount = sumOf(recents.map((r) => num(r.sampleCount)));

    return {
        cpu: {
            user: sumOf(sys.map((s) => num(s.cpu?.user))),
            system: sumOf(sys.map((s) => num(s.cpu?.system))),
            percent: round2(sumOf(sys.map((s) => num(s.cpu?.percent)))),
        },
        memory: { ...sys[hottest].memory },
        eventLoopLag: maxOf(sys.map((s) => num(s.eventLoopLag))),
        gc: {
            collections: sumOf(sys.map((s) => num(s.gc?.collections))),
            pauseMs: sumOf(sys.map((s) => num(s.gc?.pauseMs))),
            overheadPct: maxOf(sys.map((s) => num(s.gc?.overheadPct))),
            major: gcSum("major"),
            minor: gcSum("minor"),
            incremental: gcSum("incremental"),
            weakcb: gcSum("weakcb"),
            recent: {
                sampleCount: recentCount,
                avgPauseMs: recentCount > 0 ? round2(sumOf(recents.map((r) => num(r.avgPauseMs) * num(r.sampleCount))) / recentCount) : 0,
                maxPauseMs: maxOf(recents.map((r) => num(r.maxPauseMs))),
                p95PauseMs: maxOf(recents.map((r) => num(r.p95PauseMs))),
            },
        },
        memoryTrend: isObj(sys[trendIdx].memoryTrend) ? { ...sys[trendIdx].memoryTrend } : sys[trendIdx].memoryTrend,
        handles: sumOf(sys.map((s) => num(s.handles))),
        requests: sumOf(sys.map((s) => num(s.requests))),
        workers: parts.map((p, i) => ({
            workerId: p.workerId,
            pid: p.pid ?? null,
            isLeader: p.isLeader === true,
            uptime: num(p.value.snapshot.uptime),
            cpuPct: num(sys[i].cpu?.percent),
            heapUsed: num(sys[i].memory.heapUsed),
            heapSizeLimit: num(sys[i].memory.heapSizeLimit),
            rss: num(sys[i].memory.rss),
            eventLoopLag: num(sys[i].eventLoopLag),
        })),
    };
}

/** Merges dependencies.oracle (pools are per worker: worst-of for saturation, sum for volume). */
function mergeOracle(parts) {
    const pools = new Map();
    parts.forEach((p) => {
        const oracle = p.value.snapshot.dependencies.oracle;
        if (!isObj(oracle)) return;
        const ex = p.value.extras ?? {};
        for (const [name, d] of Object.entries(oracle)) {
            if (!isObj(d)) continue;
            let acc = pools.get(name);
            if (!acc) {
                acc = { rows: [], sketches: [], totalMs: 0, haveTotalMs: true };
                pools.set(name, acc);
            }
            acc.rows.push(d);
            const sk = isObj(ex.oracleSketches) ? ex.oracleSketches[name] : undefined;
            if (isValidSketch(sk)) acc.sketches.push(sk);
            const tm = isObj(ex.oracleTotalMs) ? ex.oracleTotalMs[name] : undefined;
            if (Number.isFinite(tm)) acc.totalMs += tm;
            else acc.haveTotalMs = false;
        }
    });
    const out = new Map();
    for (const [name, { rows, sketches, totalMs, haveTotalMs }] of pools) {
        const nonNull = (key) => rows.map((r) => r[key]).filter((v) => typeof v === "number" && Number.isFinite(v));
        const sumOrNull = (key) => {
            const v = nonNull(key);
            return v.length ? sumOf(v) : null;
        };
        const maxOrNull = (key) => {
            const v = nonNull(key);
            return v.length ? Math.max(...v) : null;
        };
        const queryCount = sumOf(rows.map((r) => num(r.queryCount)));
        const health = rows.map((r) => r.healthy).filter((h) => typeof h === "boolean");
        out.set(name, {
            queryCount,
            errorCount: sumOf(rows.map((r) => num(r.errorCount))),
            avgMs: queryCount > 0 ? Math.round(haveTotalMs ? totalMs / queryCount : sumOf(rows.map((r) => num(r.avgMs) * num(r.queryCount))) / queryCount) : 0,
            p95Ms: sketches.length && sumOf(sketches.map((s) => s.n)) > 0 ? percentileFromSketches(sketches, 0.95) : maxOf(rows.map((r) => num(r.p95Ms))),
            poolUtilization: maxOrNull("poolUtilization"),
            connectionsInUse: sumOrNull("connectionsInUse"),
            connectionsOpen: sumOrNull("connectionsOpen"),
            poolMax: sumOrNull("poolMax"),
            queueLength: sumOrNull("queueLength"),
            capacity: maxOrNull("capacity"),
            healthy: health.length === 0 ? null : health.every(Boolean),
            consecutiveFailures: maxOrNull("consecutiveFailures"),
            unhealthyWorkers: rows.filter((r) => r.healthy === false).length,
        });
    }
    return Object.fromEntries(out);
}

/** Merges per-channel notification stats and rebuilds the smtp block from them. */
function mergeNotifications(snaps) {
    const channels = new Map();
    for (const snap of snaps) {
        if (!isObj(snap.notifications)) continue;
        for (const [channel, e] of Object.entries(snap.notifications)) {
            if (!isObj(e)) continue;
            let acc = channels.get(channel);
            if (!acc) {
                acc = {
                    sent: 0,
                    failed: 0,
                    consecutiveFailures: 0,
                    lastSuccessAt: null,
                    lastFailureAt: null,
                    lastFailureCause: null,
                    suppressedCount: 0,
                };
                channels.set(channel, acc);
            }
            acc.sent += num(e.sent);
            acc.failed += num(e.failed);
            acc.suppressedCount += num(e.suppressedCount);
            acc.consecutiveFailures = Math.max(acc.consecutiveFailures, num(e.consecutiveFailures));
            acc.lastSuccessAt = latestIso(e.lastSuccessAt, acc.lastSuccessAt);
            if (e.lastFailureAt && (!acc.lastFailureAt || e.lastFailureAt > acc.lastFailureAt)) {
                acc.lastFailureAt = e.lastFailureAt;
                acc.lastFailureCause = e.lastFailureCause ?? null;
            }
        }
    }
    let consecutiveFailures = 0;
    let lastSuccessAt = null;
    let lastFailureAt = null;
    for (const e of channels.values()) {
        consecutiveFailures = Math.max(consecutiveFailures, e.consecutiveFailures);
        lastSuccessAt = latestIso(e.lastSuccessAt, lastSuccessAt);
        lastFailureAt = latestIso(e.lastFailureAt, lastFailureAt);
    }
    const status = consecutiveFailures >= 3 ? "down" : consecutiveFailures >= 1 ? "degraded" : "up";
    return {
        notifications: Object.fromEntries(channels),
        smtp: { status, consecutiveFailures, lastSuccessAt, lastFailureAt },
    };
}

/** Combines the frontend FIFOs: sorted by ts, newest 500 kept. */
function mergeFifo(snaps, key) {
    const all = [];
    for (const snap of snaps) {
        if (Array.isArray(snap[key])) all.push(...snap[key].filter(isObj));
    }
    all.sort((a, b) => String(a.ts ?? "").localeCompare(String(b.ts ?? "")));
    return all.slice(-FRONTEND_MERGE_MAX);
}

/** Sums watchdog terminations per route (top 200 routes kept). */
function mergeWatchdog(snaps) {
    const byRoute = new Map();
    let terminated = 0;
    for (const snap of snaps) {
        const w = snap.watchdog;
        if (!isObj(w)) continue;
        terminated += num(w.terminated);
        for (const [route, n] of Object.entries(isObj(w.byRoute) ? w.byRoute : {})) {
            byRoute.set(route, (byRoute.get(route) ?? 0) + num(n));
        }
    }
    const top = [...byRoute].sort((a, b) => b[1] - a[1]).slice(0, WATCHDOG_ROUTES_MERGE_MAX);
    return { terminated, byRoute: Object.fromEntries(top) };
}

/**
 * Merges worker parts into one cluster snapshot.
 *
 * Rules: red counts summed, rates recomputed, p50/p95/p99 from merged sketches
 * (max of the workers' values when no sketch came), avgMs weighted by samples,
 * `window` (last-5-min latency) with count summed, windowMs max and p99 from the
 * merged `routeWindowSketches` (max of the workers' window.p99 when none came;
 * a row without `window` contributes 0);
 * totals summed with successTotal/rates/apdex recomputed; system cpu%, handles,
 * requests and gc counts summed, memory from the worker closest to its heap
 * ceiling, event-loop lag and gc overhead max, memoryTrend from a worker that
 * suspects a leak; oracle volume summed but saturation (utilization, capacity)
 * is the WORST worker's, `healthy` is an AND; notifications summed with smtp
 * rebuilt; frontend FIFOs combined; watchdog summed.
 *
 * @param {Array<{workerId: number, pid?: number|null, isLeader?: boolean, value: {snapshot: object, extras?: object}}>} parts
 * @param {{missing?: number[], expected?: number}} [opts]
 * @returns {object|null} merged snapshot; null when no part is usable
 */
function mergeMetricsSnapshots(parts, { missing = [], expected } = {}) {
    const usable = (Array.isArray(parts) ? parts : []).filter(isUsablePart);
    if (usable.length === 0) return null;
    const skipped = (Array.isArray(parts) ? parts.length : 0) - usable.length;
    const snaps = usable.map((p) => p.value.snapshot);
    const extras = usable.map((p) => (isObj(p.value.extras) ? p.value.extras : {}));

    const system = mergeSystem(usable);
    const { notifications, smtp } = mergeNotifications(snaps);
    const missingIds = [...missing, ...(skipped > 0 ? [`invalid:${skipped}`] : [])];

    return {
        timestamp: new Date().toISOString(),
        uptime: maxOf(snaps.map((s) => num(s.uptime))),
        red: mergeRed(snaps, extras),
        system,
        dependencies: { oracle: mergeOracle(usable), smtp },
        totals: mergeTotals(snaps, extras),
        frontendVitals: mergeFifo(snaps, "frontendVitals"),
        frontendErrors: mergeFifo(snaps, "frontendErrors"),
        notifications,
        watchdog: mergeWatchdog(snaps),
        cluster: {
            workers: expected ?? usable.length + missing.length + skipped,
            responded: usable.length,
            missing: missingIds,
        },
    };
}

module.exports = { QUANTILE_GRID, buildQuantileSketch, percentileFromSketches, mergeMetricsSnapshots };
