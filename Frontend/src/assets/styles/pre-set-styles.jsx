/**
 * pre-set-styles.jsx
 * ──────────────────
 * Centralised Tailwind class constants following the Aumovio brand guide.
 *
 * COLOR HIERARCHY
 * ───────────────
 * Primary   → orange-400  (#FF4208)   60 %
 * Secondary → purple-400  (#4827AF)   30 %
 * Accents   → blue / turquoise / yellow / grey  10 %
 * Validation → danger / warn / success
 *
 * All colour tokens map to the @theme tokens in index.css so they
 * are available as standard Tailwind utilities (e.g. bg-orange-400).
 *
 * ANIMATION SYSTEM
 * ────────────────
 * All animation/transition constants map directly to the keyframes,
 * utility classes, and CSS custom properties defined in index.css.
 *
 * Easing curve reference (CSS vars, use in inline styles or raw CSS):
 *   --ease-standard    cubic-bezier(0.4, 0, 0.2, 1)        Material smooth
 *   --ease-decelerate  cubic-bezier(0, 0, 0.2, 1)          Ease out
 *   --ease-accelerate  cubic-bezier(0.4, 0, 1, 1)          Ease in
 *   --ease-spring      cubic-bezier(0.34, 1.56, 0.64, 1)   Spring overshoot ← buttons
 *   --ease-spring-soft cubic-bezier(0.25, 1.4, 0.5, 1)     Gentle spring
 *   --ease-spring-hard cubic-bezier(0.5, 2.0, 0.6, 0.8)    Snappy spring
 *   --ease-bounce      cubic-bezier(0.68, -0.55, 0.265, 1.55) Hard bounce ← checkmarks
 *   --ease-bounce-out  cubic-bezier(0.34, 1.4, 0.64, 1)    Bounce settle
 *   --ease-snap        cubic-bezier(0.2, 0, 0, 1)          Instant snap ← dropdowns
 *   --ease-overshoot   cubic-bezier(0.3, 1.8, 0.4, 0.9)   Overshoot settle
 *
 * Duration token reference (CSS vars):
 *   --duration-instant   80ms     micro feedback (ripple)
 *   --duration-fast     150ms     tooltip, snap interactions
 *   --duration-normal   250ms     most UI transitions
 *   --duration-moderate 350ms     modals, drawers, slides
 *   --duration-slow     500ms     page transitions, hero
 *   --duration-lazy     700ms     ambient, decorative motion
 */

// ============================================================================
// BACKGROUNDS
// ============================================================================
export const BASE_COLOR_BG = "bg-(--bg-surface) bg-gradient-to-br from-[var(--bg-surface)] to-[var(--bg-surface-2)]";
export const MAIN_FOREGROUND_COLOR_BG = "bg-orange-400";
export const MAIN_STRONG_COLOR_BG = "bg-orange-400 shadow-lg shadow-orange-400/25";
export const MAIN_OVERLAY_COLOR_BG = "bg-[var(--surface-3)]/95 backdrop-blur-sm";
export const MAIN_PULSE_COLOR_BG = "bg-orange-400/15 animate-pulse";
export const GRADIENT_COLOR_BG = "bg-gradient-to-br from-orange-300 via-orange-400 to-purple-400 dark:from-orange-500 dark:via-orange-500 dark:to-purple-500";

// ============================================================================
// TEXT
// ============================================================================
export const TITLE_COLOR_TEXT = "text-(--text-primary) font-aumovio-bold tracking-tight";
export const SUBTITLE_COLOR_TEXT = "text-(--text-primary) font-aumovio";
export const BASE_COLOR_TEXT = "text-(--text-primary) font-normal leading-relaxed";
export const BASE_COLOR_TEXT_LIGHT = "text-white font-normal leading-relaxed drop-shadow-sm";
export const MAIN_COLOR_TEXT = "text-black/80 dark:text-(--text-primary) font-aumovio";
export const MAIN_FOREGROUND_COLOR_TEXT = "text-(--nav-active-text) font-aumovio";
export const MAIN_STRONG_COLOR_TEXT = "text-orange-400 drop-shadow-sm";
export const MAIN_OVERLAY_COLOR_TEXT = "text-white drop-shadow-md";
export const GRADIENT_COLOR_TEXT = "text-orange-400 dark:text-orange-300 font-aumovio-bold tracking-wide drop-shadow-sm";
export const SECONDARY_COLOR_TEXT = "text-white font-aumovio drop-shadow-sm";
export const ACCENT_COLOR_TEXT = "text-purple-400 font-aumovio-bold";
export const OPTIONS_COLOR_TEXT = "text-white font-aumovio";
export const WARNING_COLOR_TEXT = "text-danger-400 font-aumovio-bold";

