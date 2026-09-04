"use strict";

/**
 * @fileoverview `Money` — an EXACT decimal value type over a `BigInt`
 * coefficient with an explicit scale. NOTHING here ever rounds. (Plan §3.0
 * rule 3, §3.1.)
 *
 * ============================================================================
 * WHY A VALUE TYPE, NOT `Number` OR `roundTo`
 * ============================================================================
 * A JavaScript `Number` is an IEEE-754 double. `0.1 + 0.2 !== 0.3`; a
 * `NUMBER(19,4)` fetched as a double is already rounded before any code sees
 * it. Rounding on every operation (a `roundTo`/`r2` helper) is ALSO rounding —
 * it accepts a value and silently stores a different one. Both are eliminated
 * by this type: money is a `BigInt` coefficient `c` and an integer `scale` `s`,
 * representing the exact rational `c / 10^s`.
 *
 *   Money.from("1500.5000")  ->  { c: 15005000n, s: 4 }   (== 1500.5)
 *
 * ============================================================================
 * THE TWO OPERATIONS THAT CANNOT BE EXACT — MADE EXPLICIT (§3.0 rule 3)
 * ============================================================================
 *   divide(d, { precision })  — `100 ÷ 3` has no finite decimal. `precision`
 *       is REQUIRED (no default), and the call returns `{ quotient, remainder }`
 *       so the residue is handed back, never silently dropped. A `divide` result
 *       is DERIVED (a unit cost / rate / display figure); nothing is posted, so
 *       nothing is owed (§3.7.1).
 *   allocate(weights)         — splitting a POSTED amount N ways. Uses
 *       largest-remainder so the parts sum to the original EXACTLY. This is
 *       exact partition, not rounding: no value is created or destroyed
 *       (§3.7.1). Tie-break is DETERMINISTIC on ascending index of the stable
 *       business key the caller supplies (§3.7.2) — never on floating remainder
 *       comparison order — so re-running an allocation is byte-identical.
 *
 * ============================================================================
 * WIRE + STORAGE FORMAT IS A STRING, NEVER A JSON NUMBER (§3.0 rule 3)
 * ============================================================================
 * `toStorage()` emits a fixed-scale-4 string (`"1500.0000"`). Serialising money
 * as a JSON number re-rounds it through a double at the transport layer no
 * matter how exact the arithmetic was. Bind it to Oracle as this string through
 * `parseUpdate` (§3.2).
 *
 * ============================================================================
 * INPUT DISCIPLINE (§3.1)
 * ============================================================================
 * `Money.from` accepts a STRING (canonical) or a `BigInt`. It REJECTS a
 * JavaScript `Number` outright — by the time money is a double it is already
 * rounded, and accepting one would launder that loss. It rejects NaN, Infinity,
 * and more than four decimal places for a POSTED amount (`toStorage` throws
 * rather than truncate). A rate is a different value type (`NUMBER(19,8)`,
 * §3.7.3) and must NOT be passed through `toStorage`.
 */

const { AppError } = require("../constants/errors");

/** Fixed STORAGE scale for a posted money amount — `NUMBER(19,4)` (§3.0 rule 2). */
const STORAGE_SCALE = 4;

/** 15 integer digits + 4 decimals = `NUMBER(19,4)`. Coefficient bound at scale 4. */
const MAX_INTEGER_DIGITS = 15;

/** `10n ** BigInt(n)` memoised for small n. @type {Map<number, bigint>} */
const _pow10Cache = new Map();
function _pow10(n) {
    if (n < 0) throw new RangeError(`_pow10: negative exponent ${n}`);
    let v = _pow10Cache.get(n);
    if (v === undefined) {
        v = 10n ** BigInt(n);
        _pow10Cache.set(n, v);
    }
    return v;
}

/** Absolute value of a BigInt. */
function _absBig(x) {
    return x < 0n ? -x : x;
}

class Money {
    /**
     * @param {bigint} coefficient - Exact coefficient `c` where value = c / 10^scale.
     * @param {number} scale       - Non-negative integer number of decimal places.
     * @private Use {@link Money.from} / {@link Money.zero}.
     */
    constructor(coefficient, scale) {
        if (typeof coefficient !== "bigint") {
            throw new AppError("Money coefficient must be a BigInt.", 500, {
                type: "MoneyError",
            });
        }
        if (!Number.isInteger(scale) || scale < 0) {
            throw new AppError("Money scale must be a non-negative integer.", 500, {
                type: "MoneyError",
            });
        }
        /** @type {bigint} */
        this.c = coefficient;
        /** @type {number} */
        this.s = scale;
        Object.freeze(this);
    }

