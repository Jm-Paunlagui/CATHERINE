/**
 * excelStepperHelpers.js — Pure helper functions shared across all Excel
 * upload stepper features.
 *
 * Plain JS module — no React, no JSX. All exports are named; no default export.
 */

// ─── Step factory ─────────────────────────────────────────────────────────────

/**
 * Builds the 3-step array consumed by the Stepper component.
 * Steps 1 and 2 are identical across all Excel upload features.
 * Only the step-3 description varies by feature (e.g. "Records updated").
 *
 * @param {string} completeDescription - Description text for the Complete step.
 * @returns {Array<{ id: string, label: string, description: string }>}
 *
 * @example
 * const steps = makeUploadSteps('Records updated');
 * // [
 * //   { id: 'upload',   label: 'Upload File',  description: 'Select your .xlsx file' },
 * //   { id: 'verify',   label: 'Verify Data',  description: 'Review DB-classified rows' },
 * //   { id: 'complete', label: 'Complete',     description: 'Records updated' },
 * // ]
 */
export function makeUploadSteps(completeDescription) {
    return [
        { id: "upload", label: "Upload File", description: "Select your .xlsx file" },
        { id: "verify", label: "Verify Data", description: "Review DB-classified rows" },
        { id: "complete", label: "Complete", description: completeDescription },
    ];
}

// ─── Sort helpers ─────────────────────────────────────────────────────────────

/**
 * Sorts classified rows by a caller-supplied status priority map.
 * Statuses absent from `sortOrder` sink to the bottom (priority 99).
 * Stable tie-break by original array index.
 *
 * When `useExcluded` is true (default), excluded rows always sort after
 * non-excluded rows within the same status group — the shared uploader
 * behaviour. Set to false for features that have no excluded flag
 * at all.
 *
 * @param {Array<object>} rows - Classified rows to sort.
 * @param {{ [status: string]: number }} sortOrder - Map of status → sort priority (lower = first).
 * @param {boolean} [useExcluded=true] - Whether to hoist non-excluded rows above excluded ones.
 * @returns {Array<{ row: object, originalIndex: number }>}
 *
 * @example
 * const ORDER = { Conflict: 0, Update: 1, Create: 2, Retain: 3 };
 * const sorted = sortAndIndexRows(verifiedRows, ORDER);
 * sorted.forEach(({ row, originalIndex }) => { ... });
 */
export function sortAndIndexRows(rows, sortOrder, useExcluded = true) {
    return rows
        .map((row, originalIndex) => ({ row, originalIndex }))
        .sort((a, b) => {
            if (useExcluded && a.row.excluded !== b.row.excluded) {
                return a.row.excluded ? 1 : -1;
            }
            const orderA = sortOrder[a.row.status] ?? 99;
            const orderB = sortOrder[b.row.status] ?? 99;
            if (orderA !== orderB) return orderA - orderB;
            return a.originalIndex - b.originalIndex;
        });
}

// ─── Row tint helper ──────────────────────────────────────────────────────────

/**
 * Returns the Tailwind background tint class for a verify-table row.
 *
 * `colorMap` maps each status string to its Tailwind class string.
 * Rows with `excluded === true` always get the excluded tint regardless of
 * colorMap. Statuses absent from colorMap fall back to `defaultClass`.
 *
 * @param {string}  status       - Row status value (e.g. "Create", "Conflict").
 * @param {boolean} [excluded]   - Whether the row has been manually excluded.
 * @param {{ [status: string]: string }} colorMap - Map of status → Tailwind class.
 * @param {string}  [defaultClass="bg-white dark:bg-(--bg-surface)"] - Fallback class.
 * @returns {string}
 *
 * @example
 * const COLOR_MAP = {
 *   Create:   'bg-success-100/10 dark:bg-success-400/5',
 *   Update:   'bg-orange-50 dark:bg-orange-400/5',
 *   Conflict: 'bg-danger-100/10 dark:bg-danger-400/5',
 *   Retain:   'bg-success-100/5 dark:bg-success-400/5 opacity-70',
 * };
 * const cls = rowTintClass(row.status, row.excluded, COLOR_MAP);
 */
export function rowTintClass(status, excluded, colorMap, defaultClass = "bg-(--bg-surface)") {
    if (excluded) return "bg-grey-50 dark:bg-grey-800/30 opacity-50";
    return colorMap[status] ?? defaultClass;
}
