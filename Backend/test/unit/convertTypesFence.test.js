"use strict";

/**
 * Regression test for the money fence on the legacy ORM `convertTypes` /
 * `rowToDoc` helpers (plan §3.0 rule 3b, §5.2).
 *
 * These helpers are exported for API compatibility but must NEVER re-round a
 * money or rate value. The money-safe `fetchTypeHandler` hands a scaled NUMBER
 * back as a STRING precisely so `Money.from` can parse it exactly; if
 * `convertTypes` coerced it to a double the whole money layer would be undone.
 * The fence: any string with a decimal point (money/rate shape) stays a string.
 */

const {
    convertTypes,
    rowToDoc,
} = require("../../src/utils/oracle-mongo-wrapper/utils");

describe("convertTypes fence — never re-rounds money/rate strings", function () {
    it("leaves a scale-4 money string AS A STRING", function () {
        const out = convertTypes({ AMOUNT: "50000.5000" });
        expect(out.AMOUNT).toBe("50000.5000");
        expect(typeof out.AMOUNT).toBe("string");
    });

    it("leaves a high-precision rate string AS A STRING", function () {
        const out = convertTypes({ RATE: "1.23456789" });
        expect(out.RATE).toBe("1.23456789");
    });

    it("still converts pure-integer ID/count strings to numbers", function () {
        const out = convertTypes({ ID: "42", COUNT: "1000", NAME: "Juan" });
        expect(out.ID).toBe(42);
        expect(out.COUNT).toBe(1000);
        expect(out.NAME).toBe("Juan");
    });

    it("leaves an unsafe-integer string as a string (no precision loss)", function () {
        const big = "9007199254740993"; // MAX_SAFE_INTEGER + 2
        expect(convertTypes({ N: big }).N).toBe(big);
    });

    it("rowToDoc is the same fenced behaviour", function () {
        expect(rowToDoc({ AMOUNT: "10.5000" }).AMOUNT).toBe("10.5000");
        expect(rowToDoc({ ID: "5" }).ID).toBe(5);
    });

    it("passes through null / undefined / non-objects unchanged", function () {
        expect(convertTypes(null)).toBe(null);
        expect(convertTypes(undefined)).toBe(undefined);
        expect(convertTypes({ X: null }).X).toBe(null);
    });
});
