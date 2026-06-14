/**
 * Sidebar.jsx — Collapsible left sidebar (Aumovio Design System v3.0)
 *
 * CUSTOMISATION
 * ─────────────
 * Edit nav.config.jsx to change links, groups, and role assignments.
 * This file is the renderer only — no link or auth logic lives here.
 *
 * ICON FLEXIBILITY
 * ────────────────
 *   Heroicon forwardRef — icon: UserCircleIcon         (typeof === "object", has .render)
 *   React Icons element — icon: <MdDataUsage size={16} /> (JSX ReactNode)
 *   FontAwesome object  — icon: faHome                 (has .iconName)
 *   Function component  — icon: MyIcon                 (typeof === "function")
 */

import { Menu, MenuButton, MenuItem, MenuItems, Transition } from "@headlessui/react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { ChevronDoubleLeftIcon, ChevronDoubleRightIcon, ChevronDownIcon, ChevronUpIcon, EllipsisVerticalIcon, PaintBrushIcon } from "@heroicons/react/24/outline";
import { useCallback, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";

import { ANIMATE_SCALE_IN, ANIMATE_SCALE_OUT, ANIMATE_SLIDE_LEFT, ANIMATE_SLIDE_RIGHT, TRANSITION_COLORS, TRANSITION_SPRING } from "../../assets/styles/pre-set-styles";
import { STAGE_META } from "../../config/appVersion";
import { useVersion } from "../../contexts/version/VersionContext";
import { useLayout } from "../../contexts/layout/LayoutContext";
import PersonalizeModal from "../../features/personalize/PersonalizeModal";
import ProfileModal from "../feedback/ProfileModal";
import { Avatar } from "../ui/Avatar";
import { Badge } from "../ui/Badge";
import Logo from "../ui/Logo";
import { Tooltip } from "../ui/Tooltip";
import { VersionBadge } from "../ui/VersionBadge";
import { useNav } from "./config/useNav";

const CHANGELOG_HREF = "/other/changelog";

const APP_DISPLAY_NAME = import.meta.env.VITE_APP_NAME || null;

// ── Group colour palette ──────────────────────────────────────────────────────
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
    // dot and active text stay visible on dark palette surfaces (e.g. The Divine,
    // where the raw yellow/secondary anchors are near-black). Mirrors the orange
    // entry. Defaults for the brand palette live in index.css.
    purple: {
        dot: "bg-[var(--side-purple-text)]",
        activeBg: "bg-[var(--side-purple-bg)]",
        activeText: "text-[var(--side-purple-text)]",
        hoverBg: "hover:bg-(--side-hover-bg)",
        hoverText: "hover:text-[var(--side-purple-text)]",
        collapsedBg: "bg-[var(--side-purple-bg)]",
    },
    blue: {
        dot: "bg-[var(--side-blue-text)]",
        activeBg: "bg-[var(--side-blue-bg)]",
        activeText: "text-[var(--side-blue-text)]",
        hoverBg: "hover:bg-(--side-hover-bg)",
        hoverText: "hover:text-[var(--side-blue-text)]",
        collapsedBg: "bg-[var(--side-blue-bg)]",
    },
    success: {
        dot: "bg-success-400",
        activeBg: "bg-success-50 dark:bg-success-400/10",
        activeText: "text-success-500 dark:text-success-400",
        hoverBg: "hover:bg-success-50 dark:hover:bg-success-400/10",
        hoverText: "hover:text-success-500 dark:hover:text-success-400",
        collapsedBg: "bg-success-50/80 dark:bg-success-400/[.07]",
    },
    danger: {
        dot: "bg-danger-400",
        activeBg: "bg-danger-50  dark:bg-danger-400/10",
        activeText: "text-danger-500 dark:text-danger-400",
        hoverBg: "hover:bg-danger-50  dark:hover:bg-danger-400/10",
        hoverText: "hover:text-danger-500 dark:hover:text-danger-400",
        collapsedBg: "bg-danger-50/80 dark:bg-danger-400/[.07]",
    },
    warn: {
        dot: "bg-warn-500",
        activeBg: "bg-warn-50    dark:bg-warn-400/10",
        activeText: "text-warn-600 dark:text-warn-400",
        hoverBg: "hover:bg-warn-50    dark:hover:bg-warn-400/10",
        hoverText: "hover:text-warn-600 dark:hover:text-warn-400",
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
        collapsedBg: "bg-[var(--side-yellow-bg)]",
    },
    turquoise: {
        dot: "bg-[var(--side-turquoise-text)]",
        activeBg: "bg-[var(--side-turquoise-bg)]",
        activeText: "text-[var(--side-turquoise-text)]",
        hoverBg: "hover:bg-(--side-hover-bg)",
        hoverText: "hover:text-[var(--side-turquoise-text)]",
        collapsedBg: "bg-[var(--side-turquoise-bg)]",
    },
    grey: {
        dot: "bg-grey-400",
        activeBg: "bg-grey-100 dark:bg-(--bg-surface-3)",
        activeText: "text-grey-700 dark:text-grey-300",
        hoverBg: "hover:bg-grey-100 dark:hover:bg-(--bg-surface-3)",
        hoverText: "hover:text-grey-700 dark:hover:text-grey-300",
        collapsedBg: "bg-grey-100/80 dark:bg-grey-800/50",
    },
};

