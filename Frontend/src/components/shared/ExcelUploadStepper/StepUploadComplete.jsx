/**
 * StepUploadComplete.jsx — The single Step 3 ("Complete") screen for every
 * Excel upload stepper, whatever the feature.
 *
 * SINGLE SOURCE OF TRUTH. Each feature's StepXComplete component is now a thin
 * wrapper that normalises its save response with `normalizeUploadOutcome` and
 * renders this component. Nothing about the result layout may be re-implemented
 * per feature — that divergence is what produced the inconsistent screens the
 * RPA team reported.
 *
 * ── Guarantees this component makes ──────────────────────────────────────────
 * 1. The five stat cells (Inserted / Updated / Skipped / Failed / Pending) are
 *    ALWAYS rendered, in that order, including when a value is zero. A feature
 *    never hides a bucket it happens not to use — a missing cell is what made
 *    "where did the other 11 rows go?" unanswerable.
 * 2. A reconciliation strip above the grid states the full arithmetic
 *    (parsed → excluded → submitted → the five buckets) so the numbers can be
 *    checked on screen without opening a table.
 * 3. When the buckets do not sum to the submitted total, the gap is shown in
 *    red as "Unaccounted" and a warning banner appears. It is never hidden.
 * 4. Every non-empty detail bucket gets a collapsible table with the same four
 *    columns in the same order: Key / Label / Reason / Category.
 * 5. Stable DOM hooks for automation: `data-upload-result`, `data-upload-count`
 *    on every stat cell, and a `data-upload-json` node carrying the whole
 *    ledger, plus a copy-to-clipboard block.
 *
 * Receives all data via props. Never imports a feature hook or API file.
 */

import { faChevronDown, faChevronUp, faCircleCheck, faCircleExclamation, faTriangleExclamation, faUpload } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useMemo, useState } from "react";
import { ANIMATE_FADE_IN_UP, STANDARD_BORDER, STATUS_BG_COLORS, STATUS_BORDER_COLORS, STATUS_TEXT_COLORS, TITLE_COLOR_TEXT, TRANSITION_COLORS } from "../../../assets/styles/pre-set-styles";
import Button from "../../ui/Button";
import Clipboard from "../../ui/Clipboard";
import { Table } from "../../ui/Table";
import { CATEGORY_LABELS, DETAIL_BUCKETS, OUTCOME_BUCKETS, outcomeToJson, summarySentence } from "./uploadOutcome";

// ─── Static configuration ─────────────────────────────────────────────────────

/** Hero icon + tint per severity. */
const SEVERITY_STYLE = {
    success: { icon: faCircleCheck, ring: "bg-success-100/60 dark:bg-success-400/10", text: "text-success-400" },
    warning: { icon: faTriangleExclamation, ring: "bg-warn-100/60 dark:bg-warn-400/10", text: "text-warn-500 dark:text-warn-400" },
    danger: { icon: faCircleExclamation, ring: "bg-danger-100/60 dark:bg-danger-400/10", text: "text-danger-400" },
};

/** Collapsible header styling per detail bucket. */
const DETAIL_STYLE = {
    skipped: { tone: "grey", bar: "bg-grey-100 dark:bg-grey-400/5 hover:bg-grey-200 dark:hover:bg-grey-400/10", row: "bg-(--bg-surface) dark:bg-(--bg-surface-2)", noun: "Skipped — not written" },
    failed: { tone: "red", bar: "bg-danger-100/30 dark:bg-danger-400/5 hover:bg-danger-100 dark:hover:bg-danger-400/10", row: "bg-danger-100/10 dark:bg-danger-400/5", noun: "Failed — rejected by the server" },
    pending: { tone: "blue", bar: "bg-blue-100/30 dark:bg-blue-400/5 hover:bg-blue-100 dark:hover:bg-blue-400/10", row: "bg-blue-100/10 dark:bg-blue-400/5", noun: "Pending — re-upload required" },
};

// ─── Sub-components ───────────────────────────────────────────────────────────

/**
 * One cell of the reconciliation strip.
 *
 * @param {{ label: string, value: number, danger?: boolean }} props
 */
function ReconCell({ label, value, danger = false }) {
    return (
        <div className="flex flex-col items-center px-2" data-upload-recon={label.toLowerCase()} data-upload-value={value}>
            <span className={`text-sm font-aumovio-bold ${danger ? "text-danger-400" : "text-black/70 dark:text-white/70"}`}>{value}</span>
            <span className="mt-1 text-[11px] whitespace-nowrap text-black/45 dark:text-white/40">{label}</span>
        </div>
    );
}

/** Small operator between reconciliation cells. */
function ReconOp({ children }) {
    return <span className="text-sm select-none text-black/25 dark:text-white/25">{children}</span>;
}

