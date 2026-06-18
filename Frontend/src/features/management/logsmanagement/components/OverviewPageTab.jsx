/**
 * @fileoverview Overview page tab — "is the system healthy right now?".
 * The operator's first screen: an alert/health banner, the Four Golden Signals
 * (Latency, Traffic, Errors, Saturation) + an Apdex tile, a liveness/readiness
 * strip, the live traffic chart, and the top-5 slowest routes.
 *
 * Pulls from both feature hooks (metrics + logs) — presentation only, no API.
 */

import { ArrowsRightLeftIcon, BoltIcon, CpuChipIcon, ExclamationTriangleIcon, SignalIcon } from "@heroicons/react/24/outline";
import { ANIMATE_ENTER_UP, HOVER_LIFT, TRANSITION_SPRING, staggerDelay } from "../../../../assets/styles/pre-set-styles";
import Badge from "../../../../components/ui/Badge";
import { PILL_BASE, badgeCls, getAvailabilityStyle, getErrorRateStyle, getHeapPctStyle, getLagStyle, getLatencyStyle, textCls } from "../../metrics/metricsStyles";
import TrafficChartsSection from "./TrafficChartsSection";

const BADGE_BLUE = "bg-blue-400/10 border-blue-400/20 dark:bg-blue-400/5 dark:border-blue-400/15";

/**
 * @param {{ metricsHook: import('../../metrics/metrics.hook').MetricsHook, logsHook: object }} props
 */
