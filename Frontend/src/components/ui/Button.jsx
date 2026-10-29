/**
 * Button — Polymorphic button component.
 *
 * Props:
 *   variant  — 'primary'|'accent'|'danger'|'warning'|'ghost'|'outline'|'link'|'gradient'
 *   size     — 'xs'|'sm'|'md'|'lg'|'xl'
 *   loading  — boolean
 *   disabled — boolean
 *   fullWidth — boolean
 *   leftIcon  — icon COMPONENT (e.g. `leftIcon={ArrowDownTrayIcon}`), rendered with a w-4 h-4 class
 *   rightIcon — icon COMPONENT, same contract
 *   icon      — icon ELEMENT (e.g. `icon={<FontAwesomeIcon icon={faCheck} />}`), rendered as-is on the left
 *   rounded  — boolean (pill shape)
 *   onClick, type, className, children
 *   ...rest  — any other prop (aria-*, title, data-*, etc.) is forwarded onto the rendered <button>
 *
 * WHY BOTH `leftIcon` AND `icon`: the two icon systems in this codebase have
 * incompatible call shapes. Heroicons are passed as bare components and need a
 * size class applied by the button (`leftIcon`). FontAwesome is used via
 * `<FontAwesomeIcon icon={…} />`, which is already an element and already
 * sized, so it cannot go through `leftIcon` — `<LeftIcon />` on an element
 * throws. Callers reached for the natural `icon={<FontAwesomeIcon …/>}`, which
 * this component did not accept: it fell into `...rest`, React stringified it
 * onto the DOM as `icon="[object Object]"`, and no icon rendered at all. Eight
 * call sites were silently iconless. Accepting the element form is the smaller,
 * safer fix — the alternative was rewriting those sites to a render-prop shape
 * FontAwesome does not naturally produce.
 */
import { BTN_ACCENT, BTN_BUSY, BTN_DANGER, BTN_DISABLED, BTN_DISABLED_SOLID, BTN_FOCUS, BTN_GRADIENT, BTN_LINK, BTN_MOTION, BTN_NEUTRAL, BTN_OUTLINE, BTN_PRIMARY, BTN_SUCCESS, BTN_WARNING, RIPPLE_HOST, TRANSITION_BUTTON } from "../../assets/styles/pre-set-styles";

// Every colour / border / focus / disabled decision lives in the BTN_* constants
// (token-driven, WCAG 1.4.3 + 1.4.11, border lightness follows the THEME).
const BASE = ["inline-flex items-center justify-center gap-2 font-aumovio-bold tracking-wide", TRANSITION_BUTTON, BTN_MOTION, "backface-hidden border", BTN_FOCUS].join(" ");

const VARIANTS = {
    primary: BTN_PRIMARY,
    accent: BTN_ACCENT,
    danger: BTN_DANGER,
    // Mirrors `danger` in the success family. Added because 11 call sites across
    // 8 files were already passing variant="success" for the affirmative half of
    // an approve/reject pair — and silently getting the orange `primary` fallback.
    success: BTN_SUCCESS,
    warning: BTN_WARNING,
    ghost: BTN_NEUTRAL,
    outline: BTN_OUTLINE,
    link: BTN_LINK,
    gradient: BTN_GRADIENT,
};

// Variants whose fill is a solid gradient: a faded (opacity-only) disabled state would
// leave a white label on a white surface, so they get a flat grey disabled look instead.
const SOLID_VARIANTS = new Set(["gradient"]);

// `warn` is an accepted alias for `warning` — the same failure the `success`
// variant above was added to fix, one variant over. The tokens `warning` is built
// from are all named warn-*, so variant="warn" is the natural slip, and the
// `?? VARIANTS.primary` fallback makes it silent: a secondary warning action
// would otherwise render as the page's primary CTA.
VARIANTS.warn = VARIANTS.warning;
// `secondary` is an alias of the neutral (ghost) look.
VARIANTS.secondary = VARIANTS.ghost;

const SIZES = {
    xs: "px-3 py-1    text-xs rounded-md",
    sm: "px-3   py-2  text-xs rounded-lg",
    md: "px-4   py-2    text-sm rounded-lg",
    lg: "px-5   py-3  text-base rounded-lg",
    xl: "px-7   py-3.5  text-base rounded-xl",
};

export default function Button({ variant = "primary", size = "md", loading = false, disabled = false, fullWidth = false, leftIcon: LeftIcon, rightIcon: RightIcon, icon, rounded = false, onClick, type = "button", className = "", children, ...rest }) {
    const handleClick = (e) => {
        onClick?.(e);
        const btn = e.currentTarget;
        const circle = document.createElement("span");
        const diameter = Math.max(btn.clientWidth, btn.clientHeight);
        const radius = diameter / 2;
        const rect = btn.getBoundingClientRect();
        circle.style.cssText = `width:${diameter}px;height:${diameter}px;left:${e.clientX - rect.left - radius}px;top:${e.clientY - rect.top - radius}px`;
        circle.classList.add("ripple");
        btn.querySelector(".ripple")?.remove();
        btn.appendChild(circle);
    };

    // Loading keeps full colour (spinner + aria-busy + progress cursor) so it never
    // reads as disabled; only an explicit `disabled` prop gets the disabled look.
    // The native attribute is still set while loading so the click cannot re-fire.
    const key = VARIANTS[variant] ? variant : "primary";
    const stateClass = disabled ? (SOLID_VARIANTS.has(key) ? BTN_DISABLED_SOLID : BTN_DISABLED) : loading ? BTN_BUSY : "";

    return (
        <button
            type={type}
            onClick={handleClick}
            disabled={disabled || loading}
            aria-busy={loading || undefined}
            className={`${BASE} ${RIPPLE_HOST} ${VARIANTS[key]} ${stateClass}
        ${SIZES[size] ?? SIZES.md}
        ${fullWidth ? "w-full" : ""}
        ${rounded ? "rounded-full!" : ""}
        ${className}`}
            {...rest}
        >
            {loading ? <span className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin shrink-0" /> : (LeftIcon && <LeftIcon className="w-4 h-4 shrink-0" />) || icon}
            {children}
            {!loading && RightIcon && <RightIcon className="w-4 h-4 shrink-0" />}
        </button>
    );
}
