"use strict";

/**
 * @fileoverview In-process metrics store — RED (Rate, Errors, Duration) + system metrics.
 *
 * WHAT THIS FILE DOES
 *   Collects all in-process observability metrics without any external dependency.
 *   Exposes a getSnapshot() method that returns a fully structured metrics payload
 *   consumed by MetricsController → GET /api/v1/metrics.
 *
 * HOW IT WORKS
 *   - Per-route ring buffers (max 1000 durations) for accurate p50/p95/p99 percentiles.
 *   - A parallel per-route timestamp ring feeds `red[route].window` (p99 over the
 *     last LATENCY_WINDOW_MS) - the value the HIGH_LATENCY alert reads.
 *   - System metrics polled every 10 s via setInterval (CPU, memory, handles, requests).
 *   - Event-loop lag measured via recurring setImmediate probe.
 *   - GC stats collected via perf_hooks PerformanceObserver when available.
 *   - Frontend vitals stored in a capped FIFO array (max 500 entries).
 *   - Oracle query stats tracked per pool name.
 *   - All public mutators are synchronous and non-blocking.
 *
 * EXAMPLE
 *   const { metricsStore } = require('./MetricsStore');
 *   metricsStore.recordRequest('GET /api/v1/health', 'GET', 200, 12);
 *   const snapshot = metricsStore.getSnapshot();
 */

const { PerformanceObserver } = require("perf_hooks");
const v8 = require("node:v8");
const os = require("node:os");

/**
 * @constant {number} Logical CPU count, read once at module load. Used to
 * normalise the process CPU-time delta into a system-wide CPU-usage percentage
 * (a single saturated core on an 8-core box is 12.5%, not 100%).
 */
const CPU_COUNT = Math.max(1, os.cpus()?.length ?? 1);

/**
 * @constant {number} The hard V8 old-space ceiling for this process, in bytes.
 * This is the real limit heapUsed is measured against — NOT heapTotal, which is
 * only the amount V8 has committed so far and grows on demand up to this value.
 * Constant for the process lifetime (governed by --max-old-space-size), so it is
 * read once at module load rather than on every poll.
 */
const HEAP_SIZE_LIMIT = v8.getHeapStatistics().heap_size_limit;

/** @constant {number} Maximum number of duration samples per route for percentile calc */
const RING_BUFFER_SIZE = 1000;

/** @constant {number} Maximum frontend vital events retained in memory */
const FRONTEND_VITALS_MAX = 500;

/** @constant {number} System metrics polling interval in milliseconds */
const SYSTEM_POLL_INTERVAL_MS = 10_000;

/**
 * @constant {object} V8 GC kind codes from perf_hooks `entry.detail.kind`.
 * Used to bucket GC events: minor (scavenge) churn is cheap and expected;
 * major (mark-sweep-compact) collections are what reclaim the long-lived
 * set, so the heapUsed reading immediately after a MAJOR is the true
 * "live set" baseline used for leak detection.
 */
const GC_KIND = Object.freeze({
  MINOR: 1, // Scavenge — young generation, frequent, cheap
  MAJOR: 4, // Mark-Sweep-Compact — old generation, reclaims live set
  INCREMENTAL: 8, // Incremental marking step
  WEAKCB: 16, // Weak callback processing
});

/**
 * @constant {number} Max post-major-GC heap baselines retained for the leak trend.
 * One sample per major GC; 120 samples is a long observation window since major
 * GCs are infrequent in a healthy process.
 */
const HEAP_BASELINE_MAX = 120;

/** @constant {number} Max recent GC pause samples retained for recent avg/max/p95. */
const GC_PAUSE_SAMPLE_MAX = 200;

/**
 * @constant {number} Lowest HTTP status treated as a REDIRECT (3xx).
 * Redirects are successful responses for availability purposes, but tracked
 * as their own class so the traffic dashboard can show them separately from
 * 2xx success (matching the audit-log STATUS_CATEGORY breakdown).
 */
const REDIRECT_MIN_STATUS = 300;

/**
 * @constant {number} HTTP 304 Not Modified. Tracked as its own class, separate
 * from real redirects (301/302/307/308): a 304 is a successful cache
 * revalidation (the client already holds the body), not a navigation redirect.
 * Conditional GETs with a matching ETag dominate a polling dashboard's own
 * traffic, so folding them into "Redirect" is misleading on the traffic chart.
 */
const NOT_MODIFIED_STATUS = 304;

/**
 * @constant {number} Lowest HTTP status treated as a CLIENT error (4xx).
 * Client errors mean the service correctly rejected bad input — they are
 * EXCLUDED from the availability and (server) error-rate computations.
 */
const CLIENT_ERROR_MIN_STATUS = 400;

/**
 * @constant {number} Lowest HTTP status treated as a SERVER error (5xx).
 * Server errors are the only failures that count against availability.
 */
const SERVER_ERROR_MIN_STATUS = 500;

/**
 * Rolling window the HIGH_ERROR_RATE alert reads (`totals.window`). Lifetime
 * totals stay for the dashboard tiles; the alert must reflect CURRENT traffic,
 * or a burst at boot keeps it firing and long uptime dilutes a late incident.
 */
const ERROR_WINDOW_MS = 300_000;

/**
 * Rolling window the HIGH_LATENCY alert reads (`red[route].window`). The lifetime
 * duration ring has no timestamps, so one slow call on a quiet route stayed that
 * route's p99 forever and the alert never recovered. Same width as the error window.
 */
const LATENCY_WINDOW_MS = ERROR_WINDOW_MS;

/** Bucket width of that window — 30 buckets, so memory is O(1). */
const ERROR_WINDOW_BUCKET_MS = 10_000;

/** Number of buckets that make up the window. */
const ERROR_WINDOW_BUCKETS = ERROR_WINDOW_MS / ERROR_WINDOW_BUCKET_MS;

