/**
 * Skeleton — Loading placeholder.
 *
 * Props:
 *   variant  — 'text'|'rect'|'circle'|'card'|'table'|'list'
 *   width    — string (CSS, default '100%')
 *   height   — string (CSS, default auto)
 *   lines    — number (for text variant)
 *   count    — number (repeat)
 *   animate  — boolean
 */
import { SKELETON_SURFACE } from "../../assets/styles/pre-set-styles";
const base = `${SKELETON_SURFACE} rounded`;

function SkeletonLine({ w = "100%", h = "0.875rem" }) {
    return <div className={base} style={{ width: w, height: h }} />;
}

export function Skeleton({ variant = "text", width = "100%", height, lines = 3, count = 1, animate = true }) {
    const pulse = animate ? "" : "!animate-none";

    if (variant === "circle") return <div className={`${base} ${pulse} rounded-full`} style={{ width: width, height: width }} />;

    if (variant === "text")
        return (
            <div className="space-y-2" style={{ width }}>
                {Array.from({ length: lines }, (_, i) => (
                    <SkeletonLine key={i} w={i === lines - 1 && lines > 1 ? "70%" : "100%"} />
                ))}
            </div>
        );

    if (variant === "card")
        return (
            <div className="bg-(--bg-surface) dark:bg-(--bg-surface-2) border border-grey-200 dark:border-grey-700 rounded-xl overflow-hidden p-5 space-y-4" style={{ width }}>
                <div className={`${base} ${pulse} h-36 rounded-lg`} />
                <SkeletonLine w="60%" h="1.125rem" />
                <SkeletonLine />
                <SkeletonLine w="80%" />
            </div>
        );

    if (variant === "list")
        return (
            <div className="space-y-3" style={{ width }}>
                {Array.from({ length: lines }, (_, i) => (
                    <div key={i} className="flex items-center gap-3">
                        <div className={`${base} ${pulse} rounded-full shrink-0`} style={{ width: 36, height: 36 }} />
                        <div className="flex-1 space-y-1.5">
                            <SkeletonLine w="50%" />
                            <SkeletonLine w="80%" h="0.75rem" />
                        </div>
                    </div>
                ))}
            </div>
        );

    if (variant === "table")
        return (
            <div className="space-y-2" style={{ width }}>
                <div className="flex gap-4">
                    {[3, 5, 5, 3].map((w, i) => (
                        <SkeletonLine key={i} w={`${w}rem`} h="1rem" />
                    ))}
                </div>
                {Array.from({ length: lines }, (_, i) => (
                    <div key={i} className="flex gap-4">
                        {[3, 5, 5, 3].map((w, j) => (
                            <SkeletonLine key={j} w={`${w}rem`} />
                        ))}
                    </div>
                ))}
            </div>
        );

    return <div className={`${base} ${pulse}`} style={{ width, height: height ?? "1rem" }} />;
}

export default Skeleton;
