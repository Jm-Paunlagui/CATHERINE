/**
 * Drawer — Slide-in panel from any edge.
 *
 * Props:
 *   open      — boolean
 *   onClose   — () => void
 *   side      — 'left'|'right'|'top'|'bottom'
 *   size      — 'sm'|'md'|'lg'|'xl'|'2xl'|'full'
 *   title     — string
 *   backdrop  — boolean
 *   footer    — ReactNode (optional) — sticky footer rendered below the body,
 *               e.g. Cancel/Save actions. Omit for drawers that keep an
 *               inline footer inside their own body content.
 *   children
 *
 * Portal strategy: the drawer is portaled to `document.body`, mirroring
 * `Modal.jsx`. Without this, an ancestor with a persisting `transform`
 * (e.g. views using `animate-page-enter`, whose keyframes end with
 * `transform: translateY(0) scale(1)` under `animation-fill-mode: both`)
 * becomes the containing block for `position: fixed` descendants — the
 * closed (translated off-screen) panel then adds horizontal scroll overflow
 * to the app's scroll container, the backdrop no longer covers the
 * navbar/sidebar, and the panel is clipped to page height instead of
 * viewport height. Portaling to `document.body` resolves `fixed` against
 * the viewport again.
 */
import { XMarkIcon } from "@heroicons/react/24/outline";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { TRANSITION_BOUNCE, TRANSITION_COLORS, TRANSITION_OPACITY } from "../../assets/styles/pre-set-styles";

const TRANSLATE = {
    left: {
        closed: "-translate-x-full",
        open: "translate-x-0",
        pos: "left-0 top-0 bottom-0",
    },
    right: {
        closed: "translate-x-full",
        open: "translate-x-0",
        pos: "right-0 top-0 bottom-0",
    },
    top: {
        closed: "-translate-y-full",
        open: "translate-y-0",
        pos: "top-0 left-0 right-0",
    },
    bottom: {
        closed: "translate-y-full",
        open: "translate-y-0",
        pos: "bottom-0 left-0 right-0",
    },
};

const WIDTHS = {
    sm: "w-64",
    md: "w-80",
    lg: "w-96",
    xl: "w-[480px]",
    "2xl": "w-[640px]",
    full: "w-full",
};

const HEIGHTS = {
    sm: "h-64",
    md: "h-80",
    lg: "h-96",
    xl: "h-[480px]",
    full: "h-full",
};

export function Drawer({ open, onClose, side = "right", size = "md", title, backdrop = true, footer, children }) {
    useEffect(() => {
        if (!open) return;
        const h = (e) => {
            if (e.key === "Escape") onClose?.();
        };
        document.addEventListener("keydown", h);

        const scroller = document.getElementById("app-scroll");
        const target = scroller ?? document.body;
        const prevOverflow = target.style.overflow;
        const prevPadRight = target.style.paddingRight;
        const barWidth = target.offsetWidth - target.clientWidth;
        target.style.overflow = "hidden";
        if (barWidth > 0) target.style.paddingRight = `${barWidth}px`;

        return () => {
            document.removeEventListener("keydown", h);
            target.style.overflow = prevOverflow;
            target.style.paddingRight = prevPadRight;
        };
    }, [open, onClose]);

    const t = TRANSLATE[side] ?? TRANSLATE.right;
    const isH = side === "left" || side === "right";
    const dim = isH ? WIDTHS[size] : HEIGHTS[size];

    return createPortal(
        <>
            {backdrop && (
                <div
                    onClick={onClose}
                    className={`fixed inset-0 z-40 bg-black/40 backdrop-blur-sm ${TRANSITION_OPACITY}
            ${open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"}`}
                />
            )}
            <div
                role="dialog"
                aria-modal="true"
                aria-hidden={open ? "false" : "true"}
                className={`fixed z-50 ${t.pos} ${dim} max-w-full ${isH ? "h-full" : "w-full"}
          bg-(--bg-surface) dark:bg-(--bg-surface-2) shadow-2xl
                    transform ${TRANSITION_BOUNCE} font-aumovio
          flex flex-col
          ${open ? t.open : `${t.closed} pointer-events-none`}`}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4 border-b border-grey-200 dark:border-grey-700 shrink-0">
                    <h2 className="text-base font-aumovio-bold text-black/85 dark:text-white/90">{title}</h2>
                    <button
                        onClick={onClose}
                        aria-label="Close drawer"
                        className={`p-1.5 rounded-lg text-grey-400 hover:text-grey-600 dark:hover:text-grey-300 hover:bg-grey-100
              dark:hover:bg-(--bg-surface-3) ${TRANSITION_COLORS}`}
                    >
                        <XMarkIcon className="w-5 h-5" />
                    </button>
                </div>
                {/* Body */}
                <div className="flex-1 p-5 overflow-y-auto overflow-x-hidden">{children}</div>
                {/* Footer */}
                {footer && <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-grey-200 dark:border-grey-700 bg-grey-50 dark:bg-white/5 shrink-0">{footer}</div>}
            </div>
        </>,
        document.body,
    );
}

export default Drawer;
