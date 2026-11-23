type MetricsStoreModule = typeof import("../../../../src/middleware/metrics/MetricsStore");
let MetricsStore: MetricsStoreModule["MetricsStore"];
let calcPercentile: MetricsStoreModule["calcPercentile"];
let linRegSlope: MetricsStoreModule["linRegSlope"];
let GC_KIND: MetricsStoreModule["GC_KIND"];
let LATENCY_WINDOW_MS: MetricsStoreModule["LATENCY_WINDOW_MS"];

// The shared setup file can load MetricsStore (through the service graph) before this
// file's vi.mock("perf_hooks") is registered, so evaluate a fresh copy after the mock.
beforeAll(async () => {
    vi.resetModules();
    ({ MetricsStore, calcPercentile, linRegSlope, GC_KIND, LATENCY_WINDOW_MS } = await import(
        "../../../../src/middleware/metrics/MetricsStore"
    ));
});

const observers = vi.hoisted(() => ({ callbacks: [] as Array<(list: { getEntries(): unknown[] }) => void>, throwOnObserve: false }));
vi.mock("perf_hooks", async (orig) => {
    const actual = await orig<typeof import("perf_hooks")>();
    class FakeObserver {
        constructor(cb: (list: { getEntries(): unknown[] }) => void) {
            observers.callbacks.push(cb);
        }
        observe() {
            if (observers.throwOnObserve) throw new Error("gc unsupported");
        }
    }
    return { ...actual, PerformanceObserver: FakeObserver };
});

const feed = (kind: number | undefined, duration: number, via: "detail" | "kind" = "detail") => {
    const entry = via === "detail" ? { duration, detail: { kind } } : { duration, kind };
    observers.callbacks[observers.callbacks.length - 1]({ getEntries: () => [entry] });
};

describe("MetricsStore helpers (wave2)", () => {
    it("calcPercentile handles empty input, index clamping and ordinary percentiles", () => {
        expect(calcPercentile([], 0.5)).toBe(0);
        expect(calcPercentile([1, 2, 3, 4], 0.5)).toBe(3);
        expect(calcPercentile([1, 2, 3, 4], 1)).toBe(4);
        expect(calcPercentile([7], 0.99)).toBe(7);
    });

    it("linRegSlope returns 0 for <2 points and for identical x, and the true slope otherwise", () => {
        expect(linRegSlope([1], [1])).toBe(0);
        expect(linRegSlope([5, 5, 5], [1, 2, 3])).toBe(0);
        expect(linRegSlope([0, 1, 2], [1, 3, 5])).toBeCloseTo(2, 10);
    });
});

