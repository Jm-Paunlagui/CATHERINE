import { ClusterRpcHub, buildError, METHOD_TARGET } from "../../../../src/utils/cluster/ClusterRpcHub";
import { CLUSTER_IPC, CLUSTER_RPC_METHODS as M, CLUSTER_RPC_ERROR_CODES as E, CLUSTER_RPC_TIMEOUTS, CLUSTER_RPC_LIMITS, CLUSTER_TOPICS } from "../../../../src/constants/clusterIpc";

type Msg = Record<string, any>;

function mkWorker(id: number, pid = 100 + id) {
    const w: any = { id, process: { pid }, sent: [] as Msg[], throws: false };
    w.send = (m: Msg) => { if (w.throws) throw new Error("EPIPE"); w.sent.push(m); };
    return w;
}

function setup(n = 3) {
    const workers = Array.from({ length: n }, (_, i) => mkWorker(i + 1));
    let live = [...workers];
    let leader: any = workers[0];
    const clock = { t: 0 };
    const logger = { warning: vi.fn() };
    const hub = new ClusterRpcHub({ logger, getLiveWorkers: () => live, getLeader: () => leader, now: () => clock.t });
    return {
        hub, workers, logger, clock,
        setLive: (l: any[]) => { live = l; },
        setLeader: (l: any) => { leader = l; },
        last: (w: any) => w.sent.at(-1) as Msg,
    };
}

const req = (id: string, target: string, method: string, args: Msg = {}) => ({ cmd: CLUSTER_IPC.RPC_REQUEST, id, target, method, args });
const settle = async () => { await vi.advanceTimersByTimeAsync(0); };

