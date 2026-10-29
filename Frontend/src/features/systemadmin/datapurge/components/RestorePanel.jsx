/**
 * RestorePanel.jsx — dropzone → dry-run preview report → confirm.
 *
 * Presentation only. Receives the whole `useDataPurge()` hook object via
 * props (whole-hook pattern) — never imports datapurge.hook.js or
 * datapurge.api.js directly.
 *
 * NOT an Excel-upload stepper — the uploaded file is a `.zip` backup
 * archive, not an `.xlsx` workbook, so `ExcelStepDropzone` (Excel-only,
 * Frontend/CLAUDE.md §"Excel Upload Stepper") does not apply here. This is
 * a bespoke two-stage dropzone matching the same visual idiom.
 *
 * Flow:
 *   1. Drop/select a `.zip` archive.
 *   2. `POST /restore/preview` — read-only dry-run. Renders the resolved
 *      table list, row counts, archive metadata, and the fidelity notice
 *      (plan: "must appear BEFORE the operator confirms").
 *   3. Only once the preview succeeds are the admin-password and
 *      confirm-phrase fields enabled, gating the real `POST /restore`.
 *   4. Result report via the shared `PurgeReportPanel`.
 */

import { faFileZipper, faRotateLeft } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { CloudArrowUpIcon, ExclamationTriangleIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useCallback } from "react";
import { useDropzone } from "react-dropzone";
import { ANIMATE_FADE_IN_UP, ANIMATE_SCALE_IN, ANIMATE_SHAKE, TRANSITION_COLORS } from "../../../../assets/styles/pre-set-styles";
import ApiErrorAlert from "../../../../components/feedback/ApiErrorAlert";
import { Input } from "../../../../components/forms/Input";
import Alert from "../../../../components/ui/Alert";
import Badge from "../../../../components/ui/Badge";
import Button from "../../../../components/ui/Button";
import Spinner from "../../../../components/ui/Spinner";
import { Tooltip } from "../../../../components/ui/Tooltip";
import { formatCompactNumber, formatDateTime, formatNumber } from "../../../../utils/formatters";
import { FidelityNoticePanel } from "./FidelityNoticePanel";
import { PurgeReportPanel } from "./PurgeReportPanel";
import { TamperedRestoreAlert } from "./TamperedRestoreAlert";

/** Abbreviated row count with the exact figure on hover (see PurgeScopeSelector). */
const CompactRows = ({ value, withSuffix = false }) => (
    <Tooltip content={`${formatNumber(value)} row${value === 1 ? "" : "s"}`} placement="top">
        <span className="tabular-nums cursor-default">
            {formatCompactNumber(value)}
            {withSuffix ? " rows" : ""}
        </span>
    </Tooltip>
);

/**
 * @param {object} props
 * @param {object} props.hook - Full `useDataPurge()` hook object.
 */
