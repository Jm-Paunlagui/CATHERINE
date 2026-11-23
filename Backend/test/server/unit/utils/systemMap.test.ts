/**
 * @fileoverview Unit tests for buildSystemMap — the validator/shaper behind the
 * Architecture page. Every integrity rule is exercised with a minimal model.
 */
import { buildSystemMap } from "../../../../src/utils/systemMap";

type Model = Parameters<typeof buildSystemMap>[0];

function model(over: Partial<Model> = {}): Model {
    return {
        MAP_VERIFIED_AT: "2026-01-01",
        META: { title: "Test Map", extra: 1 },
        LAYOUT: { columns: [{ nodes: ["a"] }, { nodes: ["b"] }], band: { nodes: [{ id: "c" }] } },
        layers: [{ id: "L1" }],
        edgeKinds: { http: {} },
        nodes: [
            { id: "a", layer: "L1", sub: "A sub" },
            { id: "b", layer: "L1" },
            { id: "c", layer: "L1" },
        ],
        E: [
            ["a", "b", "http", "calls"],
            ["b", "c", "http", "calls"],
        ],
        flows: [
            {
                id: "f1",
                name: "Flow",
                category: "cat",
                ref: "doc#1",
                summary: "sum",
                steps: [
                    ["a", "b", "do", "detail"],
                    ["c", "b", "back", "x"],
                ],
            },
        ],
        ...over,
    } as Model;
}

const errorsOf = (m: Model): string => {
    try {
        buildSystemMap(m);
    } catch (e) {
        return (e as Error).message;
    }
    return "";
};

describe("buildSystemMap: shaping", () => {
    it("builds edges, resolves flow steps (forward and reverse) and maps sub to subtitle", () => {
        const out = buildSystemMap(model()) as Record<string, any>;
        expect(out.meta).toEqual({ title: "Test Map", extra: 1, mapVerifiedAt: "2026-01-01" });
        expect(out.edges.map((e: { id: string }) => e.id)).toEqual(["a->b", "b->c"]);
        expect(out.nodes[0]).toEqual({ id: "a", layer: "L1", subtitle: "A sub" });
        expect(out.nodes[0].sub).toBeUndefined();
        const [flow] = out.flows;
        expect(flow.steps[0]).toMatchObject({ step: 1, edge: "a->b", reverse: false });
        expect(flow.steps[1]).toMatchObject({ step: 2, from: "c", to: "b", edge: "b->c", reverse: true });
        expect(flow.nodes).toEqual(["a", "b", "c"]);
        expect(flow.edges).toEqual(["a->b", "b->c"]);
        expect(flow.ref).toBe("doc#1");
    });

    it("omits ref when the flow has none", () => {
        const m = model();
        delete m.flows[0].ref;
        const out = buildSystemMap(m) as Record<string, any>;
        expect("ref" in out.flows[0]).toBe(false);
    });

    it("works without META (empty meta spread)", () => {
        const out = buildSystemMap(model({ META: undefined })) as Record<string, any>;
        expect(out.meta).toEqual({ mapVerifiedAt: "2026-01-01" });
    });
});

describe("buildSystemMap: validation errors", () => {
    it("rejects duplicate nodes and unknown layers", () => {
        const msg = errorsOf(
            model({
                nodes: [
                    { id: "a", layer: "L1" },
                    { id: "a", layer: "NOPE" },
                    { id: "b", layer: "L1" },
                    { id: "c", layer: "L1" },
                ],
            }),
        );
        expect(msg).toContain("Test Map model is invalid");
        expect(msg).toContain("duplicate node a");
        expect(msg).toContain("node a: unknown layer NOPE");
    });

    it("rejects unknown edge endpoints, unknown kind and duplicate edges", () => {
        const msg = errorsOf(
            model({
                E: [
                    ["ghost", "b", "http", ""],
                    ["a", "ghost2", "http", ""],
                    ["a", "b", "weird", ""],
                    ["a", "b", "http", ""],
                    ["a", "b", "http", ""],
                ],
            }),
        );
        expect(msg).toContain("edge ghost->b: unknown source");
        expect(msg).toContain("edge a->ghost2: unknown target");
        expect(msg).toContain("edge a->b: unknown kind weird");
        expect(msg).toContain("duplicate edge a->b");
    });

    it("rejects duplicate flows, non-array steps and malformed steps", () => {
        const msg = errorsOf(
            model({
                flows: [
                    { id: "f", steps: "nope" },
                    { id: "f", steps: [["a"], [1, 2], ["a", "b"], null] },
                ] as never,
            }),
        );
        expect(msg).toContain("duplicate flow f");
        expect(msg).toContain("flow f: steps is not an array");
        expect(msg).toContain("flow f step 1: not a [from, to, action, detail] step");
        expect(msg).toContain("flow f step 2:");
        expect(msg).toContain("flow f step 4:");
        expect(msg).not.toContain("flow f step 3");
    });

    it("rejects a hole in a steps array", () => {
        const steps: unknown[] = [["a", "b"]];
        steps[2] = ["a", "b"];
        expect(errorsOf(model({ flows: [{ id: "f", steps }] as never }))).toContain("flow f step 2:");
    });

    it("rejects a flow step with no edge between the nodes", () => {
        expect(errorsOf(model({ flows: [{ id: "f", steps: [["a", "c"]] }] as never }))).toContain(
            "flow f step 1: no edge between a and c",
        );
    });

    it("rejects layout problems: unplaced, unknown and doubly placed nodes", () => {
        const msg = errorsOf(model({ LAYOUT: { columns: [{ nodes: ["a", "a", "zzz"] }], band: { nodes: [] } } }));
        expect(msg).toContain("node b is not placed in the layout");
        expect(msg).toContain("node c is not placed in the layout");
        expect(msg).toContain("layout places unknown node zzz");
        expect(msg).toContain("a node is placed twice in the layout");
    });

    it("falls back to the name 'System' when META has no title", () => {
        const msg = errorsOf(model({ META: {}, E: [["x", "b", "http", ""]] }));
        expect(msg.startsWith("System model is invalid")).toBe(true);
    });
});
