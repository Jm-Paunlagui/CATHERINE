/**
 * @fileoverview RateLimiterMiddleware wave 2: constructor validation, headers,
 * refusal paths, FAILURES count mode refunds, cluster shared/fallback paths,
 * store-full fail-open, key generators and the limiter group.
 */
import { EventEmitter } from "events";

const log = vi.hoisted(() => ({ notice: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock("../../../../src/utils/logger", () => ({ logger: log }));

import {
    RateLimiterMiddleware,
    RateLimiterGroup,
    defaultRateLimiter,
    burstRateLimiter,
    perRouteRateLimiter,
    credentialEmailRateLimiter,
} from "../../../../src/middleware/security/RateLimiterMiddleware";
import { clusterRpc } from "../../../../src/utils/cluster/ClusterRpcClient";

function mkRes() {
    const res: any = new EventEmitter();
    res.statusCode = 200;
    res.hdrs = {} as Record<string, unknown>;
    res.locals = {};
    res.headersSent = false;
    res.setHeader = (k: string, v: unknown) => { res.hdrs[k] = v; };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: unknown) => { res.body = b; return res; };
    return res;
}
const mkReq = (over: Record<string, unknown> = {}) =>
    ({ method: "GET", path: "/api/v1/things", ip: "9.9.9.9", headers: {}, socket: {}, ...over }) as any;
const tick = () => new Promise<void>((r) => setImmediate(r));

describe("RateLimiterMiddleware wave2", () => {
    beforeEach(() => {
        Object.values(log).forEach((f) => f.mockClear());
        vi.restoreAllMocks();
    });

    describe("constructor", () => {
        it("reads env defaults when options are absent", () => {
            const m = new RateLimiterMiddleware();
            expect(m._max).toBe(parseInt(process.env.RATE_LIMIT_MAX || "100", 10));
            expect(m._windowMs).toBe(parseInt(process.env.RATE_LIMIT_WINDOW_MS || "900000", 10));
            expect(m._keyBy).toBe("ip");
            expect(m._label).toBe("RateLimit");
            expect(m._countMode).toBe("all");
        });
        it("rejects invalid max, windowMs and countMode", () => {
            expect(() => new RateLimiterMiddleware({ max: 0 })).toThrow(RangeError);
            expect(() => new RateLimiterMiddleware({ windowMs: -1 })).toThrow(/windowMs/);
            expect(() => new RateLimiterMiddleware({ countMode: "bogus" as any })).toThrow(/countMode/);
        });
        it("sanitises the shared label and falls back when empty", () => {
            expect(new RateLimiterMiddleware({ label: "a b/c" })._sharedLabel).toBe("a_b_c");
            expect(new RateLimiterMiddleware({ label: "x".repeat(80) })._sharedLabel).toHaveLength(64);
            expect(new RateLimiterMiddleware({ label: "" })._label).toBe("");
            expect(new RateLimiterMiddleware({ label: "" })._sharedLabel).toBe("RateLimit");
        });
        it("preset instances carry their documented limits", () => {
            expect(burstRateLimiter._max).toBe(5);
            expect(credentialEmailRateLimiter._keyBy).toBe("user");
            expect(perRouteRateLimiter._keyBy).toBe("ipAndRoute");
            expect(defaultRateLimiter._label).toBe("RateLimit:default");
        });
    });

    describe("local path", () => {
        it("sets IETF headers, then refuses with 429 + Retry-After once max is reached", () => {
            const m = new RateLimiterMiddleware({ max: 2, windowMs: 60_000 });
            const outcomes: any[] = [];
            for (let i = 0; i < 3; i++) {
                const res = mkRes(); const next = vi.fn();
                m.handle(mkReq(), res, next);
                outcomes.push({ res, next });
            }
            expect(outcomes[0].next).toHaveBeenCalled();
            expect(outcomes[0].res.hdrs["RateLimit-Limit"]).toBe(2);
            expect(outcomes[0].res.hdrs["RateLimit-Policy"]).toBe("2;w=60");
            expect(outcomes[2].next).not.toHaveBeenCalled();
            expect(outcomes[2].res.statusCode).toBe(429);
            expect(outcomes[2].res.body.error.type).toBe("RateLimitExceeded");
            expect(outcomes[2].res.hdrs["Retry-After"]).toBeGreaterThanOrEqual(1);
            expect(outcomes[2].res.hdrs["RateLimit-Remaining"]).toBe(0);
            expect(outcomes[2].res.locals.rateLimitedBy).toBe("RateLimit");
        });

        it("skips OPTIONS, health probes and skip() requests without counting", () => {
            const m = new RateLimiterMiddleware({ max: 1, windowMs: 60_000, skip: (r) => r.path === "/skipme" });
            for (const r of [mkReq({ method: "OPTIONS" }), mkReq({ path: "/api/v2/health/ready" }), mkReq({ path: "/skipme" })]) {
                for (let i = 0; i < 3; i++) {
                    const next = vi.fn();
                    m.handle(r, mkRes(), next);
                    expect(next).toHaveBeenCalled();
                }
            }
            expect(m._store.keys()).toEqual([]);
        });

        it("healthcheck-like paths are NOT bypassed", () => {
            const m = new RateLimiterMiddleware({ max: 1, windowMs: 60_000 });
            m.handle(mkReq({ path: "/api/v1/healthcheck" }), mkRes(), vi.fn());
            const res = mkRes(); const next = vi.fn();
            m.handle(mkReq({ path: "/api/v1/healthcheck" }), res, next);
            expect(res.statusCode).toBe(429);
        });

        it("dryRun passes the request on and does not mark rateLimitedBy", () => {
            const m = new RateLimiterMiddleware({ max: 1, windowMs: 60_000, dryRun: true });
            m.handle(mkReq(), mkRes(), vi.fn());
            const res = mkRes(); const next = vi.fn();
            m.handle(mkReq(), res, next);
            expect(next).toHaveBeenCalledOnce();
            expect(res.locals.rateLimitedBy).toBeUndefined();
        });

        it("a response without locals is tolerated on refusal", () => {
            const m = new RateLimiterMiddleware({ max: 1, windowMs: 60_000 });
            m.handle(mkReq(), mkRes(), vi.fn());
            const res = mkRes(); res.locals = undefined;
            expect(() => m.handle(mkReq(), res, vi.fn())).not.toThrow();
            expect(res.statusCode).toBe(429);
        });

        it("onLimit receives retry details and owns the response", () => {
            const onLimit = vi.fn();
            const m = new RateLimiterMiddleware({ max: 1, windowMs: 60_000, onLimit });
            m.handle(mkReq(), mkRes(), vi.fn());
            const res = mkRes();
            m.handle(mkReq(), res, vi.fn());
            expect(onLimit).toHaveBeenCalledWith(expect.anything(), res, expect.objectContaining({ max: 1, windowMs: 60_000, allowed: false, retryAfter: expect.any(Number) }));
            expect(res.body).toBeUndefined();
        });

        it("Retry-After is at least 1 second even when the window is about to roll", () => {
            vi.useFakeTimers();
            try {
                vi.setSystemTime(new Date(59_999 + 120_000));
                const m = new RateLimiterMiddleware({ max: 1, windowMs: 60_000 });
                m.handle(mkReq(), mkRes(), vi.fn());
                const res = mkRes();
                m.handle(mkReq(), res, vi.fn());
                expect(res.hdrs["Retry-After"]).toBeGreaterThanOrEqual(1);
            } finally { vi.useRealTimers(); }
        });

        it("store full fails open and warns at most once per minute", () => {
            vi.useFakeTimers();
            try {
                const m = new RateLimiterMiddleware({ max: 5, windowMs: 60_000, maxKeys: 1 });
                m.handle(mkReq({ ip: "1.1.1.1" }), mkRes(), vi.fn());
                const next = vi.fn(); const res = mkRes();
                m.handle(mkReq({ ip: "2.2.2.2" }), res, next);
                m.handle(mkReq({ ip: "3.3.3.3" }), mkRes(), vi.fn());
                expect(next).toHaveBeenCalled();
                expect(res.hdrs["RateLimit-Remaining"]).toBe(5);
                expect(log.warning).toHaveBeenCalledTimes(1);
                vi.advanceTimersByTime(61_000);
                m.handle(mkReq({ ip: "4.4.4.4" }), mkRes(), vi.fn());
                expect(log.warning).toHaveBeenCalledTimes(2);
            } finally { vi.useRealTimers(); }
        });

        it("a non-capacity counter failure propagates", () => {
            const m = new RateLimiterMiddleware();
            vi.spyOn(m._counter, "hit").mockImplementation(() => { throw new Error("corrupt"); });
            expect(() => m.handle(mkReq(), mkRes(), vi.fn())).toThrow("corrupt");
            const bounded = new RateLimiterMiddleware({ maxKeys: 3 });
            vi.spyOn(bounded._counter, "hit").mockImplementation(() => { throw new Error("corrupt"); });
            expect(() => bounded.handle(mkReq(), mkRes(), vi.fn())).toThrow("corrupt");
        });
    });

    describe("FAILURES count mode", () => {
        it("refunds a successful request and keeps a failed one counted", () => {
            const m = new RateLimiterMiddleware({ max: 2, windowMs: 60_000, countMode: "failures" });
            const ok = mkRes(); m.handle(mkReq(), ok, vi.fn()); ok.statusCode = 200; ok.emit("finish");
            const ok2 = mkRes(); m.handle(mkReq(), ok2, vi.fn()); ok2.statusCode = 204; ok2.emit("finish");
            // both refunded: still room for two more
            const f1 = mkRes(); m.handle(mkReq(), f1, vi.fn()); f1.statusCode = 401; f1.emit("finish");
            const f2 = mkRes(); m.handle(mkReq(), f2, vi.fn()); f2.statusCode = 401; f2.emit("finish");
            const blocked = mkRes(); const next = vi.fn();
            m.handle(mkReq(), blocked, next);
            expect(blocked.statusCode).toBe(429);
        });

        it("refunds even a failure when a LATER limiter refused the request", () => {
            const m = new RateLimiterMiddleware({ max: 1, windowMs: 60_000, countMode: "failures", label: "A" });
            const res = mkRes(); m.handle(mkReq(), res, vi.fn());
            res.statusCode = 429; res.locals.rateLimitedBy = "B"; res.emit("finish");
            const again = mkRes(); const next = vi.fn();
            m.handle(mkReq(), again, next);
            expect(next).toHaveBeenCalled();
        });

        it("does not refund when this same limiter refused", () => {
            const m = new RateLimiterMiddleware({ max: 1, windowMs: 60_000, countMode: "failures", label: "A" });
            const res = mkRes(); m.handle(mkReq(), res, vi.fn());
            res.statusCode = 400; res.locals.rateLimitedBy = "A"; res.emit("finish");
            const again = mkRes();
            m.handle(mkReq(), again, vi.fn());
            expect(again.statusCode).toBe(429);
        });

        it("a refund error is swallowed", () => {
            const m = new RateLimiterMiddleware({ max: 2, windowMs: 60_000, countMode: "failures" });
            vi.spyOn(m._counter, "refund").mockImplementation(() => { throw new Error("x"); });
            const res = mkRes(); m.handle(mkReq(), res, vi.fn());
            expect(() => res.emit("finish")).not.toThrow();
        });

        it("_refund with no bucket reserved is a no-op", () => {
            const m = new RateLimiterMiddleware();
            const spy = vi.spyOn(m._counter, "refund");
            m._refund("k", { allowed: true, count: 1, remaining: 1, resetAt: 1, source: "local" } as any);
            expect(spy).not.toHaveBeenCalled();
        });
    });

    describe("cluster shared path", () => {
        const sharedHit = { allowed: true, count: 1, remaining: 4, resetAt: Date.now() + 60_000, bucket: 10, retryAt: undefined };
        function active() { return vi.spyOn(clusterRpc, "active", "get").mockReturnValue(true); }

        it("uses the primary's verdict and marks the result shared", async () => {
            active();
            const call = vi.spyOn(clusterRpc, "call").mockResolvedValue(sharedHit);
            const m = new RateLimiterMiddleware({ max: 5, windowMs: 60_000, label: "RL:x" });
            const res = mkRes(); const next = vi.fn();
            m.handle(mkReq(), res, next);
            await tick();
            expect(call).toHaveBeenCalledWith("primary", "rl.hit", expect.objectContaining({ label: "RL:x", max: 5 }), expect.any(Object));
            expect(next).toHaveBeenCalledOnce();
            expect(res.hdrs["RateLimit-Remaining"]).toBe(4);
        });

        it("a refused shared hit answers 429 using the primary's retryAt", async () => {
            active();
            vi.spyOn(clusterRpc, "call").mockResolvedValue({ allowed: false, count: 5, remaining: 0, resetAt: Date.now() + 60_000, retryAt: Date.now() + 30_000 });
            const m = new RateLimiterMiddleware({ max: 5, windowMs: 60_000 });
            const res = mkRes();
            m.handle(mkReq(), res, vi.fn());
            await tick();
            expect(res.statusCode).toBe(429);
            expect(res.hdrs["Retry-After"]).toBeGreaterThanOrEqual(29);
        });

        it("primary declining (fallback:true) counts locally and warns once per minute", async () => {
            active();
            vi.spyOn(clusterRpc, "call").mockResolvedValue({ fallback: true });
            const m = new RateLimiterMiddleware({ max: 1, windowMs: 60_000 });
            const a = mkRes(); const na = vi.fn();
            m.handle(mkReq(), a, na); await tick();
            const b = mkRes();
            m.handle(mkReq(), b, vi.fn()); await tick();
            expect(na).toHaveBeenCalled();
            expect(b.statusCode).toBe(429);
            const fallbackWarnings = log.warning.mock.calls.filter((c) => !String(c[0]).includes("Limit exceeded"));
            expect(fallbackWarnings).toHaveLength(1);
        });

        it("an RPC failure falls back to the local counter without refusing anyone", async () => {
            active();
            vi.spyOn(clusterRpc, "call").mockRejectedValue(Object.assign(new Error("timeout"), { code: "RPC_TIMEOUT" }));
            const m = new RateLimiterMiddleware({ max: 3, windowMs: 60_000 });
            const next = vi.fn();
            m.handle(mkReq(), mkRes(), next); await tick();
            expect(next).toHaveBeenCalledOnce();
            expect(next.mock.calls[0]).toHaveLength(0);
        });

        it("an RPC failure without code or message still falls back", async () => {
            active();
            vi.spyOn(clusterRpc, "call").mockRejectedValue(undefined);
            const m = new RateLimiterMiddleware({ max: 3, windowMs: 60_000 });
            const next = vi.fn();
            m.handle(mkReq(), mkRes(), next); await tick();
            expect(next).toHaveBeenCalledOnce();
        });

        it("args the IPC schema rejects are counted locally with no RPC", async () => {
            active();
            const call = vi.spyOn(clusterRpc, "call").mockResolvedValue(sharedHit);
            const m = new RateLimiterMiddleware({ max: 3, windowMs: 60_000, keyBy: () => "k".repeat(400) });
            const next = vi.fn();
            m.handle(mkReq(), mkRes(), next); await tick();
            expect(call).not.toHaveBeenCalled();
            expect(next).toHaveBeenCalledOnce();
        });

        it("an error thrown while finishing is forwarded to next(err) exactly once", async () => {
            active();
            vi.spyOn(clusterRpc, "call").mockResolvedValue(sharedHit);
            const m = new RateLimiterMiddleware({ max: 5, windowMs: 60_000 });
            vi.spyOn(m, "_finish").mockImplementation(() => { throw new Error("finish blew up"); });
            const next = vi.fn();
            m.handle(mkReq(), mkRes(), next); await tick();
            // _finish ran after `settled`, and headers are not sent, so the error is forwarded
            expect(next).toHaveBeenCalledOnce();
            expect(next.mock.calls[0][0]).toBeInstanceOf(Error);
        });

        it("a finish error after headers were sent is not forwarded", async () => {
            active();
            vi.spyOn(clusterRpc, "call").mockResolvedValue(sharedHit);
            const m = new RateLimiterMiddleware({ max: 5, windowMs: 60_000 });
            vi.spyOn(m, "_finish").mockImplementation(() => { throw new Error("late"); });
            const res = mkRes(); res.headersSent = true;
            const next = vi.fn();
            m.handle(mkReq(), res, next); await tick();
            expect(next).not.toHaveBeenCalled();
        });

        it("shared FAILURES-mode success refunds through a notify to the primary", async () => {
            active();
            vi.spyOn(clusterRpc, "call").mockResolvedValue(sharedHit);
            const notify = vi.spyOn(clusterRpc, "notify").mockReturnValue(true);
            const m = new RateLimiterMiddleware({ max: 5, windowMs: 60_000, countMode: "failures", label: "RL:f" });
            const res = mkRes();
            m.handle(mkReq(), res, vi.fn()); await tick();
            res.statusCode = 200; res.emit("finish");
            expect(notify).toHaveBeenCalledWith("rl.refund", expect.objectContaining({ label: "RL:f", bucket: 10 }));
        });

        it("shared refund is dropped when the cluster went inactive or args are invalid", () => {
            const m = new RateLimiterMiddleware({ windowMs: 60_000 });
            const notify = vi.spyOn(clusterRpc, "notify").mockReturnValue(true);
            m._refund("k", { ...sharedHit, source: "shared" } as any); // inactive
            vi.spyOn(clusterRpc, "active", "get").mockReturnValue(true);
            m._refund("", { ...sharedHit, source: "shared" } as any); // bad key
            expect(notify).not.toHaveBeenCalled();
        });
    });

    describe("admin helpers", () => {
        it("clearKey and flushAll act locally and notify the primary when clustered", () => {
            const m = new RateLimiterMiddleware({ max: 1, windowMs: 60_000, label: "RL:c" });
            const notify = vi.spyOn(clusterRpc, "notify").mockReturnValue(true);
            m.handle(mkReq(), mkRes(), vi.fn());
            const key = m._store.keys()[0];
            expect(m.clearKey(key.split(":").slice(0, 3).join(":"))).toBeGreaterThanOrEqual(0);
            expect(notify).not.toHaveBeenCalled();
            vi.spyOn(clusterRpc, "active", "get").mockReturnValue(true);
            m.clearKey("rl:ip:9.9.9.9");
            m.flushAll();
            expect(notify).toHaveBeenNthCalledWith(1, "rl.clear", { label: "RL:c", key: "rl:ip:9.9.9.9" });
            expect(notify).toHaveBeenNthCalledWith(2, "rl.clear", { label: "RL:c", key: null });
            expect(m._store.keys()).toEqual([]);
            expect(m.getStats()).toHaveProperty("keys", 0);
        });

        it("_notifyClear skips keys the IPC schema rejects", () => {
            vi.spyOn(clusterRpc, "active", "get").mockReturnValue(true);
            const notify = vi.spyOn(clusterRpc, "notify").mockReturnValue(true);
            new RateLimiterMiddleware()._notifyClear("k".repeat(400));
            expect(notify).not.toHaveBeenCalled();
        });

        it("RateLimiterGroup is frozen, flushes and reports stats per label", () => {
            const a = new RateLimiterMiddleware({ label: "ga" });
            const b = new RateLimiterMiddleware({ label: "gb" });
            const g = new RateLimiterGroup([a, b]);
            a.handle(mkReq(), mkRes(), vi.fn());
            expect(Object.keys(g.getStats())).toEqual(["ga", "gb"]);
            expect(g.members).toHaveLength(2);
            expect(Object.isFrozen(g.members)).toBe(true);
            g.flushAll();
            expect(a._store.keys()).toEqual([]);
        });
    });

    describe("key generators", () => {
        const g = RateLimiterMiddleware.keyGenerators;
        it("extractIp prefers req.ip, then the socket, then unknown", () => {
            expect(RateLimiterMiddleware.extractIp({ ip: "1.1.1.1" } as any)).toBe("1.1.1.1");
            expect(RateLimiterMiddleware.extractIp({ socket: { remoteAddress: "2.2.2.2" } } as any)).toBe("2.2.2.2");
            expect(RateLimiterMiddleware.extractIp({} as any)).toBe("unknown");
        });
        it("ignores a spoofed X-Forwarded-For", () => {
            expect(g.ip(mkReq({ headers: { "x-forwarded-for": "6.6.6.6" } }))).toBe("rl:ip:9.9.9.9");
        });
        it("user, apiKey, ipAndRoute, userAndRoute", () => {
            expect(g.user(mkReq({ user: { sub: "u1" } }))).toBe("rl:user:u1");
            expect(g.user(mkReq())).toBe("rl:ip:9.9.9.9");
            expect(g.apiKey(mkReq({ headers: { "x-api-key": "k" } }))).toBe("rl:apikey:k");
            expect(g.apiKey(mkReq())).toBe("rl:ip:9.9.9.9");
            expect(g.ipAndRoute(mkReq({ route: { path: "/r" } }))).toBe("rl:ip+route:9.9.9.9:/r");
            expect(g.ipAndRoute(mkReq())).toBe("rl:ip+route:9.9.9.9:/api/v1/things");
            expect(g.userAndRoute(mkReq({ user: { sub: "u" }, route: { path: "/r" } }))).toBe("rl:user+route:u:/r");
            expect(g.userAndRoute(mkReq())).toBe("rl:user+route:9.9.9.9:/api/v1/things");
        });
        it("an unknown named key generator falls back to ip; a function is used verbatim", () => {
            const m = new RateLimiterMiddleware({ keyBy: "nonsense" as any });
            expect(m._getKey(mkReq())).toBe("rl:ip:9.9.9.9");
            expect(new RateLimiterMiddleware({ keyBy: () => "custom" })._getKey(mkReq())).toBe("custom");
        });
    });
});