// ============================================================================
// BACKGROUNDS (interactive)
// ============================================================================
export const MAIN_COLOR = "bg-orange-400 shadow-lg shadow-orange-400/20";
export const SECONDARY_COLOR = "bg-orange-400/8 dark:bg-orange-400/15 border border-orange-400/20";
export const ACCENT_COLOR = "bg-purple-400/8 dark:bg-purple-400/15 border border-purple-400/25 dark:border-purple-400/35";

// ============================================================================
// BORDERS
// ============================================================================
export const STANDARD_BORDER = "border border-grey-500/40 shadow-sm";
export const SECONDARY_COLOR_BORDER = "border border-purple-400/20 shadow-sm";
export const SECONDARY_BORDER = "border border-orange-400/25 shadow-sm";
export const ACCENT_COLOR_BORDER = "border border-orange-400/25 shadow-sm";

// ============================================================================
// TRANSITIONS — legacy aliases (kept for backward compatibility)
// ============================================================================
export const DELAY_1 = "transition-all duration-300 ease-out delay-75";
export const DELAY_3 = "transition-all duration-500 ease-out delay-150";

// ============================================================================
// ICON PLACEMENT
// ============================================================================
export const ICON_PLACE_SELF_CENTER = "pr-2 place-self-center drop-shadow-sm";
export const ICON_PLACE_SELF_CENTER_1 = "place-self-center drop-shadow-sm";

// ============================================================================
// FORM FIELDS
// ============================================================================
export const TEXT_FIELD = `w-full p-2 font-aumovio-bold tracking-wider rounded-lg shadow-sm
  bg-white/95 dark:bg-(--bg-surface-2) dark:text-(--text-primary) backdrop-blur-sm
  focus:outline-none focus:ring-2 focus:ring-orange-400/40
  focus:border-orange-400/50 focus:shadow-md focus:shadow-orange-400/10
  transition-all duration-300`;

// ============================================================================
// DEFAULT BUTTON BASE
// ============================================================================
export const DEFAULT_BUTTON_TRANSITION = `border border-transparent rounded-lg
  hover:-translate-y-1 hover:scale-[1.02] active:scale-[0.98]
  hover:shadow-lg transition-button`;

// ============================================================================
// BUTTON VARIANTS
// ============================================================================

/** Primary orange button */
export const MAIN_BUTTON = `font-aumovio-bold tracking-wide
  text-orange-400 bg-orange-400/10 dark:bg-orange-400/20 border border-orange-400/25 dark:border-orange-400/40
  hover:bg-orange-400 hover:text-white hover:border-transparent
  hover:shadow-xl hover:shadow-orange-400/30 dark:hover:shadow-orange-400/50
  ${DEFAULT_BUTTON_TRANSITION}`;

/** Secondary purple button */
export const ACCENT_BUTTON = `font-aumovio-bold tracking-wide
  text-purple-400 bg-purple-400/10 dark:bg-purple-400/20 border border-purple-400/20 dark:border-purple-400/35
  hover:bg-purple-400 hover:text-white hover:border-transparent
  hover:shadow-xl hover:shadow-purple-400/30 dark:hover:shadow-purple-400/50
  ${DEFAULT_BUTTON_TRANSITION}`;

/** Danger / destructive button */
export const DANGER_BUTTON = `font-aumovio-bold tracking-wide
  text-danger-400 bg-danger-100 dark:bg-danger-400/15 border border-danger-400/20 dark:border-danger-400/35
  hover:bg-danger-400 hover:text-white hover:border-transparent
  hover:shadow-xl hover:shadow-danger-400/30 dark:hover:shadow-danger-400/50
  ${DEFAULT_BUTTON_TRANSITION}`;

/** Ghost / options button */
export const OPTIONS_BUTTON = `font-aumovio-bold tracking-wide
  text-black/80 dark:text-white/80 bg-orange-400/8 dark:bg-orange-400/15 border border-orange-400/20
  hover:bg-orange-400 hover:text-white hover:border-transparent
  hover:shadow-xl hover:shadow-orange-400/30
  ${DEFAULT_BUTTON_TRANSITION}`;

