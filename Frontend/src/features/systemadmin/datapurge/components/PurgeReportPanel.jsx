/**
 * PurgeReportPanel.jsx — Post-operation per-table results (purge report /
 * restore report).
 *
 * Presentation only. Accepts the raw report object returned by
 * `POST /execute` or `POST /restore` and renders it generically —
 * `mode` selects which field names to read since the two reports have
 * different (but structurally similar) shapes:
 *
 *   purge   → { scopeHash, tables, totalDeleted, perTable: [{table, deletedCount}], durationMs }
 *   restore → { kind, tables, totalInserted, totalResigned,
 *               perTable: [{table, insertedCount, hashesResigned}], durationMs,
 *               archiveMeta, fidelityNotes }
 */

import { CheckCircleIcon, ClockIcon, TableCellsIcon } from "@heroicons/react/24/outline";
import { ANIMATE_BOUNCE_IN, ANIMATE_FADE_IN_UP } from "../../../../assets/styles/pre-set-styles";
import Badge from "../../../../components/ui/Badge";
import { Table } from "../../../../components/ui/Table";
import { Tooltip } from "../../../../components/ui/Tooltip";
import { formatCompactNumber, formatNumber } from "../../../../utils/formatters";

/**
 * Abbreviated count with the exact figure on hover. Used for every row total on
 * this screen — a fixed-width stat tile or a pill cannot hold "1,284,301".
 */
const CompactCount = ({ value, suffix = "" }) => (
    <Tooltip content={`${formatNumber(value)}${suffix ? ` ${suffix}` : ""}`} placement="top">
        <span className="tabular-nums cursor-default">{formatCompactNumber(value)}</span>
    </Tooltip>
);

/**
 * @param {object} props
 * @param {'purge'|'restore'} props.mode
 * @param {object} props.report - The raw response `data` from `/execute` or `/restore`.
 */
export function PurgeReportPanel({ mode, report }) {
    if (!report) return null;

    const isRestore = mode === "restore";
    const totalRows = isRestore ? report.totalInserted : report.totalDeleted;
    const totalLabel = isRestore ? "rows inserted" : "rows deleted";
    const perTable = report.perTable ?? [];

    const rows = perTable.map((r) => ({
        id: r.table,
        table: r.table,
        count: isRestore ? r.insertedCount : r.deletedCount,
        hashesResigned: r.hashesResigned,
    }));

    const columns = [
        { key: "table", label: "Table", render: (row) => <span className="font-mono text-xs">{row.table}</span> },
        { key: "count", label: isRestore ? "Rows Inserted" : "Rows Deleted", render: (row) => <CompactCount value={row.count} suffix="rows" /> },
        ...(isRestore
            ? [
                  {
                      key: "hashesResigned",
                      label: "Hashes Re-signed",
                      render: (row) =>
                          row.hashesResigned > 0 ? (
                              <Badge variant="purple" size="sm" pill>
                                  <CompactCount value={row.hashesResigned} suffix="signatures re-signed" />
                              </Badge>
                          ) : (
                              <span className="text-grey-400">—</span>
                          ),
                  },
              ]
            : []),
    ];

    return (
        <div className={`space-y-4 ${ANIMATE_FADE_IN_UP}`}>
            <div className={`flex flex-col items-center justify-center gap-3 py-6 ${ANIMATE_BOUNCE_IN}`}>
                <CheckCircleIcon className="w-14 h-14 text-success-400" />
                <p className="text-sm font-aumovio-bold text-black/85 dark:text-white/85">{isRestore ? "Restore completed successfully." : "Purge completed successfully."}</p>
                <p className="text-xs text-black/40 dark:text-white/40 text-center max-w-md">An audit log entry has been written to T_AUDIT_LOGS{isRestore ? "" : ", and an ops alert email has been sent"}.</p>
            </div>

            {/* Stat strip */}
            <div className="grid grid-cols-3 gap-3">
                <StatTile icon={TableCellsIcon} label="Tables Affected" value={formatNumber(report.tables?.length ?? perTable.length)} />
                <StatTile icon={CheckCircleIcon} label={totalLabel} value={<CompactCount value={totalRows ?? 0} suffix="rows" />} />
                <StatTile icon={ClockIcon} label="Duration" value={`${formatNumber(report.durationMs ?? 0)} ms`} />
            </div>

            {isRestore && report.totalResigned > 0 && (
                <p className="text-xs text-black/50 dark:text-white/50 text-center">
                    <span className="font-aumovio-bold">{formatNumber(report.totalResigned)}</span> ROW_HASH tamper-evidence signature(s) re-signed against the new primary keys — the Integrity Center will show these rows as verified.
                </p>
            )}

            {/* Per-table results */}
            <Table columns={columns} data={rows} emptyText="No tables were affected." striped compact />

            {(report.scopeHash || report.archiveMeta?.scopeHash) && <p className="text-[10px] font-mono text-black/30 dark:text-white/30 text-center break-all">Scope hash: {report.scopeHash ?? report.archiveMeta?.scopeHash}</p>}
        </div>
    );
}

/**
 * @param {{ icon: React.ComponentType, label: string, value: string }} props
 */
function StatTile({ icon: Icon, label, value }) {
    return (
        <div className="flex flex-col items-center gap-1 p-3 rounded-xl bg-grey-50 dark:bg-(--bg-surface-3) border border-(--color-card-surface-border)">
            <Icon className="w-4 h-4 text-(--accent-icon)" />
            <span className="text-base font-aumovio-bold text-black/85 dark:text-white/85">{value}</span>
            <span className="text-[10px] uppercase tracking-wide text-grey-400">{label}</span>
        </div>
    );
}

export default PurgeReportPanel;