    // ── Construction ──────────────────────────────────────────────────────────

    /**
     * Parses a value into an exact `Money`.
     *
     * Accepts:
     *   - a **string** in the canonical form `"-123.4500"` (optional sign,
     *     integer part, optional fractional part). This is how an Oracle
     *     `NUMBER` fetched as a string (§3.0 rule 3b) arrives.
     *   - a **BigInt**, interpreted as a whole number of units (scale 0).
     *
     * REJECTS a JavaScript `Number` (already rounded to a double), NaN, and
     * Infinity. Does NOT itself cap decimals — a rate may carry more than four
     * (§3.7.3); `toStorage()` is where the scale-4 ceiling is enforced.
     *
     * @param {string|bigint} value
     * @returns {Money}
     */
    static from(value) {
        if (typeof value === "bigint") return new Money(value, 0);

        if (typeof value === "number") {
            throw new AppError(
                "Money.from rejects a JavaScript number — it is already rounded to a double. " +
                    "Pass a string (the canonical form) or a BigInt.",
                500,
                { type: "MoneyError" },
            );
        }

        if (typeof value !== "string") {
            throw new AppError(
                `Money.from expects a string or BigInt but got ${typeof value}.`,
                500,
                { type: "MoneyError" },
            );
        }

        const trimmed = value.trim();
        if (!/^[+-]?\d+(\.\d+)?$/.test(trimmed)) {
            throw new AppError(
                `Money.from: "${value}" is not a valid decimal string.`,
                400,
                { type: "ValidationError" },
            );
        }

        const negative = trimmed[0] === "-";
        const unsigned = trimmed.replace(/^[+-]/, "");
        const [intPart, fracPart = ""] = unsigned.split(".");
        const scale = fracPart.length;
        const digits = `${intPart}${fracPart}`.replace(/^0+(?=\d)/, "");
        let coefficient = BigInt(digits === "" ? "0" : digits);
        if (negative) coefficient = -coefficient;

        return new Money(coefficient, scale);
    }

    /** The exact zero at scale 0. @returns {Money} */
    static zero() {
        return new Money(0n, 0);
    }

    // ── Internal scale alignment ─────────────────────────────────────────────

    /**
     * Returns `[cA, cB, scale]` — the two coefficients re-based to a common
     * scale (the larger of the two). Widening a coefficient to a larger scale is
     * an exact multiply by a power of ten; it never rounds.
     * @private
     */
    static _align(a, b) {
        if (a.s === b.s) return [a.c, b.c, a.s];
        if (a.s > b.s) return [a.c, b.c * _pow10(a.s - b.s), a.s];
        return [a.c * _pow10(b.s - a.s), b.c, b.s];
    }

    // ── Exact arithmetic (never rounds) ──────────────────────────────────────

    /** @param {Money} other @returns {Money} exact sum. */
    add(other) {
        const [cA, cB, s] = Money._align(this, other);
        return new Money(cA + cB, s);
    }

    /** @param {Money} other @returns {Money} exact difference. */
    sub(other) {
        const [cA, cB, s] = Money._align(this, other);
        return new Money(cA - cB, s);
    }

    /**
     * Exact product. Result scale is `scale(a) + scale(b)` — the mathematics is
     * retained in full (a 4-decimal amount times an 8-decimal rate yields 12
     * decimals). It is never written to a money column at that scale; it is a
     * read-time value (§3.0 rule 4).
     * @param {Money} other
     * @returns {Money}
     */
    mul(other) {
        return new Money(this.c * other.c, this.s + other.s);
    }

    /** @returns {Money} exact negation. */
    negate() {
        return new Money(-this.c, this.s);
    }

    /** @returns {Money} exact absolute value. */
    abs() {
        return new Money(_absBig(this.c), this.s);
    }

    /**
     * Exact ordering. @param {Money} other
     * @returns {-1|0|1} sign of `this - other`.
     */
    compare(other) {
        const [cA, cB] = Money._align(this, other);
        if (cA < cB) return -1;
        if (cA > cB) return 1;
        return 0;
    }

