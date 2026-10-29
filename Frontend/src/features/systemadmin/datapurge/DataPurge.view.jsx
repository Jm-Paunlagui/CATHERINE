/**
 * @fileoverview Data Purge & Restore view — orchestrator.
 * Presentation only; all state and logic live in datapurge.hook.js.
 * Never imports datapurge.api.js directly (three-layer rule).
 *
 * SUPER_ADMIN only (route-gated in App.jsx; the backend independently
 * enforces this on every endpoint via `requireSuperAdmin`).
 *
 * Tabs (Backup sits in the middle: least destructive, visited routinely):
 *   1. Purge   — group cards (PurgeScopeSelector) + the 5-step confirmation
 *                stepper (PurgeStepperModal).
 *   2. Backup  — archive list, "Back Up Now", download/verify/delete
 *                (BackupPanel).
 *   3. Restore — dropzone → dry-run preview report → confirm (RestorePanel).
 *
 * Wrapped in ErrorBoundary (default export).
 */

import { ANIMATE_PAGE_ENTER } from "../../../assets/styles/pre-set-styles";
import ErrorBoundary from "../../../components/feedback/ErrorBoundary";
import { Tabs } from "../../../components/ui/Tabs";
import { BackupPanel } from "./components/BackupPanel";
import { PurgeScopeSelector } from "./components/PurgeScopeSelector";
import { PurgeStepperModal } from "./components/PurgeStepperModal";
import { RestorePanel } from "./components/RestorePanel";
import { useDataPurge } from "./datapurge.hook";

// ─── Inner view (unwrapped) ───────────────────────────────────────────────────

/**
 * DataPurgeView — presentation layer for the Data Purge & Restore feature.
 *
 * Whole-hook pattern: one line, no destructuring at view level. Whole
 * hook object passed to each first-level tab/modal component.
 */
function DataPurgeView() {
    // Whole-hook pattern: single line, no destructuring at view level
    const hook = useDataPurge();

    const tabs = [
        {
            id: "purge",
            label: "Purge",
            content: <PurgeScopeSelector hook={hook} />,
        },
        {
            id: "backup",
            label: "Backup",
            content: <BackupPanel hook={hook} />,
        },
        {
            id: "restore",
            label: "Restore",
            content: <RestorePanel hook={hook} />,
        },
    ];

    return (
        <div className={`p-6 flex flex-col gap-4 h-full ${ANIMATE_PAGE_ENTER}`}>
            {/* Page header */}
            <div className="flex flex-col gap-1">
                <h1 className="text-xl font-aumovio-bold text-black dark:text-white tracking-tight">Data Purge, Backup &amp; Restore</h1>
                <p className="text-sm text-black/60 dark:text-white/60 mt-1">Manage scheduled database backups, permanently delete platform data with a mandatory backup, or restore from a previously downloaded archive.</p>
            </div>

            <Tabs tabs={tabs} activeTab={hook.activeTab} onChange={hook.handleTabChange} variant="pill" size="md" />

            {/* The purge confirmation stepper renders as a portal Modal — it
                only mounts DOM once hook.purgeModalOpen is true. */}
            <PurgeStepperModal hook={hook} />
        </div>
    );
}

// ─── Wrapped export (with ErrorBoundary) ─────────────────────────────────────

/**
 * Public default export for the Data Purge & Restore view.
 * Wraps DataPurgeView in an ErrorBoundary so unexpected render errors are
 * caught without crashing the host layout.
 *
 * @returns {JSX.Element}
 */
export default function DataPurgeViewWrapped() {
    return (
        <ErrorBoundary>
            <DataPurgeView />
        </ErrorBoundary>
    );
}
