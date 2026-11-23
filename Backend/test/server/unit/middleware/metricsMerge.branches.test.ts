import { mergeMetricsSnapshots, buildQuantileSketch, percentileFromSketches, QUANTILE_GRID } from "../../../../src/middleware/metrics/metricsMerge";

/** A minimal wire part: only the blocks isUsablePart requires, plus whatever the case overrides. */
function snap(over: Record<string, any> = {}) {
    return {
        uptime: 10,
        red: {},
        totals: {},
        system: { memory: { heapUsed: 10, heapTotal: 20, heapSizeLimit: 100, rss: 30, external: 1, arrayBuffers: 2 } },
        dependencies: {},
        ...over,
    };
}
const part = (workerId: number, s: any, extras?: any, more: Record<string, any> = {}) => ({ workerId, value: { snapshot: s, extras }, ...more });
const sketchOf = (values: number[]) => buildQuantileSketch([...values].sort((a, b) => a - b));
const ramp = (from: number, to: number) => Array.from({ length: 100 }, (_, i) => from + ((to - from) * i) / 99);

describe("metricsMerge sketches", () => {
    it("buildQuantileSketch of nothing is empty; otherwise samples the whole grid with min and max at the ends", () => {
        expect(buildQuantileSketch([])).toEqual({ n: 0, q: [] });
        const s = buildQuantileSketch([1, 2, 3, 4, 5]);
        expect(s.n).toBe(5);
        expect(s.q).toHaveLength(QUANTILE_GRID.length);
        expect(s.q[0]).toBe(1);
        expect(s.q.at(-1)).toBe(5);
    });

    it("percentileFromSketches: no live sketch is 0, p<=0 is the min, p>=1 is the max", () => {
        expect(percentileFromSketches([], 0.5)).toBe(0);
        expect(percentileFromSketches([{ n: 0, q: [] }, { n: 3, q: [1, 2] } as any], 0.5)).toBe(0); // invalid grid length is ignored
        const s = sketchOf(ramp(10, 110));
        expect(percentileFromSketches([s], 0)).toBe(10);
        expect(percentileFromSketches([s], 1)).toBe(110);
    });

    it("the median of a single ramp lands near its middle; two workers mix by sample weight", () => {
        const low = sketchOf(ramp(0, 100));
        const high = sketchOf(ramp(1000, 1100));
        const mid = percentileFromSketches([low], 0.5);
        expect(mid).toBeGreaterThan(40);
        expect(mid).toBeLessThan(60);
        // equal weight: the median sits in the gap between the two populations
        const both = percentileFromSketches([low, high], 0.5);
        expect(both).toBeGreaterThanOrEqual(90);
        expect(both).toBeLessThanOrEqual(1010);
        // p99 belongs to the slow worker
        expect(percentileFromSketches([low, high], 0.99)).toBeGreaterThan(1000);
    });

    it("a constant sketch (zero span) still resolves", () => {
        const flat = sketchOf(Array(50).fill(7));
        expect(percentileFromSketches([flat, flat], 0.5)).toBe(7);
    });
});

