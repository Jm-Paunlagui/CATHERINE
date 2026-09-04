/**
 * Sidebar.jsx â€” Collapsible left sidebar (Aumovio Design System v3.0)
 *
 * CUSTOMISATION
 * â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 * Edit nav.config.jsx to change links, groups, and role assignments.
 * This file is the renderer only â€” no link or auth logic lives here.
 *
 * ICON FLEXIBILITY
 * â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 *   Heroicon forwardRef â€” icon: UserCircleIcon         (typeof === "object", has .render)
 *   React Icons element â€” icon: <MdDataUsage size={16} /> (JSX ReactNode)
 *   FontAwesome object  â€” icon: faHome                 (has .iconName)
 *   Function component  â€” icon: MyIcon                 (typeof === "function")
 */

import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { ChevronDownIcon, ChevronUpIcon } from "@heroicons/react/24/outline";
import { useCallback, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";

import { TRANSITION_COLORS } from "../../assets/styles/pre-set-styles";
import { useLayout } from "../../contexts/layout/LayoutContext";
import { useVersion } from "../../contexts/version/VersionContext";
import { Tooltip } from "../ui/Tooltip";
import { VersionBadge } from "../ui/VersionBadge";
import { canSeeVersion } from "./config/nav.config";
import { useNav } from "./config/useNav";

// â”€â”€ Group colour palette â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const GROUP_COLOR_MAP = {
    orange: {
        dot: "bg-[var(--side-active-border)]",
        activeBg: "bg-[var(--side-active-bg)]",
        activeText: "text-[var(--side-active-text)]",
        hoverBg: "hover:bg-(--side-hover-bg)",
        hoverText: "hover:text-(--side-active-text)",
        // Fix 3 (QA): border-l indicator reserves 2px at rest (no layout shift);
        // shows at 50%-opacity on hover, full-opacity when active.
        hoverBorder: "border-l-2 border-transparent hover:border-[var(--side-hover-border)]",
        activeBorder: "border-l-2 border-[var(--side-active-border)]",
        collapsedBg: "bg-[var(--side-active-bg)]",
    },
    // Palette-responsive families (purple/secondary, blue, yellow, turquoise) use
    // contrast-safe per-family CSS variables computed by applyPaletteVars() so the
    // dot and active text stay visible on dark palette surfaces (e.g. Toasted Copper,
    // where the raw yellow/secondary anchors are near-black). Mirrors the orange
    // entry. Defaults for the brand palette live in index.css.
    purple: {
        dot: "bg-[var(--side-purple-text)]",
        activeBg: "bg-[var(--side-purple-bg)]",
        activeText: "text-[var(--side-purple-text)]",
        hoverBg: "hover:bg-(--side-hover-bg)",
        hoverText: "hover:text-[var(--side-purple-text)]",
        activeBorder: "border-l-2 border-[var(--side-purple-text)]",
        collapsedBg: "bg-[var(--side-purple-bg)]",
    },
    blue: {
        dot: "bg-[var(--side-blue-text)]",
        activeBg: "bg-[var(--side-blue-bg)]",
        activeText: "text-[var(--side-blue-text)]",
        hoverBg: "hover:bg-(--side-hover-bg)",
        hoverText: "hover:text-[var(--side-blue-text)]",
        activeBorder: "border-l-2 border-[var(--side-blue-text)]",
        collapsedBg: "bg-[var(--side-blue-bg)]",
    },
    success: {
        dot: "bg-success-400",
        activeBg: "bg-success-50 dark:bg-success-400/10",
        activeText: "text-success-500 dark:text-success-400",
        hoverBg: "hover:bg-success-50 dark:hover:bg-success-400/10",
        hoverText: "hover:text-success-500 dark:hover:text-success-400",
        activeBorder: "border-l-2 border-success-400",
        collapsedBg: "bg-success-50/80 dark:bg-success-400/[.07]",
    },
    danger: {
        dot: "bg-danger-400",
        activeBg: "bg-danger-50  dark:bg-danger-400/10",
        activeText: "text-danger-500 dark:text-danger-400",
        hoverBg: "hover:bg-danger-50  dark:hover:bg-danger-400/10",
        hoverText: "hover:text-danger-500 dark:hover:text-danger-400",
        activeBorder: "border-l-2 border-danger-400",
        collapsedBg: "bg-danger-50/80 dark:bg-danger-400/[.07]",
    },
    warn: {
        dot: "bg-warn-500",
        activeBg: "bg-warn-50    dark:bg-warn-400/10",
        activeText: "text-warn-600 dark:text-warn-400",
        hoverBg: "hover:bg-warn-50    dark:hover:bg-warn-400/10",
        hoverText: "hover:text-warn-600 dark:hover:text-warn-400",
        activeBorder: "border-l-2 border-warn-500",
        collapsedBg: "bg-warn-50/80 dark:bg-warn-400/[.07]",
    },
    // yellow + turquoise follow the CSS variable families we override via the
    // palette system, so sidebar groups using these keys shift colour with the
    // user's chosen accent palette.
    yellow: {
        dot: "bg-[var(--side-yellow-text)]",
        activeBg: "bg-[var(--side-yellow-bg)]",
        activeText: "text-[var(--side-yellow-text)]",
        hoverBg: "hover:bg-(--side-hover-bg)",
        hoverText: "hover:text-[var(--side-yellow-text)]",
        activeBorder: "border-l-2 border-[var(--side-yellow-text)]",
        collapsedBg: "bg-[var(--side-yellow-bg)]",
    },
    turquoise: {
        dot: "bg-[var(--side-turquoise-text)]",
        activeBg: "bg-[var(--side-turquoise-bg)]",
        activeText: "text-[var(--side-turquoise-text)]",
        hoverBg: "hover:bg-(--side-hover-bg)",
        hoverText: "hover:text-[var(--side-turquoise-text)]",
        activeBorder: "border-l-2 border-[var(--side-turquoise-text)]",
        collapsedBg: "bg-[var(--side-turquoise-bg)]",
    },
    grey: {
        dot: "bg-grey-400",
        activeBg: "bg-grey-100 dark:bg-(--bg-surface-3)",
        activeText: "text-grey-700 dark:text-grey-300",
        hoverBg: "hover:bg-grey-100 dark:hover:bg-(--bg-surface-3)",
        hoverText: "hover:text-grey-700 dark:hover:text-grey-300",
        activeBorder: "border-l-2 border-grey-400",
        collapsedBg: "bg-grey-100/80 dark:bg-grey-800/50",
    },
};

