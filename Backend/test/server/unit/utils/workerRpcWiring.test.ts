import { wireWorkerRpc } from "../../../../src/utils/cluster/workerRpcWiring";
import { CLUSTER_RPC_METHODS as M, CLUSTER_TOPICS as T } from "../../../../src/constants/clusterIpc";

/** Captures what the wiring registers; the real services behind it are loaded by the wiring itself. */
function fakeClient() {
    const handlers = new Map<string, (a: any) => any>();
    const topics = new Map<string, (p: any) => any>();
    return {
        handlers, topics,
        handle: (m: string, fn: any) => { handlers.set(m, fn); },
        onTopic: (t: string, fn: any) => { topics.set(t, fn); },
    };
}

describe("wireWorkerRpc", () => {
    it("every worker answers metrics gathers and mirrors the broadcast topics", () => {
        const c = fakeClient();
        wireWorkerRpc({ client: c as any, isLeader: false });
        expect([...c.handlers.keys()]).toEqual([M.METRICS_SNAPSHOT]);
        expect([...c.topics.keys()].sort()).toEqual([
            T.RECIPIENTS_INVALIDATE, T.SF_BLOCK, T.SF_UNBLOCKED, T.SF_SYNC, T.AUTH_REVOKED, T.AUTH_SYNC, T.SCHED_STATE, T.SCHED_SYNC,
        ].sort());
    });

    it("the metrics handler returns a mergeable snapshot", () => {
        const c = fakeClient();
        wireWorkerRpc({ client: c as any, isLeader: false });
        const out = c.handlers.get(M.METRICS_SNAPSHOT)!({});
        expect(out).toHaveProperty("snapshot");
        expect(out).toHaveProperty("extras");
    });

    it("only the cron leader registers the alert ack/status handlers", () => {
        const c = fakeClient();
        wireWorkerRpc({ client: c as any, isLeader: true });
        for (const m of [M.ALERTS_ACK, M.ALERTS_UNACK, M.ALERTS_STATUS, M.ALERTS_ACKS, M.METRICS_SNAPSHOT]) expect(c.handlers.has(m)).toBe(true);
        expect(c.handlers.size).toBe(5);
    });

    it("the leader's acks snapshot handler returns a list", () => {
        const c = fakeClient();
        wireWorkerRpc({ client: c as any, isLeader: true });
        expect(Array.isArray(c.handlers.get(M.ALERTS_ACKS)!({}))).toBe(true);
    });

    it("topic callbacks apply remote state without throwing on valid payloads", () => {
        const c = fakeClient();
        wireWorkerRpc({ client: c as any, isLeader: false });
        const future = Date.now() + 60_000;
        expect(() => {
            c.topics.get(T.RECIPIENTS_INVALIDATE)!({});
            c.topics.get(T.SF_BLOCK)!({ ip: "203.0.113.9", blockedUntil: future });
            c.topics.get(T.SF_SYNC)!({ blocks: [{ ip: "203.0.113.8", blockedUntil: future }] });
            c.topics.get(T.SF_UNBLOCKED)!({ ip: "203.0.113.9" });
            c.topics.get(T.AUTH_REVOKED)!({ entries: [{ fid: "123e4567-e89b-42d3-a456-426614174000", untilMs: future }] });
            c.topics.get(T.AUTH_SYNC)!({ entries: [] });
            c.topics.get(T.SCHED_SYNC)!({ entries: [] });
        }).not.toThrow();
    });
});