describe("ClusterRpcHub", () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    describe("buildError", () => {
        it("truncates the message and exposes appError only for operational errors", () => {
            const long = "x".repeat(2000);
            expect(buildError("C", long).message).toHaveLength(CLUSTER_RPC_LIMITS.MAX_ERROR_MESSAGE);
            expect(buildError("C", "m", new Error("plain") as any).appError).toBeUndefined();
            const op: any = Object.assign(new Error("bad input"), { isOperational: true, statusCode: 422, name: "AppError" });
            expect(buildError("C", "m", op).appError).toEqual({ statusCode: 422, message: "bad input", type: "AppError" });
        });

        it("ignores a non-integer status and a non-string name falls back to AppError", () => {
            const frac: any = Object.assign(new Error("e"), { isOperational: true, statusCode: 4.5 });
            expect(buildError("C", "m", frac).appError).toBeUndefined();
            const noName: any = Object.assign(new Error("e"), { isOperational: true, statusCode: 400 });
            noName.name = 5;
            expect(buildError("C", "m", noName).appError!.type).toBe("AppError");
        });

        it("METHOD_TARGET covers every routed method", () => {
            expect(METHOD_TARGET.get(M.RL_HIT)).toBe("primary");
            expect(METHOD_TARGET.get(M.METRICS_SNAPSHOT)).toBe("all");
            expect(METHOD_TARGET.get(M.ALERTS_ACK)).toBe("leader");
        });
    });

    describe("handleMessage routing", () => {
        it("returns false for non-protocol messages and non-objects", () => {
            const { hub, workers } = setup();
            expect(hub.handleMessage(workers[0], { cmd: "app:other" })).toBe(false);
            expect(hub.handleMessage(workers[0], "str")).toBe(false);
            expect(hub.handleMessage(workers[0], null)).toBe(false);
        });

        it("an internal failure is swallowed, logged as rejected, and still claims the message", () => {
            const { hub, workers, logger } = setup();
            (hub as any)._getLiveWorkers = () => { throw new TypeError("boom"); };
            // a valid all-target request reaches _getLiveWorkers
            expect(hub.handleMessage(workers[0], req("a", "all", M.METRICS_SNAPSHOT))).toBe(true);
            expect(logger.warning).toHaveBeenCalledTimes(1);
            expect(String(logger.warning.mock.calls[0][0])).toContain("internal:TypeError");
        });

        it("an error without a name still logs a generic internal reason", () => {
            const { hub, workers, logger } = setup();
            (hub as any)._getLiveWorkers = () => { throw undefined; };
            hub.handleMessage(workers[0], req("a", "all", M.METRICS_SNAPSHOT));
            expect(String(logger.warning.mock.calls[0][0])).toContain("internal:error");
        });
    });

    describe("primary requests", () => {
        it("runs the registered handler and replies ok; undefined result becomes null", async () => {
            const { hub, workers, last } = setup();
            hub.register(M.RECIPIENTS_INVALIDATE, () => undefined);
            hub.register(M.SF_UNBLOCK, (a: any, ctx) => ({ cleared: a.ip === "1.2.3.4" && ctx.worker.id === 2 }));
            hub.handleMessage(workers[1], req("r1", "primary", M.SF_UNBLOCK, { ip: "1.2.3.4" }));
            await settle();
            expect(last(workers[1])).toMatchObject({ cmd: CLUSTER_IPC.RPC_RESPONSE, id: "r1", ok: true, result: { cleared: true } });
            hub.handleMessage(workers[1], req("r2", "primary", M.RECIPIENTS_INVALIDATE));
            await settle();
            expect(last(workers[1])).toMatchObject({ id: "r2", ok: true, result: null });
        });

        it("a missing handler yields a generic HANDLER_ERROR and a warning", async () => {
            const { hub, workers, last, logger } = setup();
            hub.handleMessage(workers[0], req("r", "primary", M.RECIPIENTS_INVALIDATE));
            await settle();
            expect(last(workers[0]).error.code).toBe(E.HANDLER_ERROR);
            expect(last(workers[0]).error.message).toBe("handler failed");
            expect(logger.warning).toHaveBeenCalled();
        });

        it("an operational AppError crosses back with its status, no warning logged", async () => {
            const { hub, workers, last, logger } = setup();
            hub.register(M.RECIPIENTS_INVALIDATE, () => { throw Object.assign(new Error("nope"), { isOperational: true, statusCode: 409, name: "AppError" }); });
            hub.handleMessage(workers[0], req("r", "primary", M.RECIPIENTS_INVALIDATE));
            await settle();
            expect(last(workers[0]).error).toMatchObject({ code: E.HANDLER_ERROR, message: "nope", appError: { statusCode: 409 } });
            expect(logger.warning).not.toHaveBeenCalled();
        });

        it("a handler that throws a non-error value is reported without leaking it", async () => {
            const { hub, workers, last } = setup();
            hub.register(M.RECIPIENTS_INVALIDATE, () => { throw undefined; });
            hub.handleMessage(workers[0], req("r", "primary", M.RECIPIENTS_INVALIDATE));
            await settle();
            expect(last(workers[0]).error.message).toBe("handler failed");
        });

        it("rejects a request whose target does not match the method", async () => {
            const { hub, workers, last } = setup();
            hub.handleMessage(workers[0], req("r", "leader", M.RECIPIENTS_INVALIDATE));
            expect(last(workers[0]).error).toMatchObject({ code: E.REJECTED, message: "method-target-mismatch" });
        });

        it("rejects invalid args with the validator reason", async () => {
            const { hub, workers, last } = setup();
            hub.handleMessage(workers[0], req("r", "primary", M.SF_UNBLOCK, { ip: "not an ip!" }));
            expect(last(workers[0]).error).toMatchObject({ code: E.REJECTED, message: "bad-ip" });
        });

        it("invalid envelope with a recoverable id is answered, one without an id is dropped", () => {
            const { hub, workers } = setup();
            hub.handleMessage(workers[0], { cmd: CLUSTER_IPC.RPC_REQUEST, id: "ok-id", target: "nowhere", method: M.RL_HIT });
            expect(workers[0].sent).toHaveLength(1);
            hub.handleMessage(workers[0], { cmd: CLUSTER_IPC.RPC_REQUEST, target: "primary", method: M.RL_HIT });
            hub.handleMessage(workers[0], { cmd: CLUSTER_IPC.RPC_REQUEST, id: "", target: "x", method: M.RL_HIT });
            hub.handleMessage(workers[0], { cmd: CLUSTER_IPC.RPC_REQUEST, id: "y".repeat(65), target: "x", method: M.RL_HIT });
            expect(workers[0].sent).toHaveLength(1);
        });

        it("a worker whose channel is broken does not stop the hub", async () => {
            const { hub, workers } = setup();
            hub.register(M.RECIPIENTS_INVALIDATE, () => null);
            workers[0].throws = true;
            hub.handleMessage(workers[0], req("r", "primary", M.RECIPIENTS_INVALIDATE));
            await settle();
            expect(workers[0].sent).toHaveLength(0);
        });
    });

    describe("notify", () => {
        const notify = (method: string, args: Msg = {}) => ({ cmd: CLUSTER_IPC.NOTIFY, method, args });

        it("runs a notify-capable handler without replying", async () => {
            const { hub, workers } = setup();
            const fn = vi.fn(() => null);
            hub.register(M.RECIPIENTS_INVALIDATE, fn);
            hub.handleMessage(workers[0], notify(M.RECIPIENTS_INVALIDATE));
            await settle();
            expect(fn).toHaveBeenCalledTimes(1);
            expect(workers[0].sent).toHaveLength(0);
        });

        it("a failing notify handler is swallowed and logged", async () => {
            const { hub, workers, logger } = setup();
            hub.register(M.RECIPIENTS_INVALIDATE, () => { throw new Error("x"); });
            hub.handleMessage(workers[0], notify(M.RECIPIENTS_INVALIDATE));
            await settle();
            expect(logger.warning).toHaveBeenCalled();
        });

        it("rejects request-reply methods, bad envelopes and bad args", async () => {
            const { hub, workers, logger, clock } = setup();
            const fn = vi.fn();
            hub.register(M.SF_UNBLOCK, fn);
            hub.handleMessage(workers[0], notify(M.SF_UNBLOCK, { ip: "1.1.1.1" }));
            expect(logger.warning.mock.calls.at(-1)![0]).toContain("not-notify-method");
            clock.t += 60_000;
            hub.handleMessage(workers[0], { cmd: CLUSTER_IPC.NOTIFY, method: "nope" });
            expect(logger.warning.mock.calls.at(-1)![0]).toContain("bad-method");
            clock.t += 60_000;
            hub.handleMessage(workers[0], notify(M.SF_STRIKE, { ip: "bad ip" }));
            expect(logger.warning.mock.calls.at(-1)![0]).toContain("bad-ip");
            await settle();
            expect(fn).not.toHaveBeenCalled();
        });
    });

    describe("leader forwarding", () => {
        it("forwards to the leader and relays its return to the asker", async () => {
            const { hub, workers, last } = setup();
            hub.handleMessage(workers[1], req("q", "leader", M.ALERTS_STATUS));
            const call = last(workers[0]);
            expect(call).toMatchObject({ cmd: CLUSTER_IPC.RPC_CALL, method: M.ALERTS_STATUS });
            expect(hub.pendingCount).toBe(1);
            hub.handleMessage(workers[0], { cmd: CLUSTER_IPC.RPC_RETURN, callId: call.callId, ok: true, result: { s: 1 } });
            expect(last(workers[1])).toMatchObject({ cmd: CLUSTER_IPC.RPC_RESPONSE, id: "q", ok: true, result: { s: 1 } });
            expect(hub.pendingCount).toBe(0);
        });

        it("relays a leader error through the sanitiser (clamps and drops malformed appError)", () => {
            const { hub, workers, last } = setup();
            hub.handleMessage(workers[1], req("q", "leader", M.ALERTS_STATUS));
            const callId = last(workers[0]).callId;
            hub.handleMessage(workers[0], {
                cmd: CLUSTER_IPC.RPC_RETURN, callId, ok: false,
                error: { message: "m".repeat(900), appError: { statusCode: 404, message: "z".repeat(900), type: "T".repeat(200) } },
            });
            const err = last(workers[1]).error;
            expect(err.message).toHaveLength(500);
            expect(err.appError.message).toHaveLength(500);
            expect(err.appError.type).toHaveLength(64);
        });

        it("a leader error with no message or a bad appError degrades safely", () => {
            const { hub, workers, last } = setup();
            for (const [i, error] of ([undefined, { code: 1 }, { message: "ok", appError: { statusCode: "x", message: "m" } }, { message: "ok", appError: { statusCode: 400, message: "m", type: 5 } }] as any[]).entries()) {
                hub.handleMessage(workers[1], req(`q${i}`, "leader", M.ALERTS_STATUS));
                hub.handleMessage(workers[0], { cmd: CLUSTER_IPC.RPC_RETURN, callId: last(workers[0]).callId, ok: false, error });
            }
            const errs = workers[1].sent.map((m) => m.error);
            expect(errs[0].message).toBe("leader handler failed");
            expect(errs[1].message).toBe("leader handler failed");
            expect(errs[2].appError).toBeUndefined();
            expect(errs[3].appError.type).toBe("AppError");
        });

        it("no leader -> NO_LEADER immediately", () => {
            const { hub, workers, last, setLeader } = setup();
            setLeader(null);
            hub.handleMessage(workers[1], req("q", "leader", M.ALERTS_STATUS));
            expect(last(workers[1]).error.code).toBe(E.NO_LEADER);
            expect(hub.pendingCount).toBe(0);
        });

        it("unreachable leader -> NO_LEADER and the slot is freed", () => {
            const { hub, workers, last } = setup();
            workers[0].throws = true;
            hub.handleMessage(workers[1], req("q", "leader", M.ALERTS_STATUS));
            expect(last(workers[1]).error).toMatchObject({ code: E.NO_LEADER, message: "leader unreachable" });
            expect(hub.pendingCount).toBe(0);
        });

        it("caps concurrent leader calls with OVERLOAD, recovering as they complete", () => {
            const { hub, workers, last } = setup();
            for (let i = 0; i < CLUSTER_RPC_LIMITS.MAX_LEADER_CALLS; i++) hub.handleMessage(workers[1], req(`q${i}`, "leader", M.ALERTS_STATUS));
            const firstCall = workers[0].sent[0];
            hub.handleMessage(workers[1], req("over", "leader", M.ALERTS_STATUS));
            expect(last(workers[1]).error.code).toBe(E.OVERLOAD);
            hub.handleMessage(workers[0], { cmd: CLUSTER_IPC.RPC_RETURN, callId: firstCall.callId, ok: true, result: {} });
            hub.handleMessage(workers[1], req("again", "leader", M.ALERTS_STATUS));
            expect(last(workers[0]).cmd).toBe(CLUSTER_IPC.RPC_CALL);
        });

        it("the leader timing out answers TIMEOUT once, and a late return is refused", () => {
            const { hub, workers, last } = setup();
            hub.handleMessage(workers[1], req("q", "leader", M.ALERTS_STATUS));
            const callId = last(workers[0]).callId;
            vi.advanceTimersByTime(CLUSTER_RPC_TIMEOUTS.LEADER_FORWARD_MS);
            expect(last(workers[1]).error.code).toBe(E.TIMEOUT);
            const before = workers[1].sent.length;
            hub.handleMessage(workers[0], { cmd: CLUSTER_IPC.RPC_RETURN, callId, ok: true, result: {} });
            expect(workers[1].sent).toHaveLength(before);
        });

        it("timeout reply is skipped when the asker is gone", () => {
            const { hub, workers, setLive } = setup();
            hub.handleMessage(workers[1], req("q", "leader", M.ALERTS_STATUS));
            setLive([workers[0]]);
            const before = workers[1].sent.length;
            vi.advanceTimersByTime(CLUSTER_RPC_TIMEOUTS.LEADER_FORWARD_MS);
            expect(workers[1].sent).toHaveLength(before);
        });
    });

    describe("returns", () => {
        it("refuses malformed, unknown and spoofed returns", () => {
            const { hub, workers, last } = setup();
            hub.handleMessage(workers[1], req("q", "leader", M.ALERTS_STATUS));
            const callId = last(workers[0]).callId;
            expect(hub.handleMessage(workers[0], { cmd: CLUSTER_IPC.RPC_RETURN })).toBe(true);
            expect(hub.handleMessage(workers[0], { cmd: CLUSTER_IPC.RPC_RETURN, callId: "nope", ok: true })).toBe(true);
            // worker 3 tries to answer worker 1's call
            hub.handleMessage(workers[2], { cmd: CLUSTER_IPC.RPC_RETURN, callId, ok: true, result: { forged: true } });
            expect(hub.pendingCount).toBe(1);
        });
    });

    describe("gather (target all)", () => {
        const startGather = (ctx: ReturnType<typeof setup>) => {
            ctx.hub.handleMessage(ctx.workers[0], req("g", "all", M.METRICS_SNAPSHOT));
            return ctx.workers.map((w) => w.sent.at(-1).callId as string);
        };

        it("collects every part with worker id, pid and leader flag", () => {
            const ctx = setup();
            const ids = startGather(ctx);
            ctx.workers.forEach((w, i) => ctx.hub.handleMessage(w, { cmd: CLUSTER_IPC.RPC_RETURN, callId: ids[i], ok: true, result: { n: i } }));
            const res = ctx.last(ctx.workers[0]).result;
            expect(res.missing).toEqual([]);
            expect(res.parts).toHaveLength(3);
            expect(res.parts[0]).toMatchObject({ workerId: 1, pid: 101, isLeader: true, value: { n: 0 } });
            expect(res.parts[1].isLeader).toBe(false);
            expect(ctx.hub.pendingCount).toBe(0);
        });

        it("a part that failed, is oversized, or cannot be serialised counts as missing", () => {
            const ctx = setup();
            const ids = startGather(ctx);
            ctx.hub.handleMessage(ctx.workers[0], { cmd: CLUSTER_IPC.RPC_RETURN, callId: ids[0], ok: false, error: {} });
            ctx.hub.handleMessage(ctx.workers[1], { cmd: CLUSTER_IPC.RPC_RETURN, callId: ids[1], ok: true, result: { blob: "x".repeat(CLUSTER_RPC_LIMITS.MAX_METRICS_PART_BYTES + 1) } });
            const circular: any = {}; circular.self = circular;
            ctx.hub.handleMessage(ctx.workers[2], { cmd: CLUSTER_IPC.RPC_RETURN, callId: ids[2], ok: true, result: circular });
            const res = ctx.last(ctx.workers[0]).result;
            expect(res.parts).toEqual([]);
            expect(res.missing.sort()).toEqual([1, 2, 3]);
        });

        it("a null result part (ok with nothing) is reported missing", () => {
            const ctx = setup(1);
            const ids = startGather(ctx);
            ctx.hub.handleMessage(ctx.workers[0], { cmd: CLUSTER_IPC.RPC_RETURN, callId: ids[0], ok: true });
            expect(ctx.last(ctx.workers[0]).result).toEqual({ parts: [], missing: [1] });
        });

        it("unreachable workers are missing, and the gather completes without waiting", () => {
            const ctx = setup();
            ctx.workers[1].throws = true;
            ctx.workers[2].throws = true;
            ctx.hub.handleMessage(ctx.workers[0], req("g", "all", M.METRICS_SNAPSHOT));
            ctx.hub.handleMessage(ctx.workers[0], { cmd: CLUSTER_IPC.RPC_RETURN, callId: ctx.workers[0].sent.at(-1).callId, ok: true, result: { a: 1 } });
            expect(ctx.last(ctx.workers[0]).result.missing.sort()).toEqual([2, 3]);
        });

        it("no live workers: the gather finishes at once and leaks nothing", () => {
            const ctx = setup();
            ctx.setLive([]);
            ctx.setLeader(null);
            ctx.hub.handleMessage(ctx.workers[0], req("g", "all", M.METRICS_SNAPSHOT));
            // asker is not live, so there is nobody to answer; nothing pending leaks
            expect(ctx.hub.pendingCount).toBe(0);
        });

        it("caps concurrent gathers with OVERLOAD", () => {
            const ctx = setup(2);
            for (let i = 0; i < CLUSTER_RPC_LIMITS.MAX_GATHERS; i++) ctx.hub.handleMessage(ctx.workers[0], req(`g${i}`, "all", M.METRICS_SNAPSHOT));
            ctx.hub.handleMessage(ctx.workers[0], req("over", "all", M.METRICS_SNAPSHOT));
            expect(ctx.last(ctx.workers[0]).error.code).toBe(E.OVERLOAD);
        });

        it("GATHER_MS timeout finishes with the partial result and frees every call", () => {
            const ctx = setup();
            const ids = startGather(ctx);
            ctx.hub.handleMessage(ctx.workers[0], { cmd: CLUSTER_IPC.RPC_RETURN, callId: ids[0], ok: true, result: { a: 1 } });
            vi.advanceTimersByTime(CLUSTER_RPC_TIMEOUTS.GATHER_MS);
            expect(ctx.last(ctx.workers[0]).result.missing.sort()).toEqual([2, 3]);
            expect(ctx.hub.pendingCount).toBe(0);
        });

        it("a worker that exits mid-gather is counted missing and the gather still completes", () => {
            const ctx = setup(2);
            const ids = startGather(ctx);
            ctx.hub.handleMessage(ctx.workers[0], { cmd: CLUSTER_IPC.RPC_RETURN, callId: ids[0], ok: true, result: { a: 1 } });
            ctx.hub.onWorkerExit(ctx.workers[1]);
            expect(ctx.last(ctx.workers[0]).result.missing).toEqual([2]);
        });

        it("the requester exiting abandons its gather and its leader calls", () => {
            const ctx = setup(3);
            startGather(ctx);
            ctx.hub.handleMessage(ctx.workers[0], req("l", "leader", M.ALERTS_STATUS));
            expect(ctx.hub.pendingCount).toBeGreaterThan(0);
            ctx.hub.onWorkerExit(ctx.workers[0]);
            expect(ctx.hub.pendingCount).toBe(0);
            // the freed gather slot is reusable
            ctx.hub.handleMessage(ctx.workers[1], req("g2", "all", M.METRICS_SNAPSHOT));
            expect(ctx.hub.pendingCount).toBeGreaterThan(0);
        });
    });

    describe("leader exit with pending calls", () => {
        it("answers NO_LEADER to the asker", () => {
            const ctx = setup();
            ctx.hub.handleMessage(ctx.workers[1], req("q", "leader", M.ALERTS_STATUS));
            ctx.hub.onWorkerExit(ctx.workers[0]);
            expect(ctx.last(ctx.workers[1]).error).toMatchObject({ code: E.NO_LEADER, message: "leader exited" });
        });

        it("an unrelated worker exit leaves pending calls alone", () => {
            const ctx = setup();
            ctx.hub.handleMessage(ctx.workers[1], req("q", "leader", M.ALERTS_STATUS));
            ctx.hub.onWorkerExit(ctx.workers[2]);
            expect(ctx.hub.pendingCount).toBe(1);
        });
    });

    describe("broadcast and hooks", () => {
        it("broadcast reaches all live workers, optionally excluding one", () => {
            const ctx = setup();
            ctx.hub.broadcast(CLUSTER_TOPICS.SF_UNBLOCKED, { ip: "1.1.1.1" });
            expect(ctx.workers.every((w) => w.sent.length === 1)).toBe(true);
            ctx.hub.broadcast(CLUSTER_TOPICS.SF_UNBLOCKED, { ip: "1.1.1.1" }, { exceptId: 2 });
            expect(ctx.workers.map((w) => w.sent.length)).toEqual([2, 1, 2]);
        });

        it("sendTo reports whether the send succeeded", () => {
            const ctx = setup();
            expect(ctx.hub.sendTo(ctx.workers[0], "t", {})).toBe(true);
            ctx.workers[0].throws = true;
            expect(ctx.hub.sendTo(ctx.workers[0], "t", {})).toBe(false);
        });

        it("listening and exit hooks run; a throwing hook is isolated and does not skip the next", () => {
            const ctx = setup();
            const ok = vi.fn();
            ctx.hub.addListeningHook(() => { throw new RangeError("bad hook"); });
            ctx.hub.addListeningHook(ok);
            ctx.hub.addExitHook(() => { throw new Error(); });
            const exitOk = vi.fn();
            ctx.hub.addExitHook(exitOk);
            ctx.hub.onWorkerListening(ctx.workers[0]);
            ctx.hub.onWorkerExit(ctx.workers[0]);
            expect(ok).toHaveBeenCalledWith(ctx.workers[0]);
            expect(exitOk).toHaveBeenCalledWith(ctx.workers[0]);
            expect(ctx.logger.warning).toHaveBeenCalledTimes(1); // throttled
        });
    });

    describe("reject log throttle", () => {
        it("logs again once the gap has passed and truncates long reasons", () => {
            const ctx = setup();
            ctx.hub.handleMessage(ctx.workers[0], { cmd: CLUSTER_IPC.NOTIFY, method: "bad" });
            ctx.hub.handleMessage(ctx.workers[0], { cmd: CLUSTER_IPC.NOTIFY, method: "bad" });
            expect(ctx.logger.warning).toHaveBeenCalledTimes(1);
            ctx.clock.t += CLUSTER_RPC_LIMITS.REJECT_LOG_GAP_MS;
            ctx.hub.handleMessage(ctx.workers[0], { cmd: CLUSTER_IPC.NOTIFY, method: "bad" });
            expect(ctx.logger.warning).toHaveBeenCalledTimes(2);
        });
    });
});
