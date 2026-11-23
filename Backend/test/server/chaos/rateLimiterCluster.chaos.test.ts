import type { Request, Response } from "express";
import { RateLimiterMiddleware } from "../../../src/middleware/security/RateLimiterMiddleware";
import { clusterRpc } from "../../../src/utils/cluster/ClusterRpcClient";
import { CLUSTER_RPC_METHODS as M, CLUSTER_RPC_LIMITS } from "../../../src/constants/clusterIpc";

function mkReq(path = "/api/v1/x"): Request {
    return { ip: "10.0.0.9", path, method: "GET", headers: {} } as unknown as Request;
}
function mkRes() {
    const h: Record<string, any> = {};
    const fin: Array<() => void> = [];
    const res: any = {
        statusCode: 200,
        locals: {},
        headersSent: false,
        _h: h,
        setHeader: (k: string, v: unknown) => { h[k] = v; },
        status: (c: number) => { res._status = c; return res; },
        json: (b: unknown) => { res._body = b; return res; },
        once: (_e: string, fn: () => void) => { fin.push(fn); },
        finish: () => fin.forEach((f) => f()),
    };
    return res as Response & { _status?: number; _body?: any; _h: Record<string, any>; finish: () => void };
}
const tick = () => vi.advanceTimersByTimeAsync(0);

describe("RateLimiter cluster chaos (primary unavailable)", () => {
    let active: ReturnType<typeof vi.spyOn>;
    let call: ReturnType<typeof vi.spyOn>;
    let notify: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(1_700_000_000_000);
        active = vi.spyOn(clusterRpc, "active", "get").mockReturnValue(true);
        call = vi.spyOn(clusterRpc, "call");
        notify = vi.spyOn(clusterRpc, "notify").mockReturnValue(true);
    });
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    const mk = (o = {}) => new RateLimiterMiddleware({ max: 2, windowMs: 60_000, label: "chaos", ...o });

    it("uses the primary's verdict when healthy (source=shared)", async () => {
        call.mockResolvedValue({ allowed: true, count: 1, remaining: 1, resetAt: Date.now() + 1000, bucket: 5 });
        const l = mk();
        const next = vi.fn();
        const res = mkRes();
        l.handle(mkReq(), res, next);
        await tick();
        expect(next).toHaveBeenCalledOnce();
        expect(call).toHaveBeenCalledWith("primary", M.RL_HIT, expect.objectContaining({ label: "chaos", max: 2 }), expect.any(Object));
        expect(res._h["RateLimit-Remaining"]).toBe(1);
        expect(l._store.keys()).toHaveLength(0);
    });

    it("answers 429 from a shared refusal with Retry-After from retryAt", async () => {
        call.mockResolvedValue({ allowed: false, count: 3, remaining: 0, resetAt: Date.now() + 5000, retryAt: Date.now() + 3500 });
        const res = mkRes();
        mk().handle(mkReq(), res, vi.fn());
        await tick();
        expect(res._status).toBe(429);
        expect(res._h["Retry-After"]).toBe(4);
    });

    it("falls open to the local counter when the primary times out, and still enforces locally", async () => {
        call.mockRejectedValue(Object.assign(new Error("rpc timeout"), { code: "TIMEOUT" }));
        const l = mk();
        const results: Array<number | undefined> = [];
        for (let i = 0; i < 3; i++) {
            const res = mkRes();
            const next = vi.fn();
            l.handle(mkReq(), res, next);
            await tick();
            results.push(next.mock.calls.length ? 200 : res._status);
        }
        expect(results).toEqual([200, 200, 429]);
    });

    it("rate-limits its own fallback warning to one per REJECT_LOG_GAP_MS", async () => {
        call.mockRejectedValue(new Error("down"));
        const l = mk({ max: 100 });
        const warn = vi.spyOn(l, "_warnFallback");
        for (let i = 0; i < 3; i++) {
            l.handle(mkReq(), mkRes(), vi.fn());
            await tick();
        }
        expect(warn).toHaveBeenCalledTimes(3);
        const first = l._lastFallbackLog;
        vi.advanceTimersByTime(CLUSTER_RPC_LIMITS.REJECT_LOG_GAP_MS - 1);
        l._warnFallback("x");
        expect(l._lastFallbackLog).toBe(first);
        vi.advanceTimersByTime(2);
        l._warnFallback("x");
        expect(l._lastFallbackLog).toBeGreaterThan(first);
    });

    it("counts locally when the primary declines (fallback:true)", async () => {
        call.mockResolvedValue({ fallback: true });
        const l = mk();
        const next = vi.fn();
        l.handle(mkReq(), mkRes(), next);
        await tick();
        expect(next).toHaveBeenCalledOnce();
        expect(l._store.keys()).toHaveLength(1);
    });

    it("never sends a malformed hit over IPC: args failing schema validation use the local counter", async () => {
        const l = mk();
        const next = vi.fn();
        const bad = Object.assign(mkReq(), { ip: "x".repeat(5000) }); // key above RL_KEY_MAX
        l.handle(bad, mkRes(), next);
        await tick();
        expect(call).not.toHaveBeenCalled();
        expect(next).toHaveBeenCalledOnce();
    });

    it("forwards a refund to the primary for a shared hit that later succeeds (failures mode)", async () => {
        call.mockResolvedValue({ allowed: true, count: 1, remaining: 1, resetAt: Date.now() + 1000, bucket: 1_699_999_980_000 });
        const l = mk({ countMode: "failures" });
        const res = mkRes();
        l.handle(mkReq(), res, vi.fn());
        await tick();
        res.finish();
        expect(notify).toHaveBeenCalledWith(M.RL_REFUND, expect.objectContaining({ label: "chaos", bucket: 1_699_999_980_000 }));
    });

    it("drops a shared refund silently once the link is gone", async () => {
        call.mockResolvedValue({ allowed: true, count: 1, remaining: 1, resetAt: Date.now() + 1000, bucket: 1 });
        const l = mk({ countMode: "failures" });
        const res = mkRes();
        l.handle(mkReq(), res, vi.fn());
        await tick();
        active.mockReturnValue(false);
        res.finish();
        expect(notify).not.toHaveBeenCalled();
    });

    it("an error thrown by _finish before settle surfaces through next(err), never hangs", async () => {
        call.mockResolvedValue({ allowed: true, count: 1, remaining: 1, resetAt: 1, bucket: 1 });
        const l = mk();
        vi.spyOn(l, "_finish").mockImplementation(() => { throw new Error("finish blew up"); });
        const next = vi.fn();
        const res = mkRes();
        l.handle(mkReq(), res, next);
        await tick();
        // already settled: a headerless response still receives the error
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: "finish blew up" }));
    });

    it("does not call next(err) twice when the response was already sent", async () => {
        call.mockResolvedValue({ allowed: true, count: 1, remaining: 1, resetAt: 1, bucket: 1 });
        const l = mk();
        vi.spyOn(l, "_finish").mockImplementation(() => { throw new Error("late"); });
        const next = vi.fn();
        const res = mkRes();
        (res as any).headersSent = true;
        l.handle(mkReq(), res, next);
        await tick();
        expect(next).not.toHaveBeenCalled();
    });

    it("clearKey / flushAll notify the primary so shared counters reset too", () => {
        const l = mk();
        l.clearKey("rl:ip:10.0.0.9");
        l.flushAll();
        expect(notify).toHaveBeenCalledWith(M.RL_CLEAR, { label: "chaos", key: "rl:ip:10.0.0.9" });
        expect(notify).toHaveBeenCalledWith(M.RL_CLEAR, { label: "chaos", key: null });
    });
});

