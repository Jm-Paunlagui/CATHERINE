/**
 * HelpCategoryNav.jsx — Right-rail category navigation for the Help Center.
 *
 * Sticky sidebar on desktop, collapsible disclosure on mobile. Categories are
 * grouped by role tier with section dividers. Search matches show per-category
 * hit counts as badges.
 *
 * @param {object} props
 * @param {object} props.hook — return value of useHelp()
 */

import { faChevronDown } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { LuCircleHelp } from "react-icons/lu";

import { SearchInput } from "../../../../components/forms/SearchInput";
import Badge from "../../../../components/ui/Badge";

import { ANIMATE_FADE_IN_UP, ANIM_DELAY_100, BASE_COLOR_BG, BASE_COLOR_TEXT, STANDARD_BORDER, TRANSITION_COLORS } from "../../../../assets/styles/pre-set-styles";

import { ROLE_TIERS } from "../help.data";

/** @type {Record<string, string>} category color → dot bg class */
const DOT_COLORS = {
    blue: "bg-blue-400",
    orange: "bg-orange-400",
    yellow: "bg-warn-400",
    grey: "bg-grey-400",
    purple: "bg-purple-400",
    turquoise: "bg-teal-400",
    red: "bg-danger-400",
};

/** Section divider labels by tier boundary. Tier 0 (general) has no divider. */
const TIER_LABELS = {
    1: "Admin",
    2: "Super Admin",
};

/** Fallback divider label for a `roles`-scoped category that omits `roleGroup`. */
const DEFAULT_ROLE_GROUP_LABEL = "Role-Scoped";

/**
 * Group key + divider label for one category. Role-scoped categories
 * (`cat.roles` allow-list — see help.data.jsx header for why a tier cannot
 * express "signed-in-only, exactly this role") form their own group, keyed by
 * `cat.roleGroup` so two DIFFERENT role-scoped features never share one divider
 * label — without it, every `roles`-array category would collapse into a single
 * generic group and the second one's rows would print under the first one's
 * name.
 *
 * @param {import("../help.data").HelpCategory} cat
 * @returns {{ key: string, label: string|null }}
 */
function categoryGroup(cat) {
    if (Array.isArray(cat.roles)) {
        const label = cat.roleGroup ?? DEFAULT_ROLE_GROUP_LABEL;
        return { key: `roles-${label}`, label };
    }
    const tier = ROLE_TIERS[cat.minRole] ?? 0;
    return { key: `tier-${tier}`, label: TIER_LABELS[tier] ?? null };
}

/**
 * @param {object} props
 * @param {object} props.hook
 */
