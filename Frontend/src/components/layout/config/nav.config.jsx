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
 *
 * NOTE: This is the TEMPLATE information architecture. Every href below resolves
 * to a mounted route in App.jsx. Keep it that way — a nav entry with no route is
 * a broken link in a boilerplate whose whole job is to be copied cleanly.
 */

import { LuBookOpen, LuCircleHelp, LuCoins, LuDatabase, LuDatabaseBackup, LuGitBranch, LuHistory, LuHouse, LuLayoutDashboard, LuLogIn, LuNetwork, LuRocket, LuScrollText, LuServerCog, LuShieldCheck, LuUserCog } from "react-icons/lu";

const SIZE = 18;
const STROKE = 1.75;

// Single factory so every icon shares size + stroke — guarantees a uniform set.
const icon = (Glyph) => <Glyph size={SIZE} strokeWidth={STROKE} />;

// ── Unauthenticated flat links ────────────────────────────────────────────────
export const PUBLIC_LINKS = [
    { name: "Home", href: "/home", icon: icon(LuHouse) },
    { name: "Getting Started", href: "/about/getting-started", icon: icon(LuRocket) },
    { name: "Help Center", href: "/about/help", icon: icon(LuCircleHelp) },
    { name: "Sign In", href: "/auth", icon: icon(LuLogIn) },
];

// ── Authenticated flat links (shown above groups in both layouts) ──────────────
export const AUTH_FLAT_LINKS = [{ name: "Dashboard", href: "/dashboard", icon: icon(LuLayoutDashboard) }];

// ── Version-disclosure policy ─────────────────────────────────────────────────
// Single source of truth for who may SEE the app version in the chrome
// (nav item + VersionBadge). Cybersecurity (CWE-200 Information Exposure — a
// visible version string helps an attacker match known CVEs) asks for it hidden
// from non-admins. The /about/changelog route stays public
// and link-reachable regardless — this only controls surfaced visibility.
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
        { name: "Admin Management", href: "/system/admin-management", icon: icon(LuUserCog), description: "Provision administrator accounts and assign their roles" },
        { name: "Logging and Observability", href: "/system/logging-and-observability", icon: icon(LuScrollText), description: "Four Golden Signals, deep trace inspection, and log retention" },
        { name: "Data Integrity", href: "/system/data-integrity", icon: icon(LuShieldCheck), description: "Per-table HMAC tamper monitoring with live change streams" },
        { name: "Data Management", href: "/system/data-purge", icon: icon(LuDatabaseBackup), description: "Scheduled backups, backup-gated purge, and archive restore" },
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

// Omission from other roles is discoverability only; the API gates are requireAdminAccess (/dev-docs) and requireSuperAdmin (/architecture).
const DEV_DOCS_ITEM = { name: "Dev Docs", href: "/support/dev-docs", icon: icon(LuBookOpen), description: "Internal architecture reference" };
const SUPPORT_GROUP_ADMIN = { ...SUPPORT_GROUP, items: [...SUPPORT_GROUP.items, DEV_DOCS_ITEM] };
const SUPPORT_GROUP_SUPER_ADMIN = {
    ...SUPPORT_GROUP,
    items: [
        ...SUPPORT_GROUP.items,
        DEV_DOCS_ITEM,
        { name: "Architecture", href: "/support/architecture", icon: icon(LuNetwork), description: "Interactive system map and request flows" },
        { name: "Runtime", href: "/support/runtime", icon: icon(LuServerCog), description: "Scheduling, backup, resilience and shutdown — as the server simulation runs them" },
    ],
};

// ── Role-based nav groups ─────────────────────────────────────────────────────
// Add or remove roles here to match your backend's role strings.
export const NAV_GROUPS = {
    USER: [REFERENCE_GROUP_NO_VERSION, SUPPORT_GROUP],

    ADMIN: [REFERENCE_GROUP, SUPPORT_GROUP_ADMIN],

    SUPER_ADMIN: [REFERENCE_GROUP, SYSTEM_GROUP, SUPPORT_GROUP_SUPER_ADMIN],
};

