/**
 * @fileoverview Frontend Vitals tab — Core Web Vitals + client-side JS errors.
 * The backend collects these via POST /api/v1/metrics/frontend but the UI never
 * displayed them. Layout: per-metric summary cards (avg + rating distribution) on
 * top, an expandable raw-event table, then a recent client-error list.
 * Presentation only — data arrives via the metrics hook.
 */

import { ChevronDownIcon, ChevronUpIcon, SignalIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { ANIMATE_ENTER_UP, staggerDelay } from "../../../../assets/styles/pre-set-styles";
import { PILL_BASE } from "../../metrics/metricsStyles";
import Button from "../../../../components/ui/Button";
import Table from "../../../../components/ui/Table";

/** Rating → display metadata (semantic colours — not the accent family). */
const RATING = {
    good: { label: "Good", pill: "bg-success-400/15 text-success-400", text: "text-success-400" },
    "needs-improvement": { label: "Needs work", pill: "bg-warn-400/20 text-warn-400", text: "text-warn-400" },
    poor: { label: "Poor", pill: "bg-danger-400/15 text-danger-400", text: "text-danger-400" },
};

function ratingMeta(r) {
    return RATING[r] ?? { label: r ?? "—", pill: "bg-grey-100/15 text-grey-500", text: "text-grey-500 dark:text-white/50" };
}

/**
 * Format a vital value: CLS is unitless (3 dp), everything else is milliseconds.
 * @param {string} name
 * @param {number} value
 * @returns {string}
 */
function fmtVital(name, value) {
    if (value == null || Number.isNaN(value)) return "—";
    if (name === "CLS") return String(Math.round(value * 1000) / 1000);
    return `${Math.round(value)}ms`;
}

/**
 * @param {{ hook: import('../../metrics/metrics.hook').MetricsHook }} props
 */
export default function FrontendVitalsTab({ hook }) {
    const { vitalsSummary = [], frontendErrors = [], snapshot } = hook;
    const rawVitals = snapshot?.frontendVitals ?? [];
    const [showRaw, setShowRaw] = useState(false);

    const nothingYet = vitalsSummary.length === 0 && rawVitals.length === 0 && frontendErrors.length === 0;

    if (nothingYet) {
        return (
            <div className="mt-6 py-16 text-center">
                <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-grey-100 dark:bg-white/5 mb-3">
                    <SignalIcon className="w-6 h-6 text-grey-400 dark:text-white/40" />
                </div>
                <p className="text-grey-500 dark:text-grey-400 text-sm">No frontend telemetry yet.</p>
                <p className="text-grey-400 dark:text-white/35 text-xs mt-1">Web Vitals are reported when a page is hidden — navigate or switch tabs, then refresh.</p>
            </div>
        );
    }

    const rawColumns = [
        { key: "name", label: "Metric", render: (r) => <span className="font-mono text-xs text-grey-700 dark:text-grey-200">{r.name}</span> },
        { key: "value", label: "Value", render: (r) => <span className="text-sm text-grey-700 dark:text-grey-200">{fmtVital(r.name, r.value)}</span> },
        { key: "rating", label: "Rating", render: (r) => <span className={`${PILL_BASE} ${ratingMeta(r.rating).pill}`}>{ratingMeta(r.rating).label}</span> },
        { key: "page", label: "Page", render: (r) => <span className="font-mono text-xs text-grey-500 dark:text-grey-400 truncate">{r.context?.page ?? "—"}</span> },
        { key: "ts", label: "Time", render: (r) => <span className="text-xs text-grey-500 dark:text-grey-400">{r.ts ? new Date(r.ts).toLocaleTimeString() : "—"}</span> },
    ];

    return (
        <div className="mt-6 space-y-6">
            {/* ── Summary cards ─────────────────────────────────────────────── */}
            {vitalsSummary.length > 0 ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
                    {vitalsSummary.map((m, i) => {
                        const meta = ratingMeta(m.rating);
                        return (
                            <div key={m.name} className={`rounded-xl p-4 bg-(--bg-surface) dark:bg-(--bg-surface-2) border border-(--color-card-surface-border) dark:border-white/10 shadow-sm ${ANIMATE_ENTER_UP} ${staggerDelay(i)}`}>
                                <div className="flex items-center justify-between mb-1">
                                    <p className="text-[11px] text-grey-400 dark:text-white/40 font-aumovio">{m.name}</p>
                                    <span className={`${PILL_BASE} ${meta.pill}`}>{meta.label}</span>
                                </div>
                                <p className={`text-[19px] font-aumovio-bold leading-tight ${meta.text}`}>{fmtVital(m.name, m.avg)}</p>
                                <p className="text-[11px] text-grey-400 dark:text-white/40 mt-0.5">avg over {m.count} sample{m.count === 1 ? "" : "s"}</p>
                                <div className="flex items-center gap-2 mt-2 text-[11px]">
                                    <span className="text-success-400">{m.good} good</span>
                                    <span className="text-warn-400">{m.needsImprovement} ni</span>
                                    <span className="text-danger-400">{m.poor} poor</span>
                                </div>
                            </div>
                        );
                    })}
                </div>
            ) : (
                <p className="text-sm text-grey-500 dark:text-grey-400">No Web Vitals captured yet — only client errors below.</p>
            )}

            {/* ── Expandable raw events ─────────────────────────────────────── */}
            {rawVitals.length > 0 && (
                <div>
                    <Button variant="ghost" size="sm" onClick={() => setShowRaw((v) => !v)}>
                        {showRaw ? <ChevronUpIcon className="w-4 h-4 mr-1.5" /> : <ChevronDownIcon className="w-4 h-4 mr-1.5" />}
                        {showRaw ? "Hide" : "Show"} raw events ({rawVitals.length})
                    </Button>
                    {showRaw && (
                        <div className="mt-3">
                            <Table columns={rawColumns} data={rawVitals.slice().reverse().map((v, i) => ({ ...v, _id: i }))} stickyHeader striped compact />
                        </div>
                    )}
                </div>
            )}

            {/* ── Client errors ─────────────────────────────────────────────── */}
            <div>
                <h3 className="text-sm font-semibold text-grey-700 dark:text-grey-300 mb-3">
                    Client Errors {frontendErrors.length > 0 && <span className="text-danger-400">({frontendErrors.length})</span>}
                </h3>
                {frontendErrors.length === 0 ? (
                    <p className="text-sm text-grey-400 dark:text-white/35">No client-side JavaScript errors reported.</p>
                ) : (
                    <div className="space-y-2">
                        {frontendErrors
                            .slice()
                            .reverse()
                            .map((e, i) => (
                                <details key={i} className={`group rounded-xl bg-danger-400/5 border border-danger-400/30 px-4 py-3 ${ANIMATE_ENTER_UP} ${staggerDelay(Math.min(i, 6))}`}>
                                    <summary className="flex items-center justify-between gap-3 cursor-pointer list-none">
                                        <span className="text-sm text-danger-400 font-medium truncate">{e.message || "Unknown error"}</span>
                                        <span className="text-[11px] text-grey-500 dark:text-grey-400 shrink-0 font-mono">{e.context?.page ?? ""} · {e.ts ? new Date(e.ts).toLocaleTimeString() : ""}</span>
                                    </summary>
                                    {e.stack && <pre className="mt-2 text-[11px] text-grey-600 dark:text-grey-400 whitespace-pre-wrap break-words font-mono max-h-48 overflow-auto">{e.stack}</pre>}
                                </details>
                            ))}
                    </div>
                )}
            </div>
        </div>
    );
}
