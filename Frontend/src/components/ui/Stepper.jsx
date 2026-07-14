/**
 * Stepper — Multi-step wizard progress indicator.
 *
 * Props:
 *   steps   — [{ id, label, description?, icon? }]
 *   current — current step index (0-based)
 *   variant — 'default'|'numbered'|'icon'
 *   orientation — 'horizontal'|'vertical'
 */

import { CheckIcon } from "@heroicons/react/24/outline";
import { ANIMATE_ENTER_UP, staggerDelay, TRANSITION_COLORS } from "../../assets/styles/pre-set-styles";

export function Stepper({ steps = [], current = 0, variant = "numbered", orientation = "horizontal" }) {
    const isV = orientation === "vertical";

    return (
        <div className={`font-aumovio flex ${isV ? "flex-col gap-0" : "flex-row items-center gap-0"}`}>
            {steps.map((step, i) => {
                const done = i < current;
                const active = i === current;
                const pending = i > current;

                return (
                    <div key={step.id ?? i} className={`flex ${isV ? "flex-row gap-4" : "flex-col items-center"} flex-1 last:flex-none`}>
                        <div className={`flex ${isV ? "flex-col items-center" : "flex-row items-center w-full"}`}>
                            {/* Circle */}
                            <div
                                className={`flex items-center justify-center rounded-full font-aumovio-bold shrink-0
                ${TRANSITION_COLORS} ${ANIMATE_ENTER_UP} ${staggerDelay(i)} z-10
                ${done ? "w-8 h-8 bg-orange-400 text-(--on-accent-text) shadow-lg shadow-orange-400/30" : ""}
                ${active ? "w-8 h-8 bg-orange-400 text-(--on-accent-text) ring-4 ring-orange-400/30 shadow-lg shadow-orange-400/30" : ""}
                ${pending ? "w-8 h-8 bg-grey-100 dark:bg-(--bg-surface-3) text-grey-400 border-2 border-grey-300 dark:border-grey-600" : ""}`}
                            >
                                {done ? <CheckIcon className="w-4 h-4" /> : step.icon && variant === "icon" ? <step.icon className="w-4 h-4" /> : <span className="text-xs">{i + 1}</span>}
                            </div>

                            {/* Connector */}
                            {i < steps.length - 1 && (
                                <div
                                    className={`flex-1 ${TRANSITION_COLORS}
                  ${isV ? "w-0.5 h-8 mx-auto my-1" : "h-0.5 mx-2"}
                  ${done || active ? "bg-orange-400" : "bg-grey-200 dark:bg-(--bg-surface-3)"}`}
                                />
                            )}
                        </div>

                        {/* Label */}
                        <div className={`${isV ? "pb-6 flex-1" : "mt-2 text-center"} min-w-0`}>
                            <p
                                className={`text-xs font-aumovio-bold truncate
                ${active ? "text-(--accent-foreground)" : done ? "text-black/70 dark:text-white/70" : "text-grey-400"}`}
                            >
                                {step.label}
                            </p>
                            {step.description && <p className="text-xs text-grey-400 dark:text-grey-400 mt-0.5 line-clamp-2">{step.description}</p>}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

export default Stepper;
