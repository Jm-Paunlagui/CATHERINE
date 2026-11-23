import type { Request, Response } from "express";
import NodeCache from "node-cache";
import jwt from "jsonwebtoken";
import {
    RateLimiterMiddleware,
    RateLimiterGroup,
    defaultRateLimiter,
    burstRateLimiter,
    perRouteRateLimiter,
    credentialEmailRateLimiter,
} from "../../../../src/middleware/security/RateLimiterMiddleware";
import {
    loginIpKey,
    loginUserKey,
    refreshKey,
    changePasswordKey,
    loginIpLimiter,
    loginUserLimiter,
    refreshRateLimiter,
    changePasswordRateLimiter,
    authRateLimiters,
} from "../../../../src/middleware/security/authRateLimiters";
import { COOKIE_NAMES, TOKEN_TYPES, TOKEN_ISSUER, TOKEN_AUDIENCES } from "../../../../src/constants/authTokens";

type Res = Response & { _status?: number; _body?: any; _headers: Record<string, any>; _finish?: () => void };

function mkReq(over: Record<string, unknown> = {}): Request {
    return { ip: "10.0.0.1", path: "/api/v1/x", method: "GET", headers: {}, ...over } as unknown as Request;
}
function mkRes(): Res {
    const headers: Record<string, any> = {};
    const handlers: Record<string, () => void> = {};
    const res: any = {
        statusCode: 200,
        locals: {},
        headersSent: false,
        _headers: headers,
        setHeader(k: string, v: unknown) { headers[k] = v; },
        status(c: number) { res._status = c; return res; },
        json(b: unknown) { res._body = b; return res; },
        once(ev: string, fn: () => void) { handlers[ev] = fn; },
        emitFinish() { handlers.finish?.(); },
    };
    return res;
}

describe("RateLimiterMiddleware constructor and key generation", () => {
    it("falls back to env defaults and the 'ip' generator", () => {
        const l = new RateLimiterMiddleware();
        expect(l._max).toBe(99999);
        expect(l._windowMs).toBe(60000);
        expect(l._keyBy).toBe("ip");
        l._store.close();
    });

    it("rejects invalid count mode, max, and window", () => {
        expect(() => new RateLimiterMiddleware({ max: 1, countMode: "bogus" as never })).toThrow(/countMode/);
        expect(() => new RateLimiterMiddleware({ max: 0 })).toThrow(RangeError);
        expect(() => new RateLimiterMiddleware({ max: 1, windowMs: 0 })).toThrow(RangeError);
    });

    it("sanitises the label used on the cluster wire", () => {
        const l = new RateLimiterMiddleware({ max: 1, label: "a b/c" + "x".repeat(100) });
        expect(l._sharedLabel).toMatch(/^[A-Za-z0-9:_-]{1,64}$/);
        const empty = new RateLimiterMiddleware({ max: 1, label: "" });
        expect(empty._sharedLabel).toBe("RateLimit");
    });

    it("builds each key shape and falls back to the IP when the principal is missing", () => {
        const K = RateLimiterMiddleware.keyGenerators;
        const anon = mkReq();
        expect(K.ip(anon)).toBe("rl:ip:10.0.0.1");
        expect(K.user(anon)).toBe("rl:ip:10.0.0.1");
        expect(K.user(mkReq({ user: { sub: "u1" } }))).toBe("rl:user:u1");
        expect(K.apiKey(anon)).toBe("rl:ip:10.0.0.1");
        expect(K.apiKey(mkReq({ headers: { "x-api-key": "k" } }))).toBe("rl:apikey:k");
        expect(K.ipAndRoute(anon)).toBe("rl:ip+route:10.0.0.1:/api/v1/x");
        expect(K.ipAndRoute(mkReq({ route: { path: "/r" } }))).toBe("rl:ip+route:10.0.0.1:/r");
        expect(K.userAndRoute(anon)).toBe("rl:user+route:10.0.0.1:/api/v1/x");
        expect(K.userAndRoute(mkReq({ user: { sub: "u" }, route: { path: "/r" } }))).toBe("rl:user+route:u:/r");
    });

    it("extractIp falls back to the socket and then 'unknown'", () => {
        expect(RateLimiterMiddleware.extractIp({ socket: { remoteAddress: "1.2.3.4" } } as Request)).toBe("1.2.3.4");
        expect(RateLimiterMiddleware.extractIp({} as Request)).toBe("unknown");
    });

    it("selects a generator by name, by function, and defaults on unknown names", () => {
        const byFn = new RateLimiterMiddleware({ max: 1, keyBy: () => "custom" });
        expect(byFn._getKey(mkReq())).toBe("custom");
        const byName = new RateLimiterMiddleware({ max: 1, keyBy: "user" });
        expect(byName._getKey(mkReq({ user: { sub: "z" } }))).toBe("rl:user:z");
        const bogus = new RateLimiterMiddleware({ max: 1, keyBy: "nope" as never });
        expect(bogus._getKey(mkReq())).toBe("rl:ip:10.0.0.1");
    });

    it("exports configured singletons and a frozen group that aggregates stats and flushes", () => {
        expect(defaultRateLimiter._label).toBe("RateLimit:default");
        expect(burstRateLimiter._max).toBe(5);
        expect(perRouteRateLimiter._max).toBe(30);
        expect(credentialEmailRateLimiter._label).toBe("RateLimit:credential-email");
        const a = new RateLimiterMiddleware({ max: 1, label: "A" });
        const b = new RateLimiterMiddleware({ max: 1, label: "B" });
        const g = new RateLimiterGroup([a, b]);
        expect(g.members).toHaveLength(2);
        expect(Object.keys(g.getStats()).sort()).toEqual(["A", "B"]);
        a.handle(mkReq(), mkRes(), () => {});
        g.flushAll();
        expect(a._store.keys()).toHaveLength(0);
        expect(authRateLimiters.members).toHaveLength(4);
    });
});

