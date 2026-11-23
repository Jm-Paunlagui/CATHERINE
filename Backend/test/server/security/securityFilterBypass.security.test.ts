import type { NextFunction, Request, Response } from "express";
import { SecurityFilterMiddleware, defaultSecurityFilter } from "../../../src/middleware/security/SecurityFilterMiddleware";
import { clusterRpc } from "../../../src/utils/cluster/ClusterRpcClient";
import { CLUSTER_RPC_METHODS as M } from "../../../src/constants/clusterIpc";

function mkRes() {
    const res: any = {
        headers: {} as Record<string, unknown>,
        setHeader: (k: string, v: unknown) => { res.headers[k] = v; },
        status: (c: number) => { res._status = c; return res; },
        json: (b: unknown) => { res._body = b; return res; },
    };
    return res as Response & { _status?: number; _body?: any; headers: Record<string, unknown> };
}
function run(f: SecurityFilterMiddleware, req: Partial<Request>) {
    const next = vi.fn() as unknown as NextFunction & ReturnType<typeof vi.fn>;
    const res = mkRes();
    f.handle({ ip: "7.7.7.7", method: "GET", path: "/api/v1/x", originalUrl: "/api/v1/x", headers: {}, ...req } as Request, res, next);
    return { next, res };
}
const urlReq = (u: string): Partial<Request> => ({ originalUrl: u, path: u.split("?")[0] });

describe("SecurityFilter: scanner and injection patterns", () => {
    let f: SecurityFilterMiddleware;
    beforeEach(() => { f = new SecurityFilterMiddleware({ suspiciousThreshold: 1000 }); });
    afterEach(() => f._tracker.dispose());

    it.each([
        "/.env", "/.env.production", "/app/.git/config", "/wp-login.php", "/WP-ADMIN/", "/x.ASPX", "/a/b.jsp",
        "/weblogic/login", "/_layouts/15/start.aspx", "/robots.txt", "/Apriso/x", "/cli/ws",
    ])("hides scanner path %s behind a 404", (p) => {
        const { next, res } = run(f, urlReq(p));
        expect(next).not.toHaveBeenCalled();
        expect(res._status).toBe(404);
        expect(res._body.error.type).toBe("NotFound");
    });

    it.each([
        ["traversal", "/api/v1/files?f=../../etc/passwd"],
        ["double-encoded traversal", "/api/v1/files?f=%252e%252e%252fetc"],
        ["encoded traversal", "/api/v1/files?f=..%2f..%2fetc"],
        ["backslash traversal", "/api/v1/files?f=..%5c..%5cwin"],
        ["xss script", "/api/v1/s?q=<script>alert(1)</script>"],
        ["xss encoded", "/api/v1/s?q=%3Cscript%3Ealert(1)"],
        ["javascript uri", "/api/v1/s?q=javascript:alert(1)"],
        ["event handler", "/api/v1/s?q=x%20onerror=alert(1)"],
        ["sqli or", "/api/v1/s?q=' OR 1=1"],
        ["sqli union", "/api/v1/s?q=1 UNION ALL SELECT password FROM admins"],
        ["sqli stacked", "/api/v1/s?q=1; DROP TABLE users"],
        ["comment sqli", "/api/v1/s?q=a'--"],
        ["xp_cmdshell", "/api/v1/s?q=xp_cmdshell"],
        ["cmd pipe", "/api/v1/s?q=a|cat%20/etc/passwd"],
        ["cmd subst", "/api/v1/s?q=$(whoami)"],
        ["backtick", "/api/v1/s?q=`id`"],
        ["ldap", "/api/v1/s?q=*)(uid=*"],
    ])("rejects %s with 403", (_n, u) => {
        const { next, res } = run(f, urlReq(u));
        expect(next).not.toHaveBeenCalled();
        expect(res._status).toBe(403);
    });

    it("falls back to single decoding then raw URL when percent-decoding fails (malformed escapes)", () => {
        // %E0%A4%A is invalid UTF-8 / truncated: both decode passes throw -> raw URL is scanned
        const bad = run(f, urlReq("/api/v1/s?q=%E0%A4%A"));
        expect(bad.next).toHaveBeenCalledOnce();
        // first decode succeeds, second throws on a double-encoded invalid sequence
        const second = run(f, urlReq("/api/v1/s?q=%25E0%25A4%25A"));
        expect(second.next).toHaveBeenCalledOnce();
        // malformed escapes must not hide an attack that is visible in the raw string
        const hidden = run(f, urlReq("/api/v1/s?q=%E0%A4%A&x=<script>"));
        expect(hidden.res._status).toBe(403);
    });

    it("uses req.path when originalUrl is absent and the connection address when ip is absent", () => {
        const { next } = run(f, { originalUrl: undefined, path: "/api/v1/ok", ip: undefined, connection: { remoteAddress: "8.8.8.8" } as never });
        expect(next).toHaveBeenCalledOnce();
        const { next: n2 } = run(f, { ip: undefined, connection: undefined });
        expect(n2).toHaveBeenCalledOnce();
    });

    it("lets clean traffic through untouched", () => {
        for (const u of ["/api/v1/users?page=2", "/api/v1/auth/me", "/api/v1/search?q=O'Brien"]) {
            expect(run(f, urlReq(u)).next).toHaveBeenCalledOnce();
        }
    });

    it("honours custom pattern lists (constructor overrides)", () => {
        const c = new SecurityFilterMiddleware({ maliciousPatterns: [/secret/], injectionPatterns: [/badword/] });
        expect(run(c, urlReq("/secret")).res._status).toBe(404);
        expect(run(c, urlReq("/ok?x=badword")).res._status).toBe(403);
        expect(run(c, urlReq("/.env")).next).toHaveBeenCalledOnce();
        c._tracker.dispose();
    });
});

