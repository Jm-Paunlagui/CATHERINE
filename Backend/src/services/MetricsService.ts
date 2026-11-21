"use strict";

/**
 * @fileoverview Business logic for the metrics domain.
 * Evaluates alert rules against the MetricsStore snapshot and handles
 * frontend metrics ingestion with validation.
 */

const { metricsStore } = require("../middleware/metrics");
const { AppError, METRICS_ERRORS } = require("../constants/errors");
const { logger } = require("../utils/logger");
const { metricsMessages, clusterMessages } = require("../constants/messages");
const { clusterRpc } = require("../utils/cluster/ClusterRpcClient");
const { mergeMetricsSnapshots } = require("../middleware/metrics/metricsMerge");
const { CLUSTER_RPC_METHODS, CLUSTER_RPC_TIMEOUTS, CLUSTER_RPC_LIMITS } = require("../constants/clusterIpc");

/**
 * @constant {number} Server-error rate (5xx-only) that raises a WARNING alert.
 * Tuned for the server-only error rate: 4xx are excluded from the SLI, so a
 * sustained 1% of serviced requests failing with 5xx is already abnormal.
 */
const ERROR_RATE_WARNING_THRESHOLD = 0.01;

/**
 * @constant {number} Server-error rate (5xx-only) that raises a CRITICAL alert.
 * Sustained 5% of serviced requests returning 5xx is an active outage.
 */
const ERROR_RATE_CRITICAL_THRESHOLD = 0.05;

/**
 * @constant {number} Minimum serviced (non-4xx) requests in the 5-minute window
 * before HIGH_ERROR_RATE may fire. Below ~50 one failure already exceeds 1%, so
 * the rate is noise (off-hours traffic); at the floor one isolated 5xx reaches
 * at most 2% (warning) and critical (>5%) needs at least 3 failures. A real
 * low-traffic outage is still caught by ORACLE_POOL_DOWN and the health rules.
 */
const ERROR_RATE_MIN_SAMPLES = 50;

/**
 * @constant {number} Minimum requests inside a route's 5-minute latency window
 * (`red[route].window.count`) before HIGH_LATENCY may fire. `calcPercentile`
 * takes `sorted[floor(n * 0.99)]`, so for n <= 100 the "p99" is simply the
 * maximum: one slow call on a quiet route read as a permanent breach (a single
 * `{ p99: 5198, count: 1 }` sample kept the rule firing). At 20 samples one
 * outlier is 5% of recent traffic, which is no longer a lone fluke. Genuine
 * low-traffic pool starvation is still caught by ORACLE_POOL_QUEUE_BACKLOG.
 */
const LATENCY_MIN_SAMPLES = 20;

/**
 * @constant {number} Heap utilization (heapUsed / heap_size_limit) that raises a
 * WARNING. Measured against the real V8 ceiling, NOT heapTotal — heapTotal is only
 * what V8 has committed so far and naturally sits near 100% by design, so dividing
 * by it produced permanent false "critical" heap alerts.
 */
const HEAP_UTILIZATION_WARNING_THRESHOLD = 0.75;

/**
 * @constant {number} Heap utilization (heapUsed / heap_size_limit) that raises a
 * CRITICAL alert — the process is genuinely approaching OOM at this point.
 */
const HEAP_UTILIZATION_CRITICAL_THRESHOLD = 0.9;

/**
 * @constant {number} GC overhead (% of wall-clock time spent paused in GC over the
 * last poll window) that raises a WARNING. A healthy process sits well under 2%;
 * sustained > 5% means V8 is collecting far more than it should — the signature of
 * a process running too close to its heap ceiling (GC thrashing).
 */
const GC_OVERHEAD_WARNING_THRESHOLD = 5;

/** @constant {number} GC overhead that raises a CRITICAL alert — collection is starving the event loop. */
const GC_OVERHEAD_CRITICAL_THRESHOLD = 10;

/**
 * @constant {number} Oracle pool utilization (connectionsInUse / connectionsOpen)
 * that raises a WARNING. Sustained > 80% means the open connections are nearly all
 * checked out — new queries start queueing and tail latency climbs (USE saturation).
 */
const POOL_SATURATION_WARNING_THRESHOLD = 0.8;

/**
 * @constant {number} Oracle pool utilization that raises a CRITICAL alert — the pool
 * is effectively exhausted (> 95% of open connections in use); requests are blocking
 * on connection acquisition and the dependency is the bottleneck.
 */
