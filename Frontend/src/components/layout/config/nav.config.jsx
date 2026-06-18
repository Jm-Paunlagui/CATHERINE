/**
 * nav.config.jsx — Single source of truth for all navigation.
 *
 * To configure this for a new project:
 *   1. Update PUBLIC_LINKS with unauthenticated routes.
 *   2. Update AUTH_FLAT_LINKS with top-level authenticated routes (e.g. Dashboard).
 *   3. Update NAV_GROUPS per role with feature routes.
 *      • color        → sidebar group accent  (orange|purple|blue|turquoise|yellow|success|danger|warn|grey)
 *                     Palette-responsive: orange, purple, blue, turquoise, yellow
 *                     Semantic (fixed):   success, danger, warn, grey
 *      • icon         → JSX element           (shown in Sidebar; ignored by Navbar)
 *      • description  → subtitle string       (shown in Navbar dropdown; ignored by Sidebar)
 *
 * Both Navbar and Sidebar import from here — change once, both update.
 *
 * Icon library: Lucide (react-icons/lu) — single thin, rounded outline set for a
 * consistent look. SIZE + STROKE keep every glyph visually uniform; never mix in
 * filled sets (react-icons/md, react-icons/fa) here or the sidebar looks uneven.
 */

import { LuBookOpen, LuCircleHelp, LuHistory, LuHouse, LuLayoutDashboard, LuLogIn, LuScrollText, LuUserCog } from "react-icons/lu";

const SIZE = 18;
const STROKE = 1.75;

// Single factory so every icon shares size + stroke — guarantees a uniform set.
const icon = (Glyph) => <Glyph size={SIZE} strokeWidth={STROKE} />;

// ── Unauthenticated flat links ────────────────────────────────────────────────
export const PUBLIC_LINKS = [
    { name: "Home", href: "/", icon: icon(LuHouse) },
    { name: "Getting Started", href: "/about/getting-started", icon: icon(LuBookOpen) },
    { name: "Sign In", href: "/auth", icon: icon(LuLogIn) },
];

// ── Authenticated flat links (shown above groups in both layouts) ──────────────
export const AUTH_FLAT_LINKS = [{ name: "Dashboard", href: "/dashboard", icon: icon(LuLayoutDashboard) }];

// ── Role-based nav groups ─────────────────────────────────────────────────────
// Add or remove roles here to match your backend's role strings.
export const NAV_GROUPS = {
    USER: [
        {
            label: "System",
            color: "purple",
            items: [
                { name: "Logging & Observability", href: "/system/logging-and-observability", icon: icon(LuScrollText), description: "Audit and activity logs" },
                { name: "Admin Management", href: "/system/admin-management", icon: icon(LuUserCog), description: "Create and manage user accounts" },
            ],
        },
        {
            label: "About",
            color: "grey",
            items: [
                { name: "Getting Started", href: "/about/getting-started", icon: icon(LuBookOpen), description: "Setup guide, prerequisites, and first steps" },
                { name: "Version History", href: "/about/changelog", icon: icon(LuHistory), description: "What's changed in each release" },
                { name: "Help", href: "/about/help", icon: icon(LuCircleHelp) },
            ],
        },
    ],

    ADMIN: [
        {
            label: "System",
            color: "purple",
            items: [
                { name: "Logging & Observability", href: "/system/logging-and-observability", icon: icon(LuScrollText), description: "Audit and activity logs" },
                { name: "Admin Management", href: "/system/admin-management", icon: icon(LuUserCog), description: "Create and manage user accounts" },
            ],
        },
        {
            label: "About",
            color: "grey",
            items: [
                { name: "Getting Started", href: "/about/getting-started", icon: icon(LuBookOpen), description: "Setup guide, prerequisites, and first steps" },
                { name: "Version History", href: "/about/changelog", icon: icon(LuHistory), description: "What's changed in each release" },
                { name: "Help", href: "/about/help", icon: icon(LuCircleHelp) },
            ],
        },
    ],

    SUPER_ADMIN: [
        {
            label: "System",
            color: "purple",
            items: [
                { name: "Logging & Observability", href: "/system/logging-and-observability", icon: icon(LuScrollText), description: "Audit and activity logs" },
                { name: "Admin Management", href: "/system/admin-management", icon: icon(LuUserCog), description: "Create and manage user accounts" },
            ],
        },
        {
            label: "About",
            color: "grey",
            items: [
                { name: "Getting Started", href: "/about/getting-started", icon: icon(LuBookOpen), description: "Setup guide, prerequisites, and first steps" },
                { name: "Version History", href: "/about/changelog", icon: icon(LuHistory), description: "What's changed in each release" },
                { name: "Help", href: "/about/help", icon: icon(LuCircleHelp) },
            ],
        },
    ],
    ROBOT: [],
};