/** Warning button */
export const WARNING_BUTTON = `font-aumovio-bold tracking-wide
  text-warn-400 bg-warn-100/20 dark:bg-warn-400/15 border border-warn-400/30
  hover:bg-warn-400 hover:text-black hover:border-transparent
  hover:shadow-xl hover:shadow-warn-400/30 dark:hover:shadow-warn-400/50
  ${DEFAULT_BUTTON_TRANSITION}`;

export const DEFAULT_BUTTON = `font-aumovio-bold tracking-wide text-white drop-shadow-sm ${DEFAULT_BUTTON_TRANSITION}`;
export const CONTRAST = `font-aumovio-bold tracking-wide text-orange-400 drop-shadow-sm ${DEFAULT_BUTTON_TRANSITION}`;

// ============================================================================
// STATUS BADGES
// ============================================================================
export const STATUS_GREEN = "font-aumovio-bold tracking-wide text-[var(--status-success-text)] bg-[var(--status-success-bg)] border border-[var(--status-success-base)]/20 rounded-lg shadow-sm";
export const STATUS_RED = "font-aumovio-bold tracking-wide text-[var(--status-danger-text)] bg-[var(--status-danger-bg)] border border-[var(--status-danger-base)]/20 rounded-lg shadow-sm";
export const STATUS_WARNING = "font-aumovio-bold tracking-wide text-[var(--status-warning-text)] bg-[var(--status-warning-bg)] border border-[var(--status-warning-base)]/20 rounded-lg shadow-sm";
export const STATUS_BLUE = "font-aumovio-bold tracking-wide text-[var(--status-info-text)] bg-[var(--status-info-bg)] border border-[var(--status-info-base)]/20 rounded-lg shadow-sm";
export const STATUS_PURPLE = "font-aumovio-bold tracking-wide text-purple-400 dark:text-purple-300 bg-purple-100/28 dark:bg-purple-400/15 border border-purple-400/35 dark:border-purple-400/25 rounded-lg shadow-sm";
export const STATUS_CYAN = "font-aumovio-bold tracking-wide text-turquoise-500 dark:text-turquoise-300 bg-turquoise-100/22 dark:bg-turquoise-400/15 border border-turquoise-400/25 dark:border-turquoise-400/20 rounded-lg shadow-sm";
export const STATUS_AMBER = "font-aumovio-bold tracking-wide text-yellow-600 dark:text-warn-300 bg-yellow-100 dark:bg-yellow-400/15 border border-yellow-400/30 dark:border-yellow-400/25 rounded-lg shadow-sm";

// ============================================================================
// HEALTH INDICATOR DOTS
// ============================================================================
export const STATUS_INDICATOR_ACTIVE = "w-2.5 h-2.5 bg-[var(--status-success-base)] rounded-full shrink-0 shadow-sm ring-2 ring-[var(--status-success-base)]/30 animate-pulse";
export const STATUS_INDICATOR_INACTIVE = "w-2.5 h-2.5 bg-[var(--status-neutral-base)] rounded-full shrink-0 shadow-sm";
export const STATUS_INDICATOR_WARNING = "w-2.5 h-2.5 bg-[var(--status-warning-base)] rounded-full shrink-0 shadow-sm ring-2 ring-[var(--status-warning-base)]/30";
export const STATUS_INDICATOR_ERROR = "w-2.5 h-2.5 bg-[var(--status-danger-base)] rounded-full shrink-0 shadow-sm ring-2 ring-[var(--status-danger-base)]/30 animate-pulse";

// ============================================================================
// STATUS TEXT / BG / BORDER MAPS  (keyed by colour name)
// ============================================================================
export const STATUS_TEXT_COLORS = {
    green: "text-success-400 dark:text-success-300     font-aumovio-bold",
    red: "text-danger-400 dark:text-danger-300       font-aumovio-bold",
    warning: "text-warn-500 dark:text-warn-300         font-aumovio-bold",
    blue: "text-blue-500 dark:text-blue-300          font-aumovio-bold",
    purple: "text-purple-400 dark:text-purple-300      font-aumovio-bold",
    cyan: "text-turquoise-500 dark:text-turquoise-300 font-aumovio-bold",
    turquoise: "text-turquoise-500 dark:text-turquoise-300 font-aumovio-bold",
    amber: "text-yellow-600 dark:text-warn-300         font-aumovio-bold",
    grey: "text-grey-500 dark:text-grey-400           font-aumovio-bold",
    orange: "text-orange-400 dark:text-orange-300     font-aumovio-bold",
};

