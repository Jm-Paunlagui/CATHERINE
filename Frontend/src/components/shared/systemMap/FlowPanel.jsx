/**
 * FlowPanel.jsx — the Flows tab: a list of flows, or one flow's step player.
 *
 * The numbered step list is also the accessible reading of a flow: everything
 * the animated diagram shows is here as text, in order. A flow's optional `ref`
 * (Runtime: the server-simulation stage that exercises it) shows as a badge.
 *
 * LAYOUT CONTRACT (with SystemMapView's rail): this component fills the rail's
 * remaining height. The player's title and controls are a pinned, non-scrolling
 * block; only the step list scrolls. Do not make the controls `sticky` inside a
 * scroller again — steps slid underneath them and the bar's flat background
 * clashed with the rail's gradient.
 */

import { useEffect, useRef } from "react";
import { LuChevronLeft, LuChevronRight, LuPause, LuPlay } from "react-icons/lu";
import { BASE_COLOR_TEXT, TRANSITION_COLORS } from "../../../assets/styles/pre-set-styles";
import { Badge } from "../../ui/Badge";
import Button from "../../ui/Button";

function FlowList({ hook }) {
    const { map, enterFlow } = hook;
    const categories = [...new Set(map.flows.map((f) => f.category))];
    return (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
            <p className={`text-sm ${BASE_COLOR_TEXT} opacity-70`}>Pick a flow to highlight its path on the diagram, then step through it.</p>
            {categories.map((c) => (
                <section key={c} className="mt-4">
                    <h3 className={`mb-1.5 text-[11px] font-aumovio-bold uppercase tracking-wider ${BASE_COLOR_TEXT} opacity-60`}>{c}</h3>
                    <ul className="space-y-1.5">
                        {map.flows
                            .filter((f) => f.category === c)
                            .map((f) => (
                                <li key={f.id}>
                                    <button type="button" onClick={() => enterFlow(f.id)} className={`w-full rounded-lg border border-(--color-card-surface-border) px-3 py-2 text-left hover:border-(--accent-icon) hover:bg-(--bg-surface-2) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent)/40 ${TRANSITION_COLORS}`}>
                                        <span className="flex items-center gap-2">
                                            <span className={`text-sm font-aumovio-bold ${BASE_COLOR_TEXT}`}>{f.name}</span>
                                            <span className={`ml-auto shrink-0 text-[11px] ${BASE_COLOR_TEXT} opacity-60`}>{f.steps.length} steps</span>
                                        </span>
                                        {f.ref && (
                                            <span className="mt-1 block">
                                                <Badge variant="blue" size="xs" pill>
                                                    {f.ref}
                                                </Badge>
                                            </span>
                                        )}
                                        <span className={`mt-0.5 block text-xs ${BASE_COLOR_TEXT} opacity-70 line-clamp-2`}>{f.summary}</span>
                                    </button>
                                </li>
                            ))}
                    </ul>
                </section>
            ))}
        </div>
    );
}

function FlowPlayer({ hook }) {
    const { flow, stepIdx, playing, nodeById, layerTone, goStep, nextStep, prevStep, togglePlay, showPath, clear } = hook;
    const listRef = useRef(null);

    // Keep the active step in view while stepping or playing. Smooth only when
    // the reader has not asked for reduced motion.
    useEffect(() => {
        if (stepIdx < 0) return;
        const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
        listRef.current?.querySelector(`[data-step="${stepIdx}"]`)?.scrollIntoView?.({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
    }, [stepIdx]);

    const nodeLabel = (id) => (
        <span style={{ color: layerTone[nodeById[id].layer].text }} className="font-aumovio-bold">
            {nodeById[id].label}
        </span>
    );

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            {/* ── Pinned: title + controls ─────────────────────────────── */}
            <div className="shrink-0 px-4">
                <button type="button" onClick={clear} className={`text-xs ${BASE_COLOR_TEXT} opacity-70 hover:opacity-100`}>
                    ← All flows
                </button>
                <p className="mt-2 text-[11px] font-aumovio-bold uppercase tracking-wider text-(--accent-foreground)">{flow.category}</p>
                <h2 className={`text-lg font-aumovio-bold leading-snug ${BASE_COLOR_TEXT}`}>{flow.name}</h2>
                {flow.ref && (
                    <span className="mt-1 inline-block">
                        <Badge variant="blue" size="xs" pill title="Where this flow is exercised">
                            {flow.ref}
                        </Badge>
                    </span>
                )}
                <p className={`mt-1 text-sm ${BASE_COLOR_TEXT} opacity-70`}>{flow.summary}</p>

                <div className="mt-3 flex items-center gap-1.5 border-b border-(--color-card-surface-border) pb-3">
                    <Button variant="outline" size="sm" onClick={prevStep} disabled={stepIdx <= 0} aria-label="Previous step" title="Previous step (←)" leftIcon={LuChevronLeft} />
                    <Button variant="primary" size="sm" onClick={togglePlay} aria-pressed={playing} title="Play / pause (Space)" leftIcon={playing ? LuPause : LuPlay} className="w-24">
                        {playing ? "Pause" : "Play"}
                    </Button>
                    <Button variant="outline" size="sm" onClick={nextStep} disabled={stepIdx >= flow.steps.length - 1} aria-label="Next step" title="Next step (→)" leftIcon={LuChevronRight} />
                    <span className={`ml-1 whitespace-nowrap text-xs tabular-nums ${BASE_COLOR_TEXT} opacity-70`} aria-live="polite">
                        {stepIdx < 0 ? `${flow.steps.length} steps` : `Step ${stepIdx + 1} / ${flow.steps.length}`}
                    </span>
                    <Button variant="link" size="xs" onClick={showPath} className="ml-auto whitespace-nowrap">
                        Show path
                    </Button>
                </div>
            </div>

            {/* ── Scrolling: the steps ─────────────────────────────────── */}
            <ol ref={listRef} aria-label={`${flow.name} — steps`} className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-4 pt-3 pb-20">
                {flow.steps.map((s, i) => {
                    const active = i === stepIdx;
                    return (
                        <li key={s.step}>
                            <button
                                type="button"
                                data-step={i}
                                aria-current={active ? "step" : undefined}
                                onClick={() => goStep(i)}
                                className={`flex w-full scroll-mt-3 scroll-mb-20 gap-3 rounded-lg border px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent)/40 ${TRANSITION_COLORS} ${active ? "border-(--accent-icon) bg-(--accent-subtle)" : "border-(--color-card-surface-border) hover:bg-(--bg-surface-2)"}`}
                            >
                                <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-aumovio-bold ${active ? "bg-(--accent-icon) text-(--on-accent-icon-text)" : "bg-(--bg-surface-3) text-(--text-primary)"}`}>{s.step}</span>
                                <span className="min-w-0">
                                    <span className={`block text-sm font-aumovio-bold ${BASE_COLOR_TEXT}`}>{s.action}</span>
                                    <span className="mt-0.5 block text-xs">
                                        {nodeLabel(s.from)} <span className={`${BASE_COLOR_TEXT} opacity-50`}>{s.reverse ? "⇠" : "→"}</span> {nodeLabel(s.to)}
                                    </span>
                                    {s.detail && <span className={`mt-1 block text-xs ${BASE_COLOR_TEXT} opacity-70`}>{s.detail}</span>}
                                </span>
                            </button>
                        </li>
                    );
                })}
            </ol>
        </div>
    );
}

export default function FlowPanel({ hook }) {
    return hook.flow ? <FlowPlayer hook={hook} /> : <FlowList hook={hook} />;
}
