/**
 * Banner — Full-width announcement bar.
 *
 * Props:
 *   variant    — 'info'|'success'|'warning'|'danger'|'promo'
 *   sticky     — boolean (fixed top)
 *   dismissible — boolean
 *   onDismiss  — () => void
 *   actions    — [{ label, href?, onClick? }]
 *   icon       — icon component
 *   children   — message
 *   contained  — boolean, default true (false = full width, text aligned with the navbar logo)
 *   className  — extra root classes;  iconClassName — extra icon classes
 *   tone       — undefined (default, unchanged) | 'status': status banners (server reachability). Adds, per
 *                semantic variant, a dark-mode soft treatment (--status-* surface/text/hairline border, so an
 *                amber/red/green block does not glare on a dark page) and a 2 px palette hairline
 *                (--color-gradient-from -> --color-gradient-to) along the bottom edge.
 */
import { faBullhorn } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { TRANSITION_OPACITY } from "../../assets/styles/pre-set-styles";

const BANNERS = {
    // "info" is a solid fill of the secondary/purple accent family (swapped by
    // applyPaletteVars) — not the fixed semantic --status-info-* token — so its
    // foreground uses the accent-fill contrast token, same as any other solid
    // accent fill. success/warning/danger stay raw — true fixed semantic colours.
    info: "bg-purple-400 text-(--on-secondary-text)",
    success: "bg-success-500 text-grey-900",
    warning: "bg-warn-400 text-black",
    danger: "bg-danger-400 text-white",
    promo: "bg-linear-to-r from-(--color-gradient-from) to-(--color-gradient-to) text-[var(--color-gradient-text)]",
};

// tone="status" (complete class strings so Tailwind's scanner sees them). Light mode keeps the fill above.
const STATUS_TONE = {
    // info is the solid purple fill in light mode; in dark it softens like the others (>= 4.5:1: --secondary-foreground is the contrast-safe secondary text)
    info: "dark:bg-purple-400/15 dark:text-(--secondary-foreground) dark:border-b dark:border-purple-400/40",
    warning: "dark:bg-(--status-warning-bg) dark:text-(--status-warning-text) dark:border-b dark:border-(--status-warning-base)/50",
    danger: "dark:bg-(--status-danger-bg) dark:text-(--status-danger-text) dark:border-b dark:border-(--status-danger-base)/50",
    success: "dark:bg-(--status-success-bg) dark:text-(--status-success-text) dark:border-b dark:border-(--status-success-base)/50",
};
const STATUS_TONE_ICON = {
    info: "dark:text-(--secondary-foreground)",
    warning: "dark:text-(--status-warning-base)",
    danger: "dark:text-(--status-danger-base)",
    success: "dark:text-(--status-success-base)",
};
const PALETTE_HAIRLINE = "after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-linear-to-r after:from-(--color-gradient-from) after:to-(--color-gradient-to)";

/**
 * @param {"status"} [props.tone] - status banners only: dark soft treatment + palette hairline (see header).
 * @param {string} [props.className=""] - extra root classes (e.g. a colour transition).
 * @param {string} [props.iconClassName=""] - extra classes on the icon (e.g. a state animation).
 * @param {boolean} [props.contained=true] - true: content centred in max-w-7xl (default);
 *   false: full width with px-4, text starting at the page's left edge like the navbar
 *   logo (used by the server status banner).
 */
export function Banner({ variant = "promo", sticky = false, dismissible = true, onDismiss, actions = [], icon: Icon, children, contained = true, className = "", iconClassName = "", tone }) {
    const [visible, setVisible] = useState(true);
    if (!visible) return null;

    const dismiss = () => {
        setVisible(false);
        onDismiss?.();
    };

    const isStatus = tone === "status";
    // `sticky` is already a positioned box for the hairline; otherwise make the root one.
    const toneClass = isStatus ? `${STATUS_TONE[variant] ?? ""} ${PALETTE_HAIRLINE} ${sticky ? "" : "relative"}` : "";
    const toneIconClass = isStatus ? (STATUS_TONE_ICON[variant] ?? "") : "";

    return (
        <div className={`w-full z-50 font-aumovio ${BANNERS[variant]} ${sticky ? "sticky top-0" : ""} ${toneClass} ${className}`.replace(/\s+/g, " ").trim()}>
            <div className={`${contained ? "max-w-7xl mx-auto justify-between" : "w-full justify-start"} px-4 py-3 flex items-center gap-4 flex-wrap`}>
                <div className="flex items-center gap-2 text-sm font-aumovio-bold">
                    {Icon ? <Icon className={`w-4 h-4 shrink-0 ${toneIconClass} ${iconClassName}`.replace(/\s+/g, " ").trim()} aria-hidden="true" /> : <FontAwesomeIcon icon={faBullhorn} className="w-4 h-4 shrink-0" />}
                    <span>{children}</span>
                </div>
                {(actions.length > 0 || dismissible) && (
                    <div className={`flex items-center gap-3 ${contained ? "" : "ml-auto"}`}>
                        {actions.map((a, i) =>
                            a.href ? (
                                <a key={i} href={a.href} className="text-xs underline underline-offset-2 hover:no-underline font-aumovio-bold">
                                    {a.label}
                                </a>
                            ) : (
                                <button key={i} onClick={a.onClick} className="text-xs underline underline-offset-2 hover:no-underline font-aumovio-bold">
                                    {a.label}
                                </button>
                            ),
                        )}
                        {dismissible && (
                            <button onClick={dismiss} aria-label="Dismiss banner" className={`${TRANSITION_OPACITY} opacity-80 hover:opacity-100`}>
                                <XMarkIcon className="w-4 h-4" />
                            </button>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

export default Banner;
