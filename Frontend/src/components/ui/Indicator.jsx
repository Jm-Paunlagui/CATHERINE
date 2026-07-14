/**
 * Indicator — Overlay badge on a UI element (notification dot, count, status).
 *
 * Props:
 *   children  — the element to wrap
 *   content   — string | number (shown in badge; omit for dot-only)
 *   color     — 'orange'|'danger'|'success'|'warn'|'purple'|'blue'|'grey'
 *   position  — 'top-right'|'top-left'|'bottom-right'|'bottom-left'
 *   pulse     — boolean
 *   max       — number (99+ truncation)
 *   hidden    — boolean
 */
import { TRANSITION_COLORS } from "../../assets/styles/pre-set-styles";
const COLORS = {
    orange: "bg-orange-400 text-(--on-accent-text) dark:bg-orange-400 dark:text-(--on-accent-text)",
    danger: "bg-danger-400 text-white dark:bg-danger-400 dark:text-white",
    success: "bg-success-400 text-white dark:bg-success-400 dark:text-white",
    warn: "bg-warn-400 text-black dark:bg-warn-400 dark:text-grey-900",
    purple: "bg-purple-400 text-(--on-secondary-text) dark:bg-purple-300 dark:text-grey-900", // dark mode already uses fixed purple-300/grey-900 pair (not palette-adaptive), left as-is
    blue: "bg-blue-400 text-(--on-blue-text) dark:bg-blue-400 dark:text-(--on-blue-text)",
    grey: "bg-grey-400 text-white dark:bg-grey-500 dark:text-white",
};

const POS = {
    "top-right": "-top-1 -right-1",
    "top-left": "-top-1 -left-1",
    "bottom-right": "-bottom-1 -right-1",
    "bottom-left": "-bottom-1 -left-1",
};

export function Indicator({ children, content, color = "danger", position = "top-right", pulse = false, max = 99, hidden = false }) {
    const display = typeof content === "number" && content > max ? `${max}+` : content;
    const hasContent = display !== undefined && display !== null && display !== "";

    return (
        <div className="relative inline-flex">
            {children}
            {!hidden && (
                <span
                    className={`absolute ${POS[position]} z-10 flex items-center justify-center
          font-aumovio-bold tracking-wide
          ${TRANSITION_COLORS}
          ${hasContent ? "min-w-5 h-5 px-1 text-[10px] rounded-full" : "w-2.5 h-2.5 rounded-full"}
          ${COLORS[color] ?? COLORS.danger}
          ${pulse ? "animate-pulse" : ""}`}
                >
                    {hasContent ? display : null}
                </span>
            )}
        </div>
    );
}

export default Indicator;
