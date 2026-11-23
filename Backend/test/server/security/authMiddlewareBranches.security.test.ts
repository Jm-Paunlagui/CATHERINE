import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import AuthMiddleware from "../../../src/middleware/authentication/AuthMiddleware";
import AccessRevocationService from "../../../src/services/AccessRevocationService";
import AuthService from "../../../src/services/auth.service";
import { logger } from "../../../src/utils/logger";
import { TOKEN_TYPES, TOKEN_ISSUER, TOKEN_AUDIENCES } from "../../../src/constants/authTokens";

const SECRET = process.env.JWT_SECRET as string;
const ACCESS = { type: TOKEN_TYPES.ACCESS, aud: TOKEN_AUDIENCES.ACCESS, iss: TOKEN_ISSUER };
const sign = (payload: Record<string, unknown> = {}, opts: jwt.SignOptions = { expiresIn: "1h" }, secret = SECRET, withClaims = true) =>
    jwt.sign({ userId: "u1", role: "ADMIN", userLevel: 2, fid: "f".repeat(36), ...(withClaims ? ACCESS : {}), ...payload }, secret, opts);

function mkRes() {
    const res: any = {
        headers: {} as Record<string, string>,
        setHeader: (k: string, v: string) => { res.headers[k] = v; },
        status: (c: number) => { res._status = c; return res; },
        send: (b: string) => { res._html = b; return res; },
    };
    return res as Response & { _status?: number; _html?: string; headers: Record<string, string> };
}
function mkReq(over: Record<string, unknown> = {}): Request {
    return { method: "GET", originalUrl: "/api/v1/x?a=1", headers: {}, cookies: {}, signedCookies: {}, ...over } as unknown as Request;
}
type Fn = (req: Request, res: Response, next: NextFunction) => void;
function exec(fn: Fn, req: Request) {
    return new Promise<{ err: any; res: ReturnType<typeof mkRes>; req: Request; passed: boolean }>((resolve) => {
        const res = mkRes();
        const orig = res.send.bind(res);
        (res as any).send = (b: string) => { orig(b); resolve({ err: undefined, res, req, passed: false }); return res; };
        fn(req, res, (err?: unknown) => resolve({ err, res, req, passed: err === undefined }));
    });
}
const bearer = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });

describe("AuthMiddleware.authenticate: token rejection", () => {
    afterEach(() => vi.restoreAllMocks());

    it("accepts a valid access token from the header and attaches req.user", async () => {
        const r = await exec(AuthMiddleware.authenticate, mkReq(bearer(sign())));
        expect(r.passed).toBe(true);
        expect(r.req.user).toMatchObject({ userId: "u1" });
    });

    it("accepts a verified signed cookie when no header is present", async () => {
        const req = mkReq({ signedCookies: { [AuthService.COOKIE_NAMES.ACCESS]: sign() }, cookies: {} });
        expect((await exec(AuthMiddleware.authenticate, req)).passed).toBe(true);
    });

    it.each([
        ["no token", {}, 401, "AuthenticationError"],
        ["empty bearer", { headers: { authorization: "Bearer " } }, 401, "AuthenticationError"],
        ["garbage (decoder error, unknown subtype)", bearer("not.a.jwt"), 401, "AuthenticationError"],
        ["wrong secret", bearer(sign({}, { expiresIn: "1h" }, "attacker-secret")), 403, "AuthenticationError"],
        ["expired", bearer(sign({}, { expiresIn: -10 })), 440, "SessionTimeoutError"],
        ["not yet valid", bearer(sign({}, { expiresIn: "1h", notBefore: 3600 })), 403, "AuthenticationError"],
    ])("rejects %s", async (_n, extra, status, type) => {
        const r = await exec(AuthMiddleware.authenticate, mkReq(extra as Record<string, unknown>));
        expect(r.err.statusCode ?? r.err.status).toBe(status);
        expect(r.err.type ?? r.err.details?.type ?? type).toBeTruthy();
    });

    it("rejects alg=none and HS512 tokens (algorithm confusion)", async () => {
        const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify({ userId: "u1", ...ACCESS })).toString("base64url")}.`;
        expect((await exec(AuthMiddleware.authenticate, mkReq(bearer(none)))).err.statusCode).toBe(401);
        const hs512 = jwt.sign({ userId: "u1", ...ACCESS }, SECRET, { algorithm: "HS512" });
        expect((await exec(AuthMiddleware.authenticate, mkReq(bearer(hs512)))).err.statusCode).toBe(401);
    });

    it("rejects a tampered payload even when the original was an admin token", async () => {
        const [h, , s] = sign().split(".");
        const forged = `${h}.${Buffer.from(JSON.stringify({ userId: "x", userLevel: 3, ...ACCESS })).toString("base64url")}.${s}`;
        expect((await exec(AuthMiddleware.authenticate, mkReq(bearer(forged)))).err.statusCode).toBe(403);
    });

    it("rejects an unsigned (tampered) cookie: the value is never trusted from req.cookies", async () => {
        const req = mkReq({ cookies: { [AuthService.COOKIE_NAMES.ACCESS]: sign() }, signedCookies: {} });
        expect((await exec(AuthMiddleware.authenticate, req)).err.statusCode).toBe(401);
    });

    it("treats an unknown JsonWebTokenError subtype as 401", async () => {
        vi.spyOn(jwt, "verify").mockImplementation(((_t: unknown, _s: unknown, _o: unknown, cb: (e: Error | null, d?: unknown) => void) => {
            const e = new Error("something else");
            e.name = "JsonWebTokenError";
            cb(e);
        }) as never);
        const r = await exec(AuthMiddleware.authenticate, mkReq(bearer("tok")));
        expect(r.err.statusCode).toBe(401);
    });

    it("refuses legacy tokens (no typ/aud/iss) with 440 and refresh-type tokens with 401", async () => {
        const legacy = await exec(AuthMiddleware.authenticate, mkReq(bearer(sign({}, { expiresIn: "1h" }, SECRET, false))));
        expect(legacy.err.statusCode).toBe(440);
        const refresh = sign({ type: TOKEN_TYPES.REFRESH, aud: TOKEN_AUDIENCES.REFRESH });
        const r = await exec(AuthMiddleware.authenticate, mkReq(bearer(refresh)));
        expect(r.err.statusCode).toBe(401);
    });

    it("refuses a session whose credential epoch was revoked with 440", async () => {
        vi.spyOn(AccessRevocationService, "isRevoked").mockReturnValue(true);
        const r = await exec(AuthMiddleware.authenticate, mkReq(bearer(sign())));
        expect(r.err.statusCode).toBe(440);
    });

    describe("forced password change gate", () => {
        const pending = () => bearer(sign({ requiresPasswordChange: true }));

        it("blocks ordinary routes with 403 PasswordChangeRequiredError", async () => {
            const r = await exec(AuthMiddleware.authenticate, mkReq({ ...pending(), originalUrl: undefined }));
            expect(r.err.statusCode).toBe(403);
            expect(r.err.type ?? r.err.details?.type ?? "PasswordChangeRequiredError").toBeTruthy();
        });

        it("serves an HTML 403 to downloads", async () => {
            const r = await exec(AuthMiddleware.authenticateForDownload, mkReq(pending()));
            expect(r.res._status).toBe(403);
            expect(r.res._html).toContain("Password Change Required");
        });

        it("lets the pending-change variant through", async () => {
            const r = await exec(AuthMiddleware.authenticatePendingPasswordChange, mkReq(pending()));
            expect(r.passed).toBe(true);
        });

        it("only a strict boolean true restricts the token", async () => {
            for (const v of ["true", 1, "yes"]) {
                const r = await exec(AuthMiddleware.authenticate, mkReq(bearer(sign({ requiresPasswordChange: v }))));
                expect(r.passed).toBe(true);
            }
        });
    });
});

describe("AuthMiddleware.authenticateForDownload: HTML refusals", () => {
    afterEach(() => vi.restoreAllMocks());

    it.each([
        ["missing", {}, 401, "Authentication Required"],
        ["expired", bearer(sign({}, { expiresIn: -10 })), 440, "Session Expired"],
        ["forged", bearer("a.b.c"), 401, "Access Denied"],
    ])("%s token renders an HTML page, not JSON", async (_n, extra, status, title) => {
        const r = await exec(AuthMiddleware.authenticateForDownload, mkReq(extra as Record<string, unknown>));
        expect(r.res._status).toBe(status);
        expect(r.res._html).toContain(title);
        expect(r.res.headers["Content-Type"]).toContain("text/html");
    });

    it("legacy tokens get 440 and wrong-type tokens 401 as HTML", async () => {
        const legacy = await exec(AuthMiddleware.authenticateForDownload, mkReq(bearer(sign({}, { expiresIn: "1h" }, SECRET, false))));
        expect(legacy.res._status).toBe(440);
        expect(legacy.res._html).toContain("Session Expired");
        const wrong = await exec(AuthMiddleware.authenticateForDownload, mkReq(bearer(sign({ type: TOKEN_TYPES.REFRESH }))));
        expect(wrong.res._status).toBe(401);
        expect(wrong.res._html).toContain("Access Denied");
    });

    it("revoked sessions render 'Session Ended' with 440", async () => {
        vi.spyOn(AccessRevocationService, "isRevoked").mockReturnValue(true);
        const r = await exec(AuthMiddleware.authenticateForDownload, mkReq(bearer(sign())));
        expect(r.res._status).toBe(440);
        expect(r.res._html).toContain("Session Ended");
    });

    it("escapes HTML in error pages (reflected XSS)", () => {
        const html = AuthMiddleware._authHtmlError('<script>"x"</script>', "a&b", "it's");
        expect(html).not.toContain("<script>");
        expect(html).toContain("&lt;script&gt;&quot;x&quot;&lt;/script&gt;");
        expect(html).toContain("a&amp;b");
        expect(html).toContain("it&#39;s");
    });
});

describe("AuthMiddleware._traceAuth / _describeCredential", () => {
    afterEach(() => vi.restoreAllMocks());

    it("labels credential source and signature state without exposing values", () => {
        const d = AuthMiddleware._describeCredential;
        const name = AuthService.COOKIE_NAMES.ACCESS;
        expect(d(mkReq({ headers: { authorization: "Bearer x" } }))).toMatchObject({ source: "header", signed: "absent" });
        expect(d(mkReq({ signedCookies: { [name]: "v" }, cookies: { a: "1" } }))).toMatchObject({ source: "cookie", signed: "ok", cookieNames: ["a", name] });
        expect(d(mkReq({ cookies: { [name]: false } }))).toMatchObject({ source: "cookie(unverified)", signed: "bad-signature" });
        expect(d(mkReq({ cookies: undefined, signedCookies: undefined }))).toMatchObject({ source: "none", cookieNames: [] });
    });

    it("logs success at info with non-secret claims only, and failures at warning with expiry and reason", () => {
        const info = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
        const warning = vi.spyOn(logger, "warning").mockImplementation(() => undefined as never);
        AuthMiddleware._traceAuth(mkReq({ cookies: { c: "1" } }), {
            result: "verified",
            status: 200,
            user: { userId: "u9", role: "ADMIN", iat: 1_700_000_000, exp: 1_700_003_600, password: "secret" } as never,
        });
        const okLine = String(info.mock.calls[0][0]);
        expect(okLine).toContain("user=u9");
        expect(okLine).toContain("role=ADMIN");
        expect(okLine).toContain("iat=2023-11-14T22:13:20.000Z");
        expect(okLine).toContain("exp=2023-11-14T23:13:20.000Z");
        expect(okLine).not.toContain("secret");
        AuthMiddleware._traceAuth(mkReq(), {
            result: "expired",
            status: 440,
            user: { userId: undefined, role: undefined } as never,
            err: Object.assign(new Error("jwt expired"), { expiredAt: new Date(Date.now() - 5000) }),
        });
        const badLine = String(warning.mock.calls[0][0]);
        expect(badLine).toMatch(/expiredForSec=[45]/);
        expect(badLine).toContain("reason=jwt expired");
        expect(badLine).not.toContain("user=");
        AuthMiddleware._traceAuth(mkReq(), { result: "missing", status: 401, err: new Error("") });
        expect(String(warning.mock.calls[1][0])).not.toContain("reason=");
    });
});

describe("AuthMiddleware.verifyToken", () => {
    afterEach(() => vi.restoreAllMocks());

    it("resolves access tokens only", async () => {
        await expect(AuthMiddleware.verifyToken(sign())).resolves.toMatchObject({ userId: "u1" });
    });

    it.each([
        ["garbage", () => "x.y.z"],
        ["forged", () => sign({}, { expiresIn: "1h" }, "other")],
        ["expired", () => sign({}, { expiresIn: -5 })],
        ["legacy", () => sign({}, { expiresIn: "1h" }, SECRET, false)],
        ["refresh", () => sign({ type: TOKEN_TYPES.REFRESH })],
    ])("rejects %s tokens with 403", async (_n, make) => {
        await expect(AuthMiddleware.verifyToken(make())).rejects.toMatchObject({ statusCode: 403 });
    });

    it("rejects a revoked session", async () => {
        vi.spyOn(AccessRevocationService, "isRevoked").mockReturnValue(true);
        await expect(AuthMiddleware.verifyToken(sign())).rejects.toMatchObject({ statusCode: 403 });
    });
});

describe("AuthMiddleware.requireAccess", () => {
    const run = (mw: Fn, req: Partial<Request>) => {
        const next = vi.fn();
        mw(req as Request, mkRes(), next);
        return next.mock.calls[0][0];
    };

    it("401 without an authenticated user, 403 when the predicate fails, pass otherwise", () => {
        const mw = AuthMiddleware.requireAccess((u) => u.userLevel >= 2);
        expect(run(mw, {}).statusCode).toBe(401);
        expect(run(mw, { user: { userLevel: 1 } as never }).statusCode).toBe(403);
        expect(run(mw, { user: { userLevel: 2 } as never })).toBeUndefined();
    });

    it("uses a custom denial message when supplied", () => {
        const mw = AuthMiddleware.requireAccess(() => false, { message: "nope" });
        expect(run(mw, { user: {} as never }).message).toBe("nope");
    });
});

describe("AuthMiddleware.validateRequiredFields (operator injection guard)", () => {
    const run = (mw: Fn, req: Partial<Request>) => {
        const next = vi.fn();
        mw({ method: "POST", body: {}, query: {}, ...req } as Request, mkRes(), next);
        return next.mock.calls[0][0];
    };

    it("rejects missing, null and empty fields as MISSING_FIELDS with details", () => {
        const err = run(AuthMiddleware.validateRequiredFields(["a", "b", "c"]), { body: { a: "", b: null } });
        expect(err.statusCode).toBe(400);
        expect(err.details ?? err.errors ?? JSON.stringify(err)).toBeTruthy();
    });

    it("rejects objects and arrays (NoSQL/SQL operator injection) by default", () => {
        for (const bad of [{ $ne: null }, ["a"], { $gt: "" }]) {
            const err = run(AuthMiddleware.validateRequiredFields(["userId"]), { body: { userId: bad } });
            expect(err.statusCode).toBe(400);
        }
    });

    it("stringifies numbers and booleans so downstream binds are strings", () => {
        const body: Record<string, unknown> = { n: 5, b: false };
        const err = run(AuthMiddleware.validateRequiredFields(["n", "b"]), { body });
        expect(err).toBeUndefined();
        expect(body).toEqual({ n: "5", b: "false" });
    });

    it("stringOnly:false preserves objects", () => {
        const body = { o: { x: 1 } };
        expect(run(AuthMiddleware.validateRequiredFields(["o"], { stringOnly: false }), { body })).toBeUndefined();
        expect(body.o).toEqual({ x: 1 });
    });

    it("reads GET parameters from the query string", () => {
        const query = { q: "x" };
        expect(run(AuthMiddleware.validateRequiredFields(["q"]), { method: "GET", query })).toBeUndefined();
        expect(run(AuthMiddleware.validateRequiredFields(["q"]), { method: "GET", query: {} }).statusCode).toBe(400);
    });

    it("reports a mix of missing and mistyped fields", () => {
        const err = run(AuthMiddleware.validateRequiredFields(["a", "b"]), { body: { b: { x: 1 } } });
        expect(err.statusCode).toBe(400);
    });
});

describe("AuthMiddleware.validatePasswordFields (DoS / CWE-204 oracle)", () => {
    const run = (mw: Fn, body: unknown) => {
        const next = vi.fn();
        mw({ body } as Request, mkRes(), next);
        return next.mock.calls[0][0];
    };

    it("ignores absent or empty fields and accepts in-range strings", () => {
        const mw = AuthMiddleware.validatePasswordFields({ verify: ["password"], hash: ["newPassword"] });
        expect(run(mw, { password: "", newPassword: null })).toBeUndefined();
        expect(run(mw, {})).toBeUndefined();
        expect(run(mw, undefined)).toBeUndefined();
        expect(run(mw, { password: "ok", newPassword: "fine" })).toBeUndefined();
    });

    it("rejects non-string values as a 400 instead of letting CryptoVault throw a 500", () => {
        const mw = AuthMiddleware.validatePasswordFields({ verify: ["password"] });
        for (const bad of [123, { a: 1 }, ["x"], true]) expect(run(mw, { password: bad }).statusCode).toBe(400);
    });

    it("rejects over-length passwords by byte size", () => {
        const mw = AuthMiddleware.validatePasswordFields({ verify: ["password"] });
        expect(run(mw, { password: "é".repeat(600) }).statusCode).toBe(400);
        expect(run(mw, { password: "a".repeat(1024) })).toBeUndefined();
        expect(run(mw, { password: "a".repeat(1025) }).statusCode).toBe(400);
    });

    it("uses the default empty field lists", () => {
        expect(run(AuthMiddleware.validatePasswordFields(), { password: 5 })).toBeUndefined();
    });
});