const DEFAULT_COL = GROUP_COLOR_MAP.orange;
const resolveColor = (key) => GROUP_COLOR_MAP[key] ?? DEFAULT_COL;

// â”€â”€ Flexible icon renderer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function NavIcon({ icon, className = "w-4 h-4 shrink-0" }) {
    if (!icon) return null;
    if (typeof icon === "function") {
        const Icon = icon;
        return <Icon className={className} />;
    }
    if (typeof icon === "object" && typeof icon.render === "function") {
        // React.forwardRef component (Heroicons v2)
        const Icon = icon;
        return <Icon className={className} />;
    }
    if (typeof icon === "object" && "iconName" in icon) {
        return <FontAwesomeIcon icon={icon} className={className} />;
    }
    // JSX element (React Icons, etc.)
    return <span className="shrink-0 flex items-center justify-center">{icon}</span>;
}

// â”€â”€ FlatNavItem â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Renders a NavLink for items with an href, or a <button> for action-only items
// (e.g. "Your Profile" which opens a modal via onClick).
// Tailwind-docs-inspired: hybrid left-border + subtle tinted bg on active.
function FlatNavItem({ item, collapsed, colorKey = "orange", danger = false }) {
    const col = resolveColor(colorKey);
    const { pathname } = useLocation();
    const isActive = item.href ? pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href + "/")) : false;
    const isActionOnly = !item.href || (item.onClick && !item.href);

    const sharedClassName = `
        flex items-center gap-3 py-2 text-sm font-aumovio
        ${TRANSITION_COLORS}
        ${collapsed ? "justify-center px-0! w-10 h-10 mx-auto rounded-xl" : "px-3"}
        ${danger ? `text-danger-500 dark:text-danger-400 hover:bg-danger-50 dark:hover:bg-danger-400/10 ${collapsed ? GROUP_COLOR_MAP.danger.collapsedBg : ""}` : isActive ? `${col.activeText} font-aumovio-bold` : `text-(--text-secondary) ${col.hoverText} ${collapsed ? col.collapsedBg : ""}`}
    `;

    const content = (
        <>
            <span className={`shrink-0 flex items-center justify-center ${danger ? "text-danger-400" : isActive ? col.activeText : "text-(--text-tertiary)"}`}>
                <NavIcon icon={item.icon} />
            </span>
            {!collapsed && <span className="flex-1 truncate">{item.name}</span>}
        </>
    );

    const inner = isActionOnly ? (
        <button type="button" onClick={item.onClick} className={`w-full text-left ${sharedClassName}`}>
            {content}
        </button>
    ) : (
        <NavLink to={item.href} onClick={item.onClick}>
            <div className={sharedClassName}>{content}</div>
        </NavLink>
    );

    if (collapsed) {
        return (
            <Tooltip content={item.name} placement="right" delay={100}>
                {inner}
            </Tooltip>
        );
    }
    return inner;
}

