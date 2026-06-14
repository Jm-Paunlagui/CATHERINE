/**
 * Input — Text input with label, helper, error, icons.
 *
 * Props:
 *   label, name, type, value, onChange, placeholder
 *   error       — string
 *   helper      — string
 *   leftIcon    — icon component
 *   rightElement — ReactNode (custom right slot)
 *   disabled, required, autoComplete
 *   size        — 'sm'|'md'|'lg'
 *   variant     — 'default'|'filled'|'underline'
 */

import { TRANSITION_COLORS } from "../../assets/styles/pre-set-styles";

const SZ = {
    sm: "px-3 py-1.5 text-xs rounded-lg",
    md: "px-3.5 py-2 text-sm rounded-lg",
    lg: "px-4 py-3 text-base rounded-xl",
};

export function Input({ label, name, type = "text", value, onChange, placeholder, error, helper, leftIcon: LeftIcon, rightElement, disabled = false, required = false, autoComplete, size = "md", id }) {
    const inputId = id ?? name;

    return (
        <div className="w-full font-aumovio">
            {label && (
                <label htmlFor={inputId} className="block text-xs font-aumovio-bold text-black/70 dark:text-white/70 mb-1.5">
                    {label}
                    {required && <span className="text-danger-400 ml-0.5">*</span>}
                </label>
            )}
            <div className="relative">
                {LeftIcon && (
                    <span className="absolute -translate-y-1/2 pointer-events-none left-3 top-1/2 text-grey-400">
                        <LeftIcon className="w-4 h-4" />
                    </span>
                )}
                <input
                    id={inputId}
                    name={name}
                    type={type}
                    value={value}
                    onChange={onChange}
                    placeholder={placeholder}
                    disabled={disabled}
                    required={required}
                    autoComplete={autoComplete}
                    className={`w-full bg-white dark:bg-(--bg-surface-2) font-aumovio
            text-black/85 dark:text-(--text-primary)
            border ${TRANSITION_COLORS} 
            placeholder-grey-400 dark:placeholder-grey-600
            focus:outline-none focus:ring-2 focus:shadow-md
            disabled:opacity-50 disabled:cursor-not-allowed
            ${LeftIcon ? "pl-9" : ""} ${rightElement ? "pr-10" : ""}
            ${SZ[size] ?? SZ.md}
            ${error ? "border-danger-400 focus:ring-danger-400/30 focus:border-danger-400 bg-danger-100/10" : "border-grey-300 dark:border-grey-700 focus:ring-orange-400/30 focus:border-orange-400"}`}
                />
                {rightElement && <span className="absolute -translate-y-1/2 right-3 top-1/2">{rightElement}</span>}
            </div>
            {error && <p className="mt-1.5 text-xs text-danger-400 font-aumovio-bold">{error}</p>}
            {!error && helper && <p className="mt-1.5 text-xs text-grey-400">{helper}</p>}
        </div>
    );
}

export default Input;
