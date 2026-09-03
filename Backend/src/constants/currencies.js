"use strict";

/**
 * @fileoverview ISO 4217 currency registry — the single source of truth for
 * every currency the money layer can present.
 *
 * ============================================================================
 * WHY CODES, NEVER SYMBOLS (see plan §3.0)
 * ============================================================================
 * Only the three-letter ISO 4217 CODE is ever persisted. Symbols (`$`, `€`,
 * `₱`) are presentation, resolved from this registry client-side or at export
 * time. A symbol like `₱` has no code point in single-byte Oracle character
 * sets (WE8ISO8859P15) and would corrupt silently if stored (see
 * `utils/textNormalize.js`); `PHP` is pure ASCII and safe on any charset.
 *
 * ============================================================================
 * WHAT EACH ENTRY CARRIES
 * ============================================================================
 *   code        {string} ISO 4217 three-letter code (the ONLY persisted value)
 *   displayScale {number} decimal places shown to a human (2–4). This is a
 *                PRESENTATION scale — it never governs storage (always
 *                NUMBER(19,4), plan §3.0 rule 2) and never rounds the stored
 *                value; it only formats it (plan §3.0 rule 3).
 *   symbol      {string} display glyph — presentation only, never persisted.
 *   locale      {string} BCP-47 locale used for grouping/decimal separators
 *                in `Intl.NumberFormat`.
 *   name        {string} human-readable currency name.
 *
 * ============================================================================
 * DISPLAY SCALE ≠ STORAGE SCALE
 * ============================================================================
 * Storage is fixed at scale 4 for every currency (`NUMBER(19,4)`), so two money
 * columns are always comparable and summable without knowing a per-currency
 * scale. `displayScale` only decides how many places a formatter shows:
 *   - JPY/KRW: 0 (no minor unit)
 *   - most currencies: 2
 *   - KWD/BHD/OMR: 3
 * A currency that displays fewer places than are stored is formatted, not
 * rounded — the exact stored value is still there behind the presentation.
 */

/**
 * @typedef {Object} CurrencyEntry
 * @property {string} code
 * @property {number} displayScale
 * @property {string} symbol
 * @property {string} locale
 * @property {string} name
 */

/**
 * The registry. Extend by adding an entry — never store a symbol, never persist
 * anything but `code`.
 * @type {Readonly<Record<string, CurrencyEntry>>}
 */
const CURRENCIES = Object.freeze({
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
const CURRENCY_CODES = Object.freeze(Object.keys(CURRENCIES));

/**
 * True when `code` is a registered ISO 4217 code. Case-sensitive: codes are
 * always upper-case and are compared as stored.
 * @param {*} code
 * @returns {boolean}
 */
function isValidCurrency(code) {
    return typeof code === "string" && Object.prototype.hasOwnProperty.call(CURRENCIES, code);
}

/**
 * Returns the registry entry for `code`, or throws when it is not registered.
 * Callers that format or convert money must fail loudly on an unknown code
 * rather than guessing a scale.
 * @param {string} code
 * @returns {CurrencyEntry}
 */
function getCurrency(code) {
    if (!isValidCurrency(code)) {
        throw new Error(
            `Unknown currency "${code}". Registered: ${CURRENCY_CODES.join(", ")}.`,
        );
    }
    return CURRENCIES[code];
}

/**
 * Display scale (decimal places shown to a human) for `code`. Presentation
 * only — never a storage or rounding scale.
 * @param {string} code
 * @returns {number}
 */
function getDisplayScale(code) {
    return getCurrency(code).displayScale;
}

module.exports = {
    CURRENCIES,
    CURRENCY_CODES,
    isValidCurrency,
    getCurrency,
    getDisplayScale,
};
