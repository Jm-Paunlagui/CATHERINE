/**
 * @fileoverview Health tab — liveness and readiness check results.
 * Presentation only: health data comes from metrics.hook (useRequest), so this
 * component never imports httpClient (three-layer rule).
 */

import { ANIMATE_ENTER_UP, ANIM_DELAY_0, staggerDelay } from "../../../../assets/styles/pre-set-styles";
import Badge from "../../../../components/ui/Badge";
import Button from "../../../../components/ui/Button";
import { PILL_BASE, getHealthLatencyStyle } from "../metricsStyles";

/**
 * @param {{ hook: import('../metrics.hook').MetricsHook }} props
 */
export default function HealthTab({ hook }) {
    const { liveness, readiness, healthLoading, healthError, refetchHealth } = hook;

    if (healthLoading && !liveness && !readiness) {
        return (
            <div className="mt-6 space-y-3">
                <div className="h-20 rounded-xl skeleton" />
                <div className="h-36 rounded-xl skeleton" />
            </div>
        );
    }

    if (healthError && !readiness) {
        return <div className="mt-6 p-4 rounded-xl bg-danger-400/10 border border-danger-400/30 text-danger-400 text-sm">Failed to fetch health endpoint data.</div>;
    }

    // liveness/readiness are the response envelopes' `data` payloads from the hook.
    const liveData = liveness ?? {};
    const liveOk = liveData.alive === true;

    const readyData = readiness ?? {};
    const readyOk = readyData.ready === true;
    const checks = readyData.checks ?? {};

    return (
        <div className={`mt-6 space-y-4 ${ANIMATE_ENTER_UP} ${ANIM_DELAY_0}`}>
            <div className="flex justify-end">
                <Button variant="outline" size="sm" onClick={refetchHealth} disabled={healthLoading}>
                    Refresh
                </Button>
            </div>

            {/* Liveness */}
            <div className={`p-5 rounded-2xl border ${ANIMATE_ENTER_UP} ${staggerDelay(0)} ${liveOk ? "bg-(--bg-surface) dark:bg-(--bg-surface-2) border-(--color-card-surface-border) dark:border-white/10" : "bg-danger-400/5 border-danger-400/30 dark:border-danger-400/40"}`}>
                <div className="flex items-center gap-3 mb-3">
                    <Badge variant={liveOk ? "green" : "red"}>{liveOk ? "Live" : "Down"}</Badge>
                    <h3 className="font-semibold text-grey-800 dark:text-white">
                        Liveness <span className="text-xs font-mono font-normal text-grey-400 ml-1">GET /health/live</span>
                    </h3>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
                    <div>
                        <p className="text-xs text-grey-500 dark:text-grey-400 uppercase tracking-wide">PID</p>
                        <p className={`font-medium ${liveOk ? "text-success-400" : "text-danger-400"}`}>{liveData.pid ?? "—"}</p>
                    </div>
                    <div>
                        <p className="text-xs text-grey-500 dark:text-grey-400 uppercase tracking-wide">Uptime</p>
                        <p className={`font-medium ${liveOk ? "text-success-400" : "text-danger-400"}`}>{liveData.uptime ? `${Math.round(liveData.uptime)}s` : "—"}</p>
                    </div>
                    <div>
                        <p className="text-xs text-grey-500 dark:text-grey-400 uppercase tracking-wide">Checked at</p>
                        <p className={`font-medium text-xs ${liveOk ? "text-success-400" : "text-danger-400"}`}>{liveData.timestamp ? new Date(liveData.timestamp).toLocaleTimeString() : "—"}</p>
                    </div>
                </div>
            </div>

            {/* Readiness */}
            <div className={`p-5 rounded-2xl border ${ANIMATE_ENTER_UP} ${staggerDelay(1)} ${readyOk ? "bg-(--bg-surface) dark:bg-(--bg-surface-2) border-(--color-card-surface-border) dark:border-white/10" : "bg-danger-400/5 border-danger-400/30 dark:border-danger-400/40"}`}>
                <div className="flex items-center gap-3 mb-4">
                    <Badge variant={readyOk ? "green" : "red"}>{readyOk ? "Ready" : "Not Ready"}</Badge>
                    <h3 className="font-semibold text-grey-800 dark:text-white">
                        Readiness <span className="text-xs font-mono font-normal text-grey-400 ml-1">GET /health/ready</span>
                    </h3>
                </div>

                {Object.keys(checks).length === 0 ? (
                    <p className="text-sm text-grey-400 dark:text-grey-500">No dependency checks reported.</p>
                ) : (
                    <div className="space-y-2">
                        {Object.entries(checks).map(([name, check]) => (
                            <div key={name} className={`flex items-center justify-between px-3 py-2.5 rounded-lg border ${check.status === "up" ? "bg-grey-50 dark:bg-white/5 border-(--color-card-surface-border) dark:border-white/10" : "bg-danger-400/10 border-danger-400/30"}`}>
                                <span className={`font-mono text-xs ${check.status === "up" ? "text-grey-700 dark:text-grey-300" : "text-danger-400"}`}>{name}</span>
                                <div className="flex items-center gap-3">
                                    {check.latencyMs != null && <span className={`${PILL_BASE} ${getHealthLatencyStyle(check.latencyMs)}`}>{check.latencyMs}ms</span>}
                                    <Badge variant={check.status === "up" ? "green" : "red"} size="sm">
                                        {check.status === "up" ? "Up" : "Down"}
                                    </Badge>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