describe("RateLimiter store exhaustion chaos", () => {
    beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_700_000_000_000); });
    afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

    it("fails OPEN (allows, full remaining) when the key table is full, warning once per gap", () => {
        const l = new RateLimiterMiddleware({ max: 2, windowMs: 60_000, maxKeys: 1, label: "full", keyBy: (r) => `k:${r.path}` });
        l.handle(mkReq("/a"), mkRes(), vi.fn());
        const next = vi.fn();
        const res = mkRes();
        l.handle(mkReq("/b"), res, next);
        expect(next).toHaveBeenCalledOnce();
        expect(res._h["RateLimit-Remaining"]).toBe(2);
        const t = l._lastStoreFullLog;
        l.handle(mkReq("/c"), mkRes(), vi.fn());
        expect(l._lastStoreFullLog).toBe(t);
        vi.advanceTimersByTime(CLUSTER_RPC_LIMITS.REJECT_LOG_GAP_MS + 1);
        l.handle(mkReq("/d"), mkRes(), vi.fn());
        expect(l._lastStoreFullLog).toBeGreaterThan(t);
    });

    it("rethrows unexpected store errors instead of failing open", () => {
        const l = new RateLimiterMiddleware({ max: 2, windowMs: 60_000, maxKeys: 5 });
        vi.spyOn(l._counter, "hit").mockImplementation(() => { throw new Error("corrupt"); });
        expect(() => l.handle(mkReq(), mkRes(), vi.fn())).toThrow("corrupt");
        const unbounded = new RateLimiterMiddleware({ max: 2, windowMs: 60_000 });
        vi.spyOn(unbounded._counter, "hit").mockImplementation(() => { throw Object.assign(new Error("x"), { name: "ECACHEFULL" }); });
        expect(() => unbounded.handle(mkReq(), mkRes(), vi.fn())).toThrow("x");
    });
});