describe("RateLimiterMiddleware.handle", () => {
    it("bypasses OPTIONS, health probes, and skipped requests without counting", () => {
        const l = new RateLimiterMiddleware({ max: 1, windowMs: 60000, skip: (r) => r.path === "/skip" });
        const next = vi.fn();
        l.handle(mkReq({ method: "OPTIONS" }), mkRes(), next);
        l.handle(mkReq({ path: "/api/v1/health/ready" }), mkRes(), next);
        l.handle(mkReq({ path: "/skip" }), mkRes(), next);
        expect(next).toHaveBeenCalledTimes(3);
        expect(l._store.keys()).toHaveLength(0);
        // look-alike path is NOT exempt
        const res = mkRes();
        l.handle(mkReq({ path: "/api/v1/healthz-evil" }), res, next);
        expect(l._store.keys()).toHaveLength(1);
    });

    it("emits headers, 429 with Retry-After and marks res.locals", () => {
        const l = new RateLimiterMiddleware({ max: 1, windowMs: 60000, label: "L" });
        l.handle(mkReq(), mkRes(), () => {});
        const res = mkRes();
        const next = vi.fn();
        l.handle(mkReq(), res, next);
        expect(next).not.toHaveBeenCalled();
        expect(res._status).toBe(429);
        expect(res._body.error.type).toBe("RateLimitExceeded");
        expect(res._headers["Retry-After"]).toBeGreaterThanOrEqual(1);
        expect(res._headers["RateLimit-Policy"]).toBe("1;w=60");
        expect(res._headers["RateLimit-Remaining"]).toBe(0);
        expect(res.locals.rateLimitedBy).toBe("L");
    });

    it("dryRun lets the request through but still reports the breach", () => {
        const l = new RateLimiterMiddleware({ max: 1, windowMs: 60000, dryRun: true });
        l.handle(mkReq(), mkRes(), () => {});
        const res = mkRes();
        const next = vi.fn();
        l.handle(mkReq(), res, next);
        expect(next).toHaveBeenCalledOnce();
        expect(res._status).toBeUndefined();
        expect(res.locals.rateLimitedBy).toBeUndefined();
    });

    it("delegates to onLimit with retry details", () => {
        const onLimit = vi.fn().mockReturnValue("handled");
        const l = new RateLimiterMiddleware({ max: 1, windowMs: 60000, onLimit });
        l.handle(mkReq(), mkRes(), () => {});
        l.handle(mkReq(), mkRes(), () => {});
        expect(onLimit.mock.calls[0][2]).toMatchObject({ allowed: false, max: 1, windowMs: 60000 });
        expect(onLimit.mock.calls[0][2].retryAfter).toBeGreaterThanOrEqual(1);
    });

    it("tolerates a response without locals", () => {
        const l = new RateLimiterMiddleware({ max: 1, windowMs: 60000 });
        l.handle(mkReq(), mkRes(), () => {});
        const res = mkRes();
        delete (res as { locals?: unknown }).locals;
        expect(() => l.handle(mkReq(), res, () => {})).not.toThrow();
        expect(res._status).toBe(429);
    });

    it("clearKey and flushAll reset counters", () => {
        const l = new RateLimiterMiddleware({ max: 1, windowMs: 60000 });
        l.handle(mkReq(), mkRes(), () => {});
        expect(l.clearKey("rl:ip:10.0.0.1:" + Math.floor(Date.now() / 60000) * 60000)).toBeGreaterThanOrEqual(0);
        l.handle(mkReq(), mkRes(), () => {});
        l.flushAll();
        const next = vi.fn();
        l.handle(mkReq(), mkRes(), next);
        expect(next).toHaveBeenCalledOnce();
        expect(l.getStats()).toHaveProperty("keys");
    });
});

