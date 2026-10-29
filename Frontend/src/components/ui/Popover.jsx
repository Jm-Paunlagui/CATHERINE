/**
 * Popover — Rich floating panel anchored to a trigger.
 *
 * Props:
 *   trigger   — ReactNode
 *   content   — ReactNode
 *   placement — 'top'|'bottom'|'left'|'right'
 *   title     — string (optional header)
 *   width     — 'sm'|'md'|'lg'
 *   triggerOn — 'click'|'hover'
 *
 * Accessibility: the panel is role="dialog" labelled by its title; an interactive
 * (button/a/input/role=button) trigger gains aria-haspopup / aria-expanded / aria-controls. Escape closes and
 * returns focus to the trigger element; hover mode also opens on focus and
 * closes on blur so keyboard users reach the content.
 */

import { cloneElement, isValidElement, useEffect, useId, useRef, useState } from "react";
import { ANIMATE_SCALE_IN } from "../../assets/styles/pre-set-styles";

const PLACEMENT = {
    top: "bottom-full left-1/2 -translate-x-1/2 mb-2",
    bottom: "top-full  left-1/2 -translate-x-1/2 mt-2",
    left: "right-full top-1/2 -translate-y-1/2 mr-2",
    right: "left-full  top-1/2 -translate-y-1/2 ml-2",
};

const WIDTHS = { sm: "w-48", md: "w-64", lg: "w-80" };

export function Popover({ trigger, content, title, placement = "bottom", width = "md", triggerOn = "click" }) {
    const [open, setOpen] = useState(false);
    const ref = useRef(null);
    const id = useId();
    const titleId = `${id}-title`;

    useEffect(() => {
        if (triggerOn !== "click") return;
        const h = (e) => {
            if (!ref.current?.contains(e.target)) setOpen(false);
        };
        document.addEventListener("mousedown", h);
        return () => document.removeEventListener("mousedown", h);
    }, [triggerOn]);

    // Escape closes and hands focus back to the anchor.
    useEffect(() => {
        if (!open) return;
        const onKey = (e) => {
            if (e.key !== "Escape") return;
            setOpen(false);
            // Return focus to the trigger element itself; fall back to the wrapper.
            const target = ref.current?.querySelector("button, a[href], input, select, textarea, [role='button'], [tabindex]:not([tabindex='-1'])");
            (target ?? ref.current)?.focus();
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [open]);

    const handlers =
        triggerOn === "hover"
            ? {
                  onMouseEnter: () => setOpen(true),
                  onMouseLeave: () => setOpen(false),
                  onFocus: () => setOpen(true),
                  onBlur: (e) => {
                      if (!ref.current?.contains(e.relatedTarget)) setOpen(false);
                  },
              }
            : { onClick: () => setOpen((o) => !o) };

    // ARIA state belongs on the interactive trigger element, not the wrapper div.
    const interactive = isValidElement(trigger) && (["button", "a", "input"].includes(trigger.type) || trigger.props?.role === "button");
    const anchor = interactive ? cloneElement(trigger, { "aria-haspopup": "dialog", "aria-expanded": open, "aria-controls": open ? id : undefined }) : trigger;

    return (
        <div ref={ref} tabIndex={-1} className="relative inline-block font-aumovio outline-none" {...handlers}>
            {anchor}
            {open && (
                <div
                    id={id}
                    role="dialog"
                    onClick={(e) => e.stopPropagation()}
                    aria-labelledby={title ? titleId : undefined}
                    className={`absolute z-50 ${PLACEMENT[placement]} ${WIDTHS[width]}
          bg-(--bg-surface) dark:bg-(--bg-surface-2) border border-grey-200 dark:border-grey-700
          rounded-xl shadow-2xl ${ANIMATE_SCALE_IN}`}
                >
                    {title && (
                        <div className="px-4 py-3 border-b border-grey-200 dark:border-grey-700">
                            <h3 id={titleId} className="text-sm font-aumovio-bold text-black/85 dark:text-white/90">
                                {title}
                            </h3>
                        </div>
                    )}
                    <div className="p-4 text-sm text-black/70 dark:text-white/70">{content}</div>
                </div>
            )}
        </div>
    );
}

export default Popover;
