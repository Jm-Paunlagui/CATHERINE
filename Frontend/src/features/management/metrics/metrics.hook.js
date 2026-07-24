/**
 * @fileoverview Hook for the metrics observability dashboard.
 * Manages all state, data fetching, and formatting for the Metrics.view.jsx.
 * Auto-refreshes every 30 s via useRequest staleTime.
 */

import { useEffect, useMemo, useState } from "react";
import { extractApiError, toast } from "../../../components/ui/toast.utils";
import { useRequest } from "../../../hooks/useRequest";
import AuthMiddleware from "../../../middleware/authentication/AuthMiddleware";
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

/**
 * Formats a future ISO timestamp as a short "Xh left" / "Xm left" string for
 * the acknowledgement badge ("Acked by {name} · expires in Xh").
 * Returns "expired" for a timestamp already in the past — a stale ack the
 * backend guard hasn't cleared yet on this exact render tick (it clears
 * live on the next poll tick regardless).
 *
 * @param {string|null|undefined} iso
 * @returns {string}
 */
export function formatExpiresIn(iso) {
    if (!iso) return "—";
    const ms = new Date(iso).getTime() - Date.now();
    if (!Number.isFinite(ms)) return "—";
    if (ms <= 0) return "expired";
    const hours = ms / 3_600_000;
    if (hours < 1) return `${Math.max(1, Math.round(ms / 60_000))}m left`;
    return `${Math.round(hours)}h left`;
}

/**
 * Canonical display order for the Core Web Vitals.
 * @constant {Object.<string, number>}
 */
const VITAL_ORDER = { LCP: 0, INP: 1, CLS: 2, FID: 3 };

/**
 * Aggregate raw frontend web-vital events into per-metric summary cards.
 * For each metric name returns the sample count, average value, the
 * good/needs-improvement/poor distribution, and the worst rating observed
 * (which drives the summary card colour).
 *
 * @param {Array<{ name: string, value: number, rating: string }>} [vitals=[]]
 * @returns {Array<{ name: string, count: number, avg: number, good: number, needsImprovement: number, poor: number, rating: string }>}
 */
