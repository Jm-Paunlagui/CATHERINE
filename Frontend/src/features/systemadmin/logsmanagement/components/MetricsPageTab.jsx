/**
 * @fileoverview Metrics page tab — "show me the numbers". Consolidates the live
 * in-process metrics into one place with a single level of sub-tabs:
 *   RED · System · Dependencies · Frontend Vitals · Alerts
 * This replaces the previous nested-tabs-inside-a-section layout.
 */

import { Tabs } from "../../../../components/ui/Tabs";
import AlertsTab from "../../metrics/components/AlertsTab";
import RedMetricsTab from "../../metrics/components/RedMetricsTab";
import SystemTab from "../../metrics/components/SystemTab";
import DependenciesTab from "./DependenciesTab";
import FrontendVitalsTab from "./FrontendVitalsTab";

/**
 * @param {{ hook: import('../../metrics/metrics.hook').MetricsHook, onViewLogs?: (route: string) => void }} props
 */
export default function MetricsPageTab({ hook, onViewLogs }) {
    const alertCount = hook.alerts?.length ?? 0;

    const tabs = [
        { id: "red", label: "RED Metrics", content: <RedMetricsTab hook={hook} /> },
        { id: "system", label: "System", content: <SystemTab hook={hook} /> },
        { id: "dependencies", label: "Dependencies", content: <DependenciesTab hook={hook} /> },
        { id: "vitals", label: "Frontend Vitals", content: <FrontendVitalsTab hook={hook} /> },
        { id: "alerts", label: alertCount > 0 ? `Alerts (${alertCount})` : "Alerts", content: <AlertsTab hook={hook} onViewLogs={onViewLogs} /> },
    ];

    return <Tabs tabs={tabs} variant="pill" size="sm" defaultTab="red" />;
}
