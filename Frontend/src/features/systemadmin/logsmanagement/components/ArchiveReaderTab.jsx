/**
 * @fileoverview Archive Reader tab — fully OFFLINE reader for previously
 * exported observability artifacts. Loads the audit Excel export and the
 * server-log ZIP export locally in the browser (no HTTP calls — see the
 * deviation note in archiveReader.hook.js), renders the audit rows with
 * client-side search + pagination, and opens the standard trace modal by
 * scanning the loaded log lines for the row's REQUEST_ID.
 * Presentation only — parsing/state live in archiveReader.hook.js.
 */

import { ArchiveBoxIcon, DocumentChartBarIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useMemo } from "react";
import { SearchInput } from "../../../../components/forms/SearchInput";
import { FileInput } from "../../../../components/forms/FileInput";
import Button from "../../../../components/ui/Button";
import Card from "../../../../components/ui/Card";
import Pagination from "../../../../components/ui/Pagination";
import Skeleton from "../../../../components/ui/Skeleton";
import { Table } from "../../../../components/ui/Table";
import Tooltip from "../../../../components/ui/Tooltip";
import { buildPageSizeOptions } from "../../../../utils/pagination";
import RequestLogsModal from "./RequestLogsModal";

// ─── Colour maps (aligned with AuditLogTable) ──────────────────────────────────

const METHOD_COLORS = {
    GET: "bg-blue-400/15 text-(--blue-foreground)",
    POST: "bg-success-400/15 text-success-400",
    PUT: "bg-warn-400/15 text-warn-400",
    PATCH: "bg-warn-400/20 text-warn-400",
    DELETE: "bg-danger-400/15 text-danger-400",
};

function statusCodeStyle(code) {
    const n = Number(code) || 0;
    if (n >= 200 && n < 300) return "bg-success-400/15 text-success-400";
    if (n >= 300 && n < 400) return "bg-turquoise-400/15 text-(--turquoise-foreground)";
    if (n >= 400 && n < 500) return "bg-warn-400/20 text-warn-400";
    if (n >= 500 && n < 600) return "bg-danger-400/15 text-danger-400";
    return "bg-grey-100/15 text-grey-700";
}

// ─── Table columns ─────────────────────────────────────────────────────────────

const COLUMNS = [
    { key: "CREATED_AT", label: "Date" },
    { key: "REQUEST_ID", label: "Request ID" },
    { key: "USERNAME", label: "User" },
    { key: "METHOD", label: "Method" },
    { key: "ENDPOINT", label: "Endpoint" },
    { key: "CLIENT_IP", label: "Client IP" },
    { key: "RESPONSE_TIME_MS", label: "Resp. Time" },
    { key: "STATUS_CODE", label: "Status" },
    { key: "__view", label: "" },
];

function renderCell(row, col) {
    switch (col.key) {
        case "CREATED_AT":
            return row.CREATED_AT ? new Date(row.CREATED_AT).toLocaleString() : "—";
        case "REQUEST_ID": {
            const rid = String(row.REQUEST_ID ?? "");
            if (!rid) return <span className="text-grey-300 dark:text-white/20">—</span>;
            const short = rid.length > 12 ? `…${rid.slice(-8)}` : rid;
            return (
                <Tooltip content={rid}>
                    <span className="font-mono text-[11px] text-(--blue-foreground)/80" title={rid}>
                        {short}
                    </span>
                </Tooltip>
            );
        }
        case "USERNAME":
            return row.USERNAME || "—";
        case "METHOD": {
            const cls = METHOD_COLORS[row.METHOD] ?? "bg-grey-100/15 text-grey-500";
            return <span className={`inline-flex items-center text-xs font-semibold px-2 py-1 rounded-full border border-current/20 ${cls}`}>{row.METHOD || "—"}</span>;
        }
        case "ENDPOINT": {
            const ep = String(row.ENDPOINT ?? "");
            const display = ep.length > 60 ? ep.slice(0, 60) + "…" : ep;
            return ep.length > 60 ? (
                <Tooltip content={ep}>
                    <span className="font-mono text-xs cursor-default">{display}</span>
                </Tooltip>
            ) : (
                <span className="font-mono text-xs">{ep || "—"}</span>
            );
        }
        case "CLIENT_IP":
            return <span className="font-mono text-xs">{row.CLIENT_IP || "—"}</span>;
        case "RESPONSE_TIME_MS": {
            const ms = Number(row.RESPONSE_TIME_MS) || 0;
            const cls = ms > 500 ? "text-warn-400 font-semibold" : "text-grey-700 dark:text-white/85";
            return <span className={cls}>{ms} ms</span>;
        }
        case "STATUS_CODE": {
            const cls = statusCodeStyle(row.STATUS_CODE);
            return <span className={`inline-flex items-center text-xs font-semibold px-2 py-1 rounded-full border border-current/20 ${cls}`}>{row.STATUS_CODE ?? "—"}</span>;
        }
        default:
            return row[col.key] ?? "—";
    }
}

// ─── File slot card ────────────────────────────────────────────────────────────

/**
 * One artifact slot: dropzone (empty) or loaded-file summary with a clear button.
 * @param {{ icon: Function, title: string, description: string, accept: string,
 *           fileName: string, loading: boolean, error: string, summary: string,
 *           onFile: Function, onClear: Function }} props
 */