    /** @param {Money} other @returns {boolean} */
    equals(other) {
        return this.compare(other) === 0;
    }

    /** @returns {boolean} true when the exact value is zero. */
    isZero() {
        return this.c === 0n;
    }

    /** @returns {boolean} true when the exact value is negative. */
    isNegative() {
        return this.c < 0n;
    }

    // ── The two inexact operations, made explicit ────────────────────────────

    /**
     * DERIVED division to an explicit working precision. There is NO default
     * precision and NO silent truncation — the residue is returned so the caller
     * must account for it (§3.0 rule 3, §3.7.1).
     *
     * The quotient is computed at exactly `precision` decimal places (truncated
     * toward zero, not rounded); the remainder is the exact leftover expressed
     * at the quotient's scale, such that:
     *
     *   this === quotient.mul(divisor) + remainder     (exactly)
     *
     * @param {Money} divisor
     * @param {{ precision: number }} opts - `precision` REQUIRED: decimal places
     *   of the quotient.
     * @returns {{ quotient: Money, remainder: Money }}
     */
    divide(divisor, opts) {
        if (!opts || !Number.isInteger(opts.precision) || opts.precision < 0) {
            throw new AppError(
                "Money.divide requires an explicit non-negative integer precision option. " +
                    "Division cannot be exact so the working precision must be stated at the call site.",
                500,
                { type: "MoneyError" },
            );
        }
        if (divisor.isZero()) {
            throw new AppError("Money.divide by zero.", 400, {
                type: "ValidationError",
            });
        }

        const precision = opts.precision;
        // Compute quotient at `precision` places: scale the dividend up so the
        // integer division yields exactly that many fractional digits.
        // value = this.c/10^this.s ÷ divisor.c/10^divisor.s
        //       = (this.c * 10^divisor.s) / (divisor.c * 10^this.s)
        const num = this.c * _pow10(divisor.s) * _pow10(precision);
        const den = divisor.c * _pow10(this.s);

        // BigInt division truncates toward zero — the sign is carried by num/den.
        const q = num / den;
        const quotient = new Money(q, precision);

        // remainder = this - quotient*divisor, at the finest scale involved.
        const remainder = this.sub(quotient.mul(divisor));
        return { quotient, remainder };
    }

