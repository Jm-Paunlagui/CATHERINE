/**
 * SpeedDial — Floating action button with expandable sub-actions.
 *
 * Props:
 *   icon       — main button icon component
 *   actions    — [{ id, label, icon, onClick, color? }]
 *   direction  — 'up'|'down'|'left'|'right'
 *   position   — 'bottom-right'|'bottom-left'|'top-right'|'top-left'
 *   tooltip    — boolean (show labels)
 */
import { PlusIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { ANIMATE_SCALE_SPRING, HOVER_PRESS, TRANSITION_SMOOTH, TRANSITION_SPRING } from "../../assets/styles/pre-set-styles";

const POSITIONS = {
    "bottom-right": "fixed bottom-6 right-6 z-50",
    "bottom-left": "fixed bottom-6 left-6  z-50",
    "top-right": "fixed top-6 right-6 z-50",
    "top-left": "fixed top-6 left-6  z-50",
};

export function SpeedDial({ icon: Icon = PlusIcon, actions = [], direction = "up", position = "bottom-right", tooltip = true }) {
    const [open, setOpen] = useState(false);
    const isV = direction === "up" || direction === "down";
    const isReverse = direction === "up" || direction === "left";

    const actionList = (
        <div className={`flex ${isV ? "flex-col" : "flex-row"} ${isReverse ? "flex-col-reverse" : ""} gap-3 mb-3`}>
            {actions.map((a, i) => (
                <div
                    key={a.id}
                    className={`flex items-center gap-2 ${TRANSITION_SMOOTH}
          ${open ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4 pointer-events-none"}`}
                    style={{ transitionDelay: open ? `${i * 50}ms` : "0ms" }}
                >
                    {tooltip && isReverse && <span className="px-2 py-1 text-xs bg-white dark:bg-(--bg-surface-3) border border-grey-200 dark:border-grey-600 rounded-lg shadow dark:shadow-black/40 font-aumovio-bold text-black/80 dark:text-white/85 whitespace-nowrap">{a.label}</span>}
                    <button
                        onClick={() => {
                            a.onClick?.();
                            setOpen(false);
                        }}
                        className={`w-10 h-10 rounded-full flex items-center justify-center shadow-lg
              ${TRANSITION_SMOOTH} ${HOVER_PRESS} text-white
              ${a.color ?? "bg-purple-400 hover:bg-purple-500"}`}
                        aria-label={a.label}
                    >
                        <a.icon className="w-5 h-5" />
                    </button>
                </div>
            ))}
        </div>
    );

    return (
        <div className={`${POSITIONS[position]} flex flex-col items-center`}>
            {isReverse && actionList}
            <button
                className={`w-14 h-14 rounded-full bg-orange-400 text-(--on-accent-text) shadow-2xl shadow-orange-400/40
          flex items-center justify-center ${TRANSITION_SPRING} ${HOVER_PRESS} ${ANIMATE_SCALE_SPRING}
          hover:bg-orange-500 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-orange-400/40
          ${open ? "rotate-45" : ""}`}
                onClick={() => setOpen((o) => !o)}
                aria-label={open ? "Close menu" : "Open menu"}
                aria-expanded={open}
            >
                <Icon className="w-6 h-6" />
            </button>
            {!isReverse && actionList}
        </div>
    );
}

export default SpeedDial;
