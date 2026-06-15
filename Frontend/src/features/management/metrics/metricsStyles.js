/**
 * Range-based Tailwind color-style functions for the metrics components.
 * Mirrors the getStatusCodeStyle pattern from AuditLogTable.jsx.
 *
 * Each function returns a 'bg-X/15 text-X' class string suitable for pill badges.
 * Use pillCls() to build a full pill class. Use textCls() when only a text color is needed.
 */

// ─── Pill helpers ─────────────────────────────────────────────────────────────

/** Combine a style result with pill shape classes. */
export const PILL_BASE = "inline-flex items-center text-xs font-semibold px-2 py-0.5 rounded-full border border-current/20";

/** Extract just the text-* class from a style string (for large number displays). */
export function textCls(style) {
    return style.split(" ").find((c) => c.startsWith("text-")) ?? "text-grey-700 dark:text-white/85";
}

/**
 * Maps every text-* token produced by the style helpers to a MetricCard-style
 * icon badge class (background + border). All class names are literal strings
 * so Tailwind JIT detects and compiles them — never construct border-* dynamically.
 */
const _BADGE_MAP = {
    "text-success-300": "bg-success-300/15 border-success-300/30",
    "text-success-400": "bg-success-400/15 border-success-400/30",
    "text-success-500": "bg-success-500/15 border-success-500/30",
    "text-warn-400":    "bg-warn-400/20 border-warn-400/30",
    "text-warn-500":    "bg-warn-500/20 border-warn-500/30",
    "text-warn-600":    "bg-warn-600/20 border-warn-600/30",
    "text-danger-400":  "bg-danger-400/15 border-danger-400/30",
    "text-danger-600":  "bg-danger-600/15 border-danger-600/30",
};

/**
 * Derives a MetricCard-style icon badge background + border from a dynamic
 * style string (e.g. from getErrorRateStyle / getLagStyle).
 *
 * @param {string} style - A "bg-X/opacity text-X" class string
 * @returns {string} Badge container classes safe for Tailwind JIT
 */
export function badgeCls(style) {
    return _BADGE_MAP[textCls(style)] ?? "bg-grey-100/15 border-grey-300/30";
}

// ─── Error rate  (0.0 – 1.0 ratio) ───────────────────────────────────────────

export function getErrorRateStyle(rate) {
    const r = Number(rate) || 0;
    if (r < 0.001) return "bg-success-300/15 text-success-300";
    if (r < 0.01) return "bg-success-400/15 text-success-400";
    if (r < 0.05) return "bg-warn-400/20 text-warn-400";
    if (r < 0.1) return "bg-warn-500/20 text-warn-500";
    if (r < 0.2) return "bg-danger-400/15 text-danger-400";
    return "bg-danger-600/15 text-danger-600";
}

// ─── Availability  (0.0 – 1.0 ratio, higher is better) ───────────────────────

/**
 * Style for a request-based availability ratio (success / (success + 5xx)).
 * Inverse polarity to error rate: closer to 1.0 (100%) is healthier.
 * Thresholds mirror common SLO tiers (three-nines / two-nines).
 *
 * @param {number} ratio - 0.0–1.0 availability
 * @returns {string} "bg-X/opacity text-X" pill class
 */
export function getAvailabilityStyle(ratio) {
    const r = Number.isFinite(Number(ratio)) ? Number(ratio) : 1;
    if (r >= 0.999) return "bg-success-300/15 text-success-300";
    if (r >= 0.995) return "bg-success-400/15 text-success-400";
    if (r >= 0.99) return "bg-success-500/15 text-success-500";
    if (r >= 0.95) return "bg-warn-400/20 text-warn-400";
    if (r >= 0.9) return "bg-warn-600/20 text-warn-600";
    return "bg-danger-400/15 text-danger-400";
}

// ─── Response / query latency  (ms) ──────────────────────────────────────────

export function getLatencyStyle(ms) {
    const n = Number(ms) || 0;
    if (n === 0) return "bg-grey-100/15 text-grey-400";
    if (n < 50) return "bg-success-300/15 text-success-300";
    if (n < 100) return "bg-success-400/15 text-success-400";
    if (n < 200) return "bg-success-500/15 text-success-500";
    if (n < 500) return "bg-warn-400/20 text-warn-400";
    if (n < 1000) return "bg-warn-500/20 text-warn-500";
    if (n < 2000) return "bg-danger-400/15 text-danger-400";
    return "bg-danger-600/15 text-danger-600";
}

