/**
 * RevokeAdminModal.jsx — Access Control revoke/delete flow.
 *
 * Presentation only. Receives the whole `useAdminManagement()` hook object
 * via props — never imports adminmanagement.hook.js or adminmanagement.api.js
 * directly. Three steps:
 *
 *   1. Backup     — mandatory `.zip` download before either action unlocks.
 *                   Same gate idiom as `PurgeStepperModal` Step 2. The archive
 *                   contains this admin's password hash and integrity
 *                   signature — credential material, called out explicitly here.
 *   2. Choose Action — **Revoke Access is the primary, recommended action**
 *                   (deactivates, preserves the audit trail). **Delete
 *                   Permanently is secondary.** A failed action returns here
 *                   with the error shown; the same backup token still applies.
 *   3. Processing — spinner while the request is in flight, then the result.
 *
 * Security posture:
 *   - No dangerouslySetInnerHTML.
 *   - The backup-before-action gate here is UX only — the backend
 *     independently enforces it via the signed backup token (CWE-602),
 *     shared with the Data Purge & Restore `/backup` mechanism.
 *   - The SAME backup token authorises either action — one download covers both.
 */

import { faShieldHalved, faTrashCan } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { ArrowRightIcon, CheckCircleIcon, DocumentArrowDownIcon, LockClosedIcon } from "@heroicons/react/24/outline";
import { ANIMATE_BOUNCE_IN, ANIMATE_SCALE_IN } from "../../../../assets/styles/pre-set-styles";
import ApiErrorAlert from "../../../../components/feedback/ApiErrorAlert";
import Alert from "../../../../components/ui/Alert";
import Button from "../../../../components/ui/Button";
import { Modal } from "../../../../components/ui/Modal";
import Spinner from "../../../../components/ui/Spinner";
import Stepper from "../../../../components/ui/Stepper";
import { formatDateTime } from "../../../../utils/formatters";

const STEPS = [
    { id: "backup", label: "Backup" },
    { id: "action", label: "Choose Action" },
    { id: "processing", label: "Processing" },
];

/**
 * @param {object} props
 * @param {object} props.hook - Full `useAdminManagement()` hook object.
 */
export function RevokeAdminModal({ hook }) {
    if (!hook.revokeModalOpen || !hook.targetAdmin) return null;

    const stepperCurrent = hook.revokeStep - 1; // Stepper is 0-based

    return (
        <Modal open={hook.revokeModalOpen} onClose={hook.closeRevokeModal} title={`Remove Access — ${hook.targetAdmin.username}`} size="xl" variant="danger" footer={<StepFooter hook={hook} />}>
            <div className="mb-5">
                <Stepper steps={STEPS} current={stepperCurrent} variant="numbered" orientation="horizontal" />
            </div>

            {hook.revokeStep === 1 && <StepBackup hook={hook} />}
            {hook.revokeStep === 2 && <StepAction hook={hook} />}
            {hook.revokeStep === 3 && <StepProcessing hook={hook} />}
        </Modal>
    );
}

// ─── Step 1 — Backup ──────────────────────────────────────────────────────────

function StepBackup({ hook }) {
    const admin = hook.targetAdmin;

    return (
        <div className={`space-y-4 ${ANIMATE_SCALE_IN}`}>
            <Alert variant="warning" title="Download required before revoking or deleting">
                <p className="text-sm mt-1">A full backup of this admin's record and activity history must be downloaded first. You cannot proceed to either action until the download completes. This is a UX gate — the server independently refuses to revoke or delete without a valid backup token.</p>
            </Alert>

            <div className="p-4 rounded-xl bg-grey-50 dark:bg-(--bg-surface-3) border border-grey-200 dark:border-grey-700 space-y-1 text-sm">
                <p className="font-aumovio-bold text-black/80 dark:text-white/80">{admin.firstName || admin.lastName ? `${admin.firstName ?? ""} ${admin.lastName ?? ""}`.trim() : "No profile name"}</p>
                <p className="text-black/50 dark:text-white/50">
                    Username: {admin.username} &middot; Role: {admin.role}
                </p>
            </div>

            <div className="p-3 rounded-lg bg-danger-100/40 dark:bg-danger-400/10 border border-danger-400/25 flex items-start gap-3">
                <LockClosedIcon className="w-4 h-4 mt-1 text-danger-400 shrink-0" />
                <p className="text-xs text-danger-600 dark:text-danger-300">
                    This archive contains this admin's <span className="font-aumovio-bold">password hash (argon2)</span> and <span className="font-aumovio-bold">integrity signature</span> — treat it as credential material. Never share, log, or email it. Upload it only to the Data Purge &amp; Restore restore flow if recovery is ever needed.
                </p>
            </div>

            {hook.revokeBackupError && <ApiErrorAlert error={hook.revokeBackupError} onDismiss={() => {}} />}

            {hook.revokeBackupDownloaded && (
                <div className={`flex flex-col gap-1 text-success-400 text-sm font-aumovio-bold ${ANIMATE_BOUNCE_IN}`}>
                    <span className="flex items-center gap-2">
                        <CheckCircleIcon className="w-5 h-5 shrink-0" />
                        Backup archive downloaded. You may now choose an action.
                    </span>
                    {hook.revokeBackupTokenExpiresAt && <span className="text-xs font-normal text-black/50 dark:text-white/50 ml-7">Backup token valid until {formatDateTime(hook.revokeBackupTokenExpiresAt)}.</span>}
                </div>
            )}

            {hook.revokeBackupDownloading && (
                <div className="flex items-center gap-2 text-sm text-(--accent-foreground)">
                    <Spinner size="xs" />
                    <span>Building the backup archive...</span>
                </div>
            )}
        </div>
    );
}

