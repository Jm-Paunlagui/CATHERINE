/**
 * Progress — Linear or circular progress indicator.
 *
 * Props:
 *   value     — 0-100
 *   max       — number (default 100)
 *   variant   — 'primary'|'success'|'danger'|'warning'|'gradient'
 *   size      — 'xs'|'sm'|'md'|'lg'
 *   label     — boolean (show percentage)
 *   animated  — boolean (striped animation)
 *   circular  — boolean (ring variant)
 *   radius    — number (for circular, default 36)
 */
import { TRANSITION_LAZY } from "../../assets/styles/pre-set-styles";

const COLORS = {
    primary: "bg-orange-400",
    success: "bg-success-400",
    danger: "bg-danger-400",
    warning: "bg-warn-400",
    gradient: "bg-linear-to-r from-orange-400 to-purple-400",
    purple: "bg-purple-400",
};

const HEIGHTS = { xs: "h-1", sm: "h-1.5", md: "h-2.5", lg: "h-4" };

export function Progress({ value = 0, max = 100, variant = "primary", size = "md", label = false, animated = false, circular = false, radius = 36 }) {
    const pct = Math.min(100, Math.max(0, (value / max) * 100));

    if (circular) {
        const circ = 2 * Math.PI * radius;
        const dash = circ - (pct / 100) * circ;
        const sz = radius * 2 + 20;
        return (
            <div className="relative inline-flex items-center justify-center font-aumovio">
                <svg width={sz} height={sz} className="-rotate-90">
                    <circle cx={sz / 2} cy={sz / 2} r={radius} fill="none" stroke="var(--ring-track)" strokeWidth="8" />
                    <circle cx={sz / 2} cy={sz / 2} r={radius} fill="none" stroke="#FF4208" strokeWidth="8" strokeDasharray={circ} strokeDashoffset={dash} strokeLinecap="round" style={{ transition: `stroke-dashoffset var(--duration-lazy) var(--ease-decelerate)` }} />
                </svg>
                <span className="absolute text-sm font-aumovio-bold text-black/85 dark:text-white/90">{Math.round(pct)}%</span>
            </div>
        );
    }

    return (
        <div className="w-full font-aumovio">
            {label && (
                <div className="flex justify-between mb-1">
                    <span className="text-xs text-grey-500 dark:text-grey-400">Progress</span>
                    <span className="text-xs font-aumovio-bold text-black/70 dark:text-white/70">{Math.round(pct)}%</span>
                </div>
            )}
            <div className={`w-full bg-grey-200 dark:bg-(--bg-surface-3) rounded-full overflow-hidden ${HEIGHTS[size] ?? HEIGHTS.md}`}>
                <div
                    className={`h-full rounded-full ${COLORS[variant] ?? COLORS.primary}
            ${TRANSITION_LAZY}
            ${animated ? "bg-stripes animate-stripes" : ""}`}
                    style={{ width: `${pct}%` }}
                    role="progressbar"
                    aria-valuenow={value}
                    aria-valuemax={max}
                />
            </div>
        </div>
    );
}

export default Progress;
