/**
 * HelpArticleCard.jsx — Individual Q&A item with timeline dot + expand/collapse.
 *
 * Uses the same dot-and-line timeline pattern as ChangelogEntry, combined with
 * a click-to-expand accordion for the answer. The Accordion component is not
 * used directly because we need the timeline rail layout (custom markup).
 *
 * @param {object}   props
 * @param {object}   props.article    — { id, question, answer, tags }
 * @param {string}   props.dotColor   — Tailwind bg class for the timeline dot
 * @param {boolean}  props.showLine   — whether to render the connector line
 * @param {boolean}  props.expanded   — whether the answer is visible
 * @param {Function} props.onToggle   — called with article.id on click
 */

import { ChevronDownIcon } from "@heroicons/react/24/outline";
import { ANIMATE_FADE_IN_UP, TRANSITION_COLORS, TRANSITION_TRANSFORM_SPRING } from "../../../../assets/styles/pre-set-styles";
import { AnswerBody } from "./HelpFormula";

export function HelpArticleCard({ article, dotColor, showLine, expanded, onToggle }) {
    return (
        <div className="relative flex gap-4">
            {/* Timeline rail: dot + optional connector line */}
            <div className="relative flex flex-col items-center flex-none w-3 pt-2">
                <div className={`w-2.5 h-2.5 rounded-full shrink-0 ring-2 ring-white dark:ring-(--color-dark-surface-elevated) z-10 ${dotColor}`} />
                {showLine && <div className="mt-2 flex-1 w-px bg-grey-200 dark:bg-white/10 min-h-4" />}
            </div>

            {/* Content */}
            <div className={`flex-1 min-w-0 ${showLine ? "pb-6" : "pb-1"}`}>
                {/* Question header — clickable */}
                <button type="button" onClick={() => onToggle(article.id)} aria-expanded={expanded} className={`w-full flex items-start justify-between gap-3 text-left group ${TRANSITION_COLORS}`}>
                    <span className="font-semibold text-sm text-black/85 dark:text-white/90 leading-snug group-hover:text-(--accent-foreground)">{article.question}</span>
                    <ChevronDownIcon className={`w-4 h-4 mt-1 shrink-0 text-grey-400 ${TRANSITION_TRANSFORM_SPRING} ${expanded ? "rotate-180 text-(--accent-icon)" : ""}`} />
                </button>

                {/* Answer — collapsible. Rendered in readable paragraph chunks
                    with optional theme-aware highlighting of the key phrases. An
                    article opts in per-answer via `article.answerRender`
                    ({ chunk, highlight, ... }); without it the answer renders as
                    a single plain <p>. The source `article.answer` string is
                    never mutated — chunking and highlighting happen only at
                    render time, so the search index and content tests still read
                    it verbatim. */}
                {expanded && (
                    <div className={`mt-3 ${ANIMATE_FADE_IN_UP}`}>
                        <AnswerBody text={article.answer} {...(article.answerRender ?? {})} />

                        {/* Rich detail content (JSX) — formulas, tables, step lists */}
                        {article.detail && <div className="mt-3">{article.detail}</div>}

                        {/* Tags — quiet search-keyword chips. Deliberately low
                            visual weight (ghost/outline, muted) so they read as
                            metadata beneath the answer, not as actionable pills
                            competing with the DefList accent bars above them. A
                            hairline divider separates them from the content. */}
                        {article.tags?.length > 0 && (
                            <div className="mt-4 pt-3 border-t border-grey-200/70 dark:border-white/10">
                                <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5">
                                    {article.tags.map((tag) => (
                                        <span
                                            key={tag}
                                            className="inline-flex items-center text-[11px] leading-none rounded-md px-1.5 py-1 text-grey-500 dark:text-white/45 border border-grey-200 dark:border-white/10 hover:text-grey-600 dark:hover:text-white/60 hover:border-grey-300 dark:hover:border-white/20 transition-colors"
                                        >
                                            <span className="opacity-50 mr-0.5">#</span>
                                            {tag}
                                        </span>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

export default HelpArticleCard;
