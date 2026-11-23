/**
 * @fileoverview Unit tests for IntegrityController.parseFilters — scope parsing,
 * date validation and the filter-key allow pattern (no operator/SQL smuggling).
 */
import "../../../../src/config/cacheStores";
import IntegrityController from "../../../../src/controllers/IntegrityController";

const parse = IntegrityController.parseFilters;

describe("IntegrityController.parseFilters", () => {
    it("returns null dates and no filters for an empty scope", () => {
        expect(parse({})).toEqual({ from: null, to: null });
        expect(parse()).toEqual({ from: null, to: null });
    });

    it("parses ISO strings, epoch numbers and Date objects", () => {
        const out = parse({ from: "2026-01-01T00:00:00Z", to: 1_800_000_000_000 });
        expect((out.from as Date).toISOString()).toBe("2026-01-01T00:00:00.000Z");
        expect((out.to as Date).getTime()).toBe(1_800_000_000_000);
        const d = new Date("2026-03-03T00:00:00Z");
        expect(parse({ from: d }).from).toEqual(d);
    });

    it("treats empty-string and null dates as absent", () => {
        expect(parse({ from: "", to: null })).toEqual({ from: null, to: null });
    });

    it("rejects an unparseable date with 400 naming the field", () => {
        expect(() => parse({ from: "not-a-date" })).toThrow(expect.objectContaining({ statusCode: 400 }));
        expect(() => parse({ to: "garbage" })).toThrow(expect.objectContaining({ statusCode: 400 }));
    });

    it("rejects from > to but accepts from == to", () => {
        expect(() => parse({ from: "2026-02-01", to: "2026-01-01" })).toThrow(expect.objectContaining({ statusCode: 400 }));
        expect(() => parse({ from: "2026-01-01", to: "2026-01-01" })).not.toThrow();
    });

    it("keeps only non-empty string filters with safe names", () => {
        const out = parse({
            customer: "7",
            status: "",
            page: "2",
            limit: "9",
            mode: "all",
            table: "x",
            "bad-key": "v",
            "1abc": "v",
            "a'; DROP": "v",
            ["x".repeat(41)]: "v",
            obj: { $ne: null },
            list: ["a"],
            num: 5,
        });
        expect(out).toEqual({ from: null, to: null, customer: "7" });
    });
});