/**
 * Collapsible per-bucket detail table. Rendered only when the bucket has rows;
 * the count is always visible in the stats grid regardless.
 *
 * @param {{ bucket: string, rows: Array<object>, columnLabels: object }} props
 */
function DetailSection({ bucket, rows, columnLabels }) {
    const [open, setOpen] = useState(false);
    const style = DETAIL_STYLE[bucket];

    // `id` is required by Table for its React key; the array index is stable
    // here because these rows are never re-sorted or filtered after render.
    const data = useMemo(() => rows.map((r, i) => ({ ...r, id: i })), [rows]);

    const columns = useMemo(
        () => [
            { key: "key", label: columnLabels.key, render: (r) => <span className="font-aumovio-bold whitespace-nowrap">{r.key}</span> },
            { key: "label", label: columnLabels.label, render: (r) => <span className="whitespace-nowrap">{r.label ?? "—"}</span> },
            { key: "reason", label: "Reason", render: (r) => <span className={STATUS_TEXT_COLORS[style.tone].replace("font-aumovio-bold", "")}>{r.reason}</span> },
            { key: "category", label: "Category", render: (r) => <span className="font-mono text-xs whitespace-nowrap text-black/50 dark:text-white/40">{CATEGORY_LABELS[r.category] ?? r.category}</span> },
        ],
        [columnLabels, style.tone],
    );

    return (
        <div className={`rounded-lg ${STANDARD_BORDER} overflow-hidden`} data-upload-detail={bucket} data-upload-value={rows.length}>
            <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className={`w-full flex items-center justify-between px-4 py-3 ${style.bar} ${TRANSITION_COLORS}`}>
                <span className={`text-sm ${STATUS_TEXT_COLORS[style.tone]}`}>
                    {rows.length} {style.noun}
                </span>
                <FontAwesomeIcon icon={open ? faChevronUp : faChevronDown} className="text-grey-400" />
            </button>
            {open && (
                <div className="p-2">
                    <Table columns={columns} data={data} compact wrapperClassName="max-h-60" rowClassName={() => style.row} emptyText="No rows." />
                </div>
            )}
        </div>
    );
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * @component StepUploadComplete
 *
 * @param {Object} props
 * @param {ReturnType<import('./uploadOutcome').normalizeUploadOutcome>} props.outcome
 *   Normalised ledger. Build it with `normalizeUploadOutcome(result, { parsedRows, excludedRows, feature })`.
 * @param {string} props.title - What was uploaded, e.g. "Invoices", "Employee Records".
 * @param {Function} props.onReset - Restarts the wizard at Step 1.
 * @param {string} [props.resetLabel="Upload Another File"] - Reset button text.
 * @param {{ key: string, label: string }} [props.columnLabels] - Header text for the
 *   first two detail-table columns, e.g. `{ key: "EMP_ID", label: "Employee" }`.
 * @param {import('react').ReactNode} [props.children] - Feature-specific sections
 *   (an archived-records table, an email-delivery badge). Rendered after
 *   the detail tables and before the machine-readable block.
 */
export function StepUploadComplete({ outcome, title, onReset, resetLabel = "Upload Another File", columnLabels = { key: "Record", label: "Details" }, children }) {
    const [showJson, setShowJson] = useState(false);

    const { counts, file, severity, balanced, fileBalanced } = outcome;
    const style = SEVERITY_STYLE[severity] ?? SEVERITY_STYLE.warning;
    const json = useMemo(() => outcomeToJson(outcome), [outcome]);
    const sentence = summarySentence(outcome);

    const headline = severity === "success" ? `${title} Saved Successfully` : counts.failed > 0 || !balanced ? `${title} — Completed With Errors` : `${title} — Completed With Nothing Written`;

    return (
        <div className={`space-y-6 ${ANIMATE_FADE_IN_UP}`} data-upload-result="ready" data-upload-feature={outcome.feature} data-upload-severity={severity} data-upload-balanced={String(balanced && fileBalanced)}>
            {/* Hero icon */}
            <div className="flex justify-center">
                <div className={`flex items-center justify-center w-20 h-20 rounded-full shadow-lg ${style.ring}`}>
                    <FontAwesomeIcon icon={style.icon} className={`text-4xl ${style.text}`} />
                </div>
            </div>

            {/* Title + the one deterministic summary sentence */}
            <div className="text-center">
                <h3 className={`text-2xl ${TITLE_COLOR_TEXT}`}>{headline}</h3>
                <p className="mt-1 text-black/50 dark:text-white/50" data-upload-summary>
                    {sentence}
                </p>
            </div>

            {/* Unbalanced ledger — never suppressed. A gap here means rows went
                missing between the request and the response, which is a defect
                the operator must see rather than discover later in the data. */}
            {(!balanced || !fileBalanced) && (
                <div className={`rounded-lg p-4 ${STATUS_BG_COLORS.red} ${STATUS_BORDER_COLORS.red}`} role="alert">
                    <p className={`text-sm ${STATUS_TEXT_COLORS.red}`}>
                        <FontAwesomeIcon icon={faTriangleExclamation} className="mr-2" />
                        Result does not reconcile
                    </p>
                    <p className="mt-1 text-xs text-black/60 dark:text-white/60">
                        {!balanced && `${Math.abs(counts.unaccounted)} submitted row${Math.abs(counts.unaccounted) !== 1 ? "s are" : " is"} not represented in any outcome bucket. `}
                        {!fileBalanced && `Parsed rows (${file.parsed}) do not equal excluded (${file.excluded}) plus submitted (${file.submitted}). `}
                        Report this upload's Request ID to the development team before treating the result as final.
                    </p>
                </div>
            )}

            {/* Reconciliation strip — the whole arithmetic, always on screen */}
            <div className={`flex flex-wrap items-center justify-center gap-1 py-3 rounded-xl ${STATUS_BG_COLORS.grey} ${STATUS_BORDER_COLORS.grey}`} data-upload-reconciliation>
                <ReconCell label="Parsed" value={file.parsed} />
                <ReconOp>−</ReconOp>
                <ReconCell label="Excluded" value={file.excluded} />
                <ReconOp>=</ReconOp>
                <ReconCell label="Submitted" value={file.submitted} />
                <ReconOp>=</ReconOp>
                {OUTCOME_BUCKETS.map((b, i) => (
                    <span key={b.key} className="flex items-center gap-1">
                        {i > 0 && <ReconOp>+</ReconOp>}
                        <ReconCell label={b.label} value={counts[b.key]} />
                    </span>
                ))}
                {counts.unaccounted !== 0 && (
                    <span className="flex items-center gap-1">
                        <ReconOp>+</ReconOp>
                        <ReconCell label="Unaccounted" value={counts.unaccounted} danger />
                    </span>
                )}
            </div>

            {/* Stats grid — all five buckets, always, zeros included */}
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
                {OUTCOME_BUCKETS.map((b) => {
                    // A zero bucket is drawn grey so a non-zero one stands out,
                    // but the cell itself is never removed.
                    const tone = counts[b.key] > 0 ? b.tone : "grey";
                    return (
                        <div key={b.key} className={`p-4 rounded-xl text-center ${STATUS_BG_COLORS[tone]} ${STATUS_BORDER_COLORS[tone]}`} data-upload-count={b.key} data-upload-value={counts[b.key]}>
                            <p className={`text-2xl ${STATUS_TEXT_COLORS[tone]}`}>{counts[b.key]}</p>
                            <p className="mt-1 text-xs text-black/50 dark:text-white/50">{b.label}</p>
                        </div>
                    );
                })}
            </div>

            {/* Detail tables — one per non-empty bucket, identical columns */}
            {DETAIL_BUCKETS.filter((bucket) => outcome.rows[bucket].length > 0).map((bucket) => (
                <DetailSection key={bucket} bucket={bucket} rows={outcome.rows[bucket]} columnLabels={columnLabels} />
            ))}

            {/* Feature-specific extras (archived rows, email delivery, …) */}
            {children}

            {/* Machine-readable ledger for the RPA tooling */}
            <div className={`rounded-lg ${STANDARD_BORDER} overflow-hidden`}>
                <button type="button" onClick={() => setShowJson((v) => !v)} aria-expanded={showJson} className={`w-full flex items-center justify-between px-4 py-3 bg-grey-100 dark:bg-grey-400/5 hover:bg-grey-200 dark:hover:bg-grey-400/10 ${TRANSITION_COLORS}`}>
                    <span className="text-sm text-black/60 dark:text-white/60">Machine-readable result (JSON)</span>
                    <FontAwesomeIcon icon={showJson ? faChevronUp : faChevronDown} className="text-grey-400" />
                </button>
                {showJson && (
                    <div className="p-3">
                        <Clipboard variant="block" label="upload-result.json" value={json} />
                    </div>
                )}
            </div>

            {/* Always in the DOM, never painted — the stable scrape target that
                does not depend on the operator expanding the block above. */}
            <pre data-upload-json hidden>{json}</pre>

            {/* Reset */}
            <div className="flex justify-center">
                <Button variant="primary" onClick={onReset} type="button">
                    <FontAwesomeIcon icon={faUpload} />
                    {resetLabel}
                </Button>
            </div>
        </div>
    );
}

export default StepUploadComplete;
