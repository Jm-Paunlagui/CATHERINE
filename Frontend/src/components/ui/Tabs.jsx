/**
 * Tabs — Tabbed content navigation.
 *
 * Props:
 *   tabs       — [{ id, label, icon?, badge?, disabled?, content: ReactNode }]
 *   defaultTab — id (uncontrolled initial tab)
 *   activeTab  — id (optional, controlled). When provided the parent owns the
 *                active tab; pair with onChange to drive it (e.g. an email
 *                deep-link switching to a specific tab). Omit for uncontrolled.
 *   variant    — 'underline'|'pill'|'boxed'|'vertical'
 *   size       — 'sm'|'md'|'lg'
 *   fullWidth  — boolean
 */
import { useState } from "react";
import { TRANSITION_COLORS } from "../../assets/styles/pre-set-styles";

const SZ = {
    sm: "px-3 py-1.5 text-xs",
    md: "px-4 py-2 text-sm",
    lg: "px-5 py-3 text-base",
};

export function Tabs({ tabs = [], defaultTab, activeTab: controlledTab, variant = "underline", size = "md", fullWidth = false, onChange }) {
    const [internalActive, setInternalActive] = useState(defaultTab ?? tabs[0]?.id);
    // Controlled when an activeTab id is supplied; otherwise self-managed.
    const isControlled = controlledTab != null;
    const active = isControlled ? controlledTab : internalActive;
    const currentTab = tabs.find((t) => t.id === active);
    const sz = SZ[size] ?? SZ.md;

    const NAV_STYLES = {
        underline: "border-b border-grey-200 dark:border-grey-700 flex gap-1",
        pill: "flex gap-1 p-1 bg-grey-100 dark:bg-(--bg-surface-3) rounded-xl w-fit",
        boxed: "flex gap-0 border border-grey-200 dark:border-grey-700 rounded-xl overflow-hidden w-fit",
        vertical: "flex flex-col gap-1 border-r border-grey-200 dark:border-grey-700 pr-2",
    };

    const TAB_STYLES = {
        underline: (a) => `border-b-2 ${TRANSITION_COLORS} font-aumovio-bold
            ${a ? "border-orange-400 text-orange-400" : "border-transparent text-grey-500 hover:text-orange-400 hover:border-orange-200"}`,
        pill: (a) => `rounded-lg ${TRANSITION_COLORS} font-aumovio-bold
            ${a ? "bg-(--bg-surface) dark:bg-(--bg-surface-2) text-orange-400 shadow-sm" : "text-grey-500 hover:text-orange-400"}`,
        boxed: (a) => `border-r last:border-0 border-grey-200 dark:border-grey-700 font-aumovio-bold
            ${TRANSITION_COLORS}
            ${a ? "bg-orange-400 text-white" : "bg-(--bg-surface) dark:bg-(--bg-surface-2) text-grey-500 hover:bg-orange-50 dark:hover:bg-orange-400/10 hover:text-orange-400"}`,
        vertical: (a) => `rounded-lg text-left ${TRANSITION_COLORS} font-aumovio-bold
            ${a ? "bg-orange-50 dark:bg-orange-400/10 text-orange-400" : "text-grey-500 hover:bg-grey-100 dark:hover:bg-(--bg-surface-3) hover:text-orange-400"}`,
    };

    return (
        <div className={`font-aumovio ${variant === "vertical" ? "flex gap-6" : ""}`}>
            <div className={NAV_STYLES[variant]}>
                {tabs.map((tab) => (
                    <button
                        key={tab.id}
                        onClick={() => {
                            if (!tab.disabled && tab.id !== active) {
                                if (!isControlled) setInternalActive(tab.id);
                                onChange?.(tab.id);
                            }
                        }}
                        disabled={tab.disabled}
                        className={`flex items-center gap-1.5 whitespace-nowrap
              disabled:opacity-40 disabled:cursor-not-allowed
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400/40 rounded
              ${sz} ${fullWidth ? "flex-1 justify-center" : ""}
              ${(TAB_STYLES[variant] ?? TAB_STYLES.underline)(tab.id === active)}`}
                    >
                        {tab.icon && <tab.icon className="w-4 h-4 shrink-0" />}
                        {tab.label}
                        {tab.badge !== undefined && (
                            <span
                                className={`text-[10px] px-1.5 py-0.5 rounded-full font-aumovio-bold
                ${tab.id === active ? "bg-white/20 text-white" : "bg-orange-400/10 dark:bg-orange-400/20 text-orange-400 dark:text-orange-300"}`}
                            >
                                {tab.badge}
                            </span>
                        )}
                    </button>
                ))}
            </div>
            <div className={`${variant !== "vertical" ? "mt-4" : "flex-1"}`}>{currentTab?.content}</div>
        </div>
    );
}

export default Tabs;
