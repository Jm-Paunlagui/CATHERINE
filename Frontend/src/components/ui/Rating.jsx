/**
 * Rating — Star rating input or display.
 *
 * Props:
 *   value     — number (0-max)
 *   max       — number (default 5)
 *   onChange  — (val: number) => void (if omitted = read-only)
 *   size      — 'sm'|'md'|'lg'
 *   color     — 'orange'|'yellow'|'purple'
 *   half      — boolean (allow 0.5 steps)
 *   showValue — boolean
 */
import { useState } from "react";
import { TRANSITION_COLORS, TRANSITION_SNAP } from "../../assets/styles/pre-set-styles";

const COLORS = {
    orange: "text-(--accent-icon)",
    yellow: "text-(--yellow-foreground)",
    purple: "text-(--secondary-foreground)",
};
const SZ = { sm: "w-4 h-4", md: "w-5 h-5", lg: "w-7 h-7" };

export function Rating({ value = 0, max = 5, onChange, size = "md", color = "orange", showValue = false }) {
    const [hover, setHover] = useState(null);
    const readOnly = !onChange;
    const display = hover ?? value;
    const sz = SZ[size] ?? SZ.md;
    const col = COLORS[color] ?? COLORS.orange;

    return (
        <div className="inline-flex items-center gap-0.5 font-aumovio">
            {Array.from({ length: max }, (_, i) => i + 1).map((star) => (
                <button key={star} type="button" disabled={readOnly} onClick={() => onChange?.(star)} onMouseEnter={() => !readOnly && setHover(star)} onMouseLeave={() => !readOnly && setHover(null)} className={`${TRANSITION_SNAP} ${readOnly ? "cursor-default" : "cursor-pointer hover:scale-110"}`} aria-label={`${star} star${star !== 1 ? "s" : ""}`}>
                    <svg className={`${sz} ${TRANSITION_COLORS} ${display >= star ? col : "text-grey-200 dark:text-grey-600"}`} viewBox="0 0 20 20" fill="currentColor">
                        <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                    </svg>
                </button>
            ))}
            {showValue && <span className="ml-1.5 text-sm font-aumovio-bold text-black/60 dark:text-white/60">{value.toFixed(1)}</span>}
        </div>
    );
}

export default Rating;
