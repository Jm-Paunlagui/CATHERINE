"use strict";

/**
 * Unit tests for MetricsStore — the memory & GC instrumentation.
 *
 * Companion to metricsStore.test.js (which pins the RED model). This file covers
 * the leak-detection / GC-health additions:
 *   - heapSizeLimit (the real V8 ceiling) is captured in the snapshot
 *   - GC events are bucketed by kind and per-kind counts reconcile with the total
 *   - recent GC pause stats are computed
 *   - the post-major-GC heap-baseline trend ("leak detector") behaves
 *   - linRegSlope math is correct (the engine behind leak detection)
 *
 * Fresh MetricsStore instances are used per test (the class is exported beside
 * the singleton). Background timers are unref'd, so they never keep mocha alive.
 */

const {
    MetricsStore,
    linRegSlope,
    calcPercentile,
    GC_KIND,
} = require("../../../../src/middleware/metrics/MetricsStore");

describe("MetricsStore — memory & GC instrumentation", function () {
    describe("linRegSlope() — leak-trend regression engine", function () {
        it("returns 0 for fewer than two points (undeterminable)", function () {
            expect(linRegSlope([], [])).toBe(0);
            expect(linRegSlope([1], [10])).toBe(0);
        });

        it("returns ~0 for a flat series (no growth = no leak)", function () {
            expect(
                linRegSlope([0, 1000, 2000, 3000, 4000], [50, 50, 50, 50, 50]),
            ).toBeCloseTo(0, 1e-9);
        });

        it("returns a positive slope for a rising series (leak signature)", function () {
            // +0.1 units per ms
            expect(
                linRegSlope([0, 1000, 2000, 3000], [100, 200, 300, 400]),
            ).toBeCloseTo(0.1, 1e-9);
        });

        it("returns a negative slope for a falling series (healthy reclaim)", function () {
            expect(
                linRegSlope([0, 1000, 2000, 3000], [400, 300, 200, 100]),
            ).toBeCloseTo(-0.1, 1e-9);
        });

        it("returns 0 when all x values are identical (zero-denominator guard)", function () {
            expect(linRegSlope([5, 5, 5], [1, 2, 3])).toBe(0);
        });
    });

    describe("getSnapshot() — memory shape", function () {
        let store;
        beforeEach(function () {
            store = new MetricsStore();
        });

        it("exposes heapSizeLimit — the real ceiling, not heapTotal", function () {
            const { memory } = store.getSnapshot().system;
            expect(memory).toHaveProperty("heapSizeLimit");
            expect(memory.heapSizeLimit).toEqual(expect.any(Number));
            expect(memory.heapSizeLimit).toBeGreaterThan(memory.heapTotal);
            expect(memory.heapSizeLimit).toBeGreaterThan(0);
        });

        it("includes heapUsed, heapTotal, rss, external, arrayBuffers", function () {
            const { memory } = store.getSnapshot().system;
            [
                "heapUsed",
                "heapTotal",
                "rss",
                "external",
                "arrayBuffers",
            ].forEach((k) => {
                expect(memory).toHaveProperty(k);
                expect(memory[k]).toEqual(expect.any(Number));
            });
        });
    });

    describe("getSnapshot() — GC breakdown", function () {
        let store;
        beforeEach(function () {
            store = new MetricsStore();
        });

        it("exposes per-kind buckets, overhead, and recent stats", function () {
            const { gc } = store.getSnapshot().system;
            ["major", "minor", "incremental", "weakcb"].forEach((kind) => {
                expect(gc[kind]).toMatchObject({count: expect.anything(), pauseMs: expect.anything()});
            });
            expect(gc).toHaveProperty("overheadPct");
            expect(gc.overheadPct).toEqual(expect.any(Number));
            expect(gc.recent).toMatchObject({sampleCount: expect.anything(), avgPauseMs: expect.anything(), maxPauseMs: expect.anything(), p95PauseMs: expect.anything()});
        });

        it("per-kind collection counts always reconcile with the total (invariant)", function () {
            // Churn allocations so the GC observer fires naturally, then assert the
            // invariant that holds regardless of how many collections actually ran.
            let churn = [];
            for (let i = 0; i < 1_000_000; i++) churn.push({ i, s: String(i) });
            churn = null; // drop the reference so collection is possible

            return new Promise((resolve) => {
                setTimeout(() => {
                    const { gc } = store.getSnapshot().system;
                    const sumByKind =
                        gc.major.count +
                        gc.minor.count +
                        gc.incremental.count +
                        gc.weakcb.count;
                    expect(sumByKind).toBe(gc.collections);
                    expect(gc.pauseMs).toBeGreaterThanOrEqual(0);
                    resolve();
                }, 50);
            });
        });

        it("GC_KIND maps to the documented V8 codes", function () {
            expect(GC_KIND).toEqual({
                MINOR: 1,
                MAJOR: 4,
                INCREMENTAL: 8,
                WEAKCB: 16,
            });
        });
    });

    describe("memoryTrend — leak detector", function () {
        let store;
        beforeEach(function () {
            store = new MetricsStore();
        });

        it('reports "gathering data" (not suspected) with too few baselines', function () {
            store._heapBaselines = [
                { ts: Date.now(), heapUsed: 100 * 1024 * 1024 },
            ];
            const trend = store.getSnapshot().system.memoryTrend;
            expect(trend.suspected).toBe(false);
            expect(trend.sampleCount).toBe(1);
        });

        it("does NOT flag a flat post-GC baseline over a long window", function () {
            const now = Date.now();
            const base = 120 * 1024 * 1024;
            store._heapBaselines = Array.from({ length: 12 }, (_, i) => ({
                ts: now - (11 - i) * 60_000, // one per minute, ~11 min span
                heapUsed: base + (i % 2) * 1024, // jitter only — no real growth
            }));
            const trend = store.getSnapshot().system.memoryTrend;
            expect(trend.suspected).toBe(false);
            expect(Math.abs(trend.growthBytesPerMin)).toBeLessThan(
                512 * 1024,
            );
        });

        it("flags a sustained upward post-GC baseline as a suspected leak", function () {
            const now = Date.now();
            const base = 100 * 1024 * 1024;
            // 12 baselines over ~11 min, +5 MB each → ~5 MB/min, +55% total.
            store._heapBaselines = Array.from({ length: 12 }, (_, i) => ({
                ts: now - (11 - i) * 60_000,
                heapUsed: base + i * 5 * 1024 * 1024,
            }));
            const trend = store.getSnapshot().system.memoryTrend;
            expect(trend.suspected).toBe(true);
            expect(trend.growthBytesPerMin).toBeGreaterThan(512 * 1024);
            expect(trend.lastHeapUsed).toBeGreaterThan(trend.firstHeapUsed);
        });

        it("does NOT flag rapid growth over too SHORT a window (warmup guard)", function () {
            const now = Date.now();
            const base = 100 * 1024 * 1024;
            // Steep climb but only ~90s of observation → must not trip.
            store._heapBaselines = Array.from({ length: 10 }, (_, i) => ({
                ts: now - (9 - i) * 10_000,
                heapUsed: base + i * 20 * 1024 * 1024,
            }));
            expect(store.getSnapshot().system.memoryTrend.suspected).toBe(
                false,
            );
        });
    });

    describe("recent GC pause percentile helper", function () {
        it("calcPercentile returns the high-end sample for p95", function () {
            const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
            expect(calcPercentile(sorted, 0.95)).toBe(10);
            expect(calcPercentile(sorted, 0.5)).toBe(6);
            expect(calcPercentile([], 0.95)).toBe(0);
        });
    });
});
