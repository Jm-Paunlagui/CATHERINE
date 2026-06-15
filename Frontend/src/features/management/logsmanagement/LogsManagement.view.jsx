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
 *
 * Presentation only — state/logic live in logmanagement.hook.js + metrics.hook.js.
 */

import { ArchiveBoxXMarkIcon, ArrowPathIcon, ChartBarIcon, HeartIcon, QueueListIcon, Squares2X2Icon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { ANIMATE_PAGE_ENTER } from "../../../assets/styles/pre-set-styles";
import ErrorBoundary from "../../../components/feedback/ErrorBoundary";
import Button from "../../../components/ui/Button";
import { Tabs } from "../../../components/ui/Tabs";
import HealthTab from "../metrics/components/HealthTab";
import { useMetrics } from "../metrics/metrics.hook";
import AuditLogsPageTab from "./components/AuditLogsPageTab";
import DeleteLoggingTab from "./components/DeleteLoggingTab";
import MetricsPageTab from "./components/MetricsPageTab";
import OverviewPageTab from "./components/OverviewPageTab";
import RequestLogsModal from "./components/RequestLogsModal";
import useLogsManagement from "./logmanagement.hook";

// ─── View ─────────────────────────────────────────────────────────────────────

function LogsManagementView() {
    const logsHook = useLogsManagement();
    const metricsHook = useMetrics();

    // Controlled tab state — enables the alert→logs pivot and the conditional header.
    const [activeTab, setActiveTab] = useState("overview");

    /**
     * Pivot from a route-scoped alert to the Audit Logs tab, pre-filtered to that
     * route. Alert routes look like "GET /api/v1/billing"; filter on the path part.
     * @param {string} route
     */
    const navigateToLogs = (route) => {
        const path = typeof route === "string" && route.includes(" ") ? route.split(" ").slice(1).join(" ") : route;
        logsHook.handleFilterChange("search", path ?? "");
        setActiveTab("audit-logs");
    };

    /** Refresh both the audit data (stats + list) and the live metrics. */
    const handleRefreshAll = () => {
        logsHook.triggerRefresh();
        metricsHook.refetchSnapshot();
        metricsHook.refetchAlerts();
        metricsHook.refetchHealth();
    };

    const tabs = [
        { id: "overview", label: "Overview", icon: Squares2X2Icon, content: <OverviewPageTab metricsHook={metricsHook} logsHook={logsHook} /> },
        { id: "metrics", label: "Metrics", icon: ChartBarIcon, content: <MetricsPageTab hook={metricsHook} onViewLogs={navigateToLogs} /> },
        { id: "audit-logs", label: "Audit Logs", icon: QueueListIcon, content: <AuditLogsPageTab hook={logsHook} /> },
        { id: "health", label: "Health", icon: HeartIcon, content: <HealthTab hook={metricsHook} /> },
        { id: "retention", label: "Log Retention", icon: ArchiveBoxXMarkIcon, content: <DeleteLoggingTab hook={logsHook} /> },
    ];

    return (
        <div className={`p-6 flex flex-col gap-6 h-full ${ANIMATE_PAGE_ENTER}`}>
            {/* ── Page header ──────────────────────────────────────────────── */}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                    <h1 className="text-xl font-aumovio-bold text-black dark:text-white tracking-tight">Logging & Observability</h1>
                    <p className="text-sm text-black/60 dark:text-white/60 mt-0.5">Observe the Four Golden Signals, investigate individual traces, and manage log retention.</p>
                </div>

                {activeTab !== "retention" && (
                    <div className="flex items-center gap-2">
                        {logsHook.isLive && (
                            <span className="flex items-center gap-1.5 text-xs font-aumovio-bold text-success-400">
                                <span className="w-2 h-2 rounded-full bg-success-400 animate-pulse" />
                                Live
                            </span>
                        )}
                        <Button variant="ghost" size="sm" onClick={handleRefreshAll} disabled={logsHook.isRefreshing}>
                            <ArrowPathIcon className={`w-3.5 h-3.5 mr-1.5 ${logsHook.isRefreshing ? "animate-spin text-(--accent-icon)" : ""}`} />
                            {logsHook.isRefreshing ? "Refreshing…" : "Refresh"}
                        </Button>
                    </div>
                )}
            </div>

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
