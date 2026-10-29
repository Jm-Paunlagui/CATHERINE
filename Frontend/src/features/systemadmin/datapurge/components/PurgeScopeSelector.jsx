/**
 * PurgeScopeSelector.jsx — Group cards with per-table row counts and
 * "auto-included by dependency" badges.
 *
 * Presentation only. Receives the whole hook object via props (whole-hook
 * pattern, Frontend/Claude.md §3) — never imports datapurge.hook.js or
 * datapurge.api.js directly.
 *
 * Each card renders:
 *   - a Checkbox to select the whole group,
 *   - a live row-count Badge for the group total (from `GET /scopes`, never
 *     cached),
 *   - the per-table row counts,
 *   - a "pulled in by dependency" hint naming the groups this selection
 *     would auto-include (client-side preview via each group's
 *     `autoIncludes`, mirroring `GROUP_CLOSURE_HINTS`), and
 *   - a distinct purple "Auto-included" badge on any card that is CURRENTLY
 *     pulled in by another selected group, so the operator sees the
 *     resolved closure before ever opening the stepper.
 *
 * The authoritative resolved closure (with live re-counted rows) is always
 * re-fetched from `POST /preview` once the stepper opens — this component's
 * badges are a same-page preview, not the source of truth.
 */

import { faDatabase, faLayerGroup, faRotateRight } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { ANIMATE_FADE_IN_UP, HOVER_LIFT, staggerDelay, TRANSITION_COLORS, TRANSITION_SPRING } from "../../../../assets/styles/pre-set-styles";
import ApiErrorAlert from "../../../../components/feedback/ApiErrorAlert";
import Badge from "../../../../components/ui/Badge";
import Button from "../../../../components/ui/Button";
import { Checkbox } from "../../../../components/forms/Checkbox";
import { Skeleton } from "../../../../components/ui/Skeleton";
import { Tooltip } from "../../../../components/ui/Tooltip";
import { formatCompactNumber, formatNumber } from "../../../../utils/formatters";
import { GROUP_META, groupLabel } from "./shared/purgeGroupMeta";

/**
 * Row counts here are abbreviated (`2,966` → `3K`) so a badge or a table cell
 * never wraps once a table reaches six or seven digits — an audit or
 * transaction table can run to millions between archive passes.
 *
 * Every abbreviated figure is wrapped in a `Tooltip` carrying the exact count,
 * so precision is one hover away and never lost. The confirmation stepper
 * deliberately keeps `formatNumber` — an operator authorising a deletion must
 * read the exact number of rows, not a rounded one.
 */
const rowsLabel = (n) => `${formatNumber(n)} row${n === 1 ? "" : "s"}`;

/**
 * @param {object} props
 * @param {object} props.hook - Full `useDataPurge()` hook object.
 */
export function PurgeScopeSelector({ hook }) {
    const { scopeCatalogue, scopesLoading, scopesError, refetchScopes, selectedGroups, toggleGroup, clearSelection, autoIncludedGroupsPreview, openPurgeModal } = hook;

    if (scopesLoading && !scopeCatalogue) {
        return (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {Array.from({ length: 6 }).map((_, i) => (
                    <Skeleton key={i} variant="card" />
                ))}
            </div>
        );
    }

    if (scopesError) {
        return <ApiErrorAlert error={scopesError} onDismiss={null} />;
    }

    if (!scopeCatalogue || scopeCatalogue.groups.length === 0) {
        return <div className="text-center py-16 text-grey-400">No purgeable table groups were returned by the server.</div>;
    }

    const selectedTotalRows = scopeCatalogue.groups.filter((g) => selectedGroups.includes(g.group)).reduce((sum, g) => sum + g.totalRows, 0);

    return (
        <div className={`space-y-4 ${ANIMATE_FADE_IN_UP}`}>
            {/* Toolbar */}
            <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-black/60 dark:text-white/60">
                    Select one or more groups to purge. Dependent groups are pulled in automatically and shown below — nothing is deleted until you complete the confirmation stepper.
                </p>
                <Button variant="ghost" size="sm" onClick={refetchScopes} disabled={scopesLoading}>
                    <FontAwesomeIcon icon={faRotateRight} className={`w-3.5 h-3.5 mr-1.5 ${scopesLoading ? "animate-spin" : ""}`} />
                    Refresh Counts
                </Button>
            </div>

            {/* Group cards */}
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                {scopeCatalogue.groups.map((g, i) => (
                    <GroupCard key={g.group} group={g} selected={selectedGroups.includes(g.group)} autoIncluded={autoIncludedGroupsPreview.includes(g.group)} onToggle={() => toggleGroup(g.group)} staggerIndex={i} />
                ))}
            </div>

            {/* Selection summary + action bar */}
            <div className="sticky bottom-4 flex flex-wrap items-center justify-between gap-3 p-4 rounded-xl bg-white dark:bg-(--bg-surface-2) border border-(--color-card-surface-border) shadow-lg">
                <div className="flex items-center gap-2 text-sm">
                    <FontAwesomeIcon icon={faLayerGroup} className="text-(--accent-icon)" />
                    {selectedGroups.length === 0 ? <span className="text-black/50 dark:text-white/50">No groups selected.</span> : (
                        <span className="text-black/80 dark:text-white/80">
                            <span className="font-aumovio-bold">{selectedGroups.length}</span> group{selectedGroups.length !== 1 ? "s" : ""} selected &middot; ~
                            <Tooltip content={rowsLabel(selectedTotalRows)} placement="top">
                                <span className="font-aumovio-bold tabular-nums cursor-default">{formatCompactNumber(selectedTotalRows)}</span>
                            </Tooltip>{" "}
                            row{selectedTotalRows !== 1 ? "s" : ""} (explicit selection only — the confirmation stepper shows the exact resolved total)
                        </span>
                    )}
                </div>
                <div className="flex items-center gap-2">
                    <Button variant="ghost" size="sm" onClick={clearSelection} disabled={selectedGroups.length === 0}>
                        Clear
                    </Button>
                    <Button variant="danger" size="sm" onClick={openPurgeModal} disabled={selectedGroups.length === 0}>
                        <FontAwesomeIcon icon={faDatabase} className="w-3.5 h-3.5 mr-1.5" />
                        Review &amp; Purge Selected
                    </Button>
                </div>
            </div>
        </div>
    );
}