const DEFAULT_COL = GROUP_COLOR_MAP.orange;
const resolveColor = (key) => GROUP_COLOR_MAP[key] ?? DEFAULT_COL;

// ── Role helpers ──────────────────────────────────────────────────────────────
function resolveRoleLabel(role) {
    if (role === "SUPER_ADMIN") return "Super ADMIN";
    if (role === "ADMIN") return "ADMIN";
    if (role === "APPROVER") return "Approver";
    if (role === "VIEWER") return "Viewer";
    if (role === "ROBOT") return "Automation";
    return "USER";
}

function resolveRoleBadgeVariant(role) {
    if (role === "SUPER_ADMIN") return "purple";
    if (role === "ADMIN") return "orange";
    if (role === "APPROVER") return "blue";
    if (role === "VIEWER") return "cyan";
    if (role === "ROBOT") return "green";
    return "grey";
}

// ── Flexible icon renderer ────────────────────────────────────────────────────
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

// ── FlatNavItem ───────────────────────────────────────────────────────────────
// Renders a NavLink for items with an href, or a <button> for action-only items
// (e.g. "Your Profile" which opens a modal via onClick).
function FlatNavItem({ item, collapsed, colorKey = "orange", danger = false }) {
    const col = resolveColor(colorKey);
    const { pathname } = useLocation();
    const isActive = item.href ? pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href + "/")) : false;
    const isActionOnly = !item.href || (item.onClick && !item.href);

    const sharedClassName = `
        flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm font-aumovio
        ${TRANSITION_COLORS}
        ${collapsed ? "justify-center px-0! w-10 h-10 mx-auto" : ""}
        ${danger ? `text-danger-500 dark:text-danger-400 hover:bg-danger-50 dark:hover:bg-danger-400/10 ${collapsed ? GROUP_COLOR_MAP.danger.collapsedBg : ""}` : isActive ? `${col.activeBg} ${col.activeText} ${!collapsed ? (col.activeBorder ?? "") : ""} font-aumovio-bold` : `text-(--text-secondary) ${col.hoverBg} ${col.hoverText} ${!collapsed ? (col.hoverBorder ?? "") : ""} ${collapsed ? col.collapsedBg : ""}`}
    `;

    const content = (
        <>
            <span className={`shrink-0 flex items-center justify-center px-3 ${danger ? "text-danger-400" : isActive ? col.activeText : "text-(--text-tertiary)"}`}>
                <NavIcon icon={item.icon} />
            </span>
            {!collapsed && (
                <>
                    <span className="flex-1 truncate">{item.name}</span>
                    {isActive && !danger && <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${col.dot}`} />}
                </>
            )}
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

// ── SidebarGroup ──────────────────────────────────────────────────────────────
function SidebarGroup({ group, collapsed, currentPath }) {
    const col = resolveColor(group.color ?? "orange");
    const isGroupActive = group.items.some((item) => currentPath === item.href || (item.href !== "/" && currentPath.startsWith(item.href + "/")));
    const [expanded, setExpanded] = useState(isGroupActive);
    const toggle = useCallback(() => setExpanded((v) => !v), []);

    if (collapsed) {
        return (
            <div className="flex flex-col items-center gap-0.5 py-1">
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
        <div className="mb-1">
            <button onClick={toggle} className={`w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-[11px] font-aumovio-bold uppercase tracking-wider ${TRANSITION_COLORS} ${isGroupActive ? col.activeText : "text-(--text-tertiary) hover:text-(--text-secondary)"}`}>
                <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${col.dot}`} />
                <span className="flex-1 text-left">{group.label}</span>
                {expanded ? <ChevronUpIcon className="w-3 h-3" /> : <ChevronDownIcon className="w-3 h-3" />}
            </button>

            {expanded && (
                <div className="mt-0.5 ml-3 pl-3 border-l-2 border-grey-100 dark:border-(--color-dark-muted)/30 space-y-0.5">
                    {group.items.map((item) => {
                        const active = currentPath === item.href || (item.href !== "/" && currentPath.startsWith(item.href + "/"));
                        return (
                            <NavLink key={item.name} to={item.href}>
                                <div className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-aumovio ${TRANSITION_COLORS} ${active ? `${col.activeBg} ${col.activeText} font-aumovio-bold` : `text-(--text-secondary) ${col.hoverBg} ${col.hoverText}`}`}>
                                    <span className={`shrink-0 flex items-center justify-center ${active ? col.activeText : ""}`}>
                                        <NavIcon icon={item.icon} />
                                    </span>
                                    <span className="flex-1 truncate">{item.name}</span>
                                    {active && <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${col.dot}`} />}
                                </div>
                            </NavLink>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

// ── SidebarUserMenu ───────────────────────────────────────────────────────────
// Footer account control that mirrors the navbar avatar dropdown, adapted for a
// bottom-anchored sidebar: a compact avatar + length-aware name button that opens
// an UPWARD menu (origin-bottom) carrying the navbar header (avatar + name + role
// badge) and the shared profileItems — Your Profile (opens modal) + Sign out.
function SidebarUserMenu({ user, collapsed, profileItems }) {
    const name = `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim();
    const role = resolveRoleLabel(user?.role);
    const badgeVariant = resolveRoleBadgeVariant(user?.role);

    // Collapsed → fixed-width panel overflowing the rail; expanded → matches button width.
    const panelPosition = collapsed ? "left-0 w-60" : "left-0 right-0";

    const panel = (
        <Transition as="div" enter={ANIMATE_SCALE_IN} leave={ANIMATE_SCALE_OUT}>
            <MenuItems
                className={`
                    absolute bottom-full mb-2 z-50 origin-bottom ${panelPosition}
                    bg-(--bg-surface-2) rounded-xl shadow-2xl
                    ring-1 ring-black/5 dark:ring-(--color-dark-muted)/20
                    focus:outline-none overflow-hidden
                `}
            >
                {/* USER info header — same lockup as the navbar profile menu */}
                <div className="px-4 py-3 border-b border-grey-100 dark:border-grey-800">
                    <div className="flex items-center gap-2.5">
                        <Avatar name={name} size="sm" />
                        <div className="min-w-0">
                            <p className="text-sm font-aumovio-bold text-(--text-primary) truncate">{name || "USER"}</p>
                            <Badge variant={badgeVariant} size="xs" pill>
                                {role}
                            </Badge>
                        </div>
                    </div>
                </div>

                {/* Profile menu items */}
                <div className="py-1.5 px-1.5 space-y-0.5">
                    {profileItems.map((item, i) => {
                        if (item.divider) {
                            return <div key={`divider-${i}`} className="my-1 h-px bg-(--bg-surface-3) mx-2" />;
                        }
                        const Icon = item.icon;
                        return (
                            <MenuItem key={item.id}>
                                <button
                                    onClick={item.onClick ?? (() => {})}
                                    className={`
                                        w-full flex items-center gap-2.5
                                        px-3 py-2 rounded-lg text-sm font-aumovio
                                        ${TRANSITION_COLORS}
                                        ${item.danger ? "text-danger-500 dark:text-danger-400 hover:bg-danger-50 dark:hover:bg-danger-400/10" : "text-(--text-secondary) hover:bg-(--side-hover-bg) hover:text-(--side-active-text)"}
                                    `}
                                >
                                    {Icon && <Icon className="w-4 h-4 shrink-0" />}
                                    {item.label}
                                </button>
                            </MenuItem>
                        );
                    })}
                </div>
            </MenuItems>
        </Transition>
    );

    if (collapsed) {
        return (
            <Menu as="div" className="relative flex justify-center">
                <Tooltip content={`${name} · ${role}`} placement="right" delay={100}>
                    <MenuButton aria-label="Account menu" className={`rounded-full ${TRANSITION_SPRING} hover:ring-2 hover:ring-(--accent)/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent)/50`}>
                        <Avatar name={name} size="md" bordered />
                    </MenuButton>
                </Tooltip>
                {panel}
            </Menu>
        );
    }

    return (
        <Menu as="div" className="relative">
            <MenuButton className={`group w-full flex items-center gap-2.5 px-2 py-2 rounded-xl text-left ${TRANSITION_COLORS} hover:bg-(--side-hover-bg) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent)/50`}>
                <Avatar name={name} size="sm" bordered />
                <div className="min-w-0 flex-1">
                    <p className="text-sm font-aumovio-bold text-(--text-primary) truncate leading-tight">{name || "USER"}</p>
                    <p className="text-xs text-(--text-secondary) truncate leading-tight mt-0.5">{role}</p>
                </div>
                <EllipsisVerticalIcon className="w-4 h-4 shrink-0 text-(--text-tertiary) group-hover:text-(--text-secondary)" />
            </MenuButton>
            {panel}
        </Menu>
    );
}

// ── Main Sidebar ──────────────────────────────────────────────────────────────
export default function Sidebar() {
    const { layout, sidebarOpen, toggleSidebar } = useLayout();
    const { pathname } = useLocation();
    const [personalizeOpen, setPersonalizeOpen] = useState(false);
    const { user, isLoading, navGroups, authFlatLinks, profileItems, publicLinks, profileOpen, closeProfile } = useNav();
    const { version, stage } = useVersion();
    const stageMeta = STAGE_META[stage] ?? STAGE_META.stable;

    // Sidebar is only rendered in sidebar layout mode — guard AFTER all hooks
    if (layout !== "sidebar") return null;

    const isAuth = Boolean(user) && !isLoading;
    const collapsed = !sidebarOpen;

    return (
        <>
            <aside className={["sticky top-0 z-40 h-screen self-start flex flex-col shrink-0", "bg-(--surface-2)", "border-r border-(--border-elevation)", "shadow-[1px_0_8px_0_rgba(0,0,0,0.04)] dark:shadow-none", sidebarOpen ? `${ANIMATE_SLIDE_RIGHT} w-auto` : `${ANIMATE_SLIDE_LEFT} w-16`].join(" ")}>
                {/* Header: Logo + collapse toggle */}
                <div className={`flex shrink-0 border-b border-(--border-elevation) ${sidebarOpen ? "flex-col px-4 py-4" : "flex-col items-center px-2 gap-1 py-3"}`}>
                    {sidebarOpen ? (
                        <>
                            <div className="flex items-center justify-between gap-2">
                                <Tooltip content={APP_DISPLAY_NAME ?? "Home"} placement="right" delay={300}>
                                    <NavLink to="/" className={`group flex flex-col items-start min-w-0 overflow-hidden rounded-lg -ml-1 px-1 py-1 ${TRANSITION_SPRING} hover:bg-(--side-hover-bg)`}>
                                        <Logo className="h-8 md:h-10 lg:h-12 w-auto" />
                                        {APP_DISPLAY_NAME && <span className="mt-1 pl-0.5 text-[11px] font-aumovio-bold uppercase tracking-[0.22em] text-(--text-secondary) truncate max-w-full">{APP_DISPLAY_NAME}</span>}
                                    </NavLink>
                                </Tooltip>
                                <Tooltip content="Collapse" placement="right" delay={300}>
                                    <button onClick={toggleSidebar} aria-label="Collapse sidebar" className={["p-1.5 rounded-lg shrink-0", "text-(--text-tertiary)", "hover:bg-(--side-hover-bg)", "hover:text-(--text-accent)", TRANSITION_SPRING, "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent)/50"].join(" ")}>
                                        <ChevronDoubleLeftIcon className="w-4 h-4" />
                                    </button>
                                </Tooltip>
                            </div>
                            {/* Version + release-stage badge → links to Version History */}
                            <VersionBadge version={version} stage={stage} to={CHANGELOG_HREF} className="mt-2" />
                        </>
                    ) : (
                        <>
                            <Tooltip content="Expand" placement="right" delay={300}>
                                <button onClick={toggleSidebar} aria-label="Expand sidebar" className={["w-10 h-10 flex items-center justify-center rounded-lg shrink-0", "text-(--text-tertiary)", "hover:bg-(--side-hover-bg)", "hover:text-(--text-accent)", TRANSITION_SPRING, "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent)/50"].join(" ")}>
                                    <ChevronDoubleRightIcon className="w-4 h-4" />
                                </button>
                            </Tooltip>
                            {/* Collapsed: compact stage chip only (version shown in tooltip) */}
                            <Tooltip content={`v${version} · ${stageMeta.label}`} placement="right" delay={100}>
                                <VersionBadge version={version} stage={stage} to={CHANGELOG_HREF} showVersion={false} short className="justify-center" />
                            </Tooltip>
                        </>
                    )}
                </div>

                {/* Navigation */}
                <nav className={`flex-1 overflow-y-auto hide-scrollbar px-2 py-3 space-y-0.5 ${collapsed ? "flex flex-col items-center" : ""}`}>
                    {!isAuth && publicLinks.map((item) => <FlatNavItem key={item.name} item={item} collapsed={collapsed} />)}
                    {isAuth && authFlatLinks.map((item) => <FlatNavItem key={item.name} item={item} collapsed={collapsed} colorKey="orange" />)}
                    {isAuth && navGroups.map((group) => <SidebarGroup key={group.label} group={group} collapsed={collapsed} currentPath={pathname} />)}
                </nav>

                {/* Footer: personalize + account menu (avatar pinned at the bottom) */}
                <div className={`shrink-0 border-t border-grey-100 dark:border-(--color-dark-muted)/20 px-2 py-3 space-y-1 ${collapsed ? "flex flex-col items-center" : ""}`}>
                    {/* Personalize row */}
                    {collapsed ? (
                        <Tooltip content="Personalize" placement="right" delay={100}>
                            <button type="button" onClick={() => setPersonalizeOpen(true)} aria-label="Personalize" className={`w-10 h-10 mx-auto flex items-center justify-center rounded-xl bg-grey-100/80 dark:bg-(--accent-subtle) ${TRANSITION_COLORS} text-(--text-secondary) hover:bg-(--side-hover-bg) hover:text-(--side-active-text)`}>
                                <PaintBrushIcon className="w-4 h-4 shrink-0" />
                            </button>
                        </Tooltip>
                    ) : (
                        <button type="button" onClick={() => setPersonalizeOpen(true)} aria-label="Personalize" className={`group w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm font-aumovio text-left ${TRANSITION_COLORS} text-(--text-secondary) hover:bg-(--side-hover-bg) hover:text-(--side-active-text)`}>
                            <span className={`shrink-0 flex items-center justify-center px-3 text-(--text-secondary) group-hover:text-(--side-active-text) ${TRANSITION_COLORS}`}>
                                <PaintBrushIcon className="w-4 h-4" />
                            </span>
                            <span className="flex-1 truncate">Personalize</span>
                        </button>
                    )}

                    {/* Account: avatar + name → upward dropdown (Your Profile / Sign out) */}
                    {isAuth && (
                        <div className="w-full pt-1 mt-1 border-t border-grey-100 dark:border-(--color-dark-muted)/20">
                            <SidebarUserMenu user={user} collapsed={collapsed} profileItems={profileItems} />
                        </div>
                    )}
                </div>
            </aside>

            {/* Profile modal — portalled to body */}
            <ProfileModal open={profileOpen} onClose={closeProfile} user={user} />

            {/* Personalize modal — portalled to body */}
            <PersonalizeModal open={personalizeOpen} onClose={() => setPersonalizeOpen(false)} />
        </>
    );
}
