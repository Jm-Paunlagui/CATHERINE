/**
 * @fileoverview Dependencies tab — Oracle connection-pool health (USE method:
 * Utilization, Saturation, Errors). Surfaces snapshot.dependencies.oracle, which
 * the backend collects (fed by the 30 s PoolHealthMonitor poll) but the UI never
 * displayed before. Presentation only — all data arrives via the metrics hook.
 */

import { CircleStackIcon } from "@heroicons/react/24/outline";
import { ANIMATE_ENTER_UP, staggerDelay } from "../../../../assets/styles/pre-set-styles";
import Progress from "../../../../components/ui/Progress";
import { PILL_BASE, getLatencyStyle, getPoolUtilStyle } from "../../metrics/metricsStyles";

/**
 * Map a 0–1 utilization ratio to a Progress bar colour variant, aligned with the
 * backend ORACLE_POOL_SATURATION thresholds (warning > 80%, critical > 95%).
 *
 * @param {number} ratio
 * @returns {"success"|"warning"|"danger"}
 */
function utilVariant(ratio) {
    const n = (Number(ratio) || 0) * 100;
    if (n >= 95) return "danger";
    if (n >= 80) return "warning";
    return "success";
}

/**
 * @param {{ hook: import('../../metrics/metrics.hook').MetricsHook }} props
 */
export default function DependenciesTab({ hook }) {
    const { oracleDeps, snapshotLoading, formatMs, formatPct } = hook;
    const pools = Object.entries(oracleDeps ?? {});

    if (snapshotLoading && pools.length === 0) {
        return (
            <div className="mt-6 space-y-3">
                <div className="h-28 rounded-2xl skeleton" />
                <div className="h-28 rounded-2xl skeleton" />
            </div>
        );
    }

    if (pools.length === 0) {
        return (
            <div className="mt-6 py-16 text-center">
                <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-grey-100 dark:bg-white/5 mb-3">
                    <CircleStackIcon className="w-6 h-6 text-grey-400 dark:text-white/40" />
                </div>
                <p className="text-grey-500 dark:text-grey-400 text-sm">No Oracle pools reporting yet.</p>
                <p className="text-grey-400 dark:text-white/35 text-xs mt-1">Pool stats populate from the 30-second health poll once a pool is active.</p>
            </div>
        );
    }

    return (
        <div className="mt-6 space-y-3">
            {pools.map(([name, d], i) => {
                const util = d.poolUtilization; // 0–1 or null until first poll
                const hasPool = typeof util === "number";
                return (
                    <div key={name} className={`p-5 rounded-2xl bg-(--bg-surface) dark:bg-(--bg-surface-2) border border-(--color-card-surface-border) dark:border-white/10 shadow-sm ${ANIMATE_ENTER_UP} ${staggerDelay(i)}`}>
                        {/* Header: pool name + utilization pill */}
                        <div className="flex items-center justify-between gap-3 mb-3">
                            <div className="flex items-center gap-2 min-w-0">
                                <CircleStackIcon className="w-4 h-4 text-(--accent-icon) shrink-0" />
                                <h3 className="font-mono text-sm font-semibold text-grey-800 dark:text-white truncate">{name}</h3>
                            </div>
                            {hasPool ? (
                                <span className={`${PILL_BASE} ${getPoolUtilStyle(util)}`}>{formatPct(util)} utilized</span>
                            ) : (
                                <span className="text-xs text-grey-400 dark:text-white/35">awaiting poll…</span>
                            )}
                        </div>

                        {/* Utilization bar (in-use ÷ open) */}
                        {hasPool && (
                            <div className="mb-4">
                                <div className="flex justify-between mb-1 text-[11px] text-grey-500 dark:text-white/45">
                                    <span>Connections in use</span>
                                    <span className="font-mono">
                                        {d.connectionsInUse ?? "—"} / {d.connectionsOpen ?? "—"} open
                                    </span>
                                </div>
                                <Progress value={(util ?? 0) * 100} variant={utilVariant(util)} size="md" />
                            </div>
                        )}

                        {/* Stat grid */}
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                            <Stat label="Pool max" value={d.poolMax ?? "—"} />
                            <Stat label="Capacity" value={typeof d.capacity === "number" ? formatPct(d.capacity) : "—"} />
                            <Stat label="Queue length" value={d.queueLength ?? "—"} danger={Number(d.queueLength) > 0} />
                            <Stat label="Query errors" value={d.errorCount ?? 0} danger={Number(d.errorCount) > 0} />
                            <Stat label="Queries" value={(d.queryCount ?? 0).toLocaleString?.() ?? d.queryCount ?? 0} />
                            <Stat label="Avg query" value={d.queryCount ? formatMs(d.avgMs) : "—"} />
                            <Stat label="p95 query" value={d.queryCount ? formatMs(d.p95Ms) : "—"} pill={d.queryCount ? getLatencyStyle(d.p95Ms) : null} />
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

// ─── Local stat cell ────────────────────────────────────────────────────────────

/**
 * @param {{ label: string, value: any, danger?: boolean, pill?: string|null }} props
 */
function Stat({ label, value, danger = false, pill = null }) {
    return (
        <div>
            <p className="text-[11px] text-grey-500 dark:text-white/45 uppercase tracking-wide">{label}</p>
            {pill ? (
                <span className={`${PILL_BASE} ${pill} mt-1`}>{value}</span>
            ) : (
                <p className={`font-medium mt-0.5 ${danger ? "text-danger-400" : "text-grey-800 dark:text-white"}`}>{value}</p>
            )}
        </div>
    );
}
