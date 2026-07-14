/**
 * VerifyStatusSummary.jsx — Canonical status-count chip strip for the verify stage
 * of every Excel Upload Stepper.
 *
 * SINGLE SOURCE OF TRUTH for the summary chips so every stepper renders
 * identically. Counts rows by the 5 standard statuses (Create, Update, Retain,
 * Conflict, Pending); every feature-specific blocker is aggregated into the
 * single Conflict count via isConflictStatus(). Excluded rows are tallied
 * separately and shown only when present.
 *
 * Pure presentational — receives rows via props, never imports a feature hook/API.
 */

import { useMemo } from "react";
import { ANIMATE_ENTER_UP, staggerDelay } from "../../assets/styles/pre-set-styles";
import { isConflictStatus } from "./verifyStatus";

/**
 * Canonical render order — chips always appear in this sequence regardless of the
 * order requested, so every stepper is visually consistent. Excluded is appended
 * last (only when there are excluded rows).
 */
const ORDER = ["Create", "Update", "Retain", "Conflict", "Pending"];

const CHIP_COLORS = {
    Create:   "bg-success-100/20 dark:bg-success-400/10 border border-success-400/30 text-success-400",
    Update:   "bg-orange-100/20 dark:bg-orange-400/10 border border-orange-400/30 text-(--accent-foreground)",
    Retain:   "bg-grey-100 dark:bg-(--bg-surface-3) border border-grey-200 dark:border-grey-700 text-grey-500 dark:text-white/50",
    Conflict: "bg-danger-100/20 dark:bg-danger-400/10 border border-danger-400/30 text-danger-400",
    Pending:  "bg-blue-100/20 dark:bg-blue-400/10 border border-blue-400/30 text-(--blue-foreground)",
    Excluded: "bg-grey-100 dark:bg-(--bg-surface-3) border border-grey-300 dark:border-grey-600 text-grey-400",
};

/**
 * @component VerifyStatusSummary
 * @param {Object} props
 * @param {Array<{status?: string, excluded?: boolean}>} props.rows - Classified verify rows.
 * @param {string[]} [props.statuses] - Which standard statuses to always display
 *   (count 0 included), e.g. ["Create","Update","Retain","Conflict"]. Rendered in
 *   the canonical ORDER. Defaults to the full standard set.
 */
export function VerifyStatusSummary({ rows = [], statuses = ["Create", "Update", "Retain", "Conflict"] }) {
    const { counts, excluded } = useMemo(() => {
        const c = { Create: 0, Update: 0, Retain: 0, Conflict: 0, Pending: 0 };
        let ex = 0;
        for (const r of rows) {
            if (r?.excluded) {
                ex++;
                continue;
            }
            if (isConflictStatus(r?.status)) c.Conflict++;
            else if (r?.status in c) c[r.status]++;
        }
        return { counts: c, excluded: ex };
    }, [rows]);

    const show = new Set(statuses);
    const chips = ORDER.filter((s) => show.has(s)).map((s) => ({ key: s, count: counts[s] }));
    if (excluded > 0) chips.push({ key: "Excluded", count: excluded });

    return (
        <div className="flex flex-wrap gap-3">
            {chips.map(({ key, count }, i) => (
                <div key={key} className={`px-4 py-2 rounded-xl text-sm font-aumovio-bold ${CHIP_COLORS[key]} ${ANIMATE_ENTER_UP} ${staggerDelay(i)}`}>
                    {count} {key}
                </div>
            ))}
        </div>
    );
}

export default VerifyStatusSummary;