export function buildVitalsSummary(vitals = []) {
    const byName = new Map();
    for (const v of vitals) {
        if (!v || !v.name) continue;
        let agg = byName.get(v.name);
        if (!agg) {
            agg = { name: v.name, count: 0, sum: 0, good: 0, needsImprovement: 0, poor: 0 };
            byName.set(v.name, agg);
        }
        agg.count++;
        agg.sum += Number(v.value) || 0;
        if (v.rating === "good") agg.good++;
        else if (v.rating === "needs-improvement") agg.needsImprovement++;
        else if (v.rating === "poor") agg.poor++;
    }
    return [...byName.values()]
        .map((a) => ({
            name: a.name,
            count: a.count,
            avg: a.count ? a.sum / a.count : 0,
            good: a.good,
            needsImprovement: a.needsImprovement,
            poor: a.poor,
            // Worst rating present drives the card colour ("not blind" bias).
            rating: a.poor > 0 ? "poor" : a.needsImprovement > 0 ? "needs-improvement" : "good",
        }))
        .sort((x, y) => (VITAL_ORDER[x.name] ?? 99) - (VITAL_ORDER[y.name] ?? 99));
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
 * @property {Function}     formatExpiresIn  - "Xh left" formatter for the ack-expiry badge
 * @property {number}       ackTtlHours      - Configured ALERT_ACK_TTL_HOURS
 * @property {boolean}      ackModalOpen     - Whether the Acknowledge confirm modal is open
 * @property {string|null}  ackTargetKey     - alertKey the Acknowledge modal targets
 * @property {string}       ackNote          - Optional note text bound to the Acknowledge modal
 * @property {Function}     setAckNote       - Updates ackNote
 * @property {boolean}      ackLoading       - Whether an acknowledge request is in flight
 * @property {string|null}  unackLoadingKey  - alertKey currently being unacknowledged, if any
 * @property {Function}     openAckModal     - (alertKey) => void — opens the Acknowledge modal
 * @property {Function}     closeAckModal    - Closes the Acknowledge modal
 * @property {Function}     confirmAcknowledge - Confirms the acknowledge action for ackTargetKey
 * @property {Function}     unacknowledgeAlert - (alertKey) => Promise<boolean> — clears an ack
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

    // Health probes — liveness + readiness (own tab). Fetched here so HealthTab
    // stays presentation-only and never touches httpClient (three-layer rule).
    const { data: liveData, loading: liveLoading, error: liveError, refetch: refetchLive } = useRequest("health/live", metricsApi.healthLive, { staleTime: 30_000 });
    const { data: readyData, loading: readyLoading, error: readyError, refetch: refetchReady } = useRequest("health/ready", metricsApi.healthReady, { staleTime: 30_000 });

    // Derive typed data from raw API responses
    const snapshot = snapshotData?.data ?? null;
    const summary = summaryData?.data ?? null;
    const alerts = alertsData?.data?.alerts ?? [];

    // Health derivations
    const liveness = liveData?.data ?? null;
    const readiness = readyData?.data ?? null;
    const healthLoading = liveLoading || readyLoading;
    const healthError = liveError || readyError;
    const refetchHealth = () => {
        refetchLive();
        refetchReady();
    };

    // Surfaced-but-previously-invisible telemetry
    const oracleDeps = snapshot?.dependencies?.oracle ?? {};
    const apdex = snapshot?.totals?.apdex ?? null;
    const frontendErrors = snapshot?.frontendErrors ?? [];
    const vitalsSummary = useMemo(
        () => buildVitalsSummary(snapshot?.frontendVitals ?? []),
        [snapshot],
    );

    // ── Current user (SUPER_ADMIN gate on the notification test-send control) ──
    const [currentUser, setCurrentUser] = useState(null);
    useEffect(() => {
        let cancelled = false;
        AuthMiddleware.isAuth().then((u) => {
            if (!cancelled) setCurrentUser(u ?? null);
        });
        return () => {
            cancelled = true;
        };
    }, []);
    const isSuperAdmin = currentUser?.role === "SUPER_ADMIN";

    // ── Server Email Notifications — status panel ──
    const {
        data: notificationStatusData,
        loading: notificationStatusLoading,
        error: notificationStatusError,
        refetch: refetchNotificationStatus,
    } = useRequest("metrics/notifications/status", metricsApi.notificationStatus, { staleTime: 30_000 });
    const notificationStatus = notificationStatusData?.data ?? null;
    const notificationStatusErrorMessage = notificationStatusError ? extractApiError(notificationStatusError, "Failed to load notification status.").message : null;

    // ── Server Email Notifications — test send (SUPER_ADMIN only) ──
    const [testSendChannel, setTestSendChannel] = useState("");
    const [testSendLoading, setTestSendLoading] = useState(false);

    /**
     * Sends a one-off test digest email on `testSendChannel`. Toasts success
     * or a friendly error and refreshes the status panel either way (a
     * failed attempt still updates SMTP delivery-health counters).
     *
     * @returns {Promise<boolean>}
     */
    const sendTestNotification = async () => {
        if (!testSendChannel) {
            toast.error("Choose a channel first.");
            return false;
        }
        setTestSendLoading(true);
        try {
            const res = await metricsApi.testSendNotification(testSendChannel);
            toast.success(res.data?.message || res.message || "Test notification sent.");
            return true;
        } catch (err) {
            toast.error(extractApiError(err, "Failed to send the test notification.").message);
            return false;
        } finally {
            setTestSendLoading(false);
            refetchNotificationStatus();
        }
    };

    // ── Alert History sub-tab ──
    // Active | History nested-Tabs state inside the Alerts area — controlled
    // here (not locally in AlertsTab.jsx) so the History fetch below can be
    // gated behind actually opening the History toggle rather than firing
    // unconditionally the instant useMetrics() mounts.
    const [alertsView, setAlertsView] = useState("active");
    const [historyFilters, setHistoryFilters] = useState({ severity: "", rule: "", from: "", to: "" });
    const [historyPage, setHistoryPage] = useState(1);
    const historyLimit = 25;

    const historyKey = `metrics/alerts/history?severity=${historyFilters.severity}&rule=${historyFilters.rule}&from=${historyFilters.from}&to=${historyFilters.to}&page=${historyPage}`;
    const {
        data: alertHistoryData,
        loading: alertHistoryLoading,
        error: alertHistoryError,
        refetch: refetchAlertHistory,
    } = useRequest(
        historyKey,
        () =>
            metricsApi.alertHistory({
                severity: historyFilters.severity || undefined,
                rule: historyFilters.rule || undefined,
                from: historyFilters.from || undefined,
                to: historyFilters.to || undefined,
                page: historyPage,
                limit: historyLimit,
            }),
        { staleTime: 30_000, enabled: alertsView === "history" },
    );
    const alertHistoryErrorMessage = alertHistoryError ? extractApiError(alertHistoryError, "Failed to load alert history.").message : null;

    /**
     * Update one Alert History filter field and reset pagination to page 1.
     * @param {string} field - "severity" | "rule" | "from" | "to"
     * @param {string} value
     */
    const handleHistoryFilterChange = (field, value) => {
        setHistoryFilters((prev) => (prev[field] === value ? prev : { ...prev, [field]: value }));
        setHistoryPage(1);
    };

    // ── Alert Acknowledgement ──
    const [ackModalOpen, setAckModalOpen] = useState(false);
    const [ackTargetKey, setAckTargetKey] = useState(null);
    const [ackNote, setAckNote] = useState("");
    const [ackLoading, setAckLoading] = useState(false);
    const [unackLoadingKey, setUnackLoadingKey] = useState(null);

    /**
     * Opens the Acknowledge confirm modal for `alertKey`, resetting the note field.
     * @param {string} alertKey
     */
    const openAckModal = (alertKey) => {
        setAckTargetKey(alertKey);
        setAckNote("");
        setAckModalOpen(true);
    };

    /** Closes the Acknowledge confirm modal and resets its local state. */
    const closeAckModal = () => {
        setAckModalOpen(false);
        setAckTargetKey(null);
        setAckNote("");
    };

    /**
     * Confirms acknowledgement of `ackTargetKey` with the current `ackNote`.
     * Toasts success/failure and refetches the active alerts either way so
     * the row's acked badge / button state stays in sync with the server.
     *
     * @returns {Promise<boolean>}
     */
    const confirmAcknowledge = async () => {
        if (!ackTargetKey) return false;
        setAckLoading(true);
        try {
            const res = await metricsApi.acknowledgeAlert(ackTargetKey, ackNote || undefined);
            toast.success(res.data?.message || res.message || "Alert acknowledged.");
            closeAckModal();
            return true;
        } catch (err) {
            toast.error(extractApiError(err, "Failed to acknowledge the alert.").message);
            return false;
        } finally {
            setAckLoading(false);
            refetchAlerts();
        }
    };

    /**
     * Clears the acknowledgement for `alertKey` (explicit admin "never mind").
     * Toasts success/failure and refetches the active alerts either way.
     *
     * @param {string} alertKey
     * @returns {Promise<boolean>}
     */
    const unacknowledgeAlert = async (alertKey) => {
        setUnackLoadingKey(alertKey);
        try {
            const res = await metricsApi.unacknowledgeAlert(alertKey);
            toast.success(res.data?.message || res.message || "Acknowledgement cleared.");
            return true;
        } catch (err) {
            toast.error(extractApiError(err, "Failed to clear the acknowledgement.").message);
            return false;
        } finally {
            setUnackLoadingKey(null);
            refetchAlerts();
        }
    };

    /** RED metrics flattened into rows for the Table component.
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

        // Health probes
        liveness,
        readiness,
        healthLoading,
        healthError,
        refetchHealth,

        // Surfaced telemetry (previously collected but never displayed)
        oracleDeps,
        apdex,
        vitalsSummary,
        frontendErrors,

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
        formatExpiresIn,

        // Current user (SUPER_ADMIN gate)
        currentUser,
        isSuperAdmin,

        // Server Email Notifications — status panel
        notificationStatus,
        notificationStatusLoading,
        notificationStatusError,
        notificationStatusErrorMessage,
        refetchNotificationStatus,

        // Server Email Notifications — test send
        testSendChannel,
        setTestSendChannel,
        testSendLoading,
        sendTestNotification,

        // Alert History sub-tab
        alertsView,
        setAlertsView,
        historyFilters,
        historyPage,
        alertHistoryData,
        alertHistoryLoading,
        alertHistoryError,
        alertHistoryErrorMessage,
        refetchAlertHistory,
        handleHistoryFilterChange,
        setHistoryPage,

        // Alert Acknowledgement
        ackTtlHours: notificationStatus?.ackTtlHours ?? 24,
        ackModalOpen,
        ackTargetKey,
        ackNote,
        setAckNote,
        ackLoading,
        unackLoadingKey,
        openAckModal,
        closeAckModal,
        confirmAcknowledge,
        unacknowledgeAlert,
    };
}

export default useMetrics;
