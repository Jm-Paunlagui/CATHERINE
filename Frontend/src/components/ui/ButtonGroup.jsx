/**
 * ButtonGroup — Attached row of buttons.
 *
 * Props:
 *   items     — [{ id, label, icon?, disabled? }]
 *   active    — id of active item
 *   onChange  — (id) => void
 *   variant   — 'primary' | 'ghost'
 *   size      — 'xs' | 'sm' | 'md' | 'lg'
 *   orientation — 'horizontal' | 'vertical'
 */
import { TRANSITION_COLORS } from "../../assets/styles/pre-set-styles";
const SZ = {
    xs: "px-2 py-1 text-[10px]",
    sm: "px-3 py-2 text-xs",
    md: "px-4 py-2 text-sm",
    lg: "px-5 py-3 text-sm",
};

// Icon size follows the button size. `xs` (compact inline toggles — e.g. the
// Transaction History header's view toggle) gets a smaller icon so it
// doesn't overpower the shrunken label text. Every other size keeps the
// ORIGINAL hardcoded `w-4 h-4` exactly as before this change (falls through
// to DEFAULT_ICON_SZ below) — additive, no existing caller shifts.
const ICON_SZ = {
    xs: "w-3 h-3",
};
const DEFAULT_ICON_SZ = "w-4 h-4";

export function ButtonGroup({ items = [], active, onChange, variant = "primary", size = "md", orientation = "horizontal" }) {
    const isH = orientation === "horizontal";
    const isGhost = variant === "ghost";

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
                // `ghost` swaps the solid orange-fill active state for the subtle
                // accent-tint treatment already used by Tabs.jsx's "boxed" variant
                // (bg-(--accent-subtle) + text-(--accent-foreground)) instead of
                // an opaque bg-(--bg-surface) — matches the ghost convention in
                // Button.jsx (transparent, bordered container carries the shape).
                const activeClass = isGhost ? "bg-(--accent-subtle) text-(--accent-foreground)" : "bg-orange-400 text-(--on-accent-text)";
                const inactiveClass = isGhost
                    ? "bg-transparent text-grey-600 dark:text-grey-300 hover:bg-(--accent-subtle) hover:text-(--accent-foreground)"
                    : "bg-(--bg-surface) dark:bg-(--bg-surface-2) text-grey-600 dark:text-grey-300 hover:bg-orange-50 dark:hover:bg-orange-400/10 hover:text-(--accent-foreground)";
                return (
                    <button
                        key={item.id}
                        onClick={() => !item.disabled && onChange?.(item.id)}
                        disabled={item.disabled}
                        className={`flex items-center gap-2 tracking-wide ${TRANSITION_COLORS}
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400/50
              disabled:opacity-50 disabled:cursor-not-allowed
              ${SZ[size] ?? SZ.md}
              ${isActive ? activeClass : inactiveClass}`}
                    >
                        {item.icon && <item.icon className={`${ICON_SZ[size] ?? DEFAULT_ICON_SZ} shrink-0`} />}
                        {item.label}
                    </button>
                );
            })}
        </div>
    );
}

export default ButtonGroup;