describe("RateLimiterMiddleware failures-only mode (refund)", () => {
    it("refunds on success so only failed attempts count", () => {
        const l = new RateLimiterMiddleware({ max: 2, windowMs: 60000, countMode: "failures" });
        for (let i = 0; i < 5; i++) {
            const res = mkRes();
            const next = vi.fn();
            l.handle(mkReq(), res, next);
            expect(next).toHaveBeenCalled();
            res.statusCode = 200;
            (res as any).emitFinish();
        }
    });

    it("keeps failed attempts counted and blocks at the limit", () => {
        const l = new RateLimiterMiddleware({ max: 2, windowMs: 60000, countMode: "failures" });
        for (let i = 0; i < 2; i++) {
            const res = mkRes();
            l.handle(mkReq(), res, () => {});
            res.statusCode = 401;
            (res as any).emitFinish();
        }
        const res = mkRes();
        l.handle(mkReq(), res, () => {});
        expect(res._status).toBe(429);
    });

    it("refunds a failure that a LATER limiter refused (not charged to this one)", () => {
        const l = new RateLimiterMiddleware({ max: 1, windowMs: 60000, countMode: "failures", label: "me" });
        const res = mkRes();
        l.handle(mkReq(), res, () => {});
        res.statusCode = 429;
        res.locals.rateLimitedBy = "other";
        (res as any).emitFinish();
        const next = vi.fn();
        l.handle(mkReq(), mkRes(), next);
        expect(next).toHaveBeenCalledOnce();
    });

    it("does not refund when this limiter itself refused", () => {
        const l = new RateLimiterMiddleware({ max: 1, windowMs: 60000, countMode: "failures", label: "me" });
        const res = mkRes();
        l.handle(mkReq(), res, () => {});
        res.statusCode = 401;
        res.locals.rateLimitedBy = "me";
        (res as any).emitFinish();
        const res2 = mkRes();
        l.handle(mkReq(), res2, () => {});
        expect(res2._status).toBe(429);
    });

    it("swallows a refund failure instead of crashing the response", () => {
        const l = new RateLimiterMiddleware({ max: 2, windowMs: 60000, countMode: "failures" });
        vi.spyOn(l._counter, "refund").mockImplementation(() => { throw new Error("store gone"); });
        const res = mkRes();
        l.handle(mkReq(), res, () => {});
        res.statusCode = 200;
        expect(() => (res as any).emitFinish()).not.toThrow();
    });

    it("_refund with a bucketless local result is a no-op", () => {
        const l = new RateLimiterMiddleware({ max: 2, windowMs: 60000 });
        const spy = vi.spyOn(l._counter, "refund");
        l._refund("k", { allowed: true, count: 0, remaining: 2, resetAt: 1, source: "local" });
        expect(spy).not.toHaveBeenCalled();
    });
});

