"use strict";

/**
 * Property + unit tests for the exact-decimal `Money` value type
 * (src/utils/money.js). Pure — no DB, no HTTP.
 *
 * These encode ACCOUNTING INVARIANTS, not implementation details (plan §5.2):
 *   - exact arithmetic never rounds (§3.0 rule 3)
 *   - `allocate` parts sum to the total EXACTLY (§3.7.1)
 *   - `allocate` is shuffle-stable via ID-ascending tie-break (§3.7.2)
 *   - `divide` returns a residue that exactly recomposes the dividend
 *   - storage refuses >4 decimals rather than rounding (§3.0 rule 2)
 *   - `Money.from` rejects a JS number (already-rounded double, §3.1)
 */

const { Money, STORAGE_SCALE } = require("../../src/utils/money");

/** Small deterministic PRNG so property runs are reproducible. */
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

describe("Money — construction & input discipline", function () {
    it("parses a canonical decimal string exactly", function () {
        expect(Money.from("1500.5000").toStorage()).toBe("1500.5000");
        expect(Money.from("-0.5").toStorage()).toBe("-0.5000");
        expect(Money.from("0").toStorage()).toBe("0.0000");
    });

    it("accepts a BigInt as whole units", function () {
        expect(Money.from(42n).toStorage()).toBe("42.0000");
    });

    it("REJECTS a JavaScript number (already a rounded double)", function () {
        expect(() => Money.from(1500)).toThrow();
        expect(() => Money.from(0.1)).toThrow();
    });

    it("rejects NaN / Infinity / garbage strings", function () {
        expect(() => Money.from("NaN")).toThrow();
        expect(() => Money.from("Infinity")).toThrow();
        expect(() => Money.from("12abc")).toThrow();
        expect(() => Money.from("")).toThrow();
    });
});

describe("Money — exact arithmetic never rounds", function () {
    it("0.1 + 0.2 === 0.3 exactly", function () {
        expect(Money.from("0.1").add(Money.from("0.2")).toStorage()).toBe("0.3000");
    });

    it("subtracts across scales exactly", function () {
        expect(Money.from("1000").sub(Money.from("0.0001")).toStorage()).toBe("999.9999");
    });

    it("multiplies, growing scale, without loss", function () {
        // 4-decimal amount times 8-decimal rate → 12-decimal product, exact.
        const amount = Money.from("100.0000");
        const rate = Money.from("1.23456789");
        expect(amount.mul(rate).c).toBe(123456789000000n);
    });

    it("compares and negates exactly", function () {
        expect(Money.from("1.5").compare(Money.from("1.50"))).toBe(0);
        expect(Money.from("1").compare(Money.from("2"))).toBe(-1);
        expect(Money.from("5").negate().toStorage()).toBe("-5.0000");
        expect(Money.from("-5").abs().toStorage()).toBe("5.0000");
        expect(Money.zero().isZero()).toBe(true);
    });
});