describe("metricsMerge mergeMetricsSnapshots", () => {
    it("returns null when no part is usable (or the input is not an array)", () => {
        expect(mergeMetricsSnapshots([])).toBeNull();
        expect(mergeMetricsSnapshots([null, 5, {}, { value: { snapshot: { red: {} } } }])).toBeNull();
        expect(mergeMetricsSnapshots(undefined as any)).toBeNull();
    });

    it("counts skipped parts and missing workers in the cluster block", () => {
        const m = mergeMetricsSnapshots([part(1, snap()), { junk: true }], { missing: [3] })!;
        expect(m.cluster).toEqual({ workers: 3, responded: 1, missing: [3, "invalid:1"] });
        const m2 = mergeMetricsSnapshots([part(1, snap())], { expected: 4 })!;
        expect(m2.cluster.workers).toBe(4);
        expect(m2.cluster.missing).toEqual([]);
    });

    describe("routes", () => {
        const row = (o: Record<string, any> = {}) => ({ count: 10, clientErrorCount: 1, serverErrorCount: 1, redirectCount: 2, notModifiedCount: 3, p50: 5, p95: 50, p99: 99, avgMs: 20, window: { windowMs: 300_000, count: 4, p99: 77 }, ...o });

        it("sums counts and recomputes rates", () => {
            const m = mergeMetricsSnapshots([part(1, snap({ red: { r: row() } })), part(2, snap({ red: { r: row({ count: 30 }) } }))])!;
            expect(m.red.r.count).toBe(40);
            expect(m.red.r.clientErrorCount).toBe(2);
            expect(m.red.r.redirectCount).toBe(4);
            expect(m.red.r.notModifiedCount).toBe(6);
            expect(m.red.r.window.count).toBe(8);
            expect(m.red.r.window.windowMs).toBe(300_000);
        });

        it("without sketches the percentiles are the worst worker's and avgMs is count-weighted", () => {
            const m = mergeMetricsSnapshots([
                part(1, snap({ red: { r: row({ count: 10, avgMs: 10, p99: 100 }) } })),
                part(2, snap({ red: { r: row({ count: 30, avgMs: 30, p99: 400 }) } })),
            ])!;
            expect(m.red.r.p99).toBe(400);
            expect(m.red.r.avgMs).toBe(25);
            expect(m.red.r.window.p99).toBe(77);
        });

        it("the sample weight is capped at the ring-buffer size when a worker sent no sketch", () => {
            const m = mergeMetricsSnapshots([
                part(1, snap({ red: { r: row({ count: 1_000_000, avgMs: 10 }) } })),
                part(2, snap({ red: { r: row({ count: 1000, avgMs: 30 }) } })),
            ])!;
            expect(m.red.r.avgMs).toBe(20);
        });

        it("with sketches the percentiles come from the merged distribution", () => {
            const fast = sketchOf(ramp(1, 10));
            const slow = sketchOf(ramp(500, 600));
            const m = mergeMetricsSnapshots([
                part(1, snap({ red: { r: row({ avgMs: 5 }) } }), { routeSketches: { r: fast }, routeWindowSketches: { r: fast } }),
                part(2, snap({ red: { r: row({ avgMs: 550 }) } }), { routeSketches: { r: slow }, routeWindowSketches: { r: slow } }),
            ])!;
            expect(m.red.r.p99).toBeGreaterThan(500);
            expect(m.red.r.p50).toBeLessThan(600);
            expect(m.red.r.window.p99).toBeGreaterThan(500);
            expect(m.red.r.avgMs).toBeGreaterThan(5);
        });

        it("an invalid sketch is ignored in favour of the plain row; a non-object row is skipped; a row with no window reads 0", () => {
            const m = mergeMetricsSnapshots([
                part(1, snap({ red: { r: row({ window: undefined, p99: 9 }), bad: "nope" } }), { routeSketches: { r: { n: 5, q: [3, 1] } } }),
            ])!;
            expect(m.red.bad).toBeUndefined();
            expect(m.red.r.p99).toBe(9);
            expect(m.red.r.window).toEqual({ windowMs: 0, count: 0, p99: 0 });
        });

        it("a route with zero samples averages 0", () => {
            const m = mergeMetricsSnapshots([part(1, snap({ red: { r: row({ count: 0, avgMs: 0, clientErrorCount: 0, serverErrorCount: 0 }) } }))])!;
            expect(m.red.r.avgMs).toBe(0);
        });

        it("non-numeric fields on the wire read as 0", () => {
            const m = mergeMetricsSnapshots([part(1, snap({ red: { r: { count: "x", avgMs: NaN } } }))])!;
            expect(m.red.r.count).toBe(0);
            expect(m.red.r.avgMs).toBe(0);
        });
    });

    describe("totals", () => {
        it("sums, derives successTotal (never negative) and rebuilds window rates", () => {
            const m = mergeMetricsSnapshots([
                part(1, snap({ totals: { requestsTotal: 100, redirectsTotal: 5, notModifiedTotal: 5, clientErrorsTotal: 10, serverErrorsTotal: 10, window: { windowMs: 300_000, requests: 50, clientErrors: 5, serverErrors: 5 } } })),
                part(2, snap({ totals: { requestsTotal: 1, redirectsTotal: 5, notModifiedTotal: 5, clientErrorsTotal: 10, serverErrorsTotal: 10, window: { windowMs: 60_000, requests: 10, clientErrors: 1, serverErrors: 0 } } })),
            ])!;
            expect(m.totals.requestsTotal).toBe(101);
            expect(m.totals.errorsTotal).toBe(40);
            expect(m.totals.successTotal).toBe(41);
            expect(m.totals.window.windowMs).toBe(300_000);
            expect(m.totals.window.requests).toBe(60);
            expect(m.totals.window.serviced).toBe(54);
        });

        it("successTotal is clamped at 0 when counters disagree", () => {
            const m = mergeMetricsSnapshots([part(1, snap({ totals: { requestsTotal: 1, clientErrorsTotal: 10 } }))])!;
            expect(m.totals.successTotal).toBe(0);
        });

        it("apdex from exact counts: (satisfied + tolerating/2) / samples, and 1 with zero samples", () => {
            const a = mergeMetricsSnapshots([
                part(1, snap(), { apdexCounts: { satisfied: 6, tolerating: 2, samples: 10 } }),
                part(2, snap(), { apdexCounts: { satisfied: 0, tolerating: 0, samples: 10 } }),
            ])!;
            expect(a.totals.apdex).toBe(0.35);
            const z = mergeMetricsSnapshots([part(1, snap(), { apdexCounts: { satisfied: 0, tolerating: 0, samples: 0 } })])!;
            expect(z.totals.apdex).toBe(1);
        });

        it("without counts apdex is the mean of the workers' own (non-finite counts as 1)", () => {
            const m = mergeMetricsSnapshots([part(1, snap({ totals: { apdex: 0.5 } })), part(2, snap({ totals: { apdex: "x" } }))])!;
            expect(m.totals.apdex).toBe(0.75);
        });

        it("a part whose extras are missing falls back to the workers' apdex", () => {
            const m = mergeMetricsSnapshots([part(1, snap({ totals: { apdex: 0.9 } }), "garbage")])!;
            expect(m.totals.apdex).toBe(0.9);
        });
    });

    describe("system", () => {
        const sys = (o: Record<string, any> = {}) => ({ memory: { heapUsed: 10, heapTotal: 20, heapSizeLimit: 100, rss: 30, external: 1, arrayBuffers: 2 }, cpu: { user: 1, system: 2, percent: 10.123 }, eventLoopLag: 5, handles: 3, requests: 4, gc: {}, ...o });

        it("sums cpu/handles/requests, takes max lag and memory from the worker nearest its heap ceiling", () => {
            const m = mergeMetricsSnapshots([
                part(1, snap({ system: sys(), uptime: 5 }), undefined, { pid: 11, isLeader: true }),
                part(2, snap({ system: sys({ memory: { heapUsed: 90, heapTotal: 95, heapSizeLimit: 100, rss: 300, external: 0, arrayBuffers: 0 }, eventLoopLag: 50, cpu: { user: 5, system: 5, percent: 20 } }), uptime: 9 })),
            ])!;
            expect(m.system.memory.heapUsed).toBe(90);
            expect(m.system.memory.rss).toBe(300);
            expect(m.system.eventLoopLag).toBe(50);
            expect(m.system.cpu).toEqual({ user: 6, system: 7, percent: 30.12 });
            expect(m.system.handles).toBe(6);
            expect(m.system.requests).toBe(8);
            expect(m.uptime).toBe(9);
            expect(m.system.workers).toEqual([
                expect.objectContaining({ workerId: 1, pid: 11, isLeader: true, uptime: 5, heapUsed: 10 }),
                expect.objectContaining({ workerId: 2, pid: null, isLeader: false, uptime: 9, heapUsed: 90 }),
            ]);
        });

        it("a zero heap limit does not divide by zero", () => {
            const m = mergeMetricsSnapshots([part(1, snap({ system: sys({ memory: { heapUsed: 5, heapSizeLimit: 0 } }) }))])!;
            expect(m.system.memory.heapUsed).toBe(5);
        });

        it("memoryTrend comes from the worker suspecting a leak (the fastest grower), else the hottest worker", () => {
            const trend = (growth: number, suspected: boolean) => ({ sampleCount: 9, windowMs: 1, growthBytesPerMin: growth, firstHeapUsed: 1, lastHeapUsed: 2, suspected });
            const m = mergeMetricsSnapshots([
                part(1, snap({ system: sys({ memoryTrend: trend(100, true) }) })),
                part(2, snap({ system: sys({ memoryTrend: trend(900, true) }) })),
                part(3, snap({ system: sys({ memoryTrend: trend(5000, false) }) })),
            ])!;
            expect(m.system.memoryTrend.growthBytesPerMin).toBe(900);
            expect(m.system.memoryTrend.suspected).toBe(true);
            const none = mergeMetricsSnapshots([part(1, snap({ system: sys({ memoryTrend: trend(7, false) }) }))])!;
            expect(none.system.memoryTrend.growthBytesPerMin).toBe(7);
            const absent = mergeMetricsSnapshots([part(1, snap({ system: sys() }))])!;
            expect(absent.system.memoryTrend).toEqual({ sampleCount: 0, windowMs: 0, growthBytesPerMin: 0, firstHeapUsed: 0, lastHeapUsed: 0, suspected: false });
        });

        it("gc counters are summed per kind and 'recent' is a sample-weighted average", () => {
            const gc = (n: number, avg: number, max: number) => ({
                collections: n, pauseMs: n * 2, overheadPct: n,
                major: { count: n, pauseMs: 1 }, minor: { count: n, pauseMs: 2 }, incremental: { count: 1, pauseMs: 1 }, weakcb: { count: 0, pauseMs: 0 },
                recent: { sampleCount: n, avgPauseMs: avg, maxPauseMs: max, p95PauseMs: max - 1 },
            });
            const m = mergeMetricsSnapshots([
                part(1, snap({ system: sys({ gc: gc(10, 2, 8) }) })),
                part(2, snap({ system: sys({ gc: gc(30, 4, 20) }) })),
            ])!;
            expect(m.system.gc.collections).toBe(40);
            expect(m.system.gc.major.count).toBe(40);
            expect(m.system.gc.overheadPct).toBe(30);
            expect(m.system.gc.recent).toEqual({ sampleCount: 40, avgPauseMs: 3.5, maxPauseMs: 20, p95PauseMs: 19 });
        });

        it("no recent gc samples averages 0", () => {
            const m = mergeMetricsSnapshots([part(1, snap({ system: sys() }))])!;
            expect(m.system.gc.recent).toEqual({ sampleCount: 0, avgPauseMs: 0, maxPauseMs: 0, p95PauseMs: 0 });
        });
    });

    describe("oracle pools", () => {
        const pool = (o: Record<string, any> = {}) => ({ queryCount: 10, errorCount: 1, avgMs: 10, p95Ms: 30, poolUtilization: 0.5, connectionsInUse: 2, connectionsOpen: 4, poolMax: 10, queueLength: 0, capacity: 10, healthy: true, consecutiveFailures: 0, ...o });

        it("sums volume, takes the worst saturation, ANDs health and counts unhealthy workers", () => {
            const m = mergeMetricsSnapshots([
                part(1, snap({ dependencies: { oracle: { app: pool() } } })),
                part(2, snap({ dependencies: { oracle: { app: pool({ poolUtilization: 0.9, healthy: false, consecutiveFailures: 3, capacity: 20 }) } } })),
            ])!;
            const p = m.dependencies.oracle.app;
            expect(p.queryCount).toBe(20);
            expect(p.errorCount).toBe(2);
            expect(p.poolUtilization).toBe(0.9);
            expect(p.capacity).toBe(20);
            expect(p.connectionsInUse).toBe(4);
            expect(p.poolMax).toBe(20);
            expect(p.healthy).toBe(false);
            expect(p.unhealthyWorkers).toBe(1);
            expect(p.consecutiveFailures).toBe(3);
        });

        it("avgMs uses exact total ms when every worker sent it, else a query-weighted mean; p95 uses sketches when present", () => {
            const exact = mergeMetricsSnapshots([
                part(1, snap({ dependencies: { oracle: { app: pool({ avgMs: 1 }) } } }), { oracleTotalMs: { app: 100 } }),
                part(2, snap({ dependencies: { oracle: { app: pool({ avgMs: 1 }) } } }), { oracleTotalMs: { app: 300 } }),
            ])!;
            expect(exact.dependencies.oracle.app.avgMs).toBe(20);
            const weighted = mergeMetricsSnapshots([
                part(1, snap({ dependencies: { oracle: { app: pool({ avgMs: 10, queryCount: 10 }) } } }), { oracleTotalMs: { app: 100 } }),
                part(2, snap({ dependencies: { oracle: { app: pool({ avgMs: 30, queryCount: 30 }) } } })),
            ])!;
            expect(weighted.dependencies.oracle.app.avgMs).toBe(25);
            const sk = sketchOf(ramp(1, 100));
            const withSketch = mergeMetricsSnapshots([part(1, snap({ dependencies: { oracle: { app: pool() } } }), { oracleSketches: { app: sk } })])!;
            expect(withSketch.dependencies.oracle.app.p95Ms).toBeGreaterThan(80);
            const worst = mergeMetricsSnapshots([part(1, snap({ dependencies: { oracle: { app: pool({ p95Ms: 12 }) } } })), part(2, snap({ dependencies: { oracle: { app: pool({ p95Ms: 99 }) } } }))])!;
            expect(worst.dependencies.oracle.app.p95Ms).toBe(99);
        });

        it("a pool with no queries averages 0 and null-valued saturation stays null, health unknown is null", () => {
            const m = mergeMetricsSnapshots([part(1, snap({ dependencies: { oracle: { app: { queryCount: 0 } } } }))])!;
            const p = m.dependencies.oracle.app;
            expect(p.avgMs).toBe(0);
            expect(p.poolUtilization).toBeNull();
            expect(p.connectionsInUse).toBeNull();
            expect(p.healthy).toBeNull();
        });

        it("a non-object oracle block or pool entry is skipped", () => {
            const m = mergeMetricsSnapshots([
                part(1, snap({ dependencies: { oracle: "x" } })),
                part(2, snap({ dependencies: { oracle: { app: "x", other: pool() } } })),
            ])!;
            expect(Object.keys(m.dependencies.oracle)).toEqual(["other"]);
        });
    });

    describe("notifications and smtp", () => {
        const chan = (o: Record<string, any> = {}) => ({ sent: 1, failed: 0, consecutiveFailures: 0, lastSuccessAt: null, lastFailureAt: null, lastFailureCause: null, suppressedCount: 0, ...o });

        it("sums per channel, keeps the latest timestamps and the cause of the latest failure", () => {
            const m = mergeMetricsSnapshots([
                part(1, snap({ notifications: { mail: chan({ sent: 5, failed: 1, lastSuccessAt: "2026-01-01T00:00:00Z", lastFailureAt: "2026-01-02T00:00:00Z", lastFailureCause: "old", consecutiveFailures: 1, suppressedCount: 2 }) } })),
                part(2, snap({ notifications: { mail: chan({ sent: 3, failed: 2, lastSuccessAt: "2026-01-03T00:00:00Z", lastFailureAt: "2026-01-04T00:00:00Z", lastFailureCause: "new", consecutiveFailures: 2 }), other: chan() } })),
            ])!;
            const mail = m.notifications.mail;
            expect(mail).toMatchObject({ sent: 8, failed: 3, suppressedCount: 2, consecutiveFailures: 2, lastSuccessAt: "2026-01-03T00:00:00Z", lastFailureAt: "2026-01-04T00:00:00Z", lastFailureCause: "new" });
            expect(m.dependencies.smtp.status).toBe("degraded");
            expect(m.dependencies.smtp.lastFailureAt).toBe("2026-01-04T00:00:00Z");
        });

        it("an older failure does not overwrite a newer one; non-string cause becomes null", () => {
            const m = mergeMetricsSnapshots([
                part(1, snap({ notifications: { mail: chan({ lastFailureAt: "2026-02-01T00:00:00Z", lastFailureCause: "keep" }) } })),
                part(2, snap({ notifications: { mail: chan({ lastFailureAt: "2026-01-01T00:00:00Z", lastFailureCause: "stale" }) } })),
                part(3, snap({ notifications: { x: chan({ lastFailureAt: "2026-01-01T00:00:00Z", lastFailureCause: 5 }) } })),
            ])!;
            expect(m.notifications.mail.lastFailureCause).toBe("keep");
            expect(m.notifications.x.lastFailureCause).toBeNull();
        });

        it("smtp is 'down' from 3 consecutive failures and 'up' from none; junk notification blocks are skipped", () => {
            const down = mergeMetricsSnapshots([part(1, snap({ notifications: { mail: chan({ consecutiveFailures: 3 }) } }))])!;
            expect(down.dependencies.smtp.status).toBe("down");
            const up = mergeMetricsSnapshots([part(1, snap({ notifications: "nope" })), part(2, snap({ notifications: { mail: "nope" } }))])!;
            expect(up.dependencies.smtp).toEqual({ status: "up", consecutiveFailures: 0, lastSuccessAt: null, lastFailureAt: null });
            expect(up.notifications).toEqual({});
        });

        it("smtp lastSuccessAt is the latest across channels and an empty-string timestamp counts as none", () => {
            const m = mergeMetricsSnapshots([part(1, snap({ notifications: { a: chan({ lastSuccessAt: "2026-01-01T00:00:00Z" }), b: chan({ lastSuccessAt: "2026-03-01T00:00:00Z" }), c: chan({ lastSuccessAt: "" }) } }))])!;
            expect(m.dependencies.smtp.lastSuccessAt).toBe("2026-03-01T00:00:00Z");
        });
    });

    describe("frontend lists and watchdog", () => {
        it("frontend lists are merged by timestamp and capped at the newest 500", () => {
            const a = Array.from({ length: 400 }, (_, i) => ({ ts: `2026-01-01T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`, n: i }));
            const b = [{ ts: "2027-01-01T00:00:00Z", n: "newest" }, { n: "no-ts" }, "junk"];
            const m = mergeMetricsSnapshots([
                part(1, snap({ frontendVitals: a, frontendErrors: [{ ts: "1" }] })),
                part(2, snap({ frontendVitals: [...a, ...b], frontendErrors: "nope" })),
            ])!;
            expect(m.frontendVitals).toHaveLength(500);
            expect(m.frontendVitals.at(-1)).toEqual(b[0]);
            expect(m.frontendErrors).toEqual([{ ts: "1" }]);
        });

        it("watchdog terminations are summed per route, top routes first; junk blocks are skipped", () => {
            const m = mergeMetricsSnapshots([
                part(1, snap({ watchdog: { terminated: 3, byRoute: { a: 1, b: 2 } } })),
                part(2, snap({ watchdog: { terminated: 4, byRoute: { a: 5, c: "x" } } })),
                part(3, snap({ watchdog: "nope" })),
                part(4, snap({ watchdog: { terminated: 1, byRoute: "nope" } })),
            ])!;
            expect(m.watchdog.terminated).toBe(8);
            expect(Object.entries(m.watchdog.byRoute)).toEqual([["a", 6], ["b", 2], ["c", 0]]);
        });

        it("watchdog keeps only the 200 busiest routes", () => {
            const byRoute = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`r${i}`, i + 1]));
            const m = mergeMetricsSnapshots([part(1, snap({ watchdog: { terminated: 0, byRoute } }))])!;
            expect(Object.keys(m.watchdog.byRoute)).toHaveLength(200);
            expect(m.watchdog.byRoute.r249).toBe(250);
            expect(m.watchdog.byRoute.r0).toBeUndefined();
        });
    });
});
