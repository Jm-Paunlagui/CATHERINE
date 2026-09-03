/**
 * currencies.js — Frontend mirror of the backend ISO 4217 currency registry.
 *
 * This is a DELIBERATE MIRROR of `Backend/src/constants/currencies.js`. The
 * frontend never persists money and never talks to Oracle, so it only needs the
 * presentation facts: which codes exist, each code's display scale, its symbol,
 * and a locale for `Intl.NumberFormat`. Keep the two files in lock-step — a
 * currency added on the backend must be added here, or `formatMoney` will throw
 * on a code the API can legitimately return.
 *
 * ── WHY CODES, NEVER SYMBOLS ─────────────────────────────────────────────────
 * Only the three-letter ISO 4217 CODE is ever persisted (backend rule). A symbol
 * such as `₱` has no code point in single-byte Oracle character sets and would
 * corrupt silently if stored. On the client, symbols are pure presentation and
 * are resolved from this registry at render time via `Intl.NumberFormat`.
 *
 * ── DISPLAY SCALE ≠ STORAGE SCALE ────────────────────────────────────────────
 * Storage is fixed at scale 4 for every currency (`NUMBER(19,4)`). `displayScale`
 * only decides how many decimal places a formatter SHOWS (0 for JPY/KRW, 2 for
 * most, 3 for KWD/BHD/OMR). A currency that displays fewer places than are stored
 * is formatted, not rounded — the exact value is still there behind the display.
 */

/**
 * @typedef {Object} CurrencyEntry
 * @property {string} code         ISO 4217 three-letter code (the only persisted value).
 * @property {number} displayScale Decimal places shown to a human (0–3). Presentation only.
 * @property {string} symbol       Display glyph — presentation only, never persisted.
 * @property {string} locale       BCP-47 locale for grouping/decimal separators.
 * @property {string} name         Human-readable currency name.
 */

/**
 * The registry. Extend by adding an entry — never store a symbol, never persist
 * anything but `code`. Must stay in sync with the backend registry.
 * @type {Readonly<Record<string, CurrencyEntry>>}
 */
export const CURRENCIES = Object.freeze({
    PHP: { code: "PHP", displayScale: 2, symbol: "₱", locale: "en-PH", name: "Philippine Peso" },
    USD: { code: "USD", displayScale: 2, symbol: "$", locale: "en-US", name: "US Dollar" },
    EUR: { code: "EUR", displayScale: 2, symbol: "€", locale: "de-DE", name: "Euro" },
    GBP: { code: "GBP", displayScale: 2, symbol: "£", locale: "en-GB", name: "Pound Sterling" },
    JPY: { code: "JPY", displayScale: 0, symbol: "¥", locale: "ja-JP", name: "Japanese Yen" },
    KRW: { code: "KRW", displayScale: 0, symbol: "₩", locale: "ko-KR", name: "South Korean Won" },
    AUD: { code: "AUD", displayScale: 2, symbol: "A$", locale: "en-AU", name: "Australian Dollar" },
    CAD: { code: "CAD", displayScale: 2, symbol: "C$", locale: "en-CA", name: "Canadian Dollar" },
    CHF: { code: "CHF", displayScale: 2, symbol: "Fr", locale: "de-CH", name: "Swiss Franc" },
    CNY: { code: "CNY", displayScale: 2, symbol: "¥", locale: "zh-CN", name: "Chinese Yuan" },
    HKD: { code: "HKD", displayScale: 2, symbol: "HK$", locale: "en-HK", name: "Hong Kong Dollar" },
    SGD: { code: "SGD", displayScale: 2, symbol: "S$", locale: "en-SG", name: "Singapore Dollar" },
    INR: { code: "INR", displayScale: 2, symbol: "₹", locale: "en-IN", name: "Indian Rupee" },
    // ── Three-decimal currencies — displayScale 3, still stored at scale 4. ──
    KWD: { code: "KWD", displayScale: 3, symbol: "د.ك", locale: "ar-KW", name: "Kuwaiti Dinar" },
    BHD: { code: "BHD", displayScale: 3, symbol: ".د.ب", locale: "ar-BH", name: "Bahraini Dinar" },
    OMR: { code: "OMR", displayScale: 3, symbol: "ر.ع.", locale: "ar-OM", name: "Omani Rial" },
});

/** @type {ReadonlyArray<string>} */
export const CURRENCY_CODES = Object.freeze(Object.keys(CURRENCIES));

/**
 * True when `code` is a registered ISO 4217 code. Case-sensitive.
 * @param {*} code
 * @returns {boolean}
 */
export function isValidCurrency(code) {
    return typeof code === "string" && Object.prototype.hasOwnProperty.call(CURRENCIES, code);
}

/**
 * Returns the registry entry for `code`, or throws when it is not registered.
 * @param {string} code
 * @returns {CurrencyEntry}
 */
export function getCurrency(code) {
    if (!isValidCurrency(code)) {
        throw new Error(`Unknown currency "${code}". Registered: ${CURRENCY_CODES.join(", ")}.`);
    }
    return CURRENCIES[code];
}

/**
 * Display scale for `code`. Presentation only — never a storage or rounding scale.
 * @param {string} code
 * @returns {number}
 */
export function getDisplayScale(code) {
    return getCurrency(code).displayScale;
}