describe("auth rate limiter keys (CWE-400 key flooding, CWE-117 log injection, CWE-345)", () => {
    const req = (over: Record<string, unknown>) => mkReq(over);

    it("loginIpKey is per client IP", () => {
        expect(loginIpKey(req({}))).toBe("rl:login:ip:10.0.0.1");
    });

    it("collapses non-canonical or hostile user ids to a single '-' bucket", () => {
        const hostile = ["a\nb", "x".repeat(65), "bad id", "", { $ne: null }, ["a"], null, undefined, NaN, "é"];
        for (const userId of hostile) {
            expect(loginUserKey(req({ body: { userId } }))).toBe("rl:login:u:10.0.0.1:-");
        }
        expect(loginUserKey(req({}))).toBe("rl:login:u:10.0.0.1:-");
    });

    it("canonicalises usable ids so 007 and 7, and padded spellings, share a bucket", () => {
        expect(loginUserKey(req({ body: { userId: " 007 " } }))).toBe("rl:login:u:10.0.0.1:7");
        expect(loginUserKey(req({ body: { userId: 7 } }))).toBe("rl:login:u:10.0.0.1:7");
        expect(loginUserKey(req({ body: { userId: "j.doe@x-y" } }))).toBe("rl:login:u:10.0.0.1:j.doe@x-y");
    });

    it("keys a refresh family only for a fully verified signed cookie", () => {
        const fid = "f".repeat(36);
        const good = jwt.sign({ fid, type: TOKEN_TYPES.REFRESH }, process.env.JWT_SECRET as string, {
            audience: TOKEN_AUDIENCES.REFRESH,
            issuer: TOKEN_ISSUER,
        });
        const k = refreshKey(req({ signedCookies: { [COOKIE_NAMES.REFRESH]: good } }));
        expect(k).toMatch(/^rl:refresh:f:[0-9a-f]{32}$/);
        expect(k).not.toContain(fid);
        const forged = jwt.sign({ fid, type: TOKEN_TYPES.REFRESH }, "attacker-secret", {
            audience: TOKEN_AUDIENCES.REFRESH,
            issuer: TOKEN_ISSUER,
        });
        expect(refreshKey(req({ signedCookies: { [COOKIE_NAMES.REFRESH]: forged } }))).toBe("rl:refresh:ip:10.0.0.1");
        expect(refreshKey(req({}))).toBe("rl:refresh:ip:10.0.0.1");
    });

    it("keys change-password by canonical subject, else by IP", () => {
        expect(changePasswordKey(req({ user: { sub: " 042 " } }))).toBe("rl:pwchange:42");
        for (const sub of [undefined, null, ""]) {
            expect(changePasswordKey(req({ user: { sub } }))).toBe("rl:pwchange:ip:10.0.0.1");
        }
        expect(changePasswordKey(req({}))).toBe("rl:pwchange:ip:10.0.0.1");
    });

    it("exposes four limiters whose 429 body carries the retry hint", () => {
        const limiters = [loginIpLimiter, loginUserLimiter, refreshRateLimiter, changePasswordRateLimiter];
        expect(limiters.every((l) => l instanceof RateLimiterMiddleware)).toBe(true);
        const l = limiters[3];
        const key = "unit-" + Math.random();
        const r = mkReq({ user: { sub: key } });
        let res = mkRes();
        for (let i = 0; i < l._max + 1; i++) {
            res = mkRes();
            l.handle(r, res, () => {});
        }
        expect(res._status).toBe(429);
        expect(res._body.error.details[0].field).toBe("retryAfter");
        l.flushAll();
    });
});

describe("RateLimiterMiddleware with an injected store", () => {
    it("uses the supplied NodeCache", () => {
        const store = new NodeCache();
        const l = new RateLimiterMiddleware({ max: 3, windowMs: 1000, store });
        expect(l._store).toBe(store);
        store.close();
    });
});
