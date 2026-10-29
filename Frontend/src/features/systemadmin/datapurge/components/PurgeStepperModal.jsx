/**
 * PurgeStepperModal.jsx — The 5-step purge confirmation flow.
 *
 * Presentation only. Receives the whole `useDataPurge()` hook object via
 * props — never imports datapurge.hook.js or datapurge.api.js directly.
 *
 * Steps (1-based, maps to `hook.purgeStep`):
 *   1 Scope Review   — resolved closure + auto-included groups + fidelity notice
 *   2 Backup         — `.zip` download must COMPLETE before the next step unlocks
 *   3 Authorise      — admin password
 *   4 Final Confirm  — operator types the exact server-issued confirm phrase;
 *                      ANIMATE_SHAKE + onAnimationEnd reset on mismatch;
 *                      distinct red lockout panel when the admin-account table is in scope
 *   5 Processing      — spinner while /execute is in flight, then the report
 *
 * Security posture:
 *   - No dangerouslySetInnerHTML.
 *   - The backup-before-purge gate here is UX only — the backend
 *     independently enforces it via the signed backup token (CWE-602).
 *   - Confirm-phrase matching shown here is UX only — `/execute` re-verifies
 *     the phrase server-side against its own frozen row-count snapshot.
 *   - The lockout `acknowledgeLockout` checkbox is wired to the exact API
 *     field name `DataPurgeService.executePurge` checks.
 */

