/**
 * Checkbox — Styled checkbox input.
 *
 * Props:
 *   id, name, label, checked, onChange, disabled, indeterminate
 *   description — helper text beneath label
 *   variant — 'default'|'card'
 *   error
 */
import { CheckIcon, MinusIcon } from "@heroicons/react/24/outline";
import { useEffect, useRef } from "react";
import { TRANSITION_COLORS } from "../../assets/styles/pre-set-styles";

export function Checkbox({ id, name, label, checked = false, onChange, disabled = false, indeterminate = false, description, variant = "default", error }) {
    const ref = useRef(null);
    useEffect(() => {
        if (ref.current) ref.current.indeterminate = indeterminate;
    }, [indeterminate]);

    const inputEl = (
        <div className="relative w-4 h-4 shrink-0">
            <input ref={ref} type="checkbox" id={id ?? name} name={name} checked={checked} onChange={onChange} disabled={disabled} className="sr-only peer" />
            <div
                className={`w-4 h-4 rounded border-2 ${TRANSITION_COLORS} flex items-center justify-center
        ${checked || indeterminate ? "bg-orange-400 border-orange-400" : "bg-white dark:bg-(--bg-surface-3) border-grey-300 dark:border-grey-600 peer-hover:border-orange-400"}
        ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}
        ${error ? "border-danger-400" : ""}`}
            >
                {checked && !indeterminate && <CheckIcon className="w-3 h-3 text-white" strokeWidth={3} />}
                {indeterminate && <MinusIcon className="w-3 h-3 text-white" strokeWidth={3} />}
            </div>
        </div>
    );

    if (variant === "card")
        return (
            <label
                className={`flex items-start gap-3 p-4 rounded-xl border cursor-pointer
      ${TRANSITION_COLORS} font-aumovio
      ${checked ? "border-orange-400 bg-orange-50 dark:bg-orange-400/5" : "border-grey-200 dark:border-grey-700 bg-white dark:bg-(--bg-surface-2) hover:border-orange-300"}
      ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
            >
                {inputEl}
                <div>
                    <p className={`text-sm font-aumovio-bold ${checked ? "text-(--accent-foreground)" : "text-black/85 dark:text-white/85"}`}>{label}</p>
                    {description && <p className="text-xs text-grey-400 mt-0.5">{description}</p>}
                </div>
            </label>
        );

    return (
        <div className="font-aumovio">
            <label
                className={`flex items-start gap-2.5 cursor-pointer
        ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
            >
                {inputEl}
                {label && (
                    <div>
                        <span className="text-sm text-black/80 dark:text-white/80 font-aumovio">{label}</span>
                        {description && <p className="text-xs text-grey-400 mt-0.5">{description}</p>}
                    </div>
                )}
            </label>
            {error && <p className="mt-1 text-xs text-danger-400 font-aumovio-bold">{error}</p>}
        </div>
    );
}

export default Checkbox;