// ─── Event-loop lag  (ms, setImmediate probe) ─────────────────────────────────

export function getLagStyle(ms) {
    const n = Number(ms) || 0;
    if (n < 5) return "bg-success-300/15 text-success-300";
    if (n < 10) return "bg-success-400/15 text-success-400";
    if (n < 50) return "bg-warn-400/20 text-warn-400";
    if (n < 100) return "bg-warn-600/20 text-warn-600";
    return "bg-danger-400/15 text-danger-400";
}

// ─── Heap usage  (0 – 100 %) ─────────────────────────────────────────────────

export function getHeapPctStyle(pct) {
    const n = Number(pct) || 0;
    if (n < 40) return "bg-success-300/15 text-success-300";
    if (n < 60) return "bg-success-400/15 text-success-400";
    if (n < 70) return "bg-success-500/15 text-success-500";
    if (n < 80) return "bg-warn-400/20 text-warn-400";
    if (n < 90) return "bg-warn-600/20 text-warn-600";
    return "bg-danger-400/15 text-danger-400";
}

// ─── Alert severity label ─────────────────────────────────────────────────────

export function getAlertSeverityStyle(severity) {
    switch (String(severity).toLowerCase()) {
        case "emergency":
            return "bg-danger-600/15 text-danger-600";
        case "alert":
            return "bg-danger-500/15 text-danger-500";
        case "critical":
            return "bg-danger-400/15 text-danger-400";
        case "warning":
            return "bg-warn-400/20 text-warn-400";
        default:
            return "bg-grey-100/15 text-grey-500";
    }
}

// ─── Dependency health-check probe latency  (ms) ─────────────────────────────

export function getHealthLatencyStyle(ms) {
    const n = Number(ms) || 0;
    if (n < 10) return "bg-success-300/15 text-success-300";
    if (n < 50) return "bg-success-400/15 text-success-400";
    if (n < 100) return "bg-success-500/15 text-success-500";
    if (n < 200) return "bg-warn-400/20 text-warn-400";
    if (n < 500) return "bg-warn-600/20 text-warn-600";
    return "bg-danger-400/15 text-danger-400";
}

// ─── CPU delta  (ms over the last 10 s polling window) ───────────────────────

export function getCpuStyle(ms) {
    const n = Number(ms) || 0;
    if (n < 100) return "bg-success-300/15 text-success-300";
    if (n < 500) return "bg-success-400/15 text-success-400";
    if (n < 1000) return "bg-warn-400/20 text-warn-400";
    if (n < 3000) return "bg-warn-600/20 text-warn-600";
    return "bg-danger-400/15 text-danger-400";
}

// ─── Oracle pool utilization  (0.0 – 1.0 ratio, in-use ÷ open) ────────────────

/**
 * Style for an Oracle connection-pool utilization ratio (connectionsInUse /
 * connectionsOpen). Thresholds mirror the backend ORACLE_POOL_SATURATION alert
 * (warning > 80%, critical > 95%) so the pill colour matches when an alert fires.
 *
 * @param {number} ratio - 0.0–1.0 utilization
 * @returns {string} "bg-X/opacity text-X" pill class
 */
export function getPoolUtilStyle(ratio) {
    const n = (Number(ratio) || 0) * 100;
    if (n < 50) return "bg-success-300/15 text-success-300";
    if (n < 70) return "bg-success-400/15 text-success-400";
    if (n < 80) return "bg-success-500/15 text-success-500";
    if (n < 95) return "bg-warn-400/20 text-warn-400";
    return "bg-danger-400/15 text-danger-400";
}

// ─── Active handles / requests count ─────────────────────────────────────────

export function getHandlesStyle(count) {
    const n = Number(count) || 0;
    if (n < 10) return "bg-success-400/15 text-success-400";
    if (n < 50) return "bg-success-500/15 text-success-500";
    if (n < 100) return "bg-warn-400/20 text-warn-400";
    return "bg-danger-400/15 text-danger-400";
}
