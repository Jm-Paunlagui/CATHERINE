

/**
 * @fileoverview Primary-side router of the cluster shared-state IPC protocol.
 *
 * A worker sends `RPC_REQUEST` (needs an answer) or `NOTIFY` (fire and forget).
 * The hub either runs a registered primary handler, forwards the call to the
 * cron leader (`RPC_CALL` -> `RPC_RETURN`), or gathers an answer from every live
 * worker. It also fans out `BROADCAST` topics to workers.
 *
 * Must not require services or the app: it only knows the supervisor's view of
 * live workers and the leader (injected), plus the handlers registered by
 * `PrimaryStateServices`.
 *
 * Security: CWE-20 (every inbound message validated by `ipcSchemas`),
 * CWE-1321 (allow-listed methods via Set/Map, never property access),
 * CWE-400 (bounded gathers / leader calls, every wait has a timer),
 * CWE-209 (only operational AppError text crosses back, never a stack).
 * The sender is always the cluster `worker` object, never a payload field.
 *
 * Complexity: O(workers) per gather; O(1) per primary / leader call.
 *
 * @author senior-nodejs-engineer
 */

import { CLUSTER_IPC, CLUSTER_RPC_TARGETS, CLUSTER_RPC_METHODS, CLUSTER_RPC_ERROR_CODES, CLUSTER_RPC_TIMEOUTS, CLUSTER_RPC_LIMITS } from "../../constants/clusterIpc";
import { clusterMessages } from "../../constants/messages/cluster.messages";
import { validateRequest, validateNotify, validateArgs, isPlainObject } from "./ipcSchemas";

const M = CLUSTER_RPC_METHODS;
const T = CLUSTER_RPC_TARGETS;

/** Which target each method may use (a request naming another target is rejected). */
const METHOD_TARGET: Map<string, string> = new Map([
    [M.RL_HIT, T.PRIMARY],
    [M.RL_CLEAR, T.PRIMARY],
    [M.RL_REFUND, T.PRIMARY],
    [M.SF_STRIKE, T.PRIMARY],
    [M.SF_UNBLOCK, T.PRIMARY],
    [M.LOCKOUT_CHECK, T.PRIMARY],
    [M.LOCKOUT_FAIL, T.PRIMARY],
    [M.LOCKOUT_CLEAR, T.PRIMARY],
    [M.SCHED_RECORD, T.PRIMARY],
    [M.RECIPIENTS_INVALIDATE, T.PRIMARY],
    [M.AUTH_REVOKE, T.PRIMARY],
    [M.METRICS_SNAPSHOT, T.ALL],
    [M.ALERTS_ACK, T.LEADER],
    [M.ALERTS_UNACK, T.LEADER],
    [M.ALERTS_STATUS, T.LEADER],
    [M.ALERTS_ACKS, T.LEADER],
]);

/** Notify-capable methods (no reply, primary handlers only). */
const NOTIFY_METHODS: ReadonlySet<string> = new Set([
    M.RL_CLEAR,
    M.RL_REFUND,
    M.SF_STRIKE,
    M.SCHED_RECORD,
    M.RECIPIENTS_INVALIDATE,
    M.AUTH_REVOKE,
]);

const E = CLUSTER_RPC_ERROR_CODES;

/**
 * Builds the wire error. Only an operational AppError exposes `appError`.
 *
 * @param {string} code
 * @param {string} message
 * @param {Error} [err]
 * @returns {{code: string, message: string, appError?: object}}
 */
/** An error envelope sent back over IPC; appError carries an operational AppError's fields. */
type RpcError = { code: string; message: string; appError?: { statusCode: number; message: string; type: string } };

function buildError(code: string, message: string, err?: Error & { isOperational?: boolean; statusCode?: number }): RpcError {
    const out: RpcError = { code, message: String(message).slice(0, CLUSTER_RPC_LIMITS.MAX_ERROR_MESSAGE) };
    if (err && err.isOperational === true && typeof err.statusCode === "number" && Number.isInteger(err.statusCode)) {
        out.appError = {
            statusCode: err.statusCode,
            message: String(err.message).slice(0, CLUSTER_RPC_LIMITS.MAX_ERROR_MESSAGE),
            type: typeof err.name === "string" ? err.name.slice(0, 64) : "AppError",
        };
    }
    return out;
}

/**
 * @class ClusterRpcHub
 * @description Primary-side RPC router. Holds the pending leader calls and
 * gathers plus the registered primary handlers.
 */

