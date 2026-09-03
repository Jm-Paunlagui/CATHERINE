/**
 * DocShell — two-column reading shell: an article column and a sticky
 * "On This Page" rail, with an optional full-width header band above both.
 *
 * ── The rail deliberately mirrors Version History's DateJourneyNav ─────────
 * Same card shell (`BASE_COLOR_BG` + `STANDARD_BORDER`, rounded-2xl, p-4,
 * lg:w-72), same header treatment (accent icon + label + short accent
 * underline + a muted count line), same journey line: a 1px vertical connector
 * with a dot per item, an accent-tinted active row, and a trailing chevron.
 * Two rails that do the same job on the same product should not look like they
 * came from different applications — if you restyle one, restyle both.
 *
 * ── Breakpoint and DOM order, also copied from that page ──────────────────
 * The rail appears at `lg` (≥1024px), not `xl`, and the row is
 * `lg:flex-row-reverse` with the NAV FIRST in the DOM. That single ordering
 * gives the mobile stack its natural "browse, then read" sequence while the
 * desktop visual order still puts the rail on the right — one rail instance,
 * never a desktop copy plus a mobile copy. Below `lg` the rail collapses to a
 * disclosure toggle rather than vanishing, so small screens keep the ability
 * to jump between sections.
 *
 * ── Contract with the caller ──────────────────────────────────────────────
 *   • Every `sections[i].id` must match the `id` of an element rendered
 *     inside `children`.
 *   • Those elements need a `scroll-mt-*` utility (`scroll-mt-6` pairs with
 *     the default rail offset) so a jumped-to heading lands with a little
 *     breathing room rather than flush against the top edge.
 *   • `sections` must be referentially stable across renders that did not
 *     actually change the section list — `useScrollSpy` rebuilds its
 *     IntersectionObserver on every new array identity.
 *   • `header` sits ABOVE the article/rail row, not inside the article — it
 *     is not part of `sections` and is never a scrollspy target.
 */

import { faChevronDown, faChevronRight, faListUl } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useState } from "react";

import { BASE_COLOR_BG, BASE_COLOR_TEXT, STANDARD_BORDER, TRANSITION_COLORS } from "../../../assets/styles/pre-set-styles";
import { useScrollSpy } from "./useScrollSpy";

/**
 * One jump target in the rail. Mirrors DateJourneyNav's DateRailItem: the dot
 * sits on the vertical connector drawn by the parent <ul>.
 *
 * @param {{ section: {id: string, label: string}, active: boolean, onJump: Function }} props
 */
function SectionRailItem({ section, active, onJump }) {
    return (
        <li>
            <a
                href={`#${section.id}`}
                onClick={(e) => onJump(e, section.id)}
                aria-current={active ? "location" : undefined}
                className={`group relative w-full flex items-center gap-3 pl-6 pr-2 py-2 rounded-lg text-left ${TRANSITION_COLORS} ${active ? "bg-orange-400/10 dark:bg-orange-400/10" : "hover:bg-grey-100 dark:hover:bg-white/5"}`}
            >
                {/* Rail dot — sits on the vertical connector drawn by the list */}
                <span className={`absolute left-2 w-2 h-2 rounded-full ring-2 ring-(--bg-surface) ${active ? "bg-(--accent-icon)" : "bg-grey-300 dark:bg-white/20"}`} />

                <span className={`flex-1 min-w-0 block text-sm leading-tight truncate ${active ? "font-semibold text-(--accent-foreground)" : `font-medium ${BASE_COLOR_TEXT} opacity-80`}`}>{section.label}</span>

                <FontAwesomeIcon icon={faChevronRight} className={`w-2.5 h-2.5 shrink-0 ${TRANSITION_COLORS} ${active ? "text-(--accent-icon)" : "text-grey-300 dark:text-white/20 group-hover:text-grey-400"}`} />
            </a>
        </li>
    );
}

