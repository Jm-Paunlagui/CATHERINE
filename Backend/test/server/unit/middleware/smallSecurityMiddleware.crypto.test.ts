import type { NextFunction, Request, Response } from "express";
import { ShutdownGateMiddleware, defaultShutdownGate, SHUTDOWN_RETRY_AFTER_SEC } from "../../../../src/middleware/security/ShutdownGateMiddleware";
import { PreventRedirectsMiddleware, defaultPreventRedirects } from "../../../../src/middleware/security/PreventRedirectsMiddleware";
import { IdempotencyMiddleware, GUARDED_METHODS, DEFAULT_TTL_SECONDS } from "../../../../src/middleware/security/IdempotencyMiddleware";
import { IpFilterMiddleware, defaultIpFilter } from "../../../../src/middleware/security/IpFilterMiddleware";
import { HelmetMiddleware, defaultHelmet } from "../../../../src/middleware/security/HelmetMiddleware";
import { registry } from "../../../../src/middleware/cache/CacheRegistry";

function mkRes() {
    const h: Record<string, any> = {};
    const res: any = {
        statusCode: 200,
        headers: h,
        setHeader: (k: string, v: unknown) => { h[k] = v; return res; },
        status: (c: number) => { res.statusCode = c; return res; },
        json: (b: unknown) => { res.body = b; return res; },
    };
    return res as Response & { body?: any; headers: Record<string, any> };
}

describe("ShutdownGateMiddleware", () => {
    it("passes everything while the server is healthy", () => {
        const g = new ShutdownGateMiddleware({ isShuttingDown: () => false });
        const next = vi.fn();
        g.handle({ method: "POST", originalUrl: "/api/v1/x" } as Request, mkRes(), next);
        expect(next).toHaveBeenCalledWith();
    });

    it("refuses new work with 503 and Connection: close while draining", () => {
        const g = new ShutdownGateMiddleware({ isShuttingDown: () => true });
        const next = vi.fn();
        const res = mkRes();
        g.handle({ method: "GET", originalUrl: "/api/v1/users" } as Request, res, next);
        const err = next.mock.calls[0][0];
        expect(err.statusCode ?? err.status).toBe(503);
        expect(res.headers.Connection).toBe("close");
        expect(SHUTDOWN_RETRY_AFTER_SEC).toBeGreaterThan(0);
    });

    it("keeps OPTIONS and real health probes reachable, but not look-alikes or query tricks", () => {
        const g = new ShutdownGateMiddleware({ isShuttingDown: () => true });
        const reach = (req: Partial<Request>) => {
            const next = vi.fn();
            g.handle(req as Request, mkRes(), next);
            return next.mock.calls[0].length === 0;
        };
        expect(reach({ method: "OPTIONS", originalUrl: "/api/v1/users" })).toBe(true);
        expect(reach({ method: "GET", originalUrl: "/api/v1/health" })).toBe(true);
        expect(reach({ method: "GET", originalUrl: "/api/v1/health/ready?x=1" })).toBe(true);
        expect(reach({ method: "GET", url: "/api/v2/health/live" })).toBe(true);
        expect(reach({ method: "GET", originalUrl: "/api/v1/healthy" })).toBe(false);
        expect(reach({ method: "GET", originalUrl: "/api/v1/users?next=/api/v1/health" })).toBe(false);
        expect(reach({ method: "GET" })).toBe(false);
    });

    it("default gate consults the in-flight registry (not shutting down in tests)", () => {
        const next = vi.fn();
        defaultShutdownGate.handle({ method: "GET", originalUrl: "/x" } as Request, mkRes(), next);
        expect(next).toHaveBeenCalledWith();
    });
});

