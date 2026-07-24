/**
 * @fileoverview Alert History sub-tab (Active | History toggle inside the
 * Alerts area) — offset-paginated read of GET metrics/alerts/history.
 * Filters: severity, rule (text), from/to date.
 * Each row expands to show the parsed DETAILS cause payload. Presentation
 * only — all state/fetching lives in metrics.hook.js.
 */

import { useState } from "react";
import { SearchInput } from "../../../../components/forms/SearchInput";
import { Select } from "../../../../components/forms/Select";
import Alert from "../../../../components/ui/Alert";
import { Datepicker } from "../../../../components/ui/Datepicker";
import Pagination from "../../../../components/ui/Pagination";
import { Table } from "../../../../components/ui/Table";
import { PILL_BASE, getAlertSeverityStyle } from "../metricsStyles";

const SEVERITY_OPTIONS = [
    { value: "", label: "All Severities" },
    { value: "WARNING", label: "Warning" },
    { value: "CRITICAL", label: "Critical" },
    { value: "RESOLVED", label: "Resolved" },
];

const TRANSITION_LABELS = {
    FIRED: "Fired",
    ESCALATED: "Escalated",
    RENOTIFIED: "Re-notified",
    RECOVERED: "Recovered",
    SUPPRESSED: "Suppressed",
};

const EMAIL_STATUS_STYLE = {
    SENT: "bg-success-400/15 text-success-400",
    FAILED: "bg-danger-400/15 text-danger-400",
    SKIPPED: "bg-warn-400/20 text-warn-400",
    DISABLED: "bg-grey-100/20 text-grey-400",
};

/**
 * @param {{ hook: import('../metrics.hook').MetricsHook }} props
 */
export default function AlertHistoryTab({ hook }) {
    const [expandedId, setExpandedId] = useState(null);

    const rows = hook.alertHistoryData?.data?.rows ?? [];
    const total = hook.alertHistoryData?.data?.total ?? 0;
    const limit = hook.alertHistoryData?.data?.limit ?? 25;
    const totalPages = Math.max(1, Math.ceil(total / limit));

    const columns = [
        { key: "CREATED_AT", label: "Created", render: (row) => <span className="text-xs font-mono">{row.CREATED_AT ? new Date(row.CREATED_AT).toLocaleString() : "—"}</span> },
        { key: "SEVERITY", label: "Severity", render: (row) => <span className={`${PILL_BASE} ${getAlertSeverityStyle(row.SEVERITY)}`}>{row.SEVERITY}</span> },
        {
            key: "RULE",
            label: "Rule",
            render: (row) => (
                <button type="button" onClick={() => setExpandedId((cur) => (cur === row.id ? null : row.id))} className="font-mono text-xs text-left hover:text-(--accent-foreground) transition-colors" title={expandedId === row.id ? "Click to collapse" : "Click to expand details"}>
                    {row.RULE}
                </button>
            ),
        },
        { key: "TRANSITION", label: "Transition", render: (row) => <span className="text-xs">{TRANSITION_LABELS[row.TRANSITION] ?? row.TRANSITION}</span> },
        { key: "CHANNEL", label: "Channel", render: (row) => <span className="font-mono text-xs text-grey-500 dark:text-white/50">{row.CHANNEL}</span> },
        { key: "EMAIL_STATUS", label: "Email", render: (row) => <span className={`inline-flex items-center text-xs font-semibold px-2 py-0.5 rounded-full border border-current/20 ${EMAIL_STATUS_STYLE[row.EMAIL_STATUS] ?? "bg-grey-100/20 text-grey-400"}`}>{row.EMAIL_STATUS}</span> },
        { key: "VALUE_NUM", label: "Value", render: (row) => <span className="text-xs">{row.VALUE_NUM ?? "—"}</span> },
    ];

    return (
        <div className="mt-6 space-y-4">
            {/* Filters */}
            <div className="flex flex-wrap gap-3 items-end">
                <Select label="Severity" options={SEVERITY_OPTIONS} value={hook.historyFilters.severity} onChange={(v) => hook.handleHistoryFilterChange("severity", v)} className="w-44" />
                <div className="flex flex-col gap-1">
                    <p className="text-xs font-medium text-grey-500 dark:text-white/50">From</p>
                    <Datepicker value={hook.historyFilters.from ? new Date(hook.historyFilters.from) : null} onChange={(v) => hook.handleHistoryFilterChange("from", v ? v.toISOString().slice(0, 10) : "")} className="w-40" />
                </div>
                <div className="flex flex-col gap-1">
                    <p className="text-xs font-medium text-grey-500 dark:text-white/50">To</p>
                    <Datepicker value={hook.historyFilters.to ? new Date(hook.historyFilters.to) : null} onChange={(v) => hook.handleHistoryFilterChange("to", v ? v.toISOString().slice(0, 10) : "")} className="w-40" />
                </div>
                <div className="flex-1 min-w-55">
                    <SearchInput placeholder="Rule name…" value={hook.historyFilters.rule} onChange={(v) => hook.handleHistoryFilterChange("rule", v)} debounce={400} />
                </div>
            </div>

            {hook.alertHistoryLoading ? (
                <div className="space-y-2">
                    {Array.from({ length: 3 }).map((_, i) => (
                        <div key={i} className="h-12 rounded-lg skeleton" />
                    ))}
                </div>
            ) : hook.alertHistoryError ? (
                <Alert variant="danger" title="Failed to load alert history">
                    {hook.alertHistoryErrorMessage}
                </Alert>
            ) : (
                <Table
                    columns={columns}
                    data={rows.map((r) => ({ ...r, id: r.ID }))}
                    stickyHeader
                    striped
                    compact
                    expandRow={(row) => {
                        if (expandedId !== row.id) return null;
                        return (
                            <tr>
                                <td colSpan={columns.length} className="px-4 py-3 bg-grey-50 dark:bg-white/5">
                                    {row.DESCRIPTION && <p className="text-xs text-black/70 dark:text-white/70 mb-2">{row.DESCRIPTION}</p>}
                                    <pre className="text-xs font-mono whitespace-pre-wrap break-all text-grey-500 dark:text-white/50 bg-grey-100 dark:bg-white/5 rounded-lg p-2">{row.DETAILS ? JSON.stringify(row.DETAILS, null, 2) : "No details recorded."}</pre>
                                    {row.EMAIL_ERROR && <p className="text-xs text-danger-400 mt-2">{row.EMAIL_ERROR}</p>}
                                </td>
                            </tr>
                        );
                    }}
                />
            )}

            {!hook.alertHistoryLoading && !hook.alertHistoryError && rows.length > 0 && (
                <div className="flex justify-end">
                    <Pagination page={hook.historyPage} totalPages={totalPages} onChange={hook.setHistoryPage} />
                </div>
            )}
        </div>
    );
}
