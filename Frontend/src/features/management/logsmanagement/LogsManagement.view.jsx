import { faRotateRight } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { ArchiveBoxXMarkIcon, ArrowPathIcon, ChartBarIcon, CpuChipIcon, QueueListIcon, SignalIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { ANIMATE_PAGE_ENTER, TRANSITION_COLORS } from "../../../assets/styles/pre-set-styles";
import ErrorBoundary from "../../../components/feedback/ErrorBoundary";
import Button from "../../../components/ui/Button";
import { Tabs } from "../../../components/ui/Tabs";
import AlertsTab from "../metrics/components/AlertsTab";
import HealthTab from "../metrics/components/HealthTab";
import OverviewTab from "../metrics/components/OverviewTab";
import RedMetricsTab from "../metrics/components/RedMetricsTab";
import SystemTab from "../metrics/components/SystemTab";
import { useMetrics } from "../metrics/metrics.hook";
import AuditLogTable from "./components/AuditLogTable";
import AuditStatsRow from "./components/AuditStatsRow";
import DeleteLoggingTab from "./components/DeleteLoggingTab";
import RequestLogsModal from "./components/RequestLogsModal";
import TrafficChartsSection from "./components/TrafficChartsSection";
import useLogsManagement from "./logmanagement.hook";

// ─── Time-range preset helpers ─────────────────────────────────────────────────

const _iso = (d) => d.toISOString().slice(0, 10);
const _today = () => _iso(new Date());

const PRESETS = [
    {
        label: "1D",
        getFrom: () => {
            const d = new Date();
            d.setDate(d.getDate() - 1);
            return _iso(d);
        },
    },
    {
        label: "1W",
        getFrom: () => {
            const d = new Date();
            d.setDate(d.getDate() - 7);
            return _iso(d);
        },
    },
    {
        label: "1M",
        getFrom: () => {
            const d = new Date();
            d.setMonth(d.getMonth() - 1);
            return _iso(d);
        },
    },
    {
        label: "3M",
        getFrom: () => {
            const d = new Date();
            d.setMonth(d.getMonth() - 3);
            return _iso(d);
        },
    },
    {
        label: "6M",
        getFrom: () => {
            const d = new Date();
            d.setMonth(d.getMonth() - 6);
            return _iso(d);
        },
    },
    { label: "YTD", getFrom: () => `${new Date().getFullYear()}-01-01` },
    {
        label: "1Y",
        getFrom: () => {
            const d = new Date();
            d.setFullYear(d.getFullYear() - 1);
            return _iso(d);
        },
    },
    {
        label: "2Y",
        getFrom: () => {
            const d = new Date();
            d.setFullYear(d.getFullYear() - 2);
            return _iso(d);
        },
    },
    {
        label: "5Y",
        getFrom: () => {
            const d = new Date();
            d.setFullYear(d.getFullYear() - 5);
            return _iso(d);
        },
    },
    {
        label: "10Y",
        getFrom: () => {
            const d = new Date();
            d.setFullYear(d.getFullYear() - 10);
            return _iso(d);
        },
    },
    { label: "ALL", getFrom: () => "2000-01-01" },
];

const _fmtRange = (iso) =>
    new Date(iso + "T00:00:00").toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
    });

// ─── Observability tab ────────────────────────────────────────────────────────

