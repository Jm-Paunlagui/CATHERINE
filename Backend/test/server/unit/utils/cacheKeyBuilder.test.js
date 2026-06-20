"use strict";

const {
    CacheKeyBuilder,
} = require("../../../../src/middleware/cache/CacheKeyBuilder");

describe("CacheKeyBuilder", function () {
    it("produces the same key regardless of parameter insertion order", function () {
        const k1 = CacheKeyBuilder.build("users", {
            division: "WH",
            year: 2025,
            month: 1,
        });
        const k2 = CacheKeyBuilder.build("users", {
            month: 1,
            year: 2025,
            division: "WH",
        });
        expect(k1).toBe(k2);
    });

    it('normalises null and undefined values to the string "null"', function () {
        const k = CacheKeyBuilder.build("users", {
            division: null,
            year: undefined,
        });
        expect(k).toContain("division=null");
        expect(k).toContain("year=null");
    });

    it("sorts array parameters before joining", function () {
        const k1 = CacheKeyBuilder.build("ids", { ids: [3, 1, 2] });
        const k2 = CacheKeyBuilder.build("ids", { ids: [2, 3, 1] });
        expect(k1).toBe(k2);
    });

    it("hashes keys longer than 200 characters", function () {
        const longParams = {};
        for (let i = 0; i < 30; i++) longParams[`param${i}`] = `value${i}`;
        const key = CacheKeyBuilder.build("prefix", longParams);
        expect(key.length).toBeLessThan(220); // hashed — never obscenely long
        expect(key).toContain("h=");
    });

    it("throws TypeError when prefix is empty", function () {
        expect(() => new CacheKeyBuilder("")).toThrow(TypeError);
        expect(() => new CacheKeyBuilder(null)).toThrow(TypeError);
    });

    it("fluent builder and static build() produce identical keys", function () {
        const fluent = CacheKeyBuilder.of("report")
            .param("year", 2025)
            .param("month", 3)
            .build();
        const stat = CacheKeyBuilder.build("report", { year: 2025, month: 3 });
        expect(fluent).toBe(stat);
    });
});
