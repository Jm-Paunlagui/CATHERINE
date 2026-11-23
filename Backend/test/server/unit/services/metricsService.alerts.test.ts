import MetricsService from "../../../../src/services/MetricsService";
import { metricsStore } from "../../../../src/middleware/metrics";
import { logger } from "../../../../src/utils/logger";

const MB = 1024 * 1024;

/** Healthy baseline snapshot; each case overrides the block it exercises. */
function snap(over: Record<string, any> = {}): any {
    return {
        uptime: 100,
        red: {},
        totals: { window: { windowMs: 300_000, requests: 100, clientErrors: 0, serverErrors: 0, serviced: 100, errorRate: 0, availability: 1 } },
        system: {
            memory: { heapUsed: 10 * MB, heapTotal: 50 * MB, heapSizeLimit: 100 * MB },
            eventLoopLag: 1,
            gc: { overheadPct: 0, major: { count: 0 } },
            memoryTrend: { suspected: false },
        },
        dependencies: { oracle: {}, smtp: { status: "up", consecutiveFailures: 0, lastFailureAt: null } },
        ...over,
    };
}
const rules = (s: any) => MetricsService.evaluateAlerts(s).map((a) => `${a.rule}:${a.severity}${a.pool ? `:${a.pool}` : ""}${a.route ? `:${a.route}` : ""}`);
const win = (serviced: number, errorRate: number) => ({ windowMs: 300_000, requests: serviced, clientErrors: 0, serverErrors: Math.round(serviced * errorRate), serviced, errorRate, availability: 1 });

