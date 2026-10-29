import { XMarkIcon } from "@heroicons/react/24/outline";
import { format, parseISO } from "date-fns";
import { useMemo } from "react";
import { SearchInput } from "../../../../components/forms/SearchInput";
import { Select } from "../../../../components/forms/Select";
import Alert from "../../../../components/ui/Alert";
import Button from "../../../../components/ui/Button";
import Card from "../../../../components/ui/Card";
import { Datepicker } from "../../../../components/ui/Datepicker";
import Pagination from "../../../../components/ui/Pagination";
import Skeleton from "../../../../components/ui/Skeleton";
import { Table } from "../../../../components/ui/Table";
import Tooltip from "../../../../components/ui/Tooltip";
import { copyToClipboard } from "../../../../utils/clipboard";
import { buildPageSizeOptions } from "../../../../utils/pagination";

/** Server-side clamp — AuditLogService.getList caps pageSize at 100. Keep the
 * FE selector's ceiling at or under it; an option above it would silently
 * return fewer rows than requested and desync the reported page count. */
const AUDIT_LOG_MAX_PAGE_SIZE = 100;

// ─── Colour maps ───────────────────────────────────────────────────────────────

const METHOD_COLORS = {
    GET: "bg-blue-400/15 text-(--blue-foreground)",
    POST: "bg-success-400/15 text-success-400",
    PUT: "bg-warn-400/15 text-warn-400",
    PATCH: "bg-warn-400/20 text-warn-400",
    DELETE: "bg-danger-400/15 text-danger-400",
};

// Fine-grained gradient by HTTP status code.
// 1xx=blue, 2xx=success/green (lighter→darker with code), 3xx=turquoise, 4xx=warn, 5xx=danger
function getStatusCodeStyle(code) {
    const n = Number(code) || 0;

    if (n >= 100 && n < 200) return "bg-blue-400/15 text-(--blue-foreground)";

    if (n >= 200 && n < 300) {
        if (n <= 201) return "bg-success-300/15 text-success-300";
        if (n <= 204) return "bg-success-400/15 text-success-400";
        if (n <= 207) return "bg-success-500/15 text-success-500";
        return "bg-success-600/15 text-success-600";
    }

    if (n >= 300 && n < 400) {
        if (n === 304) return "bg-turquoise-300/15 text-(--turquoise-foreground)";
        if (n === 301 || n === 302) return "bg-turquoise-400/15 text-(--turquoise-foreground)";
        if (n <= 308) return "bg-turquoise-500/15 text-(--turquoise-foreground)";
        return "bg-turquoise-600/15 text-(--turquoise-foreground)";
    }

    if (n >= 400 && n < 500) {
        if (n === 400) return "bg-warn-300/20 text-warn-400";
        if (n === 401 || n === 403 || n === 404) return "bg-warn-400/20 text-warn-400";
        if (n === 405 || n === 408 || n === 409 || n === 410 || n === 422) return "bg-warn-500/20 text-warn-500";
        if (n >= 429) return "bg-warn-600/20 text-warn-600";
        return "bg-warn-400/20 text-warn-400";
    }

    if (n >= 500 && n < 600) {
        if (n === 501) return "bg-danger-300/15 text-danger-300";
        if (n === 500) return "bg-danger-400/15 text-danger-400";
        if (n === 502 || n === 503 || n === 507) return "bg-danger-500/15 text-danger-500";
        if (n >= 504) return "bg-danger-600/15 text-danger-600";
        return "bg-danger-400/15 text-danger-400";
    }

    return "bg-grey-100/15 text-grey-700";
}

// ─── Select options ────────────────────────────────────────────────────────────

const METHOD_OPTIONS = [
    { value: "", label: "All Methods" },
    { value: "GET", label: "GET" },
    { value: "POST", label: "POST" },
    { value: "PUT", label: "PUT" },
    { value: "PATCH", label: "PATCH" },
    { value: "DELETE", label: "DELETE" },
];

const STATUS_OPTIONS = [
    { value: "", label: "All Statuses" },
    { value: "2xx", label: "2xx Success" },
    { value: "3xx", label: "3xx Redirect" },
    { value: "4xx", label: "4xx Client Error" },
    { value: "5xx", label: "5xx Server Error" },
];

// ─── Table columns ─────────────────────────────────────────────────────────────

