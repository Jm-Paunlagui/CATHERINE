/**
 * PermissionFlagsFieldset.jsx — Shared permission-flag toggle section.
 *
 * Renders the admin-row toggles: Account Active, then the Server Notification
 * opt-ins. Used by both the Add Admin modal (creation-time pre-population) and
 * the Permissions modal (post-creation editing). A project adds its own flag
 * groups below the Server Notifications block.
 *
 * Props
 * ─────
 *  form           — Current flag state: { canReceiveSrvCrit, canReceiveSrvDeps,
 *                   canReceiveSrvRed, canReceiveSrvSys, isActive }  ('Y' | 'N')
 *  onToggle       — (flagName: string) => void  — flips a single flag
 *  showAuditTrail — When true, renders the "last updated" line below.
 *  updatedAt      — ISO timestamp string (optional, only shown when showAuditTrail is true)
 *  updatedBy      — Actor name or username (optional)
 *  disabled       — When true, all toggles are read-only (non-SUPER_ADMIN view).
 */

import { ShieldCheckIcon } from "@heroicons/react/24/outline";
import { Toggle } from "../../../../components/forms/Toggle";

const NOTIFICATION_FLAGS = [
    { key: "canReceiveSrvCrit", label: "Receive Critical Process Alerts", description: "Pool init failures, DB errors, scheduler crashes, unhandled exceptions." },
    { key: "canReceiveSrvDeps", label: "Receive Dependency Health Alerts", description: "Oracle pool saturation/unhealthy and SMTP delivery failures." },
    { key: "canReceiveSrvRed", label: "Receive Error Rate / Latency Alerts", description: "Sustained high error rate or slow route latency." },
    { key: "canReceiveSrvSys", label: "Receive System Resource Alerts", description: "High heap usage, event-loop lag, GC overhead, suspected memory leak." },
];

/**
 * A labelled Toggle row for a single permission flag.
 *
 * @param {{ label: string, description?: string, checked: boolean, onChange: Function, color?: string, disabled?: boolean }} props
 */
function PermissionToggleRow({ label, description, checked, onChange, color = "orange", disabled = false }) {
    return (
        <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
                <p className="text-sm font-aumovio-bold text-black/80 dark:text-white/80 leading-snug">{label}</p>
                {description && <p className="text-xs text-black/45 dark:text-white/40 mt-1 leading-relaxed">{description}</p>}
            </div>
            <Toggle checked={checked} onChange={disabled ? undefined : onChange} color={color} size="sm" disabled={disabled} />
        </div>
    );
}

/**
 * Shared permission-flag fieldset.
 *
 * @param {{
 *   form: Record<string, 'Y'|'N'>,
 *   onToggle: (flagName: string) => void,
 *   showAuditTrail?: boolean,
 *   updatedAt?: string | null,
 *   updatedBy?: string | null,
 *   disabled?: boolean,
 * }} props
 * @returns {JSX.Element}
 */
export function PermissionFlagsFieldset({ form, onToggle, showAuditTrail = false, updatedAt = null, updatedBy = null, disabled = false }) {
    return (
        <div className="space-y-4">
            <div className="flex items-start gap-2 p-3 rounded-lg bg-blue-400/8 dark:bg-blue-400/15 border border-blue-400/25">
                <ShieldCheckIcon className="w-4 h-4 text-(--blue-foreground) shrink-0 mt-1" />
                <p className="text-xs text-black/60 dark:text-white/60 font-aumovio">These flags control UI visibility only. The backend re-reads from the database on every action — stale tokens cannot bypass server-side gates.</p>
            </div>

            {/* IS_ACTIVE — most impactful, shown first */}
            <PermissionToggleRow label="Account Active" description="Inactive admins cannot log in and are blocked from token refresh." checked={form.isActive === "Y"} onChange={() => onToggle("isActive")} color="success" disabled={disabled} />

            <hr className="border-grey-200 dark:border-grey-700" />

            <p className="text-xs font-aumovio-bold text-black/50 dark:text-white/40 uppercase tracking-wide">Server Notifications</p>
            {NOTIFICATION_FLAGS.map((f) => (
                <PermissionToggleRow key={f.key} label={f.label} description={f.description} checked={form[f.key] === "Y"} onChange={() => onToggle(f.key)} color="purple" disabled={disabled} />
            ))}

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
