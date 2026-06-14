/**
 * @fileoverview RED Metrics tab — per-route request rate, error rate, and duration table.
 */

import { ANIMATE_ENTER_UP, ANIM_DELAY_0 } from "../../../../assets/styles/pre-set-styles";
import Table from "../../../../components/ui/Table";
import { PILL_BASE, getErrorRateStyle, getLatencyStyle } from "../metricsStyles";

/**
 * @param {{ hook: import('../metrics.hook').MetricsHook }} props
 */
export default function RedMetricsTab({ hook }) {
    const { redRows, snapshotLoading, snapshotError } = hook;

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
            key: "avg",
            label: "Avg",
            render: (row) => <span className={`${PILL_BASE} ${getLatencyStyle(row._avgRaw)}`}>{row.avg}</span>,
        },
    ];

    return <div className={`mt-6 ${ANIMATE_ENTER_UP} ${ANIM_DELAY_0}`}>{redRows.length === 0 ? <div className="py-16 text-center text-grey-400 dark:text-grey-500 text-sm">No route metrics collected yet. Traffic is needed to populate this table.</div> : <Table columns={columns} data={redRows} stickyHeader striped compact loading={snapshotLoading} />}</div>;
}
