/**
 * @fileoverview Overview tab — summary stat cards and system health indicator.
 * Receives the full hook object and accesses only what it needs.
 */

import { faBolt, faCircleExclamation, faClockRotateLeft, faServer } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { ANIMATE_ENTER_UP, HOVER_LIFT, TRANSITION_SPRING, staggerDelay } from "../../../../assets/styles/pre-set-styles";
import Badge from "../../../../components/ui/Badge";
import { PILL_BASE, badgeCls, getAvailabilityStyle, getErrorRateStyle, getLagStyle, textCls } from "../metricsStyles";

// ─── Fixed-colour badge classes (mirrors MetricCards.jsx COLOR map) ───────────

const BADGE = {
    blue: "bg-blue-400/10 border-blue-400/20 dark:bg-blue-400/5 dark:border-blue-400/15",
    purple: "bg-purple-400/10 border-purple-400/20 dark:bg-purple-400/5 dark:border-purple-400/15",
};

/**
 * @param {{ hook: import('../metrics.hook').MetricsHook }} props
 */
export default function OverviewTab({ hook }) {
    const { summary, summaryLoading, summaryError, alerts, formatPct, formatMs } = hook;

    if (summaryLoading) {
        return (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 mt-6">
                {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className={`rounded-xl p-4 bg-(--bg-surface) dark:bg-(--bg-surface-2) border border-(--color-card-surface-border) dark:border-white/10 shadow-sm flex items-start gap-3 ${staggerDelay(i)}`}>
                        <div className="w-9 h-9 rounded-xl skeleton shrink-0" />
                        <div className="flex-1 space-y-2 pt-1">
                            <div className="h-2.5 rounded skeleton w-3/4" />
                            <div className="h-5 rounded skeleton w-1/2" />
                            <div className="h-2 rounded skeleton w-2/3" />
                        </div>
                    </div>
                ))}
            </div>
        );
    }

    // FE-BUG-021 (2/6): metrics.hook.js already computes+returns `summaryError`,
    // but nothing here ever read it — a summary fetch failure fell through to
    // the same rendering as a genuinely healthy/idle system (alerts.length===0
    // → "Healthy" / "All systems nominal"). Mirrors the sibling RED
    // Metrics/System tabs' own snapshotError idiom in this same feature.
    if (summaryError) {
        return <div className="mt-6 p-4 rounded-xl bg-danger-400/10 border border-danger-400/30 text-danger-400 text-sm">Failed to load overview metrics. You may not have sufficient access level, or the server is temporarily unavailable.</div>;
    }

    const totalReqs = summary?.totals?.requestsTotal ?? 0;
    const errorRate = summary?.totals?.errorRate ?? 0; // server-only (5xx); 4xx excluded
    const clientErrorRate = summary?.totals?.clientErrorRate ?? 0;
    const availability = summary?.totals?.availability ?? 1;
    const alertCount = summary?.alertCount ?? alerts.length;
    const elLag = summary?.system?.eventLoopLag ?? 0;
    const uptime = summary?.uptime ?? 0;

    const availabilityStyle = getAvailabilityStyle(availability);

    const hasHard = alerts.some((a) => a.severity === "critical" || a.severity === "emergency");
    const hasSoft = alerts.some((a) => a.severity === "warning");
    const healthLabel = hasHard ? "Degraded" : hasSoft ? "Warning" : "Healthy";
    const healthVariant = hasHard ? "red" : hasSoft ? "warning" : "green";

    const errorRateStyle = getErrorRateStyle(errorRate);
    const lagStyle = getLagStyle(elLag);

    const statCards = [
        {
            label: "Total Requests",
            value: totalReqs.toLocaleString(),
            sub: "since process start",
            icon: faServer,
            badgeCls: BADGE.blue,
            iconCls: "text-(--blue-foreground)",
            accent: "text-(--blue-foreground)",
            subCls: "text-grey-400 dark:text-white/40",
        },
        {
            label: "Server Error Rate",
            value: formatPct(errorRate),
            sub: `${errorRate >= 0.05 ? "Critical (>5%)" : errorRate >= 0.01 ? "Elevated (>1%)" : "Within range"} · 4xx excluded: ${formatPct(clientErrorRate)}`,
            icon: faCircleExclamation,
            badgeCls: badgeCls(errorRateStyle),
            iconCls: textCls(errorRateStyle),
            accent: textCls(errorRateStyle),
            subCls: textCls(errorRateStyle),
        },
        {
            label: "Event-Loop Lag",
            value: `${elLag}ms`,
            sub: elLag >= 100 ? "Elevated — check blocking ops" : elLag >= 10 ? "Moderate" : "Normal",
            icon: faBolt,
            badgeCls: badgeCls(lagStyle),
            iconCls: textCls(lagStyle),
            accent: textCls(lagStyle),
            subCls: textCls(lagStyle),
        },
        {
            label: "Uptime",
            value: formatUptime(uptime),
            sub: "process running since start",
            icon: faClockRotateLeft,
            badgeCls: BADGE.purple,
            iconCls: "text-(--secondary-foreground)",
            accent: "text-(--secondary-foreground)",
            subCls: "text-grey-400 dark:text-white/40",
        },
    ];

    return (
        <div className="space-y-6 mt-4">
            {/* System health banner */}
            <div className="flex items-center gap-3 p-4 rounded-xl bg-grey-50 dark:bg-(--bg-surface-2) border border-grey-200 dark:border-white/10">
                <div className="flex items-center gap-3 min-w-0 flex-1">
                    <Badge variant={healthVariant} size="lg">
                        {healthLabel}
                    </Badge>
                    <span className="text-sm text-grey-600 dark:text-grey-300 truncate">{alertCount === 0 ? "All systems nominal — no active alerts." : `${alertCount} active alert${alertCount > 1 ? "s" : ""}. Check the Alerts tab for details.`}</span>
                </div>
                <div className="text-right shrink-0 pl-3" title="Request availability — success ÷ (success + 5xx). Client errors (4xx) are excluded.">
                    <p className="text-[11px] text-grey-400 dark:text-white/40 font-aumovio leading-tight">Availability</p>
                    <p className={`text-[19px] font-aumovio-bold leading-tight ${textCls(availabilityStyle)}`}>{formatPct(availability, 2)}</p>
                </div>
            </div>

            {/* Stat cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
                {statCards.map((card, i) => (
                    <div key={card.label} className={`rounded-xl p-4 bg-(--bg-surface) dark:bg-(--bg-surface-2) border border-(--color-card-surface-border) dark:border-white/10 shadow-sm flex items-start gap-3 ${ANIMATE_ENTER_UP} ${staggerDelay(i)} ${TRANSITION_SPRING} ${HOVER_LIFT}`}>
                        <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 border ${card.badgeCls}`}>
                            <FontAwesomeIcon icon={card.icon} className={`text-sm ${card.iconCls}`} />
                        </div>
                        <div className="flex-1 min-w-0">
                            <p className="text-[11px] text-grey-400 dark:text-white/40 font-aumovio mb-0.5 truncate">{card.label}</p>
                            <p className={`text-[19px] font-aumovio-bold leading-tight ${card.accent}`}>{card.value}</p>
                            <p className={`text-[11px] mt-0.5 ${card.subCls}`}>{card.sub}</p>
                        </div>
                    </div>
                ))}
            </div>

            {/* Top slow routes */}
            {summary?.topSlowRoutes?.length > 0 && (
                <div>
                    <h2 className="text-sm font-semibold text-grey-700 dark:text-grey-300 mb-3">Top 5 Slowest Routes (p95)</h2>
                    <div className="space-y-2">
                        {summary.topSlowRoutes.map((r, i) => (
                            <div key={r.route} className={`flex items-center justify-between px-4 py-2.5 rounded-xl bg-grey-50 dark:bg-white/5 border border-(--color-card-surface-border) dark:border-white/10 ${ANIMATE_ENTER_UP} ${staggerDelay(i)}`}>
                                <span className="text-sm font-mono text-grey-700 dark:text-grey-300 truncate max-w-xs">{r.route}</span>
                                <div className="flex items-center gap-3 shrink-0 ml-3">
                                    <span className="text-xs text-grey-500 dark:text-grey-400">{r.count} req</span>
                                    <span className={`${PILL_BASE} ${getErrorRateStyle(r.errorRate)}`}>{formatPct(r.errorRate)}</span>
                                    <span className={`${PILL_BASE} ${getLagStyle(r.p95)}`}>p95: {formatMs(r.p95)}</span>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

// ─── Local helper ─────────────────────────────────────────────────────────────

function formatUptime(seconds) {
    if (!seconds) return "—";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}
