import type { NextFunction, Request, Response } from "express";
import { CorsMiddleware, defaultCors } from "../../../src/middleware/security/CorsMiddleware";

function mkRes() {
    const h: Record<string, any> = {};
    const res: any = {
        statusCode: 200,
        locals: {} as Record<string, unknown>,
        headers: h,
        setHeader: (k: string, v: unknown) => { h[k.toLowerCase()] = v; },
        getHeader: (k: string) => h[k.toLowerCase()],
        removeHeader: (k: string) => { delete h[k.toLowerCase()]; },
        end: vi.fn(),
    };
    return res as Response & { headers: Record<string, any> };
}
function call(c: CorsMiddleware, origin: string | undefined, method = "GET") {
    const res = mkRes();
    const next = vi.fn();
    const req = { method, headers: origin ? { origin } : {} } as unknown as Request;
    c.handle(req, res, next as unknown as NextFunction);
    return { res, next };
}

describe("CorsMiddleware: origin policy", () => {
    const prev = { env: process.env.NODE_ENV, broad: process.env.CORS_ALLOW_BROAD_PATTERNS, origins: process.env.CORS_ORIGINS };
    afterEach(() => {
        process.env.NODE_ENV = prev.env;
        for (const [k, v] of [["CORS_ALLOW_BROAD_PATTERNS", prev.broad], ["CORS_ORIGINS", prev.origins]] as const) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
    });

    it("reads CORS_ORIGINS, trims and drops empties", () => {
        process.env.CORS_ORIGINS = " https://a.example , ,https://b.example ";
        const c = new CorsMiddleware({ patterns: [] });
        expect(c._explicitOrigins).toEqual(["https://a.example", "https://b.example"]);
        expect(call(c, "https://a.example").res.headers["access-control-allow-origin"]).toBe("https://a.example");
    });

    it("reflects an allowed origin with credentials and exposes the rate-limit headers", () => {
        const c = new CorsMiddleware({ origins: ["https://ok.example"], patterns: [] });
        const { res, next } = call(c, "https://ok.example");
        expect(next).toHaveBeenCalledWith();
        expect(res.headers["access-control-allow-credentials"]).toBe("true");
        expect(res.headers["access-control-expose-headers"]).toContain("Retry-After");
        expect(res.locals.corsEvaluated).toBe(true);
    });

    it("rejects unknown origins with an error and never echoes them", () => {
        const c = new CorsMiddleware({ origins: [], patterns: [/^https:\/\/ok\.dev$/] });
        for (const evil of ["https://evil.example", "https://ok.dev.evil.example", "https://evilok.dev", "null"]) {
            const { res, next } = call(c, evil);
            expect(next.mock.calls[0][0]).toBeInstanceOf(Error);
            expect(res.headers["access-control-allow-origin"]).toBeUndefined();
        }
    });

    it("allows origin-less (same-origin / curl) requests", () => {
        const c = new CorsMiddleware({ origins: [], patterns: [] });
        expect(call(c, undefined).next).toHaveBeenCalledWith();
    });

    it("answers preflight with methods, headers and max-age, and 200 status", () => {
        const c = new CorsMiddleware({ origins: ["https://ok.example"], patterns: [] });
        const { res } = call(c, "https://ok.example", "OPTIONS");
        expect(res.statusCode).toBe(200);
        expect(res.headers["access-control-allow-methods"]).toContain("PATCH");
        expect(res.headers["access-control-max-age"]).toBe("86400");
    });

    it("honours option overrides", () => {
        const c = new CorsMiddleware({
            origins: ["https://ok.example"],
            patterns: [],
            credentials: false,
            methods: ["GET"],
            allowedHeaders: ["X-A"],
            exposedHeaders: ["X-B"],
            maxAge: 5,
            optionsSuccessStatus: 204,
        });
        const { res } = call(c, "https://ok.example", "OPTIONS");
        expect(res.statusCode).toBe(204);
        expect(res.headers["access-control-allow-methods"]).toBe("GET");
        expect(res.headers["access-control-allow-headers"]).toBe("X-A");
        expect(res.headers["access-control-max-age"]).toBe("5");
        expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    });

    it("outside production private-network and internal-host origins are trusted", () => {
        process.env.NODE_ENV = "development";
        const c = new CorsMiddleware({ origins: [] });
        for (const o of ["http://localhost:5173", "http://127.0.0.1", "http://192.168.1.5:3000", "http://10.1.2.3", "http://172.20.0.1", "https://app.local", "http://x.lan:80", "https://a.corp.example", "https://a.vpn", "https://a.internal"]) {
            expect(call(c, o).next).toHaveBeenCalledWith();
        }
        expect(call(c, "http://172.32.0.1").next.mock.calls[0][0]).toBeInstanceOf(Error);
    });

    it("in production broad private patterns are OFF unless explicitly enabled", () => {
        process.env.NODE_ENV = "production";
        delete process.env.CORS_ALLOW_BROAD_PATTERNS;
        const strict = new CorsMiddleware({ origins: [] });
        expect(call(strict, "http://localhost:3000").next).toHaveBeenCalledWith();
        expect(call(strict, "http://192.168.1.5").next.mock.calls[0][0]).toBeInstanceOf(Error);
        process.env.CORS_ALLOW_BROAD_PATTERNS = "true";
        const broad = new CorsMiddleware({ origins: [] });
        expect(call(broad, "http://192.168.1.5").next).toHaveBeenCalledWith();
    });

    it("exports a default instance", () => {
        expect(defaultCors).toBeInstanceOf(CorsMiddleware);
    });
});

describe("CorsMiddleware.applyToErrorResponse", () => {
    const c = new CorsMiddleware({ origins: ["https://ok.example"], patterns: [] });
    const reqOf = (method: string, origin?: string) => ({ method, headers: origin ? { origin } : {} }) as unknown as Request;

    it("skips when CORS already ran, for OPTIONS, and for origin-less requests", () => {
        for (const [req, locals] of [
            [reqOf("GET", "https://ok.example"), { corsEvaluated: true }],
            [reqOf("OPTIONS", "https://ok.example"), {}],
            [reqOf("GET"), {}],
            [{ method: "GET" } as unknown as Request, {}],
        ] as const) {
            const res = mkRes();
            res.locals = { ...locals };
            const done = vi.fn();
            c.applyToErrorResponse(req, res, done);
            expect(done).toHaveBeenCalledOnce();
            expect(res.headers["access-control-allow-origin"]).toBeUndefined();
        }
    });

    it("adds CORS headers to an early error response so the browser can read it", () => {
        const res = mkRes();
        const done = vi.fn();
        c.applyToErrorResponse(reqOf("POST", "https://ok.example"), res, done);
        expect(done).toHaveBeenCalledOnce();
        expect(res.headers["access-control-allow-origin"]).toBe("https://ok.example");
        expect(res.locals.corsEvaluated).toBe(true);
    });

    it("does not add headers for a disallowed origin but still completes", () => {
        const res = mkRes();
        const done = vi.fn();
        c.applyToErrorResponse(reqOf("POST", "https://evil.example"), res, done);
        expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("handles a response without locals", () => {
        const res = mkRes();
        delete (res as { locals?: unknown }).locals;
        const done = vi.fn();
        expect(() => c.handle(reqOf("GET", "https://ok.example"), res, vi.fn() as unknown as NextFunction)).not.toThrow();
        c.applyToErrorResponse(reqOf("GET", "https://ok.example"), res, done);
        expect(done).toHaveBeenCalledOnce();
    });
});
