/**
 * systemMapLayout.js — pure geometry and highlight rules for the system-map
 * diagrams (Architecture, Runtime). No React, no DOM: everything here is unit-tested in
 * jsdom, which cannot measure SVG paths, so edge midpoints are computed from
 * the bezier itself rather than with `getPointAtLength`.
 */

export const NODE_W = 176;
export const NODE_H = 46;
const COL_W = 236;
const ROW_H = 60;
const TOP = 56;
const LEFT = 30;
const BAND_GAP = 62;

/**
 * Place every node. Columns are vertically centred against the tallest one;
 * the runtime band sits under the main grid at the column indexes it names.
 *
 * @param {{ columns: {layer:string,nodes:string[]}[], band: {layer:string,nodes:{id:string,col:number}[]} }} layout
 * @returns {{ pos: Record<string,{x:number,y:number,col:number,row:number,band:string}>, world: {w:number,h:number}, regions: {layer:string,x:number,y:number,w:number,h:number,labelX:number,labelY:number}[] }}
 */
export function computeLayout(layout) {
    const pos = {};
    const maxRows = Math.max(...layout.columns.map((c) => c.nodes.length));
    const gridH = maxRows * ROW_H;

    layout.columns.forEach((c, ci) => {
        const off = (gridH - c.nodes.length * ROW_H) / 2;
        c.nodes.forEach((id, ri) => {
            pos[id] = { x: LEFT + ci * COL_W, y: TOP + off + ri * ROW_H, col: ci, row: ri, band: "main" };
        });
    });

    const bandY = TOP + gridH + BAND_GAP;
    for (const b of layout.band.nodes) pos[b.id] = { x: LEFT + b.col * COL_W, y: bandY, col: b.col, row: 0, band: "runtime" };

    // One shaded region per layer, spanning all of its columns.
    const regions = [];
    layout.columns.forEach((c, ci) => {
        if (regions.some((r) => r.layer === c.layer)) return;
        const span = layout.columns.filter((x) => x.layer === c.layer).length;
        const x = LEFT + ci * COL_W;
        regions.push({ layer: c.layer, x: x - 10, y: 14, w: span * COL_W - (COL_W - NODE_W) + 20, h: TOP + gridH - 18, labelX: x, labelY: 34 });
    });
    const bandCols = layout.band.nodes.map((b) => b.col);
    if (bandCols.length) {
        const x0 = LEFT + Math.min(...bandCols) * COL_W;
        const x1 = LEFT + Math.max(...bandCols) * COL_W + NODE_W;
        regions.push({ layer: layout.band.layer, x: x0 - 10, y: bandY - 30, w: x1 - x0 + 20, h: NODE_H + 42, labelX: x0, labelY: bandY - 12 });
    }

    return {
        pos,
        world: { w: LEFT * 2 + layout.columns.length * COL_W - (COL_W - NODE_W), h: bandY + NODE_H + 40 },
        regions,
    };
}

/**
 * Edge geometry as a cubic bezier (a straight segment is a cubic whose control
 * points sit on the line), so one `pointAt` serves both.
 *
 * Routing rules, in order:
 *   - same column, adjacent rows   → short vertical connector
 *   - same column, further apart   → arc beside the column; downward edges on
 *                                    the left, upward on the right, so a
 *                                    fan-out and a fan-in never share a side
 *   - columns clearly apart        → horizontal S-curve between facing sides
 *   - otherwise                    → vertical S-curve between top and bottom
 *
 * @returns {{ d: string, p0: number[], c1: number[], c2: number[], p3: number[] }}
 */
export function edgeGeometry(edge, pos) {
    const a = pos[edge.source];
    const b = pos[edge.target];
    const acx = a.x + NODE_W / 2;
    const acy = a.y + NODE_H / 2;
    const bcx = b.x + NODE_W / 2;
    const bcy = b.y + NODE_H / 2;
    const dx = bcx - acx;
    const dy = bcy - acy;
    let p0, c1, c2, p3;

    if (a.col === b.col && a.band === b.band) {
        if (Math.abs(a.row - b.row) === 1) {
            const down = dy > 0;
            p0 = [acx, down ? a.y + NODE_H : a.y];
            p3 = [bcx, down ? b.y : b.y + NODE_H];
            c1 = p0;
            c2 = p3;
        } else {
            const left = dy > 0;
            const sx = left ? a.x : a.x + NODE_W;
            const tx = left ? b.x : b.x + NODE_W;
            const bulge = Math.min(26 + Math.abs(a.row - b.row) * 9, 92) * (left ? -1 : 1);
            p0 = [sx, acy];
            c1 = [sx + bulge, acy];
            c2 = [tx + bulge, bcy];
            p3 = [tx, bcy];
        }
    } else if (Math.abs(dx) > NODE_W * 0.75) {
        const r = dx > 0;
        const sx = r ? a.x + NODE_W : a.x;
        const tx = r ? b.x : b.x + NODE_W;
        const o = Math.max(46, Math.abs(dx) * 0.42) * (r ? 1 : -1);
        p0 = [sx, acy];
        c1 = [sx + o, acy];
        c2 = [tx - o, bcy];
        p3 = [tx, bcy];
    } else {
        const down = dy > 0;
        const sy = down ? a.y + NODE_H : a.y;
        const ty = down ? b.y : b.y + NODE_H;
        const o = Math.max(34, Math.abs(dy) * 0.4) * (down ? 1 : -1);
        p0 = [acx, sy];
        c1 = [acx, sy + o];
        c2 = [bcx, ty - o];
        p3 = [bcx, ty];
    }

    return { d: `M${p0[0]},${p0[1]} C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${p3[0]},${p3[1]}`, p0, c1, c2, p3 };
}

