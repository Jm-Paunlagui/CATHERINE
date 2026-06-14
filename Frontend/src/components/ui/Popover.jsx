/**
 * Popover — Rich floating panel anchored to a trigger.
 *
 * Props:
 *   trigger   — ReactNode
 *   content   — ReactNode
 *   placement — 'top'|'bottom'|'left'|'right'
 *   title     — string (optional header)
 *   width     — 'sm'|'md'|'lg'
 *   trigger   — 'click'|'hover'
 */

import { useEffect, useRef, useState } from "react";
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

    useEffect(() => {
        if (triggerOn !== "click") return;
        const h = (e) => {
            if (!ref.current?.contains(e.target)) setOpen(false);
        };
        document.addEventListener("mousedown", h);
        return () => document.removeEventListener("mousedown", h);
    }, [triggerOn]);

    const handlers =
        triggerOn === "hover"
            ? {
                  onMouseEnter: () => setOpen(true),
                  onMouseLeave: () => setOpen(false),
              }
            : { onClick: () => setOpen((o) => !o) };

    return (
        <div ref={ref} className="relative inline-block font-aumovio" {...handlers}>
            {trigger}
            {open && (
                <div
                    className={`absolute z-50 ${PLACEMENT[placement]} ${WIDTHS[width]}
          bg-(--bg-surface) dark:bg-(--bg-surface-2) border border-grey-200 dark:border-grey-700
          rounded-xl shadow-2xl ${ANIMATE_SCALE_IN}`}
                >
                    {title && (
                        <div className="px-4 py-3 border-b border-grey-200 dark:border-grey-700">
                            <h3 className="text-sm font-aumovio-bold text-black/85 dark:text-white/90">{title}</h3>
                        </div>
                    )}
                    <div className="p-4 text-sm text-black/70 dark:text-white/70">{content}</div>
                </div>
            )}
        </div>
    );
}

export default Popover;