/**
 * @constant {number} Apdex target threshold T, in milliseconds.
 * Requests ≤ T are "satisfied", ≤ 4T are "tolerating", > 4T are "frustrated".
 * Apdex = (satisfied + tolerating/2) / total. 500ms is the conventional default
 * T for an interactive API. Apdex is computed over the per-route duration ring
 * buffers, so it reflects the most recent ~1000 samples per route.
 */
const APDEX_THRESHOLD_MS = 500;

// ─── Percentile helper ────────────────────────────────────────────────────────

/**
 * Calculate a percentile value from a sorted array of numbers.
 * @param {number[]} sorted - Ascending-sorted array of numbers
 * @param {number}   pct    - Percentile 0–1 (e.g. 0.95 for p95)
 * @returns {number}
 */
function calcPercentile(sorted, pct) {
  if (!sorted.length) return 0;
  const idx = Math.floor(sorted.length * pct);
  return sorted[Math.min(idx, sorted.length - 1)];
}

// ─── Linear-regression slope helper (leak trend) ────────────────────────────────

/**
 * Least-squares slope of y over x. Used to turn a series of post-major-GC heap
 * baselines into a growth rate: a sustained positive slope of the *post-GC*
 * live set is the canonical memory-leak signature (GC runs but can't reclaim).
 *
 * @param {number[]} xs - Independent values (timestamps, ms)
 * @param {number[]} ys - Dependent values (heapUsed bytes)
 * @returns {number} Slope in y-units per x-unit (bytes per ms); 0 if undeterminable
 */
function linRegSlope(xs, ys) {
  const n = xs.length;
  if (n < 2) return 0;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
    sxx += xs[i] * xs[i];
    sxy += xs[i] * ys[i];
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return 0;
  return (n * sxy - sx * sy) / denom;
}

// ─── RED rate helper ──────────────────────────────────────────────────────────

/**
 * Derive availability and error rates from raw request buckets.
 *
 * Definitions (request-based SLI, Google SRE convention):
 *   serviced       = total − clientErrors   (4xx excluded from the denominator)
 *   availability   = (serviced − serverErrors) / serviced   → 1 - errorRate
 *   errorRate      = serverErrors / serviced                (server-only)
 *   clientErrorRate= clientErrors / total                   (visibility lane)
 *
 * Client errors (4xx) are deliberately excluded from availability and errorRate:
 * a 400/401/403/404/422 means the service did its job by rejecting bad input.
 * They are still reported via clientErrorRate so 4xx storms (auth failures,
 * broken validation, scanner noise) stay visible without polluting the SLI.
 *
 * @param {number} total        - Total requests observed
 * @param {number} clientErrors - Count of 4xx responses
 * @param {number} serverErrors - Count of 5xx responses
 * @returns {{ availability: number, errorRate: number, clientErrorRate: number }}
 */
function computeRates(total, clientErrors, serverErrors) {
  const serviced = total - clientErrors; // 2xx/3xx + 5xx
  return {
    // No serviced requests → nothing failed → fully available by definition.
    availability: serviced > 0 ? (serviced - serverErrors) / serviced : 1,
    errorRate: serviced > 0 ? serverErrors / serviced : 0,
    clientErrorRate: total > 0 ? clientErrors / total : 0,
  };
}

// ─── MetricsStore class ───────────────────────────────────────────────────────

/**
 * Whether the self-rescheduling background probes run by default.
 *
 * Two of this class's probes re-arm themselves forever: the 10 s system poller
 * (`setInterval`) and the 1 s event-loop-lag probe (a `setImmediate` inside a
 * `setTimeout` that schedules the next `setTimeout`). Both are unref'd, which
 * is enough for process exit but is NOT enough under a test runner:
 *
 *   - A suite that installs fake timers adopts the pending probe timer. Running
 *     the queue re-arms it every tick, so the runner gives up with
 *     "Aborting after running 10000 timers, assuming an infinite loop!"
 *     (test/server/unit/utils/retryPolicy.test.js).
 *   - A suite that counts `setImmediate` calls to prove it scheduled no
 *     fire-and-forget work sees the probe's own `setImmediate` and reports a
 *     leak that is not there.
 *
 * The probes measure the HOST process, which under Vitest is a worker running
 * arbitrary suites — the numbers are meaningless there even when they do not
 * break anything. So they are off under a test runner and on everywhere else.
 * A test that wants them passes `new MetricsStore({ backgroundProbes: true })`.
 *
 * The one-shot system collection at construction is NOT gated: `getSnapshot()`
 * must return real memory/CPU figures on its first call, which several suites
 * assert on directly.
 */
const BACKGROUND_PROBES_DEFAULT = !(
  process.env.VITEST || process.env.NODE_ENV === "test"
);

/** Max distinct route labels kept in the watchdog termination breakdown. */
const WATCHDOG_ROUTES_MAX = 200;

