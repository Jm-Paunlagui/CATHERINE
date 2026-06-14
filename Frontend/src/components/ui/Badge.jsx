/**
 * Badge — Status pill / label.
 *
 * Props:
 *   variant  — 'green'|'red'|'warning'|'blue'|'purple'|'cyan'|'amber'|'grey'|'orange'
 *   size     — 'xs'|'sm'|'md'
 *   dot      — boolean (animated pulse dot)
 *   outline  — boolean (border-only style)
 *   removable — boolean (× button)
 *   onRemove — () => void
 *   pill     — boolean (rounded-full instead of rounded-lg)
 *   children
 */
const V = {
    green: {
        solid: "text-[var(--status-success-text)] bg-[var(--status-success-bg)] border border-[var(--status-success-base)]/20",
        outline: "text-[var(--status-success-text)] bg-transparent border border-[var(--status-success-base)]/50",
        dot: "bg-[var(--status-success-base)]",
    },
    red: {
        solid: "text-[var(--status-danger-text)] bg-[var(--status-danger-bg)] border border-[var(--status-danger-base)]/20",
        outline: "text-[var(--status-danger-text)] bg-transparent border border-[var(--status-danger-base)]/50",
        dot: "bg-[var(--status-danger-base)]",
    },
    warning: {
        solid: "text-[var(--status-warning-text)] bg-[var(--status-warning-bg)] border border-[var(--status-warning-base)]/20",
        outline: "text-[var(--status-warning-text)] bg-transparent border border-[var(--status-warning-base)]/50",
        dot: "bg-[var(--status-warning-base)]",
    },
    blue: {
        solid: "text-[var(--status-info-text)] bg-[var(--status-info-bg)] border border-[var(--status-info-base)]/20",
        outline: "text-[var(--status-info-text)] bg-transparent border border-[var(--status-info-base)]/50",
        dot: "bg-[var(--status-info-base)]",
    },
    purple: {
        solid: "text-purple-400 dark:text-purple-300 bg-purple-100/25 dark:bg-purple-400/15 border-purple-400/35 dark:border-purple-400/25",
        outline: "text-purple-400 dark:text-purple-300 border-purple-400 dark:border-purple-400/60 bg-transparent",
        dot: "bg-purple-400",
    },
    cyan: {
        solid: "text-turquoise-500 dark:text-turquoise-300 bg-turquoise-100/22 dark:bg-turquoise-400/15 border-turquoise-400/25 dark:border-turquoise-400/20",
        outline: "text-turquoise-500 dark:text-turquoise-300 border-turquoise-400 dark:border-turquoise-400/60 bg-transparent",
        dot: "bg-turquoise-400",
    },
    amber: {
        solid: "text-yellow-600 dark:text-warn-300 bg-yellow-100 dark:bg-yellow-400/15 border-yellow-400/30 dark:border-yellow-400/25",
        outline: "text-yellow-600 dark:text-warn-300 border-yellow-400 dark:border-yellow-400/60 bg-transparent",
        dot: "bg-yellow-400",
    },
    grey: {
        solid: "text-grey-500 dark:text-grey-300 bg-grey-100 dark:bg-(--bg-surface-3) border-grey-400/30 dark:border-grey-600/30",
        outline: "text-grey-500 dark:text-grey-300 border-grey-400 dark:border-grey-500 bg-transparent",
        dot: "bg-grey-400 dark:bg-grey-500",
    },
    orange: {
        solid: "text-orange-500 dark:text-orange-300 bg-orange-100/20 dark:bg-orange-400/15 border-orange-400/30 dark:border-orange-400/25",
        outline: "text-orange-500 dark:text-orange-300 border-orange-400 dark:border-orange-400/60 bg-transparent",
        dot: "bg-orange-400",
    },
};

const SZ = {
    xs: "px-1.5 py-0.5 text-xs gap-1",
    sm: "px-2   py-0.5 text-xs gap-1",
    md: "px-2.5 py-1   text-xs gap-1.5",
};

export function Badge({ variant = "grey", size = "md", dot = false, outline = false, removable = false, onRemove, pill = false, children }) {
    const cfg = V[variant] ?? V.grey;
    const style = outline ? cfg.outline : cfg.solid;

    return (
        <span
            className={`inline-flex items-center font-aumovio-bold tracking-wide
      border shadow-sm ${pill ? "rounded-full" : "rounded-lg"}
      ${style} ${SZ[size] ?? SZ.md}`}
        >
            {dot && <span className={`w-1.5 h-1.5 rounded-full shrink-0 animate-pulse ${cfg.dot}`} />}
            {children}
            {removable && (
                <button onClick={onRemove} aria-label="Remove" className="ml-0.5 hover:opacity-70">
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                        <path d="M8 2L2 8M2 2l6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                </button>
            )}
        </span>
    );
}

export default Badge;
