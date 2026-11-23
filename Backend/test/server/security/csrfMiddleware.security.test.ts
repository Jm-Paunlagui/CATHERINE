import type { NextFunction, Request, Response } from "express";
import { CsrfMiddleware, defaultCsrf } from "../../../src/middleware/security/CsrfMiddleware";

const SECRET = "csrf-secret-for-security-tests-0123456789";

function mkRes() {
    const cookies: Record<string, { v: string; o: any }> = {};
    const res: any = {
        headers: {} as Record<string, any>,
        cookies,
        statusCode: 200,
        setHeader: (k: string, v: any) => { res.headers[k.toLowerCase()] = v; return res; },
        getHeader: (k: string) => res.headers[k.toLowerCase()],
        cookie: (n: string, v: string, o: any) => { cookies[n] = { v, o }; return res; },
        status: (c: number) => { res.statusCode = c; return res; },
        json: (b: unknown) => { res.body = b; return res; },
    };
    return res as Response & { body?: any; cookies: typeof cookies };
}
function mkReq(over: Record<string, unknown> = {}): Request {
    return {
        ip: "9.9.9.9",
        method: "POST",
        originalUrl: "/api/v1/x",
        headers: {},
        cookies: {},
        body: {},
        get: () => "ua",
        ...over,
    } as unknown as Request;
}

/** Issues a token and returns the pair a legitimate browser would send back. */
function issue(csrf: CsrfMiddleware, ip = "9.9.9.9") {
    const res = mkRes();
    const req = mkReq({ ip, method: "GET" });
    csrf.tokenHandler(req, res);
    const cookie = res.cookies[csrf._cookieName];
    return { token: res.body.token as string, cookieValue: cookie.v, res };
}
function protect(csrf: CsrfMiddleware, req: Request) {
    const res = mkRes();
    const next = vi.fn();
    csrf.handle(req, res, next as unknown as NextFunction);
    return { res, next };
}

describe("CsrfMiddleware: construction", () => {
    const origNodeEnv = process.env.NODE_ENV;
    afterEach(() => { process.env.NODE_ENV = origNodeEnv; });

    it("uses plain cookie in dev and __Host- prefix when secure", () => {
        expect(new CsrfMiddleware({ secret: SECRET, forceSecure: false })._cookieName).toBe("psifi.x-csrf-token");
        expect(new CsrfMiddleware({ secret: SECRET, forceSecure: true })._cookieName).toBe("__Host-psifi.x-csrf-token");
    });

    it("derives secure from production + USE_HTTPS", () => {
        const prev = process.env.USE_HTTPS;
        process.env.NODE_ENV = "production";
        process.env.USE_HTTPS = "true";
        try {
            expect(new CsrfMiddleware({ secret: SECRET })._isSecure).toBe(true);
            process.env.USE_HTTPS = "false";
            expect(new CsrfMiddleware({ secret: SECRET })._isSecure).toBe(false);
        } finally {
            if (prev === undefined) delete process.env.USE_HTTPS; else process.env.USE_HTTPS = prev;
        }
    });

    it("exposes the generator and protection primitives and a default instance", () => {
        const c = new CsrfMiddleware({ secret: SECRET });
        expect(c.generateToken).toBeTypeOf("function");
        expect(c.doubleCsrfProtection).toBeTypeOf("function");
        expect(defaultCsrf).toBeInstanceOf(CsrfMiddleware);
    });
});

