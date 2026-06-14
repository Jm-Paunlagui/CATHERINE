/**
 * Pagination — Page navigation + optional per-page selector.
 *
 * Props:
 *   page             — current page (1-indexed)
 *   totalPages       — total number of pages
 *   onChange         — (page: number) => void
 *   siblingCount     — pages shown on each side of current (default 1)
 *   showEnds         — boolean (first/last page buttons)
 *   size             — 'sm'|'md'|'lg'
 *   variant          — 'default'|'rounded'
 *   pageSize         — current page size value (optional)
 *   pageSizeOptions  — number[] (optional)
 *   onPageSizeChange — (size: number) => void (optional)
 */

import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon } from "@heroicons/react/24/outline";
import { useEffect, useRef, useState } from "react";
import { TRANSITION_COLORS } from "../../assets/styles/pre-set-styles";

function buildRange(start, end) {
    return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

function getPages(current, total, sibling = 1) {
    const range = sibling + 5;
    if (total <= range) return buildRange(1, total);
    const left = Math.max(current - sibling, 1);
    const right = Math.min(current + sibling, total);
    const pages = [1];
    if (left > 2) pages.push("...");
    pages.push(...buildRange(left, right));
    if (right < total - 1) pages.push("...");
    pages.push(total);
    return [...new Set(pages)];
}

const SZ = {
    sm: { btn: "w-7 h-7 text-xs", sel: "h-7 text-xs" },
    md: { btn: "w-8 h-8 text-sm", sel: "h-8 text-sm" },
    lg: { btn: "w-10 h-10 text-base", sel: "h-10 text-base" },
};

const DEFAULT_CLS = "bg-(--bg-surface) dark:bg-(--bg-surface-2) border-grey-200 dark:border-grey-700 text-black/70 dark:text-white/70 hover:border-orange-400 hover:text-orange-400 dark:hover:border-orange-400";
const ACTIVE_CLS = "bg-orange-400 text-white border-orange-400 shadow-lg shadow-orange-400/30";
const GHOST_CLS = "bg-transparent border-transparent text-grey-400 cursor-default pointer-events-none";

// ─── Custom per-page dropdown ─────────────────────────────────────────────────

function PageSizeSelect({ value, options, onChange, selSz, radius }) {
    const [open, setOpen] = useState(false);
    const ref = useRef(null);

    useEffect(() => {
        if (!open) return;
        const onDown = (e) => {
            if (!ref.current?.contains(e.target)) setOpen(false);
        };
        document.addEventListener("mousedown", onDown);
        return () => document.removeEventListener("mousedown", onDown);
    }, [open]);

    return (
        <div ref={ref} className="relative">
            <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                className={`flex items-center gap-1.5 pl-2.5 pr-2 cursor-pointer font-aumovio-bold shrink-0
                    border ${TRANSITION_COLORS} ${selSz} ${radius} ${DEFAULT_CLS}
                    ${open ? "border-orange-400 text-orange-400" : ""}`}
            >
                <span>{value?.toLocaleString()}</span>
                <ChevronDownIcon className={`w-3 h-3 shrink-0 ${TRANSITION_COLORS} ${open ? "rotate-180 text-orange-400" : ""}`} />
            </button>

            {open && (
                <ul
                    className="absolute bottom-full mb-1.5 left-0 z-50 min-w-full max-h-52 overflow-y-auto overflow-x-hidden
                        bg-(--bg-surface) dark:bg-(--bg-surface-2) border border-grey-200 dark:border-grey-700
                        rounded-lg shadow-xl shadow-black/10 dark:shadow-black/40 py-1 font-aumovio
                        [&::-webkit-scrollbar]:hidden"
                    style={{ scrollbarWidth: "none" }}
                >
                    {options.map((n) => (
                        <li
                            key={n}
                            onClick={() => {
                                onChange(n);
                                setOpen(false);
                            }}
                            className={`flex items-center px-3 py-1.5 cursor-pointer font-aumovio-bold ${TRANSITION_COLORS}
                                ${n === value ? "bg-orange-400 text-white" : "text-black/70 dark:text-white/70 hover:bg-orange-400/10 dark:hover:bg-orange-400/10 hover:text-orange-400"}`}
                        >
                            {n.toLocaleString()}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

// ─── Pagination ───────────────────────────────────────────────────────────────

export function Pagination({ page, totalPages, onChange, siblingCount = 1, showEnds = true, size = "md", variant = "default", pageSize, pageSizeOptions, onPageSizeChange }) {
    const hasNav = totalPages > 1;
    const hasPerPage = pageSizeOptions?.length > 0 && onPageSizeChange != null;

    if (!hasNav && !hasPerPage) return null;

    const { btn: btnSz, sel: selSz } = SZ[size] ?? SZ.md;
    const radius = variant === "rounded" ? "rounded-full" : "rounded-lg";
    const shared = `border font-aumovio-bold shrink-0 ${TRANSITION_COLORS} ${radius}`;
    const pages = hasNav ? getPages(page, totalPages, siblingCount) : [];

    const btn = (label, target, disabled, icon) => (
        <button
            key={typeof label === "string" ? label : undefined}
            onClick={() => !disabled && onChange?.(target)}
            disabled={disabled}
            aria-label={typeof label === "string" ? label : undefined}
            aria-current={label === page ? "page" : undefined}
            className={`flex items-center justify-center ${shared} ${btnSz}
                ${disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}
                ${label === page ? ACTIVE_CLS : label === "..." ? GHOST_CLS : DEFAULT_CLS}`}
        >
            {icon ?? label}
        </button>
    );

    return (
        <nav aria-label="Pagination" className="flex flex-wrap items-center gap-1 font-aumovio">
            {hasPerPage && (
                <>
                    <PageSizeSelect value={pageSize} options={pageSizeOptions} onChange={onPageSizeChange} selSz={selSz} radius={radius} />
                    {hasNav && <span className="w-px h-4 bg-grey-200 dark:bg-grey-700 mx-0.5 shrink-0" />}
                </>
            )}
            {hasNav && (
                <>
                    {btn("Prev", page - 1, page <= 1, <ChevronLeftIcon className="w-4 h-4" />)}
                    {showEnds && pages.map((p) => btn(p, typeof p === "number" ? p : page, p === "...", null))}
                    {btn("Next", page + 1, page >= totalPages, <ChevronRightIcon className="w-4 h-4" />)}
                </>
            )}
        </nav>
    );
}

export default Pagination;
