/**
 * verifyStatus.js — Shared status vocabulary for the upload-stepper verify stage.
 *
 * SINGLE SOURCE OF TRUTH for which row-classification statuses are "Conflict" types
 * and their human-friendly subtype labels. Imported by both VerifyStatusBadge (the
 * pill) and VerifyStatusSummary (the count chips) so the two never drift. Backend
 * classifiers still emit the specific keys; this layer groups them under Conflict.
 *
 * The vocabulary below is deliberately generic. A consuming application with
 * feature-specific blockers extends it at startup via
 * `registerConflictSubtypes({ MyStatus: "My Label" })` instead of editing this
 * file — the badge and summary pick the new subtypes up automatically.
 */

/**
 * Friendly subtype label for each Conflict-family status. `null` = the generic
 * "Conflict" (its detail comes from conflictReason/reason instead of a fixed name).
 *
 * @type {{ [status: string]: string|null }}
 */
export const CONFLICT_SUBTYPE_LABELS = {
    Conflict:      null,
    DuplicateRow:  "Duplicate Row",
    Invalid:       "Invalid",
    Duplicate:     "Duplicate",
    NotFound:      "Not Found",
    NoPeriod:      "No Period",
    Stale:         "Stale",
    IntraFileDupe: "File Dupe",
};

/**
 * Registers app-specific Conflict subtypes (or overrides a label). Call once at
 * startup — e.g. from the app's entry point — before any verify table renders.
 *
 * @param {{ [status: string]: string|null }} subtypes
 */
export function registerConflictSubtypes(subtypes) {
    Object.assign(CONFLICT_SUBTYPE_LABELS, subtypes);
}

/**
 * True when a row status is a kind of Conflict — the generic "Conflict" or any
 * registered blocker subtype (DuplicateRow, NotFound, NoPeriod, …).
 *
 * @param {string|null|undefined} status
 * @returns {boolean}
 */
export function isConflictStatus(status) {
    return status != null && status in CONFLICT_SUBTYPE_LABELS;
}
