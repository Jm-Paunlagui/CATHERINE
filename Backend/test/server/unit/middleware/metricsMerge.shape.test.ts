"use strict";

/**
 * The cluster merge returns the SAME shape as one process's MetricsStore.getSnapshot()
 * (plus `cluster`), so the alert rules, the summary and the alert emails read one type
 * (MetricsSnapshot). These tests merge real store parts and malformed wire parts and
 * check that every typed field comes back with its declared type.
 */

const { MetricsStore } = require("../../../../src/middleware/metrics/MetricsStore");
const { mergeMetricsSnapshots } = require("../../../../src/middleware/metrics/metricsMerge");

/** A worker part as the primary receives it over IPC. */
function partOf(store, workerId) {
    return { workerId, pid: 1000 + workerId, isLeader: workerId === 1, value: store.getMergeableSnapshot() };
}

function sortedKeys(o) {
    return Object.keys(o).sort();
}

describe("metricsMerge — merged snapshot matches MetricsSnapshot", function () {
    let a;
    let b;

    beforeEach(function () {
        a = new MetricsStore();
        b = new MetricsStore();
        a.recordRequest("GET /api/v1/x", "GET", 200, 40);
        a.recordRequest("GET /api/v1/x", "GET", 503, 900);
        b.recordRequest("GET /api/v1/x", "GET", 200, 60);
        b.recordRequest("POST /api/v1/y", "POST", 404, 10);
        a.recordDbQuery("appDb", 12, true);
        b.recordDbQuery("appDb", 30, false);
        a.recordNotificationDelivery("server-system-notification", false, "SMTP timeout");
    });

    it("has every top-level block of a single-process snapshot, plus cluster", function () {
        const single = a.getSnapshot();
        const merged = mergeMetricsSnapshots([partOf(a, 1), partOf(b, 2)]);
        expect(sortedKeys(merged)).toEqual(sortedKeys({ ...single, cluster: null }));
        expect(merged.cluster).toEqual({ workers: 2, responded: 2, missing: [] });
    });

    it("keeps route, pool, totals and system fields with the store's keys", function () {
        const single = a.getSnapshot();
        const merged = mergeMetricsSnapshots([partOf(a, 1), partOf(b, 2)]);

        expect(sortedKeys(merged.red["GET /api/v1/x"])).toEqual(sortedKeys(single.red["GET /api/v1/x"]));
        expect(merged.red["GET /api/v1/x"].count).toBe(3);

        const pool = merged.dependencies.oracle.appDb;
        expect(sortedKeys(pool)).toEqual(sortedKeys({ ...single.dependencies.oracle.appDb, unhealthyWorkers: 0 }));
        expect(pool.queryCount).toBe(2);
        expect(pool.errorCount).toBe(1);

        expect(sortedKeys(merged.totals)).toEqual(sortedKeys(single.totals));
        expect(sortedKeys(merged.system.memory)).toEqual(sortedKeys(single.system.memory));
        expect(sortedKeys(merged.system.memoryTrend)).toEqual(sortedKeys(single.system.memoryTrend));
        expect(merged.system.workers).toHaveLength(2);
        expect(["up", "degraded", "down"]).toContain(merged.dependencies.smtp.status);
    });

    it("normalises malformed wire fields to their declared types", function () {
        const bad = partOf(b, 2);
        bad.value.snapshot = {
            ...bad.value.snapshot,
            system: { ...bad.value.snapshot.system, memory: { heapUsed: "lots" }, memoryTrend: "rising" },
            notifications: {
                "server-system-notification": { failed: 1, lastFailureAt: "2999-01-01T00:00:00.000Z", lastFailureCause: { code: 42 } },
            },
        };
        // Make the malformed worker the "hottest" heap so its memory block is the one copied.
        bad.value.snapshot.system.memory.heapSizeLimit = 1;
        bad.value.snapshot.system.memory.heapUsed = 1;

        const merged = mergeMetricsSnapshots([partOf(a, 1), bad]);

        for (const v of Object.values(merged.system.memory)) expect(typeof v).toBe("number");
        expect(merged.system.memoryTrend).toEqual({
            sampleCount: expect.any(Number),
            windowMs: expect.any(Number),
            growthBytesPerMin: expect.any(Number),
            firstHeapUsed: expect.any(Number),
            lastHeapUsed: expect.any(Number),
            suspected: expect.any(Boolean),
        });
        // A non-string cause from a worker is dropped, never passed through as an object.
        expect(merged.notifications["server-system-notification"].lastFailureCause).toBeNull();
    });

    it("returns null when no part is usable", function () {
        expect(mergeMetricsSnapshots([{ value: {} }, null])).toBeNull();
    });
});
