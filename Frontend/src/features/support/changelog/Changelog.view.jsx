/**
 * Changelog.view.jsx — Version History page (date-wise journey).
 *
 * The page no longer dumps every release into one scroll. A right-hand rail
 * lists every release DATE newest-first; picking one swaps the panel beside
 * it to just that day's entries. The selected date is mirrored into the
 * `?date=YYYY-MM-DD` query param so a specific day is linkable.
 *
 * SUPER_ADMIN users see Add / Edit / Delete controls and the Release Control.
 */

import { faPlus } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";

import ApiErrorAlert from "../../../components/feedback/ApiErrorAlert";
import { ErrorBoundary } from "../../../components/feedback/ErrorBoundary";
import Button from "../../../components/ui/Button";
import { Modal } from "../../../components/ui/Modal";

import { ANIMATE_FADE_IN_UP, ANIMATE_PAGE_ENTER, ANIM_DELAY_0, BASE_COLOR_TEXT, GRADIENT_COLOR_TEXT, TITLE_COLOR_TEXT } from "../../../assets/styles/pre-set-styles";

import { ChangelogForm } from "./components/ChangelogForm";
import { DateJourneyNav } from "./components/DateJourneyNav";
import { DateJourneyPanel } from "./components/DateJourneyPanel";
import { ReleaseControl } from "./components/ReleaseControl";
import { useChangelog } from "./changelog.hook";

function ChangelogContent() {
    const hook = useChangelog();

    return (
        <div className="p-4 md:p-6 font-aumovio space-y-8">
            {/* ── Header ──────────────────────────────────────────────────── */}
            <div className={`flex flex-wrap items-start justify-between gap-4 ${ANIMATE_FADE_IN_UP} ${ANIM_DELAY_0}`}>
                <div>
                    <h1 className={`text-3xl font-extrabold ${TITLE_COLOR_TEXT}`}>
                        Version <span className={GRADIENT_COLOR_TEXT}>History</span>
                    </h1>
                    <p className={`mt-1 text-sm ${BASE_COLOR_TEXT} opacity-70`}>What&apos;s changed in this release</p>
                </div>
                {hook.isSuperAdmin && (
                    <Button variant="primary" size="sm" onClick={hook.openCreate} disabled={!hook.releaseState?.drafts?.content}>
                        <FontAwesomeIcon icon={faPlus} className="mr-1.5 w-3.5 h-3.5" />
                        New Entry
                    </Button>
                )}
            </div>

            {/* View-level API error — suppressed while any modal is open (modal renders its own) */}
            {!hook.createOpen && !hook.editTarget && !hook.deleteTarget && <ApiErrorAlert error={hook.apiError} onDismiss={() => hook.setApiError(null)} />}

            {/* ── Release control (SUPER_ADMIN) ────────────────────────────── */}
            <ReleaseControl hook={hook} />

            {/* ── Journey: rail (right on desktop) + selected-date panel ────── */}
            {/* DOM order is nav-then-panel so the mobile stack reads "browse,   */}
            {/* then read"; flex-row-reverse flips it to panel-left on desktop.  */}
            <div className="flex flex-col lg:flex-row-reverse lg:items-start gap-4 lg:gap-8">
                <DateJourneyNav hook={hook} />
                <div className="flex-1 min-w-0">
                    <DateJourneyPanel hook={hook} />
                </div>
            </div>

            {/* The "N releases across M dates" tally lives in the rail header —
                it is the rail's own summary, so the page does not repeat it. */}

            {/* ── Create modal ─────────────────────────────────────────────── */}
            <Modal
                open={hook.createOpen}
                onClose={hook.closeCreate}
                title="New Changelog Entry"
                footer={
                    <>
                        <Button variant="ghost" onClick={hook.closeCreate} disabled={hook.saving}>
                            Cancel
                        </Button>
                        <Button variant="primary" loading={hook.saving} onClick={hook.handleCreate}>
                            Create Entry
                        </Button>
                    </>
                }
            >
                <ApiErrorAlert error={hook.apiError} onDismiss={() => hook.setApiError(null)} className="mb-4" />
                <ChangelogForm form={hook.form} onChange={hook.handleFormChange} />
            </Modal>

            {/* ── Edit modal ───────────────────────────────────────────────── */}
            <Modal
                open={!!hook.editTarget}
                onClose={hook.closeEdit}
                title="Edit Changelog Entry"
                footer={
                    <>
                        <Button variant="ghost" onClick={hook.closeEdit} disabled={hook.saving}>
                            Cancel
                        </Button>
                        <Button variant="primary" loading={hook.saving} onClick={hook.handleUpdate}>
                            Save Changes
                        </Button>
                    </>
                }
            >
                <ApiErrorAlert error={hook.apiError} onDismiss={() => hook.setApiError(null)} className="mb-4" />
                <ChangelogForm form={hook.form} onChange={hook.handleFormChange} />
            </Modal>

            {/* ── Delete confirm modal ─────────────────────────────────────── */}
            <Modal
                open={!!hook.deleteTarget}
                onClose={hook.closeDelete}
                title="Delete Entry"
                variant="danger"
                footer={
                    <>
                        <Button variant="ghost" onClick={hook.closeDelete} disabled={hook.deleting}>
                            Cancel
                        </Button>
                        <Button variant="danger" loading={hook.deleting} onClick={hook.handleDelete}>
                            Delete
                        </Button>
                    </>
                }
            >
                <ApiErrorAlert error={hook.apiError} onDismiss={() => hook.setApiError(null)} className="mb-4" />
                <p className={`text-sm ${BASE_COLOR_TEXT}`}>
                    Are you sure you want to permanently delete <span className="font-semibold">&ldquo;{hook.deleteTarget?.title}&rdquo;</span>? This action cannot be undone.
                </p>
            </Modal>
        </div>
    );
}

// ── Export ────────────────────────────────────────────────────────────────────

export default function ChangelogView() {
    return (
        <div className={ANIMATE_PAGE_ENTER}>
            <ErrorBoundary>
                <ChangelogContent />
            </ErrorBoundary>
        </div>
    );
}
