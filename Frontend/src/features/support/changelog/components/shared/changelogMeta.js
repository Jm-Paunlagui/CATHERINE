/**
 * changelogMeta.js — shared metadata and pure date/grouping helpers for the
 * Version History feature.
 *
 * Tier-2 shared: consumed by the date-journey rail (DateJourneyNav), the
 * selected-date panel (DateJourneyPanel), the create/edit form, and the hook
 * itself. Keeping TYPE_META in one place is what stops the rail's type dots
 * from drifting away from the entry badges they summarise.
 *
 * No JSX lives here on purpose — the shared BADGES are in ChangelogBadges.jsx,
 * so neither file mixes component exports with constant exports
 * (react-refresh/only-export-components).
 */

import { faBug, faCodeBranch, faFileLines, faFlagCheckered, faFlask, faGears, faRocket, faShieldHalved, faTriangleExclamation, faWrench } from "@fortawesome/free-solid-svg-icons";

// ── Type metadata ─────────────────────────────────────────────────────────────

export const TYPE_META = {
    breaking: { badge: "red", icon: faTriangleExclamation, label: "Breaking", dotColor: "bg-danger-400" },
    feat: { badge: "blue", icon: faRocket, label: "Feature", dotColor: "bg-blue-400" },
    fix: { badge: "red", icon: faBug, label: "Bug Fix", dotColor: "bg-danger-400" },
    patch: { badge: "amber", icon: faWrench, label: "Patch", dotColor: "bg-warn-400" },
    perf: { badge: "purple", icon: faGears, label: "Performance", dotColor: "bg-purple-400" },
    refactor: { badge: "grey", icon: faCodeBranch, label: "Refactor", dotColor: "bg-grey-400" },
    security: { badge: "orange", icon: faShieldHalved, label: "Security", dotColor: "bg-orange-400" },
    // Badge.jsx's variant map has no "teal" key (only
    // "cyan") — "teal" was silently falling back to grey.
    test: { badge: "cyan", icon: faFlask, label: "Test", dotColor: "bg-teal-400" },
    docs: { badge: "cyan", icon: faFileLines, label: "Docs", dotColor: "bg-blue-300" },
    chore: { badge: "grey", icon: faGears, label: "Chore", dotColor: "bg-grey-300" },
    release: { badge: "green", icon: faFlagCheckered, label: "Release", dotColor: "bg-success-400" },
};

export const TYPE_OPTIONS = Object.entries(TYPE_META).map(([value, { label }]) => ({ value, label }));

/**
 * Type metadata for an entry, falling back to `feat` for an unknown type so a
 * future backend type never renders an undefined badge.
 * @param {string} type
 */
export function typeMeta(type) {
    return TYPE_META[type] ?? TYPE_META.feat;
}

// ── Date formatting ───────────────────────────────────────────────────────────

/**
 * "YYYY-MM-DD" → a LOCAL Date. Never `new Date(iso)` — that parses the string
 * as UTC midnight and renders the previous day west of UTC.
 * @param {string} iso
 * @returns {Date}
 */
function localDate(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d);
}

/** Full, human date used for the panel heading. e.g. "Sunday, July 26, 2026" */
export function formatDisplayDate(iso) {
    return localDate(iso).toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

/** Compact date used in the journey rail. e.g. "Jul 26" */
export function formatRailDate(iso) {
    return localDate(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Short weekday used as the rail's secondary line. e.g. "Sun" */
export function formatRailWeekday(iso) {
    return localDate(iso).toLocaleDateString("en-US", { weekday: "short" });
}

/** Medium date used in the prev/next journey footer. e.g. "Jul 26, 2026" */
export function formatMediumDate(iso) {
    return localDate(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

// ── Grouping ──────────────────────────────────────────────────────────────────

/**
 * Groups entries into one bucket per displayDate, newest date first, and
 * pre-computes everything the rail needs so it never re-scans entries per row.
 *
 * @param {object[]} entries
 * @returns {Array<{ date: string, year: string, entries: object[], count: number, types: string[] }>}
 */
export function buildDateGroups(entries) {
    const byDate = new Map();
    for (const entry of entries ?? []) {
        const key = entry.displayDate;
        if (!key) continue;
        if (!byDate.has(key)) byDate.set(key, []);
        byDate.get(key).push(entry);
    }

    return [...byDate.entries()]
        .sort(([a], [b]) => b.localeCompare(a))
        .map(([date, dateEntries]) => ({
            date,
            year: date.slice(0, 4),
            entries: dateEntries,
            count: dateEntries.length,
            // Distinct types in first-appearance order — drives the rail's type dots.
            types: [...new Set(dateEntries.map((e) => e.type))],
        }));
}

/**
 * Filters date groups by a free-text query. A group survives if the query
 * matches its date (raw ISO or formatted) or ANY of its entries' version /
 * title / message / type label — so searching "1.20.0" or "security" finds the
 * date that shipped it, not just dates whose label matches.
 *
 * @param {ReturnType<typeof buildDateGroups>} groups
 * @param {string} query
 */
export function filterDateGroups(groups, query) {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter((g) => {
        if (g.date.includes(q) || formatDisplayDate(g.date).toLowerCase().includes(q)) return true;
        return g.entries.some((e) =>
            [e.version, e.title, e.message, typeMeta(e.type).label].some((field) =>
                String(field ?? "")
                    .toLowerCase()
                    .includes(q),
            ),
        );
    });
}
