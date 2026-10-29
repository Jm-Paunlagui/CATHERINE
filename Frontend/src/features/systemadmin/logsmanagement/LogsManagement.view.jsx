/**
 * @fileoverview Logging & Observability — the unified observability page.
 *
 * Standardized information architecture (industry frameworks: Four Golden
 * Signals, RED, USE, three pillars). Five top-level tabs:
 *   1. Overview       — Golden Signals + Apdex + health-at-a-glance + live traffic
 *   2. Metrics        — RED · System · Dependencies · Frontend Vitals · Alerts
 *   3. Audit Logs     — historical stats + filterable log table (+ trace modal)
 *   4. Health         — liveness / readiness probes
 *   5. Log Retention  — export + delete stepper
 *   6. Archive Reader — offline reader for exported Excel + log ZIP artifacts
 *
 * Presentation only — state/logic live in logmanagement.hook.js + metrics.hook.js.
 */

import { ArchiveBoxXMarkIcon, ArrowPathIcon, ChartBarIcon, FolderOpenIcon, HeartIcon, QueueListIcon, Squares2X2Icon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { ANIMATE_PAGE_ENTER } from "../../../assets/styles/pre-set-styles";
import ApiErrorAlert from "../../../components/feedback/ApiErrorAlert";
import ErrorBoundary from "../../../components/feedback/ErrorBoundary";
import Button from "../../../components/ui/Button";
import { Tabs } from "../../../components/ui/Tabs";
import HealthTab from "../metrics/components/HealthTab";
import { METRICS_NEEDS, useMetrics } from "../metrics/metrics.hook";
import useArchiveReader from "./archiveReader.hook";
import ArchiveReaderTab from "./components/ArchiveReaderTab";
import AuditLogsPageTab from "./components/AuditLogsPageTab";
import DeleteLoggingTab from "./components/DeleteLoggingTab";
import MetricsPageTab from "./components/MetricsPageTab";
import OverviewPageTab from "./components/OverviewPageTab";
import RequestLogsModal from "./components/RequestLogsModal";
import useLogsManagement from "./logmanagement.hook";

// ─── Tab-gated fetching ─────────────────────────────────────────────────────
// This view has its OWN top-level tab vocabulary, so it computes its own
// useMetrics() `needs` map. "overview" needs almost everything (health
// banner + Apdex + liveness/readiness strip + Golden Signals all come from
// summary/alerts/snapshot/health); "metrics" needs whatever any of its RED /
// System / Dependencies / Frontend Vitals / Alerts sub-tabs render (that
// sub-tab switcher is an uncontrolled <Tabs defaultTab="red"> inside
// MetricsPageTab, so gating stops at this granularity rather than the
// sub-tab); "audit-logs" / "retention" / "archive-reader" render no metrics
// data at all — an empty array (NOT omitted) turns every useMetrics() fetch
// off while those tabs are open.
const METRICS_TAB_NEEDS = {
    overview: [METRICS_NEEDS.SUMMARY, METRICS_NEEDS.ALERTS, METRICS_NEEDS.SNAPSHOT, METRICS_NEEDS.HEALTH],
    metrics: [METRICS_NEEDS.SNAPSHOT, METRICS_NEEDS.ALERTS, METRICS_NEEDS.NOTIFICATIONS],
    "audit-logs": [],
    health: [METRICS_NEEDS.HEALTH],
    retention: [],
    "archive-reader": [],
};

// ─── View ─────────────────────────────────────────────────────────────────────

function LogsManagementView() {
    // Controlled tab state — enables the alert→logs pivot and the conditional header.
    // Computed BEFORE the feature hooks so it can gate both useMetrics() (via
    // `needs`) and useLogsManagement() (via `activeTab`) on the very first render.
    const [activeTab, setActiveTab] = useState("overview");

    const logsHook = useLogsManagement({ activeTab });
    const metricsHook = useMetrics({ needs: METRICS_TAB_NEEDS[activeTab] ?? [] });
    const archiveHook = useArchiveReader();

    /**
     * Pivot from a route-scoped alert to the Audit Logs tab, pre-filtered to that
     * route. Alert routes look like "GET /api/v1/changelog" (a RED-metrics key);
     * `applyEndpointFilter` strips the verb and pins the EXACT `endpoint` filter.
     *
     * An alert carries no request id to pivot on — it is an aggregate over a
     * window (p99, error rate), so the route is the only correlation key it has.
     * That is why this fills the route filter, not the search box.
     *
     * ⚠ It used to write the path into `search` instead, which silently returned
     * nothing on every click: that box is a server-side $or over USERNAME /
     * CLIENT_IP / REQUEST_ID and did not cover ENDPOINT at all. Do not route this
     * back through `search` — the exact filter is index-backed
     * (IDX_AUDIT_LOGS_ENDPOINT) and cannot be matched by a coincidental
     * substring of another column.
     *
     * @param {string} route
     */
    const navigateToLogs = (route) => {
        logsHook.applyEndpointFilter(route);
        setActiveTab("audit-logs");
    };

    /**
     * Refresh both the audit data (stats + list) and the live metrics. Any of
     * the four metrics refetches is a harmless no-op when its dataset is
     * gated off for the current tab (useRequest's `enabled: false` short-
     * circuits `execute()` before any HTTP call) — this always refreshes
     * whatever the active tab actually shows.
     */
    const handleRefreshAll = () => {
        logsHook.triggerRefresh();
        metricsHook.refetchSnapshot();
        metricsHook.refetchSummary();
        metricsHook.refetchAlerts();
        metricsHook.refetchHealth();
    };

    const tabs = [
        { id: "overview", label: "Overview", icon: Squares2X2Icon, content: <OverviewPageTab metricsHook={metricsHook} logsHook={logsHook} /> },
        { id: "metrics", label: "Metrics", icon: ChartBarIcon, content: <MetricsPageTab hook={metricsHook} onViewLogs={navigateToLogs} /> },
        { id: "audit-logs", label: "Audit Logs", icon: QueueListIcon, content: <AuditLogsPageTab hook={logsHook} /> },
        { id: "health", label: "Health", icon: HeartIcon, content: <HealthTab hook={metricsHook} /> },
        { id: "retention", label: "Log Retention", icon: ArchiveBoxXMarkIcon, content: <DeleteLoggingTab hook={logsHook} /> },
        { id: "archive-reader", label: "Archive Reader", icon: FolderOpenIcon, content: <ArchiveReaderTab hook={archiveHook} /> },
    ];

    return (
        <div className={`p-6 flex flex-col gap-4 h-full ${ANIMATE_PAGE_ENTER}`}>
            {/* ── Page header ──────────────────────────────────────────────── */}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                    <h1 className="text-xl font-aumovio-bold text-black dark:text-white tracking-tight">Logging & Observability</h1>
                    <p className="text-sm text-black/60 dark:text-white/60 mt-1">Observe the Four Golden Signals, investigate individual traces, and manage log retention.</p>
                </div>

                {activeTab !== "retention" && activeTab !== "archive-reader" && (
                    <div className="flex items-center gap-2">
                        <Button variant="ghost" size="sm" onClick={handleRefreshAll} disabled={logsHook.isRefreshing}>
                            <ArrowPathIcon className={`w-3.5 h-3.5 mr-1.5 ${logsHook.isRefreshing ? "animate-spin text-(--accent-icon)" : ""}`} />
                            {logsHook.isRefreshing ? "Refreshing…" : "Refresh"}
                        </Button>
                    </div>
                )}
            </div>
            {/* View-level API error — suppressed while the trace modal is open (it renders its own) */}
            {!logsHook.logsModalOpen && <ApiErrorAlert error={logsHook.apiError} onDismiss={() => logsHook.setApiError(null)} />}
            {/* ── Tabs ─────────────────────────────────────────────────────── */}
            <Tabs tabs={tabs} variant="pill" size="md" activeTab={activeTab} onChange={setActiveTab} />

            {/* Modal lives outside the tabs so it renders on any active tab */}
            <RequestLogsModal hook={logsHook} />
        </div>
    );
}

export default function LogsManagementViewWrapped() {
    return (
        <ErrorBoundary>
            <LogsManagementView />
        </ErrorBoundary>
    );
}
