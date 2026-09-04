/**
 * ExportButtons.jsx — the single "Export Excel / Export CSV" control pair.
 *
 * Every table view that offers an export renders THIS component. The pattern was
 * previously copy-pasted per feature, which is how the two formats drift: one
 * view gains a loading state, another keeps a stale CSV tooltip, a third forgets
 * the role gate entirely.
 *
 * Access control is defence-in-depth, not the boundary: `canExport` decides
 * whether the buttons render at all, but every export endpoint re-checks the
 * caller's role server-side. Hiding a button is UX; the server is the gate.
 *
 * Presentation only — receives `onExport` and calls it with the chosen format.
 */

import { faFileCsv, faFileExcel } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import Button from "../ui/Button";

/** Explains why a .csv of long credential values can still LOOK wrong in Excel. */
const CSV_TITLE = "Exact values in the file; opening directly in Excel may still display long numbers in scientific form — use Export Excel for direct opening.";

/**
 * @param {{
 *   onExport:    (format: 'xlsx'|'csv') => void,
 *   exporting?:  boolean,
 *   disabled?:   boolean,
 *   canExport?:  boolean,
 *   size?:       'xs'|'sm'|'md'|'lg',
 *   labels?:     { xlsx?: string, csv?: string },
 *   className?:  string,
 * }} props
 */
export function ExportButtons({ onExport, exporting = false, disabled = false, canExport = true, size = "sm", labels = {}, className = "" }) {
    if (!canExport) return null;

    const isBlocked = exporting || disabled;

    return (
        <div className={`flex items-center gap-2 flex-wrap ${className}`}>
            <Button size={size} variant="accent" onClick={() => onExport("xlsx")} disabled={isBlocked} loading={exporting} type="button">
                <FontAwesomeIcon icon={faFileExcel} />
                {labels.xlsx ?? "Export Excel"}
            </Button>
            <Button size={size} variant="outline" onClick={() => onExport("csv")} disabled={isBlocked} type="button" title={CSV_TITLE}>
                <FontAwesomeIcon icon={faFileCsv} />
                {labels.csv ?? "Export CSV"}
            </Button>
        </div>
    );
}

export default ExportButtons;
