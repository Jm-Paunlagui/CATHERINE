/**
 * Avatar — USER profile image or initials fallback.
 *
 * Props:
 *   src               — image URL
 *   name              — full name (used for initials fallback)
 *   size              — 'xs'|'sm'|'md'|'lg'|'xl'|'2xl'
 *   shape             — 'circle' | 'rounded'
 *   status            — 'online'|'offline'|'busy'|'away' (plain presence dot, bottom-right)
 *   indicator         — { icon, label, tone?, pulse? } overlay badge (see below)
 *   indicatorPosition — 'bottom-left'|'bottom-right'|'top-left'|'top-right' (default 'bottom-left')
 *   bordered          — boolean
 *   stacked           — boolean (for Avatar.Group)
 *
 * `status` vs `indicator` — they are NOT the same control and both may be shown:
 *   `status`    is a bare presence dot with no icon and no label. It stays at
 *               bottom-right, where it has always been.
 *   `indicator` is an icon badge that carries MEANING. It defaults to
 *               bottom-left so it cannot collide with `status`, and it REQUIRES
 *               a `label` — see the accessibility note on INDICATOR_TONE.
 */
import { HOVER_SCALE } from "../../assets/styles/pre-set-styles";

const SIZES = {
    xs: { wrap: "w-6 h-6", text: "text-xs", dot: "w-1.5 h-1.5", badge: "w-3 h-3 text-[6px]", ring: "ring-1" },
    sm: { wrap: "w-8 h-8", text: "text-xs", dot: "w-2 h-2", badge: "w-3.5 h-3.5 text-[7px]", ring: "ring-2" },
    md: { wrap: "w-10 h-10", text: "text-sm", dot: "w-2.5 h-2.5", badge: "w-4 h-4 text-[8px]", ring: "ring-2" },
    lg: { wrap: "w-12 h-12", text: "text-base", dot: "w-3 h-3", badge: "w-5 h-5 text-[10px]", ring: "ring-2" },
    xl: { wrap: "w-16 h-16", text: "text-lg", dot: "w-3.5 h-3.5", badge: "w-6 h-6 text-[11px]", ring: "ring-2" },
    "2xl": { wrap: "w-20 h-20", text: "text-xl", dot: "w-4 h-4", badge: "w-7 h-7 text-[13px]", ring: "ring-[3px]" },
};

const STATUS_DOT = {
    online: "bg-[var(--status-success-base)] ring-2 ring-white dark:ring-[var(--surface-1)]",
    offline: "bg-[var(--status-neutral-base)] ring-2 ring-white dark:ring-[var(--surface-1)]",
    busy: "bg-[var(--status-danger-base)] ring-2 ring-white dark:ring-[var(--surface-1)]",
    away: "bg-[var(--status-warning-base)] ring-2 ring-white dark:ring-[var(--surface-1)]",
};

/**
 * Indicator badge fills, keyed by tone.
 *
 * THEME AWARENESS is not a `dark:` variant here on purpose. Every
 * `--status-*-base` token is redefined inside the dark block of
 * `assets/styles/index.css` (e.g. danger #ef4444 → #f87171), so one reference
 * resolves to the correct hue in both themes and the two can never drift apart
 * the way a hand-paired `bg-red-500 dark:bg-red-400` does.
 *
 * These are the FIXED semantic statuses — they are deliberately NOT
 * palette-adaptive. An indicator's whole job is to mean one specific thing, and
 * that meaning must not change hue because the user picked a new accent in
 * Personalize. `accent` is the one palette-following tone, for badges that mark
 * identity rather than status.
 *
 * Foreground is a binary white/black chosen per fill, not `text-white`
 * everywhere: `warning` is a light amber, on which white text fails contrast.
 *
 * ACCESSIBILITY — the badge is never colour-only. `indicator.label` is required
 * and is rendered as the badge's `aria-label`, so a red circle that means
 * "wallet not seeded" is announced as those words. WCAG 1.4.1 (Use of Colour):
 * a colour difference on its own is not an accessible way to convey meaning,
 * and this badge is small enough that hue is easy to miss even sighted.
 */
const INDICATOR_TONE = {
    success: "bg-[var(--status-success-base)] text-white",
    danger: "bg-[var(--status-danger-base)] text-white",
    warning: "bg-[var(--status-warning-base)] text-black",
    info: "bg-[var(--status-info-base)] text-white",
    neutral: "bg-[var(--status-neutral-base)] text-white",
    accent: "bg-(--accent) text-(--on-accent-text)",
};

/**
 * Badge corner offsets.
 *
 * Negative insets on both axes so the badge straddles the avatar's edge rather
 * than sitting inside it — an inset badge eats the initials, which are the
 * avatar's only content when there is no image.
 */