export function HelpCategoryNav({ hook }) {
    const { visibleCategories, selectedCategoryId, selectCategory, searchQuery, setSearchQuery, categoryMatchCounts, totalArticleCount, navOpen, setNavOpen } = hook;

    const isSearching = !!searchQuery.trim();

    // Group categories for section dividers (tier ladder + role-scoped
    // groups). Derived up front rather than tracked with a mutable cursor
    // inside the map callback — a reassignment there is a render-phase write
    // (react-hooks/immutability) and reads wrong on a re-render.
    const groups = visibleCategories.map(categoryGroup);

    return (
        <nav aria-label="Help categories" className={`rounded-2xl ${BASE_COLOR_BG} ${STANDARD_BORDER} p-4 lg:w-72 lg:shrink-0 lg:sticky lg:top-6 ${ANIMATE_FADE_IN_UP} ${ANIM_DELAY_100}`}>
            {/* Header — disclosure toggle on mobile, plain heading on desktop */}
            <button type="button" onClick={() => setNavOpen(!navOpen)} aria-expanded={navOpen} className="w-full flex items-center justify-between gap-2 lg:pointer-events-none">
                <span className="flex items-center gap-2">
                    <LuCircleHelp className="w-4 h-4 text-(--accent-icon)" strokeWidth={1.75} />
                    <span className={`text-sm font-semibold ${BASE_COLOR_TEXT}`}>Categories</span>
                </span>
                <FontAwesomeIcon icon={faChevronDown} className={`w-3 h-3 text-grey-400 lg:hidden ${TRANSITION_COLORS} ${navOpen ? "rotate-180" : ""}`} />
            </button>

            <span className="block mt-1 w-10 h-0.5 rounded-full bg-(--accent-icon)" />

            <p className={`mt-2 text-xs ${BASE_COLOR_TEXT} opacity-45`}>
                {totalArticleCount} article{totalArticleCount !== 1 ? "s" : ""} · {visibleCategories.length} categor{visibleCategories.length !== 1 ? "ies" : "y"}
            </p>

            {/* Collapsible body */}
            <div className={`${navOpen ? "block" : "hidden"} lg:block`}>
                {/* Search — AI gradient comet lights up while typing (built into SearchInput). */}
                <div className="mt-3">
                    <SearchInput value={searchQuery} onChange={setSearchQuery} placeholder="Search help…" size="sm" debounce={200} />
                </div>

                {/* Category list */}
                <div className="mt-3 max-h-[22rem] lg:max-h-[calc(100vh-19rem)] overflow-y-auto pr-1">
                    {/* "All Categories" option */}
                    <button type="button" onClick={() => selectCategory(null)} className={`group relative w-full flex items-center gap-3 pl-6 pr-2 py-2 rounded-lg text-left ${TRANSITION_COLORS} ${!selectedCategoryId ? "bg-orange-400/10 dark:bg-orange-400/10" : "hover:bg-grey-100 dark:hover:bg-white/5"}`}>
                        <span className={`absolute left-2 w-2 h-2 rounded-full ring-2 ring-white dark:ring-(--color-dark-surface-elevated) ${!selectedCategoryId ? "bg-(--accent-icon)" : "bg-grey-300 dark:bg-white/20"}`} />
                        <span className={`flex-1 text-sm leading-tight ${!selectedCategoryId ? "font-semibold text-(--accent-foreground)" : `font-medium ${BASE_COLOR_TEXT} opacity-80`}`}>All Categories</span>
                        {isSearching && (
                            <Badge variant="grey" size="xs" pill>
                                {totalArticleCount}
                            </Badge>
                        )}
                    </button>

                    {/* Vertical connector behind dots */}
                    <ul className="relative space-y-1 before:absolute before:left-[11px] before:top-2 before:bottom-2 before:w-px before:bg-grey-200 dark:before:bg-white/10">
                        {visibleCategories.map((cat, i) => {
                            const group = groups[i];
                            const active = selectedCategoryId === cat.id;
                            const dotColor = DOT_COLORS[cat.color] ?? "bg-grey-400";
                            const count = categoryMatchCounts[cat.id] ?? 0;

                            // Show a section divider when crossing a group boundary
                            const startsGroup = i === 0 || groups[i - 1].key !== group.key;
                            const divider =
                                startsGroup && group.label ? (
                                    <li key={`divider-${group.key}`} className="pt-3 pb-1 pl-6">
                                        <span className={`text-[10px] font-semibold uppercase tracking-widest ${BASE_COLOR_TEXT} opacity-40`}>{group.label}</span>
                                    </li>
                                ) : null;

                            return (
                                <li key={cat.id}>
                                    {divider}
                                    <button type="button" onClick={() => selectCategory(cat.id)} title={cat.description} className={`group relative w-full flex items-center gap-3 pl-6 pr-2 py-2 rounded-lg text-left ${TRANSITION_COLORS} ${active ? "bg-orange-400/10 dark:bg-orange-400/10" : "hover:bg-grey-100 dark:hover:bg-white/5"}`}>
                                        {/* Rail dot */}
                                        <span className={`absolute left-2 w-2 h-2 rounded-full ring-2 ring-white dark:ring-(--color-dark-surface-elevated) ${active ? dotColor : "bg-grey-300 dark:bg-white/20"}`} />

                                        <span className={`flex-1 min-w-0 text-sm leading-tight truncate ${active ? "font-semibold text-(--accent-foreground)" : `font-medium ${BASE_COLOR_TEXT} opacity-80`}`}>{cat.label}</span>

                                        {/* Match count badge when searching */}
                                        {isSearching && count > 0 && (
                                            <Badge variant="grey" size="xs" pill>
                                                {count}
                                            </Badge>
                                        )}

                                        {/* Dim categories with zero matches while searching */}
                                        {isSearching && count === 0 && <span className={`text-[10px] ${BASE_COLOR_TEXT} opacity-30`}>0</span>}
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                </div>
            </div>
        </nav>
    );
}

export default HelpCategoryNav;
