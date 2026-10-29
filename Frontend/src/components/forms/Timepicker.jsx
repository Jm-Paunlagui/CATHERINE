/**
 * Timepicker — Clock time selection.
 *
 * Props:
 *   value      — "HH:MM" string
 *   onChange   — (time: string) => void
 *   label, error, disabled, size
 *   use12Hour  — boolean
 *   minuteStep — 1|5|10|15|30
 *   id         — optional trigger id; falls back to useId(). Wires the label
 *                (htmlFor / aria-labelledby), value and error (aria-describedby)
 *                to the trigger button (WCAG 1.3.1 / 4.1.2).
 */
import { ClockIcon } from "@heroicons/react/24/outline";
import { useEffect, useId, useRef, useState } from "react";
import { FIELD_BORDER, FIELD_BORDER_ERROR, FIELD_FOCUS_VISIBLE, FIELD_OPEN, FIELD_OPEN_ERROR } from "../../assets/styles/pre-set-styles";

// Matches the SZ scale used by Input.jsx / SearchInput.jsx / ButtonGroup.jsx
// so a Timepicker dropped next to those components lines up visually.
const SZ = {
    sm: "px-3 py-2 text-xs rounded-lg",
    md: "px-3 py-2 text-sm rounded-xl",
    lg: "px-4 py-3 text-base rounded-xl",
};

export function Timepicker({ value = "", onChange, label, error, disabled = false, size = "md", use12Hour = false, minuteStep = 5, id }) {
    const autoId = useId();
    const triggerId = id ?? autoId;
    const labelId = `${triggerId}-label`;
    const valueId = `${triggerId}-value`;
    const errorId = `${triggerId}-error`;
    const popupId = `${triggerId}-popup`;
    const [open, setOpen] = useState(false);
    const [h, m, ampm] = (() => {
        const [hh = "12", mm = "00"] = (value || "").split(":");
        const hn = parseInt(hh);
        if (use12Hour) return [hn > 12 ? hn - 12 : hn || 12, mm, hn >= 12 ? "PM" : "AM"];
        return [hn, mm, null];
    })();
    const ref = useRef(null);

    useEffect(() => {
        const handler = (e) => {
            if (!ref.current?.contains(e.target)) setOpen(false);
        };
        document.addEventListener("mousedown", handler);
        return () => document.removeEventListener("mousedown", handler);
    }, []);

    const emit = (newH, newM, newAmpm) => {
        let hour = newH;
        if (use12Hour) {
            if (newAmpm === "PM" && hour < 12) hour += 12;
            if (newAmpm === "AM" && hour === 12) hour = 0;
        }
        onChange?.(`${String(hour).padStart(2, "0")}:${newM}`);
    };

    const hours = Array.from({ length: use12Hour ? 12 : 24 }, (_, i) => (use12Hour ? i + 1 : i));
    const minutes = Array.from({ length: Math.floor(60 / minuteStep) }, (_, i) => String(i * minuteStep).padStart(2, "0"));

    return (
        <div ref={ref} className="relative w-full font-aumovio">
            {label && (
                <label id={labelId} htmlFor={triggerId} className="block text-xs font-aumovio-bold text-black/70 dark:text-white/70 mb-1.5">
                    {label}
                </label>
            )}
            <button
                type="button"
                id={triggerId}
                aria-labelledby={label ? `${labelId} ${valueId}` : undefined}
                aria-haspopup="dialog"
                aria-controls={open ? popupId : undefined}
                aria-expanded={open}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
                disabled={disabled}
                onClick={() => setOpen((o) => !o)}
                className={`w-full flex items-center gap-2 border text-left
          bg-white dark:bg-(--bg-surface-2) text-black/80 dark:text-white/80 transition-all duration-200
          ${SZ[size] ?? SZ.md}
          ${FIELD_FOCUS_VISIBLE} ${open ? (error ? FIELD_OPEN_ERROR : FIELD_OPEN) : error ? FIELD_BORDER_ERROR : FIELD_BORDER}
          ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
            >
                <ClockIcon className="w-4 h-4 text-grey-400" />
                <span id={valueId} className={value ? "" : "text-grey-400"}>
                    {value || "Select time"}
                </span>
            </button>
            {open && (
                <div
                    id={popupId}
                    role="dialog"
                    aria-labelledby={label ? labelId : undefined}
                    className="absolute top-full left-0 mt-2 z-50 bg-white dark:bg-(--bg-surface-2)
          border border-grey-200 dark:border-grey-700 rounded-xl shadow-2xl overflow-hidden animate-scale-in"
                >
                    <div className="flex">
                        {/* Hours */}
                        <div className="flex flex-col w-16 h-48 overflow-y-auto border-r border-grey-100 dark:border-grey-700">
                            {hours.map((hv) => (
                                <button
                                    key={hv}
                                    type="button"
                                    onClick={() => emit(hv, m, ampm)}
                                    className={`px-3 py-2 text-sm text-center hover:bg-orange-50 dark:hover:bg-orange-400/10
                    hover:text-(--accent-foreground) transition-colors
                    ${hv === h ? "bg-orange-400 text-(--on-accent-text) font-aumovio-bold" : "text-black/70 dark:text-white/70"}`}
                                >
                                    {String(hv).padStart(2, "0")}
                                </button>
                            ))}
                        </div>
                        {/* Minutes */}
                        <div className="flex flex-col w-16 h-48 overflow-y-auto">
                            {minutes.map((mv) => (
                                <button
                                    key={mv}
                                    type="button"
                                    onClick={() => emit(h, mv, ampm)}
                                    className={`px-3 py-2 text-sm text-center hover:bg-orange-50 dark:hover:bg-orange-400/10
                    hover:text-(--accent-foreground) transition-colors
                    ${mv === m ? "bg-orange-400 text-(--on-accent-text) font-aumovio-bold" : "text-black/70 dark:text-white/70"}`}
                                >
                                    {mv}
                                </button>
                            ))}
                        </div>
                        {/* AM/PM */}
                        {use12Hour && (
                            <div className="flex flex-col justify-center h-48 border-l border-grey-100 dark:border-grey-700 w-14">
                                {["AM", "PM"].map((ap) => (
                                    <button
                                        key={ap}
                                        type="button"
                                        onClick={() => emit(h, m, ap)}
                                        className={`px-3 py-3 text-sm font-aumovio-bold text-center hover:bg-orange-50
                      dark:hover:bg-orange-400/10 hover:text-(--accent-foreground) transition-colors
                      ${ap === ampm ? "text-(--accent-foreground)" : "text-grey-500"}`}
                                    >
                                        {ap}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            )}
            {error && (
                <p id={errorId} className="mt-2 text-xs text-danger-400 font-aumovio-bold">
                    {error}
                </p>
            )}
        </div>
    );
}

export default Timepicker;
