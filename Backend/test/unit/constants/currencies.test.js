"use strict";

/**
 * Unit tests for the ISO 4217 currency registry (src/constants/currencies.js).
 * Pure — no DB, no HTTP.
 */

const {
    CURRENCIES,
    CURRENCY_CODES,
    isValidCurrency,
    getCurrency,
    getDisplayScale,
} = require("../../../src/constants/currencies");

describe("currencies registry", function () {
    it("is frozen and every entry carries the required shape", function () {
        expect(Object.isFrozen(CURRENCIES)).toBe(true);
        for (const code of CURRENCY_CODES) {
            const e = CURRENCIES[code];
            expect(e.code).toBe(code);
            expect(typeof e.displayScale).toBe("number");
            expect(typeof e.symbol).toBe("string");
            expect(typeof e.locale).toBe("string");
            expect(typeof e.name).toBe("string");
            expect(code).toMatch(/^[A-Z]{3}$/); // ISO 4217 three-letter code
        }
    });

    it("codes are the ONLY persisted value — never a symbol", function () {
        // The registry uses the code as its own key AND as entry.code.
        for (const code of CURRENCY_CODES) {
            expect(CURRENCIES[code].code).toBe(code);
        }
    });

    it("isValidCurrency accepts registered codes, rejects the rest", function () {
        expect(isValidCurrency("PHP")).toBe(true);
        expect(isValidCurrency("USD")).toBe(true);
        expect(isValidCurrency("XXX")).toBe(false);
        expect(isValidCurrency("php")).toBe(false); // case-sensitive
        expect(isValidCurrency(null)).toBe(false);
        expect(isValidCurrency(123)).toBe(false);
    });

    it("getCurrency throws on an unknown code", function () {
        expect(() => getCurrency("XXX")).toThrow();
        expect(getCurrency("EUR").name).toBe("Euro");
    });

    it("display scales reflect the currency's minor unit", function () {
        expect(getDisplayScale("JPY")).toBe(0); // no minor unit
        expect(getDisplayScale("KRW")).toBe(0);
        expect(getDisplayScale("USD")).toBe(2);
        expect(getDisplayScale("KWD")).toBe(3); // three-decimal currency
        expect(getDisplayScale("BHD")).toBe(3);
        expect(getDisplayScale("OMR")).toBe(3);
    });
});
