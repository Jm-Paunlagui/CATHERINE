/**
 * useSystemMap.js — shared state for the Support system-map pages
 * (Architecture, Runtime). Each feature wraps it with its own fetcher:
 * `useArchitecture()` / `useRuntime()`. Tier-3 shared: both features consume it.
 *
 * SELECTION LIVES IN THE URL (`?flow=…&step=…` or `?node=…`), as in Dev Docs:
 * "look at step 7 of the period-close flow" is something a Super Admin will
 * send a colleague, and a selection held only in memory cannot be shared or
 * reloaded onto. `step` in the URL is 1-based to match the numbers on screen.
 *
 * Camera moves are requested, not performed, here: `focus` is a
 * `{ ids, mode, key }` value the canvas reacts to. A new key means "move
 * again" even when the ids are the same.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { extractApiError } from "../../ui/toast.utils";
import { useRequest } from "../../../hooks/useRequest";
import { agentJson, buildAdjacency, computeLayout, searchNodes, validateMap } from "./systemMapLayout";
import { tonesById } from "./systemMapTones";

/** Autoplay dwell per step. Long enough to read the step text in the rail. */
export const PLAY_INTERVAL_MS = 1600;

let focusSeq = 0;
const focusOn = (ids, mode) => ({ ids, mode, key: ++focusSeq });

/**
 * Core hook for a system-map page.
 *
 * @param {object} config
 * @param {string} config.cacheKey           - useRequest key, e.g. "architecture/map"
 * @param {() => Promise<object>} config.fetchMap - resolves to the map (`data` of the API envelope)
 * @param {string} config.downloadName       - file name for Download JSON
 * @param {string} config.forbiddenMessage   - shown on a 403
 * @param {string} config.loadErrorMessage   - shown on any other failure
 * @returns {object} state and handlers consumed by SystemMapView
 */
