/**
 * ListGroup — Bordered list of items.
 *
 * Props:
 *   items   — [{ id, label, description?, icon?, badge?, meta?, onClick?, active?, disabled? }]
 *   variant — 'default'|'flush'|'separated'
 *   selectable — boolean
 *   numbered   — boolean
 */

import { TRANSITION_COLORS } from "../../assets/styles/pre-set-styles";

export function ListGroup({ items = [], variant = "default", selectable = false, numbered = false }) {
    const wrap = {
        default: "border border-grey-200 dark:border-grey-700 rounded-xl overflow-hidden divide-y divide-grey-200 dark:divide-grey-700",
        flush: "divide-y divide-grey-200 dark:divide-grey-700",
        separated: "space-y-2",
    };

    return (
        <ul className={`font-aumovio ${wrap[variant] ?? wrap.default}`} role="list">
            {items.map((item, i) => (
                <li
                    key={item.id ?? i}
                    onClick={() => !item.disabled && item.onClick?.()}
                    className={`flex items-center gap-3 px-4 py-3 bg-(--bg-surface) dark:bg-(--bg-surface-2) text-sm
            ${TRANSITION_COLORS}
            ${variant === "separated" ? "rounded-xl border border-grey-200 dark:border-grey-700" : ""}
            ${selectable && !item.disabled ? "cursor-pointer hover:bg-orange-50 dark:hover:bg-orange-400/5 hover:text-orange-400" : ""}
            ${item.active ? "bg-orange-50 dark:bg-orange-400/10 text-orange-400 border-l-4 border-orange-400" : ""}
            ${item.disabled ? "opacity-40 cursor-not-allowed" : ""}`}
                >
                    {numbered && <span className="flex items-center justify-center w-6 h-6 text-xs text-orange-400 rounded-full bg-orange-400/10 font-aumovio-bold shrink-0">{i + 1}</span>}
                    {item.icon && <item.icon className="w-4 h-4 text-grey-400 dark:text-grey-500 shrink-0" />}
                    <div className="flex-1 min-w-0">
                        <p className={`font-aumovio-bold truncate ${item.active ? "text-orange-400" : "text-black/85 dark:text-white/85"}`}>{item.label}</p>
                        {item.description && <p className="text-xs text-grey-500 dark:text-grey-400 truncate mt-0.5">{item.description}</p>}
                    </div>
                    {item.meta && <span className="text-xs text-grey-400 dark:text-grey-500 shrink-0">{item.meta}</span>}
                    {item.badge && item.badge}
                </li>
            ))}
        </ul>
    );
}

export default ListGroup;
