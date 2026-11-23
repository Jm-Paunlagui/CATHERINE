import { CLUSTER_IPC, CLUSTER_RPC_METHODS as M, CLUSTER_RPC_ERROR_CODES as E, CLUSTER_RPC_TIMEOUTS, CLUSTER_RPC_LIMITS } from "../../../src/constants/clusterIpc";
import { ClusterRpcClient, ClusterRpcError } from "../../../src/utils/cluster/ClusterRpcClient";
import { ClusterRpcHub } from "../../../src/utils/cluster/ClusterRpcHub";

type Msg = Record<string, any>;

/** Fake IPC link between one worker-side client and a primary-side hub. */
function makeLink() {
    const toPrimary: Msg[] = [];
    const toWorker: Msg[] = [];
    let listener: ((m: unknown) => void) | null = null;
    const link = { dropToPrimary: false, dropToWorker: false, sendThrows: false };
    const proc: any = {
        on: (_e: string, fn: (m: unknown) => void) => { listener = fn; },
        off: () => { listener = null; },
        send: (m: Msg) => {
            if (link.sendThrows) throw new Error("EPIPE");
            toPrimary.push(m);
            if (!link.dropToPrimary) hub.handleMessage(worker, m);
        },
    };
    const worker = {
        id: 1,
        send: (m: Msg) => {
            toWorker.push(m);
            if (!link.dropToWorker) listener?.(m);
        },
    };
    const logger = { warning: vi.fn() };
    const hub = new ClusterRpcHub({ logger, getLiveWorkers: () => [worker], getLeader: () => worker, now: () => Date.now() });
    const client = new ClusterRpcClient();
    client._canSend = () => true;
    client._proc = proc;
    client.init();
    return { client, hub, worker, link, logger, toPrimary, toWorker, deliver: (m: Msg) => listener?.(m) };
}

const HIT = { label: "login", key: "k", max: 5, windowMs: 60_000 };
const settle = (p: Promise<unknown>) => p.then((value) => ({ value }), (error) => ({ error }));