export const STATUS_BG_COLORS = {
    green: "bg-success-100/20 dark:bg-success-400/15 shadow-sm",
    red: "bg-danger-100/20 dark:bg-danger-400/15 shadow-sm",
    warning: "bg-warn-100/20 dark:bg-warn-400/15 shadow-sm",
    blue: "bg-blue-100/25 dark:bg-blue-400/15 shadow-sm",
    purple: "bg-purple-100/28 dark:bg-purple-400/15 shadow-sm",
    cyan: "bg-turquoise-100/22 dark:bg-turquoise-400/15 shadow-sm",
    turquoise: "bg-turquoise-100 dark:bg-turquoise-400/15 shadow-sm",
    amber: "bg-yellow-100 dark:bg-yellow-400/15 shadow-sm",
    grey: "bg-grey-100 dark:bg-(--bg-surface-3) shadow-sm",
    orange: "bg-orange-100/20 dark:bg-orange-400/15 shadow-sm",
};

export const STATUS_BORDER_COLORS = {
    green: "border border-success-400/30",
    red: "border border-danger-400/30",
    warning: "border border-warn-400",
    blue: "border border-blue-400/30",
    purple: "border border-purple-400/35",
    cyan: "border border-turquoise-400/25",
    turquoise: "border border-turquoise-400/25",
    amber: "border border-yellow-400/30",
    grey: "border border-grey-500/30",
    orange: "border border-orange-400/30",
};

// ============================================================================
// SYSTEM HEALTH STATUS COLORS
// ============================================================================
export const HEALTH_STATUS_COLORS = {
    healthy: "text-success-400 dark:text-success-300 drop-shadow-sm",
    warning: "text-warn-500 dark:text-warn-300       drop-shadow-sm",
    error: "text-danger-400 dark:text-danger-300   drop-shadow-sm",
    unknown: "text-grey-500 dark:text-grey-400      drop-shadow-sm",
};

// ============================================================================
// ALERT STYLES
// ============================================================================
export const ALERT_ERROR = "bg-danger-100 dark:bg-danger-400/15 border border-danger-400/30 text-danger-400 px-6 py-2 rounded-lg shadow-lg backdrop-blur-sm";
export const ALERT_SUCCESS = "bg-success-100 dark:bg-success-400/15 border border-success-400/30 text-success-400 px-6 py-2 rounded-lg shadow-lg backdrop-blur-sm";
export const ALERT_WARNING = "bg-warn-100/20 dark:bg-warn-400/15 border border-warn-400/30 text-warn-400 px-6 py-2 rounded-lg shadow-lg backdrop-blur-sm";
export const ALERT_INFO = "bg-purple-100/15 dark:bg-purple-400/10 border border-purple-400/25 text-purple-400 px-6 py-2 rounded-lg shadow-lg backdrop-blur-sm";

// ============================================================================
// CARD STYLES
// ============================================================================
export const CARD_ERROR = "bg-danger-100 dark:bg-danger-400/15 p-6 rounded-lg shadow-xl border border-danger-400/20 dark:border-danger-400/30 backdrop-blur-sm";
export const CARD_SUCCESS = "bg-success-100 dark:bg-success-400/15 p-6 rounded-lg shadow-xl border border-success-400/20 dark:border-success-400/30 backdrop-blur-sm";
export const CARD_WARNING = "bg-warn-100/20 dark:bg-warn-400/15 p-6 rounded-lg shadow-xl border border-warn-400/20 dark:border-warn-400/30 backdrop-blur-sm";
export const CARD_INFO = "bg-purple-100/15 dark:bg-purple-400/10 p-6 rounded-lg shadow-xl border border-purple-400/20 dark:border-purple-400/30 backdrop-blur-sm";
export const CARD_PURPLE = "bg-purple-100/25 dark:bg-purple-400/15 p-6 rounded-lg shadow-xl border border-purple-400/25 dark:border-purple-400/35 backdrop-blur-sm";

