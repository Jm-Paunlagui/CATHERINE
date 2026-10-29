/**
 * PermissionCluster.jsx — Compact inline permission-indicator cluster.
 *
 * Renders one colour-coded dot per actionable permission flag of an admin row,
 * grouped by domain with thin dividers between groups:
 *
 *   Server Notifications
 *   [SC] [SD] [SR] [SS]
 *
 * Granted = solid accent background + white initial.
 * Denied  = muted ring, grey initial.
 * Inactive row → entire cluster rendered at reduced opacity.
 *
 * Clicking the cluster fires `onClick` (only if provided — SUPER_ADMIN only).
 * A project adds its own permission flags to DOTS with a new `domain`.
 */

import { Fragment } from "react";
import { Tooltip } from "../../../../components/ui/Tooltip";
import { TRANSITION_COLORS } from "../../../../assets/styles/pre-set-styles";

const DOTS = [
    { key: "canReceiveSrvCrit", label: "Receive Critical Process Alerts", abbr: "SC", domain: "srv" },
    { key: "canReceiveSrvDeps", label: "Receive Dependency Health Alerts", abbr: "SD", domain: "srv" },
    { key: "canReceiveSrvRed", label: "Receive Error Rate / Latency Alerts", abbr: "SR", domain: "srv" },
    { key: "canReceiveSrvSys", label: "Receive System Resource Alerts", abbr: "SS", domain: "srv" },
];

const DOMAINS = [...new Set(DOTS.map((d) => d.domain))];

/**
 * @param {{ abbr: string, label: string, granted: boolean, muted: boolean }} props
 */
function PermDot({ abbr, label, granted, muted }) {
    const tooltipText = `${label} — ${granted ? "granted" : "denied"}`;

    const dotClass = granted
        ? "bg-(--accent-icon)/90 dark:bg-(--accent-icon)/80 text-(--on-accent-icon-text) border border-(--accent-icon)/40"
        : "bg-grey-100 dark:bg-grey-800/60 text-grey-400 dark:text-grey-500 border border-grey-300/60 dark:border-grey-600/40";

    return (
        <Tooltip content={tooltipText} placement="top">
            <span className={`inline-flex items-center justify-center w-[18px] h-[18px] rounded-full text-[8px] font-aumovio-bold leading-none select-none ${TRANSITION_COLORS} ${dotClass} ${muted ? "opacity-40" : ""}`} aria-label={tooltipText}>
                {abbr}
            </span>
        </Tooltip>
    );
}

/**
 * Compact permission-dot cluster for inline table display.
 *
 * @param {{ row: object, onClick?: () => void }} props
 *   row — enrichedAdmin row from the list endpoint; onClick — makes it interactive (SUPER_ADMIN only)
 * @returns {JSX.Element}
 */
export function PermissionCluster({ row, onClick }) {
    const isInactive = row.isActive === "N";
    const isInteractive = typeof onClick === "function";

    return (
        <span
            className={`inline-flex items-center gap-1 ${isInteractive ? "cursor-pointer group" : "cursor-default"}`}
            onClick={isInteractive ? onClick : undefined}
            role={isInteractive ? "button" : undefined}
            tabIndex={isInteractive ? 0 : undefined}
            onKeyDown={
                isInteractive
                    ? (e) => {
                          if (e.key === "Enter" || e.key === " ") onClick();
                      }
                    : undefined
            }
            aria-label="Permission flags — click to edit"
        >
            {DOMAINS.map((domain, i) => (
                <Fragment key={domain}>
                    {i > 0 && <span className={`mx-1 h-3 w-px bg-grey-300 dark:bg-grey-600 shrink-0 ${isInactive ? "opacity-40" : ""}`} />}
                    {DOTS.filter((d) => d.domain === domain).map((d) => (
                        <PermDot key={d.key} abbr={d.abbr} label={d.label} granted={row[d.key] === "Y"} muted={isInactive} />
                    ))}
                </Fragment>
            ))}
        </span>
    );
}

export default PermissionCluster;
