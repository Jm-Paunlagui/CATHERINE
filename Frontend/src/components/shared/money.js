/**
 * @fileoverview money.js — shared money formatting helpers (tier 3).
 *
 * WHAT THIS FILE DOES
 *   `formatMoney` — multi-currency, registry-driven money formatter (the money
 *                   capability's presentation seam). Renders any ISO 4217 code
 *                   at its own display scale via `Intl.NumberFormat`.
 *   `formatPeso`  — legacy single-currency peso formatter, kept for callers not
 *                   yet migrated. Prefer `formatMoney(value, "PHP")`.
 *
 * WHY A STRING-FIRST CONTRACT
 *   Money crosses the wire as a fixed-scale STRING ("1500.5000"), never a JS
 *   number (see Backend money.js toJSON === toStorage). `formatMoney` therefore
 *   accepts the string directly and only coerces to a Number at the DISPLAY
 *   boundary — the one place a double is acceptable, because nothing is stored
 *   or posted from it. It never rounds the stored value; it formats it.
 *
 * EXAMPLE
 *   import { formatMoney } from "../../components/shared/money";
 *   formatMoney("1500.5000", "PHP")     // "₱1,500.50"
 *   formatMoney("1500", "JPY")          // "¥1,500"   (0 display decimals)
 *   formatMoney("1.2345", "KWD")        // "KD 1.234" (3 display decimals)
 *   formatMoney(null, "USD")            // "$0.00"
 *   formatMoney("nope", "USD", { nullText: "—" }) // "—"  (never "$NaN")
 */

import { getCurrency } from "../../constants/currencies";

/**
 * Formats a numeric peso value as a localised Philippine peso string.
 *
 * NON-FINITE INPUT FALLS BACK — it never reaches the screen
 *   `Number("not-a-number")`, `Number({})`, `Number([1, 2])` and `Number(NaN)`
 *   are all `NaN`, and `NaN.toLocaleString()` returns the literal string
 *   `"NaN"` — so an unguarded formatter renders `₱NaN` where an amount
 *   belongs. `Infinity` renders as `"∞"`, which reads as a real (and alarming)
 *   figure. Neither is hypothetical: this function is fed straight off wire
 *   payloads, and a chaos test driving a hostile `provisional*` figure through
 *   the real Transaction History page produced `₱NaN` on screen.
 *
 *   Every non-finite value therefore returns `nullText`, exactly as `null`
 *   does — the caller's own placeholder ("₱0.00", "—", …). A missing figure
 *   and an unusable one are the same fact to a reader: there is no amount to
 *   show. Rendering the placeholder is honest; rendering `₱NaN` is a defect
 *   the reader has to interpret.
 *
 * @param {number|string|null|undefined} value - Amount to format. Non-numeric
 *   and non-finite values fall back to `nullText`.
 * @param {string} [nullText="₱0.00"]        - Placeholder returned for null/undefined
 *   and for any value that does not coerce to a finite number.
 * @returns {string}
 * @example
 * formatPeso(1234.5)          // "₱1,234.50"
 * formatPeso("1234.5")        // "₱1,234.50"  (numeric strings still format)
 * formatPeso(null)            // "₱0.00"
 * formatPeso(null, "—")       // "—"
 * formatPeso(NaN)             // "₱0.00"      (never "₱NaN")
 * formatPeso({}, "—")         // "—"
 * formatPeso(Infinity, "—")   // "—"
 */
export function formatPeso(value, nullText = "₱0.00") {
    if (value == null) return nullText;
    const n = Number(value);
    if (!Number.isFinite(n)) return nullText;
    return `₱${n.toLocaleString("en-PH", { minimumFractionDigits: 2 })}`;
}

/**
 * Formats a monetary value in any registered ISO 4217 currency, at that
 * currency's own display scale (0 for JPY/KRW, 2 for most, 3 for KWD/BHD/OMR).
 *
 * INPUT IS A STRING BY CONTRACT — money arrives from the API as a fixed-scale
 * string ("1500.5000"), which is exactly `Money.toStorage()`'s output. A numeric
 * string still works; a raw JS number works too but is discouraged (it may
 * already carry a rounding error). The value is only coerced to a Number at the
 * display boundary, and never rounded back into storage.
 *
 * NON-FINITE INPUT FALLS BACK — never `$NaN` / `¥∞`. `null`, `undefined`, and any
 * value that does not coerce to a finite number return `opts.nullText` (default
 * a zero rendered in the requested currency), exactly as the legacy `formatPeso`
 * does. A missing figure and an unusable one are the same fact to a reader.
 *
 * @param {string|number|bigint|null|undefined} value - Amount to format. A
 *   fixed-scale string is the canonical input.
 * @param {string} currencyCode - Registered ISO 4217 code (e.g. "USD", "PHP").
 *   Throws if the code is not in the registry — fail loudly rather than guess a scale.
 * @param {Object} [opts]
 * @param {string} [opts.nullText] - Placeholder for null/undefined/non-finite input.
 *   Defaults to a zero amount rendered in `currencyCode`.
 * @param {string} [opts.locale]   - Override the registry locale (grouping/decimal).
 * @param {boolean} [opts.currencyDisplay] - When "code"/"name"/"symbol", passed to
 *   Intl. Defaults to "symbol".
 * @returns {string}
 * @example
 * formatMoney("1500.5000", "PHP")               // "₱1,500.50"
 * formatMoney("1500", "JPY")                     // "¥1,500"
 * formatMoney("1.2345", "KWD")                   // "KD 1.234"
 * formatMoney(null, "USD")                       // "$0.00"
 * formatMoney("nope", "EUR", { nullText: "—" })  // "—"
 */
export function formatMoney(value, currencyCode, opts = {}) {
    // getCurrency throws on an unknown code — deliberate: a formatter must never
    // guess a display scale for a currency the registry does not know.
    const entry = getCurrency(currencyCode);
    const locale = opts.locale || entry.locale;
    const currencyDisplay = opts.currencyDisplay || "symbol";

    const fmt = (n) =>
        n.toLocaleString(locale, {
            style: "currency",
            currency: entry.code,
            currencyDisplay,
            minimumFractionDigits: entry.displayScale,
            maximumFractionDigits: entry.displayScale,
        });

    // nullText defaults to a zero rendered in the target currency, so a missing
    // amount still reads as money, not as a bare dash, unless the caller overrides.
    const nullText = opts.nullText != null ? opts.nullText : fmt(0);

    if (value == null) return nullText;
    const n = Number(value);
    if (!Number.isFinite(n)) return nullText;
    return fmt(n);
}