// ============================================================================
// FORM VALIDATION
// ============================================================================
export const INPUT_ERROR = "outline-danger-400 placeholder-danger-400/70 text-danger-400 bg-danger-100/20 dark:bg-danger-400/10 border-danger-400/50";
export const ERROR_MESSAGE = "font-aumovio-bold text-danger-400  bg-danger-100 dark:bg-danger-400/15 border border-danger-400/30  rounded-lg p-4 wrap-break-word shadow-sm";
export const SUCCESS_MESSAGE = "font-aumovio-bold text-success-400 bg-success-100 dark:bg-success-400/15 border border-success-400/30 rounded-lg shadow-sm";
export const WARNING_MESSAGE = "font-aumovio-bold text-warn-400    bg-warn-100/20 dark:bg-warn-400/15 border border-warn-400/30    rounded-lg shadow-sm";
export const INFO_MESSAGE = "font-aumovio-bold text-purple-400  bg-purple-100/15 dark:bg-purple-400/10 border border-purple-400/25 rounded-lg shadow-sm";

// ============================================================================
// RADIO / CHECKBOX
// ============================================================================
export const PRIMARY_RADIO = `bg-white dark:bg-(--bg-surface-2) border border-purple-400/30 dark:border-purple-400/40 shadow-sm cursor-pointer focus:outline-none
  hover:bg-purple-100/10 dark:hover:bg-purple-400/15 hover:shadow-md
  peer-checked:ring-2 peer-checked:ring-purple-400/50
  peer-checked:text-purple-400 peer-checked:bg-purple-100/15 dark:peer-checked:bg-purple-400/20
  peer-checked:border-purple-400 peer-checked:shadow-lg
  ${DEFAULT_BUTTON_TRANSITION}`;

export const DANGER_RADIO = `bg-white dark:bg-(--bg-surface-2) border border-danger-400/30 dark:border-danger-400/40 rounded-lg shadow-sm cursor-pointer focus:outline-none
  hover:bg-danger-100/70 dark:hover:bg-danger-400/15 hover:shadow-md
  peer-checked:ring-2 peer-checked:ring-danger-400/50
  peer-checked:text-danger-400 peer-checked:bg-danger-100 dark:peer-checked:bg-danger-400/20
  peer-checked:border-danger-400 peer-checked:shadow-lg
  ${DEFAULT_BUTTON_TRANSITION}`;

// ============================================================================
// ─────────────────────────────────────────────────────────────────────────────
//  ANIMATION SYSTEM
//  All constants below map directly to index.css keyframes + utility classes.
// ─────────────────────────────────────────────────────────────────────────────
// ============================================================================

// ============================================================================
// ENTER ANIMATIONS — one-shot, fill-mode: both
// ============================================================================

/** Simple opacity fade in. Duration: --duration-normal (250ms), ease: decelerate. */
export const ANIMATE_FADE_IN = "animate-fade-in";

/** Simple opacity fade out. Duration: --duration-normal (250ms), ease: accelerate. */
export const ANIMATE_FADE_OUT = "animate-fade-out";

/**
 * Slides up 16 px + fades in. Duration: --duration-moderate (350ms), ease: spring.
 * Primary enter for drawers, panels, bottom-sheets.
 */
export const ANIMATE_SLIDE_UP = "animate-slide-up";

/**
 * Slides down 16 px + fades in. Duration: --duration-moderate (350ms), ease: spring.
 * Use for dropdowns opening downward from a trigger.
 */
export const ANIMATE_SLIDE_DOWN = "animate-slide-down";

/** Slides in from the right edge (16 px). */
export const ANIMATE_SLIDE_LEFT = "animate-slide-left";

/** Slides in from the left edge (16 px). */
export const ANIMATE_SLIDE_RIGHT = "animate-slide-right";

/**
 * Scales from 0.95 → 1 + fades. Duration: --duration-normal (250ms), ease: spring.
 * Best for modals, popovers, tooltips.
 */
export const ANIMATE_SCALE_IN = "animate-scale-in";

/**
 * Scales from 0.85 → 1 + fades. Duration: --duration-slow (500ms), ease: spring.
 * Heavier version for hero sections and loading screens.
 */
export const ANIMATE_SCALE_IN_CENTER = "animate-scale-in-center";

/** Scales out to 0.92 + fades. Duration: --duration-fast (150ms), ease: accelerate. */
export const ANIMATE_SCALE_OUT = "animate-scale-out";

/**
 * Spring scale with 4 % overshoot at 60 %. Duration: --duration-moderate.
 * Use for FABs, badges, notification pings, anything that should feel "alive".
 */
