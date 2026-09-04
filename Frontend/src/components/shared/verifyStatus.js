/**
 * verifyStatus.js — Shared status vocabulary for the upload-stepper verify stage.
 *
 * SINGLE SOURCE OF TRUTH for which row-classification statuses are "Conflict" types
 * and their human-friendly subtype labels. Imported by both VerifyStatusBadge (the
 * pill) and VerifyStatusSummary (the count chips) so the two never drift. Backend
 * classifiers still emit the specific keys; this layer groups them under Conflict.
 *
 * The map below is a STARTER VOCABULARY, not a fixed contract. `Conflict`,
 * `DuplicateRow`, `Duplicate`, `IntraFileDupe` and `Invalid` are generic to any
 * Excel import; `NotInMaster`, `OutOfPeriod` and `Omitted` are the shapes an
 * uploader that reconciles against a master list or a date window tends to need.
 * Add, rename, or drop entries to match whatever your backend classifier actually
 * emits — `isConflictStatus` derives from this object, so the two cannot drift.
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
    Duplicate:     "Duplicate",
    IntraFileDupe: "File Dupe",
    Invalid:       "Invalid",
    NotInMaster:   "Not in Master List",
    OutOfPeriod:   "Out of Period",
    // A master-list record absent from the uploaded file — rendered as an
    // ordinary row in the verify table rather than a blocker. Purely additive;
    // only uploaders that reconcile against a master list emit it.
    Omitted:       "Omitted",
};

/**
 * True when a row status is a kind of Conflict — the generic "Conflict" or any
 * feature-specific blocker subtype (DuplicateRow, NotInMaster, OutOfPeriod, …).
 *
 * @param {string|null|undefined} status
 * @returns {boolean}
 */
export function isConflictStatus(status) {
    return status != null && status in CONFLICT_SUBTYPE_LABELS;
}
