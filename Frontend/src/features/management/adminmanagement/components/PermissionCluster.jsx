/**
 * PermissionCluster.jsx — Compact inline permission-indicator cluster.
 *
 * Renders six colour-coded dots (or mini icons) representing the six
 * actionable permission flags for a T_EMP_MGMT_ADMIN row.
 * Grouped visually into two domains separated by a thin divider:
 *
 *   Reset domain  | Billing domain
 *   [AR] [RR]  |  [AB] [RB] [CB] [EB]
 *
 * where:
 *   AR = Approve Reset      RR = Reject Reset
 *   AB = Approve Billing    RB = Reject Billing
 *   CB = Can Receive Billing  EB = Export Billing
 *
 * Granted = solid accent background + white initial.
 * Denied  = muted ring, grey initial.
 * Inactive row → entire cluster rendered at reduced opacity.
 *
 * Clicking the cluster fires `onClick` (only if provided — SUPER_ADMIN only).
 * Non-SUPER_ADMIN callers omit `onClick`; the cursor is default and no
 * hover affordance is rendered.
 *
 * The whole cluster fits within ~120px (six 18px dots + divider + gaps).
 */

import { Tooltip } from "../../../../components/ui/Tooltip";
import { TRANSITION_COLORS } from "../../../../assets/styles/pre-set-styles";

// ─── Dot descriptor table ─────────────────────────────────────────────────────

const DOTS = [
    // Reset domain
    {
        key:     "canApproveReset",
        label:   "Approve Wallet Reset",
        abbr:    "AR",
        domain:  "reset",
    },
    {
        key:     "canRejectReset",
        label:   "Reject Wallet Reset",
        abbr:    "RR",
        domain:  "reset",
    },
    // Billing domain
    {
        key:     "canApproveBilling",
        label:   "Approve Billing Download",
        abbr:    "AB",
        domain:  "billing",
    },
    {
        key:     "canRejectBilling",
        label:   "Reject Billing Download",
        abbr:    "RB",
        domain:  "billing",
    },
    {
        key:     "canReceiveBilling",
        label:   "Receive Auto-Billing Email",
        abbr:    "CB",
        domain:  "billing",
    },
    {
        key:     "canExportBilling",
        label:   "Export Billing Report",
        abbr:    "EB",
        domain:  "billing",
    },
];

// ─── Single dot ───────────────────────────────────────────────────────────────

/**
 * @param {{
 *   abbr:    string,
 *   label:   string,
 *   granted: boolean,
 *   muted:   boolean,
 * }} props
 */
function PermDot({ abbr, label, granted, muted }) {
    const tooltipText = `${label} — ${granted ? "granted" : "denied"}`;

    const dotClass = granted
        ? [
              "bg-(--accent-icon)/90 dark:bg-(--accent-icon)/80",
              "text-white dark:text-white",
              "border border-(--accent-icon)/40",
          ].join(" ")
        : [
              "bg-grey-100 dark:bg-grey-800/60",
              "text-grey-400 dark:text-grey-500",
              "border border-grey-300/60 dark:border-grey-600/40",
          ].join(" ");

    return (
        <Tooltip content={tooltipText} placement="top">
            <span
                className={[
                    "inline-flex items-center justify-center",
                    "w-[18px] h-[18px] rounded-full",
                    "text-[8px] font-aumovio-bold leading-none select-none",
                    TRANSITION_COLORS,
                    dotClass,
                    muted ? "opacity-40" : "",
                ].join(" ")}
                aria-label={tooltipText}
            >
                {abbr}
            </span>
        </Tooltip>
    );
}

// ─── Exported component ───────────────────────────────────────────────────────

/**
 * Compact six-dot permission cluster for inline table display.
 *
 * @param {{
 *   row:      object,  — enrichedAdmin row from the list endpoint
 *   onClick?: () => void,  — when provided, cluster is interactive (SUPER_ADMIN only)
 * }} props
 * @returns {JSX.Element}
 */
export function PermissionCluster({ row, onClick }) {
    const isInactive = row.isActive === "N";
    const isInteractive = typeof onClick === "function";

    const resetDots  = DOTS.filter((d) => d.domain === "reset");
    const billingDots = DOTS.filter((d) => d.domain === "billing");

    const wrapClass = [
        "inline-flex items-center gap-0.5",
        isInteractive ? "cursor-pointer group" : "cursor-default",
    ].join(" ");

    const content = (
        <span className={wrapClass} onClick={isInteractive ? onClick : undefined} role={isInteractive ? "button" : undefined} tabIndex={isInteractive ? 0 : undefined} onKeyDown={isInteractive ? (e) => { if (e.key === "Enter" || e.key === " ") onClick(); } : undefined} aria-label="Permission flags — click to edit">
            {/* Reset domain dots */}
            {resetDots.map((d) => (
                <PermDot
                    key={d.key}
                    abbr={d.abbr}
                    label={d.label}
                    granted={row[d.key] === "Y"}
                    muted={isInactive}
                />
            ))}

            {/* Domain divider */}
            <span className={`mx-0.5 h-3 w-px bg-grey-300 dark:bg-grey-600 shrink-0 ${isInactive ? "opacity-40" : ""}`} />

            {/* Billing domain dots */}
            {billingDots.map((d) => (
                <PermDot
                    key={d.key}
                    abbr={d.abbr}
                    label={d.label}
                    granted={row[d.key] === "Y"}
                    muted={isInactive}
                />
            ))}
        </span>
    );

    return content;
}

export default PermissionCluster;
