/**
 * @fileoverview Integrity Center view — orchestrator (SUPER_ADMIN only).
 * Presentation only; all state/logic live in integrity.hook.js. Never imports
 * integrity.api.js (three-layer rule).
 *
 * Layout: header → Tabs (one per table in the backend registry) →
 * IntegrityTablePanel (driven by the hook's active table). Wrapped in ErrorBoundary.
 */

import { ANIMATE_PAGE_ENTER } from "../../../assets/styles/pre-set-styles";
import ApiErrorAlert from "../../../components/feedback/ApiErrorAlert";
import ErrorBoundary from "../../../components/feedback/ErrorBoundary";
import Alert from "../../../components/ui/Alert";
import { Tabs } from "../../../components/ui/Tabs";
import IntegrityTablePanel from "./components/IntegrityTablePanel";
import { useIntegrity } from "./integrity.hook";

function IntegrityCenterView() {
    const hook = useIntegrity();

    // Same panel instance for every tab — Tabs renders only the active one.
    const tabs = hook.tabs.map((t) => ({ id: t.id, label: t.label, content: <IntegrityTablePanel hook={hook} /> }));

    return (
        <div className={`p-6 flex flex-col gap-4 h-full ${ANIMATE_PAGE_ENTER}`}>
            <div className="flex flex-col gap-1">
                <h1 className="text-xl font-aumovio-bold text-black dark:text-white tracking-tight">Data Integrity</h1>
                <p className="text-sm text-black/60 dark:text-white/60 mt-1">Per-table HMAC tamper monitoring for every registered table. Tampered-only by default; switch to Show all rows for the full scoped data with per-row verdicts. Live tables stream new rows.</p>
            </div>

            <ApiErrorAlert error={hook.apiError} onDismiss={() => hook.setApiError(null)} />

            {!hook.catalogLoading && tabs.length === 0 ? (
                <Alert variant="info" title="No tables registered">
                    Register a table in the backend integrity registry (Backend/src/models/integrity.model.js) to monitor it here.
                </Alert>
            ) : (
                <Tabs tabs={tabs} activeTab={hook.activeTab ?? undefined} onChange={hook.handleTabChange} variant="pill" size="md" />
            )}
        </div>
    );
}

/**
 * Public default export — wraps the view in an ErrorBoundary.
 * @returns {JSX.Element}
 */
export default function IntegrityCenterViewWrapped() {
    return (
        <ErrorBoundary>
            <IntegrityCenterView />
        </ErrorBoundary>
    );
}
