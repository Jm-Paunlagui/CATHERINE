/**
 * Avatar — USER profile image or initials fallback.
 *
 * Props:
 *   src       — image URL
 *   name      — full name (used for initials fallback)
 *   size      — 'xs'|'sm'|'md'|'lg'|'xl'|'2xl'
 *   shape     — 'circle' | 'rounded'
 *   status    — 'online'|'offline'|'busy'|'away' (indicator dot)
 *   bordered  — boolean
 *   stacked   — boolean (for Avatar.Group)
 */
import { HOVER_SCALE } from "../../assets/styles/pre-set-styles";

const SIZES = {
    xs: { wrap: "w-6 h-6", text: "text-xs", dot: "w-1.5 h-1.5" },
    sm: { wrap: "w-8 h-8", text: "text-xs", dot: "w-2 h-2" },
    md: { wrap: "w-10 h-10", text: "text-sm", dot: "w-2.5 h-2.5" },
    lg: { wrap: "w-12 h-12", text: "text-base", dot: "w-3 h-3" },
    xl: { wrap: "w-16 h-16", text: "text-lg", dot: "w-3.5 h-3.5" },
    "2xl": { wrap: "w-20 h-20", text: "text-xl", dot: "w-4 h-4" },
};

const STATUS_DOT = {
    online: "bg-[var(--status-success-base)] ring-2 ring-white dark:ring-[var(--surface-1)]",
    offline: "bg-[var(--status-neutral-base)] ring-2 ring-white dark:ring-[var(--surface-1)]",
    busy: "bg-[var(--status-danger-base)] ring-2 ring-white dark:ring-[var(--surface-1)]",
    away: "bg-[var(--status-warning-base)] ring-2 ring-white dark:ring-[var(--surface-1)]",
};

// Deterministic colour from name — all entries use palette-responsive CSS variable
// families (orange, purple, blue, turquoise, yellow) so they shift when the user
// picks a different accent palette in Personalize.
const PALETTE = ["bg-orange-400 text-white", "bg-purple-400 text-white", "bg-blue-400 text-white", "bg-turquoise-500 text-white", "bg-yellow-600 text-white", "bg-orange-600 text-white", "bg-purple-600 text-white"];

function getInitials(name = "") {
    const parts = name.trim().split(" ").filter(Boolean);
    if (!parts.length) return "?";
    return parts.length === 1 ? parts[0].slice(0, 2).toUpperCase() : (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function getColor(name = "") {
    const sum = [...name].reduce((acc, c) => acc + c.charCodeAt(0), 0);
    return PALETTE[sum % PALETTE.length];
}

export function Avatar({ src, name = "", size = "md", shape = "circle", status, bordered = false, stacked = false }) {
    const sz = SIZES[size] ?? SIZES.md;
    const initials = getInitials(name);
    const color = getColor(name);
    const radius = shape === "circle" ? "rounded-full" : "rounded-lg";

    return (
        <div className={`relative inline-flex shrink-0 ${sz.wrap} ${stacked ? "-ml-3 first:ml-0" : HOVER_SCALE}`}>
            {src ? (
                <img
                    src={src}
                    alt={name || "Avatar"}
                    className={`${sz.wrap} ${radius} object-cover
            ${bordered ? "ring-2 ring-white dark:ring-(--bg-surface-2)" : ""}`}
                />
            ) : (
                <span
                    className={`flex items-center justify-center w-full h-full font-aumovio-bold
          ${radius} ${color} ${sz.text}
          ${bordered ? "ring-2 ring-white dark:ring-(--bg-surface-2)" : ""}`}
                >
                    {initials}
                </span>
            )}
            {status && <span className={`absolute bottom-0 right-0 ${sz.dot} rounded-full ${STATUS_DOT[status]}`} />}
        </div>
    );
}

/**
 * AvatarGroup — Stacked row of avatars with overflow count.
 * Props: avatars[], max, size, shape
 */
export function AvatarGroup({ avatars = [], max = 4, size = "md", shape = "circle" }) {
    const visible = avatars.slice(0, max);
    const overflow = avatars.length - max;
    const sz = SIZES[size] ?? SIZES.md;

    return (
        <div className="flex items-center">
            {visible.map((a, i) => (
                <Avatar key={i} {...a} size={size} shape={shape} stacked bordered />
            ))}
            {overflow > 0 && (
                <span
                    className={`-ml-3 flex items-center justify-center ${sz.wrap}
          rounded-full bg-grey-200 dark:bg-(--bg-surface-3) text-grey-600 dark:text-grey-300
          font-aumovio-bold ${sz.text} ring-2 ring-white dark:ring-(--bg-surface-2)`}
                >
                    +{overflow}
                </span>
            )}
        </div>
    );
}

export default Avatar;
