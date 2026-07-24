/**
 * @fileoverview System sub-tab — "what about the system?". Server log
 * entries by RFC 5424 level (EMERGENCY…DEBUG), sourced from the
 * `logs/YYYY/MM/DD/<level>.log` files directly (NOT the audit-log DB table
 * the sibling User Traffic sub-tab reads). Two modes:
 *   - Browse — GET audit-logs/system-logs, offset pagination.
 *   - Live   — SSE tail of TODAY's level files (audit-logs/system-logs/stream),
 *              only selectable when the date filter is today.
 * Presentation only — all state/fetching lives in logmanagement.hook.js.
 */

import { faRotateRight } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useState } from "react";
import { SearchInput } from "../../../../components/forms/SearchInput";
import { Select } from "../../../../components/forms/Select";
import { Toggle } from "../../../../components/forms/Toggle";
import Alert from "../../../../components/ui/Alert";
import Button from "../../../../components/ui/Button";
import Card from "../../../../components/ui/Card";
import { Datepicker } from "../../../../components/ui/Datepicker";
import Pagination from "../../../../components/ui/Pagination";
import Skeleton from "../../../../components/ui/Skeleton";
import { Table } from "../../../../components/ui/Table";
import Tooltip from "../../../../components/ui/Tooltip";
import { copyToClipboard } from "../../../../utils/clipboard";
import { SYSTEM_LOG_LEVEL_OPTIONS } from "../logmanagement.hook";

// ─── Level pill styling (follows AuditLogTable's getStatusCodeStyle / metricsStyles' getAlertSeverityStyle convention) ──

function getLevelStyle(level) {
    switch (String(level).toUpperCase()) {
        case "EMERGENCY":
        case "ALERT":
            return "bg-danger-600/15 text-danger-600";
        case "CRITICAL":
            return "bg-danger-500/15 text-danger-500";
        case "ERROR":
            return "bg-danger-400/15 text-danger-400";
        case "WARNING":
            return "bg-warn-400/20 text-warn-400";
        case "NOTICE":
            return "bg-blue-400/15 text-(--blue-foreground)";
        case "INFO":
            return "bg-grey-100/40 text-grey-500 dark:text-grey-400";
        case "DEBUG":
        default:
            return "bg-grey-100/20 text-grey-400 dark:text-grey-500";
    }
}

/** True midnight-local YYYY-MM-DD helper — mirrors the hook's own `_today()`. */
function _today() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
}

/** Builds a stable-enough row id for Table/expand-state keying. */
function rowId(row, idx) {
    return `${row.ts ?? "no-ts"}::${row.requestId ?? ""}::${idx}`;
}

// ─── Component ─────────────────────────────────────────────────────────────────

/**
 * @param {{ hook: object }} props - the useLogsManagement hook
 */