// Triage set only — what an operator scans a page of rows FOR. CLIENT_IP and
// SERVER_IP are per-request forensics, not scan targets: you want them once you
// have already picked a row, so they live in the Trace modal
// (RequestLogsModal.jsx) and are still reachable from the `search` box — which
// covers CLIENT_IP, so "find every request from this IP" survives the removal.
const COLUMNS = [
    { key: "CREATED_AT", label: "Date" },
    { key: "REQUEST_ID", label: "Request ID" },
    { key: "USERNAME", label: "User" },
    { key: "METHOD", label: "Method" },
    { key: "ENDPOINT", label: "Endpoint" },
    { key: "RESPONSE_TIME_MS", label: "Resp. Time" },
    { key: "STATUS_CODE", label: "Status" },
    { key: "__view", label: "" },
];

// ─── Cell renderers ────────────────────────────────────────────────────────────

function renderCell(row, col) {
    switch (col.key) {
        case "CREATED_AT":
            return new Date(row.CREATED_AT).toLocaleString();

        case "REQUEST_ID": {
            const rid = row.REQUEST_ID ?? "";
            if (!rid) return <span className="text-grey-300 dark:text-white/20">—</span>;
            // Show last 8 chars with full ID on hover + click-to-copy
            const short = rid.length > 12 ? `…${rid.slice(-8)}` : rid;
            const handleCopy = () => copyToClipboard(rid);
            return (
                <Tooltip content={`Click to copy: ${rid}`}>
                    <button type="button" onClick={handleCopy} className="font-mono text-[11px] text-(--blue-foreground)/80 hover:text-(--blue-foreground) cursor-copy transition-colors" title={rid}>
                        {short}
                    </button>
                </Tooltip>
            );
        }

        case "USERNAME":
            return row.USERNAME || "—";

        case "METHOD": {
            const cls = METHOD_COLORS[row.METHOD] ?? "bg-grey-100/15 text-grey-500";
            return <span className={`inline-flex items-center text-xs font-semibold px-2 py-1 rounded-full border border-current/20 ${cls}`}>{row.METHOD}</span>;
        }

        case "ENDPOINT": {
            const ep = row.ENDPOINT ?? "";
            const display = ep.length > 60 ? ep.slice(0, 60) + "…" : ep;
            return ep.length > 60 ? (
                <Tooltip content={ep}>
                    <span className="font-mono text-xs cursor-default">{display}</span>
                </Tooltip>
            ) : (
                <span className="font-mono text-xs">{ep}</span>
            );
        }

        case "RESPONSE_TIME_MS": {
            const ms = row.RESPONSE_TIME_MS ?? 0;
            const cls = ms > 500 ? "text-warn-400 font-semibold" : "text-grey-700 dark:text-white/85";
            return <span className={cls}>{ms} ms</span>;
        }

        case "STATUS_CODE": {
            const cls = getStatusCodeStyle(row.STATUS_CODE);
            return <span className={`inline-flex items-center text-xs font-semibold px-2 py-1 rounded-full border border-current/20 ${cls}`}>{row.STATUS_CODE ?? "—"}</span>;
        }

        default:
            return row[col.key] ?? "—";
    }
}

// ─── Component ─────────────────────────────────────────────────────────────────

/**
 * Audit log table with filter bar and pagination.
 *
 * @param {{ hook: object }} props
 */
