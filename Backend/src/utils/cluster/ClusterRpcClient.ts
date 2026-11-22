

/**
 * @fileoverview Worker-side endpoint of the cluster shared-state IPC protocol.
 *
 * `call()` sends an `RPC_REQUEST` to the primary and resolves with the result;
 * `notify()` is fire and forget; `handle()` registers a method the primary may
 * invoke on this worker (`RPC_CALL`, used for leader-forwarded calls and metrics
 * gathers); `onTopic()` registers a broadcast listener.
 *
 * Inactive by default: `init()` is only called from the cluster-worker branch of
 * `server.ts`, so single-process mode registers NO `process.on("message")`
 * listener and never calls `process.send` (`clusterRpc.active === false`).
 *
 * Security: CWE-20 (inbound topics/calls validated by `ipcSchemas`),
 * CWE-400 (pending cap -> immediate OVERLOAD; every call has a timer),
 * CWE-209 (an error from the primary is rehydrated as AppError only when the
 * primary marked it operational; anything else becomes a generic 503).
 *
 * Complexity: O(1) per call/response.
 *
 * @author senior-nodejs-engineer
 */

import cluster from "cluster";
import { CLUSTER_IPC, CLUSTER_RPC_METHODS, CLUSTER_RPC_TARGETS, CLUSTER_RPC_ERROR_CODES, CLUSTER_RPC_TIMEOUTS, CLUSTER_RPC_LIMITS } from "../../constants/clusterIpc";
import { AppError } from "../../constants/errors";
import { HTTP_STATUS } from "../../constants";
import { validateArgs, validateResult, validateTopic, isPlainObject } from "./ipcSchemas";

const METHOD_SET: ReadonlySet<string> = new Set(Object.values(CLUSTER_RPC_METHODS));
const E = CLUSTER_RPC_ERROR_CODES;
type RpcErrorCode = (typeof E)[keyof typeof E];
const isRpcErrorCode = (v: unknown): v is RpcErrorCode => (Object.values(E) as unknown[]).includes(v);
const KNOWN_STATUS = new Set(Object.values(HTTP_STATUS));

/** Error thrown by `call()`; `code` is one of CLUSTER_RPC_ERROR_CODES. */
/** The leader's AppError fields, carried back across IPC. */
type RpcAppError = { statusCode: number; message: string; type: string };

class ClusterRpcError extends Error {
    declare appError: RpcAppError | undefined;
    declare code: string;
    /**
     * @param {string} code
     * @param {string} message
     * @param {{statusCode: number, message: string, type: string}} [appError]
     */
    constructor(code: string, message: string, appError?: RpcAppError) {
        super(message);
        this.name = "ClusterRpcError";
        this.code = code;
        this.appError = appError;
    }
}

/**
 * @class ClusterRpcClient
 * @description Holds the pending-call table and handler registries of one worker.
 */
class ClusterRpcClient {
    #pending: Map<string, { resolve: ((...args: unknown[]) => unknown); reject: ((...args: unknown[]) => unknown); timer: ReturnType<typeof setTimeout>; method: string; }> = new Map();
    /** @type {Map<string, Function>} */
    #handlers: Map<string, (args: Record<string, unknown>) => unknown> = new Map();
    /** @type {Map<string, Function>} */
    #topics: Map<string, (payload: Record<string, unknown>) => void> = new Map();
    #active = false;
    #isLeader = false;
    #seq = 0;
    #listener: ((msg: unknown) => void) | null = null;
    declare _proc: NodeJS.Process;
    declare _canSend: () => boolean;

    constructor() {
        /** Injectable IPC-availability predicate (tests). */
        this._canSend = () => cluster.isWorker === true && typeof process.send === "function";
        /** Injectable process-like object (tests): `{ on, off, send }`. */
        this._proc = process;
    }

    /** @returns {boolean} IPC endpoint installed (cluster worker only) */
    get active(): boolean {
        return this.#active;
    }

    /** @returns {boolean} this worker is the cron leader */
    get isLeader(): boolean {
        return this.#isLeader;
    }

    /** @returns {number} pending calls (diagnostics/tests) */
    get pendingCount(): number {
        return this.#pending.size;
    }

