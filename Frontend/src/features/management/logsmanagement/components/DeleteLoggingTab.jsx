import { CheckCircleIcon, ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import { ALERT_WARNING, ANIMATE_BOUNCE_IN, ANIMATE_ENTER_UP, ANIMATE_PAGE_ENTER, BASE_COLOR_BG, staggerDelay, STANDARD_BORDER } from "../../../../assets/styles/pre-set-styles";
import ApiErrorAlert from "../../../../components/feedback/ApiErrorAlert";
import { Checkbox } from "../../../../components/forms/Checkbox";
import Button from "../../../../components/ui/Button";
import Card from "../../../../components/ui/Card";
import { Datepicker } from "../../../../components/ui/Datepicker";
import Stepper from "../../../../components/ui/Stepper";

// ─── Step definitions ──────────────────────────────────────────────────────────

const STEPS = [
    { id: "select", label: "Select & Export", description: "Choose date range and download backup" },
    { id: "confirm", label: "Confirm Deletion", description: "Review and confirm permanent deletion" },
    { id: "done", label: "Done", description: "Deletion complete" },
];

// ─── Date formatter ────────────────────────────────────────────────────────────

const _fmtDate = (iso) =>
    iso
        ? new Date(iso + "T00:00:00").toLocaleDateString("en-US", {
              month: "long",
              day: "numeric",
              year: "numeric",
          })
        : "—";

// ─── Step 1 — Select & Export ──────────────────────────────────────────────────

function StepSelectExport({ hook }) {
    const { deleteFromDate, setDeleteFromDate, deleteToDate, setDeleteToDate, setDeleteStep, handleExportDeleteExcel, handleExportDeleteLogs } = hook;

    const canContinue = Boolean(deleteFromDate && deleteToDate);

    return (
        <div className={`space-y-6 ${ANIMATE_ENTER_UP} ${staggerDelay(0)}`}>
            {/* Warning banner */}
            <div className={`${ALERT_WARNING} flex items-start gap-3`}>
                <ExclamationTriangleIcon className="w-5 h-5 shrink-0 mt-0.5" />
                <p className="text-sm">Download your records before deleting. This action is permanent and cannot be undone.</p>
            </div>

            {/* Date range pickers */}
            <div className={`p-6 rounded-xl bg-(--bg-surface) dark:bg-(--bg-surface-2) border border-grey-200 dark:border-grey-700 shadow-sm relative z-10 ${ANIMATE_ENTER_UP} ${staggerDelay(1)}`}>
                <p className="text-sm font-medium text-black/70 dark:text-white/70 mb-4">Select the date range to export and delete</p>
                <div className="flex flex-wrap gap-4">
                    <div className="flex flex-col gap-1">
                        <p className="text-xs font-medium text-grey-500 dark:text-white/50">Start Date</p>
                        <Datepicker value={deleteFromDate ? new Date(deleteFromDate) : null} onChange={(v) => setDeleteFromDate(v ? v.toISOString().slice(0, 10) : "")} className="w-44" />
                    </div>
                    <div className="flex flex-col gap-1">
                        <p className="text-xs font-medium text-grey-500 dark:text-white/50">End Date</p>
                        <Datepicker value={deleteToDate ? new Date(deleteToDate) : null} onChange={(v) => setDeleteToDate(v ? v.toISOString().slice(0, 10) : "")} minDate={deleteFromDate ? new Date(deleteFromDate) : undefined} className="w-44" />
                    </div>
                </div>
            </div>

            {/* Export actions */}
            <Card className={`p-6 bg-(--bg-surface) dark:bg-(--bg-surface-2) ${ANIMATE_ENTER_UP} ${staggerDelay(2)}`}>
                <p className="text-sm font-medium text-black/70 dark:text-white/70 mb-4">Step 1: Download a backup of your data before proceeding</p>
                <div className="flex flex-wrap gap-3">
                    <Button variant="primary" onClick={handleExportDeleteExcel} disabled={!canContinue}>
                        Export DB Records (Excel)
                    </Button>
                    <Button variant="ghost" onClick={handleExportDeleteLogs} disabled={!canContinue}>
                        Export Logs (ZIP)
                    </Button>
                </div>
            </Card>

            {/* Inline API error */}
            <ApiErrorAlert error={hook.apiError} onDismiss={() => hook.setApiError(null)} />

            {/* Continue button */}
            <div className={`flex justify-end ${ANIMATE_ENTER_UP} ${staggerDelay(3)}`}>
                <Button variant="primary" onClick={() => setDeleteStep(2)} disabled={!canContinue}>
                    Continue to Confirm
                </Button>
            </div>
        </div>
    );
}

// ─── Step 2 — Confirm Deletion ─────────────────────────────────────────────────

function StepConfirmDeletion({ hook }) {
    const { deleteFromDate, deleteToDate, deleteConfirmed, setDeleteConfirmed, deleting, handleConfirmDelete, setDeleteStep } = hook;

    const handleGoBack = () => {
        setDeleteConfirmed(false);
        setDeleteStep(1);
    };

    return (
        <div className={`space-y-6 ${ANIMATE_ENTER_UP} ${staggerDelay(0)}`}>
            {/* Danger card */}
            <div
                className={`
        bg-danger-100 dark:bg-danger-400/15
        border border-danger-400/30
        rounded-2xl p-6
        ${ANIMATE_ENTER_UP} ${staggerDelay(1)}
      `}
            >
                <div className="flex items-start gap-4">
                    <div className="shrink-0 p-2 rounded-full bg-danger-400/15">
                        <ExclamationTriangleIcon className="w-8 h-8 text-danger-400" />
                    </div>
                    <div className="flex-1 space-y-3">
                        <h2 className="text-base font-aumovio-bold text-danger-400">This action is permanent and irreversible</h2>
                        <p className="text-sm text-black/70 dark:text-white/70 leading-relaxed">All audit log database records and server log files within the selected date range will be permanently deleted. There is no recovery path after this point.</p>

                        {/* Date range summary */}
                        <div className="rounded-lg bg-danger-400/10 border border-danger-400/20 px-4 py-3 mt-2">
                            <p className="text-xs font-medium text-danger-400/70 uppercase tracking-wide mb-1">Date Range</p>
                            <p className="text-sm font-aumovio-bold text-danger-400">
                                {_fmtDate(deleteFromDate)}
                                <span className="mx-2 text-danger-400/50">→</span>
                                {_fmtDate(deleteToDate)}
                            </p>
                        </div>

                        {/* Confirmation checkbox */}
                        <div className={`pt-2 ${ANIMATE_ENTER_UP} ${staggerDelay(2)}`}>
                            <Checkbox label="I understand this action cannot be undone" checked={deleteConfirmed} onChange={(v) => setDeleteConfirmed(v)} />
                        </div>
                    </div>
                </div>
            </div>

            {/* Inline API error */}
            <ApiErrorAlert error={hook.apiError} onDismiss={() => hook.setApiError(null)} />

            {/* Action buttons */}
            <div className={`flex flex-wrap justify-between gap-3 ${ANIMATE_ENTER_UP} ${staggerDelay(3)}`}>
                <Button variant="ghost" onClick={handleGoBack} disabled={deleting}>
                    Go Back
                </Button>
                <Button variant="danger" onClick={handleConfirmDelete} disabled={!deleteConfirmed || deleting} loading={deleting}>
                    Permanently Delete
                </Button>
            </div>
        </div>
    );
}

// ─── Step 3 — Done ─────────────────────────────────────────────────────────────

function StepDone({ hook }) {
    const { deleteFromDate, deleteToDate, handleResetDeleteStepper } = hook;

    return (
        <div className={`flex flex-col items-center justify-center py-16 gap-6 text-center ${ANIMATE_ENTER_UP} ${staggerDelay(0)}`}>
            <div className={`p-4 rounded-full bg-success-400/15 ${ANIMATE_BOUNCE_IN}`}>
                <CheckCircleIcon className="w-16 h-16 text-success-400" />
            </div>
            <div className={`space-y-2 ${ANIMATE_ENTER_UP} ${staggerDelay(1)}`}>
                <h2 className="text-xl font-aumovio-bold text-black dark:text-white">Deletion Complete</h2>
                <p className="text-sm text-black/60 dark:text-white/60 max-w-md leading-relaxed">All audit log records and log files within the selected range have been permanently removed.</p>
                <p className="text-xs font-mono text-black/40 dark:text-white/35 pt-1">
                    {_fmtDate(deleteFromDate)}
                    <span className="mx-1.5 text-black/25 dark:text-white/20">→</span>
                    {_fmtDate(deleteToDate)}
                </p>
            </div>
            <div className={ANIMATE_ENTER_UP + " " + staggerDelay(2)}>
                <Button variant="ghost" onClick={handleResetDeleteStepper}>
                    Start Over
                </Button>
            </div>
        </div>
    );
}

// ─── Main component ────────────────────────────────────────────────────────────

/**
 * Delete Logging tab — 3-step stepper for exporting and permanently deleting
 * audit log DB records and server log files within a selected date range.
 *
 * @param {{ hook: object }} props - The hook object from useLogsManagement.
 */
export default function DeleteLoggingTab({ hook }) {
    const { deleteStep } = hook;

    return (
        <div className={`${ANIMATE_PAGE_ENTER}`}>
            <div className={`p-8 rounded-2xl ${BASE_COLOR_BG} ${STANDARD_BORDER} shadow-lg`}>
                {/* Stepper progress indicator */}
                <Stepper steps={STEPS} current={deleteStep - 1} variant="numbered" orientation="horizontal" />

                {/* Step content */}
                <div className="mt-10">
                    {deleteStep === 1 && <StepSelectExport hook={hook} />}
                    {deleteStep === 2 && <StepConfirmDeletion hook={hook} />}
                    {deleteStep === 3 && <StepDone hook={hook} />}
                </div>
            </div>
        </div>
    );
}