describe("PreventRedirectsMiddleware", () => {
    const run = () => {
        const res = mkRes();
        const next = vi.fn();
        new PreventRedirectsMiddleware().handle({} as Request, res, next);
        expect(next).toHaveBeenCalledOnce();
        return res;
    };

    it("turns res.redirect(url) into a 302 JSON error carrying the target", () => {
        const res = run();
        res.redirect("https://evil.example/phish");
        expect(res.statusCode).toBe(302);
        expect(res.body).toMatchObject({
            status: "error",
            code: 302,
            message: "Found (Temporary Redirect)",
            error: { type: "RedirectPrevented", details: [{ field: "redirectTo", issue: "https://evil.example/phish" }] },
        });
    });

    it("honours explicit redirect statuses and names them", () => {
        const res = run();
        res.redirect(301, "/new");
        expect(res.statusCode).toBe(301);
        expect(res.body.message).toBe("Moved Permanently");
        res.redirect(308, "/n2");
        expect(res.body.message).toBe("Permanent Redirect");
    });

    it("downgrades a non-3xx status to 302 and uses a generic message for unknown 3xx", () => {
        const res = run();
        res.redirect(200, "/x");
        expect(res.statusCode).toBe(302);
        expect(res.body.code).toBe(200);
        expect(res.body.message).toBe("Redirect prevented");
        res.redirect(399, "/y");
        expect(res.statusCode).toBe(399);
        expect(res.body.message).toBe("Redirect prevented");
    });

    it("exports a default instance bound for app.use", () => {
        const next = vi.fn();
        defaultPreventRedirects.handle({} as Request, mkRes(), next);
        expect(next).toHaveBeenCalledOnce();
    });
});

