/**
 * Breadcrumb — Nav-config-aware page hierarchy navigation.
 *
 * Supports two modes:
 *
 * 1. **Manual** — pass `items` array explicitly.
 *    items     — [{ label, href?, icon? }]  (last item = current, no link)
 *
 * 2. **Auto** — set `auto` prop. Reads the current URL and cross-references
 *    nav.config.jsx so that group segments (e.g. "System") become hover
 *    dropdowns listing the group's child pages instead of dead links.
 *
 * Sidebar layout:
 *   - Hidden on desktop (lg+) — the sidebar IS the navigation.
 *   - Visible on tablet/mobile (< lg) with a sidebar toggle button prepended.
 *
 * Topbar layout:
 *   - Always visible.
 *
 * Common props:
 *   separator — 'slash' | 'chevron' | 'dot'
 *   size      — 'sm' | 'md'
 *   homeIcon  — boolean (show home icon on first item)
 *   variant   — 'inline' | 'bar'
 *   labels    — { [segment]: string } custom display names
 *   exclude   — string[] segments to hide
 */
import { Bars3Icon, ChevronRightIcon, HomeIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useMemo } from "react";
import { NavLink, useLocation } from "react-router-dom";

import { TRANSITION_COLORS } from "../../assets/styles/pre-set-styles";
import { useLayout } from "../../contexts/layout/LayoutContext";
import { useNav } from "../layout/config/useNav";

const SEPARATORS = {
    slash: <span className="select-none text-grey-400 dark:text-grey-500">/</span>,
    chevron: <ChevronRightIcon className="w-3.5 h-3.5 text-grey-400 dark:text-grey-500 shrink-0" />,
    dot: <span className="w-1 h-1 rounded-full bg-grey-400 dark:bg-grey-500 shrink-0" />,
};

const BAR_SEPARATORS = {
    slash: <span className="select-none text-(--chrome-from-text-faint)">/</span>,
    chevron: <ChevronRightIcon className="w-3.5 h-3.5 text-(--chrome-from-text-faint) shrink-0" />,
    dot: <span className="w-1 h-1 rounded-full bg-(--chrome-from-text-faint) shrink-0" />,
};

/**
 * Capitalise a URL segment into a human-friendly label.
 */
