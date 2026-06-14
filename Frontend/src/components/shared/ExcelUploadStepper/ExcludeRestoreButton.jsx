/**
 * ExcludeRestoreButton.jsx — Shared per-row Exclude / Restore toggle for Excel upload Step 2 verify tables.
 *
 * Renders a single button that toggles a row between "excluded" and "active" states.
 * Renders nothing (null) when the row's status is not in `excludableStatuses` — Retain rows
 * never show this control because they are already in the DB and cannot be soft-excluded.
 *
 * Styling mirrors the Pay Period implementation exactly:
 *   - Exclude: danger-400 text, danger hover background
 *   - Restore: success-400 text, success hover background
 *   - `faBan` icon for Exclude, `faRedoAlt` icon for Restore
 *   - `TRANSITION_COLORS` from pre-set-styles for smooth colour transitions
 *
 * @module ExcludeRestoreButton
 */

import { faBan, faRedoAlt } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import PropTypes from "prop-types";
import { TRANSITION_COLORS } from "../../../assets/styles/pre-set-styles";

/**
 * Per-row Exclude / Restore toggle button for Excel upload Step 2 verify tables.
 *
 * @param {object}   props
 * @param {boolean}  props.excluded            - Whether the row is currently excluded.
 * @param {Function} props.onToggle            - Callback fired (with no arguments) when the button is clicked.
 * @param {string}   props.status              - The row's classification status (e.g. "Create", "Update", "Conflict", "Retain").
 * @param {string[]} [props.excludableStatuses] - Statuses that are eligible for exclusion.
 *                                               Rows whose status is NOT in this list render nothing.
 *                                               Defaults to ["Create", "Update", "Conflict"].
 * @returns {JSX.Element|null} The toggle button, or null if the row is not excludable.
 *
 * @example
 * // Inside a StepVerify table <td>:
 * <ExcludeRestoreButton
 *   excluded={row.excluded}
 *   onToggle={() => handleExcludeRow(originalIndex)}
 *   status={row.status}
 * />
 *
 * @example
 * // Feature with a non-standard excludable set:
 * <ExcludeRestoreButton
 *   excluded={row.excluded}
 *   onToggle={() => handleExcludeRow(originalIndex)}
 *   status={row.status}
 *   excludableStatuses={["Create", "Conflict"]}
 * />
 */
export function ExcludeRestoreButton({ excluded, onToggle, status, excludableStatuses = ["Create", "Update", "Conflict"] }) {
    if (!excludableStatuses.includes(status)) {
        return null;
    }

    return (
        <button
            type="button"
            onClick={onToggle}
            aria-label={excluded ? "Restore row" : "Exclude row"}
            className={[
                "flex items-center gap-1 px-2 py-1 rounded-md text-xs font-aumovio-bold",
                TRANSITION_COLORS,
                excluded
                    ? "text-success-400 hover:bg-success-100/20 dark:hover:bg-success-400/10"
                    : "text-danger-400 hover:bg-danger-100/20 dark:hover:bg-danger-400/10",
            ].join(" ")}
        >
            <FontAwesomeIcon icon={excluded ? faRedoAlt : faBan} className="text-xs" />
            {excluded ? "Restore" : "Exclude"}
        </button>
    );
}

ExcludeRestoreButton.propTypes = {
    /** Whether the row is currently excluded from the save. */
    excluded: PropTypes.bool.isRequired,
    /** Callback fired with no arguments when the button is clicked. */
    onToggle: PropTypes.func.isRequired,
    /** The row's classification status string from the verify step. */
    status: PropTypes.string.isRequired,
    /**
     * Statuses that are eligible for exclusion. Rows not in this list render null.
     * Defaults to ["Create", "Update", "Conflict"].
     */
    excludableStatuses: PropTypes.arrayOf(PropTypes.string),
};

export default ExcludeRestoreButton;
