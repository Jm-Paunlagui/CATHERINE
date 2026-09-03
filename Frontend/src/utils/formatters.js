/**
 * formatters.js — Pure transformation utilities.
 * No React, no HTTP, no side effects.
 */

/** Format a date/string to a readable locale string */
export function formatDate(value, options = {}) {
    if (!value) return "N/A";
    const d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return "Invalid date";
    return d.toLocaleString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        ...options,
    });
}

/** Format date with time included */
export function formatDateTime(value) {
    return formatDate(value, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}

/** Format a number with thousand separators */
export function formatNumber(value) {
    const n = Number(value);
    return isNaN(n) ? "0" : new Intl.NumberFormat("en-US").format(n);
}

/**
 * Abbreviate a count so it stays on one line inside a badge, pill, or
 * fixed-width table cell: 942 → "942", 2 966 → "3K", 9 462 → "9.5K",
 * 1 284 301 → "1.3M".
 *
 * Values under 1 000 are returned exactly — abbreviating them saves no width
 * and only loses information.
 *
 * ⚠ This is a LOSSY display format. Never use it where the exact figure is
 * what the user is acting on — a deletion count on a confirmation screen, a
 * money value, or anything typed back to the server. Pair it with the exact
 * `formatNumber(value)` in a Tooltip or `title` so the precise number is
 * always one hover away.
 *
 * @param {number|string} value
 * @returns {string}
 */
export function formatCompactNumber(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "0";
    if (Math.abs(n) < 1000) return new Intl.NumberFormat("en-US").format(n);
    return new Intl.NumberFormat("en-US", {
        notation: "compact",
        compactDisplay: "short",
        maximumFractionDigits: 1,
    }).format(n);
}

/** Format as currency (default: PHP) */
export function formatCurrency(value, currency = "PHP", locale = "en-PH") {
    const n = Number(value);
    if (isNaN(n)) return "—";
    return new Intl.NumberFormat(locale, {
        style: "currency",
        currency,
        minimumFractionDigits: 2,
    }).format(n);
}

/** Truncate string with ellipsis */
export function truncate(str, max = 50) {
    if (!str) return "";
    return str.length > max ? `${str.slice(0, max)}…` : str;
}

/** "SNAKE_CASE" or "snake_case" → "Snake Case" */
export function toReadableName(str) {
    if (!str) return "";
    return str
        .split(/[_\s-]/)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(" ");
}

/** Mask email: "jo**e@example.com" */
export function maskEmail(email) {
    if (!email || email.includes("*")) return email ?? "";
    const [local, domain] = email.split("@");
    return `${local.slice(0, 2)}**${local.slice(-1)}@${domain}`;
}

/**
 * Format a date for display in period/cutoff selectors.
 * Shows only Month/Day HH:mm — year is omitted because the year is
 * already communicated by the year selector that precedes this field.
 *
 * View-only formatting. Does NOT affect stored values or API payloads.
 *
 * @param {string|Date|null} value
 * @returns {string} e.g. "06/15 08:00" or "—" if falsy/invalid
 */
export function formatCutoffMonthDay(value, referenceYear = null) {
    if (!value) return "—";
    const d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return "—";
    const month  = String(d.getMonth() + 1).padStart(2, "0");
    const day    = String(d.getDate()).padStart(2, "0");
    const hour   = String(d.getHours()).padStart(2, "0");
    const minute = String(d.getMinutes()).padStart(2, "0");
    const year   = d.getFullYear();
    const base   = `${month}/${day} ${hour}:${minute}`;
    // Append short year suffix when crossing a year boundary so the display
    // is unambiguous (e.g. Dec-31 cutoff ends 01/17 '27, not 01/17 which
    // looks like the same year as the year selector).
    return referenceYear !== null && year !== referenceYear
        ? `${base} '${String(year).slice(2)}`
        : base;
}