describe("CsrfMiddleware: token issuance", () => {
    it("issues a 64-byte token with a strict httpOnly cookie", () => {
        const c = new CsrfMiddleware({ secret: SECRET, forceSecure: true });
        const { token, res } = issue(c);
        expect(res.body).toMatchObject({ success: true, headerName: "x-csrf-token", cookieName: "__Host-psifi.x-csrf-token", expiresIn: 300000 });
        expect(token.length).toBeGreaterThan(64);
        const opts = res.cookies["__Host-psifi.x-csrf-token"].o;
        expect(opts).toMatchObject({ httpOnly: true, secure: true, sameSite: "strict", path: "/" });
        expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    it("responds 500 without leaking details when generation fails (non-development)", () => {
        const c = new CsrfMiddleware({ secret: SECRET });
        c._generateCsrfToken = (() => { throw new Error("rng offline"); }) as never;
        const res = mkRes();
        c.tokenHandler(mkReq({ method: "GET" }), res);
        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ success: false, message: "Failed to generate CSRF token", error: undefined });
    });

    it("treats an empty generated token as a failure", () => {
        const c = new CsrfMiddleware({ secret: SECRET });
        c._generateCsrfToken = (() => "") as never;
        const res = mkRes();
        c.tokenHandler(mkReq({ method: "GET" }), res);
        expect(res.statusCode).toBe(500);
    });

    it("exposes error text only in development", () => {
        const c = new CsrfMiddleware({ secret: SECRET });
        const prev = process.env.NODE_ENV;
        process.env.NODE_ENV = "development";
        try {
            const r1 = mkRes();
            c._sendError(r1, 500, "m", new Error("detail"));
            expect(r1.body.error).toBe("detail");
            const r2 = mkRes();
            c._sendError(r2, 500, "m", "plain string");
            expect(r2.body.error).toBe("plain string");
        } finally {
            process.env.NODE_ENV = prev;
        }
    });
});

describe("CsrfMiddleware: attack scenarios on protected methods", () => {
    let c: CsrfMiddleware;
    beforeEach(() => { c = new CsrfMiddleware({ secret: SECRET }); });

    it("accepts a matching header token + cookie", () => {
        const { token, cookieValue } = issue(c);
        const { next } = protect(c, mkReq({ headers: { "x-csrf-token": token }, cookies: { [c._cookieName]: cookieValue } }));
        expect(next).toHaveBeenCalledOnce();
    });

    it("accepts the token from body._csrf and body.csrfToken", () => {
        const { token, cookieValue } = issue(c);
        for (const body of [{ _csrf: token }, { csrfToken: token }]) {
            const { next } = protect(c, mkReq({ body, cookies: { [c._cookieName]: cookieValue } }));
            expect(next).toHaveBeenCalledOnce();
        }
    });

    it("rejects a missing token (403) with the generic message in production-like env", () => {
        const { cookieValue } = issue(c);
        const { res, next } = protect(c, mkReq({ cookies: { [c._cookieName]: cookieValue } }));
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(403);
        expect(res.body).toMatchObject({ code: "CSRF_TOKEN_INVALID", error: "Invalid or missing CSRF token", requestId: null });
    });

    it("rejects a token without the cookie (cross-site form post)", () => {
        const { token } = issue(c);
        const { res } = protect(c, mkReq({ headers: { "x-csrf-token": token } }));
        expect(res.statusCode).toBe(403);
    });

    it("rejects a forged token and a token paired with another client's cookie", () => {
        const a = issue(c, "1.1.1.1");
        const b = issue(c, "2.2.2.2");
        expect(protect(c, mkReq({ headers: { "x-csrf-token": "forged" }, cookies: { [c._cookieName]: a.cookieValue } })).res.statusCode).toBe(403);
        expect(protect(c, mkReq({ ip: "1.1.1.1", headers: { "x-csrf-token": b.token }, cookies: { [c._cookieName]: a.cookieValue } })).res.statusCode).toBe(403);
    });

    it("binds the token to the client session (replay from a different IP fails)", () => {
        const a = issue(c, "1.1.1.1");
        const { res } = protect(c, mkReq({ ip: "6.6.6.6", headers: { "x-csrf-token": a.token }, cookies: { [c._cookieName]: a.cookieValue } }));
        expect(res.statusCode).toBe(403);
    });

    it("rejects tokens minted under a different server secret", () => {
        const other = new CsrfMiddleware({ secret: "another-secret-another-secret-0123456789" });
        const { token, cookieValue } = issue(other);
        const { res } = protect(c, mkReq({ headers: { "x-csrf-token": token }, cookies: { [c._cookieName]: cookieValue } }));
        expect(res.statusCode).toBe(403);
    });

    it("never challenges safe methods", () => {
        for (const method of ["GET", "HEAD", "OPTIONS"]) {
            expect(protect(c, mkReq({ method })).next).toHaveBeenCalledOnce();
        }
    });

    it("surfaces the validation error text in development", () => {
        const prev = process.env.NODE_ENV;
        process.env.NODE_ENV = "development";
        try {
            const { res } = protect(c, mkReq({ body: undefined }));
            expect(res.statusCode).toBe(403);
            expect(res.body.error).not.toBe("Invalid or missing CSRF token");
        } finally {
            process.env.NODE_ENV = prev;
        }
    });

    it("uses the socket address then 'anonymous' as the session identifier", () => {
        const a = issue(c, undefined as unknown as string);
        expect(a.token).toBeTruthy();
        const req = mkReq({ ip: undefined, connection: { remoteAddress: "5.5.5.5" }, headers: { "x-csrf-token": a.token }, cookies: { [c._cookieName]: a.cookieValue } });
        // different identifier (socket vs anonymous) -> token no longer binds
        expect(protect(c, req).res.statusCode).toBe(403);
    });
});