const INDICATOR_POS = {
    "bottom-left": "-bottom-0.5 -left-0.5",
    "bottom-right": "-bottom-0.5 -right-0.5",
    "top-left": "-top-0.5 -left-0.5",
    "top-right": "-top-0.5 -right-0.5",
};

// Deterministic colour from name — all entries use palette-responsive CSS variable
// families (orange, purple, blue, turquoise, yellow) so they shift when the user
// picks a different accent palette in Personalize. Each entry pairs a solid family
// fill with that family's binary white/black `--on-<fam>-text` foreground token
// (Personalize round 4) so initials stay readable on every palette's fill colour.
const PALETTE = ["bg-orange-400 text-(--on-accent-text)", "bg-purple-400 text-(--on-secondary-text)", "bg-blue-400 text-(--on-blue-text)", "bg-turquoise-500 text-(--on-turquoise-text)", "bg-yellow-600 text-(--on-yellow-text)", "bg-orange-600 text-(--on-accent-text)", "bg-purple-600 text-(--on-secondary-text)"];

function getInitials(name = "") {
    const parts = name.trim().split(" ").filter(Boolean);
    if (!parts.length) return "?";
    return parts.length === 1 ? parts[0].slice(0, 2).toUpperCase() : (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function getColor(name = "") {
    const sum = [...name].reduce((acc, c) => acc + c.charCodeAt(0), 0);
    return PALETTE[sum % PALETTE.length];
}

/**
 * @param {object} props
 * @param {string} [props.src]
 * @param {string} [props.name]
 * @param {"xs"|"sm"|"md"|"lg"|"xl"|"2xl"} [props.size]
 * @param {"circle"|"rounded"} [props.shape]
 * @param {"online"|"offline"|"busy"|"away"} [props.status]
 * @param {{ icon?: import('react').ReactNode, label: string, tone?: keyof typeof INDICATOR_TONE, pulse?: boolean }} [props.indicator]
 *        Overlay badge. `label` is REQUIRED and becomes the badge's aria-label —
 *        a bare coloured circle conveys nothing to a screen reader and fails
 *        WCAG 1.4.1. `icon` is a ReactNode rather than an icon definition so
 *        Avatar stays free of any icon-library import and callers can pass
 *        FontAwesome, react-icons, or an inline svg.
 * @param {"bottom-left"|"bottom-right"|"top-left"|"top-right"} [props.indicatorPosition]
 * @param {boolean} [props.bordered]
 * @param {boolean} [props.stacked]
 */
export function Avatar({ src, name = "", size = "md", shape = "circle", status, indicator, indicatorPosition = "bottom-left", bordered = false, stacked = false }) {
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

            {/* Indicator badge. The ring is painted in the SURFACE colour, not a
                border colour: it carves a gap between badge and avatar so the
                badge reads as a separate object rather than a coloured bite out
                of the avatar. `--bg-surface-2` is redefined per theme, so this
                stays correct in dark mode without a `dark:` pair.

                `aria-hidden` on the icon: the badge itself already carries the
                aria-label, and letting a decorative glyph announce alongside it
                would double up the same information. */}
            {indicator?.label && (
                <span
                    role="img"
                    aria-label={indicator.label}
                    title={indicator.label}
                    className={`absolute ${INDICATOR_POS[indicatorPosition] ?? INDICATOR_POS["bottom-left"]} z-10
            flex items-center justify-center rounded-full leading-none
            ${sz.badge} ${sz.ring} ring-white dark:ring-(--bg-surface-2)
            ${INDICATOR_TONE[indicator.tone] ?? INDICATOR_TONE.neutral}
            ${indicator.pulse ? "animate-pulse" : ""}`}
                >
                    {/* Icon sizing is owned HERE, not by the caller.
                        The wrapper is a full-size flex box (not a bare inline
                        span) for two reasons, both of which were visibly wrong
                        before: an inline span puts the svg on the TEXT BASELINE,
                        which pushes the glyph down off centre; and a percentage
                        size on the svg has no definite box to resolve against
                        inside an auto-sized inline box, so it also drifted
                        horizontally.

                        `[&_svg]` sizes whatever the caller passed — FontAwesome,
                        heroicons, or a bare <svg> — so no call site can get the
                        centring wrong, and none of them needs to know the badge
                        diameter. 58% leaves a visible ring of fill around the
                        glyph at every avatar size. */}
                    {indicator.icon ? (
                        <span aria-hidden="true" className="flex items-center justify-center w-full h-full [&_svg]:w-[58%] [&_svg]:h-[58%]">
                            {indicator.icon}
                        </span>
                    ) : null}
                </span>
            )}
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
