/**
 * PermissionFlagsFieldset.jsx — Shared permission-flag toggle section.
 *
 * Renders the seven permission toggles for admin rows.
 * Used by both the Add Admin modal (creation-time pre-population) and
 * the Permissions modal (post-creation editing).
 *
 * Props
 * ─────
 *  form           — Current flag state: { canApproveReset, canRejectReset,
 *                   canApproveBilling, canRejectBilling, canReceiveBilling,
 *                   canExportBilling, isActive }  ('Y' | 'N')
 *  onToggle       — (flagName: string) => void  — flips a single flag
 *  showAuditTrail — When true, renders the "last updated" line below.
 *  updatedAt      — ISO timestamp string (optional, only shown when showAuditTrail is true)
 *  updatedBy      — Actor name or EMP_ID (optional)
 *  disabled       — When true, all toggles are read-only (non-SUPER_ADMIN view).
 */

import { ShieldCheckIcon } from "@heroicons/react/24/outline";
import { Toggle } from "../../../../components/forms/Toggle";

// ─── Internal sub-component ───────────────────────────────────────────────────

/**
 * A labelled Toggle row for a single permission flag.
 *
 * @param {{
 *   label: string,
 *   description?: string,
 *   checked: boolean,
 *   onChange: Function,
 *   color?: string,
 *   disabled?: boolean,
 * }} props
 */
function PermissionToggleRow({ label, description, checked, onChange, color = "orange", disabled = false }) {
    return (
        <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
                <p className="text-sm font-aumovio-bold text-black/80 dark:text-white/80 leading-snug">{label}</p>
                {description && <p className="text-xs text-black/45 dark:text-white/40 mt-0.5 leading-relaxed">{description}</p>}
            </div>
            <Toggle checked={checked} onChange={disabled ? undefined : onChange} color={color} size="sm" disabled={disabled} />
        </div>
    );
}

// ─── Exported component ───────────────────────────────────────────────────────

/**
 * Shared permission-flag fieldset.
 * Renders the full set of seven permission toggles grouped by domain.
 *
 * @param {{
 *   form: {
 *     canApproveReset:   'Y'|'N',
 *     canRejectReset:    'Y'|'N',
 *     canApproveBilling: 'Y'|'N',
 *     canRejectBilling:  'Y'|'N',
 *     canReceiveBilling: 'Y'|'N',
 *     canExportBilling:  'Y'|'N',
 *     isActive:          'Y'|'N',
 *   },
 *   onToggle:       (flagName: string) => void,
 *   showAuditTrail?: boolean,
 *   updatedAt?:      string | null,
 *   updatedBy?:      string | null,
 *   disabled?:       boolean,
 * }} props
 * @returns {JSX.Element}
 */
export function PermissionFlagsFieldset({ form, onToggle, showAuditTrail = false, updatedAt = null, updatedBy = null, disabled = false }) {
    return (
        <div className="space-y-5">
            {/* Security note */}
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-blue-400/8 dark:bg-blue-400/15 border border-blue-400/25">
                <ShieldCheckIcon className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
                <p className="text-xs text-black/60 dark:text-white/60 font-aumovio">These flags control UI visibility only. The backend re-reads from the database on every action — stale tokens cannot bypass server-side gates.</p>
            </div>

            {/* IS_ACTIVE — most impactful, shown first */}
            <PermissionToggleRow label="Account Active" description="Inactive admins cannot log in and are blocked from token refresh." checked={form.isActive === "Y"} onChange={() => onToggle("isActive")} color="success" disabled={disabled} />

            <hr className="border-grey-200 dark:border-grey-700" />

            {/* Reset request flags */}
            <p className="text-xs font-aumovio-bold text-black/50 dark:text-white/40 uppercase tracking-wide">Wallet Reset Requests</p>
            <PermissionToggleRow label="Can Approve Resets" description="Approve pending excess-fund reset requests." checked={form.canApproveReset === "Y"} onChange={() => onToggle("canApproveReset")} disabled={disabled} />
            <PermissionToggleRow label="Can Reject Resets" description="Reject pending excess-fund reset requests." checked={form.canRejectReset === "Y"} onChange={() => onToggle("canRejectReset")} disabled={disabled} />

            <hr className="border-grey-200 dark:border-grey-700" />

            {/* Billing flags */}
            <p className="text-xs font-aumovio-bold text-black/50 dark:text-white/40 uppercase tracking-wide">Billing</p>
            <PermissionToggleRow label="Can Approve Billing Downloads" description="Approve re-download requests in the Billing section." checked={form.canApproveBilling === "Y"} onChange={() => onToggle("canApproveBilling")} disabled={disabled} />
            <PermissionToggleRow label="Can Reject Billing Downloads" description="Reject re-download requests in the Billing section." checked={form.canRejectBilling === "Y"} onChange={() => onToggle("canRejectBilling")} disabled={disabled} />
            <PermissionToggleRow label="Receive Auto-Billing Emails" description="Opted-in admins receive the monthly billing workbook by email." checked={form.canReceiveBilling === "Y"} onChange={() => onToggle("canReceiveBilling")} color="purple" disabled={disabled} />
            <PermissionToggleRow label="Can Export Billing Report" description="Download the billing Excel workbook directly from the Billing page." checked={form.canExportBilling === "Y"} onChange={() => onToggle("canExportBilling")} disabled={disabled} />

            {/* Audit trail */}
            {showAuditTrail && updatedAt && (
                <p className="text-xs text-grey-400 dark:text-grey-500 text-right pt-1">
                    Last updated {new Date(updatedAt).toLocaleString()}
                    {updatedBy ? ` by ${updatedBy}` : ""}
                </p>
            )}
        </div>
    );
}

export default PermissionFlagsFieldset;
