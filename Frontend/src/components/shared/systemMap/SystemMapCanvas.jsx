/**
 * SystemMapCanvas.jsx — the interactive SVG diagram for a system map.
 *
 * The camera (pan/zoom) lives in refs and is written straight to the viewport
 * `<g>`'s transform, so dragging and wheel-zooming never re-render the diagram (~320 nodes and edges, 1,000+ SVG
 * elements) per frame. React state here is limited to what changes what is
 * drawn: the hovered node and the hovered edge's tooltip.
 *
 * Colours: surfaces and text use the theme's CSS variables, so the diagram
 * follows light/dark like the rest of the app. Layer and edge-kind tones come
 * from systemMapTones.js (`tonesById`, resolved in useSystemMap as `layerTone` /
 * `kindTone`); the map API's own hex values are never painted. The tones are
 * categorical, not semantic.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Button from "../../ui/Button";
import { SearchBar } from "../../ui/SearchBar";
import { NODE_H, NODE_W, bboxOf, computeHighlight, edgeGeometry, stepBadges } from "./systemMapLayout";

const MIN_K = 0.15;
const MAX_K = 3;
/** Hover is ignored this long after a camera move, so a node that slides under a still cursor does not steal the highlight. */
const HOVER_LOCK_MS = 250;


export default function SystemMapCanvas({ hook }) {
    const { map, geometry, layerById, layerTone, kindTone, adj, nodeById, flow, stepIdx, selectedId, matches, hiddenLayers, focus, search, setSearch, focusMatches, toggleLayer, selectNode, clear, fitAll } = hook;
    const { pos, world, regions } = geometry;

    const wrapRef = useRef(null);
    const svgRef = useRef(null);
    const vpRef = useRef(null);
    const toolbarRef = useRef(null);
    const legendRef = useRef(null);
    const cam = useRef({ x: 0, y: 0, k: 1 });
    const anim = useRef(0);
    const hoverLockUntil = useRef(0);
    const drag = useRef(null);

    const [hoverId, setHoverId] = useState(null);
    const [edgeTip, setEdgeTip] = useState(null);

    const geometryById = useMemo(() => Object.fromEntries(map.edges.map((e) => [e.id, edgeGeometry(e, pos)])), [map.edges, pos]);
    const matchSet = useMemo(() => new Set(matches), [matches]);
    const isHidden = useCallback((nodeIdOrEdge) => hiddenLayers.has(nodeById[nodeIdOrEdge]?.layer), [hiddenLayers, nodeById]);

    const hl = useMemo(
        () => computeHighlight({ adj, edges: map.edges, flow, stepIdx, focusId: flow ? null : hoverId ?? selectedId }),
        [adj, map.edges, flow, stepIdx, hoverId, selectedId],
    );
    const badges = useMemo(() => stepBadges(flow, geometryById), [flow, geometryById]);

    // ── Camera ───────────────────────────────────────────────────────────────
    const apply = useCallback(() => {
        const { x, y, k } = cam.current;
        vpRef.current?.setAttribute("transform", `translate(${x},${y}) scale(${k})`);
    }, []);

    const viewport = useCallback(() => {
        const r = svgRef.current?.getBoundingClientRect();
        if (!r || r.width <= 0 || r.height <= 0) return null;
        const top = toolbarRef.current ? toolbarRef.current.getBoundingClientRect().bottom - r.top + 8 : 12;
        const lg = legendRef.current;
        const bottom = lg && lg.offsetParent ? r.bottom - lg.getBoundingClientRect().top + 8 : 12;
        return { w: r.width, h: r.height, top, bottom };
    }, []);

    const tweenTo = useCallback(
        (next, ms = 380) => {
            cancelAnimationFrame(anim.current);
            const from = { ...cam.current };
            hoverLockUntil.current = performance.now() + ms + HOVER_LOCK_MS;
            // One clock only: progress is measured from the FIRST frame's rAF
            // timestamp, never from performance.now(). Mixing them made progress negative whenever the
            // rAF clock was behind (a browser's frame-start time; jsdom by ~1 s), and the ease-out then
            // threw the camera the opposite way first (zoom went negative: a mirrored, huge map).
            let t0 = null;
            const step = (now) => {
                if (t0 === null) t0 = now;
                const p = Math.min(1, Math.max(0, (now - t0) / ms));
                const e = 1 - (1 - p) ** 3;
                cam.current = { x: from.x + (next.x - from.x) * e, y: from.y + (next.y - from.y) * e, k: from.k + (next.k - from.k) * e };
                apply();
                if (p < 1) anim.current = requestAnimationFrame(step);
            };
            anim.current = requestAnimationFrame(step);
        },
        [apply],
    );

    const fitBox = useCallback(
        (b, { maxK = 1.35, pad = 24, animate = true } = {}) => {
            const v = viewport();
            if (!v || !b) return;
            const avail = v.h - v.top - v.bottom;
            const k = Math.max(MIN_K, Math.min(maxK, (v.w - pad * 2) / b.w, avail / b.h));
            const next = { k, x: (v.w - b.w * k) / 2 - b.x * k, y: v.top + (avail - b.h * k) / 2 - b.y * k };
            if (animate) tweenTo(next);
            else {
                cam.current = next;
                apply();
            }
        },
        [viewport, tweenTo, apply],
    );

    /** Move only if the box is not already fully on screen; never zoom in. */
    const ensureVisible = useCallback(
        (b) => {
            const v = viewport();
            if (!v || !b) return;
            const { x, y, k } = cam.current;
            const vx0 = -x / k;
            const vy0 = (v.top - y) / k;
            const vx1 = (v.w - x) / k;
            const vy1 = (v.h - v.bottom - y) / k;
            if (b.x >= vx0 && b.y >= vy0 && b.x + b.w <= vx1 && b.y + b.h <= vy1) return;
            const avail = v.h - v.top - v.bottom;
            const nk = Math.max(MIN_K, Math.min(k, (v.w - 48) / b.w, avail / b.h));
            tweenTo({ k: nk, x: v.w / 2 - (b.x + b.w / 2) * nk, y: v.top + avail / 2 - (b.y + b.h / 2) * nk });
        },
        [viewport, tweenTo],
    );

    const worldBox = useMemo(() => ({ x: 0, y: 0, w: world.w, h: world.h }), [world]);

    // React to camera requests from the hook. With no request yet, show
    // everything without animating — this is the first paint.
    // useLayoutEffect, not useEffect: the camera transform is written straight to
    // the DOM, so it must land before paint. A passive effect ran after paint, and the first frame
    // showed the diagram unframed (0,0 at scale 1) before jumping to the fit.
    const focusKey = focus?.key ?? null;
    useLayoutEffect(() => {
        if (!focus) return fitBox(worldBox, { maxK: 1.2, pad: 12, animate: false });
        if (focus.mode === "all") return fitBox(worldBox, { maxK: 1.2, pad: 12 });
        const b = bboxOf(focus.ids, pos);
        if (focus.mode === "ensure") ensureVisible(b);
        else fitBox(b, { maxK: 1.15 });
        // focus is read through its key: a new key is a new request.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [focusKey, pos, worldBox, fitBox, ensureVisible]);

    useEffect(() => () => cancelAnimationFrame(anim.current), []);

    const zoomAt = useCallback(
        (factor, cx, cy) => {
            cancelAnimationFrame(anim.current);
            const { x, y, k } = cam.current;
            const nk = Math.max(MIN_K, Math.min(MAX_K, k * factor));
            const r = nk / k;
            cam.current = { k: nk, x: cx - (cx - x) * r, y: cy - (cy - y) * r };
            apply();
        },
        [apply],
    );

    const zoomCentre = (factor) => {
        const v = viewport();
        if (v) zoomAt(factor, v.w / 2, v.h / 2);
    };

    // Wheel must be non-passive to stop the page scrolling under the diagram.
    useEffect(() => {
        const svg = svgRef.current;
        if (!svg) return undefined;
        const onWheel = (e) => {
            e.preventDefault();
            const r = svg.getBoundingClientRect();
            zoomAt(Math.exp(-e.deltaY * 0.0016), e.clientX - r.left, e.clientY - r.top);
        };
        svg.addEventListener("wheel", onWheel, { passive: false });
        return () => svg.removeEventListener("wheel", onWheel);
    }, [zoomAt]);

    const onPointerDown = (e) => {
        if (e.target.closest?.("[data-node]")) return;
        cancelAnimationFrame(anim.current);
        drag.current = { x: e.clientX, y: e.clientY, cx: cam.current.x, cy: cam.current.y, moved: false };
        svgRef.current?.setPointerCapture?.(e.pointerId);
    };
    const onPointerMove = (e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.x;
        const dy = e.clientY - d.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
        cam.current = { ...cam.current, x: d.cx + dx, y: d.cy + dy };
        apply();
    };
    const onPointerUp = (e) => {
        const d = drag.current;
        drag.current = null;
        // A click on empty canvas clears a node focus. It deliberately does NOT
        // leave a flow: stepping through a flow while panning around it would
        // otherwise lose the flow on every stray click.
        if (d && !d.moved && !flow && !e.target.closest?.("[data-node]")) clear();
    };

    const onNodeEnter = (id) => {
        if (performance.now() < hoverLockUntil.current) return;
        setHoverId(id);
    };

    const onEdgeMove = (e, edge) => {
        const r = wrapRef.current?.getBoundingClientRect();
        if (!r) return;
        setEdgeTip({ edge, x: e.clientX - r.left + 14, y: e.clientY - r.top + 14 });
    };

    const current = hl.current;
    const kinds = map.edgeKinds;

    return (
        <div ref={wrapRef} className="smap-canvas relative h-full w-full overflow-hidden rounded-2xl">
            {/* ── Toolbar ─────────────────────────────────────────────────── */}
            <div ref={toolbarRef} className="absolute top-3 left-3 right-3 z-10 flex flex-wrap items-center gap-2 pointer-events-none">
                <form
                    className="pointer-events-auto w-56 sm:w-72"
                    role="search"
                    onSubmit={(e) => {
                        e.preventDefault();
                        focusMatches();
                    }}
                >
                    <SearchBar value={search} onChange={setSearch} onClear={() => setSearch("")} placeholder="Search nodes, files, endpoints…" />
                </form>
                <div className="pointer-events-auto flex items-center gap-1 rounded-lg border border-(--color-card-surface-border) bg-(--bg-surface) p-1 shadow-sm">
                    <Button variant="ghost" size="xs" onClick={() => zoomCentre(0.8)} aria-label="Zoom out">
                        −
                    </Button>
                    <Button variant="ghost" size="xs" onClick={() => zoomCentre(1.25)} aria-label="Zoom in">
                        +
                    </Button>
                    <Button variant="ghost" size="xs" onClick={fitAll}>
                        Fit
                    </Button>
                    <Button variant="ghost" size="xs" onClick={clear} title="Clear selection (Esc)">
                        Clear
                    </Button>
                </div>
                <div className="pointer-events-auto hidden md:flex flex-wrap gap-1 rounded-lg border border-(--color-card-surface-border) bg-(--bg-surface) p-1 shadow-sm" role="group" aria-label="Layers">
                    {map.layers.map((l) => {
                        const off = hiddenLayers.has(l.id);
                        return (
                            <button
                                key={l.id}
                                type="button"
                                aria-pressed={!off}
                                title={l.description}
                                onClick={() => toggleLayer(l.id)}
                                className={`flex h-7 items-center gap-1.5 rounded px-2 text-[11px] font-aumovio-bold text-(--text-primary) hover:bg-(--bg-surface-2) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent)/40 ${off ? "opacity-40 line-through" : ""}`}
                            >
                                <span className="h-2 w-2 rounded-full" style={{ background: layerTone[l.id].fill }} />
                                {l.label.split(" ·")[0]}
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* ── Diagram ─────────────────────────────────────────────────── */}
            <svg
                ref={svgRef}
                className="smap-svg block h-full w-full touch-none"
                role="group"
                aria-label={`${map.meta?.title ?? "System"} diagram`}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
            >
                <defs>
                    {Object.keys(kinds).map((k) => (
                        <marker key={k} id={`smap-m-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                            <path d="M0,0 L10,5 L0,10 z" style={{ fill: kindTone[k].text }} />
                        </marker>
                    ))}
                    <marker id="smap-m-cur" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                        <path d="M0,0 L10,5 L0,10 z" className="smap-cur-fill" />
                    </marker>
                </defs>

                <g ref={vpRef}>
                    {regions.map((r) =>
                        hiddenLayers.has(r.layer) ? null : (
                            <g key={`${r.layer}-${r.y}`}>
                                <rect x={r.x} y={r.y} width={r.w} height={r.h} rx="14" fillOpacity="0.05" strokeOpacity="0.35" style={{ fill: layerTone[r.layer].fill, stroke: layerTone[r.layer].fill }} />
                                <text x={r.labelX} y={r.labelY} fontSize="12" fontWeight="700" letterSpacing=".06em" style={{ fill: layerTone[r.layer].text }}>
                                    {layerById[r.layer].label.toUpperCase()}
                                </text>
                            </g>
                        ),
                    )}

                    {map.edges.map((e) => {
                        if (isHidden(e.source) || isHidden(e.target)) return null;
                        const state = hl.edgeState.get(e.id);
                        return (
                            <path
                                key={e.id}
                                d={geometryById[e.id].d}
                                className={`smap-edge ${state ? `is-${state}` : ""}`}
                                style={{ stroke: kindTone[e.kind].text, strokeDasharray: kindTone[e.kind].dashed ? "5 3" : undefined }}
                                markerEnd={`url(#smap-m-${e.kind})`}
                                data-edge={e.id}
                            />
                        );
                    })}

                    {/* The current step is redrawn on top so it is never under another edge. */}
                    {current && geometryById[current.edge] && (
                        <path d={geometryById[current.edge].d} className={`smap-edge-cur ${current.reverse ? "is-rev" : ""}`} markerEnd="url(#smap-m-cur)" />
                    )}

                    {map.edges.map((e) =>
                        isHidden(e.source) || isHidden(e.target) ? null : (
                            <path key={`hit-${e.id}`} d={geometryById[e.id].d} className="smap-edge-hit" onMouseMove={(ev) => onEdgeMove(ev, e)} onMouseLeave={() => setEdgeTip(null)} />
                        ),
                    )}

                    {map.nodes.map((n) => {
                        if (hiddenLayers.has(n.layer)) return null;
                        const p = pos[n.id];
                        const tone = layerTone[n.layer];
                        const cls = [
                            "smap-node",
                            hl.dimNodes.has(n.id) && "is-dim",
                            n.id === selectedId && "is-sel",
                            hl.curNodes.has(n.id) && "is-cur",
                            matchSet.has(n.id) && "is-match",
                        ]
                            .filter(Boolean)
                            .join(" ");
                        return (
                            <g
                                key={n.id}
                                data-node={n.id}
                                className={cls}
                                transform={`translate(${p.x},${p.y})`}
                                role="button"
                                tabIndex={0}
                                aria-label={`${n.label} — ${layerById[n.layer].label}`}
                                aria-pressed={n.id === selectedId}
                                onClick={(ev) => {
                                    ev.stopPropagation();
                                    selectNode(n.id);
                                }}
                                onKeyDown={(ev) => {
                                    if (ev.key === "Enter" || ev.key === " ") {
                                        ev.preventDefault();
                                        selectNode(n.id);
                                    }
                                }}
                                onMouseEnter={() => onNodeEnter(n.id)}
                                onMouseLeave={() => setHoverId(null)}
                            >
                                <title>{n.subtitle ? `${n.label} — ${n.subtitle}` : n.label}</title>
                                <rect className="smap-node-body" width={NODE_W} height={NODE_H} rx="9" style={{ stroke: tone.text }} />
                                <rect width={NODE_W} height={NODE_H} rx="9" fillOpacity="0.08" pointerEvents="none" style={{ fill: tone.fill }} />
                                <rect x="0" y="8" width="3" height={NODE_H - 16} rx="1.5" style={{ fill: tone.fill }} />
                                {/* HTML inside foreignObject so CSS ellipsis clips at the
                                    card's real width in whatever font renders — a character
                                    count cannot (glyph widths vary), and text ran past the edge.
                                    The full text is in the node's <title> (hover) and aria-label. */}
                                <foreignObject x="12" y="6" width={NODE_W - 20} height={NODE_H - 12} pointerEvents="none">
                                    <div className="smap-node-text">
                                        <div className="smap-node-label" style={n.endpoints?.length > 0 ? { paddingRight: 26 } : undefined}>
                                            {n.label}
                                        </div>
                                        <div className="smap-node-sub">{n.subtitle}</div>
                                    </div>
                                </foreignObject>
                                {n.endpoints?.length > 0 && (
                                    <g>
                                        <rect x={NODE_W - 30} y="6" width="24" height="14" rx="7" fillOpacity="0.18" style={{ fill: tone.fill }} />
                                        <text x={NODE_W - 18} y="16.5" textAnchor="middle" fontSize="9.5" fontWeight="700" style={{ fill: tone.text }}>
                                            {n.endpoints.length}
                                        </text>
                                    </g>
                                )}
                            </g>
                        );
                    })}

                    {badges.map((b) => (
                        <g key={`${b.edge}-${b.index}`} className={`smap-badge ${b.index === stepIdx ? "is-cur" : ""}`} transform={`translate(${b.x},${b.y})`} pointerEvents="none">
                            <circle r="9.5" strokeWidth="1.6" style={{ stroke: kindTone[map.edges.find((e) => e.id === b.edge)?.kind]?.text }} />
                            <text textAnchor="middle" y="3.6" fontSize="10" fontWeight="700">
                                {b.step}
                            </text>
                        </g>
                    ))}
                </g>
            </svg>

            {edgeTip && (
                <div
                    role="tooltip"
                    className="pointer-events-none absolute z-20 max-w-xs rounded-md border border-(--color-card-surface-border) bg-(--bg-surface) px-2.5 py-1.5 text-xs text-(--text-primary) shadow-lg"
                    style={{ left: edgeTip.x, top: edgeTip.y }}
                >
                    <div className="font-aumovio-bold">
                        {nodeById[edgeTip.edge.source].label} → {nodeById[edgeTip.edge.target].label}
                    </div>
                    {edgeTip.edge.label && <div className="opacity-70">{edgeTip.edge.label}</div>}
                    <div style={{ color: kindTone[edgeTip.edge.kind].text }}>{kinds[edgeTip.edge.kind].label}</div>
                </div>
            )}

            {/* ── Legend ──────────────────────────────────────────────────── */}
            <div
                ref={legendRef}
                className="absolute bottom-3 left-3 z-10 hidden md:grid grid-cols-3 gap-x-4 gap-y-1 rounded-lg border border-(--color-card-surface-border) bg-(--bg-surface) px-3 py-2 text-[11px] text-(--text-primary) shadow-sm"
            >
                {Object.entries(kinds).map(([k, v]) => (
                    <div key={k} className="flex items-center gap-1.5">
                        <span className="inline-block w-4 border-t-2" style={{ borderColor: kindTone[k].text, borderTopStyle: kindTone[k].dashed ? "dashed" : "solid" }} />
                        <span className="opacity-70">{v.label}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}