export default function SystemLogsTab({ hook }) {
    const [expandedId, setExpandedId] = useState(null);

    const isToday = hook.sysDate === _today();
    const rows = hook.sysLive ? hook.sysLiveRows : (hook.systemLogsData?.data?.rows ?? []);
    const totalPages = hook.systemLogsData?.data?.totalPages ?? 1;
    const truncatedFiles = hook.systemLogsData?.data?.truncatedFiles ?? [];

    const handleResetFilters = () => {
        hook.handleSystemLevelChange("5");
        hook.handleSystemSearchChange("");
        hook.handleSystemDateChange(_today());
    };

    const columns = [
        {
            key: "ts",
            label: "Time",
            render: (row) => <span className="font-mono text-xs whitespace-nowrap">{row.ts ?? "—"}</span>,
        },
        {
            key: "level",
            label: "Level",
            render: (row) => <span className={`inline-flex items-center text-xs font-semibold px-2 py-0.5 rounded-full border border-current/20 ${getLevelStyle(row.level)}`}>{row.level ?? "—"}</span>,
        },
        {
            key: "location",
            label: "Source",
            render: (row) => {
                const loc = row.location ?? "";
                if (!loc) return <span className="text-grey-300 dark:text-white/20">—</span>;
                const display = loc.length > 40 ? loc.slice(0, 40) + "…" : loc;
                return (
                    <Tooltip content={loc}>
                        <span className="font-mono text-xs text-grey-500 dark:text-white/50 cursor-default">{display}</span>
                    </Tooltip>
                );
            },
        },
        {
            key: "message",
            label: "Message",
            render: (row) => {
                const msg = row.message ?? "";
                const isExpanded = expandedId === row.id;
                return (
                    <button
                        type="button"
                        onClick={() => setExpandedId(isExpanded ? null : row.id)}
                        className="text-left font-mono text-xs text-black/75 dark:text-white/75 hover:text-(--accent-foreground) transition-colors max-w-md truncate block"
                        title={isExpanded ? "Click to collapse" : "Click to expand"}
                    >
                        {msg || "—"}
                    </button>
                );
            },
        },
        {
            key: "requestId",
            label: "Request ID",
            render: (row) => {
                const rid = row.requestId ?? "";
                if (!rid) return <span className="text-grey-300 dark:text-white/20">—</span>;
                const short = rid.length > 12 ? `…${rid.slice(-8)}` : rid;
                return (
                    <div className="flex items-center gap-2">
                        <Tooltip content={`Click to copy: ${rid}`}>
                            <button type="button" onClick={() => copyToClipboard(rid)} className="font-mono text-[11px] text-(--blue-foreground)/80 hover:text-(--blue-foreground) cursor-copy transition-colors" title={rid}>
                                {short}
                            </button>
                        </Tooltip>
                        <Button variant="ghost" size="sm" onClick={() => hook.handleViewSystemRow(row)} className="text-xs px-2 py-1">
                            Trace
                        </Button>
                    </div>
                );
            },
        },
    ];

    return (
        <Card className="bg-(--bg-surface) dark:bg-(--bg-surface-2) overflow-hidden">
            {/* ── Filter bar ── */}
            <div className="pb-4 border-b border-grey-100 dark:border-white/10 flex flex-wrap gap-3 items-end">
                <div className="flex flex-col gap-1">
                    <p className="text-xs font-medium text-grey-500 dark:text-white/50">Date</p>
                    <Datepicker value={hook.sysDate ? new Date(hook.sysDate + "T00:00:00") : null} onChange={(v) => hook.handleSystemDateChange(v ? v.toISOString().slice(0, 10) : _today())} className="w-40" />
                </div>
                <Select label="Level" options={SYSTEM_LOG_LEVEL_OPTIONS} value={hook.sysLevelFilter} onChange={hook.handleSystemLevelChange} className="w-48" />
                <div className="flex-1 min-w-55">
                    <SearchInput placeholder="Search message…" value={hook.sysSearch} onChange={hook.handleSystemSearchChange} debounce={400} />
                </div>
                <Toggle label="Live" checked={hook.sysLive} onChange={isToday ? hook.handleToggleSystemLive : undefined} color="success" size="sm" disabled={!isToday} />
                <Button variant="ghost" size="sm" onClick={hook.refetchSystemLogs} disabled={hook.systemLogsLoading || hook.sysLive}>
                    <FontAwesomeIcon icon={faRotateRight} className={`w-3.5 h-3.5 mr-1.5 ${hook.systemLogsLoading ? "animate-spin" : ""}`} />
                    Refresh
                </Button>
            </div>

            {!isToday && hook.sysLive === false && (
                <p className="pt-2 text-xs text-grey-400 dark:text-white/40">Live tail is only available for today's log files.</p>
            )}

            {truncatedFiles.length > 0 && !hook.sysLive && (
                <div className="pt-3">
                    <Alert variant="warning" title="Some files were truncated">
                        The following files exceed the read window and only their most recent portion is shown: {truncatedFiles.join(", ")}.
                    </Alert>
                </div>
            )}

            {hook.sysLive && hook.sysDropped > 0 && (
                <div className="pt-3">
                    <Alert variant="warning" title="Rows dropped">
                        {hook.sysDropped} row(s) were dropped to keep the live tail responsive. Turn off Live or narrow the Level filter to see everything.
                    </Alert>
                </div>
            )}

            {/* ── Table body ── */}
            {!hook.sysLive && hook.systemLogsLoading ? (
                <div className="p-6 space-y-3">
                    {Array.from({ length: 5 }).map((_, i) => (
                        <Skeleton key={i} className="h-10 w-full" />
                    ))}
                </div>
            ) : !hook.sysLive && hook.systemLogsError ? (
                <div className="p-6">
                    <Alert variant="danger" title="Failed to load system logs">
                        {hook.systemLogsErrorMessage}
                    </Alert>
                </div>
            ) : rows.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 gap-4">
                    <p className="text-grey-400 dark:text-white/40 text-sm">{hook.sysLive ? "Waiting for new log entries…" : "No system log entries match the current filters."}</p>
                    {!hook.sysLive && (
                        <Button variant="ghost" onClick={handleResetFilters}>
                            Reset Filters
                        </Button>
                    )}
                </div>
            ) : (
                <div className="overflow-x-auto mt-4">
                    <Table
                        columns={columns}
                        data={rows.map((row, i) => ({ ...row, id: rowId(row, i) }))}
                        stickyHeader
                        striped
                        compact
                        expandRow={(row) => {
                            if (expandedId !== row.id) return null;
                            return (
                                <tr>
                                    <td colSpan={columns.length} className="px-4 py-3 bg-grey-50 dark:bg-white/5">
                                        <p className="text-xs font-mono whitespace-pre-wrap break-all text-black/75 dark:text-white/75">{row.message}</p>
                                        {row.meta && (
                                            <pre className="mt-2 text-xs font-mono whitespace-pre-wrap break-all text-grey-500 dark:text-white/50 bg-grey-100 dark:bg-white/5 rounded-lg p-2">{row.meta}</pre>
                                        )}
                                    </td>
                                </tr>
                            );
                        }}
                    />
                </div>
            )}

            {/* ── Pagination (browse mode only) ── */}
            {!hook.sysLive && !hook.systemLogsLoading && rows.length > 0 && (
                <div className="p-4 border-t border-grey-100 dark:border-white/10 flex justify-end mt-4">
                    <Pagination page={hook.sysPage} totalPages={totalPages} onChange={hook.handleSystemPageChange} />
                </div>
            )}
        </Card>
    );
}
