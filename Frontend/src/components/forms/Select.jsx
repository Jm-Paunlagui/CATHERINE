/**
 * Select — Custom dropdown for option picking.
 *
 * Props:
 *   options  — [{ value, label, group? }]
 *   value, onChange, label, placeholder, error, disabled, multiple, size, id, name
 *
 * Replaces native <select> with a fully styled custom dropdown that matches
 * the PageSizeSelect pattern in Pagination.jsx.
 */
import { CheckIcon, ChevronDownIcon } from "@heroicons/react/24/outline";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { TRANSITION_COLORS } from "../../assets/styles/pre-set-styles";

const SZ = {
    // label + chevron + rounded track the size so the trigger matches a Button of
    // the same size (e.g. sm Select aligns in height/radius with a sm Button in a toolbar).
    sm: { trigger: "py-1.5 text-xs", item: "py-1 text-xs px-2.5", label: "text-xs", chevron: "w-3.5 h-3.5", rounded: "rounded-lg" },
    md: { trigger: "py-2 text-sm", item: "py-1.5 text-sm px-3", label: "text-sm", chevron: "w-4 h-4", rounded: "rounded-xl" },
    lg: { trigger: "py-2.5 text-base", item: "py-2 text-base px-3.5", label: "text-base", chevron: "w-4 h-4", rounded: "rounded-xl" },
};