class MetricsStore {
  /**
   * @param {object} [options]
   * @param {boolean} [options.backgroundProbes] - Run the recurring system
   *   poller and event-loop-lag probe. Defaults to false under a test runner
   *   (see BACKGROUND_PROBES_DEFAULT), true otherwise.
   */
  constructor(options = {}) {
    /**
     * Per-route RED data.
     * Key: "<METHOD> <path>" e.g. "GET /api/v1/health"
     * Value: { count, clientErrorCount, serverErrorCount, durations, timestamps }.
     * `timestamps` (epoch ms) is parallel to `durations`: same cap, pushed and
     * evicted in lockstep, so timestamps[i] is when durations[i] completed.
     * @type {Map<string, { count: number, clientErrorCount: number, serverErrorCount: number, durations: number[], timestamps: number[] }>}
     */
    this._routes = new Map();

    /** Total request counter (all routes combined) */
    this._requestsTotal = 0;

    /** Total REDIRECT counter (3xx excluding 304) — real navigation redirects */
    this._redirectsTotal = 0;

    /** Total 304 NOT MODIFIED counter — successful cache revalidations */
    this._notModifiedTotal = 0;

    /** Total CLIENT error counter (4xx) — excluded from availability/errorRate */
    this._clientErrorsTotal = 0;

    /** Total SERVER error counter (5xx) — the only failures that count against availability */
    this._serverErrorsTotal = 0;

    /**
     * Rolling error window: bucket index (epoch / ERROR_WINDOW_BUCKET_MS) →
     * request / 4xx / 5xx counts. At most ERROR_WINDOW_BUCKETS + 1 entries.
     * @type {Map<number, {total: number, client: number, server: number}>}
     */
    this._errorWindow = new Map();

    /**
     * Oracle pool stats.
     * Key: poolName, Value: { queryCount, errorCount, totalMs, durations: number[] }
     * @type {Map<string, { queryCount: number, errorCount: number, totalMs: number, durations: number[] }>}
     */
    this._oracle = new Map();

    /**
     * Live Oracle connection-pool saturation stats (USE method).
     * Key: poolName, Value: { connectionsInUse, connectionsOpen, poolMax,
     * queueLength, utilization (0–1), capacity (0–1), updatedAt }.
     * Pushed by the Oracle adapter's PoolHealthMonitor on its 30 s poll —
     * distinct from `_oracle` (per-query timings) which is fed by recordDbQuery.
     * @type {Map<string, { connectionsInUse: number, connectionsOpen: number, poolMax: number, queueLength: number, utilization: number, capacity: number, updatedAt: string }>}
     */
    this._oraclePoolStats = new Map();

    /**
     * Server email notification delivery stats, per channel (R7 — SMTP is a
     * monitored dependency, not just a notification pipe).
     * Key: channel name (e.g. "server-system-notification")
     * Value: { sent, failed, consecutiveFailures, lastSuccessAt, lastFailureAt,
     *          lastFailureCause, suppressedCount }
     * @type {Map<string, { sent: number, failed: number, consecutiveFailures: number, lastSuccessAt: string|null, lastFailureAt: string|null, lastFailureCause: string|null, suppressedCount: number }>}
     */
    this._notifications = new Map();

    /**
     * Request-watchdog terminations (B-D9): total, and per bounded route label
     * (capped at WATCHDOG_ROUTES_MAX so a stream of distinct labels cannot grow
     * memory — CWE-400).
     * @type {{ terminated: number, byRoute: Map<string, number> }}
     */
    this._watchdog = { terminated: 0, byRoute: new Map() };

    /**
     * Frontend vitals FIFO (max FRONTEND_VITALS_MAX entries).
     * @type {Array<{ name: string, value: number, rating: string, context: object, ts: string }>}
     */
    this._frontendVitals = [];

    /**
     * Frontend errors FIFO (max FRONTEND_VITALS_MAX entries).
     * @type {Array<{ message: string, stack: string, context: object, ts: string }>}
     */
    this._frontendErrors = [];

    /** Last captured system metrics (refreshed every 10 s) */
    this._system = {
      cpu: { user: 0, system: 0, percent: 0 },
      memory: { heapUsed: 0, heapTotal: 0, heapSizeLimit: HEAP_SIZE_LIMIT, rss: 0, external: 0, arrayBuffers: 0 },
      eventLoopLag: 0,
      gc: {
        collections: 0, // lifetime total across all kinds (back-compat)
        pauseMs: 0, // lifetime total pause across all kinds (back-compat)
        // Per-kind breakdown — minor churn is healthy; rising majors/overhead is not
        major: { count: 0, pauseMs: 0 },
        minor: { count: 0, pauseMs: 0 },
        incremental: { count: 0, pauseMs: 0 },
        weakcb: { count: 0, pauseMs: 0 },
        overheadPct: 0, // % of wall-clock time spent paused in GC over the last poll window
      },
      handles: 0,
      requests: 0,
    };

    /**
     * Post-major-GC heap baselines for leak detection.
     * Each entry is the live set immediately after a major (mark-sweep) GC, when
     * everything reclaimable has been reclaimed. A sustained upward slope here is
     * the defining signature of a memory leak. Capped at HEAP_BASELINE_MAX.
     * @type {Array<{ ts: number, heapUsed: number }>}
     */
    this._heapBaselines = [];

    /** Recent GC pause durations (ms) for recent avg/max/p95. Capped at GC_PAUSE_SAMPLE_MAX. */
    this._gcPauses = [];

    /** Running lifetime GC pause total at the previous poll — for overhead delta. */
    this._prevGcPauseMs = 0;

    /** Previous cpuUsage snapshot for delta calculation */
    this._prevCpuUsage = process.cpuUsage();

    /** Whether this instance runs the recurring background probes. */
    this._backgroundProbes = options.backgroundProbes ?? BACKGROUND_PROBES_DEFAULT;

    // Always collect once, probes or not — the first getSnapshot() must carry
    // real numbers rather than the zeroed initial shape.
    this.#collectSystemMetrics();

    if (this._backgroundProbes) {
      this.#startSystemPoller();
      this.#startEventLoopProbe();
    }
    // The GC observer schedules nothing of its own — it only receives
    // perf_hooks entries — so it stays on in every environment.
    this.#startGcObserver();
  }

  // ========================================
  // PRIVATE BACKGROUND PROBES
  // ========================================

  /**
   * Poll system metrics every SYSTEM_POLL_INTERVAL_MS milliseconds.
   * Unref'd so it does not prevent process exit.
   */
  #startSystemPoller() {
    const interval = setInterval(() => {
      this.#collectSystemMetrics();
    }, SYSTEM_POLL_INTERVAL_MS);

