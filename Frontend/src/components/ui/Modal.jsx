/**
 * Modal — Accessible dialog overlay.
 *
 * Props:
 *   open     — boolean
 *   onClose  — () => void
 *   title    — string
 *   size     — 'sm'|'md'|'lg'|'xl'|'2xl'|'full'
 *   variant  — 'default'|'danger'|'success'
 *   footer   — ReactNode
 *   bodyClassName — extra classes for the scrollable body (e.g. 'hide-scrollbar')
 *   children
 *
 * Blur strategy: `filter: blur` is applied directly to #root and the modal is
 * portalled to document.body. This avoids the stacking-context limitation of
 * `backdrop-filter`, which breaks when any ancestor has transform/opacity/
 * will-change applied (common with animation classes).
 */
import { XMarkIcon } from "@heroicons/react/24/outline";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { ANIMATE_FADE_IN, ANIMATE_SCALE_IN, TRANSITION_COLORS } from "../../assets/styles/pre-set-styles";

const SIZES = {
    sm: "max-w-sm",
    md: "max-w-md",
    lg: "max-w-lg",
    xl: "max-w-2xl",
    "2xl": "max-w-4xl",
    full: "max-w-full min-h-screen rounded-none",
};

const VARIANTS = {
    default: "",
    danger: "border-t-4 border-danger-400",
    success: "border-t-4 border-success-400",
};

export function Modal({ open, onClose, title, size = "md", variant = "default", footer, bodyClassName = "", children }) {
    useEffect(() => {
        if (!open) return;

        const h = (e) => {
            if (e.key === "Escape") onClose?.();
        };
        document.addEventListener("keydown", h);
        document.body.style.overflow = "hidden";

        const root = document.getElementById("root");
        if (root) root.classList.add("blur-sm");

        return () => {
            document.removeEventListener("keydown", h);
            document.body.style.overflow = "";
            if (root) root.classList.remove("blur-sm");
        };
    }, [open, onClose]);

    if (!open) return null;

    return createPortal(
        <div className={`fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 ${ANIMATE_FADE_IN}`} role="dialog" aria-modal="true" onClick={onClose}>
            <div
                className={`relative w-full ${SIZES[size] ?? SIZES.md}
                    bg-(--bg-surface) dark:bg-(--bg-surface-2) rounded-2xl shadow-2xl
                    ${ANIMATE_SCALE_IN} overflow-hidden font-aumovio ${VARIANTS[variant]}`}
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                {title && (
                    <div className="flex items-center justify-between px-6 py-4 border-b border-grey-200 dark:border-grey-700">
                        <h2 className="text-base font-aumovio-bold text-black/85 dark:text-white/90">{title}</h2>
                        <button onClick={onClose} aria-label="Close" className={`flex items-center justify-center ${TRANSITION_COLORS} rounded-lg w-7 h-7 text-grey-400 hover:text-grey-600 dark:hover:text-grey-300 hover:bg-grey-100 dark:hover:bg-(--bg-surface-3)`}>
                            <XMarkIcon className="w-4 h-4" />
                        </button>
                    </div>
                )}
                {/* Body — scroll kept, scrollbar hidden across all modals (hide-scrollbar) */}
                <div className={`px-6 py-5 overflow-y-auto max-h-[70vh] hide-scrollbar ${bodyClassName}`}>{children}</div>
                {/* Footer */}
                {footer && <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-grey-200 dark:border-grey-700 bg-grey-50 dark:bg-white/5">{footer}</div>}
            </div>
        </div>,
        document.body,
    );
}

export default Modal;
