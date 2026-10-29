/**
 * FidelityNoticePanel.jsx — fidelity-loss disclosures.
 *
 * Presentation only. Renders the `fidelityNotes` string array the backend
 * derives from `DataPurgeService.buildFidelityNotes` — shared between the
 * purge preview and the restore pre-flight so the two can never drift.
 *
 * MUST be rendered BEFORE the operator can confirm a purge or a restore —
 * never only in the post-op report.
 *
 * `tablesGettingNewPks` is restore-only (§1.2 / §1.7): identity primary keys
 * are regenerated on restore, which is also why the 8 ROW_HASH-signed
 * tables in §1.7 must be re-signed server-side — the backend does this
 * automatically, but the operator must still see that PKs will change.
 */

import { ExclamationTriangleIcon, KeyIcon } from "@heroicons/react/24/outline";
import { ANIMATE_FADE_IN_UP } from "../../../../assets/styles/pre-set-styles";
import Alert from "../../../../components/ui/Alert";

/**
 * @param {object} props
 * @param {string[]} props.notes - Fidelity disclosure strings (may be empty).
 * @param {string[]} [props.tablesGettingNewPks] - Restore-only: tables whose identity PK will be regenerated.
 * @param {string} [props.title] - Alert heading override.
 */
export function FidelityNoticePanel({ notes = [], tablesGettingNewPks = [], title = "Fidelity notice — read before continuing" }) {
    if (notes.length === 0 && tablesGettingNewPks.length === 0) return null;

    return (
        <div className={ANIMATE_FADE_IN_UP}>
            <Alert variant="warning" title={title} icon={ExclamationTriangleIcon}>
                <p className="text-sm mb-2">These effects are unavoidable and permanent. Review them before you confirm.</p>

                {notes.length > 0 && (
                    <ul className="text-sm space-y-2 list-disc list-inside">
                        {notes.map((note, i) => (
                            <li key={i}>{note}</li>
                        ))}
                    </ul>
                )}

                {tablesGettingNewPks.length > 0 && (
                    <div className="mt-3 pt-3 border-t border-current/10">
                        <p className="text-sm flex items-start gap-2">
                            <KeyIcon className="w-4 h-4 mt-1 shrink-0" />
                            <span>
                                Every restored row in the following table(s) receives a <span className="font-aumovio-bold">new primary key</span> — the original identifiers are not preserved. ROW_HASH tamper signatures are automatically re-signed against the new keys, so the Integrity Center will still show these rows as verified.
                            </span>
                        </p>
                        <p className="mt-2 text-xs font-mono opacity-80">{tablesGettingNewPks.join(", ")}</p>
                    </div>
                )}
            </Alert>
        </div>
    );
}

export default FidelityNoticePanel;
