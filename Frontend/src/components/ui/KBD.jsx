/**
 * KBD — Keyboard shortcut display.
 *
 * Props:
 *   keys    — string[] (each key rendered as its own pill)
 *   size    — 'sm'|'md'|'lg'
 *   variant — 'default'|'dark'
 */
import { Fragment } from "react";
import { TRANSITION_COLORS } from "../../assets/styles/pre-set-styles";
const SZ = {
    sm: "text-[10px] px-1.5 py-1",
    md: "text-xs px-2 py-1",
    lg: "text-sm px-3 py-2",
};
const V = {
    default: "bg-white dark:bg-(--bg-surface-3) border border-grey-300 dark:border-grey-600 text-grey-700 dark:text-grey-200 shadow-sm",
    dark: "bg-grey-800 dark:bg-(--bg-surface) border border-grey-700 text-grey-200 shadow-sm",
};

export function KBD({ keys = [], size = "md", variant = "default" }) {
    return (
        <span className="inline-flex items-center gap-1 font-mono">
            {keys.map((key, i) => (
                <Fragment key={`${key}-${i}`}>
                    {i > 0 && <span className="text-xs text-grey-400">+</span>}
                    <kbd
                        className={`inline-flex items-center justify-center rounded font-aumovio-bold
            ${TRANSITION_COLORS} ${SZ[size] ?? SZ.md} ${V[variant] ?? V.default}`}
                    >
                        {key}
                    </kbd>
                </Fragment>
            ))}
        </span>
    );
}

export default KBD;
