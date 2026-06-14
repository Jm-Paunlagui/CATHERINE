/**
 * Textarea — Multi-line text input with auto-resize and char count.
 *
 * Props:
 *   label, name, value, onChange, placeholder, rows, maxLength
 *   error, helper, disabled, required, resize, showCount, size
 */
import { useEffect, useRef } from "react";
import { TRANSITION_COLORS } from "../../assets/styles/pre-set-styles";

export function Textarea({ label, name, value = "", onChange, placeholder, rows = 4, maxLength, error, helper, disabled = false, required = false, resize = "vertical", showCount = false, size = "md", id }) {
    const inputId = id ?? name;
    const ref = useRef(null);
    const SZ = {
        sm: "px-3 py-2 text-xs",
        md: "px-3.5 py-2.5 text-sm",
        lg: "px-4 py-3 text-base",
    };
    const RESIZE = {
        none: "resize-none",
        vertical: "resize-y",
        horizontal: "resize-x",
        both: "resize",
    };

    useEffect(() => {
        if (ref.current && resize === "auto") {
            ref.current.style.height = "auto";
            ref.current.style.height = ref.current.scrollHeight + "px";
        }
    }, [value, resize]);

    return (
        <div className="font-aumovio">
            {label && (
                <label htmlFor={inputId} className="block text-xs font-aumovio-bold text-black/70 dark:text-white/70 mb-1.5">
                    {label}
                    {required && <span className="text-danger-400 ml-0.5">*</span>}
                </label>
            )}
            <textarea
                ref={ref}
                id={inputId}
                name={name}
                value={value}
                rows={rows}
                onChange={onChange}
                placeholder={placeholder}
                disabled={disabled}
                required={required}
                maxLength={maxLength}
                className={`w-full rounded-xl border font-aumovio leading-relaxed
          bg-white dark:bg-(--bg-surface-2) text-black/85 dark:text-white/85
          placeholder-grey-400 dark:placeholder-grey-600
          focus:outline-none focus:ring-2 focus:shadow-md ${TRANSITION_COLORS}
          disabled:opacity-50 disabled:cursor-not-allowed
          ${RESIZE[resize] ?? RESIZE.vertical}
          ${SZ[size] ?? SZ.md}
          ${error ? "border-danger-400 focus:ring-danger-400/30" : "border-grey-300 dark:border-grey-700 focus:ring-orange-400/30 focus:border-orange-400"}`}
            />
            <div className="flex justify-between mt-1.5">
                {error ? <p className="text-xs text-danger-400 font-aumovio-bold">{error}</p> : <p className="text-xs text-grey-400">{helper}</p>}
                {showCount && maxLength && (
                    <span className={`text-xs font-aumovio-bold ${value.length >= maxLength ? "text-danger-400" : "text-grey-400"}`}>
                        {value.length}/{maxLength}
                    </span>
                )}
            </div>
        </div>
    );
}

export default Textarea;