/**
 * @param {object} props
 * @param {{ id: string, label: string }[]} [props.sections=[]] - Ordered
 *   section registry. An empty array renders the article full-width with no rail.
 * @param {string} [props.title="On This Page"] - Rail heading; also the nav's
 *   accessible name.
 * @param {string} [props.railTop="lg:top-6"] - Tailwind sticky offset for the
 *   rail, measured from the top of the SCROLLPORT — which in this app is
 *   `#app-scroll`, not the viewport. The navbar, sidebar header and breadcrumb
 *   all render OUTSIDE that element, so the offset only needs to buy a little
 *   breathing room; it does not need to clear any chrome.
 * @param {import('react').ReactNode} [props.header=null] - Optional content
 *   rendered full-width above the article/rail row, inside the same padded
 *   container the two columns share.
 * @param {string} [props.className=""] - Extra classes on the outer container.
 * @param {import('react').ReactNode} props.children - The article content.
 */
export function DocShell({ sections = [], title = "On This Page", railTop = "lg:top-6", header = null, className = "", children }) {
    const activeId = useScrollSpy(sections);
    // Mobile disclosure only — the `lg:block` below always reveals the list on
    // desktop regardless of this value, exactly as DateJourneyNav does.
    const [navOpen, setNavOpen] = useState(false);

    /**
     * Smooth-scroll to a section instead of letting the browser hard-jump.
     *
     * The URL hash is deliberately NOT written: this shell renders inside a
     * react-router route, and a manual history write here would race the
     * router's own history handling for no user-visible gain.
     *
     * @param {import('react').MouseEvent<HTMLAnchorElement>} e
     * @param {string} id
     */
    const handleJump = (e, id) => {
        const el = document.getElementById(id);
        if (!el) return; // Anchor not mounted — let the browser resolve the href.
        e.preventDefault();
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        setNavOpen(false); // collapse the mobile disclosure after jumping
    };

    return (
        <div className={`max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 ${className}`}>
            {header && <div className="mb-8">{header}</div>}

            {/* DOM order is nav-then-article so the mobile stack reads "browse,
                then read"; lg:flex-row-reverse flips it to article-left on desktop. */}
            <div className="flex flex-col lg:flex-row-reverse lg:items-start gap-6 lg:gap-8">
                {sections.length > 0 && (
                    <nav aria-label={title} className={`rounded-2xl ${BASE_COLOR_BG} ${STANDARD_BORDER} p-4 lg:w-72 lg:shrink-0 lg:sticky ${railTop}`}>
                        {/* Header — a disclosure toggle on mobile, a plain heading on desktop */}
                        <button type="button" onClick={() => setNavOpen(!navOpen)} aria-expanded={navOpen} className="w-full flex items-center justify-between gap-2 lg:pointer-events-none">
                            <span className="flex items-center gap-2">
                                <FontAwesomeIcon icon={faListUl} className="w-3.5 h-3.5 text-(--accent-icon)" />
                                <span className={`text-sm font-semibold ${BASE_COLOR_TEXT}`}>{title}</span>
                            </span>
                            <FontAwesomeIcon icon={faChevronDown} className={`w-3 h-3 text-grey-400 lg:hidden ${TRANSITION_COLORS} ${navOpen ? "rotate-180" : ""}`} />
                        </button>
                        <span className="block mt-1 w-10 h-0.5 rounded-full bg-(--accent-icon)" />
                        <p className={`mt-2 text-xs ${BASE_COLOR_TEXT} opacity-45`}>
                            {sections.length} section{sections.length !== 1 ? "s" : ""}
                        </p>

                        <div className={`${navOpen ? "block" : "hidden"} lg:block`}>
                            <div className="mt-3 max-h-[22rem] lg:max-h-[calc(100vh-19rem)] overflow-y-auto pr-1">
                                {/* Vertical connector behind the dots — the "journey" line */}
                                <ul className="relative space-y-1 before:absolute before:left-[11px] before:top-2 before:bottom-2 before:w-px before:bg-grey-200 dark:before:bg-white/10">
                                    {sections.map((section) => (
                                        <SectionRailItem key={section.id} section={section} active={section.id === activeId} onJump={handleJump} />
                                    ))}
                                </ul>
                            </div>
                        </div>
                    </nav>
                )}

                <article className="flex-1 min-w-0">{children}</article>
            </div>
        </div>
    );
}

export default DocShell;
