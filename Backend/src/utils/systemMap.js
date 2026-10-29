"use strict";

/**
 * @fileoverview Pure validator/assembler for the Support system maps —
 * Architecture (`src/constants/architectureModel.js`) and Runtime
 * (`src/constants/runtimeModel.js`). No I/O.
 *
 * A model is plain data: `{ MAP_VERIFIED_AT, META, LAYOUT, layers, edgeKinds,
 * nodes, E, flows }`. Edges are `[source, target, kind, label]`; flow steps are
 * `[from, to, action, detail]`, and a flow may carry a `ref` (e.g. the server
 * simulation stage it mirrors).
 *
 * Output shape: { meta, layers, edgeKinds, nodes, edges, flows, layout }.
 * `layout` is diagram placement for the UI only; the page strips it from the
 * JSON it offers for download, which is the copy meant for AI agents.
 */

/**
 * Validate a model and assemble its map.
 *
 * @param {object} src - a system-map model (see file header)
 * @returns {object} the map
 * @throws {Error} listing every problem found, one per line
 */
function buildSystemMap(src) {
    const { MAP_VERIFIED_AT, META, LAYOUT: layout, layers, edgeKinds, nodes, E, flows } = src;
    const name = META?.title ?? "System";
    const errors = [];

    const nodeIds = new Set();
    for (const n of nodes) {
        if (nodeIds.has(n.id)) errors.push(`duplicate node ${n.id}`);
        nodeIds.add(n.id);
        if (!layers.some((l) => l.id === n.layer)) errors.push(`node ${n.id}: unknown layer ${n.layer}`);
    }

    const edges = [];
    const edgeIndex = new Map();
    for (const [source, target, kind, label] of E) {
        const id = `${source}->${target}`;
        if (!nodeIds.has(source)) errors.push(`edge ${id}: unknown source`);
        if (!nodeIds.has(target)) errors.push(`edge ${id}: unknown target`);
        if (!edgeKinds[kind]) errors.push(`edge ${id}: unknown kind ${kind}`);
        if (edgeIndex.has(id)) errors.push(`duplicate edge ${id}`);
        const e = { id, source, target, kind, label };
        edgeIndex.set(id, e);
        edges.push(e);
    }

    const flowIds = new Set();
    const outFlows = flows.map((f) => {
        if (flowIds.has(f.id)) errors.push(`duplicate flow ${f.id}`);
        flowIds.add(f.id);
        const steps = [];
        if (!Array.isArray(f.steps)) {
            errors.push(`flow ${f.id}: steps is not an array`);
        } else {
            // Indexed loop, not .map(): map skips holes, so a `,,` typo in a model
            // would be served as a null step instead of being rejected.
            for (let i = 0; i < f.steps.length; i++) {
                const raw = f.steps[i];
                if (!Array.isArray(raw) || raw.length < 2 || typeof raw[0] !== "string" || typeof raw[1] !== "string") {
                    errors.push(`flow ${f.id} step ${i + 1}: not a [from, to, action, detail] step`);
                    continue;
                }
                const [from, to, action, detail] = raw;
                let edge = edgeIndex.get(`${from}->${to}`);
                let reverse = false;
                if (!edge) {
                    edge = edgeIndex.get(`${to}->${from}`);
                    reverse = !!edge;
                }
                if (!edge) errors.push(`flow ${f.id} step ${i + 1}: no edge between ${from} and ${to}`);
                steps.push({ step: i + 1, from, to, edge: edge?.id ?? null, reverse, action, detail });
            }
        }
        return {
            id: f.id,
            name: f.name,
            category: f.category,
            ...(f.ref ? { ref: f.ref } : {}),
            summary: f.summary,
            nodes: [...new Set(steps.flatMap((s) => [s.from, s.to]))],
            edges: [...new Set(steps.map((s) => s.edge).filter(Boolean))],
            steps,
        };
    });

    const placed = [...layout.columns.flatMap((c) => c.nodes), ...layout.band.nodes.map((b) => b.id)];
    for (const id of nodeIds) if (!placed.includes(id)) errors.push(`node ${id} is not placed in the layout`);
    for (const id of placed) if (!nodeIds.has(id)) errors.push(`layout places unknown node ${id}`);
    if (new Set(placed).size !== placed.length) errors.push("a node is placed twice in the layout");

    if (errors.length) throw new Error(`${name} model is invalid:\n${errors.join("\n")}`);

    return {
        meta: { ...META, mapVerifiedAt: MAP_VERIFIED_AT },
        layers,
        edgeKinds,
        nodes: nodes.map(({ sub, ...n }) => ({ ...n, subtitle: sub })),
        edges,
        flows: outFlows,
        layout,
    };
}

module.exports = { buildSystemMap };