// ─── Group card ─────────────────────────────────────────────────────────────

/**
 * @param {object} props
 * @param {{ group: string, tables: Array<{table: string, rowCount: number}>, totalRows: number, autoIncludes: string[] }} props.group
 * @param {boolean} props.selected
 * @param {boolean} props.autoIncluded
 * @param {Function} props.onToggle
 * @param {number} props.staggerIndex
 */
function GroupCard({ group, selected, autoIncluded, onToggle, staggerIndex }) {
    const meta = GROUP_META[group.group] ?? { label: group.group, description: "" };

    return (
        <div
            className={`p-4 rounded-xl border ${TRANSITION_SPRING} ${HOVER_LIFT} ${ANIMATE_FADE_IN_UP} ${staggerDelay(staggerIndex)}
            ${selected ? "border-danger-400/50 bg-danger-100/10 dark:bg-danger-400/10 shadow-md shadow-danger-400/10" : "border-(--color-card-surface-border) bg-white dark:bg-(--bg-surface-2)"}`}
        >
            <div className="flex items-start justify-between gap-3">
                <Checkbox id={`purge-group-${group.group}`} label={meta.label} description={meta.description} checked={selected} onChange={onToggle} />
                <div className="shrink-0">
                    <Tooltip content={`${rowsLabel(group.totalRows)} across ${group.tables.length} table${group.tables.length === 1 ? "" : "s"}`} placement="left">
                        <Badge variant={selected ? "red" : "grey"} size="sm" pill>
                            <span className="whitespace-nowrap tabular-nums">{formatCompactNumber(group.totalRows)} rows</span>
                        </Badge>
                    </Tooltip>
                </div>
            </div>

            {autoIncluded && (
                <div className="mt-2">
                    <Badge variant="purple" size="sm" pill title="Pulled in automatically because a table in this group is referenced by a table in your current selection.">
                        Auto-included by dependency
                    </Badge>
                </div>
            )}

            {group.autoIncludes.length > 0 && (
                <p className="mt-2 text-xs text-black/50 dark:text-white/50">
                    Selecting this group also purges: <span className="font-aumovio-bold">{group.autoIncludes.map(groupLabel).join(", ")}</span>
                </p>
            )}

            <div className={`mt-3 pt-3 border-t border-grey-200 dark:border-grey-700 space-y-1 max-h-32 overflow-y-auto hide-scrollbar`}>
                {group.tables.map((t) => (
                    <div key={t.table} className={`flex items-center justify-between gap-2 text-xs ${TRANSITION_COLORS}`}>
                        <span className="font-mono text-black/60 dark:text-white/60 truncate">{t.table}</span>
                        <Tooltip content={rowsLabel(t.rowCount)} placement="left">
                            <span className="shrink-0 min-w-12 text-right tabular-nums text-black/40 dark:text-white/40 cursor-default">{formatCompactNumber(t.rowCount)}</span>
                        </Tooltip>
                    </div>
                ))}
            </div>
        </div>
    );
}

export default PurgeScopeSelector;