    /**
     * Installs the message listener. No-op (returns false) outside a cluster worker.
     *
     * @param {{isLeader?: boolean}} [opts]
     * @returns {boolean} true when installed
     */
    init({ isLeader = false }: { isLeader?: boolean; } = {}): boolean {
        if (this.#active || !this._canSend()) return false;
        this.#isLeader = isLeader === true;
        this.#listener = (msg) => this.#onMessage(msg);
        this._proc.on("message", this.#listener);
        this.#active = true;
        return true;
    }

    /** Removes the listener and fails everything pending (tests / shutdown). */
    reset() {
        if (this.#listener) this._proc.off?.("message", this.#listener);
        this.#listener = null;
        this.#active = false;
        this.#isLeader = false;
        for (const [id, p] of [...this.#pending]) {
            clearTimeout(p.timer);
            this.#pending.delete(id);
            p.reject(new ClusterRpcError(E.REJECTED, "client reset"));
        }
        this.#handlers.clear();
        this.#topics.clear();
    }

    /**
     * Registers a method the primary may call on this worker.
     *
     * @param {string} method
     * @param {(args: object) => any} fn
     */
    handle<A extends Record<string, unknown> = Record<string, unknown>>(method: string, fn: (args: A) => unknown) {
        // Args reach the handler only after validateArgs ran this method's validator, so `A` is its output shape.
        this.#handlers.set(method, fn as (args: Record<string, unknown>) => unknown);
    }

    /**
     * Registers a broadcast topic listener.
     *
     * @param {string} topic
     * @param {(payload: object) => void} fn
     */
    onTopic<P extends Record<string, unknown> = Record<string, unknown>>(topic: string, fn: (payload: P) => void) {
        // Payloads reach the listener only after validateTopic ran this topic's validator, so `P` is its output shape.
        this.#topics.set(topic, fn as (payload: Record<string, unknown>) => void);
    }

    /**
     * Sends a request to the primary (or via it to the leader / all workers).
     *
     * @param {"primary"|"leader"|"all"} target
     * @param {string} method
     * @param {object} [args]
     * @param {{timeoutMs?: number}} [opts]
     * @returns {Promise<any>} result; rejects with ClusterRpcError
     */
    call(target: "primary" | "leader" | "all", method: string, args: Record<string, unknown> = {}, { timeoutMs = CLUSTER_RPC_TIMEOUTS.DEFAULT_MS }: { timeoutMs?: number; } = {}): Promise<any> {
        if (!this.#active) return Promise.reject(new ClusterRpcError(E.REJECTED, "cluster rpc inactive"));
        // A leader call made by the leader itself runs locally, no IPC.
        if (target === CLUSTER_RPC_TARGETS.LEADER && this.#isLeader) {
            const fn = this.#handlers.get(method);
            if (!fn) return Promise.reject(new ClusterRpcError(E.NO_LEADER, "no local handler"));
            return Promise.resolve().then(() => fn(args));
        }
        if (this.#pending.size >= CLUSTER_RPC_LIMITS.MAX_PENDING_PER_CLIENT) {
            return Promise.reject(new ClusterRpcError(E.OVERLOAD, "too many pending calls"));
        }
        const id = `${process.pid}-${++this.#seq}`;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this.#pending.delete(id)) reject(new ClusterRpcError(E.TIMEOUT, `${method} timed out`));
            }, timeoutMs);
            timer.unref?.();
            this.#pending.set(id, { resolve, reject, timer, method });
            if (!this.#trySend({ cmd: CLUSTER_IPC.RPC_REQUEST, id, target, method, args })) {
                clearTimeout(timer);
                this.#pending.delete(id);
                reject(new ClusterRpcError(E.REJECTED, "ipc send failed"));
            }
        });
    }

    /**
     * Fire-and-forget message to the primary. Never throws.
     *
     * @param {string} method
     * @param {object} [args]
     * @returns {boolean} whether the send was attempted successfully
     */
    notify(method: string, args: Record<string, unknown> = {}): boolean {
        if (!this.#active) return false;
        return this.#trySend({ cmd: CLUSTER_IPC.NOTIFY, method, args });
    }

    /**
     * Converts a `ClusterRpcError` into an AppError: the leader's own operational
     * error (status/message/type) when present, otherwise a generic 503.
     *
     * @param {Error} err
     * @param {string} fallbackMessage - Message from `constants/errors`.
     * @returns {AppError}
     */
    static toAppError(err: Error & { appError?: RpcAppError }, fallbackMessage: string): AppError {
        const a = err?.appError;
        if (a && KNOWN_STATUS.has(a.statusCode) && typeof a.message === "string") {
            // Built with a catalogued literal, then re-stamped: the status was
            // chosen by the leader's own AppError and checked against HTTP_STATUS.
            const rehydrated = new AppError(a.message, HTTP_STATUS.SERVICE_UNAVAILABLE, { type: a.type });
            rehydrated.statusCode = a.statusCode;
            return rehydrated;
        }
        return new AppError(fallbackMessage, HTTP_STATUS.SERVICE_UNAVAILABLE, { type: "ClusterError" });
    }

    // ── Internals ────────────────────────────────────────────────────────────

    #trySend(message: unknown) {
        try {
            this._proc.send!(message); // a cluster worker always has the IPC channel
            return true;
        } catch {
            return false;
        }
    }

    #onMessage(msg: unknown) {
        if (!isPlainObject(msg)) return;
        switch (msg.cmd) {
            case CLUSTER_IPC.RPC_RESPONSE:
                return this.#onResponse(msg);
            case CLUSTER_IPC.RPC_CALL:
                return this.#onCall(msg);
            case CLUSTER_IPC.BROADCAST:
                return this.#onBroadcast(msg);
            default:
        }
    }

