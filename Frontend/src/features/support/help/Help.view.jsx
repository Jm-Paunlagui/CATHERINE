/**
 * Help.view.jsx — Help Center page.
 *
 * A searchable, categorised Q&A page with role-based content visibility.
 * Two-panel layout with a right rail for category navigation and a main
 * panel for articles.
 *
 * Public route — accessible without authentication. Unauthenticated visitors
 * see only general categories. Authenticated users see categories up to
 * their role level (ADMIN → admin categories, SUPER_ADMIN → everything).
 */

import { ErrorBoundary } from "../../../components/feedback/ErrorBoundary";

import { ANIMATE_FADE_IN_UP, ANIMATE_PAGE_ENTER, ANIM_DELAY_0, BASE_COLOR_TEXT, GRADIENT_COLOR_TEXT, TITLE_COLOR_TEXT } from "../../../assets/styles/pre-set-styles";

import { HelpArticlePanel } from "./components/HelpArticlePanel";
import { HelpCategoryNav } from "./components/HelpCategoryNav";
import { useHelp } from "./help.hook";

function HelpContent() {
    const hook = useHelp();

    return (
        <div className="max-w-6xl mx-auto px-4 py-10 font-aumovio space-y-8">
            {/* ── Header ──────────────────────────────────────────────────── */}
            <div className={`${ANIMATE_FADE_IN_UP} ${ANIM_DELAY_0}`}>
                <h1 className={`text-3xl font-extrabold ${TITLE_COLOR_TEXT}`}>
                    Help <span className={GRADIENT_COLOR_TEXT}>Center</span>
                </h1>
                <p className={`mt-1 text-sm ${BASE_COLOR_TEXT} opacity-70`}>Find answers to common questions about CATHERINE</p>
            </div>

            {/* ── Journey: rail (right on desktop) + article panel ──────── */}
            {/* DOM order is nav-then-panel so the mobile stack reads       */}
            {/* "browse categories, then read"; flex-row-reverse flips it   */}
            {/* to panel-left on desktop.                                   */}
            <div className="flex flex-col lg:flex-row-reverse lg:items-start gap-4 lg:gap-8">
                <HelpCategoryNav hook={hook} />
                <div className="flex-1 min-w-0">
                    <HelpArticlePanel hook={hook} />
                </div>
            </div>

            {/* ── Footer ──────────────────────────────────────────────────── */}
            <div className={`text-center py-6 ${ANIMATE_FADE_IN_UP}`}>
                <p className={`text-sm ${BASE_COLOR_TEXT} opacity-50`}>Can&apos;t find what you&apos;re looking for?</p>
                <p className={`mt-1 text-xs ${BASE_COLOR_TEXT} opacity-40`}>Contact your system administrator for further assistance.</p>
            </div>
        </div>
    );
}

// ── Export ────────────────────────────────────────────────────────────────────

export default function HelpView() {
    return (
        <div className={ANIMATE_PAGE_ENTER}>
            <ErrorBoundary>
                <HelpContent />
            </ErrorBoundary>
        </div>
    );
}