/** One fan-out gather: a worker's request answered by every live worker. */
type Gather = {
    fromId: number;
    reqId: string;
    parts: unknown[];
    missing: Set<number>;
    outstanding: number;
    callIds: Set<string>;
    done: boolean;
    timer?: ReturnType<typeof setTimeout>;
};

/** An in-flight call the hub forwarded to a worker. */
type PendingCall = {
    kind: "leader" | "gather";
    targetId: number;
    fromId: number;
    reqId: string;
    gather?: Gather;
    pid?: number | null;
    isLeader?: boolean;
    timer?: ReturnType<typeof setTimeout>;
};
/** What the hub needs from a cluster worker (a real cluster.Worker satisfies it). */
type HubWorker = { id: number; send(message: unknown): unknown; process?: { pid?: number } };
/** What the hub needs from the logger. */
type HubLogger = { warning: (message: string, meta?: Record<string, unknown>) => unknown };
/** A primary-side RPC handler: validated args in, any serialisable result out. */
type RpcHandler = (args: Record<string, unknown>, ctx: { worker: HubWorker }) => unknown;
type WorkerHook = (worker: HubWorker) => void;

class ClusterRpcHub {
    /** @type {Map<string, Function>} method -> (args, ctx) => result | Promise */
    #handlers: Map<string, RpcHandler> = new Map();
    #calls: Map<string, PendingCall> = new Map();
    /** @type {Set<Function>} */
    #listeningHooks: Set<WorkerHook> = new Set();
    /** @type {Set<Function>} */
    #exitHooks: Set<WorkerHook> = new Set();
    #seq = 0;
    #leaderCalls = 0;
    #gathers = 0;
    #lastRejectLog = -Infinity;
    declare _now: () => number;
    declare _getLeader: () => HubWorker | null | undefined;
    declare _getLiveWorkers: () => HubWorker[];
    declare _logger: HubLogger;
    declare _cluster: import("cluster").Cluster | undefined;

    /**
     * @param {object} deps
     * @param {import("cluster").Cluster} [deps.cluster]
     * @param {object} deps.logger
     * @param {() => object[]} deps.getLiveWorkers
     * @param {() => (object|null|undefined)} deps.getLeader
     * @param {() => number} [deps.now=Date.now]
     */
    constructor({ cluster, logger, getLiveWorkers, getLeader, now = Date.now }: { cluster?: import("cluster").Cluster; logger: HubLogger; getLiveWorkers: () => HubWorker[]; getLeader: () => HubWorker | null | undefined; now?: () => number; }) {
        this._cluster = cluster;
        this._logger = logger;
        this._getLiveWorkers = getLiveWorkers;
        this._getLeader = getLeader;
        this._now = now;
    }

    /** @returns {number} pending leader calls + gathers (diagnostics/tests) */
    get pendingCount(): number {
        return this.#calls.size;
    }

    /**
     * Registers a primary-side handler for an allow-listed method.
     *
     * @param {string} method
     * @param {(args: object, ctx: {worker: object}) => any} handler
     */
    register<A extends Record<string, unknown> = Record<string, unknown>>(method: string, handler: (args: A, ctx: { worker: HubWorker }) => unknown) {
        // Args reach a handler only after validateArgs ran this method's ARG_VALIDATORS
        // entry, so `A` is that validator's output shape.
        this.#handlers.set(method, handler as RpcHandler);
    }

    /** @param {(worker: object) => void} fn called when a worker emits `listening` */
    addListeningHook(fn: WorkerHook) {
        this.#listeningHooks.add(fn);
    }

    /** @param {(worker: object) => void} fn called when a worker exits */
    addExitHook(fn: WorkerHook) {
        this.#exitHooks.add(fn);
    }

    /**
     * Routes an inbound message. Never throws.
     *
     * @param {object} worker - cluster worker object (identity source)
     * @param {*} msg
     * @returns {boolean} true when the message belonged to this protocol
     */
    handleMessage(worker: HubWorker, msg: unknown): boolean {
        try {
            const cmd = isPlainObject(msg) ? msg.cmd : undefined;
            if (cmd === CLUSTER_IPC.RPC_REQUEST) {
                this.#onRequest(worker, msg);
                return true;
            }
            if (cmd === CLUSTER_IPC.RPC_RETURN) {
                this.#onReturn(worker, msg);
                return true;
            }
            if (cmd === CLUSTER_IPC.NOTIFY) {
                this.#onNotify(worker, msg);
                return true;
            }
        } catch (err) {
            this.#reject(worker, `internal:${err?.name ?? "error"}`);
            return true;
        }
        return false;
    }

