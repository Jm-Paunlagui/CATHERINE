import { ClusterRpcClient, ClusterRpcError, clusterRpc } from "../../../../src/utils/cluster/ClusterRpcClient";
import { CLUSTER_IPC, CLUSTER_RPC_METHODS as M, CLUSTER_RPC_ERROR_CODES as E, CLUSTER_TOPICS, CLUSTER_RPC_TIMEOUTS } from "../../../../src/constants/clusterIpc";
import { AppError } from "../../../../src/constants/errors";
import { HTTP_STATUS } from "../../../../src/constants";

type Msg = Record<string, any>;

function mk(opts: { canSend?: boolean } = {}) {
    const sent: Msg[] = [];
    let listener: ((m: unknown) => void) | null = null;
    const ctl = { throws: false, failOnUnserialisable: false };
    const proc: any = {
        on: vi.fn((_e: string, fn: any) => { listener = fn; }),
        off: vi.fn(() => { listener = null; }),
        send: (m: Msg) => {
            if (ctl.throws) throw new Error("EPIPE");
            if (ctl.failOnUnserialisable && m.cmd === CLUSTER_IPC.RPC_RETURN && m.ok && m.result?.bad) throw new Error("DataCloneError");
            sent.push(m);
        },
    };
    const client = new ClusterRpcClient();
    client._canSend = () => opts.canSend ?? true;
    client._proc = proc;
    return { client, proc, sent, ctl, deliver: (m: unknown) => listener?.(m), hasListener: () => listener !== null };
}

