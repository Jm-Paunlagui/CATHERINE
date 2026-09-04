/**
 * DateJourneyNav.jsx — the date-wise journey rail.
 *
 * Renders every release DATE (not every release) as a jump target, newest
 * first, grouped under sticky year headers. Picking a date swaps the panel
 * beside it — the page shows one date at a time instead of pouring 166
 * releases across 63 dates into a single scroll.
 *
 * Layout note: the rail is ONE instance, not a desktop copy plus a mobile
 * copy. The parent flex container is `lg:flex-row-reverse`, so DOM order
 * (nav first) gives the mobile stack its natural "browse, then read" order
 * while the visual order on desktop puts the rail on the right.
 */

import { faCalendarDays, faChevronDown, faChevronRight } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useEffect, useRef } from "react";

import { SearchInput } from "../../../../components/forms/SearchInput";
import { Skeleton } from "../../../../components/ui/Skeleton";

import { BASE_COLOR_BG, BASE_COLOR_TEXT, STANDARD_BORDER, TRANSITION_COLORS } from "../../../../assets/styles/pre-set-styles";

import { formatDisplayDate, formatRailDate, formatRailWeekday, typeMeta } from "./shared/changelogMeta";

/**
 * One date row in the rail.
 *
 * @param {{ group: object, active: boolean, onSelect: Function }} props
 */
function DateRailItem({ group, active, onSelect }) {
    const ref = useRef(null);

    // Keep the active date in view when the selection changes from OUTSIDE the
    // rail (deep link on load, prev/next buttons in the panel). `scrollIntoView`
    // is absent in jsdom, hence the optional call.
    useEffect(() => {
        if (active) ref.current?.scrollIntoView?.({ block: "nearest" });
    }, [active]);

    return (
        <li>
            <button
                ref={ref}
                type="button"
                onClick={() => onSelect(group.date)}
                aria-current={active ? "true" : undefined}
                title={formatDisplayDate(group.date)}
                className={`group relative w-full flex items-center gap-3 pl-6 pr-2 py-2 rounded-lg text-left ${TRANSITION_COLORS} ${active ? "bg-orange-400/10 dark:bg-orange-400/10" : "hover:bg-grey-100 dark:hover:bg-white/5"}`}
            >
                {/* Rail dot — sits on the vertical connector drawn by the list */}
                <span className={`absolute left-2 w-2 h-2 rounded-full ring-2 ring-white dark:ring-(--color-dark-surface-elevated) ${active ? "bg-(--accent-icon)" : "bg-grey-300 dark:bg-white/20"}`} />

                <span className="flex-1 min-w-0">
                    <span className={`block text-sm leading-tight truncate ${active ? `font-semibold text-(--accent-foreground)` : `font-medium ${BASE_COLOR_TEXT} opacity-80`}`}>{formatRailDate(group.date)}</span>
                    <span className={`block text-[10px] uppercase tracking-wide ${BASE_COLOR_TEXT} opacity-40`}>
                        {formatRailWeekday(group.date)} · {group.count} release{group.count !== 1 ? "s" : ""}
                    </span>
                </span>

                {/* Type dots — a glanceable summary of what shipped that day */}
                <span className="flex items-center gap-1 shrink-0">
                    {group.types.slice(0, 4).map((t) => (
                        <span key={t} title={typeMeta(t).label} className={`w-1.5 h-1.5 rounded-full ${typeMeta(t).dotColor}`} />
                    ))}
                </span>

                <FontAwesomeIcon icon={faChevronRight} className={`w-2.5 h-2.5 shrink-0 ${TRANSITION_COLORS} ${active ? "text-(--accent-icon)" : "text-grey-300 dark:text-white/20 group-hover:text-grey-400"}`} />
            </button>
        </li>
    );
}

/**
 * @param {{ hook: object }} props
 */
export function DateJourneyNav({ hook }) {
    const { dateGroups, filteredDateGroups, selectedDate, selectDate, dateQuery, setDateQuery, navOpen, setNavOpen, loading } = hook;

    // Year → its groups, preserving the newest-first order of the filtered list.
    const years = [];
    for (const group of filteredDateGroups) {
        const last = years[years.length - 1];
        if (last?.year === group.year) last.groups.push(group);
        else years.push({ year: group.year, groups: [group] });
    }

    return (
        <nav aria-label="Release notes by date" className={`rounded-2xl ${BASE_COLOR_BG} ${STANDARD_BORDER} p-4 lg:w-72 lg:shrink-0 lg:sticky lg:top-6`}>
            {/* Header — a disclosure toggle on mobile, a plain heading on desktop */}
            <button type="button" onClick={() => setNavOpen(!navOpen)} aria-expanded={navOpen} className="w-full flex items-center justify-between gap-2 lg:pointer-events-none">
                <span className="flex items-center gap-2">
                    <FontAwesomeIcon icon={faCalendarDays} className="w-3.5 h-3.5 text-(--accent-icon)" />
                    <span className={`text-sm font-semibold ${BASE_COLOR_TEXT}`}>Release Notes</span>
                </span>
                <FontAwesomeIcon icon={faChevronDown} className={`w-3 h-3 text-grey-400 lg:hidden ${TRANSITION_COLORS} ${navOpen ? "rotate-180" : ""}`} />
            </button>
            <span className="block mt-1 w-10 h-0.5 rounded-full bg-(--accent-icon)" />
            <p className={`mt-2 text-xs ${BASE_COLOR_TEXT} opacity-45`}>
                {hook.totalReleases} release{hook.totalReleases !== 1 ? "s" : ""} across {dateGroups.length} date{dateGroups.length !== 1 ? "s" : ""}
            </p>

            <div className={`${navOpen ? "block" : "hidden"} lg:block`}>
                {loading ? (
                    <div className="mt-4 space-y-2">
                        {[...Array(6)].map((_, i) => (
                            <Skeleton key={i} className="h-9 w-full rounded-lg" />
                        ))}
                    </div>
                ) : (
                    <>
                        <div className="mt-3">
                            <SearchInput value={dateQuery} onChange={setDateQuery} placeholder="Search date or version…" size="sm" debounce={150} />
                        </div>

                        {filteredDateGroups.length === 0 ? (
                            <p className={`mt-4 text-xs text-center py-6 ${BASE_COLOR_TEXT} opacity-45`}>No dates match “{dateQuery}”.</p>
                        ) : (
                            <div className="mt-3 max-h-[22rem] lg:max-h-[calc(100vh-19rem)] overflow-y-auto pr-1">
                                {years.map(({ year, groups }) => (
                                    <div key={year}>
                                        <p className={`sticky top-0 z-10 py-2 text-[10px] font-semibold uppercase tracking-widest ${BASE_COLOR_BG} ${BASE_COLOR_TEXT} opacity-50`}>{year}</p>
                                        {/* Vertical connector behind the dots — the "journey" line */}
                                        <ul className="relative space-y-1 before:absolute before:left-[11px] before:top-2 before:bottom-2 before:w-px before:bg-grey-200 dark:before:bg-white/10">
                                            {groups.map((group) => (
                                                <DateRailItem key={group.date} group={group} active={group.date === selectedDate} onSelect={selectDate} />
                                            ))}
                                        </ul>
                                    </div>
                                ))}
                            </div>
                        )}
                    </>
                )}
            </div>
        </nav>
    );
}

export default DateJourneyNav;
