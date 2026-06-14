/**
 * @fileoverview Hook for the metrics observability dashboard.
 * Manages all state, data fetching, and formatting for the Metrics.view.jsx.
 * Auto-refreshes every 30 s via useRequest staleTime.
 */

import { useMemo, useState } from "react";
import { useRequest } from "../../../hooks/useRequest";
import { metricsApi } from "./metrics.api";

// ─── Formatting helpers (exported for testability) ────────────────────────────

/**
 * Format a duration in milliseconds to a human-readable string.
 * Sub-1000 ms: "42ms", above 1000 ms: "1.23s".
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatMs(ms) {
    if (ms == null || isNaN(ms)) return "—";
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Format bytes to a human-readable string (KB, MB, GB).
 *
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
    if (bytes == null || isNaN(bytes)) return "—";
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

/**
 * Format a ratio (0–1) as a percentage string.
 *
 * @param {number} ratio - 0.0–1.0
 * @param {number} [decimals=1] - Decimal places (use 2 for SLO-grade availability)
 * @returns {string}
 */
export function formatPct(ratio, decimals = 1) {
    if (ratio == null || isNaN(ratio)) return "—";
    return `${(ratio * 100).toFixed(decimals)}%`;
}

/**
 * Derive a Badge variant from a server-error rate ratio (5xx-only).
 * Thresholds match the backend alert tiers (1% warning, 5% critical).
 *
 * @param {number} rate - 0.0–1.0
 * @returns {"success"|"warning"|"danger"}
 */
export function errorRateVariant(rate) {
    if (rate >= 0.05) return "danger";
    if (rate >= 0.01) return "warning";
    return "success";
}

/**
 * Derive a Badge variant from an availability ratio (higher is better).
 *
 * @param {number} ratio - 0.0–1.0
 * @returns {"success"|"warning"|"danger"}
 */
export function availabilityVariant(ratio) {
    if (ratio >= 0.99) return "success";
    if (ratio >= 0.95) return "warning";
    return "danger";
}

/**
 * Derive a Badge variant from event-loop lag in milliseconds.
 *
 * @param {number} lagMs
 * @returns {"success"|"warning"|"danger"}
 */
export function lagVariant(lagMs) {
    if (lagMs >= 100) return "danger";
    if (lagMs >= 10) return "warning";
    return "success";
}

/**
 * Derive a Badge variant from an alert severity string.
 *
 * @param {"warning"|"critical"|"emergency"} severity
 * @returns {"warning"|"danger"}
 */
export function alertSeverityVariant(severity) {
    if (severity === "emergency" || severity === "critical") return "danger";
    return "warning";
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * @typedef {object} MetricsHook
 * @property {object|null}  snapshot         - Full metrics snapshot
 * @property {object|null}  summary          - Abbreviated summary
 * @property {Array}        alerts           - Alert evaluations array
 * @property {boolean}      snapshotLoading  - Whether snapshot is loading
 * @property {boolean}      summaryLoading   - Whether summary is loading
 * @property {boolean}      alertsLoading    - Whether alerts are loading
 * @property {Error|null}   snapshotError    - Snapshot fetch error
 * @property {Error|null}   summaryError     - Summary fetch error
 * @property {Error|null}   alertsError      - Alerts fetch error
 * @property {Function}     refetchSnapshot  - Manually refresh snapshot
 * @property {Function}     refetchAlerts    - Manually refresh alerts
 * @property {string}       activeTab        - Currently active tab id
 * @property {Function}     setActiveTab     - Change active tab
 * @property {Array}        redRows          - RED metrics formatted for Table
 * @property {Function}     formatMs         - Duration formatter
 * @property {Function}     formatBytes      - Byte formatter
 * @property {Function}     formatPct        - Percentage formatter
 * @property {Function}     errorRateVariant - Badge variant helper for error rates
 * @property {Function}     availabilityVariant - Badge variant helper for availability
 * @property {Function}     lagVariant       - Badge variant helper for EL lag
 * @property {Function}     alertSeverityVariant - Badge variant for alert severity
 */

/**
 * Business logic, state, and formatted data for the Metrics observability dashboard.
 * Uses useRequest with staleTime: 30_000 so each cache entry auto-expires and
 * causes a background refetch on next render cycle after 30 s.
 *
 * @returns {MetricsHook}
 */
export function useMetrics() {
    const [activeTab, setActiveTab] = useState("overview");

    // Full snapshot — heavy, only shown to senior admins
    const { data: snapshotData, loading: snapshotLoading, error: snapshotError, refetch: refetchSnapshot } = useRequest("metrics/snapshot", metricsApi.snapshot, { staleTime: 30_000 });

    // Summary — lighter, shown to all authenticated users
    const { data: summaryData, loading: summaryLoading, error: summaryError } = useRequest("metrics/summary", metricsApi.summary, { staleTime: 30_000 });

    // Alert evaluations
    const { data: alertsData, loading: alertsLoading, error: alertsError, refetch: refetchAlerts } = useRequest("metrics/alerts", metricsApi.alerts, { staleTime: 30_000 });

    // Derive typed data from raw API responses
    const snapshot = snapshotData?.data ?? null;
    const summary = summaryData?.data ?? null;
    const alerts = alertsData?.data?.alerts ?? [];

    /**
     * RED metrics flattened into rows for the Table component.
     * Sorted by p95 descending so the slowest routes appear first.
     */
    const redRows = useMemo(() => {
        if (!snapshot?.red) return [];
        return Object.entries(snapshot.red)
            .map(([route, m]) => ({
                route,
                count: m.count,
                // Raw numeric values — used by getLatencyStyle / getErrorRateStyle in RedMetricsTab
                _errorRate: m.errorRate,
                _p50Raw: m.p50,
                _p95Raw: m.p95,
                _p99Raw: m.p99,
                _avgRaw: m.avgMs,
                // Formatted display strings
                errorRateDisplay: formatPct(m.errorRate),
                p50: formatMs(m.p50),
                p95: formatMs(m.p95),
                p99: formatMs(m.p99),
                avg: formatMs(m.avgMs),
            }))
            .sort((a, b) => b._p95Raw - a._p95Raw);
    }, [snapshot]);

    return {
        // Raw data
        snapshot,
        summary,
        alerts,

        // Loading states
        snapshotLoading,
        summaryLoading,
        alertsLoading,

        // Error states
        snapshotError,
        summaryError,
        alertsError,

        // Refetch
        refetchSnapshot,
        refetchAlerts,

        // UI state
        activeTab,
        setActiveTab,

        // Derived / formatted
        redRows,

        // Formatters and helpers (exposed so sub-components don't need to import them)
        formatMs,
        formatBytes,
        formatPct,
        errorRateVariant,
        availabilityVariant,
        lagVariant,
        alertSeverityVariant,
    };
}

export default useMetrics;