describe("CsrfMiddleware: refresh and status endpoints", () => {
    let c: CsrfMiddleware;
    beforeEach(() => { c = new CsrfMiddleware({ secret: SECRET }); });

    it("refuses to refresh without an existing session cookie (400 NO_CSRF_SESSION)", () => {
        const res = mkRes();
        c.refreshHandler(mkReq({ method: "POST", id: "req_1", user: { userId: "u1" } }), res);
        expect(res.statusCode).toBe(400);
        expect(res.body).toMatchObject({ code: "NO_CSRF_SESSION", requestId: "req_1" });
        const res2 = mkRes();
        c.refreshHandler(mkReq({ cookies: undefined }), res2);
        expect(res2.body.requestId).toBeNull();
    });

    it("rotates the token when a session exists and identifies the user by sub as fallback", () => {
        const { cookieValue } = issue(c);
        const res = mkRes();
        c.refreshHandler(mkReq({ cookies: { [c._cookieName]: cookieValue }, user: { sub: "s1" } }), res);
        expect(res.body).toMatchObject({ success: true, message: "CSRF token refreshed successfully" });
        expect(res.cookies[c._cookieName].v).not.toBe(cookieValue);
    });

    it("answers 500 on refresh failure without leaking internals", () => {
        const { cookieValue } = issue(c);
        c._generateCsrfToken = (() => { throw new Error("boom"); }) as never;
        const res = mkRes();
        c.refreshHandler(mkReq({ cookies: { [c._cookieName]: cookieValue } }), res);
        expect(res.statusCode).toBe(500);
        expect(res.body.error).toBeUndefined();
        c._generateCsrfToken = (() => "") as never;
        const res2 = mkRes();
        c.refreshHandler(mkReq({ cookies: { [c._cookieName]: cookieValue } }), res2);
        expect(res2.statusCode).toBe(500);
    });

    it("status reports whether the secret cookie is present, without revealing it", () => {
        const present = mkRes();
        c.statusHandler(mkReq({ method: "GET", cookies: { [c._cookieName]: "x" } }), present);
        expect(present.body.status).toMatchObject({ enabled: true, hasSecret: true });
        expect(JSON.stringify(present.body)).not.toContain(SECRET);
        const absent = mkRes();
        c.statusHandler(mkReq({ method: "GET", cookies: undefined }), absent);
        expect(absent.body.status.hasSecret).toBe(false);
        expect(absent.body.message).toMatch(/no secret cookie/);
    });

    it("status failure is a 500", () => {
        const res = mkRes();
        (res as any).json = () => { throw new Error("serialize"); };
        const sent = mkRes();
        // first json call throws, the error path uses a working responder
        let calls = 0;
        (res as any).json = (b: unknown) => { if (calls++ === 0) throw new Error("serialize"); sent.body = b; return res; };
        c.statusHandler(mkReq({ method: "GET" }), res);
        expect(res.statusCode).toBe(500);
        expect(sent.body.message).toBe("Failed to retrieve CSRF status");
    });
});
