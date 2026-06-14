/**
 * @fileoverview System tab — heap usage, event-loop lag, handles, and GC stats.
 */

import { ANIMATE_ENTER_UP, staggerDelay } from "../../../../assets/styles/pre-set-styles";
import Card from "../../../../components/ui/Card";
import Progress from "../../../../components/ui/Progress";
import { PILL_BASE, getCpuStyle, getHandlesStyle, getHeapPctStyle, getLagStyle, textCls } from "../metricsStyles";

/**
 * @param {{ hook: import('../metrics.hook').MetricsHook }} props
 */
export default function SystemTab({ hook }) {
    const { snapshot, snapshotLoading, snapshotError, formatBytes } = hook;

    if (snapshotLoading) {
        return (
            <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-4">
                {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="h-36 rounded-2xl skeleton" />
                ))}
            </div>
        );
    }

    if (snapshotError || !snapshot) {
        return <div className="mt-6 p-4 rounded-xl bg-danger-400/10 border border-danger-400/30 text-danger-400 text-sm">System metrics unavailable. Ensure you have the required access level.</div>;
    }

    const { system } = snapshot;
    const heapUsed = system.memory.heapUsed;
    const heapTotal = system.memory.heapTotal;
    // The real ceiling heapUsed is measured against (V8 --max-old-space-size).
    // heapTotal is only what V8 has committed so far and sits near 100% by design.
    const heapLimit = system.memory.heapSizeLimit || heapTotal;

    // Primary metric: utilization against the hard limit — the number that matters.
    const heapPct = heapLimit > 0 ? Math.round((heapUsed / heapLimit) * 100) : 0;
    // Secondary metric: fill of the currently committed heap — a GC-pressure hint, not an alarm.
    const committedPct = heapTotal > 0 ? Math.round((heapUsed / heapTotal) * 100) : 0;

    // Variant thresholds mirror the backend HEAP_UTILIZATION_*_THRESHOLD rules.
    const heapProgressVariant = heapPct >= 90 ? "danger" : heapPct >= 75 ? "warning" : "success";

    const lagStyle = getLagStyle(system.eventLoopLag);
    const lagLabel = system.eventLoopLag >= 100 ? "Elevated" : system.eventLoopLag >= 10 ? "Moderate" : "Normal";

    const statCards = [
        {
            title: "Heap Memory",
            content: (
                <div className="space-y-3">
                    <div className="flex justify-between text-sm">
                        <span className="text-grey-600 dark:text-grey-400">Used / Limit</span>
                        <span className={`font-semibold ${textCls(getHeapPctStyle(heapPct))}`}>
                            {formatBytes(heapUsed)} / {formatBytes(heapLimit)}
                        </span>
                    </div>
                    <Progress value={heapPct} max={100} variant={heapProgressVariant} size="md" label={`${heapPct}%`} />
                    <p className="text-xs text-grey-400 dark:text-grey-500">
                        Committed: {formatBytes(heapTotal)} ({committedPct}% filled) &bull; RSS: {formatBytes(system.memory.rss)} &bull; External: {formatBytes(system.memory.external)}
                    </p>
                </div>
            ),
        },
        {
            title: "Event-Loop Lag",
            content: (
                <div className="space-y-3">
                    <div className="flex items-center gap-3">
                        <span className={`text-3xl font-bold ${textCls(lagStyle)}`}>{system.eventLoopLag}ms</span>
                        <span className={`${PILL_BASE} ${lagStyle}`}>{lagLabel}</span>
                    </div>
                    <p className="text-xs text-grey-400 dark:text-grey-500">Measured via setImmediate probe (EMA smoothed). Elevated lag (&gt;100ms) indicates blocking synchronous work on the main thread.</p>
                </div>
            ),
        },
        {
            title: "Active Handles & Requests",
            content: (
                <div className="grid grid-cols-2 gap-4">
                    <div>
                        <p className="text-xs text-grey-500 dark:text-grey-400 uppercase tracking-wide">Handles</p>
                        <p className={`text-2xl font-bold mt-1 ${textCls(getHandlesStyle(system.handles))}`}>{system.handles >= 0 ? system.handles : "N/A"}</p>
                    </div>
                    <div>
                        <p className="text-xs text-grey-500 dark:text-grey-400 uppercase tracking-wide">Requests</p>
                        <p className={`text-2xl font-bold mt-1 ${textCls(getHandlesStyle(system.requests))}`}>{system.requests >= 0 ? system.requests : "N/A"}</p>
                    </div>
                </div>
            ),
        },
        {
            title: "CPU Usage (last 10s)",
            content: (
                <div className="grid grid-cols-2 gap-4">
                    <div>
                        <p className="text-xs text-grey-500 dark:text-grey-400 uppercase tracking-wide">User</p>
                        <p className={`text-2xl font-bold mt-1 ${textCls(getCpuStyle(system.cpu.user))}`}>{system.cpu.user}ms</p>
                    </div>
                    <div>
                        <p className="text-xs text-grey-500 dark:text-grey-400 uppercase tracking-wide">System</p>
                        <p className={`text-2xl font-bold mt-1 ${textCls(getCpuStyle(system.cpu.system))}`}>{system.cpu.system}ms</p>
                    </div>
                    <p className="col-span-2 text-xs text-grey-400 dark:text-grey-500">Delta since previous 10s polling interval.</p>
                </div>
            ),
        },
    ];

    const gc = system.gc ?? {};
    const gcCollections = gc.collections ?? 0;
    const gcPauseMs = gc.pauseMs ?? 0;
    const gcOverhead = gc.overheadPct ?? 0;
    const gcMajor = gc.major?.count ?? 0;
    const gcMinor = gc.minor?.count ?? 0;
    const gcRecent = gc.recent ?? {};
    // GC overhead variant mirrors backend GC_OVERHEAD_*_THRESHOLD (5% / 10%).
    const gcOverheadStyle = gcOverhead >= 10 ? "text-danger-400" : gcOverhead >= 5 ? "text-warn-400" : "text-success-400";

    const trend = system.memoryTrend ?? {};
    const trendMbPerMin = (trend.growthBytesPerMin ?? 0) / (1024 * 1024);
    const trendWindowMin = Math.round((trend.windowMs ?? 0) / 60000);
    const leakSuspected = trend.suspected === true;
    const trendInsufficient = (trend.sampleCount ?? 0) < 2 || (trend.windowMs ?? 0) === 0;

    return (
        <div className="mt-6 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {statCards.map((card, i) => (
                    <Card key={card.title} className={`h-full bg-(--bg-surface) dark:bg-(--bg-surface-2) border border-(--color-card-surface-border) dark:border-white/10 rounded-2xl ${ANIMATE_ENTER_UP} ${staggerDelay(i)}`}>
                        <h3 className="text-sm font-semibold text-grey-600 dark:text-grey-400 mb-3">{card.title}</h3>
                        {card.content}
                    </Card>
                ))}
            </div>

            {/* Memory leak detector — post-major-GC live-set trend */}
            <Card className={`bg-(--bg-surface) dark:bg-(--bg-surface-2) border border-(--color-card-surface-border) dark:border-white/10 rounded-2xl ${ANIMATE_ENTER_UP} ${staggerDelay(4)}`}>
                <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-semibold text-grey-600 dark:text-grey-400">Memory Trend (Leak Detector)</h3>
                    <span className={`${PILL_BASE} ${leakSuspected ? "bg-danger-400/15 text-danger-400" : trendInsufficient ? "bg-grey-400/15 text-grey-400" : "bg-success-400/15 text-success-400"}`}>
                        {leakSuspected ? "Leak Suspected" : trendInsufficient ? "Gathering Data" : "Stable"}
                    </span>
                </div>
                <div className="grid grid-cols-3 gap-4">
                    <div>
                        <p className="text-xs text-grey-500 dark:text-grey-400 uppercase tracking-wide">Post-GC Growth</p>
                        <p className={`text-2xl font-bold mt-1 ${leakSuspected ? "text-danger-400" : "text-grey-800 dark:text-white"}`}>{trendMbPerMin >= 0 ? "+" : ""}{trendMbPerMin.toFixed(2)} MB/min</p>
                    </div>
                    <div>
                        <p className="text-xs text-grey-500 dark:text-grey-400 uppercase tracking-wide">Observed</p>
                        <p className="text-2xl font-bold text-grey-800 dark:text-white mt-1">{trendWindowMin}m</p>
                    </div>
                    <div>
                        <p className="text-xs text-grey-500 dark:text-grey-400 uppercase tracking-wide">Major-GC Baselines</p>
                        <p className="text-2xl font-bold text-grey-800 dark:text-white mt-1">{trend.sampleCount ?? 0}</p>
                    </div>
                </div>
                <p className="text-xs text-grey-400 dark:text-grey-500 mt-3">
                    Measures the heap left over <em>after</em> each major garbage collection — the live set. A flat or falling line is healthy; a sustained rise means GC can no longer reclaim memory (a leak). Needs several major GCs over ~5 min before it can judge.
                </p>
            </Card>

            {/* GC stats — supplementary row */}
            {gcCollections > 0 && (
                <Card className={`bg-(--bg-surface) dark:bg-(--bg-surface-2) border border-(--color-card-surface-border) dark:border-white/10 rounded-2xl ${ANIMATE_ENTER_UP} ${staggerDelay(5)}`}>
                    <h3 className="text-sm font-semibold text-grey-600 dark:text-grey-400 mb-3">Garbage Collection (perf_hooks)</h3>
                    <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                        <div>
                            <p className="text-xs text-grey-500 dark:text-grey-400 uppercase tracking-wide">Overhead</p>
                            <p className={`text-2xl font-bold mt-1 ${gcOverheadStyle}`}>{gcOverhead}%</p>
                        </div>
                        <div>
                            <p className="text-xs text-grey-500 dark:text-grey-400 uppercase tracking-wide">Major</p>
                            <p className="text-2xl font-bold text-grey-800 dark:text-white mt-1">{gcMajor}</p>
                        </div>
                        <div>
                            <p className="text-xs text-grey-500 dark:text-grey-400 uppercase tracking-wide">Minor</p>
                            <p className="text-2xl font-bold text-grey-800 dark:text-white mt-1">{gcMinor}</p>
                        </div>
                        <div>
                            <p className="text-xs text-grey-500 dark:text-grey-400 uppercase tracking-wide">Avg Pause</p>
                            <p className="text-2xl font-bold text-grey-800 dark:text-white mt-1">{(gcRecent.avgPauseMs ?? 0).toFixed(1)}ms</p>
                        </div>
                        <div>
                            <p className="text-xs text-grey-500 dark:text-grey-400 uppercase tracking-wide">Max Pause</p>
                            <p className="text-2xl font-bold text-grey-800 dark:text-white mt-1">{(gcRecent.maxPauseMs ?? 0).toFixed(1)}ms</p>
                        </div>
                    </div>
                    <p className="text-xs text-grey-400 dark:text-grey-500 mt-3">
                        Overhead = share of wall-clock time spent paused in GC over the last 10s (healthy &lt; 2%). Frequent <strong>minor</strong> collections are normal; rising <strong>major</strong> frequency with climbing overhead signals heap pressure. Total pause since start: {gcPauseMs}ms across {gcCollections} collections.
                    </p>
                </Card>
            )}
        </div>
    );
}