import { faDatabase, faShieldHalved } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { ArrowLeftIcon, ArrowRightIcon, CheckCircleIcon, DocumentArrowDownIcon, ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import { ANIMATE_BOUNCE_IN, ANIMATE_SCALE_IN, ANIMATE_SHAKE, staggerDelay, ANIMATE_ENTER_UP } from "../../../../assets/styles/pre-set-styles";
import ApiErrorAlert from "../../../../components/feedback/ApiErrorAlert";
import { Checkbox } from "../../../../components/forms/Checkbox";
import { Input } from "../../../../components/forms/Input";
import Alert from "../../../../components/ui/Alert";
import Badge from "../../../../components/ui/Badge";
import Button from "../../../../components/ui/Button";
import { Clipboard } from "../../../../components/ui/Clipboard";
import { Modal } from "../../../../components/ui/Modal";
import Skeleton from "../../../../components/ui/Skeleton";
import Spinner from "../../../../components/ui/Spinner";
import Stepper from "../../../../components/ui/Stepper";
import { Tooltip } from "../../../../components/ui/Tooltip";
import { formatCompactNumber, formatDateTime, formatNumber } from "../../../../utils/formatters";
import { groupLabel } from "./shared/purgeGroupMeta";
import { FidelityNoticePanel } from "./FidelityNoticePanel";
import { PurgeReportPanel } from "./PurgeReportPanel";

const STEPS = [
    { id: "scope", label: "Scope Review" },
    { id: "backup", label: "Backup" },
    { id: "authorise", label: "Authorise" },
    { id: "confirm", label: "Final Confirm" },
    { id: "processing", label: "Processing" },
];

// Re-seeds the demo SUPER_ADMIN (admin / Demo@123) after the admin table is purged.
const RECOVERY_COMMAND = "cd Backend && npm run db:seed:template";

/**
 * @param {object} props
 * @param {object} props.hook - Full `useDataPurge()` hook object.
 */
export function PurgeStepperModal({ hook }) {
    if (!hook.purgeModalOpen) return null;

    const stepperCurrent = hook.purgeStep - 1; // Stepper is 0-based

    return (
        <Modal
            open={hook.purgeModalOpen}
            onClose={hook.closePurgeModal}
            title="Purge Platform Data"
            size="xl"
            variant="danger"
            footer={<StepFooter hook={hook} />}
        >
            <div className="mb-5">
                <Stepper steps={STEPS} current={stepperCurrent} variant="numbered" orientation="horizontal" />
            </div>

            {hook.purgeStep === 1 && <StepScopeReview hook={hook} />}
            {hook.purgeStep === 2 && <StepBackup hook={hook} />}
            {hook.purgeStep === 3 && <StepAuthorise hook={hook} />}
            {hook.purgeStep === 4 && <StepFinalConfirm hook={hook} />}
            {hook.purgeStep === 5 && <StepProcessing hook={hook} />}
        </Modal>
    );
}

// ─── Step 1 — Scope Review ────────────────────────────────────────────────────

function StepScopeReview({ hook }) {
    if (hook.previewLoading) {
        // The real review body is a danger Alert banner followed by grouped
        // table-row lists — mirror that with an alert-height block + text rows,
        // not an avatar-row list.
        return (
            <div className={`space-y-4 ${ANIMATE_SCALE_IN}`}>
                <Skeleton variant="rect" height="4rem" />
                <Skeleton variant="text" lines={4} />
            </div>
        );
    }

    if (hook.previewError) {
        return <ApiErrorAlert error={hook.previewError} onDismiss={null} />;
    }

    if (!hook.previewData) return null;

    const { requestedGroups, autoIncludedGroups, tables, totalRows, confirmPhrase } = hook.previewData;

    // Group the resolved table list by their group for display.
    const byGroup = new Map();
    for (const t of tables) {
        if (!byGroup.has(t.group)) byGroup.set(t.group, []);
        byGroup.get(t.group).push(t);
    }

    return (
        <div className={`space-y-4 ${ANIMATE_SCALE_IN}`}>
            <Alert variant="danger" title="Permanent and irreversible action">
                <p className="text-sm mt-1">
                    This purges <span className="font-aumovio-bold">{formatNumber(totalRows)}</span> row(s) across <span className="font-aumovio-bold">{tables.length}</span> table(s). This cannot be undone — a backup download is required before you can proceed.
                </p>
            </Alert>

            {autoIncludedGroups.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="text-black/60 dark:text-white/60">Pulled in by FK dependency:</span>
                    {autoIncludedGroups.map((g) => (
                        <Badge key={g} variant="purple" size="sm" pill>
                            {groupLabel(g)}
                        </Badge>
                    ))}
                </div>
            )}

            <div className="space-y-3 max-h-60 overflow-y-auto pr-1 hide-scrollbar">
                {[...byGroup.entries()].map(([group, groupTables], i) => (
                    <div key={group} className={`p-3 rounded-lg border border-grey-200 dark:border-grey-700 ${ANIMATE_ENTER_UP} ${staggerDelay(i)}`}>
                        <div className="flex items-center gap-2 mb-1.5">
                            <span className="text-sm font-aumovio-bold text-black/80 dark:text-white/80">{groupLabel(group)}</span>
                            {!requestedGroups.includes(group) && (
                                <Badge variant="purple" size="xs" pill>
                                    Auto-included
                                </Badge>
                            )}
                        </div>
                        <div className="space-y-1">
                            {groupTables.map((t) => (
                                <div key={t.table} className="flex items-center justify-between gap-2 text-xs">
                                    <span className="font-mono text-black/60 dark:text-white/60 truncate">{t.table}</span>
                                    {/* Abbreviated so a millions-row table cannot push the count out of
                                        the modal; the exact figure is on hover. The headline total above
                                        stays exact — that is the number being authorised. */}
                                    <Tooltip content={`${formatNumber(t.rowCount)} row${t.rowCount === 1 ? "" : "s"}`} placement="left">
                                        <span className="shrink-0 tabular-nums text-black/40 dark:text-white/40 cursor-default">{formatCompactNumber(t.rowCount)} rows</span>
                                    </Tooltip>
                                </div>
                            ))}
                        </div>
                    </div>
                ))}
            </div>

            <FidelityNoticePanel notes={hook.previewData.fidelityNotes} />

            <div className="p-3 rounded-lg bg-grey-50 dark:bg-(--bg-surface-3) border border-grey-200 dark:border-grey-700">
                <p className="text-xs text-black/50 dark:text-white/50 mb-1">Confirm phrase preview (recalculated from the backup token at Step 4 — may change slightly if live counts shift before you download the backup):</p>
                <p className="font-mono text-sm text-black/70 dark:text-white/70">{confirmPhrase}</p>
            </div>
        </div>
    );
}

// ─── Step 2 — Backup ──────────────────────────────────────────────────────────

