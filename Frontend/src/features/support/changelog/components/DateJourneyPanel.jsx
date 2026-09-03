/**
 * DateJourneyPanel.jsx — the content half of the date-wise journey.
 *
 * Shows the ONE selected date: a heading for the day, the releases shipped on
 * it as a dot-and-line timeline, and Older/Newer steppers that walk the
 * journey without going back to the rail.
 */

import { faArrowLeft, faArrowRight, faChevronDown, faChevronUp, faLock, faPen, faTrashCan } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useState } from "react";

import Badge from "../../../../components/ui/Badge";
import { Skeleton } from "../../../../components/ui/Skeleton";

import { ANIMATE_FADE_IN, ANIMATE_FADE_IN_UP, ANIM_DELAY_100, BASE_COLOR_BG, BASE_COLOR_TEXT, STANDARD_BORDER, TITLE_COLOR_TEXT, TRANSITION_COLORS } from "../../../../assets/styles/pre-set-styles";

import { StageBadge, VersionBadge } from "./shared/ChangelogBadges";
import { formatDisplayDate, formatMediumDate, typeMeta } from "./shared/changelogMeta";

// ── Entry sub-components ──────────────────────────────────────────────────────

function AuthorList({ authors, coAuthors }) {
    if (!authors?.length && !coAuthors?.length) return null;
    return (
        <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-xs ${BASE_COLOR_TEXT} opacity-45`}>
            {authors?.length > 0 && (
                <span>
                    <span className="font-semibold opacity-75">By:</span> {authors.join(", ")}
                </span>
            )}
            {coAuthors?.length > 0 && (
                <span>
                    <span className="font-semibold opacity-75">Co-authors:</span> {coAuthors.join(", ")}
                </span>
            )}
        </div>
    );
}

function EntryActions({ entry, isSuperAdmin, onEdit, onDelete }) {
    if (!isSuperAdmin) return null;
    return (
        <div className="flex items-center gap-1 shrink-0">
            <button onClick={() => onEdit(entry)} aria-label="Edit entry" className="p-2 rounded-lg text-grey-400 hover:text-(--blue-foreground) hover:bg-blue-400/10 transition-colors duration-150">
                <FontAwesomeIcon icon={faPen} className="w-3 h-3" />
            </button>
            <button onClick={() => onDelete(entry)} aria-label="Delete entry" className="p-2 rounded-lg text-grey-400 hover:text-danger-400 hover:bg-danger-400/10 transition-colors duration-150">
                <FontAwesomeIcon icon={faTrashCan} className="w-3 h-3" />
            </button>
        </div>
    );
}

/**
 * Collapsible "What Changed" section — collapsed by default.
 * Shows a `▾ N changes` disclosure toggle; expands inline on click.
 * Inspired by GitHub's PR review thread collapse pattern.
 *
 * @param {{ items: Array<{ text: string, items?: string[] }> }} props
 */
function WhatChangedSection({ items }) {
    const [open, setOpen] = useState(false);
    if (!items?.length) return null;

    return (
        <div className="mt-3">
            <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className={`inline-flex items-center gap-2 text-xs font-medium ${BASE_COLOR_TEXT} opacity-45 hover:opacity-75 transition-opacity duration-150`}>
                <FontAwesomeIcon icon={open ? faChevronUp : faChevronDown} className="w-2.5 h-2.5" />
                {open ? "Hide changes" : `${items.length} change${items.length !== 1 ? "s" : ""}`}
            </button>

            {open && (
                <ul className={`mt-2 space-y-2 pl-1 ${ANIMATE_FADE_IN_UP}`}>
                    {items.map((item, i) => (
                        <li key={i} className="flex items-start gap-2">
                            <span className="text-(--accent-icon) mt-0.75 shrink-0 text-xs leading-none select-none">•</span>
                            <div className="min-w-0">
                                <span className={`text-sm leading-snug ${BASE_COLOR_TEXT} opacity-75`}>{item.text}</span>
                                {item.items?.length > 0 && (
                                    <ul className="mt-1 space-y-1 pl-1">
                                        {item.items.map((nested, j) => (
                                            <li key={j} className="flex items-start gap-2">
                                                <span className={`${BASE_COLOR_TEXT} opacity-40 mt-0.75 shrink-0 text-xs leading-none select-none`}>–</span>
                                                <span className={`text-xs leading-snug ${BASE_COLOR_TEXT} opacity-60`}>{nested}</span>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </div>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

/**
 * Single changelog entry rendered as a timeline row.
 * Left column: coloured dot + optional vertical connector to the next entry.
 * Right column: version badge, type badge, title, message, disclosure toggle.
 *
 * @param {{ entry: object, showLine: boolean, isSuperAdmin: boolean, onEdit: Function, onDelete: Function }} props
 */
function ChangelogEntry({ entry, showLine, isSuperAdmin, onEdit, onDelete }) {
    const meta = typeMeta(entry.type);
    return (
        <div className="relative flex gap-4">
            {/* Timeline rail: dot + optional connector line */}
            <div className="relative flex flex-col items-center flex-none w-3 pt-1">
                <div className={`w-2.5 h-2.5 rounded-full shrink-0 ring-2 ring-white dark:ring-(--color-dark-surface-elevated) z-10 ${meta.dotColor}`} />
                {showLine && <div className="mt-2 flex-1 w-px bg-grey-200 dark:bg-white/10 min-h-4" />}
            </div>

            {/* Entry content */}
            <div className={`flex-1 min-w-0 ${showLine ? "pb-7" : "pb-1"}`}>
                {/* Row 1: version badge + type badge (left) · admin actions (right) */}
                <div className="flex items-start justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                        <VersionBadge version={entry.version} />
                        <StageBadge version={entry.version} />
                        <Badge variant={meta.badge} size="xs" pill>
                            <FontAwesomeIcon icon={meta.icon} className="mr-1 w-2.5 h-2.5" />
                            {meta.label}
                        </Badge>
                    </div>
                    <EntryActions entry={entry} isSuperAdmin={isSuperAdmin} onEdit={onEdit} onDelete={onDelete} />
                </div>

                {/* Title */}
                <p className="mt-2 font-semibold text-sm text-black/85 dark:text-white/90 leading-snug">{entry.title}</p>

                {/* Summary message */}
                <p className={`mt-1 text-sm leading-relaxed ${BASE_COLOR_TEXT} opacity-65`}>{entry.message}</p>

                {/* What Changed — collapsed by default */}
                <WhatChangedSection items={entry.whatChanged} />

                {/* Authors */}
                <AuthorList authors={entry.authors} coAuthors={entry.coAuthors} />
            </div>
        </div>
    );
}

// ── Journey stepper ───────────────────────────────────────────────────────────

/**
 * Older / Newer steppers. `olderDate` walks back in time (further down the
 * rail), `newerDate` walks forward — both are null at the ends of the journey.
 *
 * @param {{ olderDate: string|null, newerDate: string|null, onSelect: Function }} props
 */
function JourneySteps({ olderDate, newerDate, onSelect }) {
    if (!olderDate && !newerDate) return null;

    const step = (date, direction) => (
        <button type="button" onClick={() => onSelect(date)} className={`flex-1 min-w-0 flex items-center gap-3 rounded-xl ${STANDARD_BORDER} p-4 text-left ${TRANSITION_COLORS} hover:bg-grey-100 dark:hover:bg-white/5 ${direction === "newer" ? "flex-row-reverse text-right" : ""}`}>
            <FontAwesomeIcon icon={direction === "older" ? faArrowLeft : faArrowRight} className="w-3 h-3 shrink-0 text-(--accent-icon)" />
            <span className="min-w-0">
                <span className={`block text-[10px] uppercase tracking-widest ${BASE_COLOR_TEXT} opacity-40`}>{direction === "older" ? "Older" : "Newer"}</span>
                <span className={`block text-sm font-medium truncate ${BASE_COLOR_TEXT} opacity-80`}>{formatMediumDate(date)}</span>
            </span>
        </button>
    );

    return (
        <div className="flex flex-wrap gap-3 pt-2">
            {olderDate ? step(olderDate, "older") : <span className="flex-1" />}
            {newerDate ? step(newerDate, "newer") : <span className="flex-1" />}
        </div>
    );
}

// ── Panel ─────────────────────────────────────────────────────────────────────

/**
 * @param {{ hook: object }} props
 */
export function DateJourneyPanel({ hook }) {
    const { loading, activeGroup, selectedDate, olderDate, newerDate, selectDate, isSuperAdmin } = hook;

    if (loading) {
        return (
            <div className={`space-y-4 ${ANIMATE_FADE_IN_UP} ${ANIM_DELAY_100}`}>
                <Skeleton className="h-7 w-64 rounded" />
                {[...Array(4)].map((_, i) => (
                    <div key={i} className="flex gap-4">
                        <div className="flex flex-col items-center flex-none w-3 pt-1">
                            <Skeleton className="w-2.5 h-2.5 rounded-full shrink-0" />
                            {i < 3 && <div className="mt-2 flex-1 w-px bg-grey-200 dark:bg-white/10 min-h-12" />}
                        </div>
                        <div className={`flex-1 space-y-2 ${i < 3 ? "pb-7" : "pb-1"}`}>
                            <div className="flex gap-2">
                                <Skeleton className="h-5 w-14 rounded" />
                                <Skeleton className="h-5 w-20 rounded-full" />
                            </div>
                            <Skeleton className="h-4 w-2/3 rounded" />
                            <Skeleton className="h-4 w-full rounded" />
                            <Skeleton className="h-3 w-16 rounded" />
                        </div>
                    </div>
                ))}
            </div>
        );
    }

    if (!activeGroup) {
        return (
            <div className={`text-center py-20 rounded-2xl ${BASE_COLOR_BG} ${STANDARD_BORDER} ${ANIMATE_FADE_IN_UP} ${ANIM_DELAY_100}`}>
                <FontAwesomeIcon icon={faLock} className="text-4xl text-grey-300 dark:text-grey-600 mb-3" />
                <p className={`${BASE_COLOR_TEXT} opacity-60`}>No changelog entries yet.</p>
            </div>
        );
    }

    return (
        // Keyed on the date so the panel replays its enter animation on every hop.
        <div key={selectedDate} className={`space-y-6 ${ANIMATE_FADE_IN}`}>
            {/* Day heading */}
            <div>
                <h2 className={`text-2xl font-bold ${TITLE_COLOR_TEXT}`}>{formatDisplayDate(activeGroup.date)}</h2>
                <p className={`mt-1 text-sm ${BASE_COLOR_TEXT} opacity-55`}>
                    {activeGroup.count} release{activeGroup.count !== 1 ? "s" : ""} shipped this day
                </p>
            </div>

            <div className="pl-1">
                {activeGroup.entries.map((entry, i) => (
                    <ChangelogEntry key={entry.id} entry={entry} showLine={i < activeGroup.entries.length - 1} isSuperAdmin={isSuperAdmin} onEdit={hook.openEdit} onDelete={hook.openDelete} />
                ))}
            </div>

            <JourneySteps olderDate={olderDate} newerDate={newerDate} onSelect={selectDate} />
        </div>
    );
}

export default DateJourneyPanel;
