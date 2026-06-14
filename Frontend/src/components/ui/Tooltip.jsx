/**
 * Tooltip — Hover label attached to any element.
 *
 * Rendered through a portal to document.body with fixed positioning so it is
 * never clipped by an ancestor's overflow (e.g. a scrolling sidebar nav with
 * overflow-y-auto, which also clips overflow-x). Position is measured from the
 * trigger's bounding rect on show and kept in sync on scroll/resize.
 *
 * Props:
 *   children  — trigger element
 *   content   — string | ReactNode
 *   placement — 'top'|'bottom'|'left'|'right'
 *   delay     — ms (default 300)
 *   size      — 'sm'|'md'
 *   disabled  — boolean
 *   wrap      — boolean (default false) — allows text to wrap; caps width at 56 (14rem)
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ANIMATE_FADE_IN } from "../../assets/styles/pre-set-styles";

const GAP = 8; // px between trigger and tooltip

// Fixed-position coordinates + transform anchor for each placement.
function positionFor(placement, r) {
    switch (placement) {
        case "right":
            return { top: r.top + r.height / 2, left: r.right + GAP, transform: "translateY(-50%)" };
        case "left":
            return { top: r.top + r.height / 2, left: r.left - GAP, transform: "translate(-100%, -50%)" };
        case "bottom":
            return { top: r.bottom + GAP, left: r.left + r.width / 2, transform: "translateX(-50%)" };
        case "top":
        default:
            return { top: r.top - GAP, left: r.left + r.width / 2, transform: "translate(-50%, -100%)" };
    }
}

export function Tooltip({ children, content, placement = "top", delay = 300, size = "sm", disabled = false, wrap = false }) {
    const [visible, setVisible] = useState(false);
    const [coords, setCoords] = useState(null);
    const triggerRef = useRef(null);
    const timer = useRef(null);

    const reposition = useCallback(() => {
        const el = triggerRef.current;
        if (!el) return;
        setCoords(positionFor(placement, el.getBoundingClientRect()));
    }, [placement]);

    const show = () => {
        if (disabled) return;
        timer.current = setTimeout(() => {
            reposition();
            setVisible(true);
        }, delay);
    };
    const hide = () => {
        clearTimeout(timer.current);
        setVisible(false);
    };

    // Keep the fixed tooltip glued to the trigger while it's open.
    useEffect(() => {
        if (!visible) return;
        const onMove = () => reposition();
        window.addEventListener("scroll", onMove, true);
        window.addEventListener("resize", onMove);
        return () => {
            window.removeEventListener("scroll", onMove, true);
            window.removeEventListener("resize", onMove);
        };
    }, [visible, reposition]);

    useEffect(() => () => clearTimeout(timer.current), []);

    return (
        <span ref={triggerRef} className="inline-flex" onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
            {children}
            {visible &&
                content &&
                coords &&
                createPortal(
                    <div
                        style={{ position: "fixed", top: coords.top, left: coords.left, transform: coords.transform }}
                        className={`z-9999 pointer-events-none ${ANIMATE_FADE_IN} ${wrap ? "whitespace-normal max-w-56" : "whitespace-nowrap"}
          ${size === "sm" ? "px-2.5 py-1 text-xs rounded-lg" : "px-3 py-1.5 text-sm rounded-xl"}
          bg-grey-900 dark:bg-(--bg-surface-3) dark:border dark:border-white/10 text-white font-aumovio shadow-xl dark:shadow-black/50`}
                    >
                        {content}
                    </div>,
                    document.body,
                )}
        </span>
    );
}

export default Tooltip;
