/**
 * NodeDetails.jsx — the Details tab: one node's role, files, endpoints,
 * connections and the flows it appears in. With nothing selected it explains
 * the layers instead.
 */

import { BASE_COLOR_TEXT, TRANSITION_COLORS } from "../../../assets/styles/pre-set-styles";

const METHOD_COLOR = {
    GET: "text-success-500 dark:text-success-300",
    // blue and purple are palette-adaptive families, so they take the
    // contrast-safe foreground tokens; success/warn/danger are fixed semantics.
    POST: "text-(--blue-foreground)",
    PUT: "text-warn-600 dark:text-warn-300",
    PATCH: "text-(--secondary-foreground)",
    DELETE: "text-danger-500 dark:text-danger-300",
};

const SectionTitle = ({ children }) => <h3 className={`mt-5 mb-1.5 text-xs font-aumovio-bold uppercase tracking-wider ${BASE_COLOR_TEXT} opacity-60`}>{children}</h3>;

function Connection({ edge, dir, hook }) {
    const { nodeById, map, kindTone, selectNode } = hook;
    const other = nodeById[dir === "out" ? edge.target : edge.source];
    const kind = map.edgeKinds[edge.kind];
    return (
        <button
            type="button"
            onClick={() => selectNode(other.id)}
            className={`flex w-full items-start gap-2 rounded px-2 py-1.5 text-left hover:bg-(--bg-surface-2) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent)/40 ${TRANSITION_COLORS}`}
        >
            <span className="mt-2 w-2.5 shrink-0 border-t-2" style={{ borderColor: kindTone[edge.kind].text, borderTopStyle: kindTone[edge.kind].dashed ? "dashed" : "solid" }} />
            <span className="min-w-0">
                <span className={`text-sm ${BASE_COLOR_TEXT}`}>
                    {dir === "out" ? "→" : "←"} {other.label}
                </span>
                <span className={`block truncate text-[11px] ${BASE_COLOR_TEXT} opacity-60`}>{edge.label || kind.label}</span>
            </span>
        </button>
    );
}

export default function NodeDetails({ hook }) {
    const { map, selectedId, nodeById, layerById, layerTone, adj, flowsByNode, enterFlow } = hook;

    if (!selectedId) {
        return (
            <div>
                <p className={`text-sm ${BASE_COLOR_TEXT} opacity-70`}>Click any node to see its role, files, endpoints, connections and the flows it takes part in.</p>
                <ul className="mt-4 space-y-2">
                    {map.layers.map((l) => (
                        <li key={l.id} className="flex gap-2 text-xs">
                            <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ background: layerTone[l.id].fill }} />
                            <span>
                                <span className={`block font-aumovio-bold ${BASE_COLOR_TEXT}`}>{l.label}</span>
                                <span className={`${BASE_COLOR_TEXT} opacity-70`}>{l.description}</span>
                            </span>
                        </li>
                    ))}
                </ul>
            </div>
        );
    }

    const n = nodeById[selectedId];
    const layer = layerById[n.layer];
    const { out, in: incoming } = adj[selectedId];
    const flows = flowsByNode[selectedId] ?? [];

    return (
        <div>
            <p className="flex items-center gap-2 text-[11px] font-aumovio-bold uppercase tracking-wider" style={{ color: layerTone[n.layer].text }}>
                <span className="h-2 w-2 rounded-full" style={{ background: layerTone[n.layer].fill }} />
                {layer.label}
            </p>
            <h2 className={`mt-1.5 text-xl font-aumovio-bold ${BASE_COLOR_TEXT}`}>{n.label}</h2>
            <p className={`mt-0.5 font-mono text-xs ${BASE_COLOR_TEXT} opacity-60`}>
                {n.subtitle} · {n.id}
            </p>
            <p className={`mt-3 text-sm ${BASE_COLOR_TEXT}`}>{n.description}</p>

            {n.files?.length > 0 && (
                <>
                    <SectionTitle>Files</SectionTitle>
                    <ul className="space-y-1">
                        {n.files.map((f) => (
                            <li key={f} className="break-all font-mono text-[11.5px] text-(--accent-foreground)">
                                {f}
                            </li>
                        ))}
                    </ul>
                </>
            )}

            {n.endpoints?.length > 0 && (
                <details className="mt-5">
                    <summary className={`cursor-pointer select-none text-xs font-aumovio-bold uppercase tracking-wider ${BASE_COLOR_TEXT} opacity-60`}>Endpoints ({n.endpoints.length})</summary>
                    <ul className="mt-2 space-y-0.5">
                        {n.endpoints.map((e) => {
                            const [method, ...rest] = e.split(" ");
                            return (
                                <li key={e} className="flex gap-2 font-mono text-[11px]">
                                    <span className={`w-12 shrink-0 ${METHOD_COLOR[method] ?? ""}`}>{method}</span>
                                    <span className={`break-all ${BASE_COLOR_TEXT}`}>{rest.join(" ")}</span>
                                </li>
                            );
                        })}
                    </ul>
                </details>
            )}

            {flows.length > 0 && (
                <>
                    <SectionTitle>In flows</SectionTitle>
                    <div className="flex flex-wrap gap-1.5">
                        {flows.map((f) => (
                            <button
                                key={f.id}
                                type="button"
                                onClick={() => enterFlow(f.id)}
                                className={`rounded-md border border-(--color-card-surface-border) px-2 py-1 text-xs hover:border-(--accent-icon) ${BASE_COLOR_TEXT} ${TRANSITION_COLORS}`}
                            >
                                {f.name}
                            </button>
                        ))}
                    </div>
                </>
            )}

            <SectionTitle>Outgoing ({out.length})</SectionTitle>
            {out.length ? out.map((e) => <Connection key={e.id} edge={e} dir="out" hook={hook} />) : <p className={`px-2 text-xs ${BASE_COLOR_TEXT} opacity-60`}>None</p>}

            <SectionTitle>Incoming ({incoming.length})</SectionTitle>
            {incoming.length ? incoming.map((e) => <Connection key={e.id} edge={e} dir="in" hook={hook} />) : <p className={`px-2 text-xs ${BASE_COLOR_TEXT} opacity-60`}>None</p>}
        </div>
    );
}
