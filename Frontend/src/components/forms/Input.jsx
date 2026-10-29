/**
 * Input — Text input with label, helper, error, icons.
 *
 * Props:
 *   label, name, type, value, onChange, placeholder
 *   error       — string
 *   helper      — string
 *   leftIcon    — icon component
 *   rightElement — ReactNode (custom right slot). When type="password" and a
 *                  rightElement is given, the caller owns the right slot and the
 *                  built-in show/hide toggle is not rendered.
 *   disabled, required, autoComplete
 *   size        — 'sm'|'md'|'lg'
 *   variant     — 'default'|'filled'|'underline'
 */

import { useState } from "react";
import { EyeIcon, EyeSlashIcon } from "@heroicons/react/24/outline";
import { FIELD_BORDER, FIELD_BORDER_ERROR, FIELD_FOCUS, FIELD_FOCUS_ERROR, TRANSITION_COLORS } from "../../assets/styles/pre-set-styles";

const TOGGLE_CLS = `absolute -translate-y-1/2 right-2 top-1/2 p-1 rounded-md
    text-(--accent-icon) hover:bg-black/5 dark:hover:bg-white/10
    ${TRANSITION_COLORS}
    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--field-focus-border)
    disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent`;

const NUMBER_CLS = "[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none";

const SZ = {
    sm: "px-3 py-2 text-xs rounded-lg",
    md: "px-4 py-2 text-sm rounded-lg",
    lg: "px-4 py-3 text-base rounded-xl",
};

export function Input({ label, name, type = "text", value, onChange, placeholder, error, helper, leftIcon: LeftIcon, rightElement, disabled = false, required = false, autoComplete, size = "md", id, ...rest }) {
    const inputId = id ?? name;
    const isPassword = type === "password" && !rightElement;
    const [revealed, setRevealed] = useState(false);
    const effectiveType = isPassword && revealed ? "text" : type;
    const hasRight = isPassword || Boolean(rightElement);

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
                    {...rest}
                    id={inputId}
                    name={name}
                    type={effectiveType}
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
            disabled:opacity-50 disabled:cursor-not-allowed
            ${LeftIcon ? "pl-9" : ""} ${hasRight ? "pr-10" : ""} ${type === "number" ? NUMBER_CLS : ""}
            ${SZ[size] ?? SZ.md}
            ${error ? `${FIELD_BORDER_ERROR} ${FIELD_FOCUS_ERROR} bg-danger-100/10` : `${FIELD_BORDER} ${FIELD_FOCUS}`}`}
                />
                {isPassword ? (
                    <button type="button" onClick={() => setRevealed((r) => !r)} disabled={disabled} aria-label={revealed ? "Hide password" : "Show password"} aria-pressed={revealed} className={TOGGLE_CLS}>
                        {revealed ? <EyeSlashIcon className="w-4 h-4" aria-hidden="true" /> : <EyeIcon className="w-4 h-4" aria-hidden="true" />}
                    </button>
                ) : (
                    rightElement && <span className="absolute -translate-y-1/2 right-3 top-1/2">{rightElement}</span>
                )}
            </div>
            {error && <p className="mt-2 text-xs text-danger-400 font-aumovio-bold">{error}</p>}
            {!error && helper && <p className="mt-2 text-xs text-grey-400">{helper}</p>}
        </div>
    );
}

export default Input;