    if (typeof interval.unref === "function") interval.unref();
  }

  /**
   * Collect a fresh system metrics snapshot.
   * Called every 10 s and once at construction.
   */
  #collectSystemMetrics() {
    try {
      const mem = process.memoryUsage();
      this._system.memory = {
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal, // committed so far (grows on demand) — not a ceiling
        heapSizeLimit: HEAP_SIZE_LIMIT, // the real ceiling heapUsed is measured against
        rss: mem.rss,
        external: mem.external,
        arrayBuffers: mem.arrayBuffers ?? 0,
      };

      // Delta CPU usage since last poll
      const currentCpu = process.cpuUsage(this._prevCpuUsage);
      this._prevCpuUsage = process.cpuUsage();
      const userMs = currentCpu.user / 1000; // microseconds → ms
      const systemMs = currentCpu.system / 1000;
      // CPU% = process CPU-time used this window ÷ (wall-clock window × cores).
      // Normalised across logical cores so the figure is system-wide utilisation.
      const cpuPercent = Number(
        (((userMs + systemMs) / (SYSTEM_POLL_INTERVAL_MS * CPU_COUNT)) * 100).toFixed(2),
      );
      this._system.cpu = {
        user: Math.round(userMs),
        system: Math.round(systemMs),
        percent: cpuPercent,
      };

      // Active handles and requests (internal V8 metrics)
      this._system.handles =
        typeof process._getActiveHandles === "function"
          ? process._getActiveHandles().length
          : -1;
      this._system.requests =
        typeof process._getActiveRequests === "function"
          ? process._getActiveRequests().length
          : -1;

      // GC overhead — fraction of this poll window spent paused in GC.
      // > ~5% sustained means the process is spending real time collecting
      // instead of serving (GC thrashing), the classic under-memory symptom.
      const gcPauseDelta = this._system.gc.pauseMs - this._prevGcPauseMs;
      this._prevGcPauseMs = this._system.gc.pauseMs;
      this._system.gc.overheadPct = Number(
        ((gcPauseDelta / SYSTEM_POLL_INTERVAL_MS) * 100).toFixed(2),
      );
    } catch {
      // Non-fatal — metrics may be unavailable in constrained environments
    }
  }

  /**
   * Probe event-loop lag with a recurring setImmediate delta.
   * Measures time between scheduling and execution of setImmediate callbacks.
   * Unref'd so it does not prevent process exit.
   */
  #startEventLoopProbe() {
    const probe = () => {
      const before = Date.now();
      setImmediate(() => {
        const lag = Date.now() - before;
        // Smooth with a simple EMA (α = 0.3) to avoid spikes from GC pauses
        this._system.eventLoopLag =
          Math.round(0.7 * this._system.eventLoopLag + 0.3 * lag);

        const timer = setTimeout(probe, 1000);
        if (typeof timer.unref === "function") timer.unref();
      });
    };

    const initial = setTimeout(probe, 1000);
    if (typeof initial.unref === "function") initial.unref();
  }

  /**
   * Observe GC performance entries via perf_hooks when available.
   * Buckets each collection by kind, records pause durations for recent stats,
   * and — after every MAJOR collection — snapshots the post-GC live set as a
   * leak-detection baseline. Gracefully no-ops where perf_hooks GC is unavailable.
   */
  #startGcObserver() {
    try {
      const obs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const pauseMs = entry.duration; // keep float precision for overhead math
          const kind = entry.detail?.kind ?? entry.kind;

          this._system.gc.collections++;
          this._system.gc.pauseMs += pauseMs;

          // Per-kind bucketing
          const bucket =
            kind === GC_KIND.MAJOR
              ? this._system.gc.major
              : kind === GC_KIND.MINOR
                ? this._system.gc.minor
                : kind === GC_KIND.INCREMENTAL
                  ? this._system.gc.incremental
                  : this._system.gc.weakcb;
          bucket.count++;
          bucket.pauseMs += pauseMs;

          // Recent pause sample (capped)
          if (this._gcPauses.length >= GC_PAUSE_SAMPLE_MAX) this._gcPauses.shift();
          this._gcPauses.push(pauseMs);

          // After a MAJOR collection the heap holds only the live set —
          // the gold-standard baseline for spotting a leak's upward creep.
          if (kind === GC_KIND.MAJOR) {
            if (this._heapBaselines.length >= HEAP_BASELINE_MAX) {
              this._heapBaselines.shift();
            }
            this._heapBaselines.push({
              ts: Date.now(),
              heapUsed: process.memoryUsage().heapUsed,
            });
          }
        }
      });
      obs.observe({ entryTypes: ["gc"] });
    } catch {
      // perf_hooks GC observation not available — skip silently
    }
  }

  /**
   * Analyse the post-major-GC heap baselines for a leak signature.
   *
   * A leak is a sustained rise in the *post-GC* live set: GC keeps running but
   * can no longer return memory to the floor. We require a minimum number of
   * baselines spanning a minimum window before reporting, so warm-up growth and
   * short bursts never trip it.
   *
   * @returns {{
   *   sampleCount: number,
   *   windowMs: number,
   *   growthBytesPerMin: number,
   *   firstHeapUsed: number,
   *   lastHeapUsed: number,
   *   suspected: boolean
   * }}
   */
  #analyzeHeapTrend() {
    const baselines = this._heapBaselines;
    const sampleCount = baselines.length;
    if (sampleCount < 2) {
      return {
        sampleCount,
        windowMs: 0,
        growthBytesPerMin: 0,
        firstHeapUsed: baselines[0]?.heapUsed ?? 0,
        lastHeapUsed: baselines[0]?.heapUsed ?? 0,
        suspected: false,
      };
    }
    const xs = baselines.map((b) => b.ts);
    const ys = baselines.map((b) => b.heapUsed);
    const slopePerMs = linRegSlope(xs, ys);
    const growthBytesPerMin = Math.round(slopePerMs * 60_000);
    const windowMs = xs[xs.length - 1] - xs[0];
    const firstHeapUsed = ys[0];
    const lastHeapUsed = ys[ys.length - 1];

    return {
      sampleCount,
      windowMs,
      growthBytesPerMin,
      firstHeapUsed,
      lastHeapUsed,
      // Heuristic only — flagged when enough majors over a long-enough window
      // show consistent upward live-set growth. Consumers decide severity.
      suspected:
        sampleCount >= 8 &&
        windowMs >= 5 * 60_000 &&
        growthBytesPerMin > 512 * 1024 && // > 0.5 MB/min sustained
        lastHeapUsed > firstHeapUsed * 1.25, // and ≥ 25% above the starting floor
    };
  }

  // ========================================
  // PRIVATE RING BUFFER HELPERS
  // ========================================

  /**
   * Push a duration into a ring buffer array, evicting the oldest entry when full.
   * Mutates the array in-place.
   * @param {number[]} buf      - The ring buffer array
   * @param {number}   durationMs
   */
  #pushRing(buf, durationMs) {
    if (buf.length >= RING_BUFFER_SIZE) {
      buf.shift(); // O(n) but n is bounded and small; acceptable for 1000 items
    }
    buf.push(durationMs);
  }

  /**
   * Durations of one route recorded within the last LATENCY_WINDOW_MS, ascending.
   * Timestamps are non-decreasing, so walk from the newest entry backwards and
   * stop at the first one at or before the cutoff.
   *
   * Complexity: O(k log k), k = in-window samples <= RING_BUFFER_SIZE (1000).
   *
   * @param {{ durations: number[], timestamps?: number[] }} entry
   * @param {number} now - epoch ms
   * @returns {number[]}
   */
  #windowedSorted(entry, now) {
    const cutoff = now - LATENCY_WINDOW_MS;
    const ts = entry.timestamps ?? [];
    const out = [];
    for (let i = ts.length - 1; i >= 0 && ts[i] > cutoff; i--) {
      out.push(entry.durations[i]);
    }
    return out.sort((a, b) => a - b);
  }

  // ========================================
  // PUBLIC MUTATORS
  // ========================================

  /**
   * Counts one request into the current rolling-window bucket, pruning
   * buckets older than the window when a new bucket opens (O(1) amortised).
   * @param {number} now - epoch ms captured once per request
   * @param {boolean} isClientError
   * @param {boolean} isServerError
   */
  #recordWindow(now, isClientError, isServerError) {
    const idx = Math.floor(now / ERROR_WINDOW_BUCKET_MS);
    let bucket = this._errorWindow.get(idx);
    if (!bucket) {
      bucket = { total: 0, client: 0, server: 0 };
      this._errorWindow.set(idx, bucket);
      for (const key of this._errorWindow.keys()) {
        if (key <= idx - ERROR_WINDOW_BUCKETS) this._errorWindow.delete(key);
      }
    }
    bucket.total++;
    if (isClientError) bucket.client++;
    if (isServerError) bucket.server++;
  }

  /**
   * Sums the last ERROR_WINDOW_MS of requests.
   * @returns {{ windowMs: number, requests: number, clientErrors: number, serverErrors: number, serviced: number, errorRate: number, availability: number }}
   */
  #windowTotals() {
    const nowIdx = Math.floor(Date.now() / ERROR_WINDOW_BUCKET_MS);
    let requests = 0;
    let clientErrors = 0;
    let serverErrors = 0;
    for (const [key, b] of this._errorWindow) {
      if (key <= nowIdx - ERROR_WINDOW_BUCKETS) continue;
      requests += b.total;
      clientErrors += b.client;
      serverErrors += b.server;
    }
    const rates = computeRates(requests, clientErrors, serverErrors);
    return {
      windowMs: ERROR_WINDOW_MS,
      requests,
      clientErrors,
      serverErrors,
      serviced: requests - clientErrors,
      errorRate: rates.errorRate,
      availability: rates.availability,
    };
  }

  /**
   * Record a completed HTTP request for RED metric aggregation.
   *
   * @param {string} route      - "<METHOD> <path>" e.g. "GET /api/v1/health"
   * @param {string} method     - HTTP verb
   * @param {number} statusCode - HTTP response status code
   * @param {number} durationMs - Request duration in milliseconds
   */
  recordRequest(route, method, statusCode, durationMs) {
    const now = Date.now();
    this._requestsTotal++;

    // 304 → not-modified (cache hit); 3xx (non-304) → real redirect;
    // 4xx → client error (correct rejection); 5xx → server error (real failure).
    const isServerError = statusCode >= SERVER_ERROR_MIN_STATUS;
    const isClientError =
      statusCode >= CLIENT_ERROR_MIN_STATUS &&
      statusCode < SERVER_ERROR_MIN_STATUS;
    const isNotModified = statusCode === NOT_MODIFIED_STATUS;
    const isRedirect =
      !isNotModified &&
      statusCode >= REDIRECT_MIN_STATUS &&
      statusCode < CLIENT_ERROR_MIN_STATUS;

    if (isServerError) this._serverErrorsTotal++;
    if (isClientError) this._clientErrorsTotal++;
    this.#recordWindow(now, isClientError, isServerError);
    if (isRedirect) this._redirectsTotal++;
    if (isNotModified) this._notModifiedTotal++;

    let entry = this._routes.get(route);
    if (!entry) {
      entry = { count: 0, redirectCount: 0, notModifiedCount: 0, clientErrorCount: 0, serverErrorCount: 0, durations: [], timestamps: [] };
      this._routes.set(route, entry);
    }

    entry.count++;
    if (isServerError) entry.serverErrorCount++;
    if (isClientError) entry.clientErrorCount++;
    if (isRedirect) entry.redirectCount++;
    if (isNotModified) entry.notModifiedCount++;
    this.#pushRing(entry.durations, durationMs);
    this.#pushRing(entry.timestamps, now); // lockstep with durations
  }

  /**
   * Record a request cut by the request watchdog (idle past its limit).
   *
   * @param {string} route - Bounded "<METHOD> <route-pattern>" label.
   */
  recordWatchdogTermination(route) {
    this._watchdog.terminated++;
    const map = this._watchdog.byRoute;
    if (map.has(route) || map.size < WATCHDOG_ROUTES_MAX) {
      map.set(route, (map.get(route) ?? 0) + 1);
    }
  }

  /**
   * Record an Oracle DB query for dependency metrics.
   *
   * @param {string}  poolName   - Named connection pool (e.g. "appDb")
   * @param {number}  durationMs - Query round-trip duration in milliseconds
   * @param {boolean} success    - Whether the query succeeded
   */
  recordDbQuery(poolName, durationMs, success) {
    let entry = this._oracle.get(poolName);
    if (!entry) {
      entry = { queryCount: 0, errorCount: 0, totalMs: 0, durations: [] };
      this._oracle.set(poolName, entry);
    }

    entry.queryCount++;
    entry.totalMs += durationMs;
    if (!success) entry.errorCount++;
    this.#pushRing(entry.durations, durationMs);
  }

  /**
   * Record live Oracle connection-pool saturation stats (USE method).
   *
   * Called by the Oracle adapter's PoolHealthMonitor on its 30 s poll. The
   * pool object exposes these counters synchronously, so this is non-blocking
   * and never touches the DB query hot path. Two derived ratios are stored:
   *   - utilization = connectionsInUse / connectionsOpen  (how saturated the
   *     currently-open connections are — the live pressure signal)
   *   - capacity    = connectionsOpen / poolMax           (how close the pool
   *     is to its hard ceiling — headroom before exhaustion)
   *
   * @param {string} poolName - Named connection pool (e.g. "appDb")
   * @param {{ connectionsInUse: number, connectionsOpen: number, poolMax: number, queueLength: number, healthy?: boolean, consecutiveFailures?: number }} stats
   */
  recordPoolStats(poolName, stats) {
    const open = Number(stats?.connectionsOpen) || 0;
    const inUse = Number(stats?.connectionsInUse) || 0;
    const poolMax = Number(stats?.poolMax) || 0;
    const queueLength = Number(stats?.queueLength) || 0;
    this._oraclePoolStats.set(poolName, {
      connectionsInUse: inUse,
      connectionsOpen: open,
      poolMax,
      queueLength,
      utilization: open > 0 ? inUse / open : 0,
      capacity: poolMax > 0 ? open / poolMax : 0,
      // O5 pool-outage health signal from the adapter's health poll.
      // Default healthy=true when absent (older callers / success path).
      healthy: stats?.healthy !== false,
      consecutiveFailures: Number(stats?.consecutiveFailures) || 0,
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * Record the outcome of one server email notification send attempt
   * (server-email-notifications feature). Called by `ServerNotificationService`
   * on EVERY attempt — success and failure — so the SMTP dependency and the
   * alert tab always reflect delivery health, even when zero emails get
   * through (R7: email delivery is itself a monitored dependency).
   *
   * @param {string}      channel - Channel key (e.g. "server-system-notification")
   * @param {boolean}     ok      - Whether the send succeeded
   * @param {string|null} [cause] - Failure reason when ok is false
   */
  recordNotificationDelivery(channel, ok, cause = null) {
    let entry = this._notifications.get(channel);
    if (!entry) {
      entry = {
        sent: 0,
        failed: 0,
        consecutiveFailures: 0,
        lastSuccessAt: null,
        lastFailureAt: null,
        lastFailureCause: null,
        suppressedCount: 0,
      };
      this._notifications.set(channel, entry);
    }

    if (ok) {
      entry.sent++;
      entry.consecutiveFailures = 0;
      entry.lastSuccessAt = new Date().toISOString();
    } else {
      entry.failed++;
      entry.consecutiveFailures++;
      entry.lastFailureAt = new Date().toISOString();
      entry.lastFailureCause = cause ?? null;
    }
  }

  /**
   * Records that N buffered critical-channel events were dropped by the
   * hourly email storm ceiling (R3) instead of being sent. Visible in the
   * alert tab / status endpoint even while the ceiling suppresses the email
   * itself.
   *
   * @param {string} channel - Channel key (normally "server-critical-notification")
   * @param {number} count   - Number of events suppressed in this window
   */
  recordNotificationSuppressed(channel, count = 1) {
    let entry = this._notifications.get(channel);
    if (!entry) {
      entry = {
        sent: 0,
        failed: 0,
        consecutiveFailures: 0,
        lastSuccessAt: null,
        lastFailureAt: null,
        lastFailureCause: null,
        suppressedCount: 0,
      };
      this._notifications.set(channel, entry);
    }
    entry.suppressedCount += Math.max(0, Number(count) || 0);
  }

  /**
   * Store a frontend web vital event.
   * Evicts oldest when buffer exceeds FRONTEND_VITALS_MAX.
   *
   * @param {string} name    - "LCP" | "CLS" | "FID" | "INP"
   * @param {number} value   - Metric value in the metric's native unit
   * @param {string} rating  - "good" | "needs-improvement" | "poor"
   * @param {object} [context={}] - Additional context from the client
   */
  recordFrontendVital(name, value, rating, context = {}) {
    if (this._frontendVitals.length >= FRONTEND_VITALS_MAX) {
      this._frontendVitals.shift();
    }
    this._frontendVitals.push({ name, value, rating, context, ts: new Date().toISOString() });
  }

  /**
   * Store a frontend JS error.
   * Evicts oldest when buffer exceeds FRONTEND_VITALS_MAX.
   *
   * @param {string} message  - Error message
   * @param {string} [stack]  - Error stack trace
   * @param {object} [context={}] - Additional context (page, userAgent, etc.)
   */
  recordFrontendError(message, stack = "", context = {}) {
    if (this._frontendErrors.length >= FRONTEND_VITALS_MAX) {
      this._frontendErrors.shift();
    }
    this._frontendErrors.push({ message, stack, context, ts: new Date().toISOString() });
  }

  /**
   * Aggregates the per-channel notification delivery stats into one SMTP
   * dependency health block (R7). SMTP is ONE physical dependency shared by
   * all four channels, so `consecutiveFailures` is the MAX across channels
   * (any channel failing means the SMTP relay is unreachable) and the
   * timestamps are the most recent across channels.
   *
   * @returns {{ status: "up"|"degraded"|"down", consecutiveFailures: number, lastSuccessAt: string|null, lastFailureAt: string|null }}
   */
  #buildSmtpDependencySnapshot() {
    let consecutiveFailures = 0;
    let lastSuccessAt = null;
    let lastFailureAt = null;

    for (const entry of this._notifications.values()) {
      consecutiveFailures = Math.max(consecutiveFailures, entry.consecutiveFailures);
      if (entry.lastSuccessAt && (!lastSuccessAt || entry.lastSuccessAt > lastSuccessAt)) {
        lastSuccessAt = entry.lastSuccessAt;
      }
      if (entry.lastFailureAt && (!lastFailureAt || entry.lastFailureAt > lastFailureAt)) {
        lastFailureAt = entry.lastFailureAt;
      }
    }

    const status =
      consecutiveFailures >= 3 ? "down" : consecutiveFailures >= 1 ? "degraded" : "up";

    return { status, consecutiveFailures, lastSuccessAt, lastFailureAt };
  }

  // ========================================
  // PUBLIC SNAPSHOT
  // ========================================

  /**
   * Return a complete metrics snapshot.
   * Sorting ring buffers for percentile calculation is done on read, not on write,
   * to keep recordRequest() as fast as possible.
   *
   * `red[route].window` is the p99 over the last LATENCY_WINDOW_MS only (0 when
   * no request fell inside it); `window.count` is capped at the ring size (1000)
   * per worker. Lifetime p50/p95/p99/count/avgMs/apdex are unchanged.
   *
   * @returns {{
   *   timestamp: string,
   *   uptime: number,
   *   red: Object.<string, { count: number, clientErrorCount: number, serverErrorCount: number, errorRate: number, clientErrorRate: number, availability: number, p50: number, p95: number, p99: number, avgMs: number, window: { windowMs: number, count: number, p99: number } }>,
   *   system: { cpu: object, memory: object, eventLoopLag: number, gc: object, handles: number, requests: number },
   *   dependencies: { oracle: Object.<string, { queryCount: number, errorCount: number, avgMs: number, p95Ms: number, poolUtilization: number|null, connectionsInUse: number|null, connectionsOpen: number|null, poolMax: number|null, queueLength: number|null, capacity: number|null, healthy: boolean|null, consecutiveFailures: number|null }> },
   *   totals: { requestsTotal: number, clientErrorsTotal: number, serverErrorsTotal: number, errorRate: number, clientErrorRate: number, availability: number },
   *   frontendVitals: Array,
   *   frontendErrors: Array
   * }}
   */
  getSnapshot() {
    // Build RED metrics per route. Apdex is accumulated globally in the same
    // pass over each route's duration ring buffer — O(total samples), no extra
    // allocation beyond the per-route sort already needed for percentiles.
    const red = {};
    const apdexT = APDEX_THRESHOLD_MS;
    let apdexSatisfied = 0; // d ≤ T
    let apdexTolerating = 0; // T < d ≤ 4T
    let apdexSamples = 0;
    const now = Date.now();

    for (const [route, entry] of this._routes) {
      const win = this.#windowedSorted(entry, now);
      const sorted = [...entry.durations].sort((a, b) => a - b);
      const avg = sorted.length
        ? Math.round(sorted.reduce((s, v) => s + v, 0) / sorted.length)
        : 0;

      for (const d of sorted) {
        apdexSamples++;
        if (d <= apdexT) apdexSatisfied++;
        else if (d <= apdexT * 4) apdexTolerating++;
      }

      const rates = computeRates(
        entry.count,
        entry.clientErrorCount,
        entry.serverErrorCount,
      );

      red[route] = {
        count: entry.count,
        redirectCount: entry.redirectCount ?? 0,
        notModifiedCount: entry.notModifiedCount ?? 0,
        clientErrorCount: entry.clientErrorCount,
        serverErrorCount: entry.serverErrorCount,
        errorRate: rates.errorRate, // server-only (4xx excluded)
        clientErrorRate: rates.clientErrorRate,
        availability: rates.availability,
        p50: calcPercentile(sorted, 0.5),
        p95: calcPercentile(sorted, 0.95),
        p99: calcPercentile(sorted, 0.99),
        avgMs: avg,
        window: {
          windowMs: LATENCY_WINDOW_MS,
          count: win.length,
          p99: calcPercentile(win, 0.99),
        },
      };
    }

    // Apdex = (satisfied + tolerating/2) / total. No samples → 1 (nothing slow yet).
    const apdex = apdexSamples > 0
      ? Number(((apdexSatisfied + apdexTolerating / 2) / apdexSamples).toFixed(3))
      : 1;

    // Build Oracle dependency stats — union of per-query timings (recordDbQuery)
    // and live pool saturation (recordPoolStats). Either source may be absent:
    // recordDbQuery is optional instrumentation, while pool stats arrive from the
    // adapter's 30 s health poll. A pool appears here as soon as either reports.
    const oracleDeps = {};
    const oracleNames = new Set([
      ...this._oracle.keys(),
      ...this._oraclePoolStats.keys(),
    ]);
    for (const poolName of oracleNames) {
      const entry = this._oracle.get(poolName);
      const sorted = entry ? [...entry.durations].sort((a, b) => a - b) : [];
      const pool = this._oraclePoolStats.get(poolName) || null;
      oracleDeps[poolName] = {
        queryCount: entry?.queryCount ?? 0,
        errorCount: entry?.errorCount ?? 0,
        avgMs: entry?.queryCount
          ? Math.round(entry.totalMs / entry.queryCount)
          : 0,
        p95Ms: calcPercentile(sorted, 0.95),
        // Live pool saturation (USE). null until the adapter first reports.
        poolUtilization: pool ? Number(pool.utilization.toFixed(4)) : null,
        connectionsInUse: pool?.connectionsInUse ?? null,
        connectionsOpen: pool?.connectionsOpen ?? null,
        poolMax: pool?.poolMax ?? null,
        queueLength: pool?.queueLength ?? null,
        capacity: pool ? Number(pool.capacity.toFixed(4)) : null,
        // O5 health signal. null = never reported (fires neither DOWN nor DEGRADED).
        healthy: pool ? pool.healthy : null,
        consecutiveFailures: pool ? pool.consecutiveFailures : null,
      };
    }

    // Recent GC pause stats (windowed, vs the lifetime totals in gc.*)
    const sortedPauses = [...this._gcPauses].sort((a, b) => a - b);
    const recentGc = {
      sampleCount: sortedPauses.length,
      avgPauseMs: sortedPauses.length
        ? Number(
            (sortedPauses.reduce((s, v) => s + v, 0) / sortedPauses.length).toFixed(2),
          )
        : 0,
      maxPauseMs: sortedPauses.length
        ? Number(sortedPauses[sortedPauses.length - 1].toFixed(2))
        : 0,
      p95PauseMs: Number(calcPercentile(sortedPauses, 0.95).toFixed(2)),
    };

    const gc = this._system.gc;

    return {
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      red,
      system: {
        cpu: { ...this._system.cpu },
        memory: { ...this._system.memory },
        eventLoopLag: this._system.eventLoopLag,
        gc: {
          collections: gc.collections,
          pauseMs: Math.round(gc.pauseMs),
          overheadPct: gc.overheadPct,
          major: { ...gc.major },
          minor: { ...gc.minor },
          incremental: { ...gc.incremental },
          weakcb: { ...gc.weakcb },
          recent: recentGc,
        },
        // Post-major-GC live-set trend — the leak detector
        memoryTrend: this.#analyzeHeapTrend(),
        handles: this._system.handles,
        requests: this._system.requests,
      },
      dependencies: {
        oracle: oracleDeps,
        smtp: this.#buildSmtpDependencySnapshot(),
      },
      totals: (() => {
        const rates = computeRates(
          this._requestsTotal,
          this._clientErrorsTotal,
          this._serverErrorsTotal,
        );
        const errorsTotal = this._clientErrorsTotal + this._serverErrorsTotal;
        // 2xx success = everything that is not a redirect, 304, client error, or
        // server error. Floored at 0 to stay safe against any counter skew.
        const successTotal = Math.max(
          0,
          this._requestsTotal -
            this._redirectsTotal -
            this._notModifiedTotal -
            this._clientErrorsTotal -
            this._serverErrorsTotal,
        );
        return {
          requestsTotal: this._requestsTotal,
          successTotal,
          redirectsTotal: this._redirectsTotal,
          notModifiedTotal: this._notModifiedTotal,
          clientErrorsTotal: this._clientErrorsTotal,
          serverErrorsTotal: this._serverErrorsTotal,
          errorsTotal, // client + server combined (dashboard tile)
          errorRate: rates.errorRate, // server-only (4xx excluded)
          clientErrorRate: rates.clientErrorRate,
          availability: rates.availability,
          apdex,
          window: this.#windowTotals(),
        };
      })(),
      frontendVitals: [...this._frontendVitals],
      frontendErrors: [...this._frontendErrors],
      notifications: Object.fromEntries(
        [...this._notifications].map(([channel, entry]) => [channel, { ...entry }]),
      ),
      watchdog: {
        terminated: this._watchdog.terminated,
        byRoute: Object.fromEntries(this._watchdog.byRoute),
      },
    };
  }

  /**
   * Snapshot plus the raw material `metricsMerge` needs to combine several
   * workers' stores: per-route and per-pool quantile sketches (sorted durations
   * sampled on QUANTILE_GRID), total Oracle query ms and Apdex bucket counts.
   * `getSnapshot()` itself is unchanged. `routeWindowSketches` holds the same
   * sketch built from only the last LATENCY_WINDOW_MS of each route's samples.
   *
   * @returns {{ snapshot: object, extras: { routeSketches: object, routeWindowSketches: object, oracleSketches: object, oracleTotalMs: object, apdexCounts: { satisfied: number, tolerating: number, samples: number } } }}
   */
  getMergeableSnapshot() {
    // Lazy: metricsMerge requires this module for computeRates.
    const { buildQuantileSketch } = require("./metricsMerge");
    const snapshot = this.getSnapshot();

    const routeSketches = new Map();
    const routeWindowSketches = new Map();
    const now = Date.now();
    let satisfied = 0;
    let tolerating = 0;
    let samples = 0;
    for (const [route, entry] of this._routes) {
      const sorted = [...entry.durations].sort((a, b) => a - b);
      routeSketches.set(route, buildQuantileSketch(sorted));
      routeWindowSketches.set(route, buildQuantileSketch(this.#windowedSorted(entry, now)));
      for (const d of sorted) {
        samples++;
        if (d <= APDEX_THRESHOLD_MS) satisfied++;
        else if (d <= APDEX_THRESHOLD_MS * 4) tolerating++;
      }
    }

    const oracleSketches = new Map();
    const oracleTotalMs = new Map();
    for (const [pool, entry] of this._oracle) {
      oracleSketches.set(pool, buildQuantileSketch([...entry.durations].sort((a, b) => a - b)));
      oracleTotalMs.set(pool, entry.totalMs);
    }

    return {
      snapshot,
      extras: {
        routeSketches: Object.fromEntries(routeSketches),
        routeWindowSketches: Object.fromEntries(routeWindowSketches),
        oracleSketches: Object.fromEntries(oracleSketches),
        oracleTotalMs: Object.fromEntries(oracleTotalMs),
        apdexCounts: { satisfied, tolerating, samples },
      },
    };
  }
}

// ─── Singleton export ─────────────────────────────────────────────────────────

const metricsStore = new MetricsStore();

module.exports = {
  MetricsStore,
  metricsStore,
  computeRates,
  calcPercentile,
  linRegSlope,
  GC_KIND,
  REDIRECT_MIN_STATUS,
  NOT_MODIFIED_STATUS,
  CLIENT_ERROR_MIN_STATUS,
  SERVER_ERROR_MIN_STATUS,
  APDEX_THRESHOLD_MS,
  LATENCY_WINDOW_MS,
};