describe("ClusterRpcClient", () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    describe("lifecycle", () => {
        it("is inactive and does not install a listener when IPC is unavailable", async () => {
            const { client, proc, sent } = mk({ canSend: false });
            expect(client.init()).toBe(false);
            expect(client.active).toBe(false);
            expect(proc.on).not.toHaveBeenCalled();
            await expect(client.call("primary", M.RL_CLEAR)).rejects.toMatchObject({ code: E.REJECTED });
            expect(client.notify(M.RL_CLEAR)).toBe(false);
            expect(sent).toHaveLength(0);
        });

        it("init installs once, records leadership, and a second init is a no-op", () => {
            const { client, proc } = mk();
            expect(client.init({ isLeader: true })).toBe(true);
            expect(client.isLeader).toBe(true);
            expect(client.init()).toBe(false);
            expect(proc.on).toHaveBeenCalledTimes(1);
        });

        it("a process without off() can still reset", () => {
            const { client, proc } = mk();
            client.init();
            delete proc.off;
            expect(() => client.reset()).not.toThrow();
            expect(client.active).toBe(false);
        });

        it("reset clears handlers and topics so nothing fires afterwards", () => {
            const { client, deliver } = mk();
            client.init();
            const fn = vi.fn();
            client.onTopic(CLUSTER_TOPICS.RECIPIENTS_INVALIDATE, fn);
            client.reset();
            deliver({ cmd: CLUSTER_IPC.BROADCAST, topic: CLUSTER_TOPICS.RECIPIENTS_INVALIDATE, payload: {} });
            expect(fn).not.toHaveBeenCalled();
        });

        it("the exported singleton is inactive outside a cluster worker", () => {
            expect(clusterRpc.active).toBe(false);
        });
    });

    describe("call", () => {
        it("leader call from the leader runs the local handler with no IPC", async () => {
            const { client, sent } = mk();
            client.init({ isLeader: true });
            client.handle(M.ALERTS_STATUS, () => ({ local: true }));
            await expect(client.call("leader", M.ALERTS_STATUS)).resolves.toEqual({ local: true });
            expect(sent).toHaveLength(0);
        });

        it("leader call from the leader without a local handler is NO_LEADER", async () => {
            const { client } = mk();
            client.init({ isLeader: true });
            await expect(client.call("leader", M.ALERTS_STATUS)).rejects.toMatchObject({ code: E.NO_LEADER });
        });

        it("sends the request envelope and resolves on a matching response", async () => {
            const { client, sent, deliver } = mk();
            client.init();
            const p = client.call("primary", M.SF_UNBLOCK, { ip: "1.1.1.1" });
            expect(sent[0]).toMatchObject({ cmd: CLUSTER_IPC.RPC_REQUEST, target: "primary", method: M.SF_UNBLOCK, args: { ip: "1.1.1.1" } });
            deliver({ cmd: CLUSTER_IPC.RPC_RESPONSE, id: sent[0].id, ok: true, result: { cleared: true } });
            await expect(p).resolves.toEqual({ cleared: true });
        });

        it("default timeout is DEFAULT_MS", async () => {
            const { client } = mk();
            client.init();
            const p = client.call("primary", M.RL_CLEAR).catch((e) => e);
            await vi.advanceTimersByTimeAsync(CLUSTER_RPC_TIMEOUTS.DEFAULT_MS);
            expect((await p).code).toBe(E.TIMEOUT);
        });
    });

    describe("responses", () => {
        const failWith = async (error: unknown) => {
            const { client, sent, deliver } = mk();
            client.init();
            const p = client.call("primary", M.RL_CLEAR).catch((e) => e);
            deliver({ cmd: CLUSTER_IPC.RPC_RESPONSE, id: sent[0].id, ok: false, error });
            return (await p) as ClusterRpcError;
        };

        it("known error code, message and appError are rehydrated and clamped", async () => {
            const err = await failWith({ code: E.OVERLOAD, message: "m".repeat(900), appError: { statusCode: 429, message: "a".repeat(900), type: "T".repeat(100) } });
            expect(err).toBeInstanceOf(ClusterRpcError);
            expect(err.code).toBe(E.OVERLOAD);
            expect(err.message).toHaveLength(500);
            expect(err.appError!.message).toHaveLength(500);
            expect(err.appError!.type).toHaveLength(64);
        });

        it("an unknown code becomes HANDLER_ERROR; a missing message becomes 'error'", async () => {
            const err = await failWith({ code: "WAT" });
            expect(err.code).toBe(E.HANDLER_ERROR);
            expect(err.message).toBe("error");
            expect(err.appError).toBeUndefined();
        });

        it("a non-object error is tolerated", async () => {
            const err = await failWith("oops");
            expect(err.code).toBe(E.HANDLER_ERROR);
        });

        it("appError with a bad status or no message is dropped; non-string type defaults to AppError", async () => {
            expect((await failWith({ appError: { statusCode: 1.5, message: "m" } })).appError).toBeUndefined();
            expect((await failWith({ appError: { statusCode: 400 } })).appError).toBeUndefined();
            expect((await failWith({ appError: { statusCode: 400, message: "m", type: 7 } })).appError!.type).toBe("AppError");
        });

        it("responses with a non-string or unknown id are ignored", async () => {
            const { client, sent, deliver } = mk();
            client.init();
            const p = client.call("primary", M.RL_CLEAR);
            deliver({ cmd: CLUSTER_IPC.RPC_RESPONSE, id: 5, ok: true, result: null });
            deliver({ cmd: CLUSTER_IPC.RPC_RESPONSE, id: "unknown", ok: true, result: null });
            expect(client.pendingCount).toBe(1);
            deliver({ cmd: CLUSTER_IPC.RPC_RESPONSE, id: sent[0].id, ok: true, result: null });
            await expect(p).resolves.toBeNull();
        });

        it("unknown cmd is ignored", () => {
            const { client, deliver } = mk();
            client.init();
            expect(() => deliver({ cmd: "app:other" })).not.toThrow();
        });
    });

    describe("notify", () => {
        it("returns true when sent and false when the channel is broken", () => {
            const { client, sent, ctl } = mk();
            client.init();
            expect(client.notify(M.RL_CLEAR, { label: "x" })).toBe(true);
            expect(sent[0]).toMatchObject({ cmd: CLUSTER_IPC.NOTIFY, method: M.RL_CLEAR });
            ctl.throws = true;
            expect(client.notify(M.RL_CLEAR)).toBe(false);
        });
    });

    describe("primary -> worker calls (handle)", () => {
        const call = (callId: unknown, method: unknown, args?: unknown) => ({ cmd: CLUSTER_IPC.RPC_CALL, callId, method, args });

        it("runs the handler and returns its result; undefined becomes null", async () => {
            const { client, sent, deliver } = mk();
            client.init();
            client.handle(M.METRICS_SNAPSHOT, () => ({ snap: 1 }));
            deliver(call("c1", M.METRICS_SNAPSHOT));
            await vi.advanceTimersByTimeAsync(0);
            expect(sent[0]).toEqual({ cmd: CLUSTER_IPC.RPC_RETURN, callId: "c1", ok: true, result: { snap: 1 } });
            client.handle(M.ALERTS_STATUS, () => undefined);
            deliver(call("c2", M.ALERTS_STATUS, null));
            await vi.advanceTimersByTimeAsync(0);
            expect(sent[1].result).toBeNull();
        });

        it("rejects a method with no handler, a non-allow-listed method, and bad args", async () => {
            const { client, sent, deliver } = mk();
            client.init();
            client.handle("not.a.method", () => ({}));
            client.handle(M.ALERTS_ACK, () => ({}));
            deliver(call("a", M.ALERTS_STATUS));
            deliver(call("b", "not.a.method"));
            deliver(call("c", 12));
            deliver(call("d", M.ALERTS_ACK, { alertKey: "" }));
            expect(sent.map((m) => m.error.message)).toEqual(["no handler", "no handler", "no handler", "bad-alert-key"]);
            expect(sent.every((m) => m.error.code === E.REJECTED)).toBe(true);
        });

        it("ignores a call without a usable callId", () => {
            const { client, sent, deliver } = mk();
            client.init();
            client.handle(M.ALERTS_STATUS, () => ({}));
            deliver(call(undefined, M.ALERTS_STATUS));
            deliver(call("x".repeat(65), M.ALERTS_STATUS));
            expect(sent).toHaveLength(0);
        });

        it("a throwing handler returns a generic error; an operational one carries appError", async () => {
            const { client, sent, deliver } = mk();
            client.init();
            client.handle(M.ALERTS_STATUS, () => { throw new Error("secret stack detail"); });
            client.handle(M.ALERTS_ACKS, () => { throw Object.assign(new Error("not allowed"), { isOperational: true, statusCode: 403, name: "AppError" }); });
            client.handle(M.ALERTS_UNACK, () => Promise.reject(null));
            deliver(call("e1", M.ALERTS_STATUS));
            deliver(call("e2", M.ALERTS_ACKS));
            deliver(call("e3", M.ALERTS_UNACK, { alertKey: "k" }));
            await vi.advanceTimersByTimeAsync(0);
            expect(sent[0].error).toEqual({ code: E.HANDLER_ERROR, message: "handler failed" });
            expect(sent[1].error).toMatchObject({ message: "not allowed", appError: { statusCode: 403, type: "AppError" } });
            expect(sent[2].error.message).toBe("handler failed");
        });

        it("operational error with a non-string name falls back to AppError type", async () => {
            const { client, sent, deliver } = mk();
            client.init();
            client.handle(M.ALERTS_STATUS, () => { const e: any = new Error("x"); e.isOperational = true; e.statusCode = 400; e.name = 1; throw e; });
            deliver(call("n", M.ALERTS_STATUS));
            await vi.advanceTimersByTimeAsync(0);
            expect(sent[0].error.appError.type).toBe("AppError");
        });

        it("an unserialisable result is reported as a failure instead of leaving the primary waiting", async () => {
            const { client, sent, deliver, ctl } = mk();
            client.init();
            ctl.failOnUnserialisable = true;
            client.handle(M.ALERTS_STATUS, () => ({ bad: true }));
            deliver(call("u", M.ALERTS_STATUS));
            await vi.advanceTimersByTimeAsync(0);
            expect(sent).toHaveLength(1);
            expect(sent[0]).toMatchObject({ ok: false, error: { message: "unserialisable result" } });
        });

        it("a broken channel on a failure reply does not recurse", async () => {
            const { client, sent, deliver, ctl } = mk();
            client.init();
            ctl.throws = true;
            client.handle(M.ALERTS_STATUS, () => { throw new Error("x"); });
            deliver(call("z", M.ALERTS_STATUS));
            await vi.advanceTimersByTimeAsync(0);
            expect(sent).toHaveLength(0);
        });
    });

    describe("broadcast topics", () => {
        const bc = (topic: unknown, payload: unknown) => ({ cmd: CLUSTER_IPC.BROADCAST, topic, payload });

        it("dispatches a validated payload to its listener", () => {
            const { client, deliver } = mk();
            client.init();
            const fn = vi.fn();
            client.onTopic(CLUSTER_TOPICS.SF_UNBLOCKED, fn);
            deliver(bc(CLUSTER_TOPICS.SF_UNBLOCKED, { ip: "9.9.9.9" }));
            expect(fn).toHaveBeenCalledWith({ ip: "9.9.9.9" });
        });

        it("drops unknown topics, non-string topics and invalid payloads", () => {
            const { client, deliver } = mk();
            client.init();
            const fn = vi.fn();
            client.onTopic(CLUSTER_TOPICS.SF_UNBLOCKED, fn);
            deliver(bc("nope", {}));
            deliver(bc(7, {}));
            deliver(bc(CLUSTER_TOPICS.SF_UNBLOCKED, { ip: "<script>" }));
            expect(fn).not.toHaveBeenCalled();
        });

        it("a throwing listener never breaks the IPC listener", () => {
            const { client, deliver } = mk();
            client.init();
            client.onTopic(CLUSTER_TOPICS.RECIPIENTS_INVALIDATE, () => { throw new Error("x"); });
            expect(() => deliver(bc(CLUSTER_TOPICS.RECIPIENTS_INVALIDATE, {}))).not.toThrow();
        });
    });

    describe("toAppError", () => {
        it("rehydrates the leader's status and message when the status is a known HTTP status", () => {
            const e = ClusterRpcClient.toAppError(new ClusterRpcError(E.HANDLER_ERROR, "x", { statusCode: 404, message: "Alert not found", type: "NotFound" }), "fallback");
            expect(e).toBeInstanceOf(AppError);
            expect(e.statusCode).toBe(404);
            expect(e.message).toBe("Alert not found");
        });

        it("an unknown status or missing appError becomes a generic 503", () => {
            const a = ClusterRpcClient.toAppError(new ClusterRpcError(E.TIMEOUT, "x", { statusCode: 799, message: "m", type: "t" }), "Cluster unavailable");
            expect(a.statusCode).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
            expect(a.message).toBe("Cluster unavailable");
            const b = ClusterRpcClient.toAppError(new Error("plain"), "fb");
            expect(b.statusCode).toBe(HTTP_STATUS.SERVICE_UNAVAILABLE);
            const c = ClusterRpcClient.toAppError(undefined as any, "fb");
            expect(c.message).toBe("fb");
        });
    });
});