    /**
     * Sends a topic to every live worker (optionally except one).
     *
     * @param {string} topic
     * @param {object} payload
     * @param {{exceptId?: number}} [opts]
     */
    broadcast(topic: string, payload: Record<string, unknown>, { exceptId }: { exceptId?: number; } = {}) {
        for (const w of this._getLiveWorkers()) {
            if (exceptId !== undefined && w.id === exceptId) continue;
            this.sendTo(w, topic, payload);
        }
    }

    /**
     * Sends a topic to one worker.
     *
     * @param {object} worker
     * @param {string} topic
     * @param {object} payload
     * @returns {boolean}
     */
    sendTo(worker: HubWorker, topic: string, payload: Record<string, unknown>): boolean {
        return this.#send(worker, { cmd: CLUSTER_IPC.BROADCAST, topic, payload });
    }

    /** @param {object} worker - a worker that just emitted `listening` */
    onWorkerListening(worker: HubWorker) {
        for (const fn of this.#listeningHooks) this.#safeHook(fn, worker);
    }

    /**
     * Fails everything pending on a worker that exited and runs exit hooks
     * (e.g. release locks it held).
     *
     * @param {object} worker
     */
    onWorkerExit(worker: HubWorker) {
        for (const [callId, call] of [...this.#calls]) {
            if (call.fromId === worker.id) {
                this.#dropCall(callId, call);
            } else if (call.targetId === worker.id) {
                if (call.kind === "leader") {
                    this.#dropCall(callId, call);
                    this.#respondTo(call.fromId, call.reqId, false, undefined, buildError(E.NO_LEADER, "leader exited"));
                } else {
                    this.#gatherPartDone(callId, call, null);
                }
            }
        }
        for (const fn of this.#exitHooks) this.#safeHook(fn, worker);
    }

    // ── Inbound ──────────────────────────────────────────────────────────────

    #onRequest(worker: HubWorker, msg: unknown) {
        const v = validateRequest(msg);
        if (!v.ok) {
            this.#reject(worker, v.reason);
            // Answer when an id is recoverable so the caller does not wait for its timeout.
            if (isPlainObject(msg) && typeof msg.id === "string" && msg.id.length > 0 && msg.id.length <= CLUSTER_RPC_LIMITS.MAX_ID_LENGTH) {
                this.#send(worker, {
                    cmd: CLUSTER_IPC.RPC_RESPONSE,
                    id: msg.id,
                    ok: false,
                    error: buildError(E.REJECTED, v.reason),
                });
            }
            return;
        }
        const { id, target, method, args } = v.value;
        const reply = (ok: boolean, result?: unknown, error?: RpcError) => this.#respond(worker, id, ok, result, error);
        if (METHOD_TARGET.get(method) !== target) {
            this.#reject(worker, "method-target-mismatch");
            reply(false, undefined, buildError(E.REJECTED, "method-target-mismatch"));
            return;
        }
        const a = validateArgs(method, args);
        if (!a.ok) {
            this.#reject(worker, a.reason);
            reply(false, undefined, buildError(E.REJECTED, a.reason));
            return;
        }
        if (target === T.PRIMARY) {
            this.#runPrimary(worker, method, a.value).then(
                (result) => reply(true, result),
                (err) => reply(false, undefined, this.#handlerError(method, err)),
            );
        } else if (target === T.LEADER) {
            this.#forwardToLeader(worker, id, method, a.value);
        } else {
            this.#gather(worker, id, method, a.value);
        }
    }