export const ANIMATE_SCALE_SPRING = "animate-scale-spring";

/**
 * Combined: translateY(12px) scale(0.97) → natural position.
 * Preferred enter for cards and list items.
 */
export const ANIMATE_ENTER_UP = "animate-enter-up";

/** Combined: translateY(-12px) scale(0.97) → natural. For top-entering items. */
export const ANIMATE_ENTER_DOWN = "animate-enter-down";

/**
 * Scale from 0.3 → 1.08 → 0.97 → 1 with bounce easing.
 * Duration: --duration-slow (500ms). Perfect for success/error states.
 */
export const ANIMATE_BOUNCE_IN = "animate-bounce-in";

// ── Fade-in from a direction (opacity starts at 0 in CSS, 0.6s spring) ───────

/** Fades + rises from 20 px below. Sets opacity: 0 in CSS — element is hidden until animation plays. */
export const ANIMATE_FADE_IN_UP = "animate-fade-in-up";

/** Fades + drops from 20 px above. */
export const ANIMATE_FADE_IN_DOWN = "animate-fade-in-down";

/** Fades + slides from 20 px to the right. */
export const ANIMATE_FADE_IN_LEFT = "animate-fade-in-left";

/** Fades + slides from 20 px to the left. */
export const ANIMATE_FADE_IN_RIGHT = "animate-fade-in-right";

// ── Page-level transitions ────────────────────────────────────────────────────

/** Route enter: Y(10px) scale(0.99) → 0. Duration: --duration-moderate. */
export const ANIMATE_PAGE_ENTER = "animate-page-enter";

/** Route exit: 0 → Y(-10px) scale(0.99). Duration: --duration-normal. */
export const ANIMATE_PAGE_EXIT = "animate-page-exit";

// ============================================================================
// LOOP ANIMATIONS — infinite, use for ambient / idle states
// ============================================================================

/** Float up/down 8 px continuously. Period: 3 s. Standard floating element. */
export const ANIMATE_FLOAT = "animate-float";

/** Subtle float, 4 px. Period: 2.5 s. For small icons and badges. */
export const ANIMATE_FLOAT_SM = "animate-float-sm";

/** Large float, 14 px. Period: 4 s. For hero illustration elements. */
export const ANIMATE_FLOAT_LG = "animate-float-lg";

/** Gentle bounce-like bob. Use for buttons awaiting interaction. */
export const ANIMATE_BOUNCE_SLOW = "animate-bounce-slow";

/** Double-beat heartbeat scale. Use for like buttons, health indicators. */
export const ANIMATE_HEARTBEAT = "animate-heartbeat";

/** Opacity 1 → 0.5 → 1. Standard skeleton/loading pulse. */
export const ANIMATE_PULSE = "animate-pulse";

/** Scale 1 → 1.05 → 1. Subtle "breathing" for CTAs. */
export const ANIMATE_PULSE_SCALE = "animate-pulse-scale";

/** Scale 2 + opacity 0. Use as a ring behind a dot indicator. */
export const ANIMATE_PING = "animate-ping";

/** 360° spin, 0.75 s linear. Standard loading spinner. */
export const ANIMATE_SPIN = "animate-spin";

/** 360° spin, 2 s linear. Slow ambient rotation for decorative elements. */
export const ANIMATE_SPIN_SLOW = "animate-spin-slow";

/** Counter-clockwise spin. Use as an inner ring against ANIMATE_SPIN. */
export const ANIMATE_SPIN_REVERSE = "animate-spin-reverse";

/**
 * Moving shimmer gradient. Apply to elements with a gradient background.
 * Used internally by the `.skeleton` class in index.css.
 */
export const ANIMATE_SHIMMER = "animate-shimmer";

/**
 * Animates background-position on a 300% wide gradient.
 * Combine with a gradient bg: "animate-gradient bg-gradient-to-r from-orange-400 via-purple-400 to-blue-400"
 */
export const ANIMATE_GRADIENT = "animate-gradient";

// ============================================================================
// ATTENTION SEEKERS — one-shot triggers on error/validation state
// ============================================================================

/**
 * Rapid horizontal shake with colour shift to danger-red.
 * Duration: 250ms. Attach on invalid form submit.
 * @example className={`${ANIMATE_SHAKE} ${showError ? '' : 'invisible'}`}
 */
export const ANIMATE_SHAKE = "animate-shake";

