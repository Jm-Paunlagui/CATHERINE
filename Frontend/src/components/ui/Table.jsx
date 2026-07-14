/**
 * Table — Data table with sort, pagination, selection, and empty state.
 *
 * Props:
 *   columns        — [{ key, label, sortable?, render?: (row) => ReactNode, width? }]
 *   data           — array of row objects (each needs a unique `id`)
 *   loading        — boolean
 *   selectable     — boolean
 *   selectedIds    — Set<id>
 *   onSelect       — (id, checked) => void
 *   onSelectAll    — (checked) => void
 *   sortKey        — string
 *   sortDir        — 'asc'|'desc'
 *   onSort         — (key) => void
 *   emptyText      — string
 *   stickyHeader   — boolean
 *   striped        — boolean
 *   compact        — boolean
 *   rowClassName   — (row) => string  — overrides default bg/hover classes for that row
 *   rowTitle       — (row) => string | undefined  — title attr on each <tr>
 *   expandRow      — (row) => ReactNode  — optional sub-row rendered after each data row
 *   wrapperClassName — string  — extra classes appended to the outer wrapper div
 */

import { ChevronDownIcon, ChevronUpIcon } from "@heroicons/react/24/outline";
import { Fragment } from "react";
import { TRANSITION_COLORS } from "../../assets/styles/pre-set-styles";
import Skeleton from "./Skeleton";

export function Table({ columns = [], data = [], loading = false, selectable = false, selectedIds = new Set(), onSelect, onSelectAll, sortKey, sortDir = "asc", onSort, emptyText = "No records found.", stickyHeader = false, striped = false, compact = false, rowClassName, rowTitle, expandRow, wrapperClassName = "" }) {
    const allSelected = data.length > 0 && data.every((r) => selectedIds.has(r.id));
    const someSelected = data.some((r) => selectedIds.has(r.id));
    const cellPad = compact ? "px-4 py-2" : "px-5 py-3.5";

    return (
        <div className={`w-full overflow-x-auto border rounded-xl border-grey-200 dark:border-grey-700 font-aumovio${wrapperClassName ? ` ${wrapperClassName}` : ""}`}>
            <table className="w-full text-sm">
                <thead
                    className={`${stickyHeader ? "sticky top-0 z-10" : ""}
          bg-grey-50 dark:bg-(--bg-surface-3) border-b border-grey-200 dark:border-grey-700`}
                >
                    <tr>
                        {selectable && (
                            <th className={cellPad}>
                                <input
                                    type="checkbox"
                                    checked={allSelected}
                                    ref={(el) => {
                                        if (el) el.indeterminate = someSelected && !allSelected;
                                    }}
                                    onChange={(e) => onSelectAll?.(e.target.checked)}
                                    className="w-4 h-4 rounded cursor-pointer accent-orange-400"
                                />
                            </th>
                        )}
                        {columns.map((col) => (
                            <th
                                key={col.key}
                                className={`${cellPad} text-left font-aumovio-bold text-grey-500 dark:text-grey-400
                  uppercase tracking-wider text-xs whitespace-nowrap
                  ${col.sortable ? "cursor-pointer hover:text-(--accent-foreground) select-none" : ""}
                  ${col.width ?? ""}`}
                                onClick={() => col.sortable && onSort?.(col.key)}
                            >
                                <span className="flex items-center gap-1">
                                    {col.label}
                                    {col.sortable && (
                                        <span className="flex flex-col -space-y-0.5">
                                            <ChevronUpIcon className={`w-2.5 h-2.5 ${sortKey === col.key && sortDir === "asc" ? "text-(--accent-foreground)" : "text-grey-300 dark:text-grey-600"}`} />
                                            <ChevronDownIcon className={`w-2.5 h-2.5 ${sortKey === col.key && sortDir === "desc" ? "text-(--accent-foreground)" : "text-grey-300 dark:text-grey-600"}`} />
                                        </span>
                                    )}
                                </span>
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody className="divide-y divide-grey-100 dark:divide-grey-800">
                    {loading ? (
                        Array.from({ length: 5 }, (_, i) => (
                            <tr key={i} className="bg-(--bg-surface) dark:bg-(--bg-surface-2)">
                                {selectable && (
                                    <td className={cellPad}>
                                        <Skeleton variant="rect" width="1rem" height="1rem" />
                                    </td>
                                )}
                                {columns.map((col) => (
                                    <td key={col.key} className={cellPad}>
                                        <Skeleton variant="rect" height="0.875rem" />
                                    </td>
                                ))}
                            </tr>
                        ))
                    ) : data.length === 0 ? (
                        <tr>
                            <td colSpan={columns.length + (selectable ? 1 : 0)} className="py-16 text-center text-grey-400 dark:text-grey-500">
                                {emptyText}
                            </td>
                        </tr>
                    ) : (
                        data.map((row, ri) => {
                            const isSelected = selectedIds.has(row.id);
                            const customCls = rowClassName?.(row) ?? "";
                            const title = rowTitle?.(row);
                            return (
                                <Fragment key={row.id ?? ri}>
                                    <tr
                                        title={title}
                                        className={
                                            customCls
                                                ? `${TRANSITION_COLORS} ${customCls}`
                                                : `${TRANSITION_COLORS}
                                               ${striped && ri % 2 === 1 ? "bg-grey-50/50 dark:bg-white/3" : "bg-(--bg-surface) dark:bg-(--bg-surface-2)"}
                                               ${isSelected ? "bg-orange-50 dark:bg-orange-400/5" : ""}
                                               hover:bg-orange-50/60 dark:hover:bg-orange-400/5`
                                        }
                                    >
                                        {selectable && (
                                            <td className={cellPad}>
                                                <input type="checkbox" checked={isSelected} onChange={(e) => onSelect?.(row.id, e.target.checked)} className="w-4 h-4 cursor-pointer accent-orange-400" />
                                            </td>
                                        )}
                                        {columns.map((col) => (
                                            <td key={col.key} className={`${cellPad} text-black/75 dark:text-white/75`}>
                                                {col.render ? col.render(row) : (row[col.key] ?? "—")}
                                            </td>
                                        ))}
                                    </tr>
                                    {expandRow?.(row) ?? null}
                                </Fragment>
                            );
                        })
                    )}
                </tbody>
            </table>
        </div>
    );
}

export default Table;
