/**
 * Radio — Radio button group.
 *
 * Props:
 *   name, options: [{ value, label, description?, disabled? }]
 *   value, onChange, label, error, disabled
 *   variant — 'default'|'card'|'button-group'
 *   orientation — 'vertical'|'horizontal'
 */
import { TRANSITION_COLORS } from "../../assets/styles/pre-set-styles";

export function Radio({ name, options = [], value, onChange, label: groupLabel, error, disabled = false, variant = "default", orientation = "vertical" }) {
    if (variant === "button-group")
        return (
            <div className="font-aumovio">
                {groupLabel && <p className="text-xs font-aumovio-bold text-black/70 dark:text-white/70 mb-1.5">{groupLabel}</p>}
                <div className="inline-flex overflow-hidden border divide-x border-grey-200 dark:border-grey-700 rounded-xl divide-grey-200 dark:divide-grey-700">
                    {options.map((opt) => (
                        <label
                            key={opt.value}
                            className={`px-4 py-2 text-sm font-aumovio-bold cursor-pointer ${TRANSITION_COLORS}
              ${opt.disabled || disabled ? "opacity-40 cursor-not-allowed" : ""}
              ${value === opt.value ? "bg-orange-400 text-white" : "bg-(--bg-surface) dark:bg-(--bg-surface-2) text-grey-600 dark:text-grey-300 hover:bg-orange-50 dark:hover:bg-orange-400/10 hover:text-orange-400"}`}
                        >
                            <input type="radio" name={name} value={opt.value} checked={value === opt.value} onChange={() => !opt.disabled && !disabled && onChange?.(opt.value)} disabled={opt.disabled || disabled} className="sr-only" />
                            {opt.label}
                        </label>
                    ))}
                </div>
            </div>
        );

    return (
        <fieldset className="font-aumovio">
            {groupLabel && <legend className="mb-2 text-xs font-aumovio-bold text-black/70 dark:text-white/70">{groupLabel}</legend>}
            <div className={`flex gap-3 ${orientation === "horizontal" ? "flex-row flex-wrap" : "flex-col"}`}>
                {options.map((opt) => (
                    <label
                        key={opt.value}
                        className={`flex items-start gap-2.5 cursor-pointer
              ${
                  variant === "card"
                      ? `p-4 rounded-xl border ${TRANSITION_COLORS}
                ${value === opt.value ? "border-orange-400 bg-orange-50 dark:bg-orange-400/5" : "border-grey-200 dark:border-grey-700 hover:border-orange-300"}`
                      : ""
              }
              ${opt.disabled || disabled ? "opacity-50 cursor-not-allowed" : ""}`}
                    >
                        <div className="relative shrink-0 mt-0.5">
                            <input type="radio" name={name} value={opt.value} checked={value === opt.value} onChange={() => !opt.disabled && !disabled && onChange?.(opt.value)} disabled={opt.disabled || disabled} className="sr-only" />
                            <div
                                className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${TRANSITION_COLORS}
                ${value === opt.value ? "border-orange-400 bg-orange-400" : "border-grey-300 dark:border-grey-600 hover:border-orange-400 bg-white dark:bg-(--bg-surface-3)"}`}
                            >
                                {value === opt.value && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                            </div>
                        </div>
                        <div>
                            <p className={`text-sm font-aumovio ${value === opt.value ? "text-orange-400 font-aumovio-bold" : "text-black/80 dark:text-white/80"}`}>{opt.label}</p>
                            {opt.description && <p className="text-xs text-grey-400 mt-0.5">{opt.description}</p>}
                        </div>
                    </label>
                ))}
            </div>
            {error && <p className="mt-1.5 text-xs text-danger-400 font-aumovio-bold">{error}</p>}
        </fieldset>
    );
}

export default Radio;