describe("IdempotencyMiddleware", () => {
    let n = 0;
    const mk = (o: ConstructorParameters<typeof IdempotencyMiddleware>[0] = {}) =>
        new IdempotencyMiddleware({ storeName: `idem-crypto-${++n}`, ...o });
    const mkReq = (over: Record<string, unknown> = {}, key: string | null = "k1") =>
        ({
            method: "POST",
            baseUrl: "/api/v1/pay",
            path: "/",
            ip: "1.1.1.1",
            body: { a: 1, b: [1, 2] },
            originalUrl: "/api/v1/pay",
            get: (h: string) => (h.toLowerCase() === "idempotency-key" ? key : undefined),
            ...over,
        }) as unknown as Request;

    it("exposes constants", () => {
        expect(GUARDED_METHODS.has("POST")).toBe(true);
        expect(GUARDED_METHODS.has("GET")).toBe(false);
        expect(DEFAULT_TTL_SECONDS).toBe(86400);
    });

    it("ignores unguarded methods", () => {
        const next = vi.fn();
        mk().handle(mkReq({ method: "GET" }), mkRes(), next);
        expect(next).toHaveBeenCalledWith();
    });

    it("requires the header by default (400) and allows omission when optional", () => {
        const next = vi.fn();
        mk().handle(mkReq({}, null), mkRes(), next);
        expect(next.mock.calls[0][0].statusCode ?? next.mock.calls[0][0].status).toBe(400);
        const next2 = vi.fn();
        mk({ required: false }).handle(mkReq({}, null), mkRes(), next2);
        expect(next2).toHaveBeenCalledWith();
    });

    it("replays the first 2xx outcome for an identical retry without re-running the handler", () => {
        const m = mk();
        const first = mkRes();
        m.handle(mkReq(), first, vi.fn());
        first.statusCode = 201;
        first.json({ id: 7 });
        const replay = mkRes();
        const next = vi.fn();
        m.handle(mkReq({ body: { b: [1, 2], a: 1 } }), replay, next); // key order differs: same canonical body
        expect(next).not.toHaveBeenCalled();
        expect(replay.statusCode).toBe(201);
        expect(replay.body).toEqual({ id: 7 });
        expect(replay.headers["Idempotent-Replay"]).toBe("true");
    });

    it("rejects key reuse with a different body (409) - tamper/replay protection", () => {
        const m = mk();
        const first = mkRes();
        m.handle(mkReq(), first, vi.fn());
        first.json({ ok: true });
        const next = vi.fn();
        m.handle(mkReq({ body: { a: 2 } }), mkRes(), next);
        const err = next.mock.calls[0][0];
        expect(err.statusCode ?? err.status).toBe(409);
    });

    it("scopes keys per caller, route, and method so another user cannot read a cached outcome", () => {
        const m = mk();
        const a = mkRes();
        m.handle(mkReq({ ip: "1.1.1.1" }), a, vi.fn());
        a.json({ secret: "A" });
        for (const other of [mkReq({ ip: "2.2.2.2" }), mkReq({ baseUrl: "/api/v1/other" }), mkReq({ method: "PUT" })]) {
            const next = vi.fn();
            const res = mkRes();
            m.handle(other, res, next);
            expect(next).toHaveBeenCalledWith();
            expect(res.body).toBeUndefined();
        }
    });

    it("does not cache non-2xx outcomes (a failed attempt may be retried)", () => {
        const m = mk();
        const first = mkRes();
        m.handle(mkReq(), first, vi.fn());
        first.statusCode = 500;
        first.json({ err: 1 });
        const next = vi.fn();
        m.handle(mkReq(), mkRes(), next);
        expect(next).toHaveBeenCalledWith();
    });

    it("still answers when storing the outcome fails", () => {
        const m = mk();
        vi.spyOn(m._store, "set").mockImplementation(() => { throw new Error("full"); });
        const res = mkRes();
        m.handle(mkReq(), res, vi.fn());
        expect(() => res.json({ ok: 1 })).not.toThrow();
        expect(res.body).toEqual({ ok: 1 });
    });

    it("replays stored headers and uses user ids / route paths / anonymous callers in the key", () => {
        const m = mk();
        m._store.set(m._storageKey(mkReq(), "k1"), { status: 200, body: { r: 1 }, bodyHash: IdempotencyMiddleware._bodyHash({ a: 1, b: [1, 2] }), headers: { "X-A": "1" } }, 60);
        const res = mkRes();
        m.handle(mkReq(), res, vi.fn());
        expect(res.headers["X-A"]).toBe("1");
        expect(IdempotencyMiddleware._defaultCaller({ user: { id: 5 } } as Request)).toBe("5");
        expect(IdempotencyMiddleware._defaultCaller({ user: { userId: "u" } } as Request)).toBe("u");
        expect(IdempotencyMiddleware._defaultCaller({} as Request)).toBe("anonymous");
        expect(m._storageKey(mkReq({ route: { path: "/r" } }), "k")).toContain("/api/v1/pay/r");
    });

    it("canonicalises primitives, null, nested arrays/objects, and shares a pre-registered store", () => {
        expect(IdempotencyMiddleware._canonicalise(undefined)).toBe("null");
        expect(IdempotencyMiddleware._canonicalise({ b: [1, { z: 1, a: 2 }], a: null })).toBe('{"a":null,"b":[1,{"a":2,"z":1}]}');
        const name = `idem-shared-${++n}`;
        const first = new IdempotencyMiddleware({ storeName: name });
        const second = new IdempotencyMiddleware({ storeName: name });
        expect(second._store).toBe(first._store);
        expect(registry.has(name)).toBe(true);
    });
});