describe("SecurityFilter: methods and bodyless guard", () => {
    let f: SecurityFilterMiddleware;
    beforeEach(() => { f = new SecurityFilterMiddleware({ suspiciousThreshold: 1000 }); });
    afterEach(() => f._tracker.dispose());

    it("blocks TRACE/TRACK/PROPFIND/SEARCH with 405 except on whitelisted paths", () => {
        for (const method of ["TRACE", "TRACK", "PROPFIND", "SEARCH"]) {
            expect(run(f, { method, path: "/api/v1/x" }).res._status).toBe(405);
        }
        expect(run(f, { method: "TRACE", path: "/health" }).next).toHaveBeenCalledOnce();
        expect(run(f, { method: "TRACE", path: "/" }).next).toHaveBeenCalledOnce();
        expect(run(f, { method: "TRACE", path: "/api-docs/ui" }).next).toHaveBeenCalledOnce();
    });

    it("refuses GET/HEAD that declare a body (smuggling guard) with Connection: close and no strike", () => {
        const cases: Array<Record<string, string>> = [
            { "content-length": "5" },
            { "content-length": " 12 " },
            { "transfer-encoding": "chunked" },
        ];
        for (const headers of cases) {
            const { res, next } = run(f, { method: "HEAD", headers });
            expect(next).not.toHaveBeenCalled();
            expect(res._status).toBe(400);
            expect(res._body.error.type).toBe("BodyNotAllowedError");
            expect(res.headers.Connection).toBe("close");
        }
        expect(f._tracker.records.size).toBe(0);
    });

    it("accepts a declared zero length, junk lengths, non-string lengths, and POST bodies", () => {
        expect(run(f, { headers: { "content-length": "0" } }).next).toHaveBeenCalledOnce();
        expect(run(f, { headers: { "content-length": "abc" } }).next).toHaveBeenCalledOnce();
        expect(run(f, { headers: { "content-length": ["5"] as never } }).next).toHaveBeenCalledOnce();
        expect(run(f, { method: "POST", headers: { "content-length": "50" } }).next).toHaveBeenCalledOnce();
        expect(run(f, { headers: undefined }).next).toHaveBeenCalledOnce();
    });

    it("the guard can be disabled explicitly and via SECURITY_FILTER_REJECT_GET_BODY=false", () => {
        const off = new SecurityFilterMiddleware({ rejectBodyOnBodylessMethods: false });
        expect(run(off, { headers: { "content-length": "9" } }).next).toHaveBeenCalledOnce();
        off._tracker.dispose();
        const prev = process.env.SECURITY_FILTER_REJECT_GET_BODY;
        process.env.SECURITY_FILTER_REJECT_GET_BODY = "false";
        const envOff = new SecurityFilterMiddleware();
        process.env.SECURITY_FILTER_REJECT_GET_BODY = prev;
        if (prev === undefined) delete process.env.SECURITY_FILTER_REJECT_GET_BODY;
        expect(envOff._rejectBodyOnBodylessMethods).toBe(false);
        envOff._tracker.dispose();
    });

    it("tolerates a response whose setHeader throws (headers already sent)", () => {
        const next = vi.fn();
        const res = mkRes();
        (res as any).setHeader = () => { throw new Error("ERR_HTTP_HEADERS_SENT"); };
        f.handle({ ip: "7.7.7.7", method: "GET", path: "/x", originalUrl: "/x", headers: { "content-length": "3" } } as unknown as Request, res, next);
        expect(res._status).toBe(400);
    });

    it("assigns a request id when none exists and keeps an existing one", () => {
        const a = mkRes();
        const req1 = { ip: "7.7.7.7", method: "GET", path: "/.env", originalUrl: "/.env", headers: {} } as unknown as Request;
        f.handle(req1, a, vi.fn());
        expect(req1.id).toBeTruthy();
        expect(a._body.requestId).toBe(req1.id);
        const b = mkRes();
        const req2 = { ...req1, id: "fixed" } as unknown as Request;
        f.handle(req2, b, vi.fn());
        expect(b._body.requestId).toBe("fixed");
        const c = mkRes();
        (c as any).setHeader = () => { throw new Error("sent"); };
        f.handle({ ...req1, id: "x" } as unknown as Request, c, vi.fn());
        expect(c._status).toBe(404);
    });
});