    #onNotify(worker: HubWorker, msg: unknown) {
        const v = validateNotify(msg);
        if (!v.ok) return this.#reject(worker, v.reason);
        const { method, args } = v.value;
        if (!NOTIFY_METHODS.has(method)) return this.#reject(worker, "not-notify-method");
        const a = validateArgs(method, args);
        if (!a.ok) return this.#reject(worker, a.reason);
        this.#runPrimary(worker, method, a.value).catch((err) => this.#handlerError(method, err));
    }

    #onReturn(worker: HubWorker, msg: unknown) {
        if (!isPlainObject(msg) || typeof msg.callId !== "string") return this.#reject(worker, "bad-return");
        const call = this.#calls.get(msg.callId);
        // Identity from the worker object: only the worker the call went to may answer it.
        if (!call || call.targetId !== worker.id) return this.#reject(worker, "unexpected-return");
        const ok = msg.ok === true;
        if (call.kind === "leader") {
            this.#dropCall(msg.callId, call);
            if (ok) this.#respondTo(call.fromId, call.reqId, true, msg.result);
            else this.#respondTo(call.fromId, call.reqId, false, undefined, this.#sanitizeWireError(msg.error));
            return;
        }
        if (!ok) return this.#gatherPartDone(msg.callId, call, null);
        let size = Infinity;
        try {
            size = JSON.stringify(msg.result ?? null).length;
        } catch {
            // unserialisable -> counts as missing
        }
        if (size > CLUSTER_RPC_LIMITS.MAX_METRICS_PART_BYTES) return this.#gatherPartDone(msg.callId, call, null);
        this.#gatherPartDone(msg.callId, call, msg.result);
    }

    // ── Routing ──────────────────────────────────────────────────────────────

    async #runPrimary(worker: HubWorker, method: string, args: Record<string, unknown>) {
        const handler = this.#handlers.get(method);
        if (!handler) throw Object.assign(new Error("no-handler"), { code: "NO_HANDLER" });
        return handler(args, { worker });
    }

    #forwardToLeader(worker: HubWorker, reqId: string, method: string, args: unknown) {
        const leader = this._getLeader();
        if (!leader) return this.#respond(worker, reqId, false, undefined, buildError(E.NO_LEADER, "no leader"));
        if (this.#leaderCalls >= CLUSTER_RPC_LIMITS.MAX_LEADER_CALLS) {
            return this.#respond(worker, reqId, false, undefined, buildError(E.OVERLOAD, "too many leader calls"));
        }
        const callId = this.#nextCallId();
        const call: PendingCall = { kind: "leader", targetId: leader.id, fromId: worker.id, reqId };
        call.timer = this.#timer(() => {
            if (!this.#calls.has(callId)) return;
            this.#dropCall(callId, call);
            this.#respondTo(worker.id, reqId, false, undefined, buildError(E.TIMEOUT, "leader timeout"));
        }, CLUSTER_RPC_TIMEOUTS.LEADER_FORWARD_MS);
        this.#calls.set(callId, call);
        this.#leaderCalls++;
        if (!this.#send(leader, { cmd: CLUSTER_IPC.RPC_CALL, callId, method, args })) {
            this.#dropCall(callId, call);
            this.#respond(worker, reqId, false, undefined, buildError(E.NO_LEADER, "leader unreachable"));
        }
    }

    #gather(worker: HubWorker, reqId: string, method: string, args: unknown) {
        const live = this._getLiveWorkers();
        if (this.#gathers >= CLUSTER_RPC_LIMITS.MAX_GATHERS) {
            return this.#respond(worker, reqId, false, undefined, buildError(E.OVERLOAD, "too many gathers"));
        }
        const leader = this._getLeader();
        const g: Gather = {
            fromId: worker.id,
            reqId,
            parts: [],
            missing: new Set<number>(live.map((w) => w.id)),
            outstanding: 0,
            callIds: new Set(),
            done: false,
        };
        this.#gathers++;
        g.timer = this.#timer(() => this.#finishGather(g), CLUSTER_RPC_TIMEOUTS.GATHER_MS);
        for (const w of live) {
            const callId = this.#nextCallId();
            const call: PendingCall = {
                kind: "gather",
                targetId: w.id,
                fromId: worker.id,
                reqId,
                gather: g,
                pid: w.process?.pid ?? null,
                isLeader: leader?.id === w.id,
            };
            this.#calls.set(callId, call);
            g.callIds.add(callId);
            g.outstanding++;
            if (!this.#send(w, { cmd: CLUSTER_IPC.RPC_CALL, callId, method, args })) {
                this.#gatherPartDone(callId, call, null);
            }
        }
        if (g.outstanding === 0) this.#finishGather(g);
    }

    #gatherPartDone(callId: string, call: PendingCall, value: unknown) {
        if (!this.#calls.has(callId)) return;
        this.#calls.delete(callId);
        const g = call.gather;
        if (!g) return; // only gather calls reach here
        g.callIds.delete(callId);
        g.outstanding--;
        if (value !== null && value !== undefined) {
            g.missing.delete(call.targetId);
            g.parts.push({ workerId: call.targetId, pid: call.pid, isLeader: call.isLeader, value });
        }
        if (g.outstanding <= 0) this.#finishGather(g);
    }

    #finishGather(g: Gather) {
        if (g.done) return;
        g.done = true;
        this.#gathers--;
        clearTimeout(g.timer);
        for (const id of g.callIds) this.#calls.delete(id);
        g.callIds.clear();
        this.#respondTo(g.fromId, g.reqId, true, { parts: g.parts, missing: [...g.missing] });
    }

    #dropCall(callId: string, call: PendingCall) {
        if (!this.#calls.delete(callId)) return;
        if (call.timer) clearTimeout(call.timer);
        if (call.kind === "leader") this.#leaderCalls--;
        else if (call.gather && !call.gather.done) {
            // Requester exited: abandon the gather.
            call.gather.callIds.delete(callId);
            call.gather.outstanding--;
            if (call.gather.outstanding <= 0 && call.fromId !== undefined) {
                call.gather.done = true;
                this.#gathers--;
                clearTimeout(call.gather.timer);
            }
        }
    }

    // ── Wire helpers ─────────────────────────────────────────────────────────

    #handlerError(method: unknown, err: unknown) {
        // Thrown values are untyped; buildError reads isOperational / statusCode / message defensively.
        const e = err as (Error & { isOperational?: boolean; statusCode?: number }) | null | undefined;
        const wire = buildError(E.HANDLER_ERROR, e?.isOperational ? String(e.message) : "handler failed", e ?? undefined);
        if (!e?.isOperational) {
            this._logger.warning(clusterMessages.CLUSTER_RPC_HANDLER_FAILED(method, String(e?.message ?? err).slice(0, 200)));
        }
        return wire;
    }

    /** Re-clamps an error object received from a leader before relaying it. */
    #sanitizeWireError(e: unknown) {
        if (!isPlainObject(e) || typeof e.message !== "string") return buildError(E.HANDLER_ERROR, "leader handler failed");
        const out = buildError(E.HANDLER_ERROR, e.message);
        const a = e.appError;
        if (isPlainObject(a) && typeof a.statusCode === "number" && Number.isInteger(a.statusCode) && typeof a.message === "string") {
            out.appError = {
                statusCode: a.statusCode,
                message: a.message.slice(0, CLUSTER_RPC_LIMITS.MAX_ERROR_MESSAGE),
                type: typeof a.type === "string" ? a.type.slice(0, 64) : "AppError",
            };
        }
        return out;
    }

    #respond(worker: HubWorker, id: unknown, ok: boolean, result?: unknown, error?: RpcError) {
        const msg: { cmd: string; id: unknown; ok: boolean; result?: unknown; error?: RpcError } = { cmd: CLUSTER_IPC.RPC_RESPONSE, id, ok };
        if (ok) msg.result = result === undefined ? null : result;
        else msg.error = error;
        this.#send(worker, msg);
    }

    #respondTo(workerId: unknown, id: unknown, ok: boolean, result?: unknown, error?: RpcError) {
        const w = this._getLiveWorkers().find((x) => x.id === workerId);
        if (w) this.#respond(w, id, ok, result, error);
    }

    #send(worker: HubWorker, message: unknown) {
        try {
            worker.send(message);
            return true;
        } catch {
            return false;
        }
    }

    #timer(fn: () => void, ms: number) {
        const t = setTimeout(fn, ms);
        t.unref?.();
        return t;
    }

    #nextCallId() {
        return `c${++this.#seq}`;
    }

    #safeHook(fn: WorkerHook, worker: HubWorker) {
        try {
            fn(worker);
        } catch (err) {
            this.#reject(worker, `hook:${err?.name ?? "error"}`);
        }
    }

    /** Logs a rejected message at most once per minute (CWE-400 on the log). */
    #reject(worker: HubWorker | null | undefined, reason: unknown) {
        const now = this._now();
        if (now - this.#lastRejectLog < CLUSTER_RPC_LIMITS.REJECT_LOG_GAP_MS) return;
        this.#lastRejectLog = now;
        this._logger.warning(clusterMessages.CLUSTER_RPC_REJECTED(worker?.id ?? "?", String(reason).slice(0, 80)), {
            _noNotify: true,
        });
    }
}

export { ClusterRpcHub, buildError, METHOD_TARGET };
export type { HubWorker };
