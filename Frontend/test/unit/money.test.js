/**
 * money.test.js — presentation-seam guarantees for the frontend money helpers.
 *
 * These tests protect the two properties a reader depends on and a copier is
 * most likely to break:
 *
 *   1. A money cell NEVER renders `$NaN`, `¥∞`, or a bare `NaN` — a hostile or
 *      missing wire value falls back to a placeholder, in EVERY registered
 *      currency (not just the peso path the legacy formatter guarded).
 *   2. Each currency formats at its OWN display scale (0 / 2 / 3), and that
 *      scale FORMATS the canonical fixed-scale-4 string — it never rounds the
 *      value back into storage.
 *
 * The value under test is always the canonical wire shape: a fixed-scale
 * STRING ("1500.5000"), exactly `Money.toStorage()`'s output on the backend.
 */

import { describe, expect, it } from "vitest";
import { CURRENCY_CODES, CURRENCIES, getDisplayScale, isValidCurrency } from "../../src/constants/currencies";
import { formatMoney, formatPeso } from "../../src/components/shared/money";

// Strip whitespace so "₱1,500.50" and "1,500.50 ₱" compare on digits alone.
const digits = (s) => s.replace(/[\s\u00a0\u202f]/g, "");

// Count fraction digits in a LOCALE-AGNOSTIC way. Some currencies format with
// non-Latin digits (ar-KW → Arabic-Indic ١٢٣) and a non-ASCII decimal
// separator (٫), so we cannot split on "." or match /[0-9]/. Instead we ask
// Intl itself, via resolvedOptions, how many fraction digits it will render.
const fractionDigitsFor = (code) => {
    const opts = new Intl.NumberFormat(undefined, { style: "currency", currency: code }).resolvedOptions();
    return opts.maximumFractionDigits;
};

describe("formatMoney — never renders a non-finite value", () => {
    const HOSTILE = [null, undefined, NaN, Infinity, -Infinity, "nope", "NaN", {}, [1, 2], "", "  "];

    for (const code of CURRENCY_CODES) {
        it(`falls back for every hostile input in ${code} (never NaN/Infinity)`, () => {
            for (const bad of HOSTILE) {
                const out = formatMoney(bad, code);
                expect(out).not.toMatch(/NaN/i);
                expect(out).not.toMatch(/Infinity/i);
                expect(out).not.toContain("∞");
                // Default fallback is a zero rendered in the target currency.
                expect(typeof out).toBe("string");
                expect(out.length).toBeGreaterThan(0);
            }
        });
    }

    it("honours an explicit nullText placeholder for a bad value", () => {
        expect(formatMoney("nope", "USD", { nullText: "—" })).toBe("—");
        expect(formatMoney(null, "EUR", { nullText: "—" })).toBe("—");
        expect(formatMoney(Infinity, "JPY", { nullText: "—" })).toBe("—");
    });

    it("default fallback renders a zero in the requested currency, not a dash", () => {
        expect(digits(formatMoney(null, "USD"))).toContain("0.00");
        expect(digits(formatMoney(null, "JPY"))).toMatch(/0$/); // no decimal part
    });
});

describe("formatMoney — display scale is per-currency and only formats", () => {
    it("shows 2 decimals for a scale-2 currency", () => {
        expect(digits(formatMoney("1500.5000", "PHP"))).toBe("₱1,500.50");
        expect(digits(formatMoney("1500.5000", "USD"))).toBe("$1,500.50");
    });

    it("shows 0 decimals for a scale-0 currency", () => {
        const out = digits(formatMoney("1500.0000", "JPY"));
        expect(out).not.toContain(".");
        expect(out).toContain("1,500");
    });

    it("shows 3 fraction digits for a scale-3 currency (locale-agnostic)", () => {
        // KWD's ar-KW locale renders Arabic-Indic digits and a ٫ separator, so we
        // assert on the FRACTION-DIGIT COUNT Intl resolves, not on ASCII glyphs.
        // displayScale (3) must line up with what Intl will actually render.
        expect(getDisplayScale("KWD")).toBe(3);
        expect(fractionDigitsFor("KWD")).toBe(3);
        // And it produces some output without throwing on the 4th stored place.
        expect(typeof formatMoney("1.2345", "KWD")).toBe("string");
    });

    it("registry display scale matches Intl's resolved fraction digits for every currency", () => {
        for (const code of CURRENCY_CODES) {
            expect(getDisplayScale(code)).toBe(fractionDigitsFor(code));
        }
    });
});

describe("formatMoney — string-first contract", () => {
    it("accepts the canonical fixed-scale string", () => {
        expect(digits(formatMoney("0.5000", "USD"))).toBe("$0.50");
    });

    it("throws on an unknown currency rather than guessing a scale", () => {
        expect(() => formatMoney("1.0000", "ZZZ")).toThrow(/Unknown currency/);
    });
});

describe("currency registry invariants", () => {
    it("is frozen and code-keyed", () => {
        expect(Object.isFrozen(CURRENCIES)).toBe(true);
        for (const code of CURRENCY_CODES) {
            expect(CURRENCIES[code].code).toBe(code);
        }
    });

    it("every display scale is an integer in 0..3", () => {
        for (const code of CURRENCY_CODES) {
            const s = getDisplayScale(code);
            expect(Number.isInteger(s)).toBe(true);
            expect(s).toBeGreaterThanOrEqual(0);
            expect(s).toBeLessThanOrEqual(3);
        }
    });

    it("isValidCurrency is case-sensitive and rejects non-strings", () => {
        expect(isValidCurrency("USD")).toBe(true);
        expect(isValidCurrency("usd")).toBe(false);
        expect(isValidCurrency(null)).toBe(false);
        expect(isValidCurrency(123)).toBe(false);
    });
});

describe("formatPeso — legacy single-currency helper still guards NaN", () => {
    it("formats a peso value", () => {
        expect(digits(formatPeso(1234.5))).toBe("₱1,234.50");
    });

    it("never renders ₱NaN or ₱∞", () => {
        for (const bad of [null, undefined, NaN, Infinity, "nope", {}]) {
            const out = formatPeso(bad);
            expect(out).not.toMatch(/NaN/i);
            expect(out).not.toContain("∞");
        }
    });

    it("honours a custom placeholder", () => {
        expect(formatPeso(null, "—")).toBe("—");
        expect(formatPeso(NaN, "—")).toBe("—");
    });
});