describe("cluster RPC chaos", () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it("healthy round trip resolves and clears the pending entry", async () => {
        const { client, hub } = makeLink();
        hub.register(M.RL_HIT, () => ({ allowed: true, count: 1, remaining: 4, resetAt: 1 }));
        const p = settle(client.call("primary", M.RL_HIT, HIT));
        await vi.advanceTimersByTimeAsync(0);
        expect(await p).toEqual({ value: { allowed: true, count: 1, remaining: 4, resetAt: 1 } });
        expect(client.pendingCount).toBe(0);
        client.reset();
    });

    it("silent primary: call rejects with TIMEOUT after the timeout and frees the slot", async () => {
        const { client, link } = makeLink();
        link.dropToPrimary = true;
        const p = settle(client.call("primary", M.RL_HIT, HIT, { timeoutMs: CLUSTER_RPC_TIMEOUTS.RL_HIT_MS }));
        expect(client.pendingCount).toBe(1);
        await vi.advanceTimersByTimeAsync(CLUSTER_RPC_TIMEOUTS.RL_HIT_MS - 1);
        expect(client.pendingCount).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        const r: any = await p;
        expect(r.error).toBeInstanceOf(ClusterRpcError);
        expect(r.error.code).toBe(E.TIMEOUT);
        expect(client.pendingCount).toBe(0);
        client.reset();
    });

    it("caller can fall open: a timeout is a typed error it can map to a fallback", async () => {
        const { client, link } = makeLink();
        link.dropToPrimary = true;
        const guarded = async () => {
            try {
                return await client.call("primary", M.RL_HIT, HIT, { timeoutMs: 100 });
            } catch (err: any) {
                if (err.code === E.TIMEOUT) return { fallback: true };
                throw err;
            }
        };
        const p = guarded();
        await vi.advanceTimersByTimeAsync(100);
        expect(await p).toEqual({ fallback: true });
        client.reset();
    });

    it("lost reply (primary processed, response dropped) times out on the worker", async () => {
        const { client, hub, link } = makeLink();
        const handler = vi.fn(() => ({ allowed: true, count: 1, remaining: 4, resetAt: 1 }));
        hub.register(M.RL_HIT, handler);
        link.dropToWorker = true;
        const p = settle(client.call("primary", M.RL_HIT, HIT, { timeoutMs: 100 }));
        await vi.advanceTimersByTimeAsync(100);
        expect(handler).toHaveBeenCalledTimes(1);
        expect(((await p) as any).error.code).toBe(E.TIMEOUT);
        expect(client.pendingCount).toBe(0);
        client.reset();
    });

    it("late reply after the timeout is ignored and does not throw", async () => {
        const { client, link, toPrimary, deliver } = makeLink();
        link.dropToPrimary = true;
        const p = settle(client.call("primary", M.RL_HIT, HIT, { timeoutMs: 100 }));
        await vi.advanceTimersByTimeAsync(100);
        expect(((await p) as any).error.code).toBe(E.TIMEOUT);
        const id = toPrimary[0].id;
        expect(() => deliver({ cmd: CLUSTER_IPC.RPC_RESPONSE, id, ok: true, result: { allowed: true, count: 1, remaining: 1, resetAt: 1 } })).not.toThrow();
        expect(client.pendingCount).toBe(0);
        client.reset();
    });

    it("duplicate reply is ignored: only the first settles the call", async () => {
        const { client, link, toPrimary, deliver } = makeLink();
        link.dropToPrimary = true;
        const p = settle(client.call("primary", M.RL_HIT, HIT));
        const id = toPrimary[0].id;
        const ok = { allowed: true, count: 1, remaining: 4, resetAt: 1 };
        deliver({ cmd: CLUSTER_IPC.RPC_RESPONSE, id, ok: true, result: ok });
        deliver({ cmd: CLUSTER_IPC.RPC_RESPONSE, id, ok: false, error: { code: E.HANDLER_ERROR, message: "x" } });
        expect(await p).toEqual({ value: ok });
        client.reset();
    });

    it("reply with an invalid result is rejected, not trusted", async () => {
        const { client, link, toPrimary, deliver } = makeLink();
        link.dropToPrimary = true;
        const p = settle(client.call("primary", M.RL_HIT, HIT));
        deliver({ cmd: CLUSTER_IPC.RPC_RESPONSE, id: toPrimary[0].id, ok: true, result: { allowed: "maybe" } });
        expect(((await p) as any).error.code).toBe(E.HANDLER_ERROR);
        client.reset();
    });

    it("garbage inbound messages are ignored", async () => {
        const { client, deliver } = makeLink();
        for (const m of [null, 5, "x", [], { cmd: "weird" }, { cmd: CLUSTER_IPC.RPC_RESPONSE }, { cmd: CLUSTER_IPC.RPC_RESPONSE, id: {} }]) {
            expect(() => deliver(m as any)).not.toThrow();
        }
        expect(client.pendingCount).toBe(0);
        client.reset();
    });

    it("send failure (broken channel) rejects immediately with REJECTED", async () => {
        const { client, link } = makeLink();
        link.sendThrows = true;
        const r: any = await settle(client.call("primary", M.RL_HIT, HIT));
        expect(r.error.code).toBe(E.REJECTED);
        expect(client.pendingCount).toBe(0);
        expect(client.notify(M.RL_CLEAR, { label: "x" })).toBe(false);
        client.reset();
    });

    it("pending cap rejects with OVERLOAD instead of growing unbounded", async () => {
        const { client, link } = makeLink();
        link.dropToPrimary = true;
        const pending: Promise<unknown>[] = [];
        for (let i = 0; i < CLUSTER_RPC_LIMITS.MAX_PENDING_PER_CLIENT; i++) pending.push(settle(client.call("primary", M.RL_HIT, HIT)));
        const over: any = await settle(client.call("primary", M.RL_HIT, HIT));
        expect(over.error.code).toBe(E.OVERLOAD);
        await vi.advanceTimersByTimeAsync(CLUSTER_RPC_TIMEOUTS.DEFAULT_MS);
        await Promise.all(pending);
        expect(client.pendingCount).toBe(0);
        client.reset();
    });

    it("reset fails everything pending with no leaked timers", async () => {
        const { client, link } = makeLink();
        link.dropToPrimary = true;
        const p = settle(client.call("primary", M.RL_HIT, HIT));
        client.reset();
        expect(((await p) as any).error.code).toBe(E.REJECTED);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("hub handler that never settles: worker times out, hub keeps serving others", async () => {
        const { client, hub } = makeLink();
        let first = true;
        hub.register(M.RL_HIT, () => (first ? ((first = false), new Promise(() => undefined)) : { allowed: true, count: 1, remaining: 4, resetAt: 1 }));
        const stuck = settle(client.call("primary", M.RL_HIT, HIT, { timeoutMs: 100 }));
        const fine = settle(client.call("primary", M.RL_HIT, HIT, { timeoutMs: 100 }));
        await vi.advanceTimersByTimeAsync(100);
        expect(((await stuck) as any).error.code).toBe(E.TIMEOUT);
        expect(((await fine) as any).value.allowed).toBe(true);
        client.reset();
    });

    it("hub handler error is relayed generically, never leaking internals", async () => {
        const { client, hub, logger } = makeLink();
        hub.register(M.RL_HIT, () => { throw new Error("secret internals"); });
        const r: any = await settle(client.call("primary", M.RL_HIT, HIT));
        expect(r.error.code).toBe(E.HANDLER_ERROR);
        expect(r.error.message).toBe("handler failed");
        expect(logger.warning).toHaveBeenCalled();
        client.reset();
    });

    it("hub: invalid request gets an immediate REJECTED reply (no wait for timeout)", async () => {
        const { client, hub, worker, toWorker } = makeLink();
        hub.handleMessage(worker, { cmd: CLUSTER_IPC.RPC_REQUEST, id: "z", target: "primary", method: "evil", args: {} });
        expect(toWorker.at(-1)).toMatchObject({ cmd: CLUSTER_IPC.RPC_RESPONSE, id: "z", ok: false, error: { code: E.REJECTED } });
        client.reset();
    });

    it("hub: silent leader times out the forwarded call", async () => {
        const logger = { warning: vi.fn() };
        const sent: Msg[] = [];
        const leader = { id: 2, send: (m: Msg) => { sent.push(m); } };
        const asker = { id: 1, send: vi.fn() };
        const hub = new ClusterRpcHub({ logger, getLiveWorkers: () => [asker, leader], getLeader: () => leader });
        hub.handleMessage(asker, { cmd: CLUSTER_IPC.RPC_REQUEST, id: "a1", target: "leader", method: M.ALERTS_STATUS, args: {} });
        expect(hub.pendingCount).toBe(1);
        await vi.advanceTimersByTimeAsync(CLUSTER_RPC_TIMEOUTS.LEADER_FORWARD_MS);
        expect(asker.send).toHaveBeenCalledWith(expect.objectContaining({ id: "a1", ok: false, error: expect.objectContaining({ code: E.TIMEOUT }) }));
        expect(hub.pendingCount).toBe(0);
        // A late return from the leader afterwards is dropped, not forwarded.
        asker.send.mockClear();
        hub.handleMessage(leader, { cmd: CLUSTER_IPC.RPC_RETURN, callId: sent[0].callId, ok: true, result: {} });
        expect(asker.send).not.toHaveBeenCalled();
    });

    it("hub: return from the wrong worker is refused", () => {
        const logger = { warning: vi.fn() };
        const sent: Msg[] = [];
        const leader = { id: 2, send: (m: Msg) => { sent.push(m); } };
        const asker = { id: 1, send: vi.fn() };
        const hub = new ClusterRpcHub({ logger, getLiveWorkers: () => [asker, leader], getLeader: () => leader });
        hub.handleMessage(asker, { cmd: CLUSTER_IPC.RPC_REQUEST, id: "a1", target: "leader", method: M.ALERTS_STATUS, args: {} });
        hub.handleMessage(asker, { cmd: CLUSTER_IPC.RPC_RETURN, callId: sent[0].callId, ok: true, result: {} });
        expect(asker.send).not.toHaveBeenCalled();
        expect(hub.pendingCount).toBe(1);
    });

    it("hub: gather with one silent worker finishes at GATHER_MS reporting it missing", async () => {
        const logger = { warning: vi.fn() };
        const sent: Record<number, Msg[]> = { 1: [], 2: [] };
        const w1 = { id: 1, send: vi.fn((m: Msg) => { sent[1].push(m); }) };
        const w2 = { id: 2, send: (m: Msg) => { sent[2].push(m); } };
        const hub = new ClusterRpcHub({ logger, getLiveWorkers: () => [w1, w2], getLeader: () => w1 });
        hub.handleMessage(w1, { cmd: CLUSTER_IPC.RPC_REQUEST, id: "g1", target: "all", method: M.METRICS_SNAPSHOT, args: {} });
        hub.handleMessage(w1, { cmd: CLUSTER_IPC.RPC_RETURN, callId: sent[1][0].callId, ok: true, result: { m: 1 } });
        await vi.advanceTimersByTimeAsync(CLUSTER_RPC_TIMEOUTS.GATHER_MS);
        const res = w1.send.mock.calls.map((c) => c[0]).find((m: Msg) => m.cmd === CLUSTER_IPC.RPC_RESPONSE) as Msg;
        expect(res.ok).toBe(true);
        expect(res.result.missing).toEqual([2]);
        expect(res.result.parts).toHaveLength(1);
        expect(hub.pendingCount).toBe(0);
    });

    it("hub: worker exit while a leader call is pending answers NO_LEADER", () => {
        const logger = { warning: vi.fn() };
        const leader = { id: 2, send: vi.fn() };
        const asker = { id: 1, send: vi.fn() };
        const hub = new ClusterRpcHub({ logger, getLiveWorkers: () => [asker, leader], getLeader: () => leader });
        hub.handleMessage(asker, { cmd: CLUSTER_IPC.RPC_REQUEST, id: "a1", target: "leader", method: M.ALERTS_STATUS, args: {} });
        hub.onWorkerExit(leader);
        expect(asker.send).toHaveBeenCalledWith(expect.objectContaining({ id: "a1", ok: false, error: expect.objectContaining({ code: E.NO_LEADER }) }));
        expect(hub.pendingCount).toBe(0);
    });

    it("hub: reject log is throttled to once per gap", () => {
        let now = 0;
        const logger = { warning: vi.fn() };
        const w = { id: 1, send: vi.fn() };
        const hub = new ClusterRpcHub({ logger, getLiveWorkers: () => [w], getLeader: () => w, now: () => now });
        for (let i = 0; i < 5; i++) hub.handleMessage(w, { cmd: CLUSTER_IPC.RPC_REQUEST, id: String(i), target: "x", method: "y" });
        expect(logger.warning).toHaveBeenCalledTimes(1);
        now += CLUSTER_RPC_LIMITS.REJECT_LOG_GAP_MS;
        hub.handleMessage(w, { cmd: CLUSTER_IPC.RPC_REQUEST, id: "late", target: "x", method: "y" });
        expect(logger.warning).toHaveBeenCalledTimes(2);
    });
});
