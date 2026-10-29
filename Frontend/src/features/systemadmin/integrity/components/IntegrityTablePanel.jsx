/**
 * IntegrityTablePanel — the shared workhorse rendered by every Integrity Center
 * tab. Driven entirely by the hook's ACTIVE table state:
 *
 *   Scope filters → mode toggle (Tampered-only / All) → live indicator (live
 *   tables) → scan summary + Export + Re-scan → Table (+ Integrity verdict
 *   column) → Pagination with page-size selector.
 *
 * Tampered-only is the default headline view; "Show all rows" switches to the
 * browse mode (offset page with a per-row verdict).
 *
 * @param {{ hook: object }} props
 */

import { faRotateRight } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { ANIMATE_PAGE_ENTER } from "../../../../assets/styles/pre-set-styles";
import { Toggle } from "../../../../components/forms/Toggle";
import ExportButtons from "../../../../components/shared/ExportButtons";
import Alert from "../../../../components/ui/Alert";
import Button from "../../../../components/ui/Button";
import Pagination from "../../../../components/ui/Pagination";
import { Table } from "../../../../components/ui/Table";
import { formatDateTime } from "../../../../utils/formatters";
import ScopeFilters from "./ScopeFilters";
import IntegrityBadge from "./shared/IntegrityBadge";

const INTEGRITY_COLUMN = {
    key: "integrity",
    label: "Integrity",
    render: (row) => <IntegrityBadge integrity={row.integrity} />,
};

export function IntegrityTablePanel({ hook }) {
    const columns = [...hook.columns, INTEGRITY_COLUMN];
    const isTamperMode = hook.mode === "tamper";

    // Tamper mode: hook.total IS the scope-wide tampered count. Browse mode:
    // hook.tamperedInScope comes from the backend's cached sweep, so the banner
    // covers the WHOLE scope; page-scoped counting is only the fallback.
    const tamperedOnPage = (hook.rows ?? []).filter((r) => r.integrity === "TAMPERED").length;
    const scopeCount = isTamperMode ? hook.total : hook.tamperedInScope;
    const bannerCount = scopeCount ?? tamperedOnPage;
    const bannerIsScopeWide = scopeCount != null;

    return (
        <div className={`flex flex-col gap-4 ${ANIMATE_PAGE_ENTER}`}>
            <ScopeFilters hook={hook} />

            {/* ── Controls row: mode toggle · live indicator · re-scan ── */}
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                <Toggle label="Show all rows" checked={hook.mode === "all"} onChange={(checked) => hook.setMode(checked ? "all" : "tamper")} />

                {hook.activeIsLive && (
                    <div className="flex items-center gap-2 text-xs">
                        <span className={`inline-block w-2 h-2 rounded-full ${hook.isLive ? "bg-success-400 animate-pulse" : "bg-grey-400"}`} />
                        <span className="text-black/60 dark:text-white/60">{hook.isLive ? "Live" : "Offline"}</span>
                        {hook.liveNewCount > 0 && (
                            <button type="button" onClick={hook.loadLiveUpdates} className="text-(--accent-foreground) font-aumovio-bold hover:underline">
                                {hook.liveNewCount} new — load
                            </button>
                        )}
                    </div>
                )}

                <div className="ml-auto flex items-center gap-3">
                    {isTamperMode && hook.scannedAt && (
                        <span className="text-xs text-black/50 dark:text-white/50">
                            Scanned {formatDateTime(hook.scannedAt)} · {hook.rowsScanned} rows
                        </span>
                    )}
                    {/* Export follows the mode toggle, so the file matches the screen. */}
                    <ExportButtons exporting={hook.exporting} disabled={hook.loading || hook.rescanning} onExport={hook.handleExportRows} />
                    <Button variant="primary" size="sm" onClick={hook.rescan} disabled={hook.rescanning || hook.loading}>
                        <FontAwesomeIcon icon={faRotateRight} className={`w-3.5 h-3.5 mr-1.5 ${hook.rescanning ? "animate-spin" : ""}`} />
                        Re-scan
                    </Button>
                </div>
            </div>

            {isTamperMode && hook.truncated && (
                <Alert variant="warning" title="Partial scan">
                    The scan hit its row cap before finishing. Narrow the scope (e.g. the date range) for a complete tamper result.
                </Alert>
            )}

            {hook.dataError && (
                <Alert variant="danger" title="Failed to load integrity data">
                    {hook.dataError.message}
                </Alert>
            )}

            {!hook.dataError && bannerCount > 0 && (
                <Alert variant="danger" title={`${bannerCount} tampered row${bannerCount === 1 ? "" : "s"} detected`}>
                    HMAC verification failed for {bannerCount === 1 ? "this row" : "these rows"} {bannerIsScopeWide ? "in the current scope" : "on this page"}. Investigate before trusting downstream figures.
                </Alert>
            )}

            <Table columns={columns} data={hook.rows} loading={hook.loading} emptyText={hook.dataError ? "Unable to load rows — see error above." : isTamperMode ? "No tampered rows — all verified ✓" : "No rows in scope."} striped />

            {(hook.totalPages > 1 || hook.total > hook.limit) && (
                <div className="flex justify-end">
                    <Pagination page={hook.page} totalPages={hook.totalPages} onChange={hook.setPage} pageSize={hook.limit} pageSizeOptions={hook.pageSizeOptions} onPageSizeChange={hook.setLimit} />
                </div>
            )}
        </div>
    );
}

export default IntegrityTablePanel;
