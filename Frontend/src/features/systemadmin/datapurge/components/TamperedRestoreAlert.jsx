/**
 * TamperedRestoreAlert.jsx — persistent danger alert shown when a restore
 * finished but some rows failed their ORIGINAL signature check and were
 * restored with ROW_HASH = NULL (backend: `tamperedRowsRestoredUnsigned`).
 *
 * Presentation only. Table names are rendered as React text children
 * (never HTML) — CWE-79. Renders nothing when the total is 0 / absent.
 *
 * Complexity: O(t) over the per-table entries.
 *
 * @param {object} props
 * @param {{ tamperedRowsRestoredUnsigned?: number, perTable?: Array<{ table: string, tamperedRowsRestoredUnsigned?: number }> }} props.report
 */

import { useInRouterContext, Link } from "react-router-dom";
import Alert from "../../../../components/ui/Alert";
import { formatNumber } from "../../../../utils/formatters";

const INTEGRITY_PATH = "/system/data-integrity";
const LINK_CLASS = "text-xs font-aumovio-bold underline text-[var(--status-danger-text)]";

export function TamperedRestoreAlert({ report }) {
    const inRouter = useInRouterContext();
    const total = Number(report?.tamperedRowsRestoredUnsigned) || 0;
    if (total <= 0) return null;

    const tables = (report.perTable ?? []).filter((t) => (Number(t?.tamperedRowsRestoredUnsigned) || 0) > 0);

    return (
        <Alert variant="danger" title="Restore finished with unsigned rows">
            <p className="text-sm mt-1">{`${formatNumber(total)} row(s) failed their original signature check and were restored without a signature. Review them before relying on this data — where Data Integrity covers the table, they show as Tampered.`}</p>
            {tables.length > 0 && (
                <ul aria-label="Tables with unsigned rows" className="mt-2 space-y-1 text-xs">
                    {tables.map((t) => (
                        <li key={t.table} className="flex items-center justify-between gap-2">
                            <span className="font-mono truncate text-black/70 dark:text-white/70">{t.table}</span>
                            <span className="shrink-0 tabular-nums font-aumovio-bold text-black/80 dark:text-white/80">{formatNumber(t.tamperedRowsRestoredUnsigned)}</span>
                        </li>
                    ))}
                </ul>
            )}
            <div className="mt-3">
                {inRouter ? (
                    <Link to={INTEGRITY_PATH} className={LINK_CLASS}>
                        Open Data Integrity
                    </Link>
                ) : (
                    <a href={INTEGRITY_PATH} className={LINK_CLASS}>
                        Open Data Integrity
                    </a>
                )}
            </div>
        </Alert>
    );
}

export default TamperedRestoreAlert;
