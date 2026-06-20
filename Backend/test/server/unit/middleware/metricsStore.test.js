"use strict";

/**
 * Unit tests for the MetricsStore RED three-bucket model.
 *
 * Focus: the availability / error-rate computation must EXCLUDE client errors
 * (4xx) and count only successes (2xx/3xx) and server errors (5xx). These tests
 * pin the status-code classification boundaries (399/400/499/500) and the
 * complementary identity availability === 1 - errorRate.
 */

const {
    MetricsStore,
    computeRates,
    CLIENT_ERROR_MIN_STATUS,
    SERVER_ERROR_MIN_STATUS,
} = require("../../../../src/middleware/metrics/MetricsStore");

// A tiny tolerance for floating-point ratio comparisons.
const EPSILON = 1e-9;

describe("MetricsStore — RED three-bucket model", function () {
    describe("status-code boundary constants", function () {
        it("classifies 4xx as client and 5xx as server", function () {
            expect(CLIENT_ERROR_MIN_STATUS).toBe(400);
            expect(SERVER_ERROR_MIN_STATUS).toBe(500);
        });
    });

    describe("computeRates() — pure rate math", function () {
        it("returns 100% availability and 0 error rates for an empty store", function () {
            const r = computeRates(0, 0, 0);
            expect(r.availability).toBe(1);
            expect(r.errorRate).toBe(0);
            expect(r.clientErrorRate).toBe(0);
        });

        it("treats an all-success workload as fully available", function () {
            const r = computeRates(10, 0, 0);
            expect(r.availability).toBe(1);
            expect(r.errorRate).toBe(0);
            expect(r.clientErrorRate).toBe(0);
        });

        it("EXCLUDES client errors from availability and error rate", function () {
            // 10 requests, all 4xx: service rejected bad input correctly.
            const r = computeRates(10, 10, 0);
            expect(r.availability).toBe(1); // serviced denominator is 0 → fully available
            expect(r.errorRate).toBe(0);
            expect(r.clientErrorRate).toBe(1); // but still 100% visible in its own lane
        });

        it("counts server errors fully against availability", function () {
            const r = computeRates(10, 0, 10);
            expect(r.availability).toBe(0);
            expect(r.errorRate).toBe(1);
            expect(r.clientErrorRate).toBe(0);
        });

        it("computes a mixed workload with 4xx removed from the denominator", function () {
            // 8 success, 1 client (4xx), 1 server (5xx) → serviced = 9
            const r = computeRates(10, 1, 1);
            expect(r.availability).toBeCloseTo(8 / 9, EPSILON);
            expect(r.errorRate).toBeCloseTo(1 / 9, EPSILON);
            expect(r.clientErrorRate).toBeCloseTo(1 / 10, EPSILON);
        });

        it("guarantees the identity availability === 1 - errorRate", function () {
            const r = computeRates(100, 17, 6); // arbitrary mix
            expect(r.availability + r.errorRate).toBeCloseTo(1, EPSILON);
        });
    });

    describe("recordRequest() — classification boundaries", function () {
        let store;
        beforeEach(function () {
            store = new MetricsStore();
        });

        function rate(statusCode) {
            store.recordRequest("GET /x", "GET", statusCode, 5);
            return store.getSnapshot().totals;
        }

        it("classifies 399 as success (not an error)", function () {
            const t = rate(399);
            expect(t.serverErrorsTotal).toBe(0);
            expect(t.clientErrorsTotal).toBe(0);
            expect(t.availability).toBe(1);
        });

        it("classifies 400 as a client error", function () {
            const t = rate(400);
            expect(t.clientErrorsTotal).toBe(1);
            expect(t.serverErrorsTotal).toBe(0);
            expect(t.availability).toBe(1); // 4xx excluded
            expect(t.clientErrorRate).toBe(1);
        });

        it("classifies 499 as a client error", function () {
            const t = rate(499);
            expect(t.clientErrorsTotal).toBe(1);
            expect(t.serverErrorsTotal).toBe(0);
        });

        it("classifies 500 as a server error", function () {
            const t = rate(500);
            expect(t.serverErrorsTotal).toBe(1);
            expect(t.clientErrorsTotal).toBe(0);
            expect(t.availability).toBe(0);
            expect(t.errorRate).toBe(1);
        });
    });

    describe("getSnapshot() — per-route and global aggregation", function () {
        let store;
        beforeEach(function () {
            store = new MetricsStore();
        });

        it("exposes the three buckets and derived rates per route", function () {
            // 8×200, 1×404, 1×503 on one route
            for (let i = 0; i < 8; i++)
                store.recordRequest("GET /a", "GET", 200, 5);
            store.recordRequest("GET /a", "GET", 404, 5);
            store.recordRequest("GET /a", "GET", 503, 5);

            const m = store.getSnapshot().red["GET /a"];
            expect(m.count).toBe(10);
            expect(m.clientErrorCount).toBe(1);
            expect(m.serverErrorCount).toBe(1);
            expect(m.availability).toBeCloseTo(8 / 9, EPSILON);
            expect(m.errorRate).toBeCloseTo(1 / 9, EPSILON);
            expect(m.clientErrorRate).toBeCloseTo(1 / 10, EPSILON);
        });

        it("aggregates totals across routes with 4xx excluded from availability", function () {
            store.recordRequest("GET /a", "GET", 200, 5);
            store.recordRequest("GET /b", "GET", 403, 5); // client — excluded
            store.recordRequest("GET /c", "GET", 500, 5); // server — counts

            const t = store.getSnapshot().totals;
            expect(t.requestsTotal).toBe(3);
            expect(t.clientErrorsTotal).toBe(1);
            expect(t.serverErrorsTotal).toBe(1);
            // serviced = 3 - 1 = 2; availability = (2 - 1) / 2 = 0.5
            expect(t.availability).toBeCloseTo(0.5, EPSILON);
            expect(t.errorRate).toBeCloseTo(0.5, EPSILON);
            expect(t.clientErrorRate).toBeCloseTo(1 / 3, EPSILON);
        });
    });
});