function StepBackup({ hook }) {
    return (
        <div className={`space-y-4 ${ANIMATE_SCALE_IN}`}>
            <Alert variant="warning" title="Download required before purge">
                <p className="text-sm mt-1">A full archive of the resolved scope must be downloaded as your recovery copy. You cannot proceed until the download completes. This is a UX gate — the server independently refuses to purge without a valid backup token.</p>
            </Alert>

            {hook.backupError && <ApiErrorAlert error={hook.backupError} onDismiss={() => {}} />}

            {hook.backupDownloaded && (
                <div className={`flex flex-col gap-1 text-success-400 text-sm font-aumovio-bold ${ANIMATE_BOUNCE_IN}`}>
                    <span className="flex items-center gap-2">
                        <CheckCircleIcon className="w-5 h-5 shrink-0" />
                        Backup archive downloaded. You may now proceed to authorisation.
                    </span>
                    {hook.backupTokenExpiresAt && <span className="text-xs font-normal text-black/50 dark:text-white/50 ml-7">Backup token valid until {formatDateTime(hook.backupTokenExpiresAt)}.</span>}
                </div>
            )}

            {hook.backupDownloading && (
                <div className="flex items-center gap-2 text-sm text-(--accent-foreground)">
                    <Spinner size="xs" />
                    <span>Building the backup archive — this may take a moment for large scopes...</span>
                </div>
            )}
        </div>
    );
}

// ─── Step 3 — Authorise ───────────────────────────────────────────────────────

function StepAuthorise({ hook }) {
    return (
        <div className={`space-y-4 ${ANIMATE_SCALE_IN}`}>
            <p className="text-sm text-black/60 dark:text-white/60">Enter your admin password to authorise this purge. This is verified server-side and is never stored.</p>

            {/* Verified HERE rather than only at /execute, so a wrong password is
                caught before the operator types the confirm phrase. */}
            {hook.authoriseError && <ApiErrorAlert error={hook.authoriseError} onDismiss={() => hook.setAuthoriseError(null)} />}

            <Input
                id="purgeAdminPassword"
                name="purgeAdminPassword"
                label="Your Admin Password"
                type="password"
                value={hook.adminPassword}
                onChange={(e) => {
                    hook.setAdminPassword(e.target.value);
                    // Clear a previous rejection as soon as they start correcting it.
                    if (hook.authoriseError) hook.setAuthoriseError(null);
                }}
                error={hook.authoriseError ? "That password doesn't match our records." : undefined}
                placeholder="Enter your account password"
                autoComplete="off"
                required
            />
        </div>
    );
}

// ─── Step 4 — Final Confirm ───────────────────────────────────────────────────

function StepFinalConfirm({ hook }) {
    const matches = hook.confirmPhraseMatches;

    return (
        <div className={`space-y-4 ${ANIMATE_SCALE_IN}`}>
            <Alert variant="danger" title="Last chance — this cannot be undone">
                <p className="text-sm mt-1">
                    Type the exact phrase below to unlock the purge button.
                </p>
            </Alert>

            {hook.executeError && (
                <Alert variant="danger" title="Purge failed">
                    <p className="text-sm mt-1">{hook.executeError.message}</p>
                </Alert>
            )}

            {hook.requiresLockoutAck && (
                <div className="p-4 rounded-xl bg-danger-100 dark:bg-danger-400/15 border-2 border-danger-400/60 space-y-3">
                    <div className="flex items-start gap-2">
                        <FontAwesomeIcon icon={faShieldHalved} className="text-danger-400 mt-1 shrink-0" />
                        <div>
                            <p className="text-sm font-aumovio-bold text-danger-600 dark:text-danger-300">This scope includes T_ADMINS_DEV — every admin login will be destroyed</p>
                            <p className="text-xs mt-1 text-danger-600/90 dark:text-danger-300/80">The backup archive is a downloadable file only — with no admin rows left, nobody can log in to upload it back. The command below is the sole recovery path. Read it and keep it before you continue.</p>
                        </div>
                    </div>

                    <Clipboard value={RECOVERY_COMMAND} label="Recovery command" showCode />

                    <Checkbox
                        id="purgeAcknowledgeLockout"
                        label="I understand every admin login will be destroyed, and I have saved the recovery command above."
                        checked={hook.acknowledgeLockout}
                        onChange={(e) => hook.setAcknowledgeLockout(e.target.checked)}
                    />
                </div>
            )}

            {/* The footer's "Execute Purge" button is disabled whenever the
                phrase doesn't match, so a click can never reach the
                shake-on-mismatch guard in hook.handleExecutePurge. Wiring the
                form's own onSubmit to the same handler restores that feedback
                via Enter-to-submit from within the field (disabled footer
                button + a real onSubmit that still validates). A bare
                `e.preventDefault()` here was a dead no-op — the shake path
                was unreachable from the real UI. */}
            <form className={`space-y-2 ${hook.confirmShaking ? ANIMATE_SHAKE : ""}`} onAnimationEnd={() => hook.setConfirmShaking(false)} onSubmit={(e) => { e.preventDefault(); hook.handleExecutePurge(); }}>
                <p className="text-xs text-black/50 dark:text-white/50 flex items-center gap-2">
                    <ExclamationTriangleIcon className="w-4 h-4 text-danger-400 shrink-0" />
                    Type exactly as shown (case-sensitive).
                </p>
                <div className="p-3 rounded-lg bg-grey-900 dark:bg-black">
                    <code className="text-sm text-grey-100 break-all">{hook.purgeConfirmPhrase ?? "…"}</code>
                </div>
                <Input id="purgeConfirmPhrase" name="purgeConfirmPhrase" label="Confirmation phrase" type="text" value={hook.confirmPhraseTyped} onChange={(e) => hook.setConfirmPhraseTyped(e.target.value)} placeholder="Type the confirmation phrase" autoComplete="off" required />
                {hook.confirmPhraseTyped && (
                    <span className={`flex items-center gap-1 text-xs ${matches ? "text-success-400" : "text-danger-400"}`}>
                        {matches ? "✓ Phrase matches" : "✗ Phrase does not match"}
                    </span>
                )}
            </form>
        </div>
    );
}

