/**
 * Accordion — Collapsible content panels.
 *
 * Props:
 *   items        — [{ id, title, content, icon? }]
 *   defaultOpen  — id of panel open by default (null = all closed)
 *   multiple     — boolean: allow multiple open at once
 *   variant      — 'default' | 'flush' | 'separated'
 *   size         — 'sm' | 'md' | 'lg'
 */

import { ChevronDownIcon } from "@heroicons/react/24/outline";
import { useCallback, useState } from "react";
import { TRANSITION_COLORS, TRANSITION_SMOOTH, TRANSITION_TRANSFORM_SPRING } from "../../assets/styles/pre-set-styles";

const VARIANTS = {
    default: "border border-grey-200 dark:border-grey-700 rounded-xl overflow-hidden divide-y divide-grey-200 dark:divide-grey-700",
    flush: "divide-y divide-grey-200 dark:divide-grey-700",
    separated: "space-y-2",
};

const ITEM_VARIANTS = {
    default: "",
    flush: "",
    separated: "border border-grey-200 dark:border-grey-700 rounded-xl overflow-hidden",
};

const SIZES = {
    sm: { header: "px-4 py-3 text-sm", body: "px-4 pb-3 text-sm" },
    md: { header: "px-5 py-4 text-sm", body: "px-5 pb-4 text-sm" },
    lg: { header: "px-6 py-5 text-base", body: "px-6 pb-5 text-sm" },
};

export function Accordion({ items = [], defaultOpen = null, multiple = false, variant = "default", size = "md" }) {
    const [openIds, setOpenIds] = useState(() => (defaultOpen ? [defaultOpen] : []));

    const toggle = useCallback(
        (id) => {
            setOpenIds((prev) => {
                const isOpen = prev.includes(id);
                if (multiple) return isOpen ? prev.filter((x) => x !== id) : [...prev, id];
                return isOpen ? [] : [id];
            });
        },
        [multiple],
    );

    const sz = SIZES[size] ?? SIZES.md;

    return (
        <div className={`font-aumovio ${VARIANTS[variant] ?? VARIANTS.default}`}>
            {items.map((item) => {
                const isOpen = openIds.includes(item.id);
                return (
                    <div key={item.id} className={`bg-(--bg-surface) dark:bg-(--bg-surface-2) ${ITEM_VARIANTS[variant]}`}>
                        <button
                            onClick={() => toggle(item.id)}
                            aria-expanded={isOpen}
                            className={`w-full flex items-center justify-between gap-3
                text-left font-aumovio-bold text-black/85 dark:text-white/90
                hover:bg-orange-50 dark:hover:bg-orange-400/5
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400/50
                ${TRANSITION_COLORS} ${sz.header}`}
                        >
                            <span className="flex items-center gap-2">
                                {item.icon && <item.icon className="w-4 h-4 text-orange-400 shrink-0" />}
                                {item.title}
                            </span>
                            <ChevronDownIcon
                                className={`w-4 h-4 text-grey-400 shrink-0 ${TRANSITION_TRANSFORM_SPRING}
                  ${isOpen ? "rotate-180 text-orange-400" : ""}`}
                            />
                        </button>
                        <div
                            className={`overflow-hidden ${TRANSITION_SMOOTH}
                ${isOpen ? "max-h-500 opacity-100" : "max-h-0 opacity-0"}`}
                        >
                            <div className={`text-black/70 dark:text-white/70 leading-relaxed ${sz.body}`}>{item.content}</div>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

export default Accordion;
