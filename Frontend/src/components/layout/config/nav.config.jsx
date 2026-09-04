/**
 * nav.config.jsx â€” Single source of truth for all navigation.
 *
 * To configure this for a new project:
 *   1. Update PUBLIC_LINKS with unauthenticated routes.
 *   2. Update AUTH_FLAT_LINKS with top-level authenticated routes (e.g. Dashboard).
 *   3. Update NAV_GROUPS per role with feature routes.
 *      â€¢ color        â†’ sidebar group accent  (orange|purple|blue|turquoise|yellow|success|danger|warn|grey)
 *                     Palette-responsive: orange, purple, blue, turquoise, yellow
 *                     Semantic (fixed):   success, danger, warn, grey
 *      â€¢ icon         â†’ JSX element           (shown in Sidebar; ignored by Navbar)
 *      â€¢ description  â†’ subtitle string       (shown in Navbar dropdown; ignored by Sidebar)
 *
 * Both Navbar and Sidebar import from here â€” change once, both update.
 *
 * Icon library: Lucide (react-icons/lu) â€” single thin, rounded outline set for a
 * consistent look. SIZE + STROKE keep every glyph visually uniform; never mix in
 * filled sets (react-icons/md, react-icons/fa) here or the sidebar looks uneven.
 *
 * NOTE: This is the TEMPLATE information architecture. Every href below resolves
 * to a mounted route in App.jsx. Keep it that way â€” a nav entry with no route is
 * a broken link in a boilerplate whose whole job is to be copied cleanly.
 */

import { LuChartBar, LuCircleHelp, LuCoins, LuDatabase, LuGitBranch, LuHistory, LuHouse, LuLayoutDashboard, LuLogIn, LuNetwork, LuRocket, LuScrollText, LuUserCog } from "react-icons/lu";

const SIZE = 18;
const STROKE = 1.75;

// Single factory so every icon shares size + stroke â€” guarantees a uniform set.
const icon = (Glyph) => <Glyph size={SIZE} strokeWidth={STROKE} />;

// â”€â”€ Unauthenticated flat links â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export const PUBLIC_LINKS = [
    { name: "Home", href: "/home", icon: icon(LuHouse) },
    { name: "Getting Started", href: "/about/getting-started", icon: icon(LuRocket) },
    { name: "Help Center", href: "/about/help", icon: icon(LuCircleHelp) },
    { name: "Sign In", href: "/auth", icon: icon(LuLogIn) },
];

// â”€â”€ Authenticated flat links (shown above groups in both layouts) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export const AUTH_FLAT_LINKS = [{ name: "Dashboard", href: "/dashboard", icon: icon(LuLayoutDashboard) }];

// â”€â”€ Version-disclosure policy â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Single source of truth for who may SEE the app version in the chrome
// (nav item + VersionBadge). Cybersecurity (CWE-200 Information Exposure â€” a
// visible version string helps an attacker match known CVEs) and HR (employees
// don't need it) asked for it hidden. The /about/changelog route stays public
// and link-reachable regardless â€” this only controls surfaced visibility.
const VERSION_VISIBLE_ROLES = new Set(["ADMIN", "SUPER_ADMIN"]);

/**
 * Whether the given role may see the version badge / Version History nav entry.
 * @param {string} [role] - The authenticated user's role string (e.g. "ADMIN").
 * @returns {boolean} True for ADMIN / SUPER_ADMIN, false for everyone else and anon.
 * @example canSeeVersion("USER") // false
 * @example canSeeVersion("ADMIN") // true
 */
export function canSeeVersion(role) {
    return VERSION_VISIBLE_ROLES.has(role);
}

// ── Reference group ───────────────────────────────────────────────────────────
// The template's documentation surface. Shared by every authenticated role.
// Version History visibility is filtered per-role via the *_NO_VERSION variant.
const REFERENCE_GROUP = {
    label: "Reference",
    color: "blue",
    items: [
        { name: "Database Connection", href: "/about/database-connection", icon: icon(LuDatabase), description: "How the app connects to Oracle and manages pooled connections" },
        { name: "Mira ORM", href: "/about/mira-orm", icon: icon(LuGitBranch), description: "The oracle-mongo-wrapper query layer and how models map to tables" },
        { name: "Money and Currency", href: "/about/money", icon: icon(LuCoins), description: "Exact-decimal money, ISO 4217 currencies, and the accounting rules a copier must not break" },
        { name: "CORS Setup", href: "/about/cors-setup", icon: icon(LuNetwork), description: "Cross-origin request configuration for the API and the SPA" },
        { name: "Version History", href: "/about/changelog", icon: icon(LuHistory), description: "What's changed in each release" },
    ],
};

// A copy of REFERENCE_GROUP with Version History dropped — for roles that may
// not surface the version string (canSeeVersion === false).
const REFERENCE_GROUP_NO_VERSION = {
    ...REFERENCE_GROUP,
    items: REFERENCE_GROUP.items.filter((i) => i.href !== "/about/changelog"),
};

// ── System group ──────────────────────────────────────────────────────────────
// Operational tooling. SUPER_ADMIN only (matches the ProtectedRoute gates in App.jsx).
const SYSTEM_GROUP = {
    label: "System",
    color: "purple",
    items: [
        { name: "Admin Management", href: "/system/admin-management", icon: icon(LuUserCog), description: "Provision administrators and automation/robot service accounts" },
        { name: "Logging and Observability", href: "/system/logging-and-observability", icon: icon(LuScrollText), description: "Four Golden Signals, deep trace inspection, and log retention" },
        { name: "Metrics", href: "/system/metrics", icon: icon(LuChartBar), description: "Runtime metrics dashboard across the API surface" },
    ],
};

// ── Support group ─────────────────────────────────────────────────────────────
const SUPPORT_GROUP = {
    label: "Support",
    color: "grey",
    items: [
        { name: "Getting Started", href: "/about/getting-started", icon: icon(LuCircleHelp), description: "Set-up walkthrough and where to go next" },
        { name: "Help Center", href: "/about/help", icon: icon(LuCircleHelp), description: "Searchable answers about accounts, sessions, logging, and more" },
    ],
};

// ── Role-based nav groups ─────────────────────────────────────────────────────
// Add or remove roles here to match your backend's role strings.
export const NAV_GROUPS = {
    USER: [REFERENCE_GROUP_NO_VERSION, SUPPORT_GROUP],

    APPROVER: [REFERENCE_GROUP_NO_VERSION, SUPPORT_GROUP],

    VIEWER: [REFERENCE_GROUP_NO_VERSION, SUPPORT_GROUP],

    ADMIN: [REFERENCE_GROUP, SUPPORT_GROUP],

    SUPER_ADMIN: [REFERENCE_GROUP, SYSTEM_GROUP, SUPPORT_GROUP],
};