const POOL_SATURATION_CRITICAL_THRESHOLD = 0.95;

/**
 * @constant {number} Oracle pool ACQUIRE-QUEUE depth that raises a WARNING.
 *
 * This is the signal `POOL_SATURATION_*` above cannot give. Those thresholds
 * read `connectionsInUse / connectionsOpen`, a ratio of the connections the
 * pool has currently OPENED — not of its ceiling. A pool sitting at `poolMin`
 * with every opened connection busy reads 100% utilized while headroom up to
 * `poolMax` remains unallocated and nothing is waiting; a pool grown to
 * `poolMax` and genuinely thrashing reads about the same. The ratio therefore
 * both false-alarms and under-reports, and neither its firing nor its silence
 * answers "is the pool the bottleneck".
 *
 * `queueLength` answers it directly and unambiguously: a non-zero acquire
 * queue means every open connection is checked out AND callers are blocked
 * waiting for one.
 *
 * Set at 3 rather than 1 deliberately. One or two waiters caught by a 30 s
 * poll is an ordinary burst absorbed in milliseconds; alerting on it would
 * make this rule the thing operators mute, which the `HIGH_LATENCY` threshold
 * note above already warns is worse than having no rule at all. Three or more
 * still waiting AT THE POLL INSTANT means the queue is not draining between
 * bursts — the pool is undersized for its offered load.
 */
const POOL_QUEUE_WARNING_DEPTH = 3;

/**
 * @constant {number} Acquire-queue depth that raises a CRITICAL alert. At this
 * depth requests are stacking toward the pool's `queueTimeout` and the tail is
 * already measured in seconds —
 * callers are being made to wait for a connection, not for work. Queries are
 * not slow; there is nothing to run them on.
 */
const POOL_QUEUE_CRITICAL_DEPTH = 10;

/**
 * @constant {number} Consecutive server-notification send failures (any
 * channel) that escalate the EMAIL_DELIVERY_FAILING rule from warning to
 * critical. SMTP is a monitored dependency —
 * 1 consecutive failure warns, 3 in a row means the relay is down.
 */
const EMAIL_CONSECUTIVE_FAILURE_CRITICAL = 3;

/**
 * @constant {number} Default per-route p99 latency (ms) that raises a WARNING.
 * Compared against the WINDOWED p99 (`red[route].window.p99`, last 5 min), not
 * the lifetime ring. Applies to every interactive request — a read, a form POST, a login. If one
 * of those takes over 5 s at the 99th percentile something is genuinely wrong.
 *
 * Was a bare inline `2000`, which fired constantly on the bulk endpoints below
 * and trained the operator to ignore HIGH_LATENCY entirely — a threshold that
 * cries wolf is worse than no threshold, because it also buries the real ones.
 */
const LATENCY_P99_DEFAULT_THRESHOLD_MS = 5_000;

/**
 * @constant {number} p99 latency (ms) for the BULK routes below. Compared
 * against the windowed p99 (`red[route].window.p99`, last 5 min).
 *
 * These are not slow requests, they are batch jobs behind an HTTP call: an
 * Excel upload verified and saved row by row, or an export streaming a large
 * ledger into a workbook — minutes of normal work, not a fault, and paging on
 * it is noise.
 *
 * Raise it here (one constant) rather than muting the rule when a legitimate
 * batch outgrows it.
 */
const LATENCY_P99_BULK_THRESHOLD_MS = 170_000;

/**
 * @constant {RegExp[]} Route-key patterns that take {@link LATENCY_P99_BULK_THRESHOLD_MS}.
 *
 * Matched against the metrics route key, which is `"METHOD /full/path"` (e.g.
 * `GET /api/v1/audit-logs/export/excel`) — see `MetricsStore.recordRequest`.
 *
 * PATTERNS, not a list of exact paths, deliberately: an exact-path list would
 * silently fall back to the 5 s default the moment a route is renamed or a new
 * bulk endpoint is added — and the failure mode is a false page at 3 a.m., not
 * a missing alert.
 */
const LATENCY_P99_BULK_ROUTE_PATTERNS = [
    /\/save(\/|$)/,
    /\/export(\/|$)/,
];

/**
 * Resolves the p99 latency threshold for one route key.
 *
 * @param {string} route - Metrics route key, `"METHOD /path"`.
 * @returns {number} Threshold in milliseconds.
 */
