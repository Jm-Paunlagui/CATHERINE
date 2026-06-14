import { SearchInput } from "../../../../components/forms/SearchInput";
import { Select } from "../../../../components/forms/Select";
import Button from "../../../../components/ui/Button";
import Card from "../../../../components/ui/Card";
import { Datepicker } from "../../../../components/ui/Datepicker";
import Pagination from "../../../../components/ui/Pagination";
import Skeleton from "../../../../components/ui/Skeleton";
import { Table } from "../../../../components/ui/Table";
import Tooltip from "../../../../components/ui/Tooltip";

// ─── Colour maps ───────────────────────────────────────────────────────────────

const METHOD_COLORS = {
    GET: "bg-blue-400/15 text-blue-400",
    POST: "bg-success-400/15 text-success-400",
    PUT: "bg-warn-400/15 text-warn-400",
    PATCH: "bg-warn-400/20 text-warn-400",
    DELETE: "bg-danger-400/15 text-danger-400",
};

// Fine-grained gradient by HTTP status code.
// 1xx=blue, 2xx=success/green (lighter→darker with code), 3xx=turquoise, 4xx=warn, 5xx=danger
function getStatusCodeStyle(code) {
    const n = Number(code) || 0;

    if (n >= 100 && n < 200) return "bg-blue-400/15 text-blue-400";

    if (n >= 200 && n < 300) {
        if (n <= 201) return "bg-success-300/15 text-success-300";
        if (n <= 204) return "bg-success-400/15 text-success-400";
        if (n <= 207) return "bg-success-500/15 text-success-500";
        return "bg-success-600/15 text-success-600";
    }

    if (n >= 300 && n < 400) {
        if (n === 304) return "bg-turquoise-300/15 text-turquoise-300";
        if (n === 301 || n === 302) return "bg-turquoise-400/15 text-turquoise-400";
        if (n <= 308) return "bg-turquoise-500/15 text-turquoise-500";
        return "bg-turquoise-600/15 text-turquoise-600";
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

const COLUMNS = [
    { key: "CREATED_AT", label: "Date" },
    { key: "USERNAME", label: "User" },
    { key: "METHOD", label: "Method" },
    { key: "ENDPOINT", label: "Endpoint" },
    { key: "CLIENT_IP", label: "Client IP" },
    { key: "SERVER_IP", label: "Server IP" },
    { key: "RESPONSE_TIME_MS", label: "Resp. Time" },
    { key: "STATUS_CODE", label: "Status" },
    { key: "__view", label: "" },
];

// ─── Cell renderers ────────────────────────────────────────────────────────────

function renderCell(row, col) {
    switch (col.key) {
        case "CREATED_AT":
            return new Date(row.CREATED_AT).toLocaleString();

        case "USERNAME":
            return row.USERNAME || "—";

        case "METHOD": {
            const cls = METHOD_COLORS[row.METHOD] ?? "bg-grey-100/15 text-grey-500";
            return <span className={`inline-flex items-center text-xs font-semibold px-2 py-0.5 rounded-full border border-current/20 ${cls}`}>{row.METHOD}</span>;
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

        case "CLIENT_IP":
            return <span className="font-mono text-xs">{row.CLIENT_IP ?? "—"}</span>;

        case "SERVER_IP":
            return <span className="font-mono text-xs">{row.SERVER_IP ?? "—"}</span>;

        case "RESPONSE_TIME_MS": {
            const ms = row.RESPONSE_TIME_MS ?? 0;
            const cls = ms > 500 ? "text-warn-400 font-semibold" : "text-grey-700 dark:text-white/85";
            return <span className={cls}>{ms} ms</span>;
        }

        case "STATUS_CODE": {
            const cls = getStatusCodeStyle(row.STATUS_CODE);
            return <span className={`inline-flex items-center text-xs font-semibold px-2 py-0.5 rounded-full border border-current/20 ${cls}`}>{row.STATUS_CODE ?? "—"}</span>;
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
    const { listData, listLoading, filters, page, handleFilterChange, handlePageChange } = hook;

    const rows = listData?.data?.rows ?? [];
    const totalPages = listData?.data?.totalPages ?? 1;

    const handleResetFilters = () => {
        handleFilterChange("fromDate", "");
        handleFilterChange("toDate", "");
        handleFilterChange("method", "");
        handleFilterChange("statusCategory", "");
        handleFilterChange("search", "");
    };

    return (
        <Card className="bg-(--bg-surface) dark:bg-(--bg-surface-2) overflow-hidden">
            {/* ── Filter bar ── */}
            <div className="pb-4 border-b border-grey-100 dark:border-white/10 flex gap-3 items-end">
                <div className="flex flex-col gap-1">
                    <p className="text-xs font-medium text-grey-500 dark:text-white/50">Start Date</p>
                    <Datepicker value={filters.fromDate ? new Date(filters.fromDate) : null} onChange={(v) => handleFilterChange("fromDate", v ? v.toISOString().slice(0, 10) : "")} className="w-40" />
                </div>
                <div className="flex flex-col gap-1">
                    <p className="text-xs font-medium text-grey-500 dark:text-white/50">End Date</p>
                    <Datepicker value={filters.toDate ? new Date(filters.toDate) : null} onChange={(v) => handleFilterChange("toDate", v ? v.toISOString().slice(0, 10) : "")} className="w-40" />
                </div>
                <Select label="Method" options={METHOD_OPTIONS} value={filters.method} onChange={(v) => handleFilterChange("method", v)} className="w-44" />
                <Select label="Status" options={STATUS_OPTIONS} value={filters.statusCategory} onChange={(v) => handleFilterChange("statusCategory", v)} className="w-52" />
                <div className="flex-1 min-w-0">
                    <SearchInput placeholder="GID / EMP ID, Username, Client IP…" value={filters.search} onChange={(v) => handleFilterChange("search", v)} debounce={400} />
                </div>
            </div>

            {/* ── Table body ── */}
            {listLoading ? (
                <div className="p-6 space-y-3">
                    {Array.from({ length: 5 }).map((_, i) => (
                        <Skeleton key={i} className="h-10 w-full" />
                    ))}
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
                                col.key === "__view"
                                    ? (row) => {
                                          const params = row.PARAMS;
                                          let paramsSnippet = null;
                                          if (params) {
                                              try {
                                                  const parsed = JSON.parse(params);
                                                  const entries = Object.entries(parsed);
                                                  if (entries.length > 0) {
                                                      const raw = entries.map(([k, v]) => `${k}=${v}`).join(" · ");
                                                      paramsSnippet = raw.length > 60 ? raw.slice(0, 57) + "…" : raw;
                                                  }
                                              } catch {
                                                  const raw = String(params);
                                                  paramsSnippet = raw.length > 60 ? raw.slice(0, 57) + "…" : raw;
                                              }
                                          }
                                          return (
                                              <div className="flex flex-col items-start gap-1">
                                                  {/* {paramsSnippet && (
                          <span
                            className="text-xs font-mono text-grey-400 dark:text-white/40 leading-tight max-w-[200px] truncate"
                            title={params}
                          >
                            {paramsSnippet}
                          </span>
                        )} */}
                                                  <Button variant="ghost" size="sm" onClick={() => hook.handleViewRow(row)} className="text-xs px-2 py-1">
                                                      Trace
                                                  </Button>
                                              </div>
                                          );
                                      }
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
                    <Pagination page={page} totalPages={totalPages} onChange={handlePageChange} />
                </div>
            )}
        </Card>
    );
}
