/**
 * Modal — Accessible dialog overlay.
 *
 * Props:
 *   open     — boolean
 *   onClose  — () => void
 *   title    — string
 *   ariaLabel - optional string. Accessible name for title-less modals; ignored
 *               when `title` is set, which names the dialog via aria-labelledby (WCAG 4.1.2).
 *   size     — 'sm'|'md'|'lg'|'xl'|'2xl'|'3xl'|'full'
 *   variant  — 'default'|'danger'|'success'|'warning'
 *   footer   — ReactNode
 *   bodyClassName — extra classes for the scrollable body (e.g. 'hide-scrollbar'),
 *               appended after the body variant's base classes
 *   titleIcon — optional ReactNode rendered (aria-hidden) before the title inside the h2.
 *               The accessible name stays exactly `title`.
 *   headerAside — optional ReactNode placed between the title and the × button
 *               (not part of the accessible name).
 *   headerVariant — 'default' | 'section'. 'section' mirrors SectionCardHeader
 *               (compact 13px title, card-surface border) so a modal can read as a
 *               continuation of the card it was opened from.
 *   bodyVariant — 'default' | 'flush'. 'flush' drops the padding / max-height /
 *               hide-scrollbar base classes so the caller owns body layout via
 *               `bodyClassName` (there is no class-merge library, and
 *               `.hide-scrollbar` is unlayered CSS, so it cannot be overridden by
 *               appended utilities).
 *   initialFocusRef — ref to the element focused on open (default: the dialog panel).
 *   returnFocusRef  — ref to the element focused on close (default: the element
 *               that was focused when the modal opened).
 *   children
 *
 * Focus: on open, focus moves into the panel unless it is already inside it
 * (callers' own focus effects win). Tab / Shift+Tab are trapped inside the panel.
 * On close, focus returns to `returnFocusRef` or the opener. The focus effect is
 * keyed on [open, refs] only, so callers passing an inline `onClose` never get
 * their focus moved on re-render.
 *
 * The × button carries `data-lock-exempt` so the server-status lock (which
 * inerts controls during an outage) never prevents closing a dialog.
 *
 * Blur strategy: `filter: blur` is applied directly to #root and the modal is
 * portalled to document.body. This avoids the stacking-context limitation of
 * `backdrop-filter`, which breaks when any ancestor has transform/opacity/
 * will-change applied (common with animation classes).
 */
import { XMarkIcon } from "@heroicons/react/24/outline";
import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { ANIMATE_FADE_IN, ANIMATE_SCALE_IN, FOCUS_RING, TRANSITION_COLORS } from "../../assets/styles/pre-set-styles";

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[contenteditable="true"],[tabindex]:not([tabindex="-1"])';

/**
 * Where return-focus may actually land: `el` itself when connected and not inert; otherwise the nearest
 * focusable, non-inert ancestor; otherwise null (focus stays on <body>). Never throws. O(depth).
 *
 * @param {Element|null|undefined} el
 * @returns {HTMLElement|null}
 */
function usableFocusTarget(el) {
    if (!el || !el.isConnected || el === document.body) return null;
    if (!el.closest("[inert]")) return el;
    for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
        if (node.matches(FOCUSABLE) && !node.closest("[inert]")) return node;
    }
    return null;
}

const SIZES = {
    sm: "max-w-sm",
    md: "max-w-md",
    lg: "max-w-lg",
    xl: "max-w-2xl",
    "2xl": "max-w-4xl",
    "3xl": "max-w-6xl",
    full: "max-w-full min-h-screen rounded-none",
};

const VARIANTS = {
    default: "",
    danger: "border-t-4 border-danger-400",
    success: "border-t-4 border-success-400",
    warning: "border-t-4 border-warn-400",
};

