/**
 * purgeGroupMeta.js — Friendly display metadata for purge group keys.
 *
 * Pure helper, no React, no side effects — shared by `PurgeScopeSelector`
 * and `PurgeStepperModal` (CLAUDE.md §9: pure helpers used by 2+ components
 * live in a feature's `components/shared/` folder, not duplicated per file
 * or exported from a component file — the latter also breaks Fast Refresh,
 * `react-refresh/only-export-components`).
 *
 * Purely presentational. The group keys themselves, their tables, and their
 * row counts always come from `GET /scopes` — nothing here can drift the
 * actual purgeable scope. A project adds a label here for each group it
 * registers in the backend's PURGE_GROUP_KEYS.
 */

/** @type {Record<string, { label: string, description: string }>} */
export const GROUP_META = {
    SERVER_: { label: "Server Alerts", description: "Server alert log and acknowledgement records" },
    T_: { label: "Core & Admin", description: "Accounts, admin accounts, and audit logs" },
};

/**
 * @param {string} group - A purge group key, e.g. `"T_"`.
 * @returns {string} The friendly display label, or the raw key if unknown.
 */
export function groupLabel(group) {
    return GROUP_META[group]?.label ?? group;
}

export default GROUP_META;