export function Select({
    options = [],
    value,
    onChange,
    label,
    placeholder = "Select…",
    error,
    disabled = false,
    multiple = false,
    size = "md",
    id,
    name,
    /** When true the dropdown renders with position:fixed so it escapes
     *  overflow:hidden / overflow:auto ancestors (e.g. inside a Modal). */
    fixed = false,
}) {
    const [open, setOpen] = useState(false);
    const ref = useRef(null);
    const triggerRef = useRef(null);
    // Wraps the option list. In fixed mode the list is portaled to document.body,
    // so it is NOT a DOM descendant of `ref` — the outside-click handler must check
    // this ref too, otherwise an option's own mousedown is treated as an outside
    // click and closes/unmounts the list before its click can fire (selection no-op).
    const dropdownRef = useRef(null);
    const [fixedPos, setFixedPos] = useState({ top: 0, left: 0, width: 0 });
    const inputId = id ?? name;
    const { trigger: triggerSz, item: itemSz, label: labelSz, chevron: chevronSz, rounded: roundedSz } = SZ[size] ?? SZ.md;

    useEffect(() => {
        if (!open) return;
        const onDown = (e) => {
            if (ref.current?.contains(e.target)) return;
            if (dropdownRef.current?.contains(e.target)) return;
            setOpen(false);
        };
        document.addEventListener("mousedown", onDown);
        return () => document.removeEventListener("mousedown", onDown);
    }, [open]);

    // ── Derived display values ────────────────────────────────────────────────

    const groups = [...new Set(options.map((o) => o.group).filter(Boolean))];
    const ungrouped = options.filter((o) => !o.group);

    const selectedValues = multiple ? (Array.isArray(value) ? value.map(String) : []) : [];

    const selectedOption = !multiple ? options.find((o) => String(o.value) === String(value)) : null;

    const hasValue = multiple ? selectedValues.length > 0 : !!selectedOption;

    const triggerLabel = (() => {
        if (!multiple) return selectedOption?.label ?? null;
        if (selectedValues.length === 0) return null;
        if (selectedValues.length === 1) {
            return options.find((o) => String(o.value) === selectedValues[0])?.label ?? null;
        }
        return `${selectedValues.length} selected`;
    })();

    // ── Handlers ──────────────────────────────────────────────────────────────

    const handleToggleOpen = () => {
        if (fixed && triggerRef.current) {
            const rect = triggerRef.current.getBoundingClientRect();
            const DROPDOWN_MAX_H = 208; // max-h-52 = 13rem
            const spaceBelow = window.innerHeight - rect.bottom - 8;
            const top = spaceBelow >= DROPDOWN_MAX_H ? rect.bottom + 6 : rect.top - DROPDOWN_MAX_H - 6;
            setFixedPos({ top, left: rect.left, width: rect.width });
        }
        setOpen((o) => !o);
    };

    const handleSingle = (optValue) => {
        onChange?.(optValue);
        setOpen(false);
    };

    const handleMultiToggle = (optValue) => {
        const str = String(optValue);
        const next = selectedValues.includes(str) ? selectedValues.filter((v) => v !== str) : [...selectedValues, str];
        onChange?.(next);
    };

    // ── Option list renderer ──────────────────────────────────────────────────

    const renderItems = (opts) =>
        opts.map((o) => {
            const isActive = multiple ? selectedValues.includes(String(o.value)) : String(o.value) === String(value);
            return (
                <li
                    key={o.value}
                    onClick={() => (multiple ? handleMultiToggle(o.value) : handleSingle(o.value))}
                    className={`flex items-center justify-between cursor-pointer font-aumovio-bold
                        ${TRANSITION_COLORS} ${itemSz}
                        ${isActive ? "bg-orange-400 text-(--on-accent-text)" : "text-black/70 dark:text-white/70 hover:bg-orange-400/10 hover:text-(--accent-foreground)"}`}
                >
                    <span>{o.label}</span>
                    {multiple && isActive && <CheckIcon className="w-3.5 h-3.5 shrink-0" />}
                </li>
            );
        });

    // ── Render ────────────────────────────────────────────────────────────────

    return (
        <div className="font-aumovio">
            {label && (
                <label htmlFor={inputId} className="block text-xs font-aumovio-bold text-black/70 dark:text-white/70 mb-1.5 cursor-default">
                    {label}
                </label>
            )}

            <div ref={ref} className="relative">
                <button
                    ref={triggerRef}
                    id={inputId}
                    name={name}
                    type="button"
                    disabled={disabled}
                    onClick={handleToggleOpen}
                    className={`w-full flex items-center justify-between gap-2 pl-3 pr-2.5 ${roundedSz} border
                        font-aumovio cursor-pointer ${TRANSITION_COLORS} ${triggerSz}
                        bg-white dark:bg-(--bg-surface-2)
                        disabled:opacity-50 disabled:cursor-not-allowed
                        ${
                            error
                                ? open
                                    ? "border-danger-400 ring-2 ring-danger-400/30 shadow-md text-black/85 dark:text-white/85"
                                    : "border-danger-400 text-black/85 dark:text-white/85 hover:border-danger-400"
                                : open
                                  ? "border-orange-400 text-(--accent-foreground) ring-2 ring-orange-400/20 shadow-md"
                                  : "border-grey-300 dark:border-grey-700 text-black/85 dark:text-white/85 hover:border-orange-400 hover:text-(--accent-foreground)"
                        }`}
                >
                    <span className={`truncate ${labelSz} ${!hasValue ? "text-black/40 dark:text-white/40" : "font-aumovio-bold"}`}>{triggerLabel ?? placeholder}</span>
                    <ChevronDownIcon
                        className={`${chevronSz} shrink-0 ${TRANSITION_COLORS}
                            ${open ? "rotate-180 text-(--accent-foreground)" : "text-grey-400"}`}
                    />
                </button>

                {open &&
                    (() => {
                        const dropdownEl = (
                            <ul
                                ref={dropdownRef}
                                className={`${fixed ? "z-9999" : "absolute top-full mt-1.5 left-0 z-50 min-w-full w-max max-w-[20rem]"} max-h-52 overflow-y-auto overflow-x-hidden
                                bg-white dark:bg-(--bg-surface-2) border border-grey-200 dark:border-grey-700
                                rounded-xl shadow-xl shadow-black/10 dark:shadow-black/40 py-1
                                [&::-webkit-scrollbar]:hidden`}
                                style={fixed ? { position: "fixed", top: fixedPos.top, left: fixedPos.left, width: fixedPos.width, scrollbarWidth: "none" } : { scrollbarWidth: "none" }}
                            >
                                {/* Placeholder / clear option — single select only */}
                                {placeholder && !multiple && (
                                    <li
                                        onClick={() => {
                                            onChange?.("");
                                            setOpen(false);
                                        }}
                                        className={`flex items-center cursor-pointer italic ${TRANSITION_COLORS} ${itemSz}
                                        text-black/35 dark:text-white/35 hover:bg-orange-400/10 hover:text-(--accent-foreground)`}
                                    >
                                        {placeholder}
                                    </li>
                                )}

                                {/* Options — with optional group headers */}
                                {groups.length > 0 ? (
                                    <>
                                        {ungrouped.length > 0 && renderItems(ungrouped)}
                                        {groups.map((g) => (
                                            <li key={g}>
                                                <div className="px-3 pt-2 pb-0.5 text-xs font-aumovio-bold text-black/40 dark:text-white/40 uppercase tracking-wider select-none">{g}</div>
                                                <ul>{renderItems(options.filter((o) => o.group === g))}</ul>
                                            </li>
                                        ))}
                                    </>
                                ) : (
                                    renderItems(options)
                                )}
                            </ul>
                        );
                        return fixed ? createPortal(dropdownEl, document.body) : dropdownEl;
                    })()}
            </div>

            {error && <p className="mt-1.5 text-xs text-danger-400 font-aumovio-bold">{error}</p>}
        </div>
    );
}

export default Select;
