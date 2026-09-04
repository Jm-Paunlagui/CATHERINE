/**
 * VerifyStatusBadge.jsx — Canonical badge for the row classification status
 * returned by an upload wizard's POST /verify step.
 *
 * SINGLE SOURCE OF TRUTH. Every Excel Upload Stepper in the app renders the
 * verify-stage status pill through this one component, whatever the feature.
 * Receives all data via props — never imports a feature hook or API.
 *
 * Standard status vocabulary — these are the ONLY pills shown:
 *   - Create   → green  / plus     (new row, will be inserted)
 *   - Update   → orange / pencil   (existing row, will be updated; inline edits)
 *   - Conflict → red    / triangle (row cannot be saved — see "conflict types")
 *   - Retain   → grey   / check    (already in DB, skipped on save)
 *   - Pending  → blue   / clock    (inline-modification flows)
 *
 * Conflict types — every feature-specific blocker is a KIND of Conflict. It renders
 * the red "Conflict" pill PLUS a visible reason label naming the subtype, so the
 * status column stays on the 5-status standard while the cause is still on screen:
 *   - Conflict      → reason text = conflictReason (file-vs-DB diff)
 *   - DuplicateRow  → "Duplicate Row"
 *   - Duplicate     → "Duplicate"
 *   - IntraFileDupe → "File Dupe"
 *   - Invalid       → "Invalid"
 *   - NotInMaster   → "Not in Master List"
 *   - OutOfPeriod   → "Out of Period"
 *   - Omitted       → "Omitted" (a master-list record absent from the
 *                      uploaded file — additive, not a blocker)
 *   The verbose row.reason (when present) is kept as the hover tooltip.
 *
 *   This subtype list is a starter vocabulary — see `verifyStatus.js`, which
 *   owns it. Add or rename entries there to match your backend classifier.
 *
 * Override + fallback:
 *   - excluded=true → grey "Excluded" pill (wins over any status)
 *   - unknown       → grey dash
 *
 * Backend classifiers still emit the specific status keys (needed for row sorting,
 * summary counts, and the save-filter); only this presentation layer collapses them
 * into the Conflict category.
 */

import { faBan, faCheckCircle, faClock, faExclamationTriangle, faPencil, faPlus } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import Badge from "../ui/Badge";
import { CONFLICT_SUBTYPE_LABELS } from "./verifyStatus";

/**
 * @component VerifyStatusBadge
 * @param {Object} props
 * @param {'Create'|'Update'|'Conflict'|'Retain'|'Pending'|'DuplicateRow'|'Duplicate'|'IntraFileDupe'|'Invalid'|'NotInMaster'|'OutOfPeriod'|'Omitted'|null} props.status
 *   Classification status from the /verify API response.
 * @param {boolean} [props.excluded]       - When true, overrides status with the grey "Excluded" badge.
 * @param {string}  [props.conflictReason] - Short conflict detail (file-vs-DB diff), rendered as the reason label.
 * @param {string}  [props.reason]         - Verbose conflict detail; becomes the hover tooltip.
 */
export function VerifyStatusBadge({ status, excluded, conflictReason, reason }) {
    if (excluded) {
        return (
            <Badge variant="grey" size="sm" pill>
                <FontAwesomeIcon icon={faBan} className="mr-1" />
                Excluded
            </Badge>
        );
    }

    if (status === "Create") {
        return (
            <Badge variant="green" size="sm" pill>
                <FontAwesomeIcon icon={faPlus} className="mr-1" />
                Create
            </Badge>
        );
    }

    if (status === "Update") {
        return (
            <Badge variant="orange" size="sm" pill>
                <FontAwesomeIcon icon={faPencil} className="mr-1" />
                Update
            </Badge>
        );
    }

    if (status === "Retain") {
        return (
            <Badge variant="grey" size="sm" pill title="Already exists in the database — no changes needed, will be skipped on save">
                <FontAwesomeIcon icon={faCheckCircle} className="mr-1 text-success-400" />
                Retained
            </Badge>
        );
    }

    if (status === "Pending") {
        return (
            <Badge variant="blue" size="sm" pill>
                <FontAwesomeIcon icon={faClock} className="mr-1" />
                Pending
            </Badge>
        );
    }

    // Conflict family — one red "Conflict" pill + a visible reason naming the subtype.
    if (status && status in CONFLICT_SUBTYPE_LABELS) {
        const detail = CONFLICT_SUBTYPE_LABELS[status] ?? conflictReason ?? reason ?? null;
        const tooltip = reason ?? conflictReason ?? detail ?? undefined;
        return (
            <span className="inline-flex items-center gap-2 min-w-0">
                <Badge variant="red" size="sm" pill title={tooltip}>
                    <FontAwesomeIcon icon={faExclamationTriangle} className="mr-1" />
                    Conflict
                </Badge>
                {detail && (
                    <span className="text-xs text-grey-500 dark:text-grey-400 truncate max-w-[12rem]" title={tooltip}>
                        {detail}
                    </span>
                )}
            </span>
        );
    }

    return (
        <Badge variant="grey" size="sm" pill>
            —
        </Badge>
    );
}

export default VerifyStatusBadge;
