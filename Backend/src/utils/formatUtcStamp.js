"use strict";

/**
 * formatUtcStamp — "Nov 3, 2026, 2:32 PM" style date-time text, identical on every JS engine.
 *
 * `toLocaleString("en-US", { dateStyle: "medium", timeStyle })` is not portable: V8 (Node) joins
 * the date and time with ", " while JavaScriptCore (Bun) joins them with " at ". Email bodies and
 * their tests depend on the exact text, so this builds it from `formatToParts`, which returns the
 * same field values on both engines, and supplies the separators itself.
 *
 * @param {Date} date - The instant to format. It is rendered in UTC; callers that want a fixed
 *   offset shift the Date first and append their own `UTC±HH:MM` label.
 * @param {{ seconds?: boolean }} [opts] - `seconds: true` matches `timeStyle: "medium"`;
 *   the default matches `timeStyle: "short"`.
 * @returns {string} e.g. "Nov 3, 2026, 2:32 PM" or "Nov 3, 2026, 2:32:05 PM".
 */
function formatUtcStamp(date, { seconds = false } = {}) {
    const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: "UTC",
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        ...(seconds ? { second: "2-digit" } : {}),
        hour12: true,
    });
    const p = Object.fromEntries(fmt.formatToParts(date).map(({ type, value }) => [type, value]));
    const time = seconds ? `${p.hour}:${p.minute}:${p.second}` : `${p.hour}:${p.minute}`;
    return `${p.month} ${p.day}, ${p.year}, ${time} ${p.dayPeriod}`;
}

module.exports = { formatUtcStamp };
