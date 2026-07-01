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

import { LuBookOpen, LuCircleHelp, LuDatabase, LuHistory, LuHouse, LuLayoutDashboard, LuLogIn, LuScrollText, LuShieldCheck, LuSparkles, LuUserCog } from "react-icons/lu";

const SIZE = 18;
const STROKE = 1.75;

// Single factory so every icon shares size + stroke — guarantees a uniform set.
const icon = (Glyph) => <Glyph size={SIZE} strokeWidth={STROKE} />;

// ── Unauthenticated flat links ────────────────────────────────────────────────
export const PUBLIC_LINKS = [
    { name: "Home", href: "/home", icon: icon(LuHouse) },
    { name: "Sign In", href: "/auth", icon: icon(LuLogIn) },
];

// ── Authenticated flat links (shown above groups in both layouts) ──────────────
export const AUTH_FLAT_LINKS = [{ name: "Dashboard", href: "/dashboard", icon: icon(LuLayoutDashboard) }];

// ── Getting Started docs group ─────────────────────────────────────────────────
// Defined once and shared by every role (NAV_GROUPS) AND the public/unauthenticated
// nav (PUBLIC_GROUPS) — these are developer docs, readable without signing in.
const GETTING_STARTED_GROUP = {
    label: "Getting Started",
    color: "blue",
    items: [
        { name: "Getting Started", href: "/about/getting-started", icon: icon(LuBookOpen), description: "Setup guide, prerequisites, and first steps" },
        { name: "Database Connection", href: "/about/database-connection", icon: icon(LuDatabase), description: "Configure .env, connection registry, and the ORM" },
        { name: "Mira ORM", href: "/about/mira-orm", icon: icon(LuSparkles), description: "The built-in Oracle-Mongo-Wrapper — usage, best practices, testing" },
        { name: "CORS Setup", href: "/about/cors-setup", icon: icon(LuShieldCheck), description: "LAN IP access and the CORS_ORIGINS allow-list" },
    ],
};

// Public (unauthenticated) nav groups — shown in the sidebar/navbar when logged out.
// Version History is public for read-only viewing (the backend GET /changelog is
// unauthenticated; mutations remain SUPER_ADMIN only).
export const PUBLIC_GROUPS = [
    GETTING_STARTED_GROUP,
    {
        label: "About",
        color: "grey",
        items: [{ name: "Version History", href: "/about/changelog", icon: icon(LuHistory), description: "What's changed in each release" }],
    },
];

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
        GETTING_STARTED_GROUP,
        {
            label: "About",
            color: "grey",
            items: [
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
        GETTING_STARTED_GROUP,
        {
            label: "About",
            color: "grey",
            items: [
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
        GETTING_STARTED_GROUP,
        {
            label: "About",
            color: "grey",
            items: [
                { name: "Version History", href: "/about/changelog", icon: icon(LuHistory), description: "What's changed in each release" },
                { name: "Help", href: "/about/help", icon: icon(LuCircleHelp) },
            ],
        },
    ],
    ROBOT: [],
};
