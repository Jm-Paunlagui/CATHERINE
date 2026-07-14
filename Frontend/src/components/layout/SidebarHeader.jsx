/**
 * SidebarHeader.jsx — Top header bar for sidebar layout mode (Aumovio Design System v3.1)
 *
 * Displays the Logo + app name + version badge on the left, and Personalize +
 * Avatar profile dropdown on the right — mirroring the Navbar's right rail.
 * The navigation menu stays in the Sidebar; this is the chrome-only top bar.
 *
 * Only rendered in "sidebar" layout mode (see App.jsx).
 */

import { Menu, MenuButton, MenuItem, MenuItems, Transition } from "@headlessui/react";
import { PaintBrushIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { NavLink } from "react-router-dom";

import { ANIMATE_SCALE_IN, ANIMATE_SCALE_OUT, TRANSITION_COLORS, TRANSITION_SPRING } from "../../assets/styles/pre-set-styles";
import { useVersion } from "../../contexts/version/VersionContext";
import PersonalizeModal from "../../features/personalize/PersonalizeModal";
import ProfileModal from "../feedback/ProfileModal";
import { Avatar } from "../ui/Avatar";
import { Badge } from "../ui/Badge";
import Logo from "../ui/Logo";
import { Tooltip } from "../ui/Tooltip";
import { VersionBadge } from "../ui/VersionBadge";
import { useNav } from "./config/useNav";

const APP_DISPLAY_NAME = import.meta.env.VITE_APP_NAME || null;
const CHANGELOG_HREF = "/support/changelog";

// ── Role helpers (shared with Navbar) ─────────────────────────────────────────
function resolveRoleLabel(role) {
    if (role === "SUPER_ADMIN") return "Super ADMIN";
    if (role === "ADMIN") return "ADMIN";
    if (role === "VENDOR") return "Vendor";
    if (role === "ROBOT") return "Automation";
    return "USER";
}

function resolveRoleBadgeVariant(role) {
    if (role === "SUPER_ADMIN") return "purple";
    if (role === "ADMIN") return "orange";
    if (role === "VENDOR") return "cyan";
    if (role === "ROBOT") return "green";
    return "grey";
}

export default function SidebarHeader() {
    const { version, stage } = useVersion();
    const { user, isLoading, profileItems, profileOpen, closeProfile } = useNav();
    const [personalizeOpen, setPersonalizeOpen] = useState(false);

    const isAuth = Boolean(user) && !isLoading;
    const userName = user ? `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() : "";
    const roleLabel = resolveRoleLabel(user?.role);
    const roleBadge = resolveRoleBadgeVariant(user?.role);

    return (
        <>
            <header
                className={[
                    "sticky top-0 z-50 flex items-center justify-between shrink-0",
                    // Mobile/tablet: standard surface
                    "bg-(--bg-surface) border-b border-(--border-elevation)",
                    // Desktop (lg+): company gradient (orange 60% → via 85% → purple), palette-aware
                    "lg:bg-linear-to-r lg:from-(--color-gradient-from) lg:via-(--color-gradient-from) lg:via-60% lg:to-(--color-gradient-to)",
                    "lg:border-transparent",
                    // Dark mode: soften the gradient so it doesn't overwhelm the dark UI
                    "dark:lg:brightness-85 dark:lg:saturate-90",
                    "h-16 px-4",
                    TRANSITION_COLORS,
                ].join(" ")}
            >
                {/* ── Left: logo + app name + version ── */}
                <div className="flex items-center gap-2.5">
                    {/* Logo + app name — white logo on desktop gradient */}
                    <NavLink to="/" className="flex items-center gap-2">
                        {/* Mobile/tablet: theme-aware logo */}
                        <Logo className="h-8 md:h-10 lg:hidden w-auto" />
                        {/* Desktop: zone-adaptive logo on gradient (never hardcoded white — pale palettes).
                            Display visibility owned by this wrapper span — the Logo's two internal
                            imgs carry ONLY sizing classes so .logo-on-chrome-dark/-light (index.css)
                            has sole control of which mark renders (avoids a hidden/block cascade fight). */}
                        <span className="hidden lg:block">
                            <Logo variant="chrome" className="h-12 w-auto" />
                        </span>
                        {APP_DISPLAY_NAME && <span className="hidden md:block tracking-widest text-base font-normal leading-relaxed text-(--text-primary) lg:text-(--chrome-from-text) lg:drop-shadow-sm">{APP_DISPLAY_NAME}</span>}
                    </NavLink>

                    {/* Version badge — normal on mobile/tablet, glass on desktop gradient.
                        Visibility owned by the wrapper span, not VersionBadge's className —
                        the component's own `inline-flex` base class fights a `hidden` passed
                        via className at equal specificity. */}
                    <span className="hidden md:inline-flex lg:hidden">
                        <VersionBadge version={version} stage={stage} to={CHANGELOG_HREF} />
                    </span>
                    <span className="hidden lg:inline-flex">
                        <VersionBadge version={version} stage={stage} to={CHANGELOG_HREF} glass />
                    </span>
                </div>

                {/* ── Right: Personalize + Avatar profile dropdown ── */}
                <div className="flex items-center gap-2 shrink-0">
                    {/* Personalize button — white on desktop gradient */}
                    <Tooltip content="Personalize" placement="bottom" delay={200}>
                        <button
                            onClick={() => setPersonalizeOpen(true)}
                            aria-label="Personalize"
                            className={`p-2 border rounded-lg
                                max-lg:border-transparent max-lg:text-grey-500 dark:max-lg:text-grey-400 max-lg:hover:text-(--text-accent) max-lg:hover:bg-(--nav-hover-bg) max-lg:hover:border-(--accent)/20
                                lg:text-(--chrome-to-text) lg:bg-(--chrome-to-glass-bg) lg:border-(--chrome-to-glass-border) lg:hover:bg-(--chrome-to-hover-bg) lg:hover:text-(--chrome-to-hover-text)
                                ${TRANSITION_COLORS}`}
                        >
                            <PaintBrushIcon className="w-4 h-4" />
                        </button>
                    </Tooltip>

                    {/* Profile avatar dropdown */}
                    {isAuth && (
                        <Menu as="div" className="relative">
                            <MenuButton className={`rounded-full ${TRANSITION_SPRING} hover:ring-2 hover:ring-(--accent)/40 lg:hover:ring-(--chrome-to-ring) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent)/50 lg:focus-visible:ring-(--chrome-to-ring)`}>
                                <Avatar name={userName} size="sm" bordered />
                            </MenuButton>

                            <Transition as="div" enter={ANIMATE_SCALE_IN} leave={ANIMATE_SCALE_OUT}>
                                <MenuItems className="absolute right-0 z-50 mt-2 w-56 bg-(--bg-surface-2) rounded-xl shadow-2xl ring-1 ring-black/5 dark:ring-(--color-dark-muted)/20 focus:outline-none overflow-hidden">
                                    {/* User info header */}
                                    <div className="px-4 py-3 border-b border-grey-100 dark:border-grey-800">
                                        <div className="flex items-center gap-2.5">
                                            <Avatar name={userName} size="sm" />
                                            <div className="min-w-0">
                                                <p className="text-sm font-aumovio-bold text-(--text-primary) truncate">{userName || "USER"}</p>
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
                                                    <button onClick={item.onClick ?? (() => {})} className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-aumovio ${TRANSITION_COLORS} ${item.danger ? "text-danger-500 dark:text-danger-400 hover:bg-danger-50 dark:hover:bg-danger-400/10" : "text-(--text-secondary) hover:bg-(--nav-hover-bg) hover:text-(--text-accent)"}`}>
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
                </div>
            </header>

            {/* Profile modal — portalled to body */}
            <ProfileModal open={profileOpen} onClose={closeProfile} user={user} />

            {/* Personalize modal — portalled to body */}
            <PersonalizeModal open={personalizeOpen} onClose={() => setPersonalizeOpen(false)} />
        </>
    );
}