describe("Money — add/sub algebraic laws (property, §3.0 rule 3)", function () {
    // Draw exact scale-4 decimals as coefficient BigInts so no rounding ever
    // enters the generator itself — the numbers are constructed, not parsed as
    // floats. Range spans well past MAX_SAFE_INTEGER to prove BigInt storage.
    function randMoney(rng) {
        // Up to 14 WHOLE digits so a sum of two operands still fits the
        // NUMBER(19,4) ceiling of 15 integer digits (toStorage would throw at 16).
        // At scale 4 the coefficient is a 14+4 = 18-digit BigInt — already far
        // past Number.MAX_SAFE_INTEGER (~16 digits), so this is genuine BigInt math.
        const wholeDigits = 1 + Math.floor(rng() * 14);
        let s = "";
        for (let i = 0; i < wholeDigits; i++) s += Math.floor(rng() * 10);
        let frac = "";
        for (let i = 0; i < 4; i++) frac += Math.floor(rng() * 10);
        const neg = rng() < 0.5 ? "-" : "";
        return Money.from(`${neg}${s || "0"}.${frac}`);
    }

    it("PROPERTY: addition is commutative  a + b === b + a", function () {
        const rng = mulberry32(0xa11ce);
        for (let i = 0; i < 500; i++) {
            const a = randMoney(rng);
            const b = randMoney(rng);
            expect(a.add(b).toStorage()).toBe(b.add(a).toStorage());
        }
    });

    it("PROPERTY: addition is associative  (a + b) + c === a + (b + c)", function () {
        const rng = mulberry32(0xb0b);
        for (let i = 0; i < 500; i++) {
            const a = randMoney(rng);
            const b = randMoney(rng);
            const c = randMoney(rng);
            expect(a.add(b).add(c).toStorage()).toBe(a.add(b.add(c)).toStorage());
        }
    });

    it("PROPERTY: subtraction inverts addition  (a + b) - b === a", function () {
        const rng = mulberry32(0xcafe);
        for (let i = 0; i < 500; i++) {
            const a = randMoney(rng);
            const b = randMoney(rng);
            expect(a.add(b).sub(b).toStorage()).toBe(a.toStorage());
        }
    });

    it("holds well past Number.MAX_SAFE_INTEGER (BigInt storage, not double)", function () {
        // 14 whole digits at scale 4 → an 18-digit coefficient. 2^53-1 is only
        // 9007199254740991 (16 digits), so this value's coefficient is far beyond
        // what a JS double could represent without rounding.
        const big = Money.from("99999999999999.0001");
        expect(big.c > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
        expect(big.add(Money.from("0.0002")).toStorage()).toBe("99999999999999.0003");
        expect(big.sub(big).toStorage()).toBe("0.0000");
        // Adding one more sub-centavo at the top digit still carries exactly.
        expect(big.add(Money.from("0.9999")).toStorage()).toBe("100000000000000.0000");
        // A round-trip through the wire format loses nothing.
        expect(Money.from(big.toStorage()).toStorage()).toBe(big.toStorage());
    });
});

describe("Money.divide — DERIVED, residue returned (§3.7.1)", function () {
    it("requires an explicit precision", function () {
        expect(() => Money.from("100").divide(Money.from("3"))).toThrow();
        expect(() => Money.from("100").divide(Money.from("3"), {})).toThrow();
    });

    it("returns quotient + remainder that recompose the dividend exactly", function () {
        const { quotient, remainder } = Money.from("100").divide(Money.from("3"), {
            precision: 4,
        });
        expect(quotient.toStorage()).toBe("33.3333");
        // dividend === quotient*divisor + remainder, exactly
        expect(quotient.mul(Money.from("3")).add(remainder).toStorage()).toBe("100.0000");
    });

    it("throws on divide-by-zero", function () {
        expect(() => Money.from("1").divide(Money.zero(), { precision: 2 })).toThrow();
    });
});

describe("Money.allocate — POSTED, parts sum EXACTLY (§3.7.1)", function () {
    it("splits 100 three ways with no lost centavo", function () {
        const parts = Money.from("100").allocate([1, 1, 1]);
        expect(parts.map((p) => p.toStorage())).toEqual([
            "33.3334",
            "33.3333",
            "33.3333",
        ]);
        Money.assertBalanced(parts, Money.from("100"), "split100");
    });

    it("allocates proportionally to weights", function () {
        const parts = Money.from("100").allocate([2, 1]);
        expect(parts.map((p) => p.toStorage())).toEqual(["66.6667", "33.3333"]);
        Money.assertBalanced(parts, Money.from("100"));
    });

    it("balances negative totals too", function () {
        const parts = Money.from("-100").allocate([1, 1, 1]);
        Money.assertBalanced(parts, Money.from("-100"));
    });

    it("every part is at storage scale 4", function () {
        const parts = Money.from("10").allocate([1, 1, 1]);
        for (const p of parts) expect(p.s).toBe(STORAGE_SCALE);
    });
});

describe("Money.allocate — weights are whole units, never truncated", function () {
    // Regression: weights used to run through `BigInt(Math.trunc(Number(x)))`,
    // so every weight below 1 became 0 and a ratio expressed as fractions —
    // allocate([0.5, 0.25, 0.25]), the most natural way to write a percentage
    // split — collapsed to [0, 0, 0] and surfaced as "weights sum to zero".
    // The caller's actual mistake never appeared in the message.
    it("refuses a fractional weight instead of truncating it to zero", function () {
        expect(() => Money.from("100").allocate([0.5, 0.25, 0.25])).toThrow(
            /whole number or BigInt/,
        );
    });

    it("names the offending index and suggests whole units", function () {
        expect(() => Money.from("100").allocate([50, 25.5, 25])).toThrow(
            /weight at index 1/,
        );
        expect(() => Money.from("100").allocate([50, 25.5, 25])).toThrow(
            /50 \/ 25 \/ 25/,
        );
    });

    it("accepts the whole-unit form of the same ratio", function () {
        const parts = Money.from("100").allocate([50, 25, 25]);
        expect(parts.map((p) => p.toStorage())).toEqual([
            "50.0000",
            "25.0000",
            "25.0000",
        ]);
        Money.assertBalanced(parts, Money.from("100"));
    });

    it("accepts BigInt weights", function () {
        const parts = Money.from("100").allocate([2n, 1n, 1n]);
        expect(parts.map((p) => p.toStorage())).toEqual([
            "50.0000",
            "25.0000",
            "25.0000",
        ]);
    });

    it("refuses NaN, Infinity, and non-numeric weights", function () {
        expect(() => Money.from("100").allocate([NaN, 1])).toThrow(/whole number/);
        expect(() => Money.from("100").allocate([Infinity, 1])).toThrow(/whole number/);
        expect(() => Money.from("100").allocate(["50", 1])).toThrow(/whole number/);
        expect(() => Money.from("100").allocate([null, 1])).toThrow(/whole number/);
    });

    it("still refuses negative weights, number and BigInt alike", function () {
        expect(() => Money.from("100").allocate([-1, 2])).toThrow(/negative/);
        expect(() => Money.from("100").allocate([-1n, 2n])).toThrow(/negative/);
    });

    it("still refuses an all-zero weight vector", function () {
        expect(() => Money.from("100").allocate([0, 0])).toThrow(/sum to zero/);
    });
});

describe("Money.allocate — deterministic tie-break (§3.7.2, blocking)", function () {
    it("equal weights give the extra unit to the EARLIER index, not array luck", function () {
        // 0.03 over 3 equal parts is exact — no tie. 0.0001 over 3 equal parts
        // creates a residue that MUST land on index 0 deterministically.
        const parts = Money.from("0.0001").allocate([1, 1, 1]);
        expect(parts.map((p) => p.toStorage())).toEqual([
            "0.0001",
            "0.0000",
            "0.0000",
        ]);
    });

    it("PROPERTY: shuffling weights does not change any party's amount", function () {
        // Model parties as {id, weight}. Sort by id ascending before allocating
        // (the documented contract). Re-run with the input array shuffled — the
        // per-id result must be byte-identical.
        const rand = mulberry32(20260903);
        for (let trial = 0; trial < 200; trial++) {
            const n = 2 + Math.floor(rand() * 6);
            const parties = Array.from({ length: n }, (_, i) => ({
                id: i,
                weight: 1 + Math.floor(rand() * 5),
            }));
            const totalUnits = 1 + Math.floor(rand() * 1_000_000);
            const total = Money.from(String(totalUnits) + ".0001");

            const allocateByIdOrder = (arr) => {
                const sorted = [...arr].sort((a, b) => a.id - b.id);
                const parts = total.allocate(sorted.map((p) => p.weight));
                const byId = {};
                sorted.forEach((p, i) => {
                    byId[p.id] = parts[i].toStorage();
                });
                return byId;
            };

            const canonical = allocateByIdOrder(parties);

            // Shuffle and re-run — result per id must match.
            const shuffled = [...parties];
            for (let i = shuffled.length - 1; i > 0; i--) {
                const j = Math.floor(rand() * (i + 1));
                [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
            }
            const reordered = allocateByIdOrder(shuffled);

            expect(reordered).toEqual(canonical);

            // And the parts must always sum to the total exactly.
            const sorted = [...parties].sort((a, b) => a.id - b.id);
            const parts = total.allocate(sorted.map((p) => p.weight));
            Money.assertBalanced(parts, total, `trial ${trial}`);
        }
    });
});

describe("Money.toStorage — refuses >4 decimals rather than rounding (§3.0 rule 2)", function () {
    it("throws on a value carrying more than 4 non-zero decimals", function () {
        expect(() => Money.from("1.00001").toStorage()).toThrow();
    });

    it("accepts extra decimals when they are all trailing zeros", function () {
        expect(Money.from("1.50000000").toStorage()).toBe("1.5000");
    });

    it("pads a shorter scale up to 4", function () {
        expect(Money.from("7").toStorage()).toBe("7.0000");
        expect(Money.from("7.5").toStorage()).toBe("7.5000");
    });
});

describe("Money — wire format is a STRING, never a JSON number (§3.0 rule 3)", function () {
    it("serialises to a scale-4 string via toJSON", function () {
        expect(JSON.stringify({ amount: Money.from("12.5") })).toBe(
            '{"amount":"12.5000"}',
        );
    });
});

describe("Money.format — presentation only, from the currency registry", function () {
    it("formats at the currency's display scale", function () {
        // Exact value unchanged behind the presentation.
        expect(typeof Money.from("1500").format("USD")).toBe("string");
        expect(Money.from("1500").format("USD")).toContain("1,500");
    });
});
