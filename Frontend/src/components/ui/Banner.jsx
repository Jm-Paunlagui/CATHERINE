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
    success: "bg-success-500 text-white",
    warning: "bg-warn-400 text-black",
    danger: "bg-danger-400 text-white",
    promo: "bg-linear-to-r from-(--color-gradient-from) to-(--color-gradient-to) text-[var(--color-gradient-text)]",
};

export function Banner({ variant = "promo", sticky = false, dismissible = true, onDismiss, actions = [], icon, children }) {
    const [visible, setVisible] = useState(true);
    if (!visible) return null;

    const dismiss = () => {
        setVisible(false);
        onDismiss?.();
    };

    return (
        <div className={`w-full z-50 font-aumovio ${BANNERS[variant]} ${sticky ? "sticky top-0" : ""}`}>
            <div className="max-w-7xl mx-auto px-4 py-2.5 flex items-center justify-between gap-4 flex-wrap">
                <div className="flex items-center gap-2 text-sm font-aumovio-bold">
                    {icon ? <icon className="w-4 h-4 shrink-0" /> : <FontAwesomeIcon icon={faBullhorn} className="w-4 h-4 shrink-0" />}
                    <span>{children}</span>
                </div>
                <div className="flex items-center gap-3">
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
            </div>
        </div>
    );
}

export default Banner;
