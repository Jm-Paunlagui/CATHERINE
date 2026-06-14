/**
 * Toggle — Accessible on/off switch.
 *
 * Props:
 *   checked, onChange, label, description, disabled
 *   size     — 'sm'|'md'|'lg'
 *   color    — 'accent'|'orange'|'success'|'purple'|'danger'
 *   labelPosition — 'right'|'left'
 */
import { TRANSITION_COLORS, TRANSITION_TRANSFORM_SPRING } from "../../assets/styles/pre-set-styles";

const SIZES = {
    sm: { track: "w-8 h-4", thumb: "w-3 h-3", translate: "translate-x-4" },
    md: { track: "w-11 h-6", thumb: "w-4 h-4", translate: "translate-x-5" },
    lg: { track: "w-14 h-7", thumb: "w-5 h-5", translate: "translate-x-7" },
};

const COLORS = {
    accent: "bg-(--accent)",
    orange: "bg-orange-400",
    success: "bg-success-400",
    purple: "bg-purple-400",
    danger: "bg-danger-400",
};

export function Toggle({ checked = false, onChange, label, description, disabled = false, size = "md", color = "orange", labelPosition = "right" }) {
    const sz = SIZES[size] ?? SIZES.md;
    const col = COLORS[color] ?? COLORS.orange;

    const track = (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            onClick={() => !disabled && onChange?.(!checked)}
            disabled={disabled}
            className={`relative inline-flex items-center rounded-full shrink-0
        ${TRANSITION_COLORS} focus-visible:outline-none
        focus-visible:ring-2 focus-visible:ring-(--accent)/50 focus-visible:ring-offset-2
        ${sz.track}
        ${checked ? col : "bg-grey-300 dark:bg-grey-600"}
        ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
        >
            <span
                className={`${sz.thumb} inline-block bg-white rounded-full shadow-sm
        transform ${TRANSITION_TRANSFORM_SPRING} mx-0.5
        ${checked ? sz.translate : "translate-x-0"}`}
            />
        </button>
    );

    if (!label) return track;

    return (
        <label
            className={`flex items-center gap-3 cursor-pointer font-aumovio
      ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
        >
            {labelPosition === "left" && (
                <div>
                    <span className="text-sm text-black/80 dark:text-white/80 font-aumovio">{label}</span>
                    {description && <p className="text-xs text-grey-400">{description}</p>}
                </div>
            )}
            {track}
            {labelPosition === "right" && (
                <div>
                    <span className="text-sm text-black/80 dark:text-white/80 font-aumovio">{label}</span>
                    {description && <p className="text-xs text-grey-400">{description}</p>}
                </div>
            )}
        </label>
    );
}

export default Toggle;
