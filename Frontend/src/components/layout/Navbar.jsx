/**
 * Navbar.jsx — Responsive top navigation bar (Aumovio Design System v3.0)
 *
 * CUSTOMISATION
 * ─────────────
 * Edit nav.config.jsx to change links, groups, and role assignments.
 * This file is the renderer only — no link or auth logic lives here.
 *
 * Layout: sticky top bar with centred desktop links + right-rail (theme toggle, avatar).
 * Mobile: slide-down drawer with grouped links and Account section.
 */

import { Menu, MenuButton, MenuItem, MenuItems, Transition } from "@headlessui/react";
import { Bars3Icon, PaintBrushIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useMemo, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";

import { ANIMATE_SCALE_IN, ANIMATE_SCALE_OUT, ANIMATE_SLIDE_DOWN, BASE_COLOR_TEXT, DELAY_1, MAIN_FOREGROUND_COLOR_TEXT, MAIN_OVERLAY_COLOR_BG, MAIN_PULSE_COLOR_BG, SECONDARY_COLOR_TEXT, SUBTITLE_COLOR_TEXT, TITLE_COLOR_TEXT, TRANSITION_COLORS, TRANSITION_SNAP, TRANSITION_SPRING } from "../../assets/styles/pre-set-styles";

import PersonalizeModal from "../../features/personalize/PersonalizeModal";
import ProfileModal from "../feedback/ProfileModal";
import { useVersion } from "../../contexts/version/VersionContext";
import { Avatar } from "../ui/Avatar";
import { Badge } from "../ui/Badge";
import Logo from "../ui/Logo";
import { VersionBadge } from "../ui/VersionBadge";
import { useNav } from "./config/useNav";

const APP_DISPLAY_NAME = import.meta.env.VITE_APP_NAME || null;

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

// ── NavItem — flat link pill ──────────────────────────────────────────────────
function NavItem({ item }) {
    return (
        <NavLink to={item.href}>
            <div
                className={`
                    ${item.current ? `${MAIN_FOREGROUND_COLOR_TEXT} bg-(--nav-active-bg) border border-(--nav-active-border)/25 shadow` : `${TITLE_COLOR_TEXT} hover:bg-(--nav-hover-bg) hover:text-(--nav-active-text)`}
                    px-3 py-2 rounded-lg text-sm font-aumovio ${TRANSITION_COLORS} cursor-pointer
                `}
            >
                {item.name}
            </div>
        </NavLink>
    );
}

// ── DropdownGroup — hover mega-menu ───────────────────────────────────────────
// Computes its own active state from the current pathname so the hook can stay
// data-only and the renderer decides what "active" means.
function DropdownGroup({ group, isLoading }) {
    const { pathname } = useLocation();
    const isActive = group.items.some((item) => pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href + "/")));

    return (
        <div className="relative group">
            <div
                className={`
                    ${isLoading ? `${SECONDARY_COLOR_TEXT} animate-pulse ${MAIN_PULSE_COLOR_BG} cursor-default` : isActive ? `${MAIN_FOREGROUND_COLOR_TEXT} bg-(--nav-active-bg) border border-(--nav-active-border)/25 shadow` : `${TITLE_COLOR_TEXT} hover:bg-(--nav-hover-bg) hover:text-(--nav-active-text)`}
                    px-3 py-2 rounded-lg text-sm font-aumovio ${TRANSITION_COLORS} cursor-pointer
                `}
            >
                {isLoading ? <span className={`w-20 bg-(--accent-subtle) rounded animate-pulse text-transparent ${DELAY_1}`}>{group.label}</span> : group.label}
            </div>

            {group.items.length > 0 && (
                // Outer wrapper is the full hover target. `pt-2` is a transparent
                // bridge spanning the visual gap so the cursor never leaves the
                // `group` while travelling from the trigger down to the menu card —
                // this is what stops the dropdown vanishing mid-navigation.
                <div
                    className={`
                        absolute z-10 invisible top-full pt-2 ${TRANSITION_SNAP}
                        origin-top transform -translate-x-1/2 left-1/2 w-80
                        opacity-0 translate-y-1
                        group-hover:opacity-100 group-hover:visible group-hover:translate-y-0
                    `}
                >
                    <div
                        className="
                            py-4 bg-(--bg-surface-2) rounded-xl shadow-2xl
                            ring-1 ring-black/5 dark:ring-(--color-dark-muted)/20
                        "
                    >
                        <div className="px-4">
                            <p className="mb-3 text-[10px] font-aumovio-bold uppercase tracking-widest text-grey-400">{group.label}</p>
                            <div className="space-y-1">
                                {group.items.map((item) => {
                                    const active = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href + "/"));
                                    return (
                                        <NavLink key={item.name} to={item.href}>
                                            <div
                                                className={`
                                                    flex items-center justify-between p-2.5 rounded-lg
                                                    ${TRANSITION_COLORS}
                                                    hover:bg-(--nav-hover-bg)
                                                    ${active ? "text-(--nav-active-text) font-aumovio-bold" : "text-grey-700 dark:text-grey-300 hover:text-(--nav-active-text)"}
                                                `}
                                            >
                                                <div>
                                                    <p className="text-sm font-aumovio">{item.name}</p>
                                                    {item.description && <p className="text-xs text-grey-400 mt-0.5">{item.description}</p>}
                                                </div>
                                                <span className="text-grey-300 dark:text-grey-600 text-sm">→</span>
                                            </div>
                                        </NavLink>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

// ── Main Navbar ───────────────────────────────────────────────────────────────
export default function Navbar() {
    const { user, isLoading, navGroups, profileItems, authFlatLinks, publicLinks, profileOpen, closeProfile } = useNav();
    const { version, stage } = useVersion();
    const [personalizeOpen, setPersonalizeOpen] = useState(false);
    const [isScrolled, setIsScrolled] = useState(false);
    const { pathname } = useLocation();

    // Scroll shadow
    useEffect(() => {
        const onScroll = () => setIsScrolled(window.scrollY > 10);
        window.addEventListener("scroll", onScroll);
        onScroll();
        return () => window.removeEventListener("scroll", onScroll);
    }, []);

    // Active check by path segment depth
    const split = pathname.split("/");
    const isActive = useCallback((seg, depth = 1) => split[depth] === seg, [split]);

    // Derived user display values
    const userName = user ? `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() : "";
    const userRole = user?.role ?? "";
    const userDivision = user?.segmentDesc ?? "";
    const roleLabel = resolveRoleLabel(userRole);
    const roleBadge = resolveRoleBadgeVariant(userRole);

    // Flat link bar: loading skeleton | authenticated flat links | public links
    const navigationLinks = useMemo(() => {
        if (isLoading) return [{ name: "Loading…", href: "#", isLoading: true }];
        if (user) return authFlatLinks.map((item) => ({ ...item, current: isActive(item.href.split("/")[1], 1) }));
        return publicLinks.map((item) => ({ ...item, current: isActive(item.href.split("/")[1] || "", 1) }));
    }, [isLoading, user, authFlatLinks, publicLinks, isActive]);

    return (
        <>
            <Menu
                as="nav"
                className={`
                sticky top-0 z-50 w-full font-aumovio
                ${MAIN_OVERLAY_COLOR_BG}
                border-b border-(--border-elevation)
                ${isScrolled ? "shadow-lg shadow-black/10" : ""}
            `}
            >
                {({ open }) => (
                    <>
                        {open && <div className="fixed inset-0 z-40 lg:hidden bg-black/10" />}

                        <div className="relative">
                            <div className="relative flex items-center justify-between h-16 px-4">
                                {/* Logo + version badge */}
                                <div className="flex items-center gap-2.5">
                                    <NavLink to="/" className="flex items-center gap-2">
                                        <Logo className="h-8 md:h-10 lg:h-12 w-auto" />
                                        {APP_DISPLAY_NAME && <span className={`hidden md:block tracking-widest text-base ${BASE_COLOR_TEXT}`}>{APP_DISPLAY_NAME}</span>}
                                    </NavLink>
                                    {/* Version + release-stage badge → links to Version History */}
                                    <VersionBadge version={version} stage={stage} to="/other/changelog" className="hidden md:inline-flex" />
                                </div>

                                {/* Desktop centred link bar */}
                                <div className="justify-center flex-1 hidden lg:flex">
                                    <div className="flex items-center gap-1">
                                        {navigationLinks.map((item, i) =>
                                            item.isLoading ? (
                                                <div key={`loading-${i}`} className={`${SECONDARY_COLOR_TEXT} animate-pulse ${MAIN_PULSE_COLOR_BG} px-3 py-2 rounded-lg text-sm`}>
                                                    <span className={`inline-block w-20 bg-(--accent-subtle) rounded animate-pulse text-transparent ${DELAY_1}`}>Loading…</span>
                                                </div>
                                            ) : (
                                                <NavItem key={item.name} item={item} />
                                            ),
                                        )}

                                        {/* Role-based mega-menu groups */}
                                        {navGroups.map((group) => (
                                            <DropdownGroup key={group.label} group={group} isLoading={isLoading} />
                                        ))}
                                    </div>
                                </div>

                                {/* Right rail: Personalize + Avatar + Burger */}
                                <div className="flex items-center gap-2">
                                    <button onClick={() => setPersonalizeOpen(true)} aria-label="Personalize" title="Personalize" className={`p-2 border border-transparent rounded-lg text-grey-500 dark:text-grey-400 hover:text-(--nav-active-text) hover:bg-(--nav-hover-bg) hover:border-(--accent)/20 ${TRANSITION_COLORS}`}>
                                        <PaintBrushIcon className="w-4 h-4" />
                                    </button>

                                    {/* Profile dropdown (desktop) */}
                                    {(user || isLoading) && (
                                        <Menu as="div" className="relative hidden md:block">
                                            <MenuButton
                                                disabled={isLoading}
                                                className={`
                                                focus-visible:outline-none
                                                focus-visible:ring-2 focus-visible:ring-(--accent)/50
                                                rounded-full ${TRANSITION_SPRING}
                                                hover:ring-2 hover:ring-(--accent)/40
                                            `}
                                            >
                                                {isLoading ? <div className="w-9 h-9 rounded-full bg-(--accent-subtle) animate-pulse" /> : <Avatar name={userName} size="sm" bordered />}
                                            </MenuButton>

                                            <Transition as="div" enter={ANIMATE_SCALE_IN} leave={ANIMATE_SCALE_OUT}>
                                                <MenuItems
                                                    className="
                                                    absolute right-0 z-50 mt-2 w-56
                                                    bg-(--bg-surface-2)
                                                    rounded-xl shadow-2xl
                                                    ring-1 ring-black/5 dark:ring-(--color-dark-muted)/20
                                                    focus:outline-none overflow-hidden
                                                "
                                                >
                                                    {/* USER info header */}
                                                    <div className="px-4 py-3 border-b border-grey-100 dark:border-grey-800">
                                                        <div className="flex items-center gap-2.5">
                                                            <Avatar name={userName} size="sm" />
                                                            <div className="min-w-0">
                                                                <p className="text-sm font-aumovio-bold text-black/85 dark:text-(--color-dark-text) truncate">{userName}</p>
                                                                <Badge variant={roleBadge} size="xs" pill>
                                                                    {roleLabel}
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
                                                                        ${item.danger ? "text-danger-500 dark:text-danger-400 hover:bg-danger-50 dark:hover:bg-danger-400/10" : "text-grey-700 dark:text-grey-300 hover:bg-(--nav-hover-bg) hover:text-(--nav-active-text)"}
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
                                        </Menu>
                                    )}

                                    {/* Mobile burger */}
                                    <MenuButton
                                        className={`
                                        lg:hidden inline-flex items-center justify-center p-2
                                        rounded-lg ${TRANSITION_SPRING}
                                        text-grey-600 dark:text-grey-300
                                        hover:bg-(--nav-hover-bg)
                                        hover:text-(--nav-active-text)
                                    `}
                                    >
                                        <span className="sr-only">Open main menu</span>
                                        {open ? <XMarkIcon aria-hidden="true" className="w-5 h-5" /> : <Bars3Icon aria-hidden="true" className="w-5 h-5" />}
                                    </MenuButton>
                                </div>
                            </div>
                        </div>

                        {/* Mobile drawer */}
                        <Transition show={open} as="div" className="absolute left-0 right-0 z-50 lg:hidden top-full" enter={ANIMATE_SLIDE_DOWN} leave={ANIMATE_SCALE_OUT}>
                            <div
                                className={`
                                mx-2 mb-2 px-2 pt-4 pb-4 space-y-1
                                overflow-auto rounded-xl shadow-2xl
                                max-h-[90vh] hide-scrollbar
                                ${MAIN_OVERLAY_COLOR_BG}
                                border border-grey-100 dark:border-grey-800
                            `}
                            >
                                {/* Mobile user card */}
                                {user && (
                                    <div className="flex items-center gap-3 px-3 py-2.5 mb-2 rounded-xl bg-(--accent-subtle) border border-(--border-subtle)">
                                        <Avatar name={userName} size="sm" />
                                        <div className="min-w-0">
                                            <p className="text-sm font-aumovio-bold text-black/85 dark:text-(--color-dark-text) truncate">{userName}</p>
                                            <Badge variant={roleBadge} size="xs" pill>
                                                {roleLabel}
                                            </Badge>
                                        </div>
                                    </div>
                                )}

                                {/* Flat navigation links */}
                                {navigationLinks.map((item, i) => (
                                    <NavLink key={item.name || `mobile-${i}`} to={item.isLoading ? "#" : item.href} onClick={item.isLoading ? (e) => e.preventDefault() : undefined}>
                                        <div
                                            className={`
                                            px-3 py-2 rounded-xl text-sm font-aumovio
                                            ${TRANSITION_COLORS} block
                                            ${item.isLoading ? `${SECONDARY_COLOR_TEXT} animate-pulse bg-(--accent-subtle) cursor-default` : item.current ? `${MAIN_FOREGROUND_COLOR_TEXT} bg-(--nav-active-bg) border border-(--nav-active-border)/25` : `${TITLE_COLOR_TEXT} hover:bg-(--nav-hover-bg) hover:text-(--nav-active-text)`}
                                        `}
                                        >
                                            {item.isLoading ? <span className="w-20 bg-(--accent-subtle) rounded animate-pulse text-transparent">…</span> : item.name}
                                        </div>
                                    </NavLink>
                                ))}

                                {/* Mobile group links (flat) */}
                                {navGroups.map((group) => (
                                    <div key={group.label} className="pt-3 border-t border-grey-100 dark:border-grey-800">
                                        <p className="px-3 pb-1 text-[10px] font-aumovio-bold uppercase tracking-widest text-grey-400">{group.label}</p>
                                        {group.items.map((item) => {
                                            const active = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href + "/"));
                                            return (
                                                <NavLink key={item.name} to={item.href}>
                                                    <div
                                                        className={`
                                                            px-3 py-2 rounded-xl text-sm font-aumovio
                                                            transition-all duration-200 block
                                                            ${active ? `${MAIN_FOREGROUND_COLOR_TEXT} bg-(--nav-active-bg)` : `${SUBTITLE_COLOR_TEXT} hover:bg-(--nav-hover-bg) hover:text-(--nav-active-text)`}
                                                        `}
                                                    >
                                                        {item.name}
                                                    </div>
                                                </NavLink>
                                            );
                                        })}
                                    </div>
                                ))}

                                {/* Mobile Account section */}
                                {user && profileItems.filter((i) => !i.divider).length > 0 && (
                                    <div className="pt-3 border-t border-grey-100 dark:border-grey-800">
                                        <p className="px-3 pb-1 text-[10px] font-aumovio-bold uppercase tracking-widest text-grey-400">Account</p>
                                        {profileItems
                                            .filter((item) => !item.divider)
                                            .map((item) => {
                                                const Icon = item.icon;
                                                return (
                                                    <button
                                                        key={item.id}
                                                        onClick={item.onClick ?? (() => {})}
                                                        className={`
                                                        w-full flex items-center gap-2.5
                                                        px-3 py-2 rounded-xl text-sm font-aumovio
                                                        transition-colors duration-150 text-left
                                                        ${item.danger ? "text-danger-500 hover:bg-danger-50 dark:hover:bg-danger-400/10" : `${SUBTITLE_COLOR_TEXT} hover:bg-(--nav-hover-bg) hover:text-(--nav-active-text)`}
                                                    `}
                                                    >
                                                        {Icon && <Icon className="w-4 h-4 shrink-0" />}
                                                        {item.label}
                                                    </button>
                                                );
                                            })}
                                    </div>
                                )}

                                {/* Mobile personalize */}
                                <div className="pt-3 border-t border-grey-100 dark:border-grey-800">
                                    <button onClick={() => setPersonalizeOpen(true)} className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm font-aumovio text-left ${TRANSITION_COLORS} text-grey-600 dark:text-grey-400 hover:bg-(--nav-hover-bg) hover:text-(--nav-active-text)`}>
                                        <PaintBrushIcon className="w-4 h-4 shrink-0" />
                                        Personalize
                                    </button>
                                </div>

                                {/* Mobile version + release-stage badge → Version History */}
                                <div className="pt-3 mt-1 border-t border-grey-100 dark:border-grey-800 flex justify-center">
                                    <VersionBadge version={version} stage={stage} to="/other/changelog" />
                                </div>
                            </div>
                        </Transition>
                    </>
                )}
            </Menu>

            {/* Profile modal — portalled to body */}
            <ProfileModal open={profileOpen} onClose={closeProfile} user={user} />

            {/* Personalize modal — portalled to body */}
            <PersonalizeModal open={personalizeOpen} onClose={() => setPersonalizeOpen(false)} />
        </>
    );
}
