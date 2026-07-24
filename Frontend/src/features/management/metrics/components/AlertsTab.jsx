/**
 * @fileoverview Alerts tab — triggered alert rule evaluations.
 */

import { ANIMATE_ENTER_UP, ANIM_DELAY_0 } from "../../../../assets/styles/pre-set-styles";
import Button from "../../../../components/ui/Button";
import Table from "../../../../components/ui/Table";
import { Tabs } from "../../../../components/ui/Tabs";
import { PILL_BASE, getAlertSeverityStyle } from "../metricsStyles";
import AckAlertModal from "./AckAlertModal";
import AlertHistoryTab from "./AlertHistoryTab";
import NotificationStatusPanel from "./NotificationStatusPanel";

/**
 * Active alerts — the original (pre-History-split) AlertsTab content, moved
 * verbatim into its own sub-component so it can sit alongside AlertHistoryTab
 * inside the nested Active | History Tabs below.
 *
 * @param {{ hook: import('../metrics.hook').MetricsHook, onViewLogs?: (route: string) => void }} props
 */
function ActiveAlertsTab({ hook, onViewLogs }) {
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
            key: "scope",
            label: "Route / Pool",
            render: (row) => {
                const scope = row.route ?? row.pool;
                return scope ? <span className="font-mono text-xs text-grey-500 dark:text-grey-400">{scope}</span> : <span className="text-grey-300 dark:text-grey-600">—</span>;
            },
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
                if (row.rule === "HIGH_GC_OVERHEAD") display = `${row.value}%`;
                if (row.rule === "ORACLE_POOL_SATURATION") display = formatPct(row.value);
                return <span className="text-sm font-medium text-grey-700 dark:text-grey-200">{display}</span>;
            },
        },
        {
            key: "actions",
            label: "",
            render: (row) => (
                <div className="flex items-center justify-end gap-2 flex-wrap">
                    {row.acknowledged && (
                        <span
                            className="text-xs text-grey-500 dark:text-white/50 whitespace-nowrap"
                            title={row.ackNote || ""}
                        >
                            Acked by {row.ackedByName || `Admin #${row.ackedBy}`} · {hook.formatExpiresIn(row.ackExpiresAt)}
                        </span>
                    )}
                    {row.acknowledged ? (
                        <Button
                            variant="ghost"
                            size="sm"
                            loading={hook.unackLoadingKey === row.alertKey}
                            onClick={() => hook.unacknowledgeAlert(row.alertKey)}
                        >
                            Unack
                        </Button>
                    ) : (
                        <Button variant="outline" size="sm" onClick={() => hook.openAckModal(row.alertKey)}>
                            Ack
                        </Button>
                    )}
                    {row.route && onViewLogs && (
                        <Button variant="ghost" size="sm" onClick={() => onViewLogs(row.route)}>
                            View Logs
                        </Button>
                    )}
                </div>
            ),
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

/**
 * Alerts area — the notification status panel, followed by an Active |
 * History nested Tabs pair (Active = the original rule-evaluation table
 * above, unchanged; History = the persisted alert-log audit view).
 *
 * Controlled by `hook.alertsView` (not local/uncontrolled state) so the
 * History sub-tab's fetch can be gated behind actually opening it instead of
 * firing unconditionally the instant this feature's hook mounts.
 *
 * @param {{ hook: import('../metrics.hook').MetricsHook, onViewLogs?: (route: string) => void }} props
 * @param {function} [props.onViewLogs] - Pivot callback: jump to the Audit Logs tab
 *   pre-filtered to a route. Rendered as a "View Logs" action on route-scoped alerts.
 */
export default function AlertsTab({ hook, onViewLogs }) {
    const tabs = [
        { id: "active", label: "Active", content: <ActiveAlertsTab hook={hook} onViewLogs={onViewLogs} /> },
        { id: "history", label: "History", content: <AlertHistoryTab hook={hook} /> },
    ];

    return (
        <div className="space-y-4">
            <NotificationStatusPanel hook={hook} />
            <Tabs tabs={tabs} variant="pill" size="sm" activeTab={hook.alertsView} onChange={hook.setAlertsView} />
            <AckAlertModal hook={hook} />
        </div>
    );
}

// ─── Fallback descriptions ─────────────────────────────────────────────────────

const RULE_DESCRIPTIONS = {
    HIGH_ERROR_RATE: "Global server-error rate exceeds threshold",
    HIGH_LATENCY: "Route p99 latency exceeds 2 000ms",
    HIGH_HEAP: "Heap usage exceeds the V8 limit threshold",
    EVENT_LOOP_LAG: "Event-loop lag exceeds 100ms",
    HIGH_GC_OVERHEAD: "GC overhead exceeds threshold of wall-clock time",
    MEMORY_LEAK_SUSPECTED: "Post-GC heap is steadily climbing — possible leak",
    ORACLE_POOL_SATURATION: "Oracle connection pool utilization exceeds threshold",
};
