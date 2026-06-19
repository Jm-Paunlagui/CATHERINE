/**
 * DocShell.jsx — Layout wrapper for documentation pages (Tailwind-docs style).
 *
 * Renders the article column on the left and a right-hand "On this page" rail
 * that scroll-spies the section registry. Used inside the normal app shell, so
 * the rail's sticky offset is layout-aware:
 *   • sidebar mode → inner content area scrolls (header above it) → small offset
 *   • top mode     → window scrolls under the sticky Navbar (h-16) → clear the bar
 *
 * Shared (tier 3) by Getting Started, Database Connection, and any future docs view.
 */

import { useCallback } from "react";
import { TRANSITION_SMOOTH } from "../../../assets/styles/pre-set-styles";
import { useLayout } from "../../../contexts/layout/LayoutContext";
import { useScrollSpy } from "./useScrollSpy";

// ── "On this page" rail (right) ───────────────────────────────────────────────
function OnThisPage({ sections, activeSection, onJump }) {
    return (
        <nav>
            <p className="text-[11px] font-aumovio-bold uppercase tracking-widest text-grey-400 mb-3 pl-4">On this page</p>
            <ul className="border-l border-grey-200/60 dark:border-grey-700/40 space-y-px">
                {sections.map((s) => {
                    const isActive = activeSection === s.id;
                    return (
                        <li key={s.id}>
                            <a
                                href={`#${s.id}`}
                                onClick={(e) => onJump(e, s.id)}
                                className={`block -ml-px pl-4 py-1.5 text-sm border-l-2 ${TRANSITION_SMOOTH}
                                    ${isActive ? "border-orange-400 text-(--accent-foreground) font-aumovio-bold" : "border-transparent text-(--text-secondary) hover:text-(--text-primary) hover:border-grey-300 dark:hover:border-grey-600"}`}
                            >
                                {s.label}
                            </a>
                        </li>
                    );
                })}
            </ul>
        </nav>
    );
}

/**
 * @param {object} props
 * @param {{id: string, label: string}[]} props.sections  Section registry (stable ref).
 * @param {React.ReactNode} props.children  The article content (sections with matching ids).
 * @returns {JSX.Element}
 */
export function DocShell({ sections, children }) {
    const { layout } = useLayout();
    const activeSection = useScrollSpy(sections);

    // sidebar mode → inner content div scrolls (header above it) → small offset.
    // top mode → window scrolls under the sticky Navbar (h-16) → clear the bar.
    const railTop = layout === "sidebar" ? "top-6" : "top-20";

    const handleJump = useCallback((e, id) => {
        e.preventDefault();
        document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, []);

    return (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 font-aumovio">
            <div className="flex gap-10">
                {/* ── Article ───────────────────────────────────────────────── */}
                <article className="min-w-0 flex-1 max-w-4xl">{children}</article>

                {/* ── "On this page" rail (desktop only) ────────────────────── */}
                <aside className="hidden xl:block w-56 shrink-0">
                    <div className={`sticky ${railTop} max-h-[calc(100vh-8rem)] overflow-y-auto pb-8`}>
                        <OnThisPage sections={sections} activeSection={activeSection} onJump={handleJump} />
                    </div>
                </aside>
            </div>
        </div>
    );
}

export default DocShell;
