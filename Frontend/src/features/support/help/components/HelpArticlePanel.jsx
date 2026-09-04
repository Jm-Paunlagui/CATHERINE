/**
 * HelpArticlePanel.jsx — Main content area for the Help Center.
 *
 * Renders filtered Q&A articles grouped by category, using a timeline
 * dot-and-line pattern. Re-mounts on category change (via key prop) to replay
 * the enter animation.
 *
 * @param {object} props
 * @param {object} props.hook — return value of useHelp()
 */

import { MagnifyingGlassIcon } from "@heroicons/react/24/outline";

import Button from "../../../../components/ui/Button";
import { Skeleton } from "../../../../components/ui/Skeleton";

import { ANIMATE_FADE_IN, ANIMATE_FADE_IN_UP, ANIM_DELAY_100, BASE_COLOR_BG, BASE_COLOR_TEXT, STANDARD_BORDER, TITLE_COLOR_TEXT, staggerDelay } from "../../../../assets/styles/pre-set-styles";

import { HelpArticleCard } from "./HelpArticleCard";

/** @type {Record<string, string>} category color → timeline dot bg class */
const DOT_COLORS = {
    blue: "bg-blue-400",
    orange: "bg-orange-400",
    yellow: "bg-warn-400",
    grey: "bg-grey-400",
    purple: "bg-purple-400",
    turquoise: "bg-teal-400",
    red: "bg-danger-400",
};

/**
 * @param {object} props
 * @param {object} props.hook
 */
export function HelpArticlePanel({ hook }) {
    const { isLoading, filteredCategories, searchQuery, selectedCategoryId, expandedArticleId, toggleArticle, clearFilters, matchCount, suggestion, applySuggestion } = hook;

    // ── Loading skeleton ──────────────────────────────────────────────────────
    if (isLoading) {
        return (
            <div className={`space-y-4 ${ANIMATE_FADE_IN_UP} ${ANIM_DELAY_100}`}>
                <Skeleton className="h-7 w-64 rounded" />
                {[...Array(4)].map((_, i) => (
                    <div key={i} className="flex gap-4">
                        <div className="flex flex-col items-center flex-none w-3 pt-2">
                            <Skeleton className="w-2.5 h-2.5 rounded-full shrink-0" />
                            {i < 3 && <div className="mt-2 flex-1 w-px bg-grey-200 dark:bg-white/10 min-h-12" />}
                        </div>
                        <div className={`flex-1 space-y-2 ${i < 3 ? "pb-6" : "pb-1"}`}>
                            <Skeleton className="h-4 w-4/5 rounded" />
                            <Skeleton className="h-3 w-2/3 rounded" />
                        </div>
                    </div>
                ))}
            </div>
        );
    }

    // ── Empty state ───────────────────────────────────────────────────────────
    if (filteredCategories.length === 0) {
        const trimmed = searchQuery.trim();
        return (
            <div className={`text-center py-20 rounded-2xl ${BASE_COLOR_BG} ${STANDARD_BORDER} ${ANIMATE_FADE_IN_UP} ${ANIM_DELAY_100}`}>
                <MagnifyingGlassIcon className="w-10 h-10 mx-auto text-grey-300 dark:text-grey-600 mb-3" />
                {trimmed ? (
                    <>
                        <p className={`${BASE_COLOR_TEXT} opacity-70`}>Sorry, we couldn&apos;t find anything for &ldquo;{trimmed}&rdquo;.</p>
                        {suggestion && (
                            <p className={`mt-2 text-sm ${BASE_COLOR_TEXT} opacity-60`}>
                                Did you mean{" "}
                                <button type="button" onClick={applySuggestion} className="font-semibold text-orange-400 hover:text-orange-500 dark:hover:text-orange-300 underline underline-offset-2 transition-colors">
                                    {suggestion}
                                </button>
                                ?
                            </p>
                        )}
                    </>
                ) : (
                    <p className={`${BASE_COLOR_TEXT} opacity-60`}>No articles available.</p>
                )}
                {(trimmed || selectedCategoryId) && (
                    <Button variant="ghost" size="sm" className="mt-4" onClick={clearFilters}>
                        Clear filters
                    </Button>
                )}
            </div>
        );
    }

    // ── Article list ──────────────────────────────────────────────────────────
    // Track a global article index for stagger delay across categories
    let globalIndex = 0;

    return (
        <div key={selectedCategoryId ?? "all"} className={`space-y-8 ${ANIMATE_FADE_IN}`}>
            {/* Search results summary */}
            {searchQuery.trim() && (
                <p className={`text-sm ${BASE_COLOR_TEXT} opacity-55`}>
                    {matchCount} result{matchCount !== 1 ? "s" : ""} for &ldquo;{searchQuery.trim()}&rdquo;
                </p>
            )}

            {filteredCategories.map((cat) => {
                const dotColor = DOT_COLORS[cat.color] ?? "bg-grey-400";
                const Icon = cat.icon;

                return (
                    <section key={cat.id}>
                        {/* Category heading */}
                        <div className="mb-4">
                            <h2 className={`flex items-center gap-2 text-lg font-bold ${TITLE_COLOR_TEXT}`}>
                                <Icon className="w-5 h-5 text-(--accent-icon) shrink-0" strokeWidth={1.75} />
                                {cat.label}
                            </h2>
                            <p className={`mt-1 text-sm ${BASE_COLOR_TEXT} opacity-55`}>{cat.description}</p>
                        </div>

                        {/* Articles timeline */}
                        <div className="pl-1">
                            {cat.articles.map((article, i) => {
                                const stagger = staggerDelay(globalIndex);
                                globalIndex++;

                                return (
                                    <div key={article.id} className={`${ANIMATE_FADE_IN_UP} ${stagger}`}>
                                        <HelpArticleCard article={article} dotColor={dotColor} showLine={i < cat.articles.length - 1} expanded={expandedArticleId === article.id} onToggle={toggleArticle} />
                                    </div>
                                );
                            })}
                        </div>
                    </section>
                );
            })}
        </div>
    );
}

export default HelpArticlePanel;