function latencyThresholdFor(route) {
    const key = String(route ?? "");
    return LATENCY_P99_BULK_ROUTE_PATTERNS.some((re) => re.test(key))
        ? LATENCY_P99_BULK_THRESHOLD_MS
        : LATENCY_P99_DEFAULT_THRESHOLD_MS;
}

class MetricsService {
    /** Shared in-flight/just-finished cluster gather (see getClusterSnapshot). */
    static #clusterShare = null;
    static #lastPartialLogAt = -Infinity;

    // ========================================
    // SNAPSHOT & ALERTS
    // ========================================

    /**
     * Return the full metrics snapshot from the in-process store.
     *
     * @returns {object} Full metrics snapshot (see MetricsStore.getSnapshot)
     * @throws {AppError} 503 if snapshot retrieval fails unexpectedly
     */
    static getSnapshot() {
        try {
            return metricsStore.getSnapshot();
        } catch (err) {
            throw new AppError(METRICS_ERRORS.METRICS_UNAVAILABLE, 503, {
                type: "MetricsError",
                hint: err.message,
            });
        }
    }

    /**
     * Snapshot of the WHOLE service. Single-process: exactly `getSnapshot()` (a
     * sync value, no IPC). Cluster worker: asks every worker for its mergeable
     * snapshot through the primary (one gather, shared by concurrent callers for
     * `METRICS_SHARE_MS`) and merges them; the result carries `cluster:
     * {workers, responded, missing}` and `system.workers`. If the gather fails
     * the local snapshot is returned with `cluster.degraded: true`.
     *
     * @returns {Promise<object>|object} merged snapshot (see MetricsStore.getSnapshot)
     */
    static getClusterSnapshot() {
        if (!clusterRpc.active) return MetricsService.getSnapshot();
        const share = MetricsService.#clusterShare;
        if (share && Date.now() - share.at < CLUSTER_RPC_TIMEOUTS.METRICS_SHARE_MS) return share.promise;
        const promise = MetricsService.#gatherCluster();
        MetricsService.#clusterShare = { at: Date.now(), promise };
        return promise;
    }

