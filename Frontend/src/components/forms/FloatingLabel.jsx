/**
 * FloatingLabel — Input with animated floating label.
 *
 * Props:
 *   label, name, type, value, onChange, error, disabled, required, size
 */
import { FIELD_BORDER, FIELD_BORDER_ERROR, FIELD_FOCUS, FIELD_FOCUS_ERROR, TRANSITION_COLORS, TRANSITION_SMOOTH } from "../../assets/styles/pre-set-styles";
export function FloatingLabel({ label, name, type = "text", value = "", onChange, error, disabled = false, required = false, id }) {
    const inputId = id ?? name;
    const filled = value !== "" && value !== null && value !== undefined;

    return (
        <div className="relative font-aumovio">
            <input
                id={inputId}
                name={name}
                type={type}
                value={value}
                onChange={onChange}
                disabled={disabled}
                required={required}
                placeholder=" "
                className={`peer w-full px-4 pt-5 pb-2 text-sm rounded-xl border
          bg-white dark:bg-(--bg-surface-2) text-black/85 dark:text-(--text-primary)
          ${TRANSITION_COLORS}
          disabled:opacity-50 disabled:cursor-not-allowed placeholder-transparent
          ${error ? `${FIELD_BORDER_ERROR} ${FIELD_FOCUS_ERROR}` : `${FIELD_BORDER} ${FIELD_FOCUS}`}`}
            />
            <label
                htmlFor={inputId}
                className={`absolute left-3.5 ${TRANSITION_SMOOTH} pointer-events-none font-aumovio
          peer-placeholder-shown:top-3.5 peer-placeholder-shown:text-sm peer-placeholder-shown:text-grey-400
          peer-focus:top-1.5 peer-focus:text-xs peer-focus:text-(--accent-foreground) peer-focus:font-aumovio-bold
          ${filled ? "top-1.5 text-xs text-grey-500 dark:text-grey-400 font-aumovio-bold" : "top-3.5 text-sm text-grey-400"}`}
            >
                {label}
                {required && <span className="text-danger-400 ml-0.5">*</span>}
            </label>
            {error && <p className="mt-2 text-xs text-danger-400 font-aumovio-bold">{error}</p>}
        </div>
    );
}

export default FloatingLabel;