// ─── Step 5 — Processing ──────────────────────────────────────────────────────

function StepProcessing({ hook }) {
    if (hook.executing) {
        return (
            <div className={`flex flex-col items-center justify-center gap-4 py-8 ${ANIMATE_SCALE_IN}`}>
                <Spinner size="lg" />
                <p className="text-sm text-black/60 dark:text-white/60">Purging {hook.previewData?.tables?.length ?? 0} table(s)...</p>
                <p className="text-xs text-black/40 dark:text-white/40">Do not close this window. Large scopes may take a moment.</p>
            </div>
        );
    }

    if (hook.executeResult) {
        return <PurgeReportPanel mode="purge" report={hook.executeResult} />;
    }

    return null;
}

// ─── Step Footer ──────────────────────────────────────────────────────────────

function StepFooter({ hook }) {
    const step = hook.purgeStep;

    return (
        <>
            {!(step === 5 && hook.executing) && (
                <Button variant="ghost" onClick={hook.closePurgeModal} type="button">
                    {step === 5 ? "Close" : "Cancel"}
                </Button>
            )}

            {step > 1 && step < 5 && (
                <Button variant="ghost" onClick={() => hook.advancePurgeStep(step - 1)} type="button">
                    <ArrowLeftIcon className="w-4 h-4" />
                    Back
                </Button>
            )}

            {step === 1 && (
                <Button variant="danger" onClick={() => hook.advancePurgeStep(2)} disabled={!hook.previewData || hook.previewLoading || !!hook.previewError} type="button">
                    <ArrowRightIcon className="w-4 h-4" />
                    Proceed to Backup
                </Button>
            )}

            {step === 2 && (
                <>
                    {/* No static aria-label — the visible text is self-describing
                        and DYNAMIC ("Download Backup" / "Downloading..." /
                        "Download Again"); a static label would go stale and
                        override what assistive tech announces. */}
                    <Button variant="warning" onClick={hook.handleDownloadBackup} loading={hook.backupDownloading} disabled={hook.backupDownloading} type="button">
                        {!hook.backupDownloading && <DocumentArrowDownIcon className="w-4 h-4" />}
                        {hook.backupDownloading ? "Downloading..." : hook.backupDownloaded ? "Download Again" : "Download Backup"}
                    </Button>
                    {hook.backupDownloaded && (
                        <Button variant="danger" onClick={() => hook.advancePurgeStep(3)} type="button">
                            <ArrowRightIcon className="w-4 h-4" />
                            Proceed to Authorise
                        </Button>
                    )}
                </>
            )}

            {step === 3 && (
                <Button variant="danger" onClick={hook.handleAuthorise} loading={hook.authorising} disabled={!hook.adminPassword.trim() || hook.authorising} type="button">
                    {!hook.authorising && <ArrowRightIcon className="w-4 h-4" />}
                    {hook.authorising ? "Verifying..." : "Proceed to Final Confirm"}
                </Button>
            )}

            {step === 4 && (
                <Button variant="danger" onClick={hook.handleExecutePurge} disabled={!hook.canExecutePurge} type="button" aria-label="Execute purge">
                    <FontAwesomeIcon icon={faDatabase} className="w-3.5 h-3.5" />
                    Execute Purge
                </Button>
            )}
        </>
    );
}

export default PurgeStepperModal;
