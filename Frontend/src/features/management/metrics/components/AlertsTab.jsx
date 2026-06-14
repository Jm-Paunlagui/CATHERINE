/**
 * @fileoverview Alerts tab — triggered alert rule evaluations.
 */

import { ANIMATE_ENTER_UP, ANIM_DELAY_0 } from "../../../../assets/styles/pre-set-styles";
import Button from "../../../../components/ui/Button";
import Table from "../../../../components/ui/Table";
import { PILL_BASE, getAlertSeverityStyle } from "../metricsStyles";

/**
 * @param {{ hook: import('../metrics.hook').MetricsHook }} props
 */
export default function AlertsTab({ hook }) {
    const { alerts, alertsLoading, alertsError, refetchAlerts, formatPct, formatMs } = hook;

    if (alertsLoading) {
        return (
            <div className="mt-6 space-y-2">
                {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="h-12 rounded-lg skeleton" />
                ))}
            </div>
        );
    }

    if (alertsError) {
        return <div className="mt-6 p-4 rounded-xl bg-danger-400/10 border border-danger-400/30 text-danger-400 text-sm">Failed to load alert evaluations.</div>;
    }

    const columns = [
        {
            key: "severity",
            label: "Severity",
            render: (row) => <span className={`${PILL_BASE} ${getAlertSeverityStyle(row.severity)}`}>{row.severity.toUpperCase()}</span>,
        },
        {
            key: "rule",
            label: "Rule",
            render: (row) => <span className="font-mono text-xs text-grey-700 dark:text-grey-200">{row.rule}</span>,
        },
        {
            key: "description",
            label: "Description",
            render: (row) => <span className="text-sm text-grey-600 dark:text-grey-300">{row.description ?? RULE_DESCRIPTIONS[row.rule] ?? row.rule}</span>,
        },
        {
            key: "route",
            label: "Route",
            render: (row) => (row.route ? <span className="font-mono text-xs text-grey-500 dark:text-grey-400">{row.route}</span> : <span className="text-grey-300 dark:text-grey-600">—</span>),
        },
        {
            key: "value",
            label: "Value",
            render: (row) => {
                if (row.value == null) return <span className="text-grey-300 dark:text-grey-600">—</span>;
                // Format the raw value by rule context
                let display = String(row.value);
                if (row.rule === "HIGH_ERROR_RATE") display = formatPct(row.value);
                if (row.rule === "HIGH_LATENCY") display = formatMs(row.value);
                if (row.rule === "HIGH_HEAP") display = formatPct(row.value);
                if (row.rule === "EVENT_LOOP_LAG") display = `${Math.round(row.value)}ms`;
                return <span className="text-sm font-medium text-grey-700 dark:text-grey-200">{display}</span>;
            },
        },
    ];

    return (
        <div className={`mt-6 space-y-4 ${ANIMATE_ENTER_UP} ${ANIM_DELAY_0}`}>
            <div className="flex items-center justify-between">
                <p className="text-sm text-grey-600 dark:text-grey-400">{alerts.length === 0 ? "No active alerts — all rules are within thresholds." : `${alerts.length} alert${alerts.length > 1 ? "s" : ""} currently active.`}</p>
                <Button variant="outline" size="sm" onClick={refetchAlerts}>
                    Refresh
                </Button>
            </div>

            {alerts.length === 0 ? (
                <div className="py-16 text-center">
                    <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-success-400/10 mb-3">
                        <span className="text-success-400 font-bold text-sm">OK</span>
                    </div>
                    <p className="text-grey-500 dark:text-grey-400 text-sm">All clear</p>
                </div>
            ) : (
                <Table columns={columns} data={alerts.map((a, i) => ({ ...a, _id: i }))} stickyHeader striped compact />
            )}
        </div>
    );
}

// ─── Fallback descriptions ─────────────────────────────────────────────────────

const RULE_DESCRIPTIONS = {
    HIGH_ERROR_RATE: "Global error rate exceeds 5%",
    HIGH_LATENCY: "Route p99 latency exceeds 2 000ms",
    HIGH_HEAP: "Heap usage exceeds 80% of heap total",
    EVENT_LOOP_LAG: "Event-loop lag exceeds 100ms",
};