/** Horizontal-only shake, 5 px amplitude. No colour shift. 500ms. */
export const ANIMATE_SHAKE_H = "animate-shake-h";

/** ±5° rotation wobble over 600ms. Playful draw-attention. */
export const ANIMATE_WOBBLE = "animate-wobble";

/** Combined translateX + rotateY "head shake". 500ms. */
export const ANIMATE_HEADSHAKE = "animate-headshake";

// ============================================================================
// TOAST / NOTIFICATION ANIMATIONS
// ============================================================================

/** Slide in from right edge (110%). Duration: --duration-moderate, ease: spring. */
export const ANIMATE_TOAST_IN_RIGHT = "animate-toast-in-right";

/** Slide in from left edge. */
export const ANIMATE_TOAST_IN_LEFT = "animate-toast-in-left";

/** Slide up from 80 px below. */
export const ANIMATE_TOAST_IN_UP = "animate-toast-in-up";

/** Slide out to right, collapses height/padding. Duration: --duration-moderate, ease: accelerate. */
export const ANIMATE_TOAST_OUT = "animate-toast-out";

// ============================================================================
// TRANSITION PRESETS — named classes from index.css
// ============================================================================

/**
 * Standard smooth: transform 250ms + opacity 250ms + shadow 350ms + bg/color 150ms.
 * Standard-material easing (0.4,0,0.2,1). Use for nav links, colour swaps.
 */
export const TRANSITION_SMOOTH = "transition-smooth";

/**
 * Spring: transform 350ms + shadow 350ms (spring easing).
 * Use for buttons, toggles, interactive cards.
 */
export const TRANSITION_SPRING = "transition-spring";

/**
 * Bounce: transform 350ms + opacity 250ms (bounce easing).
 * Use for modals, drawers, notification toasts.
 */
export const TRANSITION_BOUNCE = "transition-bounce";

/**
 * Snap: transform 150ms + opacity 150ms (snap easing).
 * Use for dropdowns, tooltips, tiny state toggles that need to feel instant.
 */
export const TRANSITION_SNAP = "transition-snap";

/**
 * Lazy: all 700ms standard easing.
 * Use for background decorations, hero sections, ambient motion.
 */
export const TRANSITION_LAZY = "transition-lazy";

// ── Individual property shortcuts ─────────────────────────────────────────────

/** color + background-color + border-color, 150ms standard. */
export const TRANSITION_COLORS = "transition-colors-fast";

/**
 * Button: spring transform + shadow (350ms spring) + fast bg/color/border (150ms standard).
 * Gives physical lift feel while keeping colour swaps instant and crisp.
 * Use on every interactive button element.
 */
export const TRANSITION_BUTTON = "transition-button";

/** transform only, 350ms spring easing with will-change. */
export const TRANSITION_TRANSFORM_SPRING = "transition-transform-spring";

/** box-shadow only, 350ms standard. */
export const TRANSITION_SHADOW = "transition-shadow";

/** opacity only, 250ms standard. */
export const TRANSITION_OPACITY = "transition-opacity";

/** transform scale only, 350ms spring. Alias for transform-spring. */
export const TRANSITION_SCALE_SPRING = "transition-scale-spring";

// ============================================================================
// HOVER PATTERNS — compound classes that combine transform + shadow
// ============================================================================

/**
 * Lift -3 px on hover + drop shadow. Active: returns to -1 px.
 * Duration: 350ms spring + 350ms shadow.
 * Use for cards, thumbnails, non-button interactive surfaces.
 */
export const HOVER_LIFT = "hover-lift";

/** Lift -2 px + shadow-md. Lighter version for compact list items. */
export const HOVER_LIFT_SM = "hover-lift-sm";

/** Lift -6 px + shadow-xl. Dramatic lift for featured/hero cards. */
export const HOVER_LIFT_LG = "hover-lift-lg";

/**
 * Scale 1.02 on hover, scale 0.97 on active. 150ms snap easing.
 * Use for icon buttons, inline interactive elements.
 */
export const HOVER_PRESS = "hover-press";

/**
 * Scale 1.05 on hover, scale 0.97 on active. 250ms spring.
 * Good for avatar, logo, small interactive graphics.
 */
export const HOVER_SCALE = "scale-hover";

/** Box-shadow glow-orange on hover. Use for primary CTA buttons. */
export const HOVER_GLOW_ORANGE = "hover-glow-orange";

