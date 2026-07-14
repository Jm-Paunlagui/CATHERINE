/**
 * ButtonGroup — Attached row of buttons.
 *
 * Props:
 *   items     — [{ id, label, icon?, disabled? }]
 *   active    — id of active item
 *   onChange  — (id) => void
 *   variant   — 'primary' | 'ghost'
 *   size      — 'sm' | 'md' | 'lg'
 *   orientation — 'horizontal' | 'vertical'
 */
import { TRANSITION_COLORS } from "../../assets/styles/pre-set-styles";
const SZ = {
    sm: "px-3 py-1.5 text-xs",
    md: "px-4 py-2 text-sm",
    lg: "px-5 py-2.5 text-sm",
};

export function ButtonGroup({ items = [], active, onChange, variant = "primary", size = "md", orientation = "horizontal" }) {
    const isH = orientation === "horizontal";

    return (
        <div
            role="group"
            className={`inline-flex font-aumovio-bold
        ${isH ? "flex-row" : "flex-col"}
        ${isH ? "divide-x" : "divide-y"}
        divide-grey-200 dark:divide-grey-700
        border border-grey-200 dark:border-grey-700
        ${isH ? "rounded-lg overflow-hidden" : "rounded-lg overflow-hidden"}`}
        >
            {items.map((item) => {
                const isActive = item.id === active;
                return (
                    <button
                        key={item.id}
                        onClick={() => !item.disabled && onChange?.(item.id)}
                        disabled={item.disabled}
                        className={`flex items-center gap-2 tracking-wide ${TRANSITION_COLORS}
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400/50
              disabled:opacity-50 disabled:cursor-not-allowed
              ${SZ[size] ?? SZ.md}
              ${isActive ? "bg-orange-400 text-(--on-accent-text)" : "bg-(--bg-surface) dark:bg-(--bg-surface-2) text-grey-600 dark:text-grey-300 hover:bg-orange-50 dark:hover:bg-orange-400/10 hover:text-(--accent-foreground)"}`}
                    >
                        {item.icon && <item.icon className="w-4 h-4 shrink-0" />}
                        {item.label}
                    </button>
                );
            })}
        </div>
    );
}

export default ButtonGroup;
