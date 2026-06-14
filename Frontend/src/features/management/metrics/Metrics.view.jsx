/**
 * @fileoverview Metrics Observability Dashboard view.
 * Presentation only — all state and logic live in metrics.hook.js.
 * Never imports metrics.api.js directly (three-layer rule).
 *
 * Tabs:
 *   1. Overview   — summary stat cards + system health indicator
 *   2. RED        — per-route rate/error/duration table
 *   3. System     — heap, event-loop lag, handles
 *   4. Alerts     — triggered alert evaluations
 *   5. Health     — liveness / readiness check status
 */

import ErrorBoundary from "../../../components/feedback/ErrorBoundary";
import Tabs from "../../../components/ui/Tabs";
import { ANIMATE_PAGE_ENTER } from "../../../assets/styles/pre-set-styles";
import { useMetrics } from "./metrics.hook";
import OverviewTab from "./components/OverviewTab";
import RedMetricsTab from "./components/RedMetricsTab";
import SystemTab from "./components/SystemTab";
import AlertsTab from "./components/AlertsTab";
import HealthTab from "./components/HealthTab";

// ─── View ─────────────────────────────────────────────────────────────────────

function MetricsView() {
  // Billing hook pattern: one line, no destructuring at view level
  const hook = useMetrics();

  const tabs = [
    {
      id: "overview",
      label: "Overview",
      content: <OverviewTab hook={hook} />,
    },
    {
      id: "red",
      label: "RED Metrics",
      content: <RedMetricsTab hook={hook} />,
    },
    {
      id: "system",
      label: "System",
      content: <SystemTab hook={hook} />,
    },
    {
      id: "alerts",
      label: `Alerts${hook.alerts.length > 0 ? ` (${hook.alerts.length})` : ""}`,
      content: <AlertsTab hook={hook} />,
    },
    {
      id: "health",
      label: "Health",
      content: <HealthTab hook={hook} />,
    },
  ];

  return (
    <div className={`space-y-6 ${ANIMATE_PAGE_ENTER}`}>
      {/* Page header */}
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold text-black/85 dark:text-white/85">
          Observability Dashboard
        </h1>
        <p className="text-sm text-grey-500 dark:text-grey-400">
          Real-time in-process metrics — auto-refreshes every 30 seconds
        </p>
      </div>

      {/* Tab navigation */}
      <Tabs
        tabs={tabs}
        activeTab={hook.activeTab}
        onChange={hook.setActiveTab}
        variant="pill"
      />
    </div>
  );
}

export default function MetricsViewWrapped() {
  return (
    <ErrorBoundary>
      <MetricsView />
    </ErrorBoundary>
  );
}