function humanise(segment) {
    return segment
        .replace(/[-_]/g, " ")
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Build a lookup: first URL segment → nav group object.
 * e.g. "system" → { label: "System", items: [...] }
 */
function buildGroupMap(navGroups) {
    const map = {};
    for (const group of navGroups) {
        // Derive the segment from the first item's href: "/system/foo" → "system"
        const firstHref = group.items?.[0]?.href;
        if (firstHref) {
            const seg = firstHref.split("/").filter(Boolean)[0];
            if (seg) map[seg.toLowerCase()] = group;
        }
    }
    return map;
}

/**
 * Build items array from the current pathname, cross-referencing nav groups
 * so group segments become dropdown triggers instead of dead links.
 */
function buildAutoItems(pathname, navGroups, labels = {}, exclude = []) {
    const segments = pathname.split("/").filter((s) => s && !exclude.includes(s.toLowerCase()));
    const groupMap = buildGroupMap(navGroups);

    if (segments.length === 0) {
        return [{ label: "Home" }];
    }

    const items = [{ label: "Home", href: "/" }];

    segments.forEach((seg, i) => {
        const href = "/" + segments.slice(0, i + 1).join("/");
        const label = labels[seg.toLowerCase()] ?? labels[seg] ?? humanise(seg);
        const isLast = i === segments.length - 1;
        const group = groupMap[seg.toLowerCase()];

        if (group && !isLast) {
            // This segment is a nav group — mark it as a dropdown, not a link
            items.push({ label: group.label, group });
        } else {
            items.push({ label, href: isLast ? undefined : href });
        }
    });

    return items;
}

// ── GroupDropdown — hover/click dropdown for group segments ────────────────────
function GroupDropdown({ group, isBar }) {
    const { pathname } = useLocation();

    return (
        <div className="relative group/crumb">
            <button type="button" className={`flex items-center gap-1 cursor-pointer transition-colors duration-200 ${isBar ? "text-(--chrome-from-text-muted) hover:text-(--chrome-from-text)" : "text-grey-500 dark:text-grey-400 hover:text-(--text-accent)"}`}>
                {group.label}
            </button>

            {/* Dropdown panel — appears on hover */}
            <div className="absolute left-0 top-full pt-2 z-50 invisible opacity-0 translate-y-1 group-hover/crumb:visible group-hover/crumb:opacity-100 group-hover/crumb:translate-y-0 transition-all duration-200 min-w-52">
                <div className="bg-(--bg-surface-2) rounded-xl shadow-2xl ring-1 ring-black/5 dark:ring-(--color-dark-muted)/20 overflow-hidden py-2 px-1.5">
                    <p className="px-3 mb-1.5 text-[10px] font-aumovio-bold uppercase tracking-widest text-grey-400">{group.label}</p>
                    {group.items.map((item) => {
                        const active = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href + "/"));
                        return (
                            <NavLink key={item.name} to={item.href}>
                                <div className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-aumovio ${TRANSITION_COLORS} hover:bg-(--side-hover-bg) ${active ? "text-(--text-accent) font-aumovio-bold" : "text-grey-700 dark:text-grey-300 hover:text-(--text-accent)"}`}>
                                    {item.icon && <span className="shrink-0 flex items-center justify-center">{item.icon}</span>}
                                    <div className="min-w-0">
                                        <p className="truncate">{item.name}</p>
                                        {item.description && <p className="text-xs text-grey-400 mt-0.5 truncate">{item.description}</p>}
                                    </div>
                                </div>
                            </NavLink>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}

export function Breadcrumb({ items, auto = false, separator = "chevron", size = "md", homeIcon = true, variant = "inline", labels = {}, exclude = [] }) {
    const location = useLocation();
    const { layout, sidebarOpen, toggleSidebar } = useLayout();
    const { navGroups } = useNav();

    const resolvedItems = auto ? buildAutoItems(location.pathname, navGroups, labels, exclude) : (items ?? []);

    const textSz = size === "sm" ? "text-sm" : "text-base";
    const isBar = variant === "bar";
    const isSidebar = layout === "sidebar";

    // Skip "Home" segment for sidebar breadcrumb — sidebar already has Dashboard
    const displayItems = useMemo(() => {
        if (isSidebar && resolvedItems.length > 1) {
            return resolvedItems.slice(1); // drop Home
        }
        return resolvedItems;
    }, [isSidebar, resolvedItems]);

    const crumbs = (
        <nav aria-label="Breadcrumb" className={`flex items-center gap-1.5 flex-wrap font-aumovio ${textSz}`}>
            {/* Sidebar toggle — only shown in sidebar layout (tablet/mobile) */}
            {isSidebar && (
                <button onClick={toggleSidebar} aria-label={sidebarOpen ? "Close sidebar" : "Open sidebar"} className={`p-1.5 -ml-1 mr-1 rounded-lg shrink-0 ${TRANSITION_COLORS} ${isBar ? "text-(--chrome-from-text-muted) hover:text-(--chrome-from-text) hover:bg-(--chrome-from-hover-bg)" : "text-grey-500 hover:text-(--text-accent) hover:bg-(--side-hover-bg)"}`}>
                    {sidebarOpen ? <XMarkIcon className="w-4 h-4" /> : <Bars3Icon className="w-4 h-4" />}
                </button>
            )}

            {displayItems.map((item, i) => {
                const isLast = i === displayItems.length - 1;
                const seps = isBar ? BAR_SEPARATORS : SEPARATORS;

                return (
                    <div key={`${item.label}-${i}`} className="flex items-center gap-1.5">
                        {i > 0 && (seps[separator] ?? seps.chevron)}

                        {/* Group segment → hover dropdown */}
                        {item.group ? (
                            <GroupDropdown group={item.group} isBar={isBar} />
                        ) : isLast ? (
                            <span className={`flex items-center gap-1 font-aumovio-bold ${isBar ? "text-(--chrome-from-text) drop-shadow-md rounded px-2 py-0.5" : "text-(--text-accent)"}`} aria-current="page">
                                {item.icon && <item.icon className="w-3.5 h-3.5" />}
                                {item.label}
                            </span>
                        ) : item.href ? (
                            <NavLink to={item.href} className={`flex items-center gap-1 transition-colors duration-200 ${isBar ? "text-(--chrome-from-text-muted) hover:text-(--chrome-from-text)" : "text-grey-500 dark:text-grey-400 hover:text-(--text-accent)"}`}>
                                {i === 0 && homeIcon ? <HomeIcon className="w-3.5 h-3.5" /> : item.icon && <item.icon className="w-3.5 h-3.5" />}
                                {item.label}
                            </NavLink>
                        ) : (
                            <span className={`flex items-center gap-1 ${isBar ? "text-(--chrome-from-text-muted)" : "text-grey-500 dark:text-grey-400"}`}>
                                {i === 0 && homeIcon ? <HomeIcon className="w-3.5 h-3.5" /> : item.icon && <item.icon className="w-3.5 h-3.5" />}
                                {item.label}
                            </span>
                        )}
                    </div>
                );
            })}
        </nav>
    );

    if (isBar) {
        return (
            <div className={`${isSidebar ? "lg:hidden" : ""} relative z-40 bg-linear-to-r from-(--color-gradient-from) via-(--color-gradient-from) via-60% to-(--color-gradient-to) dark:brightness-85 dark:saturate-90 shadow-lg shadow-orange-400/25 dark:shadow-none dark:border-b dark:border-(--border-elevation)`}>
                <div className="px-4 mx-auto">
                    <div className="flex items-center w-full py-3">{crumbs}</div>
                </div>
            </div>
        );
    }

    return <div className={isSidebar ? "lg:hidden" : ""}>{crumbs}</div>;
}

export default Breadcrumb;