    /** Never rejects: degrades to the local snapshot. */
    static async #gatherCluster() {
        try {
            const r = await clusterRpc.call(
                "all",
                CLUSTER_RPC_METHODS.METRICS_SNAPSHOT,
                {},
                { timeoutMs: CLUSTER_RPC_TIMEOUTS.METRICS_CLIENT_MS },
            );
            const missing = Array.isArray(r?.missing) ? r.missing : [];
            const parts = Array.isArray(r?.parts) ? r.parts : [];
            const merged = mergeMetricsSnapshots(parts, { missing, expected: parts.length + missing.length });
            if (!merged) throw new Error("no usable part");
            if (merged.cluster.missing.length > 0) {
                const now = Date.now();
                if (now - MetricsService.#lastPartialLogAt >= CLUSTER_RPC_LIMITS.REJECT_LOG_GAP_MS) {
                    MetricsService.#lastPartialLogAt = now;
                    logger.warning(
                        clusterMessages.CLUSTER_METRICS_PARTIAL(merged.cluster.responded, merged.cluster.workers, merged.cluster.missing),
                        { _noNotify: true },
                    );
                }
            }
            return merged;
        } catch {
            const snap = MetricsService.getSnapshot();
            return { ...snap, cluster: { workers: 1, responded: 1, missing: [], degraded: true } };
        }
    }

    /**
     * Return a concise summary: totals, top-5 slowest routes, and active alert count.
     *
     * @param {object} [snapshot] - Optional pre-fetched snapshot (the controller passes the cluster one)
     * @returns {{ totals: object, topSlowRoutes: Array, alertCount: number, uptime: number }}
     */
    static getSummary(snapshot = null) {
        snapshot = snapshot || MetricsService.getSnapshot();
        const alerts = MetricsService.evaluateAlerts(snapshot);

        // Top 5 routes by p95 latency descending
        const topSlowRoutes = Object.entries(snapshot.red)
            .map(([route, m]) => ({ route, ...m }))
            .sort((a, b) => b.p95 - a.p95)
            .slice(0, 5);

        return {
            uptime: snapshot.uptime,
            totals: snapshot.totals,
            system: {
                heapUsedMb: Math.round(
                    snapshot.system.memory.heapUsed / 1024 / 1024,
                ),
                heapTotalMb: Math.round(
                    snapshot.system.memory.heapTotal / 1024 / 1024,
                ),
                heapLimitMb: Math.round(
                    snapshot.system.memory.heapSizeLimit / 1024 / 1024,
                ),
                eventLoopLag: snapshot.system.eventLoopLag,
            },
            topSlowRoutes,
            alertCount: alerts.length,
        };
    }

    /**
     * Alert keys whose recovery must be HELD (neither counted toward nor reset
     * from the recovery-confirm countdown) because the rule cannot currently be
     * evaluated — not because it genuinely cleared. `evaluateAlerts` omits
     * HIGH_ERROR_RATE when the 5-min window holds fewer than
     * ERROR_RATE_MIN_SAMPLES serviced requests; without a hold, a quiet period
     * would read as "recovered" and fire a false RESOLVED digest.
     *
     * HIGH_LATENCY hysteresis: `evaluateAlerts` skips a route whose 5-min window
     * holds fewer than LATENCY_MIN_SAMPLES requests. While that thin window STILL
     * contains a slow sample (0 < count < floor and window p99 over budget) the
     * alert cannot be evaluated, not cleared, so `HIGH_LATENCY::<route>` is held
     * instead of reading as recovery. Once the slow sample ages out (count 0) the
     * hold is dropped and an idle route resolves normally.
     *
     * Keys use the AlertNotifierService identity format `<rule>::<scope>`.
     *
     * @param {object} [snapshot] - Optional pre-fetched snapshot; fetches fresh if omitted
     * @returns {string[]} Alert keys to hold; `"*"` holds every active key not seen this tick
     */
    static evaluateAlertHolds(snapshot = null) {
        const snap = snapshot || MetricsService.getSnapshot();
        const holds = [];
        const win = snap.totals?.window;
        if (!win || win.serviced < ERROR_RATE_MIN_SAMPLES) {
            holds.push("HIGH_ERROR_RATE::global");
        }
        for (const [route, m] of Object.entries(snap.red ?? {})) {
            const w = m?.window;
            if (
                w &&
                w.count > 0 &&
                w.count < LATENCY_MIN_SAMPLES &&
                w.p99 > latencyThresholdFor(route)
            ) {
                holds.push(`HIGH_LATENCY::${route}`);
            }
        }
        // Cluster: a worker that missed the gather (or a failed gather) means
        // EVERY rule is unevaluable for the workers we did not hear from, so
        // absence from this tick's alerts must not read as recovery.
        if (snap.cluster && (snap.cluster.degraded === true || (snap.cluster.missing?.length ?? 0) > 0)) {
            holds.push("*");
        }
        return holds;
    }

    /**
     * Evaluate all alert rules against a metrics snapshot.
     * Returns an array of triggered alert objects (empty array = all clear).
     *
     * Alert rules:
     *   1. Server-error rate (5xx-only) > 1% warning / > 5% critical, across all routes
     *   2. P99 latency over the last 5 min > per-route budget (5000ms default, 170000ms bulk),
     *      once the window holds LATENCY_MIN_SAMPLES requests
     *   3. Heap usage > 75% (warning) / > 90% (critical) of the V8 heap ceiling
     *   4. Event-loop lag > 100ms
     *   5. GC overhead > 5% (warning) / > 10% (critical) of wall-clock time
     *   6. Memory leak suspected — sustained post-major-GC live-set growth
     *   7. Oracle pool saturation > 80% (warning) / > 95% (critical) utilization, per pool
     *   8. Email notification delivery failing — 1+ consecutive send failure (warning) /
     *      EMAIL_CONSECUTIVE_FAILURE_CRITICAL+ consecutive failures (critical), any channel
     *   9. Oracle pool DOWN — health checks marked the pool unhealthy (critical), per pool
     *  10. Oracle pool DEGRADED — consecutive health-check failures below the unhealthy threshold (warning)
     *  11. Oracle pool acquire-queue backlog >= POOL_QUEUE_WARNING_DEPTH (warning) /
     *      POOL_QUEUE_CRITICAL_DEPTH (critical), per pool
     *
     * LOOP GUARD: every ALERT_TRIGGERED log
     * above carries meta `_noNotify: true` — each alert is already delivered by
     * AlertNotifierService via its mapped channel, so the critical logger tap
     * must never double-email it.
     *
     * Note: the error rate is computed from 5xx responses only — client errors
     * (4xx) are excluded so auth failures, validation rejections, and scanner
     * noise never trip the availability alert (MetricsStore.computeRates). It is
     * read over the last 5 minutes (`totals.window`), not the process lifetime,
     * and only once that window holds ERROR_RATE_MIN_SAMPLES serviced requests.
     *
     * @param {object} [snapshot] - Optional pre-fetched snapshot; fetches fresh if omitted
     * @returns {Array<{ rule: string, severity: string, value: number, route?: string, pool?: string }>}
     */
    static evaluateAlerts(snapshot = null) {
        const snap = snapshot || MetricsService.getSnapshot();
        const alerts = [];

        // Rule 1 — high SERVER-error rate over the last 5 minutes (5xx-only;
        // 4xx excluded). A snapshot without `totals.window` never fires it.
        const win = snap.totals?.window;
        const errorRate = win?.errorRate ?? 0;
        if (
            win &&
            win.serviced >= ERROR_RATE_MIN_SAMPLES &&
            errorRate > ERROR_RATE_WARNING_THRESHOLD
        ) {
            const isCritical = errorRate > ERROR_RATE_CRITICAL_THRESHOLD;
            const severity = isCritical ? "critical" : "warning";
            const threshold = isCritical
                ? ERROR_RATE_CRITICAL_THRESHOLD
                : ERROR_RATE_WARNING_THRESHOLD;
            alerts.push({
                rule: "HIGH_ERROR_RATE",
                severity,
                value: errorRate,
                description: `Server-error rate over the last ${Math.round(win.windowMs / 60000)} min is ${(errorRate * 100).toFixed(2)}% (${win.serverErrors} of ${win.serviced} serviced requests; threshold: ${(threshold * 100).toFixed(0)}%, 5xx only)`,
            });
            logger[isCritical ? "critical" : "warning"](
                metricsMessages.ALERT_TRIGGERED("HIGH_ERROR_RATE", severity),
                {
                    errorRate,
                    windowServerErrors: win.serverErrors,
                    windowServiced: win.serviced,
                    serverErrorsTotal: snap.totals.serverErrorsTotal,
                    // Double-notify guard: this alert is already
                    // delivered via its mapped channel by AlertNotifierService's metrics
                    // poll — the critical logger tap must not double-notify it.
                    _noNotify: true,
                },
            );
        }

        // Rule 2 — per-route p99 latency spike, read over the last 5 minutes
        // (`window`), never the lifetime ring: a lifetime p99 keeps one slow call
        // as the p99 forever and the alert could never recover.
        for (const [route, m] of Object.entries(snap.red)) {
            const w = m?.window;
            if (!w || w.count < LATENCY_MIN_SAMPLES) continue;
            // Per-route threshold — a bulk upload/issuance/export is measured
            // against its own budget, not an interactive request's. The
            // threshold is reported in the description so the operator reads
            // WHICH budget was breached, never a single global number that
            // contradicts what actually fired.
            const latencyThreshold = latencyThresholdFor(route);
            if (w.p99 > latencyThreshold) {
                alerts.push({
                    rule: "HIGH_LATENCY",
                    severity: "warning",
                    route,
                    value: w.p99,
                    description: `P99 latency for ${route} over the last ${Math.round(w.windowMs / 60000)} min is ${w.p99}ms across ${w.count} requests (threshold: ${latencyThreshold}ms)`,
                });
                logger.warning(
                    metricsMessages.ALERT_TRIGGERED("HIGH_LATENCY", "warning"),
                    {
                        route,
                        p99: w.p99,
                        windowCount: w.count,
                        windowMs: w.windowMs,
                        threshold: latencyThreshold,
                        _noNotify: true, // R2 — already delivered via its mapped channel
                    },
                );
            }
        }

        // Rule 3 — heap pressure (measured against the real V8 ceiling, not heapTotal)
        const heapLimit = snap.system.memory.heapSizeLimit;
        const heapUtilization =
            heapLimit > 0 ? snap.system.memory.heapUsed / heapLimit : 0;
        if (heapUtilization > HEAP_UTILIZATION_WARNING_THRESHOLD) {
            const isCritical =
                heapUtilization > HEAP_UTILIZATION_CRITICAL_THRESHOLD;
            const severity = isCritical ? "critical" : "warning";
            const threshold = isCritical
                ? HEAP_UTILIZATION_CRITICAL_THRESHOLD
                : HEAP_UTILIZATION_WARNING_THRESHOLD;
            alerts.push({
                rule: "HIGH_HEAP",
                severity,
                value: heapUtilization,
                description: `Heap usage is ${(heapUtilization * 100).toFixed(1)}% of the V8 limit (threshold: ${(threshold * 100).toFixed(0)}%)`,
            });
            logger[isCritical ? "critical" : "warning"](
                metricsMessages.ALERT_TRIGGERED("HIGH_HEAP", severity),
                {
                    heapUtilization,
                    heapUsedMb: Math.round(
                        snap.system.memory.heapUsed / 1024 / 1024,
                    ),
                    heapLimitMb: Math.round(heapLimit / 1024 / 1024),
                    _noNotify: true, // R2 — already delivered via its mapped channel
                },
            );
        }

        // Rule 4 — event-loop lag
        if (snap.system.eventLoopLag > 100) {
            alerts.push({
                rule: "EVENT_LOOP_LAG",
                severity: "warning",
                value: snap.system.eventLoopLag,
                description: `Event-loop lag is ${snap.system.eventLoopLag}ms (threshold: 100ms)`,
            });
            logger.warning(
                metricsMessages.ALERT_TRIGGERED("EVENT_LOOP_LAG", "warning"),
                {
                    lagMs: snap.system.eventLoopLag,
                    _noNotify: true, // R2 — already delivered via its mapped channel
                },
            );
        }

        // Rule 5 — GC overhead (process spending too much time collecting)
        const gcOverhead = snap.system.gc?.overheadPct ?? 0;
        if (gcOverhead > GC_OVERHEAD_WARNING_THRESHOLD) {
            const isCritical = gcOverhead > GC_OVERHEAD_CRITICAL_THRESHOLD;
            const severity = isCritical ? "critical" : "warning";
            const threshold = isCritical
                ? GC_OVERHEAD_CRITICAL_THRESHOLD
                : GC_OVERHEAD_WARNING_THRESHOLD;
            alerts.push({
                rule: "HIGH_GC_OVERHEAD",
                severity,
                value: gcOverhead,
                description: `GC overhead is ${gcOverhead}% of wall-clock time (threshold: ${threshold}%)`,
            });
            logger[isCritical ? "critical" : "warning"](
                metricsMessages.ALERT_TRIGGERED("HIGH_GC_OVERHEAD", severity),
                {
                    overheadPct: gcOverhead,
                    majorCollections: snap.system.gc?.major?.count,
                    _noNotify: true, // R2 — already delivered via its mapped channel
                },
            );
        }

        // Rule 6 — suspected memory leak (sustained post-major-GC live-set growth)
        const trend = snap.system.memoryTrend;
        if (trend?.suspected) {
            const mbPerMin = (trend.growthBytesPerMin / (1024 * 1024)).toFixed(
                2,
            );
            const windowMin = Math.round(trend.windowMs / 60_000);
            alerts.push({
                rule: "MEMORY_LEAK_SUSPECTED",
                severity: "warning",
                value: trend.growthBytesPerMin,
                description: `Post-GC heap is climbing ~${mbPerMin} MB/min over ${windowMin} min across ${trend.sampleCount} major-GC baselines — investigate for a leak`,
            });
            logger.warning(
                metricsMessages.ALERT_TRIGGERED(
                    "MEMORY_LEAK_SUSPECTED",
                    "warning",
                ),
                {
                    growthBytesPerMin: trend.growthBytesPerMin,
                    windowMs: trend.windowMs,
                    firstHeapUsedMb: Math.round(trend.firstHeapUsed / 1024 / 1024),
                    lastHeapUsedMb: Math.round(trend.lastHeapUsed / 1024 / 1024),
                    _noNotify: true, // R2 — already delivered via its mapped channel
                },
            );
        }

        // Rule 7 — Oracle connection-pool saturation (USE method). poolUtilization
        // is null until the adapter's health poll first reports, so guard the type.
        const oracleDeps = snap.dependencies?.oracle ?? {};
        for (const [poolName, dep] of Object.entries(oracleDeps)) {
            const util = dep.poolUtilization;
            if (typeof util !== "number" || util <= POOL_SATURATION_WARNING_THRESHOLD) {
                continue;
            }
            const isCritical = util > POOL_SATURATION_CRITICAL_THRESHOLD;
            const severity = isCritical ? "critical" : "warning";
            const threshold = isCritical
                ? POOL_SATURATION_CRITICAL_THRESHOLD
                : POOL_SATURATION_WARNING_THRESHOLD;
            alerts.push({
                rule: "ORACLE_POOL_SATURATION",
                severity,
                pool: poolName,
                value: util,
                description: `Oracle pool "${poolName}" is ${(util * 100).toFixed(1)}% utilized (${dep.connectionsInUse}/${dep.connectionsOpen} connections in use, threshold: ${(threshold * 100).toFixed(0)}%)`,
            });
            logger[isCritical ? "critical" : "warning"](
                metricsMessages.ALERT_TRIGGERED("ORACLE_POOL_SATURATION", severity),
                {
                    poolName,
                    utilization: util,
                    connectionsInUse: dep.connectionsInUse,
                    connectionsOpen: dep.connectionsOpen,
                    queueLength: dep.queueLength,
                    _noNotify: true, // R2 — already delivered via its mapped channel
                },
            );
        }

        // Rule 11 — Oracle pool ACQUIRE-QUEUE backlog (USE saturation, the
        // direct form). Rule 7 above measures inUse/open, a ratio of the
        // connections the pool happens to have opened; this measures how many
        // callers are BLOCKED waiting for one. A non-zero queue is the only
        // unambiguous "the pool is the bottleneck" signal the adapter exposes,
        // and nothing alerted on it before — it was recorded by
        // MetricsStore.recordPoolStats and rendered on the Dependencies tab,
        // but reaching it required a human to go and look while the load was
        // still happening. Scoped per pool (`pool` feeds the ack key, exactly
        // as Rules 7/9/10 do), so a queueing `appDb` is acknowledged
        // independently of a healthy `appDbBulk`.
        for (const [poolName, dep] of Object.entries(oracleDeps)) {
            const queued = dep.queueLength;
            if (typeof queued !== "number" || queued < POOL_QUEUE_WARNING_DEPTH) {
                continue;
            }
            const isCritical = queued >= POOL_QUEUE_CRITICAL_DEPTH;
            const severity = isCritical ? "critical" : "warning";
            const threshold = isCritical
                ? POOL_QUEUE_CRITICAL_DEPTH
                : POOL_QUEUE_WARNING_DEPTH;
            alerts.push({
                rule: "ORACLE_POOL_QUEUE_BACKLOG",
                severity,
                pool: poolName,
                value: queued,
                description: `Oracle pool "${poolName}" has ${queued} request(s) waiting for a connection (threshold: ${threshold}); ${dep.connectionsInUse}/${dep.connectionsOpen} open connections in use, poolMax ${dep.poolMax}`,
            });
            logger[isCritical ? "critical" : "warning"](
                metricsMessages.ALERT_TRIGGERED(
                    "ORACLE_POOL_QUEUE_BACKLOG",
                    severity,
                ),
                {
                    poolName,
                    queueLength: queued,
                    connectionsInUse: dep.connectionsInUse,
                    connectionsOpen: dep.connectionsOpen,
                    poolMax: dep.poolMax,
                    _noNotify: true, // R2 — already delivered via its mapped channel
                },
            );
        }

        // Rules 9 & 10 — Oracle pool OUTAGE (O5), distinct from Rule 7's saturation.
        // These read the health signal fed from the adapter's health poll (both
        // success and catch paths). They are mutually exclusive per pool:
        //   Rule 9  DOWN     — healthy === false (pool marked unhealthy)
        //   Rule 10 DEGRADED — consecutiveFailures > 0 && healthy === true
        //                      (failing but below the unhealthy threshold)
        // healthy === null means the pool has never reported → fires neither.
        for (const [poolName, dep] of Object.entries(oracleDeps)) {
            if (dep.healthy === false) {
                alerts.push({
                    rule: "ORACLE_POOL_DOWN",
                    severity: "critical",
                    pool: poolName,
                    value: dep.consecutiveFailures ?? 0,
                    description: `Oracle pool "${poolName}" is DOWN — health checks have failed ${dep.consecutiveFailures ?? 0} consecutive time(s); the pool is marked unhealthy`,
                });
                logger.critical(
                    metricsMessages.ALERT_TRIGGERED(
                        "ORACLE_POOL_DOWN",
                        "critical",
                    ),
                    {
                        poolName,
                        consecutiveFailures: dep.consecutiveFailures,
                        _noNotify: true, // R2 — already delivered via its mapped channel
                    },
                );
            } else if (
                typeof dep.consecutiveFailures === "number" &&
                dep.consecutiveFailures > 0 &&
                dep.healthy === true
            ) {
                alerts.push({
                    rule: "ORACLE_POOL_DEGRADED",
                    severity: "warning",
                    pool: poolName,
                    value: dep.consecutiveFailures,
                    description: `Oracle pool "${poolName}" is DEGRADED — ${dep.consecutiveFailures} consecutive health-check failure(s), below the unhealthy threshold`,
                });
                logger.warning(
                    metricsMessages.ALERT_TRIGGERED(
                        "ORACLE_POOL_DEGRADED",
                        "warning",
                    ),
                    {
                        poolName,
                        consecutiveFailures: dep.consecutiveFailures,
                        _noNotify: true, // R2 — already delivered via its mapped channel
                    },
                );
            }
        }

        // Rule 8 — server email notification delivery failing (SMTP dependency, R7).
        // Warns at 1 consecutive failure across any channel, escalates to critical
        // at EMAIL_CONSECUTIVE_FAILURE_CRITICAL. Maps to the dependencies channel.
        const smtp = snap.dependencies?.smtp;
        if (smtp && smtp.consecutiveFailures >= 1) {
            const isCritical = smtp.consecutiveFailures >= EMAIL_CONSECUTIVE_FAILURE_CRITICAL;
            const severity = isCritical ? "critical" : "warning";
            alerts.push({
                rule: "EMAIL_DELIVERY_FAILING",
                severity,
                value: smtp.consecutiveFailures,
                description: `Server email notification delivery has failed ${smtp.consecutiveFailures} time(s) in a row (threshold: ${isCritical ? EMAIL_CONSECUTIVE_FAILURE_CRITICAL : 1}) — last failure: ${smtp.lastFailureAt ?? "unknown"}`,
            });
            logger[isCritical ? "critical" : "warning"](
                metricsMessages.ALERT_TRIGGERED("EMAIL_DELIVERY_FAILING", severity),
                {
                    consecutiveFailures: smtp.consecutiveFailures,
                    lastFailureAt: smtp.lastFailureAt,
                    _noNotify: true, // R2 — already delivered via its mapped channel
                },
            );
        }

        return alerts;
    }

    // ========================================
    // FRONTEND METRICS INGESTION
    // ========================================

    /**
     * Validate and store an array of frontend metric events (vitals + errors).
     *
     * Validation rules:
     *   - payload must be an array
     *   - payload must be non-empty
     *   - payload may not exceed 50 items per request
     *   - each item must have a "type" field: "vital" | "error"
     *
     * @param {Array} payload - Array of frontend metric events from the client
     * @throws {AppError} 400 on validation failure
     */
    static async ingestFrontendMetrics(payload) {
        if (!Array.isArray(payload)) {
            throw new AppError(METRICS_ERRORS.INVALID_PAYLOAD, 400, {
                type: "ValidationError",
                hint: "Send a JSON array of metric events in the request body.",
            });
        }

        if (payload.length === 0) {
            throw new AppError(METRICS_ERRORS.INVALID_PAYLOAD, 400, {
                type: "ValidationError",
                hint: "The payload array must contain at least one event.",
            });
        }

        if (payload.length > 50) {
            throw new AppError(METRICS_ERRORS.PAYLOAD_TOO_LARGE, 400, {
                type: "ValidationError",
                hint: "Split into batches of at most 50 events per request.",
            });
        }

        let vitalCount = 0;
        let errorCount = 0;

        for (const event of payload) {
            if (!event || typeof event !== "object") continue;

            if (event.type === "vital") {
                metricsStore.recordFrontendVital(
                    String(event.name || "UNKNOWN").slice(0, 200),
                    Number(event.value) || 0,
                    String(event.rating || "unknown"),
                    event.context || {},
                );
                vitalCount++;
                logger.debug(metricsMessages.FRONTEND_INGESTED(1), {
                    eventType: "vital",
                    name: event.name,
                    rating: event.rating,
                });
            } else if (event.type === "error") {
                metricsStore.recordFrontendError(
                    String(event.message || "").slice(0, 500),
                    String(event.stack || "").slice(0, 2000),
                    event.context || {},
                );
                errorCount++;
                logger.notice(metricsMessages.FRONTEND_INGESTED(1), {
                    eventType: "error",
                    message: String(event.message || "").slice(0, 200),
                });
            }
        }

        logger.info(metricsMessages.FRONTEND_INGESTED(payload.length), {
            vitalCount,
            errorCount,
        });
    }
}

module.exports = MetricsService;