export default function OverviewPageTab({ metricsHook, logsHook }) {
    const { summary, summaryLoading, alerts, formatPct, formatMs, apdex, liveness, readiness } = metricsHook;
    const { trafficSnapshot, trafficSeries, isLive } = logsHook;

    if (summaryLoading && !summary) {
        return (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 mt-2">
                {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="rounded-xl p-4 bg-(--bg-surface) dark:bg-(--bg-surface-2) border border-(--color-card-surface-border) dark:border-white/10 shadow-sm h-24 skeleton" />
                ))}
            </div>
        );
    }

    const totals = summary?.totals ?? {};
    const sys = summary?.system ?? {};
    const errorRate = totals.errorRate ?? 0;
    const clientErrorRate = totals.clientErrorRate ?? 0;
    const availability = totals.availability ?? 1;
    const serverErrors = totals.serverErrorsTotal ?? 0;
    const totalReqs = totals.requestsTotal ?? 0;
    const apdexVal = totals.apdex ?? apdex;
    const elLag = sys.eventLoopLag ?? 0;
    const heapPct = sys.heapLimitMb ? (sys.heapUsedMb / sys.heapLimitMb) * 100 : 0;
    const worst = summary?.topSlowRoutes?.[0] ?? null;
    const worstP95 = worst?.p95 ?? 0;
    const reqPerSec = trafficSnapshot?.rates?.reqPerSec;

    // Health banner derivation (mirrors the old Overview health rollup)
    const hasHard = alerts.some((a) => a.severity === "critical" || a.severity === "emergency");
    const hasSoft = alerts.some((a) => a.severity === "warning");
    const healthLabel = hasHard ? "Degraded" : hasSoft ? "Warning" : "Healthy";
    const healthVariant = hasHard ? "red" : hasSoft ? "warning" : "green";
    const alertCount = summary?.alertCount ?? alerts.length;

    const latencyStyle = getLatencyStyle(worstP95);
    const errorStyle = getErrorRateStyle(errorRate);
    const heapStyle = getHeapPctStyle(heapPct);
    const availStyle = getAvailabilityStyle(availability);
    const apdexStyle = getAvailabilityStyle(apdexVal ?? 1); // same polarity (higher better)

    const liveOk = liveness?.alive === true;
    const readyOk = readiness?.ready === true;

    // Four Golden Signals
    const signals = [
        {
            icon: BoltIcon,
            label: "Latency (worst p95)",
            value: worst ? formatMs(worstP95) : "—",
            sub: worst ? worst.route : "no traffic yet",
            valueCls: textCls(latencyStyle),
            badgeCls: badgeCls(latencyStyle),
            iconCls: textCls(latencyStyle),
        },
        {
            icon: ArrowsRightLeftIcon,
            label: "Traffic",
            value: reqPerSec != null ? `${Number(reqPerSec).toFixed(1)}/s` : "—",
            sub: `${totalReqs.toLocaleString()} total requests`,
            valueCls: "text-blue-400 dark:text-blue-300",
            badgeCls: BADGE_BLUE,
            iconCls: "text-blue-400 dark:text-blue-300",
        },
        {
            icon: ExclamationTriangleIcon,
            label: "Errors (5xx rate)",
            value: formatPct(errorRate),
            sub: `${serverErrors} server errors · 4xx ${formatPct(clientErrorRate)}`,
            valueCls: textCls(errorStyle),
            badgeCls: badgeCls(errorStyle),
            iconCls: textCls(errorStyle),
        },
        {
            icon: CpuChipIcon,
            label: "Saturation (heap)",
            value: `${Math.round(heapPct)}%`,
            sub: `event-loop lag ${elLag}ms`,
            valueCls: textCls(heapStyle),
            badgeCls: badgeCls(heapStyle),
            iconCls: textCls(heapStyle),
        },
    ];

    return (
        <div className="space-y-6">
            {/* ── Health + Apdex + Availability banner ───────────────────────── */}
            <div className="flex flex-wrap items-center gap-3 p-4 rounded-xl bg-grey-50 dark:bg-(--bg-surface-2) border border-grey-200 dark:border-white/10">
                <div className="flex items-center gap-3 min-w-0 flex-1">
                    <Badge variant={healthVariant} size="lg">
                        {healthLabel}
                    </Badge>
                    <span className="text-sm text-grey-600 dark:text-grey-300 truncate">{alertCount === 0 ? "All systems nominal — no active alerts." : `${alertCount} active alert${alertCount > 1 ? "s" : ""}. See the Metrics ▸ Alerts tab.`}</span>
                </div>
                <div className="flex items-center gap-5 shrink-0 pl-3">
                    <div className="text-right" title="Apdex — (satisfied + tolerating/2) / total over recent samples (T=500ms).">
                        <p className="text-[11px] text-grey-400 dark:text-white/40 font-aumovio leading-tight">Apdex</p>
                        <p className={`text-[19px] font-aumovio-bold leading-tight ${textCls(apdexStyle)}`}>{apdexVal != null ? apdexVal.toFixed(2) : "—"}</p>
                    </div>
                    <div className="text-right" title="Request availability — success ÷ (success + 5xx). 4xx excluded.">
                        <p className="text-[11px] text-grey-400 dark:text-white/40 font-aumovio leading-tight">Availability</p>
                        <p className={`text-[19px] font-aumovio-bold leading-tight ${textCls(availStyle)}`}>{formatPct(availability, 2)}</p>
                    </div>
                </div>
            </div>

            {/* ── Four Golden Signals ────────────────────────────────────────── */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
                {signals.map((s, i) => (
                    <div key={s.label} className={`rounded-xl p-4 bg-(--bg-surface) dark:bg-(--bg-surface-2) border border-(--color-card-surface-border) dark:border-white/10 shadow-sm flex items-start gap-3 ${ANIMATE_ENTER_UP} ${staggerDelay(i)} ${TRANSITION_SPRING} ${HOVER_LIFT}`}>
                        <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 border ${s.badgeCls}`}>
                            <s.icon className={`w-4 h-4 ${s.iconCls}`} />
                        </div>
                        <div className="flex-1 min-w-0">
                            <p className="text-[11px] text-grey-400 dark:text-white/40 font-aumovio mb-0.5 truncate">{s.label}</p>
                            <p className={`text-[19px] font-aumovio-bold leading-tight ${s.valueCls}`}>{s.value}</p>
                            <p className="text-[11px] mt-0.5 text-grey-400 dark:text-white/40 truncate font-mono">{s.sub}</p>
                        </div>
                    </div>
                ))}
            </div>

            {/* ── Liveness / readiness strip ─────────────────────────────────── */}
            <div className="flex flex-wrap items-center gap-2">
                <span className={`${PILL_BASE} ${liveOk ? "bg-success-400/15 text-success-400" : "bg-danger-400/15 text-danger-400"}`}>Liveness: {liveOk ? "Live" : "Down"}</span>
                <span className={`${PILL_BASE} ${readyOk ? "bg-success-400/15 text-success-400" : "bg-danger-400/15 text-danger-400"}`}>Readiness: {readyOk ? "Ready" : "Not ready"}</span>
                <span className="text-xs text-grey-400 dark:text-white/35">See the Health tab for per-dependency detail.</span>
            </div>

            {/* ── Live Traffic ───────────────────────────────────────────────── */}
            <section className="space-y-4">
                <div className="flex items-center gap-2 pb-3 border-b border-black/10 dark:border-white/10">
                    <SignalIcon className="w-4 h-4 text-(--accent-icon) shrink-0" />
                    <h2 className="text-xs font-aumovio-bold text-black/55 dark:text-white/55 tracking-widest uppercase">Live Traffic</h2>
                    {isLive && (
                        <span className="flex items-center gap-1 text-xs text-success-400 font-aumovio-bold">
                            <span className="w-1.5 h-1.5 rounded-full bg-success-400 animate-ping" />
                        </span>
                    )}
                </div>
                <TrafficChartsSection trafficSnapshot={trafficSnapshot} trafficSeries={trafficSeries} />
            </section>

            {/* ── Top slow routes ────────────────────────────────────────────── */}
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
