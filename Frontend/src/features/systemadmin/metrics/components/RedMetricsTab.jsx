/**
 * @fileoverview RED Metrics tab — per-route request rate, error rate, and duration table.
 */

import { useMemo } from "react";
import { ANIMATE_ENTER_UP, ANIM_DELAY_0 } from "../../../../assets/styles/pre-set-styles";
import ExportButtons from "../../../../components/shared/ExportButtons";
import Pagination from "../../../../components/ui/Pagination";
import Table from "../../../../components/ui/Table";
import { usePagination } from "../../../../hooks/usePagination";
import { buildPageSizeOptions, DEFAULT_PAGE_SIZE } from "../../../../utils/pagination";
import { PILL_BASE, getErrorRateStyle, getLatencyStyle } from "../metricsStyles";

/**
 * @param {{ hook: import('../metrics.hook').MetricsHook }} props
 */
export default function RedMetricsTab({ hook }) {
    const { redRows, snapshotLoading, snapshotError, exportingRed, handleExportRed } = hook;

    // Client-side pagination — one row per observed route, unbounded and
    // traffic-driven (redRows arrives whole from the snapshot, already
    // sorted p95 descending; slicing per page preserves that order).
    const pagination = usePagination({ items: redRows, defaultPageSize: DEFAULT_PAGE_SIZE });
    const pageSizeOptions = useMemo(() => buildPageSizeOptions(redRows.length), [redRows.length]);

    if (snapshotLoading) {
        return (
            <div className={`mt-6 space-y-2 ${ANIMATE_ENTER_UP} ${ANIM_DELAY_0}`}>
                {Array.from({ length: 8 }).map((_, i) => (
                    <div key={i} className="h-10 rounded-lg skeleton" />
                ))}
            </div>
        );
    }

    if (snapshotError) {
        return <div className="mt-6 p-4 rounded-xl bg-danger-400/10 border border-danger-400/30 text-danger-400 text-sm">Failed to load metrics. You may not have sufficient access level, or the server is temporarily unavailable.</div>;
    }

    const columns = [
        {
            key: "route",
            label: "Route",
            render: (row) => <span className="font-mono text-xs text-grey-700 dark:text-grey-200">{row.route}</span>,
        },
        {
            key: "count",
            label: "Requests",
            render: (row) => <span className="text-sm text-grey-700 dark:text-grey-300">{row.count.toLocaleString()}</span>,
        },
        {
            key: "errorRate",
            label: "Error Rate",
            render: (row) => <span className={`${PILL_BASE} ${getErrorRateStyle(row._errorRate)}`}>{row.errorRateDisplay}</span>,
        },
        {
            key: "p50",
            label: "p50",
            render: (row) => <span className={`${PILL_BASE} ${getLatencyStyle(row._p50Raw)}`}>{row.p50}</span>,
        },
        {
            key: "p95",
            label: "p95",
            render: (row) => <span className={`${PILL_BASE} ${getLatencyStyle(row._p95Raw)}`}>{row.p95}</span>,
        },
        {
            key: "p99",
            label: "p99",
            render: (row) => <span className={`${PILL_BASE} ${getLatencyStyle(row._p99Raw)}`}>{row.p99}</span>,
        },
        {
            // What the HIGH_LATENCY alert judges: p99 over the last 5 minutes,
            // with the request count it rests on (the alert needs >= 20).
            key: "p99Window",
            label: "p99 (5 min)",
            render: (row) =>
                row._p99WindowRaw === null ? (
                    <span className="text-sm text-grey-400 dark:text-grey-500" title="No requests on this route in the last 5 minutes">
                        —
                    </span>
                ) : (
                    <span className="inline-flex items-center gap-1.5" title={`p99 over the last 5 minutes, from ${row.windowCount} request(s). The slow-page alert needs at least 20.`}>
                        <span className={`${PILL_BASE} ${getLatencyStyle(row._p99WindowRaw)}`}>{row.p99Window}</span>
                        <span className="text-xs text-grey-500 dark:text-grey-400">n={row.windowCount}</span>
                    </span>
                ),
        },
        {
            key: "avg",
            label: "Avg",
            render: (row) => <span className={`${PILL_BASE} ${getLatencyStyle(row._avgRaw)}`}>{row.avg}</span>,
        },
    ];

    return (
        <div className={`mt-6 space-y-4 ${ANIMATE_ENTER_UP} ${ANIM_DELAY_0}`}>
            {redRows.length === 0 ? (
                <div className="py-16 text-center text-grey-400 dark:text-grey-500 text-sm">No route metrics collected yet. Traffic is needed to populate this table.</div>
            ) : (
                <>
                    {/* Exports the WHOLE table, not the current page — redRows
                        arrives whole from the snapshot, so paging is a view
                        concern only. Same ExportButtons / exportRowsToFile pair
                            as every other export. The tab is
                        already behind the metrics route gate, so no extra
                        `canExport` predicate is layered on here. */}
                    <div className="flex justify-end">
                        <ExportButtons exporting={exportingRed} disabled={snapshotLoading} onExport={handleExportRed} />
                    </div>
                    <Table columns={columns} data={pagination.paginatedItems} stickyHeader striped compact loading={snapshotLoading} />
                    <div className="flex justify-end">
                        <Pagination page={pagination.page} totalPages={pagination.totalPages} onChange={pagination.goToPage} pageSize={pagination.pageSize} pageSizeOptions={pageSizeOptions} onPageSizeChange={pagination.setPageSize} />
                    </div>
                </>
            )}
        </div>
    );
}