/** Point on the bezier at parameter t (0..1). */
export function pointAt({ p0, c1, c2, p3 }, t) {
    const u = 1 - t;
    const k = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
    return [0, 1].map((i) => k[0] * p0[i] + k[1] * c1[i] + k[2] * c2[i] + k[3] * p3[i]);
}

/** Bounding box (world units, padded) around a set of node ids. */
export function bboxOf(ids, pos, pad = 30) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const id of ids) {
        const p = pos[id];
        if (!p) continue;
        x0 = Math.min(x0, p.x);
        y0 = Math.min(y0, p.y);
        x1 = Math.max(x1, p.x + NODE_W);
        y1 = Math.max(y1, p.y + NODE_H);
    }
    if (x0 === Infinity) return null;
    return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
}

/** id → { out: edge[], in: edge[] } */
export function buildAdjacency(nodes, edges) {
    const adj = Object.fromEntries(nodes.map((n) => [n.id, { out: [], in: [] }]));
    for (const e of edges) {
        adj[e.source]?.out.push(e);
        adj[e.target]?.in.push(e);
    }
    return adj;
}

/** Case-insensitive match on id, label, subtitle, description, files and endpoints. */
export function searchNodes(nodes, query) {
    const q = String(query ?? "").trim().toLowerCase();
    if (!q) return [];
    return nodes
        .filter((n) => [n.id, n.label, n.subtitle, n.description, ...(n.files ?? []), ...(n.endpoints ?? [])].join(" ").toLowerCase().includes(q))
        .map((n) => n.id);
}

/**
 * What to emphasise. A flow wins over a node focus; with neither, nothing is
 * dimmed. `focusId` is the hovered node, else the selected one.
 *
 * @returns {{ dimNodes: Set<string>, curNodes: Set<string>, edgeState: Map<string,'hl'|'flow'|'cur'|'dim'>, current: object|null }}
 */
export function computeHighlight({ adj, edges, flow, stepIdx, focusId }) {
    const dimNodes = new Set();
    const curNodes = new Set();
    const edgeState = new Map();
    let current = null;

    if (flow) {
        const inFlow = new Set(flow.nodes);
        const flowEdges = new Set(flow.edges);
        for (const id of Object.keys(adj)) if (!inFlow.has(id)) dimNodes.add(id);
        for (const e of edges) edgeState.set(e.id, flowEdges.has(e.id) ? "flow" : "dim");
        current = stepIdx >= 0 ? flow.steps[stepIdx] ?? null : null;
        if (current) {
            edgeState.set(current.edge, "cur");
            curNodes.add(current.from);
            curNodes.add(current.to);
        }
        return { dimNodes, curNodes, edgeState, current };
    }

    if (focusId && adj[focusId]) {
        const keep = new Set([focusId]);
        for (const e of [...adj[focusId].out, ...adj[focusId].in]) {
            keep.add(e.source);
            keep.add(e.target);
        }
        for (const id of Object.keys(adj)) if (!keep.has(id)) dimNodes.add(id);
        for (const e of edges) edgeState.set(e.id, e.source === focusId || e.target === focusId ? "hl" : "dim");
    }
    return { dimNodes, curNodes, edgeState, current };
}

/**
 * Where to draw each step's number. Steps that share an edge are spread along
 * it instead of stacking on the midpoint.
 *
 * @returns {{ step: number, index: number, edge: string, x: number, y: number }[]}
 */