describe("MetricsService.evaluateAlerts", () => {
    beforeEach(() => {
        for (const m of ["critical", "warning", "notice", "info", "debug"] as const) vi.spyOn(logger, m).mockImplementation((() => undefined) as any);
    });
    afterEach(() => { vi.restoreAllMocks(); });

    it("a healthy snapshot raises nothing and logs nothing", () => {
        expect(rules(snap())).toEqual([]);
        expect(logger.critical).not.toHaveBeenCalled();
        expect(logger.warning).not.toHaveBeenCalled();
    });

    it("a snapshot with no totals.window never fires the error-rate rule", () => {
        expect(rules(snap({ totals: {} }))).toEqual([]);
    });

    describe("HIGH_ERROR_RATE", () => {
        it("stays quiet below the minimum sample floor even at a 100% error rate", () => {
            expect(rules(snap({ totals: { window: win(49, 1) } }))).toEqual([]);
        });
        it("stays quiet at or below the warning threshold", () => {
            expect(rules(snap({ totals: { window: win(1000, 0.01) } }))).toEqual([]);
        });
        it("warns above 1% and goes critical above 5%, with the critical logger on critical", () => {
            expect(rules(snap({ totals: { window: win(1000, 0.02) } }))).toEqual(["HIGH_ERROR_RATE:warning"]);
            expect(logger.warning).toHaveBeenCalledTimes(1);
            expect(rules(snap({ totals: { window: win(1000, 0.2) } }))).toEqual(["HIGH_ERROR_RATE:critical"]);
            expect(logger.critical).toHaveBeenCalledTimes(1);
        });
        it("never lets the logger tap double-notify", () => {
            rules(snap({ totals: { window: win(1000, 0.2) } }));
            expect((logger.critical as any).mock.calls[0][1]._noNotify).toBe(true);
        });
        it("describes the window length and the threshold that fired", () => {
            const [a] = MetricsService.evaluateAlerts(snap({ totals: { window: win(1000, 0.2) } })) as any[];
            expect(a.description).toContain("5 min");
            expect(a.description).toContain("threshold: 5%");
            expect(a.value).toBe(0.2);
        });
    });

    describe("HIGH_LATENCY", () => {
        const red = (route: string, count: number, p99: number) => ({ [route]: { window: { windowMs: 300_000, count, p99 } } });
        it("fires per route above the default 5s budget with enough samples", () => {
            expect(rules(snap({ red: red("GET /a", 20, 5001) }))).toEqual(["HIGH_LATENCY:warning:GET /a"]);
        });
        it("is quiet at the threshold, with too few samples, or with no window", () => {
            expect(rules(snap({ red: red("GET /a", 20, 5000) }))).toEqual([]);
            expect(rules(snap({ red: red("GET /a", 19, 99_999) }))).toEqual([]);
            expect(rules(snap({ red: { "GET /a": {} } }))).toEqual([]);
            expect(rules(snap({ red: { "GET /a": null } }))).toEqual([]);
        });
        it("bulk save and export routes get the 170s budget", () => {
            expect(rules(snap({ red: red("POST /api/v1/x/save", 20, 100_000) }))).toEqual([]);
            expect(rules(snap({ red: red("GET /api/v1/x/export/", 20, 100_000) }))).toEqual([]);
            expect(rules(snap({ red: red("POST /api/v1/x/save", 20, 171_000) }))).toEqual(["HIGH_LATENCY:warning:POST /api/v1/x/save"]);
        });
    });

    describe("heap", () => {
        const heap = (used: number, limit = 100 * MB) => snap({ system: { ...snap().system, memory: { heapUsed: used, heapTotal: limit, heapSizeLimit: limit } } });
        it("warns above 75% and is critical above 90%", () => {
            expect(rules(heap(80 * MB))).toEqual(["HIGH_HEAP:warning"]);
            expect(rules(heap(95 * MB))).toEqual(["HIGH_HEAP:critical"]);
            expect(rules(heap(75 * MB))).toEqual([]);
        });
        it("a zero heap limit reads as 0% rather than dividing by zero", () => {
            expect(rules(heap(50 * MB, 0))).toEqual([]);
        });
    });

    it("raises EVENT_LOOP_LAG above 100ms only", () => {
        const lag = (v: number) => snap({ system: { ...snap().system, eventLoopLag: v } });
        expect(rules(lag(100))).toEqual([]);
        expect(rules(lag(101))).toEqual(["EVENT_LOOP_LAG:warning"]);
    });

    describe("GC overhead", () => {
        const gc = (pct: number | undefined) => snap({ system: { ...snap().system, gc: pct === undefined ? undefined : { overheadPct: pct, major: { count: 2 } } } });
        it("warns above 5% and is critical above 10%", () => {
            expect(rules(gc(5))).toEqual([]);
            expect(rules(gc(6))).toEqual(["HIGH_GC_OVERHEAD:warning"]);
            expect(rules(gc(11))).toEqual(["HIGH_GC_OVERHEAD:critical"]);
        });
        it("a snapshot without a gc block reads as 0", () => {
            expect(rules(gc(undefined))).toEqual([]);
        });
    });

    it("flags a suspected memory leak with the growth per minute", () => {
        const s = snap({ system: { ...snap().system, memoryTrend: { suspected: true, growthBytesPerMin: 5 * MB, windowMs: 600_000, sampleCount: 8, firstHeapUsed: MB, lastHeapUsed: 9 * MB } } });
        const [a] = MetricsService.evaluateAlerts(s) as any[];
        expect(a.rule).toBe("MEMORY_LEAK_SUSPECTED");
        expect(a.description).toContain("5.00 MB/min");
        expect(a.description).toContain("10 min");
    });

    describe("oracle pools", () => {
        const pool = (o: Record<string, any>) => snap({ dependencies: { oracle: { app: { connectionsInUse: 1, connectionsOpen: 2, poolMax: 10, ...o } }, smtp: undefined } });
        it("saturation: warning above 80%, critical above 95%, ignored when null", () => {
            expect(rules(pool({ poolUtilization: 0.8 }))).toEqual([]);
            expect(rules(pool({ poolUtilization: 0.9 }))).toEqual(["ORACLE_POOL_SATURATION:warning:app"]);
            expect(rules(pool({ poolUtilization: 0.99 }))).toEqual(["ORACLE_POOL_SATURATION:critical:app"]);
            expect(rules(pool({ poolUtilization: null }))).toEqual([]);
        });
        it("queue backlog: warning from 3 waiters, critical from 10, ignored below or when absent", () => {
            expect(rules(pool({ queueLength: 2 }))).toEqual([]);
            expect(rules(pool({ queueLength: 3 }))).toEqual(["ORACLE_POOL_QUEUE_BACKLOG:warning:app"]);
            expect(rules(pool({ queueLength: 10 }))).toEqual(["ORACLE_POOL_QUEUE_BACKLOG:critical:app"]);
            expect(rules(pool({ queueLength: null }))).toEqual([]);
        });
        it("DOWN when unhealthy (failure count defaults to 0)", () => {
            expect(rules(pool({ healthy: false, consecutiveFailures: 4 }))).toEqual(["ORACLE_POOL_DOWN:critical:app"]);
            const [a] = MetricsService.evaluateAlerts(pool({ healthy: false })) as any[];
            expect(a.value).toBe(0);
            expect(a.description).toContain("0 consecutive");
        });
        it("DEGRADED when healthy but failing; neither when never reported or clean", () => {
            expect(rules(pool({ healthy: true, consecutiveFailures: 1 }))).toEqual(["ORACLE_POOL_DEGRADED:warning:app"]);
            expect(rules(pool({ healthy: true, consecutiveFailures: 0 }))).toEqual([]);
            expect(rules(pool({ healthy: null, consecutiveFailures: 2 }))).toEqual([]);
            expect(rules(pool({ healthy: true, consecutiveFailures: "x" }))).toEqual([]);
        });
        it("a snapshot without a dependencies block raises no pool alerts", () => {
            expect(rules(snap({ dependencies: undefined }))).toEqual([]);
        });
    });

    describe("EMAIL_DELIVERY_FAILING", () => {
        const smtp = (n: number, lastFailureAt: string | null = null) => snap({ dependencies: { oracle: {}, smtp: { status: "degraded", consecutiveFailures: n, lastFailureAt } } });
        it("warns at 1 failure, critical at 3, quiet at 0", () => {
            expect(rules(smtp(0))).toEqual([]);
            expect(rules(smtp(1))).toEqual(["EMAIL_DELIVERY_FAILING:warning"]);
            expect(rules(smtp(3))).toEqual(["EMAIL_DELIVERY_FAILING:critical"]);
        });
        it("reports the last failure time or 'unknown'", () => {
            expect((MetricsService.evaluateAlerts(smtp(1, "2026-01-01T00:00:00Z")) as any[])[0].description).toContain("2026-01-01T00:00:00Z");
            expect((MetricsService.evaluateAlerts(smtp(1)) as any[])[0].description).toContain("unknown");
        });
    });

    it("evaluates the live store snapshot when none is given", () => {
        vi.spyOn(metricsStore, "getSnapshot").mockReturnValue(snap({ system: { ...snap().system, eventLoopLag: 500 } }));
        expect(MetricsService.evaluateAlerts().map((a) => a.rule)).toEqual(["EVENT_LOOP_LAG"]);
    });
});