export const useSystemMap = ({ cacheKey, fetchMap, downloadName, forbiddenMessage, loadErrorMessage }) => {
    const [searchParams, setSearchParams] = useSearchParams();

    const { data, loading, error } = useRequest(cacheKey, fetchMap, { staleTime: 300_000 });
    // A payload that cannot be drawn is treated as a load failure, never drawn
    // half-way (an unknown edge endpoint would throw inside the geometry).
    // A finished load with no body (200 + empty `data`) is the same failure —
    // without this the page rendered nothing at all: no map, no error.
    const problems = useMemo(() => (data ? validateMap(data) : !loading && !error ? ["map is missing"] : []), [data, loading, error]);
    const map = data && problems.length === 0 ? data : null;

    // ── Indexes (derived once per map) ───────────────────────────────────────
    const derived = useMemo(() => {
        if (!map) return null;
        const flowsByNode = {};
        for (const f of map.flows) for (const id of f.nodes) (flowsByNode[id] ??= []).push(f);
        return {
            nodeById: Object.fromEntries(map.nodes.map((n) => [n.id, n])),
            layerById: Object.fromEntries(map.layers.map((l) => [l.id, l])),
            // Palette- and theme-aware colours; the API's hex values are never painted.
            layerTone: tonesById(map.layers.map((l) => l.id)),
            kindTone: tonesById(Object.keys(map.edgeKinds)),
            adj: buildAdjacency(map.nodes, map.edges),
            flowsByNode,
            geometry: computeLayout(map.layout),
            endpointCount: map.nodes.reduce((n, node) => n + (node.endpoints?.length ?? 0), 0),
        };
    }, [map]);

    // ── URL-held selection ───────────────────────────────────────────────────
    const flowId = searchParams.get("flow");
    const nodeId = searchParams.get("node");
    const flow = useMemo(() => (map && flowId ? map.flows.find((f) => f.id === flowId) ?? null : null), [map, flowId]);
    const rawStep = Number.parseInt(searchParams.get("step") ?? "", 10);
    const stepIdx = flow && Number.isFinite(rawStep) ? Math.min(Math.max(rawStep, 1), flow.steps.length) - 1 : -1;
    const selectedId = !flow && nodeId && derived?.nodeById[nodeId] ? nodeId : null;

    const writeParams = useCallback(
        (entries) => {
            setSearchParams(
                (prev) => {
                    const next = new URLSearchParams(prev);
                    for (const k of ["flow", "step", "node"]) next.delete(k);
                    for (const [k, v] of Object.entries(entries)) if (v !== null && v !== undefined) next.set(k, String(v));
                    return next;
                },
                { replace: true },
            );
        },
        [setSearchParams],
    );

    // ── Local UI state ───────────────────────────────────────────────────────
    const [tab, setTab] = useState(() => (searchParams.get("node") && !searchParams.get("flow") ? "details" : "flows"));
    const [search, setSearch] = useState("");
    const [hiddenLayers, setHiddenLayers] = useState(() => new Set());
    const [playing, setPlaying] = useState(false);
    const [focus, setFocus] = useState(() => {
        const f = searchParams.get("flow");
        const n = searchParams.get("node");
        return f ? { flowId: f, mode: "fit", key: ++focusSeq } : n ? { nodeId: n, mode: "fit", key: ++focusSeq } : null;
    });

    const matches = useMemo(() => (map ? searchNodes(map.nodes, search) : []), [map, search]);

    // A deep link arrives before the map does, so the initial focus names a
    // flow or node by id; it is resolved to node ids here once the map exists.
    const resolvedFocus = useMemo(() => {
        if (!focus) return null;
        if (focus.mode === "all" || focus.ids) return focus;
        if (!derived || !map) return null;
        if (focus.flowId) {
            const f = map.flows.find((x) => x.id === focus.flowId);
            return f ? { ids: f.nodes, mode: "fit", key: focus.key } : null;
        }
        if (focus.nodeId && derived.adj[focus.nodeId]) {
            const a = derived.adj[focus.nodeId];
            return { ids: [focus.nodeId, ...a.out.map((e) => e.target), ...a.in.map((e) => e.source)], mode: "fit", key: focus.key };
        }
        return null;
    }, [focus, derived, map]);

    // ── Actions ──────────────────────────────────────────────────────────────
    const selectNode = useCallback(
        (id) => {
            if (!derived?.adj[id]) return;
            setPlaying(false);
            writeParams({ node: id });
            setTab("details");
            const a = derived.adj[id];
            const ids = [id, ...a.out.map((e) => e.target), ...a.in.map((e) => e.source)].filter((x) => !hiddenLayers.has(derived.nodeById[x].layer));
            setFocus(focusOn(ids, "fit"));
        },
        [derived, hiddenLayers, writeParams],
    );

    const enterFlow = useCallback(
        (id) => {
            const f = map?.flows.find((x) => x.id === id);
            if (!f) return;
            setPlaying(false);
            writeParams({ flow: id });
            setTab("flows");
            setFocus(focusOn(f.nodes, "fit"));
        },
        [map, writeParams],
    );

    const goStep = useCallback(
        (i) => {
            if (!flow) return;
            const idx = Math.min(Math.max(i, 0), flow.steps.length - 1);
            writeParams({ flow: flow.id, step: idx + 1 });
            const s = flow.steps[idx];
            setFocus(focusOn([s.from, s.to], "ensure"));
        },
        [flow, writeParams],
    );

    /** Back to the whole path with no step selected. */
    const showPath = useCallback(() => {
        if (!flow) return;
        setPlaying(false);
        writeParams({ flow: flow.id });
        setFocus(focusOn(flow.nodes, "fit"));
    }, [flow, writeParams]);

    const nextStep = useCallback(() => {
        setPlaying(false);
        goStep(stepIdx + 1);
    }, [goStep, stepIdx]);

    const prevStep = useCallback(() => {
        setPlaying(false);
        goStep(stepIdx - 1);
    }, [goStep, stepIdx]);

    const togglePlay = useCallback(() => {
        if (!flow) return;
        if (playing) return setPlaying(false);
        // Restart from the top when the last step is showing.
        if (stepIdx >= flow.steps.length - 1) goStep(0);
        else goStep(stepIdx + 1);
        setPlaying(true);
    }, [flow, playing, stepIdx, goStep]);

    const clear = useCallback(() => {
        setPlaying(false);
        setSearch("");
        writeParams({});
        setFocus(focusOn(null, "all"));
    }, [writeParams]);

    const fitAll = useCallback(() => setFocus(focusOn(null, "all")), []);

    const toggleLayer = useCallback((layerId) => {
        setHiddenLayers((prev) => {
            const next = new Set(prev);
            if (next.has(layerId)) next.delete(layerId);
            else next.add(layerId);
            return next;
        });
    }, []);

    const focusMatches = useCallback(() => {
        if (matches.length === 1) selectNode(matches[0]);
        else if (matches.length > 1) setFocus(focusOn(matches, "fit"));
    }, [matches, selectNode]);

    const downloadJson = useCallback(() => {
        if (!map) return;
        const url = URL.createObjectURL(new Blob([agentJson(map)], { type: "application/json" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = downloadName;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, [map, downloadName]);

    // ── Autoplay ─────────────────────────────────────────────────────────────
    // The interval only advances; it stops itself on the last step. No state is
    // set synchronously in the effect body.
    useEffect(() => {
        if (!playing || !flow) return undefined;
        const t = setInterval(() => {
            if (stepIdx >= flow.steps.length - 1) setPlaying(false);
            else goStep(stepIdx + 1);
        }, PLAY_INTERVAL_MS);
        return () => clearInterval(t);
    }, [playing, flow, stepIdx, goStep]);

    // ── Errors ───────────────────────────────────────────────────────────────
    const apiError = useMemo(() => {
        if (!error && problems.length) return { message: `${loadErrorMessage} The map data is incomplete.`, severity: "danger" };
        if (!error) return null;
        // 403 means the session is not SUPER_ADMIN — the server working as
        // intended, so say that rather than implying the page is broken.
        const fallback = error?.response?.status === 403 ? forbiddenMessage : loadErrorMessage;
        return extractApiError(error, fallback);
    }, [error, problems, forbiddenMessage, loadErrorMessage]);

    return {
        map,
        loading,
        apiError,
        ...(derived ?? {}),
        // selection
        flow,
        stepIdx,
        selectedId,
        tab,
        setTab,
        focus: resolvedFocus,
        // search / filters
        search,
        setSearch,
        matches,
        focusMatches,
        hiddenLayers,
        toggleLayer,
        // playback
        playing,
        // actions
        selectNode,
        enterFlow,
        goStep,
        nextStep,
        prevStep,
        togglePlay,
        showPath,
        clear,
        fitAll,
        downloadJson,
    };
};

export default useSystemMap;