export function stepBadges(flow, geometryById) {
    if (!flow) return [];
    const byEdge = new Map();
    flow.steps.forEach((s, i) => {
        if (!byEdge.has(s.edge)) byEdge.set(s.edge, []);
        byEdge.get(s.edge).push(i);
    });
    const out = [];
    for (const [edgeId, idxs] of byEdge) {
        const g = geometryById[edgeId];
        if (!g) continue;
        idxs.forEach((i, j) => {
            const t = idxs.length === 1 ? 0.5 : 0.3 + (0.4 * j) / (idxs.length - 1);
            const [x, y] = pointAt(g, t);
            out.push({ step: flow.steps[i].step, index: i, edge: edgeId, x, y });
        });
    }
    return out;
}

/** The copy offered for download: the map without diagram placement. */
export function agentJson(map) {
    const { layout, ...rest } = map;
    return JSON.stringify(rest, null, 2);
}

/**
 * Structural check of a map payload before anything is drawn. The API
 * validates its models, but the page must not white-screen if a payload ever
 * arrives incomplete or inconsistent (proxy truncation, a mismatched deploy):
 * an edge to an unknown node would otherwise throw inside edgeGeometry.
 *
 * @param {object} map
 * @returns {string[]} problems; empty when the map is drawable
 */
export function validateMap(map) {
    if (!map || typeof map !== "object") return ["map is missing"];
    const problems = [];
    for (const key of ["layers", "nodes", "edges", "flows"]) if (!Array.isArray(map[key])) problems.push(`${key} is not a list`);
    if (!map.layout || !Array.isArray(map.layout.columns) || !Array.isArray(map.layout.band?.nodes)) problems.push("layout is missing");
    if (!map.edgeKinds || typeof map.edgeKinds !== "object") problems.push("edgeKinds is missing");
    if (problems.length) return problems;

    const isObj = (v) => v !== null && typeof v === "object";
    const isStrList = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
    const nodes = map.nodes.filter(isObj);
    const edges = map.edges.filter(isObj);
    const layers = map.layers.filter(isObj);
    const columns = map.layout.columns.filter(isObj);
    const bandNodes = map.layout.band.nodes.filter(isObj);
    if (nodes.length !== map.nodes.length) problems.push("nodes contains an empty entry");
    if (edges.length !== map.edges.length) problems.push("edges contains an empty entry");
    if (layers.length !== map.layers.length) problems.push("layers contains an empty entry");
    if (columns.length !== map.layout.columns.length) problems.push("layout columns contain an empty entry");
    if (bandNodes.length !== map.layout.band.nodes.length) problems.push("layout band contains an empty entry");
    // computeLayout reads `c.nodes.length` for every column.
    map.layout.columns.forEach((c, i) => {
        if (isObj(c) && !Array.isArray(c.nodes)) problems.push(`layout column ${i + 1} nodes is not a list`);
    });

    const nodeIds = new Set(nodes.map((n) => n.id));
    const layerIds = new Set(layers.map((l) => l.id));
    const placed = new Set([...columns.flatMap((c) => (Array.isArray(c.nodes) ? c.nodes : [])), ...bandNodes.map((b) => b.id)]);
    for (const n of nodes) {
        if (!layerIds.has(n.layer)) problems.push(`node ${n.id} has unknown layer`);
        if (!placed.has(n.id)) problems.push(`node ${n.id} is not placed`);
        // NodeDetails maps these and splits each endpoint on a space.
        for (const key of ["files", "endpoints"]) if (n[key] !== undefined && n[key] !== null && !isStrList(n[key])) problems.push(`node ${n.id} ${key} is not a list of text`);
    }
    const edgeIds = new Set();
    for (const e of edges) {
        edgeIds.add(e.id);
        if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) problems.push(`edge ${e.id} has an unknown endpoint`);
        if (!map.edgeKinds[e.kind]) problems.push(`edge ${e.id} has unknown kind`);
    }
    map.flows.forEach((f, fi) => {
        if (!isObj(f)) {
            problems.push(`flow ${fi + 1} is missing`);
            return;
        }
        // Every consumer (FlowPanel, useSystemMap, computeHighlight) reads these as lists.
        if (!Array.isArray(f.nodes)) problems.push(`flow ${f.id} nodes is not a list`);
        else if (f.nodes.some((id) => !nodeIds.has(id))) problems.push(`flow ${f.id} has an unknown node`);
        if (f.edges !== undefined && !Array.isArray(f.edges)) problems.push(`flow ${f.id} edges is not a list`);
        if (!Array.isArray(f.steps)) {
            problems.push(`flow ${f.id} steps is not a list`);
            return;
        }
        f.steps.forEach((s, i) => {
            if (!isObj(s)) problems.push(`flow ${f.id} step ${i + 1} is missing`);
            else {
                if (!edgeIds.has(s.edge)) problems.push(`flow ${f.id} step ${s.step} has unknown edge`);
                if (!nodeIds.has(s.from) || !nodeIds.has(s.to)) problems.push(`flow ${f.id} step ${s.step} has an unknown node`);
            }
        });
    });
    return problems;
}