function FileSlotCard({ icon, title, description, accept, fileName, loading, error, summary, onFile, onClear }) {
    const SlotIcon = icon;
    return (
        <Card className="bg-(--bg-surface) dark:bg-(--bg-surface-2)">
            <div className="flex items-center gap-2 mb-2">
                <SlotIcon className="w-4 h-4 text-(--accent-icon) shrink-0" />
                <h3 className="text-xs font-aumovio-bold text-black/55 dark:text-white/55 tracking-widest uppercase">{title}</h3>
            </div>
            <p className="text-xs text-grey-500 dark:text-white/45 mb-3">{description}</p>

            {loading ? (
                <Skeleton className="h-24 w-full" />
            ) : fileName ? (
                <div className="flex items-center justify-between gap-3 rounded-lg border border-(--color-card-surface-border) dark:border-white/10 p-3">
                    <div className="min-w-0">
                        <p className="text-sm font-aumovio-bold text-black/80 dark:text-white/85 truncate">{fileName}</p>
                        <p className="text-xs text-grey-400 dark:text-white/40">{summary}</p>
                    </div>
                    <Button variant="ghost" size="sm" onClick={onClear}>
                        <XMarkIcon className="w-4 h-4 mr-1" />
                        Remove
                    </Button>
                </div>
            ) : (
                <FileInput accept={accept} error={error || undefined} onChange={(files) => files?.[0] && onFile(files[0])} />
            )}

            {error && !loading && <p className="mt-2 text-xs text-danger-400">{error}</p>}
        </Card>
    );
}

// ─── Component ─────────────────────────────────────────────────────────────────

/**
 * Archive Reader tab body.
 * @param {{ hook: object }} props - the useArchiveReader hook
 */
export default function ArchiveReaderTab({ hook }) {
    const bothLoaded = hook.excelRows.length > 0 && hook.logLines.length > 0;
    // Client-side pagination over the loaded (and search-filtered) rows — all
    // of them already sit in memory, so no server clamp applies here.
    const pageSizeOptions = useMemo(() => buildPageSizeOptions(hook.filteredCount), [hook.filteredCount]);

    return (
        <div className="space-y-8">
            {/* ── Artifact inputs ───────────────────────────────────────────── */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <FileSlotCard
                    icon={DocumentChartBarIcon}
                    title="Audit Excel Export"
                    description="The .xlsx exported from Log Retention → Export Excel (sheet “Audit Records”). Parsed locally — nothing is uploaded."
                    accept=".xlsx"
                    fileName={hook.excelFileName}
                    loading={hook.excelLoading}
                    error={hook.excelError}
                    summary={`${hook.excelRows.length} audit record(s) loaded`}
                    onFile={hook.handleExcelFile}
                    onClear={hook.clearExcel}
                />
                <FileSlotCard
                    icon={ArchiveBoxIcon}
                    title="Server Logs ZIP Export"
                    description="The .zip exported from Log Retention → Export Logs (entries YYYY/MM/DD/level.log). Parsed locally — nothing is uploaded."
                    accept=".zip"
                    fileName={hook.zipFileName}
                    loading={hook.zipLoading}
                    error={hook.zipError}
                    summary={`${hook.logLines.length} log line(s) from ${hook.zipFileCount} file(s)`}
                    onFile={hook.handleZipFile}
                    onClear={hook.clearZip}
                />
            </div>

            {/* ── Audit rows table ──────────────────────────────────────────── */}
            {hook.excelRows.length > 0 && (
                <Card className="bg-(--bg-surface) dark:bg-(--bg-surface-2) overflow-hidden">
                    <div className="pb-4 border-b border-grey-100 dark:border-white/10 flex items-end gap-3">
                        <div className="flex-1 min-w-0">
                            <SearchInput placeholder="Request ID, Username, Endpoint, Client IP…" value={hook.search} onChange={hook.handleSearchChange} debounce={300} />
                        </div>
                        <p className="text-xs text-grey-400 dark:text-white/40 whitespace-nowrap pb-3">
                            {hook.filteredCount} of {hook.excelRows.length} record(s)
                        </p>
                    </div>

                    {!bothLoaded && (
                        <p className="mt-4 text-xs text-warn-500 dark:text-warn-400">Load the server-logs ZIP to enable per-row trace inspection.</p>
                    )}

                    {hook.pageRows.length === 0 ? (
                        <div className="py-16 text-center text-sm text-grey-400 dark:text-white/40">No records match the current search.</div>
                    ) : (
                        <div className="overflow-x-auto mt-4">
                            <Table
                                columns={COLUMNS.map((col) => ({
                                    key: col.key,
                                    label: col.label,
                                    render:
                                        col.key === "__view"
                                            ? (row) => (
                                                  <Button variant="ghost" size="sm" disabled={hook.logLines.length === 0} onClick={() => hook.handleViewRow(row)} className="text-xs px-2 py-1">
                                                      Trace
                                                  </Button>
                                              )
                                            : (row) => renderCell(row, col),
                                }))}
                                data={hook.pageRows}
                                stickyHeader
                                striped
                                compact
                            />
                        </div>
                    )}

                    {hook.pageRows.length > 0 && (
                        <div className="p-4 border-t border-grey-100 dark:border-white/10 flex justify-end mt-4">
                            <Pagination page={hook.page} totalPages={hook.totalPages} onChange={hook.setPage} pageSize={hook.pageSize} pageSizeOptions={pageSizeOptions} onPageSizeChange={hook.setPageSize} />
                        </div>
                    )}
                </Card>
            )}

            {hook.excelRows.length === 0 && !hook.excelLoading && (
                <div className="text-center py-10 text-sm text-grey-400 dark:text-white/40">Load the audit Excel export to browse archived records.</div>
            )}

            {/* Offline trace modal — Export hidden (no backend in this tab) */}
            <RequestLogsModal hook={hook.modalHook} offline />
        </div>
    );
}