// â”€â”€ SidebarGroup â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Tailwind-docs-inspired: groups default to expanded, chevron shown on hover
// only, child items use left-border active indicator with subtle tinted bg.
function SidebarGroup({ group, collapsed, currentPath }) {
    const col = resolveColor(group.color ?? "orange");
    const isGroupActive = group.items.some((item) => currentPath === item.href || (item.href !== "/" && currentPath.startsWith(item.href + "/")));
    // Default expanded (Tailwind docs style) â€” user can still collapse
    const [expanded, setExpanded] = useState(true);
    const toggle = useCallback(() => setExpanded((v) => !v), []);

    if (collapsed) {
        return (
            <div className="flex flex-col items-center gap-1 py-1">
                {group.items.map((item) => {
                    const active = currentPath === item.href || (item.href !== "/" && currentPath.startsWith(item.href + "/"));
                    return (
                        <Tooltip key={item.name} content={item.name} placement="right" delay={100}>
                            <NavLink to={item.href} className="block">
                                <div className={`w-10 h-10 flex items-center justify-center rounded-xl ${TRANSITION_COLORS} ${active ? `${col.activeBg} ${col.activeText}` : `text-(--text-tertiary) ${col.collapsedBg} ${col.hoverBg} ${col.hoverText}`}`}>
                                    <span className={`flex items-center justify-center ${active ? col.activeText : ""}`}>
                                        <NavIcon icon={item.icon} />
                                    </span>
                                </div>
                            </NavLink>
                        </Tooltip>
                    );
                })}
            </div>
        );
    }

    return (
        <div className="mb-1 pr-2">
            {/* Group header â€” chevron visible on hover only (Tailwind docs style) */}
            <button onClick={toggle} className={`group/hdr w-full flex items-center gap-2 px-3 py-2 rounded-lg text-[11px] font-aumovio-bold uppercase tracking-wider ${TRANSITION_COLORS} ${isGroupActive ? col.activeText : "text-(--text-tertiary) hover:text-(--text-secondary)"}`}>
                {/* Dot indicator - */}
                {/* <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${col.dot}`} /> */}
                <span className="flex-1 text-left">{group.label}</span>
                {/* Chevron fades in on group header hover */}
                <span className={`${TRANSITION_COLORS} opacity-0 group-hover/hdr:opacity-100`}>{expanded ? <ChevronUpIcon className="w-3 h-3" /> : <ChevronDownIcon className="w-3 h-3" />}</span>
            </button>

            {expanded && (
                <div className="mt-1 ml-4 pl-0 border-l border-grey-200/50 dark:border-(--color-dark-muted)/15 space-y-px">
                    {group.items.map((item) => {
                        const active = currentPath === item.href || (item.href !== "/" && currentPath.startsWith(item.href + "/"));
                        return (
                            <NavLink key={item.name} to={item.href}>
                                <div
                                    className={`
                                        flex items-center gap-2 pl-4 pr-3 py-2 text-sm font-aumovio
                                        ${TRANSITION_COLORS}
                                        ${active ? `${col.activeText} font-aumovio-bold -ml-px ${col.activeBorder}` : `text-(--text-secondary) ${col.hoverText} -ml-px border-l-2 border-transparent`}
                                    `}
                                >
                                    <span className={`shrink-0 flex items-center justify-center ${active ? col.activeText : "text-(--text-tertiary)"}`}>
                                        <NavIcon icon={item.icon} />
                                    </span>
                                    <span className="flex-1 truncate">{item.name}</span>
                                </div>
                            </NavLink>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

// â”€â”€ Main Sidebar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Desktop (lg+): always visible, always expanded â€” no collapsed icon-only mode.
// Tablet/mobile (< lg): hidden by default, shown as an overlay when the
// breadcrumb toggle sets sidebarOpen = true.
export default function Sidebar() {
    const { layout, sidebarOpen, toggleSidebar } = useLayout();
    const { pathname } = useLocation();
    const { user, isLoading, navGroups, authFlatLinks, publicLinks } = useNav();
    const { version, stage } = useVersion();

    // Sidebar is only rendered in sidebar layout mode â€” guard AFTER all hooks
    if (layout !== "sidebar") return null;

    const isAuth = Boolean(user) && !isLoading;
    const showVersion = canSeeVersion(user?.role);

    return (
        <>
            {/* Backdrop overlay â€” tablet/mobile only, when sidebar is open */}
            {sidebarOpen && <div className="absolute inset-0 z-30 bg-black/30 lg:hidden" onClick={toggleSidebar} aria-hidden="true" />}

            <aside
                className={[
                    // Desktop: static in-flow, full height of the flex container, scrolls independently
                    "lg:relative lg:translate-x-0 lg:flex lg:flex-col lg:shrink-0 lg:overflow-y-auto lg:hide-scrollbar",
                    "bg-(--bg-surface-2)",
                    "border-r border-(--border-elevation)",
                    "w-auto",
                    // Tablet/mobile: absolute within content area (below header+breadcrumb)
                    "absolute top-0 left-0 bottom-0 z-35 flex flex-col shrink-0",
                    "transition-transform duration-300 ease-in-out",
                    sidebarOpen ? "translate-x-0" : "-translate-x-full",
                    "lg:translate-x-0!",
                ].join(" ")}
            >
                {/* â”€â”€ Navigation â”€â”€ */}
                <nav className="flex-1 overflow-y-auto hide-scrollbar px-2 py-3 space-y-1">
                    {!isAuth && publicLinks.map((item) => <FlatNavItem key={item.name} item={item} collapsed={false} />)}
                    {isAuth && authFlatLinks.map((item) => <FlatNavItem key={item.name} item={item} collapsed={false} colorKey="orange" />)}
                    {isAuth && navGroups.map((group) => <SidebarGroup key={group.label} group={group} collapsed={false} currentPath={pathname} />)}
                </nav>

                {/* â”€â”€ Drawer footer: version + release stage â†’ Version History â”€â”€
                    `lg:hidden` on purpose. From `lg` up SidebarHeader always shows
                    its glass badge on the gradient bar, so rendering here too would
                    duplicate it â€” and a `display:none` element contributes no width,
                    so the desktop sidebar's `w-auto` sizing is untouched. Below `sm`
                    the header hides the badge entirely, which makes this drawer the
                    only place a phone user can reach the changelog. */}
                {showVersion && (
                    <div className="lg:hidden shrink-0 px-2 py-3 border-t border-(--border-elevation) flex justify-center">
                        <VersionBadge version={version} stage={stage} to="/about/changelog" />
                    </div>
                )}
            </aside>
        </>
    );
}