// ─── Step 2 — Choose Action ───────────────────────────────────────────────────

function StepAction({ hook }) {
    const admin = hook.targetAdmin;

    return (
        <div className={`space-y-4 ${ANIMATE_SCALE_IN}`}>
            {hook.revokeActionError && (
                <Alert variant="danger" title="Action failed">
                    <p className="text-sm mt-1">{hook.revokeActionError.message}</p>
                </Alert>
            )}

            {/* Revoke — PRIMARY action */}
            <div className="p-4 rounded-xl border-2 border-(--accent-icon)/40 bg-orange-50/40 dark:bg-orange-400/5 space-y-2">
                <div className="flex items-center gap-2">
                    <FontAwesomeIcon icon={faShieldHalved} className="text-(--accent-icon)" />
                    <p className="text-sm font-aumovio-bold text-black/85 dark:text-white/85">Revoke Access — recommended</p>
                </div>
                <p className="text-xs text-black/60 dark:text-white/60">Deactivates {admin.username} immediately (login and token refresh both blocked) and clears every permission flag. The audit trail is preserved untouched. This is the default way access is removed.</p>
            </div>

            {/* Delete — SECONDARY / edge-case action */}
            <div className="p-3 rounded-lg border border-grey-200 dark:border-grey-700 space-y-2">
                <div className="flex items-center gap-2">
                    <FontAwesomeIcon icon={faTrashCan} className="text-grey-400" />
                    <p className="text-xs font-aumovio-bold text-black/60 dark:text-white/60">Delete Permanently — advanced, edge case</p>
                </div>
                <p className="text-xs text-black/40 dark:text-white/40">Removes {admin.username}'s admin record for good. Use this only for an admin created by mistake and never used.</p>
            </div>
        </div>
    );
}

// ─── Step 3 — Processing ──────────────────────────────────────────────────────

function StepProcessing({ hook }) {
    if (hook.revokeActionLoading) {
        return (
            <div className={`flex flex-col items-center justify-center gap-4 py-8 ${ANIMATE_SCALE_IN}`}>
                <Spinner size="lg" />
                <p className="text-sm text-black/60 dark:text-white/60">{hook.revokeIntent === "delete" ? "Deleting admin record..." : "Revoking access..."}</p>
                <p className="text-xs text-black/40 dark:text-white/40">Do not close this window.</p>
            </div>
        );
    }

    if (hook.revokeActionResult) {
        const isDelete = hook.revokeActionResult.intent === "delete";
        return (
            <div className={`flex flex-col items-center justify-center gap-4 py-8 ${ANIMATE_BOUNCE_IN}`}>
                <CheckCircleIcon className="w-14 h-14 text-success-400" />
                <p className="text-sm font-aumovio-bold text-black/85 dark:text-white/85">{isDelete ? "Admin record permanently deleted." : "Access revoked successfully."}</p>
                <p className="text-xs text-black/40 dark:text-white/40 text-center max-w-xs">{isDelete ? "The record has been removed from the admin table." : "IS_ACTIVE and every permission flag are now 'N'. Login and token refresh are both blocked immediately."}</p>
            </div>
        );
    }

    return null;
}

// ─── Step Footer ──────────────────────────────────────────────────────────────

function StepFooter({ hook }) {
    const step = hook.revokeStep;

    return (
        <>
            {!(step === 3 && hook.revokeActionLoading) && (
                <Button variant="ghost" onClick={hook.closeRevokeModal} type="button">
                    {step === 3 ? "Close" : "Cancel"}
                </Button>
            )}

            {step === 1 && (
                <>
                    <Button variant="warning" onClick={hook.handleDownloadRevokeBackup} loading={hook.revokeBackupDownloading} disabled={hook.revokeBackupDownloading} type="button">
                        {!hook.revokeBackupDownloading && <DocumentArrowDownIcon className="w-4 h-4" />}
                        {hook.revokeBackupDownloading ? "Downloading..." : hook.revokeBackupDownloaded ? "Download Again" : "Download Backup"}
                    </Button>
                    {hook.revokeBackupDownloaded && (
                        <Button variant="danger" onClick={() => hook.advanceRevokeStep(2)} type="button">
                            <ArrowRightIcon className="w-4 h-4" />
                            Continue
                        </Button>
                    )}
                </>
            )}

            {step === 2 && (
                <>
                    {/* Visible text is self-describing — no aria-label override. */}
                    <Button variant="ghost" onClick={hook.confirmDeletePermanently} type="button">
                        <FontAwesomeIcon icon={faTrashCan} className="w-3.5 h-3.5 mr-1.5" />
                        Delete Permanently
                    </Button>
                    <Button variant="primary" onClick={hook.confirmRevokeAccess} type="button">
                        <FontAwesomeIcon icon={faShieldHalved} className="w-3.5 h-3.5 mr-1.5" />
                        Revoke Access
                    </Button>
                </>
            )}
        </>
    );
}

export default RevokeAdminModal;
