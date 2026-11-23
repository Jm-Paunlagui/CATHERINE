import { mergeMetricsSnapshots, buildQuantileSketch } from "../../../src/middleware/metrics/metricsMerge";
import { ClusterRpcHub } from "../../../src/utils/cluster/ClusterRpcHub";
import { CLUSTER_IPC, CLUSTER_RPC_METHODS as M, CLUSTER_RPC_LIMITS } from "../../../src/constants/clusterIpc";

function part(workerId: number, routes: number) {
    const ramp = Array.from({ length: 1000 }, (_, i) => i);
    const red: Record<string, unknown> = {};
    const routeSketches: Record<string, unknown> = {};
    for (let r = 0; r < routes; r++) {
        red[`GET /r${r}`] = { count: 1000, clientErrorCount: 1, serverErrorCount: 1, p50: 1, p95: 2, p99: 3, avgMs: 5, window: { windowMs: 300_000, count: 10, p99: 3 } };
        routeSketches[`GET /r${r}`] = buildQuantileSketch(ramp);
    }
    return {
        workerId,
        value: {
            snapshot: { uptime: 1, red, totals: { requestsTotal: 1000 }, system: { memory: { heapUsed: 1, heapSizeLimit: 10 } }, dependencies: {} },
            extras: { routeSketches },
        },
    };
}

describe("cluster merge scale", () => {
    it("merges 32 workers x 200 routes with exact sums and a bounded run time", () => {
        const parts = Array.from({ length: 32 }, (_, i) => part(i + 1, 200));
        const t0 = performance.now();
        const merged = mergeMetricsSnapshots(parts)!;
        const ms = performance.now() - t0;
        expect(Object.keys(merged.red)).toHaveLength(200);
        expect(merged.red["GET /r0"].count).toBe(32_000);
        expect(merged.totals.requestsTotal).toBe(32_000);
        expect(merged.cluster.responded).toBe(32);
        // O(workers x routes x 60 bisections): a generous ceiling that still catches a quadratic regression.
        expect(ms).toBeLessThan(10_000);
    });

    it("the hub caps in-flight gathers and leader calls so a flood cannot grow its tables", () => {
        const sent: any[] = [];
        const workers = [1, 2].map((id) => ({ id, process: { pid: id }, send: (m: any) => { sent.push(m); } }));
        const hub = new ClusterRpcHub({ logger: { warning: () => undefined }, getLiveWorkers: () => workers, getLeader: () => workers[0] });
        for (let i = 0; i < 5000; i++) {
            hub.handleMessage(workers[1], { cmd: CLUSTER_IPC.RPC_REQUEST, id: `g${i}`, target: "all", method: M.METRICS_SNAPSHOT, args: {} });
            hub.handleMessage(workers[1], { cmd: CLUSTER_IPC.RPC_REQUEST, id: `l${i}`, target: "leader", method: M.ALERTS_STATUS, args: {} });
        }
        const upper = CLUSTER_RPC_LIMITS.MAX_GATHERS * workers.length + CLUSTER_RPC_LIMITS.MAX_LEADER_CALLS;
        expect(hub.pendingCount).toBe(upper);
        const overloads = sent.filter((m) => m.cmd === CLUSTER_IPC.RPC_RESPONSE && m.ok === false && m.error.code === "OVERLOAD");
        expect(overloads.length).toBe(10_000 - CLUSTER_RPC_LIMITS.MAX_GATHERS - CLUSTER_RPC_LIMITS.MAX_LEADER_CALLS);
    });
});
