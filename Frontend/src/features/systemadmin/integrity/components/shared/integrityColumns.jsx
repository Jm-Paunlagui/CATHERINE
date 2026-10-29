/**
 * @fileoverview Per-table column definitions for the Integrity Center.
 *
 * The Integrity verdict column is appended generically by IntegrityTablePanel,
 * so it is NOT repeated here. A project registers a column array per table key
 * (mirroring the backend row projection in models/integrity.model.js); an
 * unregistered table derives its columns from the first row it receives.
 */

import { formatDateTime } from "../../../../../utils/formatters";

const idCell = (v) => <span className="font-mono font-aumovio-bold text-black/85 dark:text-white/85">{v ?? "—"}</span>;
const text = (v) => <span className="text-sm text-black/85 dark:text-white/85">{v ?? "—"}</span>;
const date = (v) => <span className="text-xs text-black/60 dark:text-white/60 whitespace-nowrap">{v ? formatDateTime(v) : "—"}</span>;

const col = (key, label, render) => ({ key, label, render: (row) => render(row[key]) });

/** Register `<tableKey>: [col("COLUMN", "Label", text), ...]` here (renderers: idCell, text, date). */
const COLUMNS = {};

/** Row fields that are verdict/plumbing, never data columns. */
const INTERNAL_KEYS = new Set(["integrity", "ROW_HASH", "SYSSIGNATURE", "contentDigest"]);

const humanise = (key) =>
    String(key)
        .toLowerCase()
        .split("_")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");

/**
 * Returns the column array for a table key. Unregistered tables derive their
 * columns from `sampleRow` (first column = id cell, `*_AT` / `*DATE*` = date).
 *
 * @param {string} tableKey
 * @param {object} [sampleRow]
 * @returns {Array<{ key:string, label:string, render:Function }>}
 */
export function getColumns(tableKey, sampleRow) {
    if (COLUMNS[tableKey]) return COLUMNS[tableKey];
    if (!sampleRow) return [];
    return Object.keys(sampleRow)
        .filter((k) => !INTERNAL_KEYS.has(k))
        .map((k, i) => col(k, humanise(k), i === 0 ? idCell : /(_AT|DATE)/i.test(k) ? date : text));
}

export default getColumns;