    /**
     * EXACT partition of a POSTED amount into parts proportional to `weights`,
     * by largest remainder, so the parts sum to `this` EXACTLY (§3.0 rule 3,
     * §3.7.1). Distribution is done at the STORAGE scale (4) so the smallest
     * indivisible unit is `0.0001` — the finest a posted amount can carry — and
     * every returned part is a scale-4 `Money`. (A posted amount is what is
     * split; a posted amount is stored at scale 4.)
     *
     * Tie-break is DETERMINISTIC (§3.7.2): when two parts tie on remainder, the
     * extra smallest-unit goes to the one whose weight appears EARLIER in the
     * array. Callers MUST order `weights` by a stable business key (ID
     * ascending) so re-running the allocation is byte-identical — never rely on
     * object-key or insertion order.
     *
     * @param {Array<number|bigint>} weights - Non-negative WHOLE-unit weights,
     *   at least one strictly positive. Relative only; not required to sum to
     *   anything. A fractional weight throws rather than being truncated —
     *   express a ratio in whole units (`50, 25, 25`, not `0.5, 0.25, 0.25`).
     * @throws {AppError} If any weight is fractional, negative, or non-numeric,
     *   or if the weights sum to zero.
     * @returns {Money[]} scale-4 parts, in the same order as `weights`, summing
     *   to `this` exactly.
     */
    allocate(weights) {
        if (!Array.isArray(weights) || weights.length === 0) {
            throw new AppError("Money.allocate requires a non-empty weights array.", 500, {
                type: "MoneyError",
            });
        }

        // Weights must be WHOLE units. A fractional weight is REFUSED, never
        // truncated: `Math.trunc(0.5)` is 0, so `allocate([0.5, 0.25, 0.25])`
        // silently became `[0, 0, 0]` and surfaced as the misleading
        // "weights sum to zero" below — the caller's real mistake (a ratio
        // expressed as fractions) never appeared in the message. Refusing here
        // is the same reject-don't-round rule `Money.from` applies to a
        // JavaScript number and `toStorage` applies to a 5th decimal place: a
        // value the caller did not supply must never be substituted for one
        // they did.
        const w = weights.map((x, i) => {
            if (typeof x === "bigint") {
                if (x < 0n) {
                    throw new AppError(
                        `Money.allocate: weight at index ${i} is negative.`,
                        500,
                        { type: "MoneyError" },
                    );
                }
                return x;
            }
            if (typeof x !== "number" || !Number.isInteger(x)) {
                throw new AppError(
                    `Money.allocate: weight at index ${i} must be a whole number or BigInt, ` +
                        `received ${typeof x === "number" ? x : typeof x}. Fractional weights are ` +
                        "refused rather than truncated — express the ratio in whole units instead " +
                        "(0.5 / 0.25 / 0.25 becomes 50 / 25 / 25).",
                    500,
                    { type: "MoneyError" },
                );
            }
            if (x < 0) {
                throw new AppError(
                    `Money.allocate: weight at index ${i} is negative.`,
                    500,
                    { type: "MoneyError" },
                );
            }
            return BigInt(x);
        });

        const totalWeight = w.reduce((sum, x) => sum + x, 0n);
        if (totalWeight === 0n) {
            throw new AppError(
                "Money.allocate: weights sum to zero — nothing to allocate against.",
                500,
                { type: "MoneyError" },
            );
        }

        // Re-base the value to the STORAGE scale (4) so distribution happens in
        // whole 0.0001 units. Widening a smaller scale is exact; a value already
        // finer than scale 4 cannot be a posted amount and is refused up front.
        let baseC = this.c;
        if (this.s > STORAGE_SCALE) {
            const factor = _pow10(this.s - STORAGE_SCALE);
            if (baseC % factor !== 0n) {
                throw new AppError(
                    `Money.allocate: value carries more than ${STORAGE_SCALE} decimals and ` +
                        `cannot be a posted amount. Round with an explicit precision first.`,
                    400,
                    { type: "ValidationError" },
                );
            }
            baseC = baseC / factor;
        } else if (this.s < STORAGE_SCALE) {
            baseC = baseC * _pow10(STORAGE_SCALE - this.s);
        }

        // floor share plus one extra 0.0001 unit to the largest remainders until
        // the parts sum back to baseC exactly.
        const shares = w.map((weight) => {
            const product = baseC * weight; // exact
            const quotient = product / totalWeight; // truncates toward zero
            const remainder = product - quotient * totalWeight; // >= 0 for baseC >= 0
            return { quotient, remainder };
        });

        const distributed = shares.reduce((sum, sh) => sum + sh.quotient, 0n);
        const leftover = baseC - distributed; // number of 0.0001 units still to place

        // Order indices by remainder DESC, then by original index ASC (stable
        // deterministic tie-break — §3.7.2).
        const order = shares
            .map((sh, i) => ({ i, remainder: sh.remainder }))
            .sort((a, b) => {
                if (a.remainder > b.remainder) return -1;
                if (a.remainder < b.remainder) return 1;
                return a.i - b.i;
            });

        // `leftover` may be negative if baseC is negative (truncation toward zero
        // leaves the deficit on the negative side). Place +/- one unit per step
        // in remainder order until exhausted.
        const step = leftover >= 0n ? 1n : -1n;
        let remaining = _absBig(leftover);
        let k = 0;
        while (remaining > 0n) {
            shares[order[k % order.length].i].quotient += step;
            remaining -= 1n;
            k += 1;
        }

        return shares.map((sh) => new Money(sh.quotient, STORAGE_SCALE));
    }

    /**
     * Throws `AppError` when `parts` do not sum to `total` EXACTLY. The
     * invariant a split must uphold (§3.1); with no step rounding it is a real
     * guarantee, not a rounding-order convention.
     *
     * @param {Money[]} parts
     * @param {Money} total
     * @param {string} [label="allocation"]
     * @returns {void}
     */
    static assertBalanced(parts, total, label = "allocation") {
        const sum = parts.reduce((acc, p) => acc.add(p), Money.zero());
        if (!sum.equals(total)) {
            throw new AppError(
                `${label} does not balance: parts sum to ${sum.toStorage()} but total is ${total.toStorage()}.`,
                500,
                { type: "MoneyError" },
            );
        }
    }

