/**
 * Datepicker — Calendar date selection.
 *
 * Props:
 *   value       — Date | null
 *   onChange    — (date: Date) => void
 *   placeholder — string
 *   label       — string (optional floating label above the trigger)
 *   minDate     — Date
 *   maxDate     — Date
 *   disabled    — boolean
 *   error       — string | null  (shows error state + message)
 */
import { CalendarDaysIcon, ChevronLeftIcon, ChevronRightIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { addMonths, eachDayOfInterval, endOfMonth, endOfWeek, format, isAfter, isBefore, isSameDay, isSameMonth, isToday, startOfMonth, startOfWeek, subMonths } from "date-fns";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

export function Datepicker({ value = null, onChange, placeholder = "Select date", label, minDate, maxDate, disabled = false, error = null }) {
    const [open, setOpen] = useState(false);
    const [viewDate, setViewDate] = useState(value ?? new Date());
    const [dropdownPos, setDropdownPos] = useState({ top: 0, left: 0 });
    const ref = useRef(null);
    const triggerRef = useRef(null);
    const dropdownRef = useRef(null);

    useEffect(() => {
        const handler = (e) => {
            if (ref.current?.contains(e.target)) return;
            if (dropdownRef.current?.contains(e.target)) return;
            setOpen(false);
        };
        document.addEventListener("mousedown", handler);
        return () => document.removeEventListener("mousedown", handler);
    }, []);

    // Position the portal dropdown beneath the trigger button
    useEffect(() => {
        if (!open || !triggerRef.current) return;
        const rect = triggerRef.current.getBoundingClientRect();
        setDropdownPos({ top: rect.bottom + 8, left: rect.left });
    }, [open, viewDate]);

    // Keep view in sync when value changes externally
    useEffect(() => {
        if (value) setViewDate(value);
    }, [value]);

    const days = eachDayOfInterval({
        start: startOfWeek(startOfMonth(viewDate)),
        end: endOfWeek(endOfMonth(viewDate)),
    });

    const isDisabled = (d) => (minDate && isBefore(d, minDate)) || (maxDate && isAfter(d, maxDate));

    const handleClear = (e) => {
        e.stopPropagation();
        onChange?.(null);
    };

    return (
        <div ref={ref} className="relative w-full font-aumovio">
            {/* Label */}
            {label && <label className="block text-xs font-aumovio-bold text-grey-500 dark:text-grey-400 mb-1.5 tracking-wide">{label}</label>}

            {/* Trigger button */}
            <button
                ref={triggerRef}
                type="button"
                onClick={() => !disabled && setOpen((o) => !o)}
                disabled={disabled}
                className={[
                    "group w-full flex items-center gap-2.5 px-3.5 py-2 rounded-lg border text-sm text-left",
                    "bg-white dark:bg-(--bg-surface-2)",
                    "transition-all duration-200",
                    open ? "border-orange-400 ring-2 ring-orange-400/30 shadow-md" : error ? "border-danger-400 ring-2 ring-danger-400/30" : "border-grey-300 dark:border-grey-700 hover:border-orange-400/60",
                    disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer",
                ].join(" ")}
            >
                {/* Icon with accent tint when open */}
                <span className={`shrink-0 transition-colors duration-200 ${open ? "text-(--accent-icon)" : "text-grey-400 group-hover:text-(--accent-icon)"}`}>
                    <CalendarDaysIcon className="w-4 h-4" />
                </span>

                {/* Value / placeholder */}
                <span className={`flex-1 truncate ${value ? "text-black/85 dark:text-white/90 font-aumovio-bold" : "text-grey-400"}`}>{value ? format(value, "MMMM dd, yyyy") : placeholder}</span>

                {/* Clear button — only when a value is selected */}
                {value && !disabled && (
                    <span role="button" tabIndex={0} onClick={handleClear} onKeyDown={(e) => e.key === "Enter" && handleClear(e)} className="shrink-0 p-0.5 rounded-md text-grey-400 hover:text-danger-400 hover:bg-danger-400/10 transition-colors duration-150" aria-label="Clear date">
                        <XMarkIcon className="w-3.5 h-3.5" />
                    </span>
                )}
            </button>

            {/* Error message */}
            {error && (
                <p className="mt-1.5 text-xs text-danger-400 font-aumovio flex items-center gap-1">
                    <span className="inline-block w-1 h-1 rounded-full bg-danger-400 shrink-0" />
                    {error}
                </p>
            )}

            {/* Calendar dropdown — rendered via portal to escape modal overflow clipping */}
            {open &&
                createPortal(
                    <div ref={dropdownRef} style={{ position: "fixed", top: dropdownPos.top, left: dropdownPos.left }} className={["z-9999 w-70", "bg-(--bg-surface) dark:bg-(--bg-surface-2)", "border border-(--color-card-surface-border) dark:border-grey-700/60", "rounded-2xl shadow-2xl shadow-black/15 dark:shadow-black/40", "overflow-hidden animate-scale-in"].join(" ")}>
                        {/* ── Month/Year header ── */}
                        <div className="px-4 pt-4 pb-3 bg-linear-to-br from-orange-400/8 via-orange-400/5 to-purple-400/5 dark:from-orange-400/12 dark:via-orange-400/6 dark:to-purple-400/8 border-b border-grey-200/60 dark:border-grey-700/50">
                            <div className="flex items-center justify-between">
                                <button onClick={() => setViewDate(subMonths(viewDate, 1))} className="p-1.5 rounded-lg text-grey-500 dark:text-grey-400 hover:text-(--accent-foreground) hover:bg-orange-400/10 dark:hover:bg-orange-400/15 transition-all duration-150 active:scale-90" aria-label="Previous month">
                                    <ChevronLeftIcon className="w-4 h-4" />
                                </button>

                                <div className="text-center">
                                    <p className="text-sm font-aumovio-bold text-black/85 dark:text-white/90 leading-none">{format(viewDate, "MMMM")}</p>
                                    <p className="text-xs text-(--accent-foreground) font-aumovio-bold mt-0.5 leading-none">{format(viewDate, "yyyy")}</p>
                                </div>

                                <button onClick={() => setViewDate(addMonths(viewDate, 1))} className="p-1.5 rounded-lg text-grey-500 dark:text-grey-400 hover:text-(--accent-foreground) hover:bg-orange-400/10 dark:hover:bg-orange-400/15 transition-all duration-150 active:scale-90" aria-label="Next month">
                                    <ChevronRightIcon className="w-4 h-4" />
                                </button>
                            </div>
                        </div>

                        <div className="px-3 pt-3 pb-2">
                            {/* Day-of-week labels */}
                            <div className="grid grid-cols-7 mb-1">
                                {DAYS.map((d) => (
                                    <span key={d} className="py-1 text-[10px] text-center font-aumovio-bold tracking-widest text-grey-400 dark:text-grey-500 uppercase">
                                        {d}
                                    </span>
                                ))}
                            </div>

                            {/* Day cells */}
                            <div className="grid grid-cols-7 gap-0.5">
                                {days.map((day, i) => {
                                    const outside = !isSameMonth(day, viewDate);
                                    const selected = value && isSameDay(day, value);
                                    const today = isToday(day);
                                    const dis = isDisabled(day);

                                    return (
                                        <button
                                            key={i}
                                            onClick={() => {
                                                if (!dis) {
                                                    onChange?.(day);
                                                    setOpen(false);
                                                }
                                            }}
                                            disabled={dis}
                                            aria-label={format(day, "MMMM d, yyyy")}
                                            aria-pressed={!!selected}
                                            className={[
                                                "relative h-8 w-8 mx-auto flex items-center justify-center rounded-lg text-xs transition-all duration-150",
                                                selected ? "bg-linear-to-br from-orange-400 to-orange-500 text-(--text-on-accent) font-aumovio-bold shadow-md shadow-orange-400/40 scale-105" : today ? "text-(--accent-foreground) font-aumovio-bold bg-orange-400/10 dark:bg-orange-400/15 ring-1 ring-orange-400/40" : outside ? "text-grey-300 dark:text-grey-600" : "text-black/75 dark:text-white/75",
                                                !selected && !dis && !outside ? "hover:bg-orange-400/10 dark:hover:bg-orange-400/15 hover:text-(--accent-foreground) hover:scale-105" : "",
                                                dis ? "opacity-25 cursor-not-allowed" : "cursor-pointer",
                                            ].join(" ")}
                                        >
                                            {format(day, "d")}
                                            {/* Dot indicator for today when not selected */}
                                            {today && !selected && <span className="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-orange-400" />}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>

                        {/* Footer actions */}
                        <div className="px-4 py-2.5 flex items-center justify-between border-t border-grey-100/80 dark:border-grey-700/50 bg-grey-50/50 dark:bg-white/2">
                            <button
                                onClick={() => {
                                    onChange?.(null);
                                    setOpen(false);
                                }}
                                className="text-xs text-grey-400 hover:text-danger-400 font-aumovio transition-colors duration-150"
                            >
                                Clear
                            </button>
                            <button
                                onClick={() => {
                                    const now = new Date();
                                    onChange?.(now);
                                    setViewDate(now);
                                    setOpen(false);
                                }}
                                className="text-xs text-(--accent-foreground) hover:opacity-70 font-aumovio-bold transition-opacity duration-150"
                            >
                                Today
                            </button>
                        </div>
                    </div>,
                    document.body,
                )}
        </div>
    );
}

export default Datepicker;