export function Modal({ open, onClose, title, size = "md", variant = "default", footer, bodyClassName = "", ariaLabel, titleIcon, headerAside, headerVariant = "default", bodyVariant = "default", initialFocusRef, returnFocusRef, children }) {
    const titleId = useId();
    const panelRef = useRef(null);

    // Focus management — separate effect keyed on [open, refs] ONLY (not onClose),
    // so an inline onClose from the caller never re-runs it and yanks focus.
    useEffect(() => {
        if (!open) return;
        const panel = panelRef.current;
        if (!panel) return;
        const active = document.activeElement;
        const opener = panel.contains(active) ? null : active;
        if (!panel.contains(active)) {
            (initialFocusRef?.current ?? panel).focus({ preventScroll: true });
        }
        return () => {
            // Intentionally read at cleanup time: callers (e.g. a gallery) retarget this ref just before closing.
            // eslint-disable-next-line react-hooks/exhaustive-deps
            const preferred = returnFocusRef?.current;
            const target = usableFocusTarget(preferred?.isConnected ? preferred : opener);
            target?.focus?.({ preventScroll: true });
        };
    }, [open, initialFocusRef, returnFocusRef]);

    /** Tab trap. Ignores events from portalled descendants (e.g. a nested Modal). */
    const handleTrapKeyDown = (e) => {
        if (e.key !== "Tab") return;
        const panel = panelRef.current;
        if (!panel || !panel.contains(e.target)) return;
        const items = Array.from(panel.querySelectorAll(FOCUSABLE)).filter((el) => !el.closest("[inert],[hidden]") && el.getClientRects().length > 0);
        if (items.length === 0) {
            e.preventDefault();
            panel.focus();
            return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && (active === first || active === panel)) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && active === last) {
            e.preventDefault();
            first.focus();
        }
    };

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

    const section = headerVariant === "section";
    const closeButton = (
        <button type="button" data-lock-exempt="" onClick={onClose} aria-label="Close" className={`flex items-center justify-center ${TRANSITION_COLORS} ${FOCUS_RING} rounded-lg w-7 h-7 text-grey-400 hover:text-grey-600 dark:hover:text-grey-300 hover:bg-grey-100 dark:hover:bg-(--bg-surface-3)`}>
            <XMarkIcon className="w-4 h-4" />
        </button>
    );

    return createPortal(
        <div className={`fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 ${ANIMATE_FADE_IN}`} role="dialog" aria-modal="true" aria-labelledby={title ? titleId : undefined} aria-label={!title && ariaLabel ? ariaLabel : undefined} onClick={onClose}>
            <div
                ref={panelRef}
                tabIndex={-1}
                onKeyDown={handleTrapKeyDown}
                className={`relative w-full ${SIZES[size] ?? SIZES.md}
                    bg-(--bg-surface) dark:bg-(--bg-surface-2) rounded-2xl shadow-2xl
                    ${ANIMATE_SCALE_IN} overflow-hidden font-aumovio focus:outline-none ${VARIANTS[variant]}`}
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                {title && (
                    <div className={section ? "flex items-center justify-between gap-4 p-4 min-h-13 border-b border-(--color-card-surface-border)" : "flex items-center justify-between px-6 py-4 border-b border-grey-200 dark:border-grey-700"}>
                        <h2 id={titleId} className={section ? "text-[13px] font-aumovio-bold text-(--text-primary) flex items-center gap-3 min-w-0 truncate" : "text-base font-aumovio-bold text-black/85 dark:text-white/90"}>
                            {titleIcon && (
                                <span aria-hidden="true" className="shrink-0 flex">
                                    {titleIcon}
                                </span>
                            )}
                            {titleIcon ? <span className="truncate">{title}</span> : title}
                        </h2>
                        {headerAside ? (
                            <div className="flex items-center gap-3 shrink-0">
                                {headerAside}
                                {closeButton}
                            </div>
                        ) : (
                            closeButton
                        )}
                    </div>
                )}
                {/* Body — default: scroll kept, scrollbar hidden across all modals (hide-scrollbar); flush: caller owns layout */}
                <div className={`${bodyVariant === "flush" ? "" : "px-6 py-5 overflow-y-auto max-h-[70vh] hide-scrollbar"} ${bodyClassName}`}>{children}</div>
                {/* Footer */}
                {footer && <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-grey-200 dark:border-grey-700 bg-grey-50 dark:bg-white/5">{footer}</div>}
            </div>
        </div>,
        document.body,
    );
}

export default Modal;
