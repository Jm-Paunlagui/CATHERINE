/**
 * Timepicker — Clock time selection.
 *
 * Props:
 *   value      — "HH:MM" string
 *   onChange   — (time: string) => void
 *   label, error, disabled, size
 *   use12Hour  — boolean
 *   minuteStep — 1|5|10|15|30
 */
import { ClockIcon } from "@heroicons/react/24/outline";
import { useEffect, useRef, useState } from "react";

export function Timepicker({ value = "", onChange, label, error, disabled = false, size = "md", use12Hour = false, minuteStep = 5 }) {
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
            {label && <label className="block text-xs font-aumovio-bold text-black/70 dark:text-white/70 mb-1.5">{label}</label>}
            <button
                type="button"
                disabled={disabled}
                onClick={() => setOpen((o) => !o)}
                className={`w-full flex items-center gap-2 px-3 py-2 rounded-xl border text-sm text-left
          bg-white dark:bg-(--bg-surface-2) text-black/80 dark:text-white/80 transition-all duration-200
          ${open ? "border-orange-400 ring-2 ring-orange-400/30" : "border-grey-300 dark:border-grey-700"}
          ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
            >
                <ClockIcon className="w-4 h-4 text-grey-400" />
                <span className={value ? "" : "text-grey-400"}>{value || "Select time"}</span>
            </button>
            {open && (
                <div
                    className="absolute top-full left-0 mt-2 z-50 bg-white dark:bg-(--bg-surface-2)
          border border-grey-200 dark:border-grey-700 rounded-xl shadow-2xl overflow-hidden animate-scale-in"
                >
                    <div className="flex">
                        {/* Hours */}
                        <div className="flex flex-col w-16 h-48 overflow-y-auto border-r border-grey-100 dark:border-grey-700">
                            {hours.map((hv) => (
                                <button
                                    key={hv}
                                    onClick={() => emit(hv, m, ampm)}
                                    className={`px-3 py-2 text-sm text-center hover:bg-orange-50 dark:hover:bg-orange-400/10
                    hover:text-orange-400 transition-colors
                    ${hv === h ? "bg-orange-400 text-white font-aumovio-bold" : "text-black/70 dark:text-white/70"}`}
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
                                    onClick={() => emit(h, mv, ampm)}
                                    className={`px-3 py-2 text-sm text-center hover:bg-orange-50 dark:hover:bg-orange-400/10
                    hover:text-orange-400 transition-colors
                    ${mv === m ? "bg-orange-400 text-white font-aumovio-bold" : "text-black/70 dark:text-white/70"}`}
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
                                        onClick={() => emit(h, m, ap)}
                                        className={`px-3 py-3 text-sm font-aumovio-bold text-center hover:bg-orange-50
                      dark:hover:bg-orange-400/10 hover:text-orange-400 transition-colors
                      ${ap === ampm ? "text-orange-400" : "text-grey-500"}`}
                                    >
                                        {ap}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            )}
            {error && <p className="mt-1.5 text-xs text-danger-400 font-aumovio-bold">{error}</p>}
        </div>
    );
}

export default Timepicker;