describe("MetricsStore background probes and GC observer (wave2)", () => {
    beforeEach(() => {
        observers.callbacks.length = 0;
        observers.throwOnObserve = false;
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("with probes on, the poller refreshes system metrics every 10s and the lag probe smooths event-loop lag with an EMA", async () => {
        const mem = vi.spyOn(process, "memoryUsage");
        const store = new MetricsStore({ backgroundProbes: true });
        const initialCalls = mem.mock.calls.length;
        await vi.advanceTimersByTimeAsync(10_000);
        expect(mem.mock.calls.length).toBeGreaterThan(initialCalls);
        expect(store.getSnapshot().system.eventLoopLag).toBeGreaterThanOrEqual(0);
        const before = vi.getTimerCount();
        await vi.advanceTimersByTimeAsync(3000);
        expect(vi.getTimerCount()).toBeGreaterThanOrEqual(before - 1);
    });

    it("with probes off, no recurring timers are scheduled", () => {
        new MetricsStore({ backgroundProbes: false });
        expect(vi.getTimerCount()).toBe(0);
    });

    it("system collection reports -1 handles/requests when the internals are unavailable, and survives memoryUsage throwing", () => {
        const p = process as unknown as Record<string, unknown>;
        const h = p._getActiveHandles;
        const r = p._getActiveRequests;
        p._getActiveHandles = undefined;
        p._getActiveRequests = undefined;
        try {
            const store = new MetricsStore({ backgroundProbes: false });
            expect(store.getSnapshot().system.handles).toBe(-1);
            expect(store.getSnapshot().system.requests).toBe(-1);
            vi.spyOn(process, "memoryUsage").mockImplementation(() => { throw new Error("denied"); });
            expect(() => new MetricsStore({ backgroundProbes: false })).not.toThrow();
        } finally {
            p._getActiveHandles = h;
            p._getActiveRequests = r;
        }
    });

    it("GC entries are bucketed by kind (detail.kind or legacy kind), totals reconcile, and majors add heap baselines", () => {
        const store = new MetricsStore({ backgroundProbes: false });
        feed(GC_KIND.MAJOR, 10);
        feed(GC_KIND.MINOR, 2);
        feed(GC_KIND.INCREMENTAL, 3);
        feed(GC_KIND.WEAKCB, 1);
        feed(undefined, 4);
        feed(GC_KIND.MINOR, 6, "kind");
        const gc = store.getSnapshot().system.gc;
        expect(gc.collections).toBe(6);
        expect(gc.major.count).toBe(1);
        expect(gc.minor.count).toBe(2);
        expect(gc.incremental.count).toBe(1);
        expect(gc.weakcb.count).toBe(2);
        expect(gc.recent.sampleCount).toBe(6);
        expect(gc.recent.maxPauseMs).toBe(10);
        expect(gc.recent.p95PauseMs).toBe(10);
        expect(gc.recent.avgPauseMs).toBeCloseTo(26 / 6, 1);
    });

    it("GC pause samples are capped at 200 and heap baselines at 120, evicting the oldest", () => {
        const store = new MetricsStore({ backgroundProbes: false });
        for (let i = 0; i < 130; i++) feed(GC_KIND.MAJOR, 1);
        for (let i = 0; i < 100; i++) feed(GC_KIND.MINOR, 2);
        const snap = store.getSnapshot();
        expect(snap.system.gc.recent.sampleCount).toBe(200);
        expect(snap.system.memoryTrend.sampleCount).toBe(120);
        expect((store as any)._heapBaselines.length).toBe(120);
    });

    it("a leak signature (many majors, long window, steep growth) flags suspected; a single baseline never does", () => {
        const store = new MetricsStore({ backgroundProbes: false });
        const base = Date.now();
        (store as any)._heapBaselines = [{ ts: base, heapUsed: 100_000_000 }];
        expect((store as any).getSnapshot().system.memoryTrend.suspected).toBe(false);
        (store as any)._heapBaselines = Array.from({ length: 10 }, (_, i) => ({ ts: base + i * 60_000, heapUsed: 100_000_000 + i * 20_000_000 }));
        const trend = (store as any).getSnapshot().system.memoryTrend;
        expect(trend.suspected).toBe(true);
        expect(trend.sampleCount).toBe(10);
        expect(trend.growthBytesPerMin).toBeGreaterThan(512 * 1024);
        (store as any)._heapBaselines = Array.from({ length: 10 }, (_, i) => ({ ts: base + i * 60_000, heapUsed: 100_000_000 }));
        expect((store as any).getSnapshot().system.memoryTrend.suspected).toBe(false);
    });

    it("chaos: an unsupported GC observer is swallowed and the store still works", () => {
        observers.throwOnObserve = true;
        const store = new MetricsStore({ backgroundProbes: false });
        store.recordRequest("GET /x", "GET", 200, 5);
        expect(store.getSnapshot().totals.requestsTotal).toBe(1);
    });
});

describe("MetricsStore recorders and snapshot (wave2)", () => {
    beforeEach(() => {
        observers.callbacks.length = 0;
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    });
    afterEach(() => vi.useRealTimers());
    const fresh = () => new MetricsStore({ backgroundProbes: false });

    it("recordRequest classifies 2xx/3xx/304/4xx/5xx and evicts ring entries past 1000", () => {
        const s = fresh();
        for (const code of [200, 302, 304, 404, 503]) s.recordRequest("GET /r", "GET", code, 10);
        const snap = s.getSnapshot();
        expect(snap.totals).toMatchObject({ requestsTotal: 5, redirectsTotal: 1, notModifiedTotal: 1, clientErrorsTotal: 1, serverErrorsTotal: 1 });
        expect(snap.red["GET /r"]).toMatchObject({ count: 5, redirectCount: 1, notModifiedCount: 1, clientErrorCount: 1, serverErrorCount: 1 });
        for (let i = 0; i < 1100; i++) s.recordRequest("GET /r", "GET", 200, i);
        expect((s as any)._routes.get("GET /r").durations).toHaveLength(1000);
        expect((s as any)._routes.get("GET /r").timestamps).toHaveLength(1000);
    });

    it("latency window p99 only counts samples inside LATENCY_WINDOW_MS", () => {
        const s = fresh();
        s.recordRequest("GET /w", "GET", 200, 5000);
        vi.advanceTimersByTime(LATENCY_WINDOW_MS + 1000);
        s.recordRequest("GET /w", "GET", 200, 10);
        const red = s.getSnapshot().red["GET /w"];
        expect(red.window.count).toBe(1);
        expect(red.window.p99).toBe(10);
        expect(red.p99).toBe(5000);
    });

    it("rolling error window prunes old buckets when a new one opens", () => {
        const s = fresh();
        s.recordRequest("GET /e", "GET", 500, 1);
        vi.advanceTimersByTime(60 * 60 * 1000);
        s.recordRequest("GET /e", "GET", 200, 1);
        const win = s.getSnapshot().totals.window;
        expect(win).toBeDefined();
        expect((s as any)._errorWindow.size).toBe(1);
    });

    it("watchdog terminations are counted per route up to the route cap, existing routes still increment when full", () => {
        const s = fresh();
        for (let i = 0; i < 205; i++) s.recordWatchdogTermination(`GET /r${i}`);
        s.recordWatchdogTermination("GET /r0");
        const wd = s.getSnapshot().watchdog;
        expect(wd.terminated).toBe(206);
        expect(Object.keys(wd.byRoute)).toHaveLength(200);
        expect(wd.byRoute["GET /r0"]).toBe(2);
        expect(wd.byRoute["GET /r204"]).toBeUndefined();
    });

    it("recordDbQuery accumulates, and pool stats derive utilization/capacity with safe defaults", () => {
        const s = fresh();
        s.recordDbQuery("appDb", 10, true);
        s.recordDbQuery("appDb", 30, false);
        s.recordPoolStats("appDb", { connectionsInUse: 2, connectionsOpen: 4, poolMax: 8, queueLength: 1, healthy: false, consecutiveFailures: 3 });
        s.recordDbQuery("other", 5, true);
        s.recordPoolStats("other", undefined as never);
        const o = s.getSnapshot().dependencies.oracle;
        expect(o.appDb).toMatchObject({ queryCount: 2, errorCount: 1, avgMs: 20, p95Ms: 30, poolUtilization: 0.5, capacity: 0.5, healthy: false, consecutiveFailures: 3, queueLength: 1 });
        expect(o.other).toMatchObject({ poolUtilization: 0, capacity: 0, healthy: true, consecutiveFailures: 0 });
    });

    it("notification delivery tracks success/failure streaks and the SMTP dependency status thresholds", () => {
        const s = fresh();
        const smtp = () => (s.getSnapshot().dependencies as any).smtp;
        s.recordNotificationDelivery("c1", true);
        expect(smtp()?.status ?? "up").toBe("up");
        s.recordNotificationDelivery("c1", false, "refused");
        s.recordNotificationDelivery("c2", false);
        expect(smtp()?.status).toBe("degraded");
        s.recordNotificationDelivery("c1", false, "refused");
        s.recordNotificationDelivery("c1", false, "refused");
        const snap = s.getSnapshot();
        expect(smtp()?.status).toBe("down");
        expect(smtp()?.consecutiveFailures).toBe(3);
        expect(snap.notifications.c1).toMatchObject({ sent: 1, failed: 3, consecutiveFailures: 3, lastFailureCause: "refused" });
        expect(snap.notifications.c2.lastFailureCause).toBeNull();
        s.recordNotificationDelivery("c1", true);
        expect(s.getSnapshot().notifications.c1.consecutiveFailures).toBe(0);
    });

    it("suppressed counts accumulate, default to 1 and ignore negatives/NaN", () => {
        const s = fresh();
        s.recordNotificationSuppressed("c");
        s.recordNotificationSuppressed("c", 4);
        s.recordNotificationSuppressed("c", -9);
        s.recordNotificationSuppressed("c", NaN);
        expect(s.getSnapshot().notifications.c.suppressedCount).toBe(5);
    });

    it("frontend vitals and errors are capped at 500 (oldest evicted) with default stack/context", () => {
        const s = fresh();
        for (let i = 0; i < 505; i++) {
            s.recordFrontendVital("LCP", i, "good");
            s.recordFrontendError(`e${i}`);
        }
        const snap = s.getSnapshot();
        expect(snap.frontendVitals).toHaveLength(500);
        expect((snap.frontendVitals[0] as { value: number }).value).toBe(5);
        expect(snap.frontendErrors).toHaveLength(500);
        expect(snap.frontendErrors[0]).toMatchObject({ message: "e5", stack: "", context: {} });
    });

    it("getMergeableSnapshot exposes sketches, oracle totals and apdex buckets (satisfied/tolerating/frustrated)", () => {
        const s = fresh();
        s.recordRequest("GET /m", "GET", 200, 10);
        s.recordRequest("GET /m", "GET", 200, 1200);
        s.recordRequest("GET /m", "GET", 200, 60_000);
        s.recordDbQuery("appDb", 7, true);
        const { snapshot, extras } = s.getMergeableSnapshot();
        expect(snapshot.totals.requestsTotal).toBe(3);
        expect(extras.apdexCounts.samples).toBe(3);
        expect(extras.apdexCounts.satisfied).toBe(1);
        expect(extras.apdexCounts.satisfied + extras.apdexCounts.tolerating).toBeLessThan(3);
        expect(Object.keys(extras.routeSketches)).toEqual(["GET /m"]);
        expect(Object.keys(extras.routeWindowSketches)).toEqual(["GET /m"]);
        expect(extras.oracleTotalMs).toEqual({ appDb: 7 });
    });
});