describe("SecurityFilter: strike/block lifecycle (single process)", () => {
    afterEach(() => vi.restoreAllMocks());

    it("blocks an IP after the strike threshold and then refuses even clean requests", () => {
        const f = new SecurityFilterMiddleware({ suspiciousThreshold: 3, blockDurationMs: 60_000 });
        for (let i = 0; i < 3; i++) run(f, urlReq("/.env"));
        const { res, next } = run(f, urlReq("/api/v1/health-ok"));
        expect(next).not.toHaveBeenCalled();
        expect(res._status).toBe(403);
        expect(res._body.error.type).toBe("ForbiddenError");
        expect((f.getStats() as { blocked: number }).blocked).toBe(1);
        expect(f.unblock("7.7.7.7", "admin")).toBe(true);
        expect(f.unblock("7.7.7.7")).toBe(false);
        expect(run(f, urlReq("/api/v1/ok")).next).toHaveBeenCalledOnce();
        f._tracker.dispose();
    });

    it("strikes are per IP: one attacker does not block another client", () => {
        const f = new SecurityFilterMiddleware({ suspiciousThreshold: 2 });
        run(f, { ...urlReq("/.env"), ip: "1.1.1.1" });
        run(f, { ...urlReq("/.env"), ip: "1.1.1.1" });
        expect(run(f, { ...urlReq("/ok"), ip: "2.2.2.2" }).next).toHaveBeenCalledOnce();
        expect(run(f, { ...urlReq("/ok"), ip: "1.1.1.1" }).next).not.toHaveBeenCalled();
        f._tracker.dispose();
    });

    it("applies primary-decided blocks, unblocks and full syncs to the local mirror", () => {
        const f = new SecurityFilterMiddleware();
        f.applyRemoteBlock("3.3.3.3", Date.now() + 60_000);
        expect(run(f, { ip: "3.3.3.3" }).res._status).toBe(403);
        f.applyRemoteUnblock("3.3.3.3");
        expect(run(f, { ip: "3.3.3.3" }).next).toHaveBeenCalledOnce();
        f.applySync([{ ip: "4.4.4.4", blockedUntil: Date.now() + 60_000 }]);
        expect(run(f, { ip: "4.4.4.4" }).res._status).toBe(403);
        f.applySync(undefined as never);
        f._tracker.dispose();
    });

    it("exports a default instance", () => {
        expect(defaultSecurityFilter).toBeInstanceOf(SecurityFilterMiddleware);
    });
});