describe("IpFilterMiddleware (allowlist bypass attempts)", () => {
    const run = (f: IpFilterMiddleware, req: Partial<Request>) => {
        const next = vi.fn();
        const res = mkRes();
        f.handle({ path: "/api", ...req } as Request, res, next);
        return { next, res };
    };

    it("reads ENABLE_IP_FILTER / ALLOWED_IPS from the environment, trimming entries", () => {
        const prev = { e: process.env.ENABLE_IP_FILTER, a: process.env.ALLOWED_IPS };
        process.env.ENABLE_IP_FILTER = "true";
        process.env.ALLOWED_IPS = " 10.0.0.1 , 192.168.0.0/16 ";
        try {
            const f = new IpFilterMiddleware();
            expect(f._enabled).toBe(true);
            expect(f._allowedIps).toEqual(["10.0.0.1", "192.168.0.0/16"]);
        } finally {
            process.env.ENABLE_IP_FILTER = prev.e;
            if (prev.a === undefined) delete process.env.ALLOWED_IPS; else process.env.ALLOWED_IPS = prev.a;
        }
        expect(defaultIpFilter._enabled).toBe(false);
    });

    it("fails open only when disabled or when the allowlist is empty", () => {
        expect(run(new IpFilterMiddleware({ enabled: false, allowedIps: ["1.1.1.1"] }), { ip: "9.9.9.9" }).next).toHaveBeenCalledOnce();
        expect(run(new IpFilterMiddleware({ enabled: true, allowedIps: [] }), { ip: "9.9.9.9" }).next).toHaveBeenCalledOnce();
    });

    it("blocks unlisted IPs with a 403 body and no next()", () => {
        const { next, res } = run(new IpFilterMiddleware({ enabled: true, allowedIps: ["10.0.0.1"] }), { ip: "10.0.0.2" });
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(403);
        expect(res.body.error.type).toBe("ForbiddenError");
    });

    it("unwraps IPv4-mapped IPv6 so ::ffff:10.0.0.1 matches an IPv4 allowlist entry", () => {
        const f = new IpFilterMiddleware({ enabled: true, allowedIps: ["10.0.0.1", "172.16.0.0/12"] });
        expect(run(f, { ip: "::ffff:10.0.0.1" }).next).toHaveBeenCalledOnce();
        expect(run(f, { ip: "172.31.255.255" }).next).toHaveBeenCalledOnce();
        expect(run(f, { ip: "172.32.0.1" }).next).not.toHaveBeenCalled();
    });

    it("uses the socket address, then 'unknown', which is never allowed", () => {
        const f = new IpFilterMiddleware({ enabled: true, allowedIps: ["10.0.0.1"] });
        expect(run(f, { socket: { remoteAddress: "10.0.0.1" } as never }).next).toHaveBeenCalledOnce();
        expect(run(f, {}).next).not.toHaveBeenCalled();
        expect(IpFilterMiddleware.extractClientIp({})).toBe("unknown");
    });

    it("a CIDR entry without prefix length degrades to an exact-network compare", () => {
        expect(IpFilterMiddleware.ipInCidr("10.0.0.5", "10.0.0.5/")).toBe(true);
        expect(IpFilterMiddleware.ipInCidr("10.0.0.6", "10.0.0.5/")).toBe(false);
        expect(IpFilterMiddleware.ipInCidr("10.0.0.5", "10.0.0.5/32")).toBe(true);
        expect(IpFilterMiddleware.ipInCidr("10.0.0.6", "10.0.0.5/32")).toBe(false);
    });
});

describe("HelmetMiddleware", () => {
    const headersFor = (h: HelmetMiddleware) => {
        const res = mkRes();
        const next = vi.fn();
        const req = { headers: {}, method: "GET" } as Request;
        (res as any).removeHeader = (k: string) => { delete res.headers[k]; };
        (res as any).getHeader = (k: string) => res.headers[k];
        h.handle(req, res, next);
        expect(next).toHaveBeenCalled();
        return Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k.toLowerCase(), v]));
    };

    it("applies the hardened defaults", () => {
        const h = headersFor(new HelmetMiddleware());
        expect(h["x-frame-options"]).toBe("DENY");
        expect(h["x-content-type-options"]).toBe("nosniff");
        expect(String(h["strict-transport-security"])).toContain("max-age=31536000");
        expect(String(h["content-security-policy"])).toContain("object-src 'none'");
        expect(h["cross-origin-resource-policy"]).toBe("same-origin");
        expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
        expect(defaultHelmet).toBeInstanceOf(HelmetMiddleware);
    });

    it("lets a caller override individual policies without losing the rest", () => {
        const h = headersFor(new HelmetMiddleware({ frameguard: { action: "sameorigin" }, referrerPolicy: { policy: "no-referrer" } }));
        expect(h["x-frame-options"]).toBe("SAMEORIGIN");
        expect(h["referrer-policy"]).toBe("no-referrer");
        expect(h["x-content-type-options"]).toBe("nosniff");
    });
});