export function RestorePanel({ hook }) {
    const onDrop = useCallback(
        (accepted) => {
            const f = accepted[0];
            if (f) hook.handleRestoreFile(f);
        },
        [hook],
    );

    const { getRootProps, getInputProps, isDragActive } = useDropzone({
        onDrop,
        accept: { "application/zip": [".zip"], "application/x-zip-compressed": [".zip"] },
        maxSize: hook.maxRestoreFileSize,
        multiple: false,
        disabled: !!hook.restoreFile,
    });

    // ── Terminal state — restore already completed ──────────────────────────
    if (hook.restoreResult) {
        return (
            <div className={`space-y-4 ${ANIMATE_FADE_IN_UP}`}>
                <TamperedRestoreAlert report={hook.restoreResult} />
                <PurgeReportPanel mode="restore" report={hook.restoreResult} />
                <div className="flex justify-center">
                    <Button variant="ghost" onClick={hook.resetRestore} type="button">
                        <FontAwesomeIcon icon={faRotateLeft} className="mr-1.5" />
                        Restore Another Archive
                    </Button>
                </div>
            </div>
        );
    }

    return (
        <div className={`space-y-6 ${ANIMATE_FADE_IN_UP}`}>
            <Alert variant="info" title="Restore from a backup archive">
                <p className="text-sm mt-1">
                    Upload a <code>.zip</code> backup archive produced by the Purge stepper or downloaded from the Backup tab. The archive is verified and a read-only pre-flight report is generated first — nothing is written until you complete the confirmation below.
                </p>
            </Alert>

            {/* ── Dropzone ──────────────────────────────────────────────────── */}
            {!hook.restoreFile && (
                <div
                    {...getRootProps()}
                    onAnimationEnd={() => hook.setRestoreShaking(false)}
                    aria-label="Backup archive upload area"
                    className={`border-2 border-dashed rounded-xl p-16 text-center cursor-pointer select-none
                        ${TRANSITION_COLORS}
                        ${hook.restoreShaking ? `${ANIMATE_SHAKE} border-danger-400 bg-danger-100/10 dark:bg-danger-400/5` : ""}
                        ${isDragActive && !hook.restoreShaking ? "border-orange-400 bg-orange-50 dark:bg-orange-400/5 scale-[1.01] shadow-lg" : ""}
                        ${!isDragActive && !hook.restoreShaking ? "border-orange-200 dark:border-orange-400/30 hover:border-orange-400 hover:bg-orange-50 dark:hover:bg-orange-400/5" : ""}`}
                >
                    <input {...getInputProps()} />
                    <div className="flex flex-col items-center gap-3">
                        <div className={`p-4 rounded-full ${isDragActive ? "bg-orange-100 dark:bg-orange-400/20" : "bg-grey-100 dark:bg-(--bg-surface-3)"} ${TRANSITION_COLORS}`}>
                            <CloudArrowUpIcon className={`w-8 h-8 ${isDragActive ? "text-(--accent-icon)" : "text-grey-400"} ${TRANSITION_COLORS}`} />
                        </div>
                        {isDragActive ? (
                            <p className="text-lg font-aumovio-bold text-(--accent-foreground)">Drop the backup archive here...</p>
                        ) : (
                            <div className="space-y-1">
                                <p className="text-lg text-black/70 dark:text-white/70">Drag &amp; drop a backup `.zip` here</p>
                                <p className="text-black/50 dark:text-white/50">
                                    or <span className="text-(--accent-foreground) font-aumovio-bold hover:underline">click to select</span>
                                </p>
                                <p className="text-black/40 dark:text-white/40 text-sm">Supports .zip only &middot; Max {hook.formatFileSize(hook.maxRestoreFileSize)}</p>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {hook.restoreFileError && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-danger-100 dark:bg-danger-400/10 border border-danger-400/30 text-danger-400 text-sm">
                    <ExclamationTriangleIcon className="w-4 h-4 shrink-0" />
                    {hook.restoreFileError}
                </div>
            )}

            {/* ── Selected file card ───────────────────────────────────────── */}
            {hook.restoreFile && (
                <div className={`p-4 rounded-lg bg-success-100/20 dark:bg-success-400/10 border border-success-400/30 flex items-start gap-4 ${ANIMATE_SCALE_IN}`}>
                    <FontAwesomeIcon icon={faFileZipper} className="text-2xl text-success-400 mt-1 shrink-0" />
                    <div className="flex-1 min-w-0">
                        <p className="font-aumovio-bold text-black/85 dark:text-white/85 truncate">{hook.restoreFile.name}</p>
                        <p className="text-sm text-black/50 dark:text-white/50 mt-1">{hook.formatFileSize(hook.restoreFile.size)}</p>
                    </div>
                    <button onClick={hook.handleRemoveRestoreFile} type="button" aria-label="Remove file" className={`text-grey-400 hover:text-danger-400 ${TRANSITION_COLORS} p-1 rounded`}>
                        <XMarkIcon className="w-5 h-5" />
                    </button>
                </div>
            )}

            {hook.restoreFile && !hook.restorePreviewData && (
                <div className="flex justify-end">
                    <Button variant="primary" onClick={hook.handleRestorePreview} loading={hook.restorePreviewLoading} disabled={hook.restorePreviewLoading} type="button">
                        {!hook.restorePreviewLoading && <ExclamationTriangleIcon className="w-4 h-4" />}
                        {hook.restorePreviewLoading ? "Verifying archive..." : "Run Pre-flight Check"}
                    </Button>
                </div>
            )}

            {hook.restorePreviewError && <ApiErrorAlert error={hook.restorePreviewError} onDismiss={null} />}

            {/* ── Pre-flight report ────────────────────────────────────────── */}
            {hook.restorePreviewData && <RestorePreviewReport hook={hook} />}
        </div>
    );
}

// ─── Pre-flight report + confirm ───────────────────────────────────────────────

function RestorePreviewReport({ hook }) {
    const p = hook.restorePreviewData;

    return (
        <div className={`space-y-4 ${ANIMATE_SCALE_IN}`}>
            <Alert variant="success" title="Archive verified">
                <p className="text-sm mt-1">The archive's signature is valid and the pre-flight checks passed. Nothing has been written yet.</p>
            </Alert>

            {/* Archive metadata + kind */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                <MetaTile
                    label="Kind"
                    value={
                        <Badge variant={p.kind === "ENTITY" ? "cyan" : "orange"} size="sm" pill>
                            {p.kind}
                        </Badge>
                    }
                />
                <MetaTile label="Tables" value={formatNumber(p.tables.length)} />
                <MetaTile label="Total Rows" value={<CompactRows value={Object.values(p.rowCounts ?? {}).reduce((s, n) => s + n, 0)} />} />
                <MetaTile label="Archived At" value={p.archiveMeta?.createdAt ? formatDateTime(p.archiveMeta.createdAt) : "—"} />
            </div>

            {p.kind === "ENTITY" && p.entity && (
                <p className="text-xs text-black/50 dark:text-white/50">
                    Single-subject restore:{" "}
                    <span className="font-mono">
                        {p.entity.table}.{p.entity.keyColumn}
                    </span>{" "}
                    = <span className="font-aumovio-bold">{String(p.entity.keyValue)}</span>
                </p>
            )}

            {/* Per-table row counts */}
            <div className="space-y-1 max-h-40 overflow-y-auto pr-1 hide-scrollbar border border-grey-200 dark:border-grey-700 rounded-lg p-3">
                {p.tables.map((table) => (
                    <div key={table} className="flex items-center justify-between gap-2 text-xs">
                        <span className="font-mono text-black/60 dark:text-white/60 inline-flex items-center gap-2 min-w-0">
                            <span className="truncate">{table}</span>
                            {p.tablesGettingNewPks.includes(table) && (
                                <Badge variant="purple" size="xs" pill>
                                    New PK
                                </Badge>
                            )}
                        </span>
                        <span className="shrink-0 text-black/40 dark:text-white/40">
                            <CompactRows value={p.rowCounts?.[table] ?? 0} withSuffix />
                        </span>
                    </div>
                ))}
            </div>

            {/* Fidelity notice — must appear BEFORE the operator confirms */}
            <FidelityNoticePanel notes={p.fidelityNotes} tablesGettingNewPks={p.tablesGettingNewPks} title="Fidelity notice — restored data will differ from the original in these ways" />

            {/* Confirm section — only enabled after a successful preview */}
            <div className="pt-4 border-t border-grey-200 dark:border-grey-700 space-y-4">
                <Alert variant="danger" title="Confirm restore">
                    <p className="text-sm mt-1">Enter your admin password and type the exact confirm phrase to write this archive back to the database.</p>
                </Alert>

                {hook.restoreError && (
                    <Alert variant="danger" title="Restore failed">
                        <p className="text-sm mt-1">{hook.restoreError.message}</p>
                    </Alert>
                )}

                <Input id="restoreAdminPassword" name="restoreAdminPassword" label="Your Admin Password" type="password" value={hook.restoreAdminPassword} onChange={(e) => hook.setRestoreAdminPassword(e.target.value)} placeholder="Enter your account password" autoComplete="off" required />

                {/* Same fix as PurgeStepperModal's StepFinalConfirm form — the
                    footer's "Execute Restore" button is disabled whenever the
                    phrase doesn't match, so wire onSubmit to the real handler
                    to keep the shake-on-mismatch guard reachable via
                    Enter-to-submit. */}
                <form
                    className={`space-y-2 ${hook.restoreConfirmShaking ? ANIMATE_SHAKE : ""}`}
                    onAnimationEnd={() => hook.setRestoreConfirmShaking(false)}
                    onSubmit={(e) => {
                        e.preventDefault();
                        hook.handleRestoreExecute();
                    }}
                >
                    <p className="text-xs text-black/50 dark:text-white/50 flex items-center gap-2">
                        <ExclamationTriangleIcon className="w-4 h-4 text-danger-400 shrink-0" />
                        Type exactly as shown (case-sensitive).
                    </p>
                    <div className="p-3 rounded-lg bg-grey-900 dark:bg-black">
                        <code className="text-sm text-grey-100 break-all">{hook.restoreExpectedPhrase ?? "…"}</code>
                    </div>
                    <Input id="restoreConfirmPhrase" name="restoreConfirmPhrase" label="Confirmation phrase" type="text" value={hook.restoreConfirmPhraseTyped} onChange={(e) => hook.setRestoreConfirmPhraseTyped(e.target.value)} placeholder="Type the confirmation phrase" autoComplete="off" required />
                    {hook.restoreConfirmPhraseTyped && <span className={`flex items-center gap-1 text-xs ${hook.restoreConfirmMatches ? "text-success-400" : "text-danger-400"}`}>{hook.restoreConfirmMatches ? "✓ Phrase matches" : "✗ Phrase does not match"}</span>}
                </form>

                <div className="flex justify-end gap-2">
                    <Button variant="ghost" onClick={hook.resetRestore} type="button" disabled={hook.restoreExecuting}>
                        Cancel
                    </Button>
                    {/* No static aria-label — visible text is dynamic ("Execute Restore" / "Restoring..."). */}
                    <Button variant="danger" onClick={hook.handleRestoreExecute} loading={hook.restoreExecuting} disabled={!hook.canExecuteRestore} type="button">
                        {hook.restoreExecuting ? "Restoring..." : "Execute Restore"}
                    </Button>
                </div>

                {hook.restoreExecuting && (
                    <div className="flex items-center justify-center gap-2 text-sm text-black/50 dark:text-white/50">
                        <Spinner size="xs" />
                        Do not close this window. Large archives may take a moment.
                    </div>
                )}
            </div>
        </div>
    );
}

/**
 * @param {{ label: string, value: React.ReactNode }} props
 */
function MetaTile({ label, value }) {
    return (
        <div className="flex flex-col gap-1 p-3 rounded-lg bg-grey-50 dark:bg-(--bg-surface-3) border border-(--color-card-surface-border)">
            <span className="uppercase tracking-wide text-[10px] text-grey-400">{label}</span>
            <span className="font-aumovio-bold text-black/80 dark:text-white/80">{value}</span>
        </div>
    );
}

export default RestorePanel;