describe("MetricsService.evaluateAlertHolds", () => {
    const hold = (s: any) => MetricsService.evaluateAlertHolds(s);
    it("holds the global error-rate rule when there is no window or too few serviced requests", () => {
        expect(hold(snap({ totals: {} }))).toContain("HIGH_ERROR_RATE::global");
        expect(hold(snap({ totals: { window: win(10, 0) } }))).toContain("HIGH_ERROR_RATE::global");
        expect(hold(snap())).toEqual([]);
    });
    it("holds a route whose slow window is too thin to judge, but not a thick or fast or empty one", () => {
        const red = {
            "GET /thin": { window: { count: 5, p99: 9000 } },
            "GET /thick": { window: { count: 50, p99: 9000 } },
            "GET /fast": { window: { count: 5, p99: 10 } },
            "GET /empty": { window: { count: 0, p99: 9000 } },
            "GET /none": {},
            "POST /api/x/save": { window: { count: 5, p99: 100_000 } },
        };
        expect(hold(snap({ red }))).toEqual(["HIGH_LATENCY::GET /thin"]);
    });
    it("a degraded or incomplete cluster holds every rule", () => {
        expect(hold(snap({ cluster: { degraded: true, missing: [] } }))).toContain("*");
        expect(hold(snap({ cluster: { missing: [2] } }))).toContain("*");
        expect(hold(snap({ cluster: { missing: [] } }))).not.toContain("*");
        expect(hold(snap({ cluster: {} }))).not.toContain("*");
    });
    it("a snapshot with no red block does not throw; with no argument it reads the store", () => {
        expect(hold(snap({ red: undefined }))).toEqual([]);
        vi.spyOn(metricsStore, "getSnapshot").mockReturnValue(snap());
        expect(MetricsService.evaluateAlertHolds()).toEqual([]);
        vi.restoreAllMocks();
    });
});

describe("MetricsService.getSummary / getSnapshot", () => {
    afterEach(() => { vi.restoreAllMocks(); });

    it("returns heap in MB, the five slowest routes by p95 and the alert count", () => {
        vi.spyOn(logger, "warning").mockImplementation((() => undefined) as any);
        const red = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`r${i}`, { p95: i * 10, count: 1 }]));
        const s = snap({ red, system: { ...snap().system, eventLoopLag: 500, memory: { heapUsed: 10 * MB, heapTotal: 20 * MB, heapSizeLimit: 100 * MB } } });
        const sum = MetricsService.getSummary(s);
        expect(sum.topSlowRoutes.map((r) => r.route)).toEqual(["r6", "r5", "r4", "r3", "r2"]);
        expect(sum.system).toEqual({ heapUsedMb: 10, heapTotalMb: 20, heapLimitMb: 100, eventLoopLag: 500 });
        expect(sum.alertCount).toBe(1);
        expect(sum.uptime).toBe(100);
    });

    it("reads the store when no snapshot is passed", () => {
        vi.spyOn(metricsStore, "getSnapshot").mockReturnValue(snap());
        expect(MetricsService.getSummary().alertCount).toBe(0);
    });

    it("getSnapshot wraps a store failure in a 503 AppError carrying the cause as hint", () => {
        vi.spyOn(metricsStore, "getSnapshot").mockImplementation(() => { throw new Error("store exploded"); });
        try {
            MetricsService.getSnapshot();
            expect.unreachable("should throw");
        } catch (err: any) {
            expect(err.statusCode).toBe(503);
            expect(err.isOperational).toBe(true);
        }
    });

    it("getClusterSnapshot returns the local snapshot when cluster RPC is inactive", () => {
        const s = snap();
        vi.spyOn(metricsStore, "getSnapshot").mockReturnValue(s);
        expect(MetricsService.getClusterSnapshot()).toBe(s);
    });
});
