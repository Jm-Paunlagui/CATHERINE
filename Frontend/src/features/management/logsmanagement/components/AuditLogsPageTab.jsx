/**
 * @fileoverview Audit Logs page tab — "what happened?". Historical, DB-backed
 * audit data: a time-range preset selector + aggregate statistics, followed by
 * the filterable/paginated audit-log table. The per-request trace modal lives at
 * the view root so it overlays any tab. Presentation only.
 */

import { faRotateRight } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { ChartBarIcon, QueueListIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { TRANSITION_COLORS } from "../../../../assets/styles/pre-set-styles";
import Button from "../../../../components/ui/Button";
import AuditLogTable from "./AuditLogTable";
import AuditStatsRow from "./AuditStatsRow";

// ─── Time-range preset helpers ──────────────────────────────────────────────────

const _iso = (d) => d.toISOString().slice(0, 10);
const _today = () => _iso(new Date());

/** Build a preset that subtracts a unit from today. */
const _ago = (mutate) => () => {
    const d = new Date();
    mutate(d);
    return _iso(d);
};

const PRESETS = [
    { label: "1D", getFrom: _ago((d) => d.setDate(d.getDate() - 1)) },
    { label: "1W", getFrom: _ago((d) => d.setDate(d.getDate() - 7)) },
    { label: "1M", getFrom: _ago((d) => d.setMonth(d.getMonth() - 1)) },
    { label: "3M", getFrom: _ago((d) => d.setMonth(d.getMonth() - 3)) },
    { label: "6M", getFrom: _ago((d) => d.setMonth(d.getMonth() - 6)) },
    { label: "YTD", getFrom: () => `${new Date().getFullYear()}-01-01` },
    { label: "1Y", getFrom: _ago((d) => d.setFullYear(d.getFullYear() - 1)) },
    { label: "2Y", getFrom: _ago((d) => d.setFullYear(d.getFullYear() - 2)) },
    { label: "5Y", getFrom: _ago((d) => d.setFullYear(d.getFullYear() - 5)) },
    { label: "10Y", getFrom: _ago((d) => d.setFullYear(d.getFullYear() - 10)) },
    { label: "ALL", getFrom: () => "2000-01-01" },
];

const _fmtRange = (iso) =>
    new Date(iso + "T00:00:00").toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
    });

/**
 * @param {{ hook: object }} props - the useLogsManagement hook
 */
export default function AuditLogsPageTab({ hook }) {
    const [activePreset, setActivePreset] = useState("1M");

    const handlePreset = (preset) => {
        setActivePreset(preset.label);
        hook.setStatsDateRange({ fromDate: preset.getFrom(), toDate: _today() });
    };

    return (
        <div className="space-y-8">
            {/* ── Historical Audit Statistics ───────────────────────────────── */}
            <section className="space-y-4">
                <div className="flex items-center gap-2 pb-3 border-b border-black/10 dark:border-white/10">
                    <ChartBarIcon className="w-4 h-4 text-(--accent-icon) shrink-0" />
                    <h2 className="text-xs font-aumovio-bold text-black/55 dark:text-white/55 tracking-widest uppercase">Historical Audit Statistics</h2>
                </div>

                {/* Time-range selector */}
                <div className="flex flex-col gap-2">
                    <div className="flex flex-wrap gap-1 p-1 bg-grey-100 dark:bg-(--bg-surface-3) rounded-xl w-fit">
                        {PRESETS.map((preset) => {
                            const isActive = activePreset === preset.label;
                            return (
                                <button
                                    key={preset.label}
                                    type="button"
                                    onClick={() => handlePreset(preset)}
                                    className={`px-3 py-1.5 rounded-lg text-xs font-aumovio-bold ${TRANSITION_COLORS}
                                        ${isActive ? "bg-(--bg-surface) dark:bg-(--bg-surface-2) text-(--accent-foreground) shadow-sm" : "text-grey-500 dark:text-white/45 hover:text-(--accent-foreground)"}`}
                                >
                                    {preset.label}
                                </button>
                            );
                        })}
                    </div>

                    <p className="text-xs font-mono text-black/40 dark:text-white/35 pl-1">
                        {_fmtRange(hook.statsDateRange.fromDate)}
                        <span className="mx-1.5 text-black/25 dark:text-white/20">→</span>
                        {_fmtRange(hook.statsDateRange.toDate)}
                    </p>
                </div>

                <AuditStatsRow hook={hook} />
            </section>

            {/* ── Audit Log ─────────────────────────────────────────────────── */}
            <section className="space-y-4">
                <div className="flex items-center justify-between gap-2 pb-3 border-b border-black/10 dark:border-white/10">
                    <div className="flex items-center gap-2 min-w-0">
                        <QueueListIcon className="w-4 h-4 text-(--accent-icon) shrink-0" />
                        <h2 className="text-xs font-aumovio-bold text-black/55 dark:text-white/55 tracking-widest uppercase">Audit Log</h2>
                    </div>
                    <Button variant="primary" size="sm" onClick={hook.refetchList} disabled={hook.listLoading}>
                        <FontAwesomeIcon icon={faRotateRight} className={`w-3.5 h-3.5 mr-1.5 ${hook.listLoading ? "animate-spin" : ""}`} />
                        Refresh
                    </Button>
                </div>

                <AuditLogTable hook={hook} />
            </section>
        </div>
    );
}