describe("MetricsStore — Oracle pool stats (recordPoolStats / USE method)", function () {
    let store;
    beforeEach(function () {
        store = new MetricsStore();
    });

    it("reports no pools when none have been recorded", function () {
        expect(store.getSnapshot().dependencies.oracle).toEqual({});
    });

    it("computes utilization = inUse/open and capacity = open/poolMax", function () {
        store.recordPoolStats("userAccount", {
            connectionsInUse: 17,
            connectionsOpen: 20,
            poolMax: 25,
            queueLength: 0,
        });
        const dep = store.getSnapshot().dependencies.oracle.userAccount;
        expect(dep.poolUtilization).toBe(0.85);
        expect(dep.capacity).toBe(0.8);
        expect(dep.connectionsInUse).toBe(17);
        expect(dep.connectionsOpen).toBe(20);
        expect(dep.poolMax).toBe(25);
    });

    it("never divides by zero when no connections are open", function () {
        store.recordPoolStats("idle", {
            connectionsInUse: 0,
            connectionsOpen: 0,
            poolMax: 10,
            queueLength: 0,
        });
        const dep = store.getSnapshot().dependencies.oracle.idle;
        expect(dep.poolUtilization).toBe(0);
        expect(dep.capacity).toBe(0);
    });

    it("replaces the old null placeholder with a real number once reported", function () {
        store.recordPoolStats("reporting", {
            connectionsInUse: 20,
            connectionsOpen: 20,
            poolMax: 20,
            queueLength: 4,
        });
        const dep = store.getSnapshot().dependencies.oracle.reporting;
        expect(dep.poolUtilization).toBe(1);
        expect(dep.queueLength).toBe(4);
    });

    it("unions per-query stats and pool stats under one pool name", function () {
        store.recordDbQuery("userAccount", 12, true);
        store.recordDbQuery("userAccount", 8, true);
        store.recordPoolStats("userAccount", {
            connectionsInUse: 5,
            connectionsOpen: 10,
            poolMax: 20,
            queueLength: 0,
        });
        const dep = store.getSnapshot().dependencies.oracle.userAccount;
        expect(dep.queryCount).toBe(2);
        expect(dep.avgMs).toBe(10);
        expect(dep.poolUtilization).toBe(0.5);
    });
});