export default function AuditLogTable({ hook }) {
    const { listData, listLoading, listError, listErrorMessage, filters, page, pageSize, handleFilterChange, handlePageChange, handlePageSizeChange } = hook;

    const rows = listData?.data?.rows ?? [];
    const totalPages = listData?.data?.totalPages ?? 1;
    const totalRows = listData?.data?.total ?? rows.length;

    // Server clamps pageSize at 100 (AuditLogService.getList) — filter the
    // adaptive option list down to that ceiling, and add the current value
    // back in if it fell outside the generated tiers (e.g. the 20 default).
    const pageSizeOptions = useMemo(() => {
        const opts = buildPageSizeOptions(totalRows).filter((n) => n <= AUDIT_LOG_MAX_PAGE_SIZE);
        return [...new Set([...opts, pageSize])].sort((a, b) => a - b);
    }, [totalRows, pageSize]);

    const handleResetFilters = () => {
        handleFilterChange("fromDate", "");
        handleFilterChange("toDate", "");
        handleFilterChange("method", "");
        handleFilterChange("statusCategory", "");
        // The route pivot sets this — omitting it here would leave an invisible
        // filter pinned after "Reset Filters" and keep the table empty.
        handleFilterChange("endpoint", "");
        handleFilterChange("search", "");
    };

    return (
        <Card className="bg-(--bg-surface) dark:bg-(--bg-surface-2) overflow-hidden">
            {/* ── Filter bar ── */}
            <div className="pb-4 border-b border-grey-100 dark:border-white/10 flex gap-3 items-end">
                <div className="flex flex-col gap-1">
                    <p className="text-xs font-medium text-grey-500 dark:text-white/50">Start Date</p>
                    <Datepicker value={filters.fromDate ? parseISO(filters.fromDate) : null} onChange={(v) => handleFilterChange("fromDate", v ? format(v, "yyyy-MM-dd") : "")} className="w-40" />
                </div>
                <div className="flex flex-col gap-1">
                    <p className="text-xs font-medium text-grey-500 dark:text-white/50">End Date</p>
                    <Datepicker value={filters.toDate ? parseISO(filters.toDate) : null} onChange={(v) => handleFilterChange("toDate", v ? format(v, "yyyy-MM-dd") : "")} className="w-40" />
                </div>
                <Select label="Method" options={METHOD_OPTIONS} value={filters.method} onChange={(v) => handleFilterChange("method", v)} className="w-44" />
                <Select label="Status" options={STATUS_OPTIONS} value={filters.statusCategory} onChange={(v) => handleFilterChange("statusCategory", v)} className="w-52" />
                <div className="flex-1 min-w-0">
                    <SearchInput placeholder="Request ID, Username, Endpoint, Client IP…" value={filters.search} onChange={(v) => handleFilterChange("search", v)} debounce={400} />
                </div>
            </div>

            {/* ── Active route filter ──
                The alert→logs pivot pins an EXACT endpoint. Without a visible,
                clearable chip it is an invisible filter: the table looks like it
                has no data for the whole date range. */}
            {filters.endpoint && (
                <div className="pt-3 flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-medium text-grey-500 dark:text-white/50">Route</span>
                    <span className="inline-flex items-center gap-2 rounded-full bg-(--accent-subtle) border border-(--color-card-surface-border) px-3 py-1">
                        <span className="font-mono text-xs text-(--accent-foreground) break-all">{filters.endpoint}</span>
                        <button
                            type="button"
                            aria-label={`Clear route filter ${filters.endpoint}`}
                            title="Clear route filter"
                            onClick={() => handleFilterChange("endpoint", "")}
                            className="w-4 h-4 inline-flex items-center justify-center rounded-full text-grey-500 dark:text-white/50 hover:bg-grey-200/60 dark:hover:bg-white/10 transition-colors-fast"
                        >
                            <XMarkIcon className="w-3 h-3" />
                        </button>
                    </span>
                </div>
            )}

            {/* ── Table body ── */}
            {listLoading ? (
                <div className="p-6 space-y-3">
                    {Array.from({ length: 5 }).map((_, i) => (
                        <Skeleton key={i} className="h-10 w-full" />
                    ))}
                </div>
            ) : listError ? (
                // a fetch failure must never render as the
                // same "no records match the filters" empty state as a
                // genuinely empty (but successful) result.
                <div className="p-6">
                    <Alert variant="danger" title="Failed to load audit log">
                        {listErrorMessage}
                    </Alert>
                </div>
            ) : rows.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 gap-4">
                    <p className="text-grey-400 dark:text-white/40 text-sm">No audit log records match the current filters.</p>
                    <Button variant="ghost" onClick={handleResetFilters}>
                        Reset Filters
                    </Button>
                </div>
            ) : (
                <div className="overflow-x-auto mt-4">
                    <Table
                        columns={COLUMNS.map((col) => ({
                            key: col.key,
                            label: col.label,
                            render:
                                // Action column — Trace only. The PARAMS snippet that
                                // used to sit above this button was a truncated,
                                // reformatted copy of data the Trace modal already
                                // renders in full (RequestLogsModal's ParamsSection),
                                // so it cost a column's width to show a worse version
                                // of it. Query params and body belong to the
                                // per-request view, not the triage scan.
                                col.key === "__view"
                                    ? (row) => (
                                          <Button variant="ghost" size="sm" onClick={() => hook.handleViewRow(row)} className="text-xs px-2 py-1">
                                              Trace
                                          </Button>
                                      )
                                    : (row) => renderCell(row, col),
                        }))}
                        data={rows}
                        stickyHeader
                        striped
                        compact
                    />
                </div>
            )}

            {/* ── Pagination ── */}
            {!listLoading && rows.length > 0 && (
                <div className="p-4 border-t border-grey-100 dark:border-white/10 flex justify-end mt-4">
                    <Pagination page={page} totalPages={totalPages} onChange={handlePageChange} pageSize={pageSize} pageSizeOptions={pageSizeOptions} onPageSizeChange={handlePageSizeChange} />
                </div>
            )}
        </Card>
    );
}
