import { ClusterSupervisor } from "../../../src/utils/cluster/ClusterSupervisor";
import { ClusterRpcHub } from "../../../src/utils/cluster/ClusterRpcHub";
import { PrimaryStateServices } from "../../../src/utils/cluster/PrimaryStateServices";
import { CLUSTER_IPC, CLUSTER_RPC_METHODS as M, CLUSTER_RPC_ERROR_CODES as E, CLUSTER_TOPICS as T } from "../../../src/constants/clusterIpc";
import { makeSupervisorDeps } from "../helpers/fakeCluster";

/** A real supervisor + hub + primary state over fake workers. */
function boot(numWorkers = 3) {
    const ctx = makeSupervisorDeps({ numWorkers });
    const hub: ClusterRpcHub = new ClusterRpcHub({
        logger: ctx.logger,
        getLiveWorkers: () => sup.getLiveWorkers() as any,
        getLeader: () => sup.getLeader() as any,
        now: ctx.deps.now,
    });
    const state = new PrimaryStateServices({ logger: ctx.logger, now: ctx.deps.now });
    state.attach(hub);
    const sup = new ClusterSupervisor({ ...ctx.deps, rpcHub: hub });
    sup.start();
    const w = (i: number) => ctx.cluster.workers[i];
    const lastTo = (worker: any) => worker.sent.at(-1);
    return { ...ctx, sup, hub, state, w, lastTo };
}

describe("cluster supervisor + hub reliability", () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it("a leader that dies mid-call answers the asker NO_LEADER, then the respawned leader serves the next call", async () => {
        const { cluster, hub, w, lastTo, sup } = boot();
        cluster.emit("message", w(1), { cmd: CLUSTER_IPC.RPC_REQUEST, id: "a1", target: "leader", method: M.ALERTS_STATUS, args: {} });
        expect(lastTo(w(0)).cmd).toBe(CLUSTER_IPC.RPC_CALL);
        cluster.emit("exit", w(0), null, "SIGKILL");
        expect(lastTo(w(1))).toMatchObject({ id: "a1", ok: false, error: { code: E.NO_LEADER } });
        expect(hub.pendingCount).toBe(0);

        await vi.advanceTimersByTimeAsync(ClusterSupervisor.BACKOFF_BASE_MS);
        const newLeader = sup.getLeader();
        expect(newLeader).toBe(w(3));
        cluster.emit("message", w(1), { cmd: CLUSTER_IPC.RPC_REQUEST, id: "a2", target: "leader", method: M.ALERTS_STATUS, args: {} });
        const call = lastTo(w(3));
        cluster.emit("message", w(3), { cmd: CLUSTER_IPC.RPC_RETURN, callId: call.callId, ok: true, result: { status: "fine" } });
        expect(lastTo(w(1))).toMatchObject({ id: "a2", ok: true, result: { status: "fine" } });
    });

    it("while the leader slot is empty (respawn pending) leader calls fail fast instead of hanging", () => {
        const { cluster, w, lastTo } = boot();
        cluster.emit("exit", w(0), 1, null);
        cluster.emit("message", w(2), { cmd: CLUSTER_IPC.RPC_REQUEST, id: "x", target: "leader", method: M.ALERTS_ACKS, args: {} });
        expect(lastTo(w(2)).error.code).toBe(E.NO_LEADER);
    });

    it("a worker that crashes before answering a metrics gather is reported missing, not waited for", () => {
        const { cluster, w, lastTo } = boot();
        cluster.emit("message", w(0), { cmd: CLUSTER_IPC.RPC_REQUEST, id: "g", target: "all", method: M.METRICS_SNAPSHOT, args: {} });
        const callIds = [w(0), w(1), w(2)].map((x) => x.sent.at(-1).callId);
        cluster.emit("message", w(0), { cmd: CLUSTER_IPC.RPC_RETURN, callId: callIds[0], ok: true, result: { snapshot: 1 } });
        cluster.emit("message", w(1), { cmd: CLUSTER_IPC.RPC_RETURN, callId: callIds[1], ok: true, result: { snapshot: 2 } });
        cluster.emit("exit", w(2), 1, null);
        expect(lastTo(w(0))).toMatchObject({ id: "g", ok: true });
        expect(lastTo(w(0)).result.missing).toEqual([3]);
        expect(lastTo(w(0)).result.parts).toHaveLength(2);
    });

    it("a replacement worker that starts listening is brought up to date with blocks, scheduler state and revoked sessions", async () => {
        const { cluster, w, sup } = boot(2);
        const future = Date.now() + 3_600_000;
        for (let i = 0; i < 300; i++) cluster.emit("message", w(1), { cmd: CLUSTER_IPC.NOTIFY, method: M.SF_STRIKE, args: { ip: "9.9.9.9" } });
        cluster.emit("message", w(1), { cmd: CLUSTER_IPC.NOTIFY, method: M.SCHED_RECORD, args: { job: "dbBackup", outcome: { label: "L", status: "ok", at: new Date().toISOString() } } });
        cluster.emit("message", w(1), { cmd: CLUSTER_IPC.NOTIFY, method: M.AUTH_REVOKE, args: { entries: [{ fid: "123e4567-e89b-42d3-a456-426614174000", untilMs: future }] } });
        await vi.advanceTimersByTimeAsync(0);
        cluster.emit("exit", w(1), 1, null);
        await vi.advanceTimersByTimeAsync(ClusterSupervisor.BACKOFF_BASE_MS);
        const fresh = sup.getLiveWorkers().at(-1) as any;
        fresh.sent.length = 0;
        cluster.emit("listening", fresh);
        const topics = fresh.sent.map((m: any) => m.topic).sort();
        expect(topics).toEqual([T.AUTH_SYNC, T.SCHED_SYNC, T.SF_SYNC].sort());
    });

    it("a worker that exits is removed from the live set before anything is sent to it again", async () => {
        const { cluster, hub, w, sup } = boot();
        cluster.emit("exit", w(2), 1, null);
        const before = w(2).sent.length;
        hub.broadcast(T.RECIPIENTS_INVALIDATE, {});
        expect(w(2).sent).toHaveLength(before);
        expect(sup.liveCount).toBe(2);
    });
});
