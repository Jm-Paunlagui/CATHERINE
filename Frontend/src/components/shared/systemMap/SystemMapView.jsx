/**
 * SystemMapView.jsx — the shared page body for the Support system maps
 * (Architecture, Runtime): header with counts and Download JSON, the diagram,
 * and a Flows / Details rail (stacked below on mobile).
 *
 * Tier-3 shared: each feature view calls its own hook in one line and renders
 * `<SystemMapView hook={hook} … />`. Keyboard: ← / → step, Space play/pause,
 * Esc clear.
 */

import { useEffect } from "react";
import { ANIMATE_FADE_IN_UP, ANIM_DELAY_0, BASE_COLOR_BG, BASE_COLOR_TEXT, STANDARD_BORDER } from "../../../assets/styles/pre-set-styles";
import ErrorBoundary from "../../feedback/ErrorBoundary";
import { Alert } from "../../ui/Alert";
import { Badge } from "../../ui/Badge";
import Button from "../../ui/Button";
import { Skeleton } from "../../ui/Skeleton";
import { Tabs } from "../../ui/Tabs";
import "./systemMap.css";
import FlowPanel from "./FlowPanel";
import NodeDetails from "./NodeDetails";
import SystemMapCanvas from "./SystemMapCanvas";

/** Keyboard shortcuts. Ignored while typing in a field. */
function useShortcuts(hook) {
    const { flow, nextStep, prevStep, togglePlay, clear } = hook;
    useEffect(() => {
        const onKey = (e) => {
            if (e.target.closest?.("input, textarea, select, [contenteditable='true']")) {
                if (e.key === "Escape") e.target.blur?.();
                return;
            }
            if (e.key === "Escape") return clear();
            if (!flow) return;
            if (e.key === "ArrowRight") {
                e.preventDefault();
                nextStep();
            } else if (e.key === "ArrowLeft") {
                e.preventDefault();
                prevStep();
            } else if (e.key === " " && !e.target.closest?.("button")) {
                e.preventDefault();
                togglePlay();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [flow, nextStep, prevStep, togglePlay, clear]);
}

/**
 * @param {object} props
 * @param {object} props.hook      - from useSystemMap (via useArchitecture / useRuntime)
 * @param {string} props.title     - page heading
 * @param {string} props.subtitle  - one line under the heading
 * @param {string} props.noun      - what the map is called in loading/error copy, e.g. "architecture map"
 */
export function SystemMapView({ hook, title, subtitle, noun }) {
    useShortcuts(hook);
    const map = hook.map;

    const panelHeight = "lg:h-[calc(var(--app-scroll-h,100vh)-10rem)] lg:min-h-[520px]";

    return (
        <ErrorBoundary>
            <div className="p-4 md:p-6 flex flex-col gap-4 animate-page-enter">
                {/* ── Header ─────────────────────────────────────────────── */}
                <div className={`flex flex-wrap items-start justify-between gap-4 ${ANIMATE_FADE_IN_UP} ${ANIM_DELAY_0}`}>
                    <div>
                        <h1 className={`text-xl font-bold ${BASE_COLOR_TEXT}`}>{title}</h1>
                        <p className={`text-sm ${BASE_COLOR_TEXT} opacity-60`}>{subtitle}</p>
                    </div>
                    {map && (
                        <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="grey" size="xs" pill>
                                {map.nodes.length} nodes
                            </Badge>
                            <Badge variant="grey" size="xs" pill>
                                {map.edges.length} edges
                            </Badge>
                            <Badge variant="grey" size="xs" pill>
                                {map.flows.length} flows
                            </Badge>
                            {hook.endpointCount > 0 && (
                                <Badge variant="grey" size="xs" pill>
                                    {hook.endpointCount} endpoints
                                </Badge>
                            )}
                            <Badge variant="blue" size="xs" pill title="Date the map was last checked against the code">
                                Verified {map.meta.mapVerifiedAt}
                            </Badge>
                            <Button variant="outline" size="sm" onClick={hook.downloadJson} title="Nodes, edges and flows as JSON — for AI agents and tooling">
                                Download JSON
                            </Button>
                        </div>
                    )}
                </div>

                {hook.apiError && (
                    <Alert variant="danger" title={`Could not load the ${noun}`}>
                        {hook.apiError.message}
                    </Alert>
                )}

                {hook.loading && !map && (
                    <div role="status" aria-live="polite" aria-busy="true" className="flex flex-col lg:flex-row gap-4">
                        <span className="sr-only">Loading {noun}…</span>
                        <Skeleton className="h-[60vh] flex-1 rounded-2xl" />
                        <Skeleton className="h-[60vh] w-full lg:w-[400px] rounded-2xl" />
                    </div>
                )}

                {map && (
                    <div className="flex flex-col lg:flex-row gap-4">
                        <section aria-label="Diagram" className={`h-[62vh] min-h-[420px] flex-1 min-w-0 rounded-2xl ${STANDARD_BORDER} ${panelHeight}`}>
                            <SystemMapCanvas hook={hook} />
                        </section>

                        {/* Rail = a pinned region (tabs, and inside FlowPanel the flow
                            title + player controls) over ONE scrolling region. The
                            controls are never `sticky` inside the scroller, so no
                            step can slide underneath them and the tabs never
                            scroll away. Tabs renders the nav (its empty content
                            slot is the gap below it); the panel is rendered here
                            so it can take the remaining height. */}
                        <aside aria-label="Flows and details" className={`flex w-full lg:w-[400px] shrink-0 flex-col lg:overflow-hidden rounded-2xl ${BASE_COLOR_BG} ${STANDARD_BORDER} ${panelHeight}`}>
                            <div className="shrink-0 px-4 pt-4">
                                <Tabs
                                    variant="pill"
                                    fullWidth
                                    activeTab={hook.tab}
                                    onChange={hook.setTab}
                                    tabs={[
                                        { id: "flows", label: "Flows", badge: map.flows.length, content: null },
                                        { id: "details", label: "Details", content: null },
                                    ]}
                                />
                            </div>
                            <div className="flex min-h-0 flex-1 flex-col">
                                {hook.tab === "details" ? (
                                    <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
                                        <NodeDetails hook={hook} />
                                    </div>
                                ) : (
                                    <FlowPanel hook={hook} />
                                )}
                            </div>
                        </aside>
                    </div>
                )}
            </div>
        </ErrorBoundary>
    );
}

export default SystemMapView;
