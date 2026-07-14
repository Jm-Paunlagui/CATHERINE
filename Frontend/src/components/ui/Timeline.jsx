/**
 * Timeline — Vertical list of events in time order.
 *
 * Props:
 *   items  — [{ id, title, description, date, icon?, color?, badge? }]
 *   variant — 'left'|'alternating'
 *   connect — boolean (connecting line)
 */
import { TRANSITION_COLORS } from "../../assets/styles/pre-set-styles";

// `text` (dot/icon foreground) is palette-adaptive for the orange/purple accent
// family (--on-accent-text / --on-secondary-text) — semantic colors keep the
// fixed text-white/bg-white pair since they are not part of the user's palette.
const COLORS = {
    orange: { fill: "bg-orange-400  ring-orange-400/30 dark:ring-orange-400/40", text: "text-(--on-accent-text)", dot: "bg-(--on-accent-text)" },
    purple: { fill: "bg-purple-400  ring-purple-400/30 dark:ring-purple-300/40", text: "text-(--on-secondary-text)", dot: "bg-(--on-secondary-text)" },
    success: { fill: "bg-success-400 ring-success-400/30 dark:ring-success-400/40", text: "text-white", dot: "bg-white" },
    danger: { fill: "bg-danger-400  ring-danger-400/30 dark:ring-danger-400/40", text: "text-white", dot: "bg-white" },
    warn: { fill: "bg-warn-400    ring-warn-400/30 dark:ring-warn-400/40", text: "text-white", dot: "bg-white" },
    blue: { fill: "bg-blue-400    ring-blue-400/30 dark:ring-blue-400/40", text: "text-white", dot: "bg-white" },
    grey: { fill: "bg-grey-400 dark:bg-grey-500 ring-grey-400/30 dark:ring-grey-500/40", text: "text-white", dot: "bg-white" },
};

export function Timeline({ items = [], variant = "left", connect = true }) {
    return (
        <ol className="relative font-aumovio">
            {connect && <div className="absolute left-4 top-4 bottom-4 w-0.5 bg-grey-200 dark:bg-(--bg-surface-3)" />}
            <div className="space-y-8">
                {items.map((item, i) => {
                    const colCfg = COLORS[item.color ?? "orange"] ?? COLORS.orange;
                    return (
                        <li key={item.id ?? i} className="relative flex gap-5 pl-2">
                            {/* Dot */}
                            <div
                                className={`relative z-10 w-8 h-8 rounded-full shrink-0
                flex items-center justify-center ring-4 ${colCfg.text} shadow
                ${TRANSITION_COLORS} ${colCfg.fill}`}
                            >
                                {item.icon ? <item.icon className="w-4 h-4" /> : <span className={`w-2 h-2 rounded-full ${colCfg.dot}`} />}
                            </div>
                            {/* Content */}
                            <div className={`flex-1 pb-2 ${TRANSITION_COLORS}`}>
                                <div className="flex flex-wrap items-center justify-between gap-3 mb-1">
                                    <h3 className="text-sm font-aumovio-bold text-black/85 dark:text-white/90">{item.title}</h3>
                                    <div className="flex items-center gap-2">
                                        {item.badge && item.badge}
                                        <time className="text-xs text-grey-400">{item.date}</time>
                                    </div>
                                </div>
                                {item.description && <p className="text-sm leading-relaxed text-grey-500 dark:text-grey-400">{item.description}</p>}
                            </div>
                        </li>
                    );
                })}
            </div>
        </ol>
    );
}

export default Timeline;