function ObservabilityTab({ logsHook, metricsHook }) {
    const [activePreset, setActivePreset] = useState("1M");

    const handlePreset = (preset) => {
        setActivePreset(preset.label);
        logsHook.setStatsDateRange({ fromDate: preset.getFrom(), toDate: _today() });
    };

    const alertCount = metricsHook.alerts?.length ?? 0;
    const metricsTabs = [
        { id: "overview", label: "Overview", content: <OverviewTab hook={metricsHook} /> },
        { id: "red", label: "RED Metrics", content: <RedMetricsTab hook={metricsHook} /> },
        { id: "system", label: "System", content: <SystemTab hook={metricsHook} /> },
        { id: "alerts", label: alertCount > 0 ? `Alerts (${alertCount})` : "Alerts", content: <AlertsTab hook={metricsHook} /> },
        { id: "health", label: "Health", content: <HealthTab hook={metricsHook} /> },
    ];

    return (
        <div className="space-y-8">
            {/* ── Live Traffic ──────────────────────────────────────────────── */}
            <section className="space-y-4">
                <div className="flex items-center gap-2 pb-3 border-b border-black/10 dark:border-white/10">
                    <SignalIcon className="w-4 h-4 text-(--accent-icon) shrink-0" />
                    <h2 className="text-xs font-aumovio-bold text-black/55 dark:text-white/55 tracking-widest uppercase">Live Traffic</h2>
                    {logsHook.isLive && (
                        <span className="flex items-center gap-1 text-xs text-success-400 font-aumovio-bold">
                            <span className="w-1.5 h-1.5 rounded-full bg-success-400 animate-ping" />
                            SSE
                        </span>
                    )}
                </div>

                <TrafficChartsSection trafficSnapshot={logsHook.trafficSnapshot} trafficSeries={logsHook.trafficSeries} />
            </section>

            {/* ── Historical Audit Statistics ───────────────────────────────── */}
            <section className="space-y-4">
                <div className="flex items-center gap-2 pb-3 border-b border-black/10 dark:border-white/10">
                    <ChartBarIcon className="w-4 h-4 text-(--accent-icon) shrink-0" />
                    <h2 className="text-xs font-aumovio-bold text-black/55 dark:text-white/55 tracking-widest uppercase">Historical Audit Statistics</h2>
                </div>

                {/* Time-range selector */}
                <div className="flex flex-col gap-2">
                    <div className="flex flex-wrap gap-1 p-1 bg-grey-100 dark:bg-(--bg-surface-3) rounded-xl w-fit">
                        {PRESETS.map((preset) => {
                            const isActive = activePreset === preset.label;
                            return (
                                <button
                                    key={preset.label}
                                    type="button"
                                    onClick={() => handlePreset(preset)}
                                    className={`px-3 py-1.5 rounded-lg text-xs font-aumovio-bold ${TRANSITION_COLORS}
                                        ${isActive ? "bg-(--bg-surface) dark:bg-(--bg-surface-2) text-(--accent-foreground) shadow-sm" : "text-grey-500 hover:text-(--accent-foreground)"}`}
                                >
                                    {preset.label}
                                </button>
                            );
                        })}
                    </div>

                    <p className="text-xs font-mono text-black/40 dark:text-white/35 pl-1">
                        {_fmtRange(logsHook.statsDateRange.fromDate)}
                        <span className="mx-1.5 text-black/25 dark:text-white/20">→</span>
                        {_fmtRange(logsHook.statsDateRange.toDate)}
                    </p>
                </div>

                <AuditStatsRow hook={logsHook} />
            </section>

            {/* ── Live System Metrics ────────────────────────────────────────── */}
            <section className="space-y-4">
                <div className="flex items-center gap-3 pb-3 border-b border-black/10 dark:border-white/10">
                    <CpuChipIcon className="w-4 h-4 text-purple-400 shrink-0" />
                    <h2 className="text-xs font-aumovio-bold text-black/55 dark:text-white/55 tracking-widest uppercase">Live System Metrics</h2>
                </div>

                <Tabs tabs={metricsTabs} activeTab={metricsHook.activeTab} onChange={metricsHook.setActiveTab} variant="pill" size="sm" />
            </section>
        </div>
    );
}

// ─── View ─────────────────────────────────────────────────────────────────────

function LogsManagementView() {
    const logsHook = useLogsManagement();
    const metricsHook = useMetrics();

    // Track the active tab so we can show the Refresh button only on the Logging tab
    const [activeTab, setActiveTab] = useState("observability");

    const tabs = [
        {
            id: "observability",
            label: "Observability",
            icon: ChartBarIcon,
            content: <ObservabilityTab logsHook={logsHook} metricsHook={metricsHook} />,
        },
        {
            id: "logging",
            label: "Logging",
            icon: QueueListIcon,
            content: <AuditLogTable hook={logsHook} />,
        },
        {
            id: "delete-logging",
            label: "Delete Logging",
            icon: ArchiveBoxXMarkIcon,
            content: <DeleteLoggingTab hook={logsHook} />,
        },
    ];

    return (
        <div className={`p-6 flex flex-col gap-6 h-full ${ANIMATE_PAGE_ENTER}`}>
            {/* ── Page header ──────────────────────────────────────────────── */}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                    <h1 className="text-xl font-aumovio-bold text-black dark:text-white tracking-tight">Logging & Observability</h1>
                    <p className="text-sm text-black/60 dark:text-white/60 mt-0.5">Observe system health, investigate individual traces, and manage log retention.</p>
                </div>

                {activeTab !== "delete-logging" && (
                    <div className="flex items-center gap-2">
                        {logsHook.isLive && (
                            <span className="flex items-center gap-1.5 text-xs font-aumovio-bold text-success-400">
                                <span className="w-2 h-2 rounded-full bg-success-400 animate-pulse" />
                                Live
                            </span>
                        )}
                        <Button variant="ghost" size="sm" onClick={logsHook.triggerRefresh} disabled={logsHook.isRefreshing}>
                            <ArrowPathIcon className={`w-3.5 h-3.5 mr-1.5 ${logsHook.isRefreshing ? "animate-spin text-(--accent-icon)" : ""}`} />
                            {logsHook.isRefreshing ? "Refreshing…" : "Refresh"}
                        </Button>
                    </div>
                )}
            </div>

            {/* ── Tabs + Refresh button ─────────────────────────────────────── */}
            {/* Wrap in a relative container so the Refresh button can sit on   */}
            {/* the same visual row as the pill nav bar, aligned to the right.  */}
            <div className="relative">
                {activeTab === "logging" && (
                    <div className="absolute top-0 right-0 z-10">
                        <Button variant="primary" size="sm" onClick={logsHook.refetchList} disabled={logsHook.listLoading}>
                            <FontAwesomeIcon icon={faRotateRight} className={`w-3.5 h-3.5 mr-1.5 ${logsHook.listLoading ? "animate-spin" : ""}`} />
                            Refresh
                        </Button>
                    </div>
                )}
                <Tabs tabs={tabs} variant="pill" size="md" defaultTab="observability" onChange={setActiveTab} />
            </div>

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