    #onResponse(msg: Record<string, unknown>) {
        if (typeof msg.id !== "string") return;
        const p = this.#pending.get(msg.id);
        if (!p) return;
        this.#pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok === true) {
            if (!validateResult(p.method, msg.result)) {
                p.reject(new ClusterRpcError(E.HANDLER_ERROR, "invalid result"));
                return;
            }
            p.resolve(msg.result);
            return;
        }
        const e = isPlainObject(msg.error) ? msg.error : {};
        const code = isRpcErrorCode(e.code) ? e.code : E.HANDLER_ERROR;
        const text = typeof e.message === "string" ? e.message.slice(0, CLUSTER_RPC_LIMITS.MAX_ERROR_MESSAGE) : "error";
        const a = e.appError;
        const appError =
            isPlainObject(a) && typeof a.statusCode === "number" && Number.isInteger(a.statusCode) && typeof a.message === "string"
                ? {
                      statusCode: a.statusCode,
                      message: a.message.slice(0, CLUSTER_RPC_LIMITS.MAX_ERROR_MESSAGE),
                      type: typeof a.type === "string" ? a.type.slice(0, 64) : "AppError",
                  }
                : undefined;
        p.reject(new ClusterRpcError(code, text, appError));
    }

    #onCall(msg: Record<string, unknown>) {
        const { callId } = msg;
        const method = typeof msg.method === "string" ? msg.method : "";
        if (typeof callId !== "string" || callId.length > CLUSTER_RPC_LIMITS.MAX_ID_LENGTH) return;
        const reply = (ok: boolean, result?: unknown, error?: unknown) => {
            const out: { cmd: string; callId: string; ok: boolean; result?: unknown; error?: unknown } = { cmd: CLUSTER_IPC.RPC_RETURN, callId, ok };
            if (ok) out.result = result === undefined ? null : result;
            else out.error = error;
            if (!this.#trySend(out) && ok) {
                // Unserialisable result: tell the primary instead of leaving it waiting.
                this.#trySend({
                    cmd: CLUSTER_IPC.RPC_RETURN,
                    callId,
                    ok: false,
                    error: { code: E.HANDLER_ERROR, message: "unserialisable result" },
                });
            }
        };
        const fn = METHOD_SET.has(method) ? this.#handlers.get(method) : undefined;
        if (!fn) return reply(false, undefined, { code: E.REJECTED, message: "no handler" });
        const args = validateArgs(method, msg.args === undefined || msg.args === null ? {} : msg.args);
        if (!args.ok) return reply(false, undefined, { code: E.REJECTED, message: args.reason });
        Promise.resolve()
            .then(() => fn(args.value))
            .then(
                (result) => reply(true, result),
                (err) => {
                    const error: { code: string; message: string; appError?: RpcAppError } = { code: E.HANDLER_ERROR, message: err?.isOperational ? String(err.message).slice(0, 500) : "handler failed" };
                    if (err?.isOperational === true && Number.isInteger(err.statusCode)) {
                        error.appError = {
                            statusCode: err.statusCode,
                            message: String(err.message).slice(0, 500),
                            type: typeof err.name === "string" ? err.name.slice(0, 64) : "AppError",
                        };
                    }
                    reply(false, undefined, error);
                },
            );
    }

    #onBroadcast(msg: Record<string, unknown>) {
        const topic = typeof msg.topic === "string" ? msg.topic : null;
        const fn = topic !== null ? this.#topics.get(topic) : undefined;
        if (!fn || topic === null) return;
        const v = validateTopic(topic, msg.payload);
        if (!v.ok) return;
        try {
            fn(v.value);
        } catch {
            // A faulty topic handler must never break the IPC listener.
        }
    }
}

const clusterRpc = new ClusterRpcClient();

export { ClusterRpcClient, ClusterRpcError, clusterRpc };