describe("SecurityFilter: cluster mode", () => {
    afterEach(() => vi.restoreAllMocks());

    it("reports strikes to the primary and relies on the mirrored block state", () => {
        vi.spyOn(clusterRpc, "active", "get").mockReturnValue(true);
        const notify = vi.spyOn(clusterRpc, "notify").mockReturnValue(true);
        const f = new SecurityFilterMiddleware();
        expect(run(f, urlReq("/.env")).res._status).toBe(404);
        expect(notify).toHaveBeenCalledWith(M.SF_STRIKE, { ip: "7.7.7.7" });
        expect(f._tracker.records.size).toBe(0); // local strike not counted: the primary owns it
        f._tracker.dispose();
    });

    it("falls back to local counting when the strike notice cannot be sent or the IP is not an IP", () => {
        vi.spyOn(clusterRpc, "active", "get").mockReturnValue(true);
        const notify = vi.spyOn(clusterRpc, "notify").mockReturnValue(false);
        const f = new SecurityFilterMiddleware();
        run(f, urlReq("/.env"));
        expect(f._tracker.records.size).toBe(1);
        run(f, { ...urlReq("/.env"), ip: "not-an-ip" });
        expect(notify).toHaveBeenCalledTimes(1);
        f._tracker.dispose();
    });

    it("unblockClusterWide asks the primary and clears the local mirror", async () => {
        vi.spyOn(clusterRpc, "active", "get").mockReturnValue(true);
        const call = vi.spyOn(clusterRpc, "call").mockResolvedValue({ cleared: true });
        const f = new SecurityFilterMiddleware();
        f.applyRemoteBlock("5.5.5.5", Date.now() + 1000);
        await expect(f.unblockClusterWide("5.5.5.5", "root")).resolves.toBe(true);
        expect(call).toHaveBeenCalledWith("primary", M.SF_UNBLOCK, { ip: "5.5.5.5", actor: "root" }, expect.any(Object));
        expect(f._tracker.isBlocked("5.5.5.5")).toBe(false);
        call.mockResolvedValue({ cleared: false });
        await expect(f.unblockClusterWide("5.5.5.5")).resolves.toBe(false);
        f._tracker.dispose();
    });

    it("unblockClusterWide degrades to a local unblock when the primary is unreachable", async () => {
        vi.spyOn(clusterRpc, "active", "get").mockReturnValue(true);
        vi.spyOn(clusterRpc, "call").mockRejectedValue(Object.assign(new Error("t"), { code: "TIMEOUT" }));
        const f = new SecurityFilterMiddleware();
        f.applyRemoteBlock("6.6.6.6", Date.now() + 1000);
        await expect(f.unblockClusterWide("6.6.6.6")).resolves.toBe(true);
        expect(f._tracker.isBlocked("6.6.6.6")).toBe(false);
        f._tracker.dispose();
    });

    it("unblockClusterWide is local when clustering is off or the IP is malformed", async () => {
        const f = new SecurityFilterMiddleware();
        f.applyRemoteBlock("9.9.9.9", Date.now() + 1000);
        await expect(f.unblockClusterWide("9.9.9.9")).resolves.toBe(true);
        vi.spyOn(clusterRpc, "active", "get").mockReturnValue(true);
        const call = vi.spyOn(clusterRpc, "call");
        await expect(f.unblockClusterWide("bogus")).resolves.toBe(false);
        expect(call).not.toHaveBeenCalled();
        f._tracker.dispose();
    });
});
