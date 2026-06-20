"use strict";

/**
 * Unit tests for AuditLogModel._reduceCategoryGroups — the pure reducer that
 * turns a `GROUP BY STATUS_CATEGORY` aggregate into total + per-category counts.
 *
 * Core guarantee: total === Σ(all category counts), including categories outside
 * 2xx–5xx, so the dashboard's Total never disagrees with the sum of its buckets
 * (the previous five-separate-query approach could produce Success+Redirect>Total).
 */

const AuditLogModel = require("../../../../src/models/audit.log.model");

describe("AuditLogModel._reduceCategoryGroups", function () {
    it("returns all-zero buckets for an empty/undefined result", function () {
        for (const input of [[], null, undefined]) {
            const r = AuditLogModel._reduceCategoryGroups(input);
            expect(r.total).toBe(0);
            expect(r.totalRespTime).toBe(0);
            expect(r.buckets).toEqual({
                "2xx": 0,
                "3xx": 0,
                "4xx": 0,
                "5xx": 0,
            });
        }
    });

    it("reconciles total with the sum of category buckets (screenshot data)", function () {
        const r = AuditLogModel._reduceCategoryGroups([
            { STATUS_CATEGORY: "2xx", CNT: 63, RESPTIME: 693 },
            { STATUS_CATEGORY: "3xx", CNT: 3, RESPTIME: 0 },
            { STATUS_CATEGORY: "4xx", CNT: 7, RESPTIME: 0 },
        ]);
        expect(r.total).toBe(73);
        expect(r.buckets["2xx"]).toBe(63);
        expect(r.buckets["3xx"]).toBe(3);
        expect(r.buckets["4xx"]).toBe(7);
        expect(r.buckets["5xx"]).toBe(0);
        const sum = Object.values(r.buckets).reduce((a, b) => a + b, 0);
        expect(sum).toBe(r.total); // never Success + Redirect > Total again
    });

    it("trims CHAR-padded category values so they still bucket", function () {
        const r = AuditLogModel._reduceCategoryGroups([
            { STATUS_CATEGORY: "4xx   ", CNT: 5, RESPTIME: 0 },
        ]);
        expect(r.buckets["4xx"]).toBe(5);
    });

    it("counts uncategorised rows toward total but no bucket (visible signal)", function () {
        const r = AuditLogModel._reduceCategoryGroups([
            { STATUS_CATEGORY: "2xx", CNT: 10, RESPTIME: 0 },
            { STATUS_CATEGORY: null, CNT: 2, RESPTIME: 0 }, // uncategorised
            { STATUS_CATEGORY: "1xx", CNT: 1, RESPTIME: 0 }, // outside 2xx–5xx
        ]);
        expect(r.total).toBe(13);
        const known = Object.values(r.buckets).reduce((a, b) => a + b, 0);
        expect(known).toBe(10);
        expect(r.total).toBeGreaterThan(known); // inflated total flags uncategorised rows
    });

    it("coerces non-numeric CNT/RESPTIME safely", function () {
        const r = AuditLogModel._reduceCategoryGroups([
            { STATUS_CATEGORY: "5xx", CNT: undefined, RESPTIME: undefined },
        ]);
        expect(r.total).toBe(0);
        expect(r.totalRespTime).toBe(0);
    });
});