    // ── Serialisation ────────────────────────────────────────────────────────

    /**
     * The fixed-scale-4 string written to Oracle and used in row hashing (§3.4).
     * THROWS rather than truncate if the value carries more than four decimal
     * places — this is how a conversion product (higher scale) is stopped from
     * reaching a `NUMBER(19,4)` money column (§3.0 rule 4, §3.1). A rate lives in
     * `NUMBER(19,8)` and is a different value type — do NOT call this on one.
     *
     * @returns {string} e.g. `"1500.0000"`, `"-0.5000"`.
     */
    toStorage() {
        // Re-base to scale 4 exactly if the current scale is <= 4; refuse if >4.
        let c = this.c;
        let s = this.s;
        if (s > STORAGE_SCALE) {
            // Only safe if the extra digits are all zero (an exact value that
            // merely carries trailing zeros). Otherwise storing it would round.
            const factor = _pow10(s - STORAGE_SCALE);
            if (c % factor !== 0n) {
                throw new AppError(
                    `Money.toStorage: value carries more than ${STORAGE_SCALE} decimal places ` +
                        `and cannot be stored without rounding. Convert or divide with an explicit ` +
                        `precision before persisting.`,
                    400,
                    { type: "ValidationError" },
                );
            }
            c = c / factor;
            s = STORAGE_SCALE;
        } else if (s < STORAGE_SCALE) {
            c = c * _pow10(STORAGE_SCALE - s);
            s = STORAGE_SCALE;
        }

        const negative = c < 0n;
        const digits = _absBig(c).toString().padStart(STORAGE_SCALE + 1, "0");
        const intPart = digits.slice(0, digits.length - STORAGE_SCALE);
        const fracPart = digits.slice(digits.length - STORAGE_SCALE);

        if (intPart.replace(/^0+(?=\d)/, "").length > MAX_INTEGER_DIGITS) {
            throw new AppError(
                `Money.toStorage: value exceeds NUMBER(19,4) integer capacity (${MAX_INTEGER_DIGITS} digits).`,
                400,
                { type: "ValidationError" },
            );
        }

        return `${negative ? "-" : ""}${intPart}.${fracPart}`;
    }

    /**
     * Presentation string at a currency's display scale (§3.1). This is the ONE
     * place a value is shortened for a human — it NEVER feeds arithmetic or
     * storage. Uses `Intl.NumberFormat`; grouping and separators come from the
     * currency's locale. Rounding here is presentation only; the exact value is
     * unchanged behind it.
     *
     * @param {string} currencyCode - ISO 4217 code; scale/locale from the registry.
     * @param {string} [localeOverride] - Force a locale instead of the registry's.
     * @returns {string} e.g. `"₱1,500.00"` (symbol resolved by the caller/registry).
     */
    format(currencyCode, localeOverride) {
        // Lazy require to avoid a constants<->utils cycle at module load.
        const { getCurrency } = require("../constants/currencies");
        const entry = getCurrency(currencyCode);
        const locale = localeOverride || entry.locale;

        return new Intl.NumberFormat(locale, {
            style: "currency",
            currency: entry.code,
            minimumFractionDigits: entry.displayScale,
            maximumFractionDigits: entry.displayScale,
        }).format(this._toBoundedNumberForDisplay(entry.displayScale));
    }

    /**
     * Produces a JS number for DISPLAY ONLY, at `displayScale` places. Never
     * used for arithmetic or storage. Kept tiny and explicit so its single
     * lossy step is obvious and contained.
     * @private
     */
    _toBoundedNumberForDisplay(displayScale) {
        // Truncate/round to displayScale via string first to keep the double as
        // close to the exact value as the format's own scale.
        const str = this.toStorage(); // scale 4 exact string
        const asNum = Number(str);
        // Number() here is acceptable: this is the presentation boundary, and
        // Intl.NumberFormat will format to displayScale regardless.
        void displayScale;
        return asNum;
    }

    /** Debug/diagnostic only — the exact scale-4 storage string. */
    toString() {
        return this.toStorage();
    }

    /** JSON serialises as the scale-4 STRING, never a number (§3.0 rule 3). */
    toJSON() {
        return this.toStorage();
    }
}

module.exports = {
    Money,
    STORAGE_SCALE,
    MAX_INTEGER_DIGITS,
};
