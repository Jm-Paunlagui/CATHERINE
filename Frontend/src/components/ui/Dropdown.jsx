/**
 * Dropdown — Contextual menu on click/hover.
 *
 * Props:
 *   trigger  — ReactNode (the button/element that opens it)
 *   items    — [{ id, label, icon?, shortcut?, divider?, danger?, disabled?, onClick }]
 *   placement — 'bottom-start'|'bottom-end'|'top-start'|'top-end'
 *   width    — 'auto'|'sm'|'md'|'lg' (sm=160,md=192,lg=224)
 */
import { useEffect, useRef, useState } from "react";
import { TRANSITION_COLORS, TRANSITION_SNAP } from "../../assets/styles/pre-set-styles";

const WIDTHS = { auto: "min-w-max", sm: "w-40", md: "w-48", lg: "w-56" };
const PLACEMENT = {
    "bottom-start": "top-full left-0 mt-1",
    "bottom-end": "top-full right-0 mt-1",
    "top-start": "bottom-full left-0 mb-1",
    "top-end": "bottom-full right-0 mb-1",
};

export function Dropdown({ trigger, items = [], placement = "bottom-start", width = "md" }) {
    const [open, setOpen] = useState(false);
    const ref = useRef(null);

    useEffect(() => {
        const h = (e) => {
            if (!ref.current?.contains(e.target)) setOpen(false);
        };
        document.addEventListener("mousedown", h);
        return () => document.removeEventListener("mousedown", h);
    }, []);

    return (
        <div ref={ref} className="relative inline-block font-aumovio">
            <div onClick={() => setOpen((o) => !o)} className="cursor-pointer">
                {trigger}
            </div>

            {open && (
                <div
                    className={`absolute z-50 ${PLACEMENT[placement]} ${WIDTHS[width]}
          bg-(--bg-surface) dark:bg-(--bg-surface-2) border border-grey-200 dark:border-grey-700
          rounded-xl shadow-2xl py-1.5 animate-scale-in origin-top ${TRANSITION_SNAP}`}
                >
                    {items.map((item, i) => {
                        if (item.divider) return <div key={i} className="my-1.5 border-t border-grey-200 dark:border-grey-700" />;
                        return (
                            <button
                                key={item.id ?? i}
                                onClick={() => {
                                    if (!item.disabled) {
                                        item.onClick?.();
                                        setOpen(false);
                                    }
                                }}
                                disabled={item.disabled}
                                className={`w-full flex items-center gap-2.5 px-3.5 py-2 text-sm text-left
                  ${TRANSITION_COLORS} font-aumovio
                  ${item.disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}
                  ${item.danger ? "text-danger-500 dark:text-danger-300 hover:bg-danger-100 dark:hover:bg-danger-400/10" : "text-black/80 dark:text-white/80 hover:bg-orange-50 dark:hover:bg-orange-400/5 hover:text-(--accent-foreground)"}`}
                            >
                                {item.icon && <item.icon className="w-4 h-4 shrink-0" />}
                                <span className="flex-1">{item.label}</span>
                                {item.shortcut && (
                                    <kbd
                                        className="text-xs text-grey-400 font-mono bg-grey-100 dark:bg-(--bg-surface-3)
                    border border-grey-200 dark:border-grey-700 rounded px-1.5 py-0.5"
                                    >
                                        {item.shortcut}
                                    </kbd>
                                )}
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

export default Dropdown;