/** Box-shadow glow-purple on hover. Use for accent/secondary buttons. */
export const HOVER_GLOW_PURPLE = "hover-glow-purple";

/** Box-shadow glow-blue on hover. Use for info/link items. */
export const HOVER_GLOW_BLUE = "hover-glow-blue";

/** Box-shadow glow-success on hover. Use for positive action items. */
export const HOVER_GLOW_SUCCESS = "hover-glow-success";

// ============================================================================
// ANIMATION DELAY HELPERS — append to any animate-* class
// ============================================================================

export const ANIM_DELAY_0 = "delay-0";
export const ANIM_DELAY_50 = "delay-50";
export const ANIM_DELAY_75 = "delay-75";
export const ANIM_DELAY_100 = "delay-100";
export const ANIM_DELAY_150 = "delay-150";
export const ANIM_DELAY_200 = "delay-200";
export const ANIM_DELAY_300 = "delay-300";
export const ANIM_DELAY_400 = "delay-400";
export const ANIM_DELAY_500 = "delay-500";
export const ANIM_DELAY_600 = "delay-600";
export const ANIM_DELAY_700 = "delay-700";
export const ANIM_DELAY_1000 = "delay-1000";

// ============================================================================
// STAGGER UTILITIES — pre-built index → delay maps
// ============================================================================

/**
 * Returns the correct delay class for a list item at `index`.
 * Caps at index 5 (500ms). Use for staggered list/grid entrance.
 *
 * @example
 * items.map((item, i) => (
 *   <li key={item.id} className={`${ANIMATE_FADE_IN_UP} ${staggerDelay(i)}`}>
 *     {item.name}
 *   </li>
 * ))
 */
export const staggerDelay = (index) => {
    const delays = ["delay-0", "delay-100", "delay-200", "delay-300", "delay-400", "delay-500"];
    return delays[Math.min(index, delays.length - 1)];
};

/**
 * Returns a dense stagger for tighter sequences (50ms steps, caps at 7).
 * Better for compact menus and nav items.
 *
 * @example
 * navItems.map((item, i) => (
 *   <a key={item.id} className={`${ANIMATE_FADE_IN_UP} ${staggerDelayDense(i)}`}>
 *     {item.label}
 *   </a>
 * ))
 */
export const staggerDelayDense = (index) => {
    const delays = ["delay-0", "delay-50", "delay-75", "delay-100", "delay-150", "delay-200", "delay-300"];
    return delays[Math.min(index, delays.length - 1)];
};

// ============================================================================
// COMPOSED ANIMATION COMBOS — shorthand for the most common patterns
// ============================================================================

/**
 * Standard card enter: fade in up + enter-up spring.
 * Apply directly to a Card component className.
 */
export const CARD_ENTER = `${ANIMATE_FADE_IN_UP} ${HOVER_LIFT}`;

/**
 * Interactive button with spring transition + orange glow.
 * Compose with variant-specific colour classes.
 */
export const BUTTON_SPRING = `${TRANSITION_SPRING} ${HOVER_GLOW_ORANGE}`;

/**
 * Modal overlay backdrop.
 * Pair with ANIMATE_SCALE_IN on the modal panel itself.
 */
export const MODAL_BACKDROP = `${ANIMATE_FADE_IN} fixed inset-0 bg-black/50 backdrop-blur-sm`;

/**
 * Skeleton placeholder — the pre-built shimmer surface from index.css.
 * Uses the .skeleton class directly (gradient + shimmer animation built in).
 */
export const SKELETON_SURFACE = "skeleton";

/**
 * Ripple host container. Add to any element that should emit a click ripple.
 * Pair with the ripple JS logic that appends .ripple elements on click.
 */
export const RIPPLE_HOST = "ripple-host";

/**
 * Consistent accessible focus ring with orange brand colour.
 * Apply to custom interactive elements that bypass Browser defaults.
 */
export const FOCUS_RING = "focus-ring";

// ============================================================================
// UTILITY — Email not set (re-exported for backward-compatible import paths)
// ============================================================================
// The `EMAIL_NOT_SET` component lives in `pre-set-styles.components.jsx` so
// that this file remains constants-only (required by react-refresh/only-export-components).
// All existing call sites can keep importing { EMAIL_NOT_SET } from "./pre-set-styles".
export { EMAIL_NOT_SET } from "./pre-set-styles.components";
