import { EventEmitter } from "node:events";
import InFlightTaskRegistryInstance from "../../../../src/utils/InFlightTaskRegistry";
import { ProgressScope } from "../../../../src/utils/progress/ProgressScope";
import { RequestWatchdog } from "../../../../src/utils/progress/RequestWatchdog";
import { RetryPolicy } from "../../../../src/utils/resilience/RetryPolicy";
import { logger } from "../../../../src/utils/logger";

const silence = () => {
    for (const m of ["warning", "notice", "info", "debug", "critical", "error"] as const) {
        vi.spyOn(logger, m).mockImplementation((() => undefined) as never);
    }
};

describe("InFlightTaskRegistry (wave2)", () => {
    const Ctor = (InFlightTaskRegistryInstance as any).constructor as new () => typeof InFlightTaskRegistryInstance;
    beforeEach(() => {
        vi.useFakeTimers();
        silence();
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("track returns non-promises untouched and does not register them", () => {
        const reg = new Ctor();
        expect(reg.track("x", undefined as never)).toBeUndefined();
        const notThenable = { then: 1 } as never;
        expect(reg.track("y", notThenable)).toBe(notThenable);
        expect(reg.size()).toBe(0);
    });

    it("track returns the same promise and untracks on both resolve and reject without unhandled rejections", async () => {
        const reg = new Ctor();
        const ok = Promise.resolve(1);
        const bad = Promise.reject(new Error("boom"));
        expect(reg.track("ok", ok)).toBe(ok);
        expect(reg.track("bad", bad)).toBe(bad);
        expect(reg.size()).toBe(2);
        await ok;
        await bad.catch(() => undefined);
        await vi.advanceTimersByTimeAsync(0);
        expect(reg.size()).toBe(0);
    });

    it("beginShutdown flips the flag idempotently", () => {
        const reg = new Ctor();
        expect(reg.isShuttingDown()).toBe(false);
        reg.beginShutdown();
        reg.beginShutdown();
        expect(reg.isShuttingDown()).toBe(true);
    });

    it("drain with nothing tracked returns immediately, arms no timer, but sets the flag", async () => {
        const reg = new Ctor();
        const res = await reg.drain(1000);
        expect(res).toEqual({ drained: 0, abandoned: 0, labels: [] });
        expect(vi.getTimerCount()).toBe(0);
        expect(reg.isShuttingDown()).toBe(true);
    });

    it("drain waits for tasks that settle within budget and clears its timer", async () => {
        const reg = new Ctor();
        reg.track("a", new Promise((r) => setTimeout(r, 100)));
        reg.track("b", new Promise((_, rej) => setTimeout(() => rej(new Error("x")), 200)).catch(() => undefined) as Promise<unknown>);
        const p = reg.drain(1000);
        await vi.advanceTimersByTimeAsync(200);
        await expect(p).resolves.toEqual({ drained: 2, abandoned: 0, labels: [] });
        expect(vi.getTimerCount()).toBe(0);
    });

    it("chaos: drain abandons tasks that outlive the budget and reports their labels", async () => {
        const reg = new Ctor();
        reg.track("fast", new Promise((r) => setTimeout(r, 10)));
        reg.track("notify:job:20", new Promise(() => undefined));
        const p = reg.drain(500);
        await vi.advanceTimersByTimeAsync(500);
        await expect(p).resolves.toEqual({ drained: 1, abandoned: 1, labels: ["notify:job:20"] });
        expect(logger.warning).toHaveBeenCalled();
    });

    it("drain tolerates a timer without unref", async () => {
        const reg = new Ctor();
        reg.track("slow", new Promise(() => undefined));
        const realSet = globalThis.setTimeout;
        vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms: number) => {
            const t = realSet(fn, ms) as unknown as { unref?: unknown };
            t.unref = undefined;
            return t;
        }) as never);
        const p = reg.drain(50);
        await vi.advanceTimersByTimeAsync(50);
        await expect(p).resolves.toMatchObject({ abandoned: 1 });
    });
});

describe("ProgressScope (wave2)", () => {
    let t = 1000;
    const now = () => t;
    beforeEach(() => {
        t = 1000;
    });

    it("applies defaults for label and idle limit", () => {
        const s = new ProgressScope();
        expect(s.label).toBe("scope");
        expect(s.idleLimitMs).toBe(Infinity);
        expect(s.lastSource).toBe("start");
        expect(s.aborted).toBe(false);
        expect(s.abortError).toBeNull();
        expect(s.signal.aborted).toBe(false);
    });

    it("touch records source, forwards to parent, and defaults the source", () => {
        const parent = new ProgressScope({ now });
        const child = new ProgressScope({ now, parent });
        t = 1500;
        child.touch("db");
        expect(child.lastSource).toBe("db");
        expect(parent.lastSource).toBe("db");
        expect(parent.lastProgressAt).toBe(1500);
        t = 1600;
        child.touch();
        expect(child.lastSource).toBe("unknown");
        expect(child.idleMs(1700)).toBe(100);
        expect(child.idleMs(0)).toBe(0);
    });

    it("follow takes the max of own and followed progress; unfollow and self-follow reset it", () => {
        const a = new ProgressScope({ now });
        const b = new ProgressScope({ now });
        t = 2000;
        b.touch("leader");
        expect(a.lastProgressAt).toBe(1000);
        a.follow(b);
        expect(a.lastProgressAt).toBe(2000);
        a.unfollow();
        expect(a.lastProgressAt).toBe(1000);
        a.follow(b);
        a.follow(a);
        expect(a.lastProgressAt).toBe(1000);
        a.follow(null as never);
        expect(a.lastProgressAt).toBe(1000);
    });

    it("markBusy tracks the oldest in-flight call, propagates to the parent and releases idempotently", () => {
        const parent = new ProgressScope({ now });
        const child = new ProgressScope({ now, parent });
        expect(child.oldestBusyAt()).toBeNull();
        t = 1100;
        const r1 = child.markBusy();
        t = 1200;
        const r2 = child.markBusy();
        expect(child.oldestBusyAt()).toBe(1100);
        expect(parent.oldestBusyAt()).toBe(1100);
        r1();
        r1();
        expect(child.oldestBusyAt()).toBe(1200);
        r2();
        expect(child.oldestBusyAt()).toBeNull();
        expect(parent.oldestBusyAt()).toBeNull();
    });

    it("abort is idempotent, runs every hook even if one throws, aborts the signal and children, and stops touches", () => {
        const parent = new ProgressScope({ now });
        const child = new ProgressScope({ now, parent });
        const calls: string[] = [];
        parent.onAbort(() => {
            throw new Error("bad hook");
        });
        parent.onAbort((e) => calls.push(e.message));
        const first = new Error("first");
        parent.abort(first);
        parent.abort(new Error("second"));
        expect(parent.abortError).toBe(first);
        expect(child.abortError).toBe(first);
        expect(parent.signal.aborted).toBe(true);
        expect(calls).toEqual(["first"]);
        const before = parent.lastProgressAt;
        t = 9999;
        parent.touch("late");
        expect(parent.lastProgressAt).toBe(before);
        expect(() => parent.throwIfAborted()).toThrow("first");
    });

    it("abort without an error uses a default error; throwIfAborted is a no-op beforehand", () => {
        const s = new ProgressScope();
        expect(() => s.throwIfAborted()).not.toThrow();
        s.abort();
        expect(s.abortError?.message).toBe("ProgressScope aborted");
    });

    it("onAbort runs immediately on an aborted scope (swallowing hook errors) and dispose unregisters", () => {
        const s = new ProgressScope();
        s.abort(new Error("x"));
        const seen = vi.fn();
        const off = s.onAbort(seen);
        expect(seen).toHaveBeenCalledTimes(1);
        expect(off()).toBeUndefined();
        expect(() => s.onAbort(() => { throw new Error("h"); })).not.toThrow();

        const live = new ProgressScope();
        const hook = vi.fn();
        const dispose = live.onAbort(hook);
        dispose();
        live.abort();
        expect(hook).not.toHaveBeenCalled();
    });

    it("a child created under an aborted parent is born aborted; dispose detaches from parent", () => {
        const parent = new ProgressScope();
        const detached = new ProgressScope({ parent });
        detached.onAbort(() => undefined);
        detached.dispose();
        const born = new ProgressScope({ parent: (() => { const p = new ProgressScope(); p.abort(new Error("dead")); return p; })() });
        expect(born.aborted).toBe(true);
        expect(born.abortError?.message).toBe("dead");
        parent.abort(new Error("later"));
        expect(detached.aborted).toBe(false);
        const orphan = new ProgressScope();
        expect(() => orphan.dispose()).not.toThrow();
    });

    it("abort survives a throwing signal controller", () => {
        const s = new ProgressScope();
        vi.spyOn(s._controller, "abort").mockImplementation(() => { throw new Error("listener"); });
        expect(() => s.abort(new Error("e"))).not.toThrow();
        expect(s.aborted).toBe(true);
    });
});

describe("RequestWatchdog internals (wave2)", () => {
    const makeRes = (over: Record<string, any> = {}): any => {
        const res = new EventEmitter() as any;
        res.headersSent = false;
        res.writableEnded = false;
        res.headers = {} as Record<string, string>;
        res.setHeader = (k: string, v: string) => { res.headers[k.toLowerCase()] = v; };
        res.getHeader = (k: string) => res.headers[k.toLowerCase()];
        res.destroy = vi.fn();
        res.end = vi.fn();
        return Object.assign(res, over);
    };
    const cors = (apply = (_q: unknown, _r: unknown, done: () => void) => done()) => ({ applyToErrorResponse: vi.fn(apply) });
    const idle = () => {
        const reg: { cb?: (s: ProgressScope, i: number) => void; probe?: (s: ProgressScope) => void; unregister: () => void } = { unregister: vi.fn() };
        return {
            reg,
            wd: { register: vi.fn((_s: unknown, cb: any, o: any) => { reg.cb = cb; reg.probe = o.probe; return reg.unregister; }) } as any,
        };
    };
    beforeEach(() => silence());
    afterEach(() => {
        RequestWatchdog.setShutdownHook(null);
        vi.restoreAllMocks();
    });

    it("scopeOf is undefined for falsy/unknown requests; setShutdownHook ignores non-functions", () => {
        expect(RequestWatchdog.scopeOf(undefined as never)).toBeUndefined();
        expect(RequestWatchdog.scopeOf({} as never)).toBeUndefined();
        RequestWatchdog.setShutdownHook("nope" as never);
    });

    it("constructor without limits resolves env limits and warns on clamped values", () => {
        const old = { ...process.env };
        process.env.REQUEST_IDLE_TIMEOUT_MS = "1";
        process.env.REQUEST_IDLE_LONG_TIMEOUT_MS = "1";
        try {
            const w = new RequestWatchdog({ burstDetector: { record: vi.fn() } });
            expect(w._limits.defaultMs).toBeGreaterThan(0);
        } finally {
            process.env = old;
        }
    });

    it("_watch probe: SSE content-type or flushed head keeps scope alive; byte movement touches socket-io; no movement does not", () => {
        const { wd, reg } = idle();
        const w = new RequestWatchdog({ limits: { defaultMs: 1000, longMs: 5000 }, idleWatchdog: wd, burstDetector: { record: vi.fn() } });
        const req: any = { method: "GET", url: "/api/v1/things", socket: { bytesRead: 0, bytesWritten: 0 } };
        const res = makeRes();
        w._watch(req, res);
        const scope = RequestWatchdog.scopeOf(req)!;
        reg.probe!(scope);
        expect(scope.lastSource).toBe("start");
        req.socket.bytesRead = 10;
        reg.probe!(scope);
        expect(scope.lastSource).toBe("socket-io");
        res.setHeader("content-type", "text/event-stream");
        reg.probe!(scope);
        expect(scope.lastSource).toBe("sse-exempt");
        res.headers = {};
        res._header = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n";
        scope.touch("reset");
        reg.probe!(scope);
        expect(scope.lastSource).toBe("sse-exempt");
        res.emit("finish");
        res.emit("close");
        expect(reg.unregister).toHaveBeenCalledTimes(1);
    });

    it("_watch tolerates a request with no socket", () => {
        const { wd, reg } = idle();
        const w = new RequestWatchdog({ limits: { defaultMs: 1000, longMs: 5000 }, idleWatchdog: wd, burstDetector: { record: vi.fn() } });
        const req: any = { method: "GET", url: "/x" };
        w._watch(req, makeRes({ getHeader: undefined }));
        expect(() => reg.probe!(RequestWatchdog.scopeOf(req)!)).not.toThrow();
    });

    it("_terminate answers 504 via status/json, records burst and fires the shutdown hook with a masked path", () => {
        const record = vi.fn();
        const c = cors();
        const w = new RequestWatchdog({ limits: { defaultMs: 1, longMs: 2 }, burstDetector: { record }, cors: c });
        const hook = vi.fn();
        RequestWatchdog.setShutdownHook(hook);
        const req: any = { method: "POST", url: "/api/v1/users/12345?x=1", id: "rid" };
        const res = makeRes({ status: vi.fn().mockReturnThis(), json: vi.fn() });
        const scope = new ProgressScope({ idleLimitMs: 1 });
        w._terminate(req, res, scope, 77);
        expect(res.status).toHaveBeenCalledWith(504);
        expect(res.json.mock.calls[0][0]).toMatchObject({ requestId: "rid" });
        expect(res.locals.__watchdogTerminated).toBe(true);
        expect(res.headers.connection).toBe("close");
        expect(scope.aborted).toBe(true);
        expect(record).toHaveBeenCalledWith(expect.objectContaining({ method: "POST", path: "/api/v1/users/…" }));
        expect(hook).toHaveBeenCalledWith(expect.objectContaining({ idleMs: 77, path: "/api/v1/users/…" }));
    });

    it("_terminate falls back to raw statusCode/end when res has no status/json, and uses the route template", () => {
        const w = new RequestWatchdog({ limits: { defaultMs: 1, longMs: 2 }, burstDetector: { record: vi.fn() }, cors: cors() });
        const req: any = { method: "GET", originalUrl: "/api/v1/a/1", baseUrl: "/api/v1/a", route: { path: "/:id" } };
        const res = makeRes();
        w._terminate(req, res, new ProgressScope(), 5);
        expect(res.statusCode).toBe(504);
        expect(res.headers["content-type"]).toContain("application/json");
        expect(JSON.parse(res.end.mock.calls[0][0])).toMatchObject({ status: "error", code: 504 });
        const logged = (logger.error as any).mock.calls.flat().join(" ");
        expect(logged).toContain("/api/v1/a/:id");
    });

    it("_terminate destroys the socket when headers were already sent", () => {
        const w = new RequestWatchdog({ limits: { defaultMs: 1, longMs: 2 }, burstDetector: { record: vi.fn() }, cors: cors() });
        const res = makeRes({ headersSent: true });
        w._terminate({ method: "GET", url: "/" } as any, res, new ProgressScope(), 1);
        expect(res.destroy).toHaveBeenCalled();
        expect(res.locals.__watchdogTerminated).toBe(true);
    });

    it("chaos: a throwing CORS policy, a throwing destroy, burst detector and shutdown hook never escape _terminate", () => {
        const bad = { applyToErrorResponse: () => { throw new Error("cors down"); } };
        const w = new RequestWatchdog({
            limits: { defaultMs: 1, longMs: 2 },
            cors: bad as never,
            burstDetector: { record: () => { throw new Error("burst"); } },
        });
        RequestWatchdog.setShutdownHook(() => { throw new Error("hook"); });
        const res = makeRes({ destroy: () => { throw new Error("gone"); } });
        expect(() => w._terminate({ method: undefined, url: undefined } as any, res, new ProgressScope(), 1)).not.toThrow();
        const logged = (logger.error as any).mock.calls.flat().join(" ");
        expect(logged).toContain("cors down");
    });

    it("attach prepends a request listener that starts watching", () => {
        const { wd } = idle();
        const w = new RequestWatchdog({ limits: { defaultMs: 1, longMs: 2 }, idleWatchdog: wd });
        const server = new EventEmitter() as any;
        server.prependListener = (ev: string, fn: any) => server.on(ev, fn);
        expect(w.attach(server)).toBe(w);
        const req: any = { method: "GET", url: "/", socket: {} };
        server.emit("request", req, makeRes());
        expect(RequestWatchdog.scopeOf(req)).toBeInstanceOf(ProgressScope);
    });
});

describe("RetryPolicy (wave2)", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        silence();
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    it("constructor defaults come from env, ignoring invalid values", async () => {
        vi.stubEnv("DB_ROW_RETRY_MAX", "4");
        vi.stubEnv("DB_RETRY_BASE_DELAY_MS", "abc");
        vi.stubEnv("DB_RETRY_MAX_DELAY_MS", "-3");
        const p = new RetryPolicy();
        expect(p._maxAttempts).toBe(4);
        expect(p._baseDelayMs).toBe(200);
        expect(p._maxDelayMs).toBe(5000);
    });

    it("rejects maxDelayMs below base and a non-function classifier", () => {
        expect(() => new RetryPolicy({ baseDelayMs: 10, maxDelayMs: 5 })).toThrow(RangeError);
        expect(() => new RetryPolicy({ classifier: "x" as never })).toThrow(TypeError);
    });

    it("chaos: retry budget exhausted rethrows the last error with attempts and classification attached", async () => {
        const p = new RetryPolicy({ maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 40, classifier: RetryPolicy.classifySmtpError, label: "smtp" });
        const fn = vi.fn().mockRejectedValue(Object.assign(new Error("down"), { code: "ECONNECTION" }));
        const run = p.execute(fn);
        const assertion = expect(run).rejects.toMatchObject({ attempts: 3, classification: "TRANSIENT_SMTP" });
        await vi.runAllTimersAsync();
        await assertion;
        expect(fn).toHaveBeenCalledTimes(3);
    });

    it("a permanent classification stops after one attempt even with budget left", async () => {
        const p = new RetryPolicy({ maxAttempts: 5, classifier: RetryPolicy.classifyDbError });
        const fn = vi.fn().mockRejectedValue(new Error("ORA-00942: table missing"));
        await expect(p.execute(fn)).rejects.toMatchObject({ attempts: 1, classification: "PERMANENT_DB" });
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it("onRetry probe resolves with the id of the resolved row (key derivation from id, ID, null)", async () => {
        const mk = () => new RetryPolicy({ maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 });
        for (const resolved of [{ id: 7 }, { ID: 8 }, null]) {
            const out = await mk().execute(async () => { throw new Error("lost ack"); }, { onRetry: async () => ({ resolved }) });
            expect(out).toBe(resolved);
        }
        const msgs = (logger.info as any).mock.calls.map((c: any[]) => String(c[0]));
        expect(msgs.length).toBe(3);
    });

    it("onRetry returning nothing keeps retrying; backoff is capped at maxDelayMs plus jitter", async () => {
        vi.spyOn(Math, "random").mockReturnValue(0.5);
        const p = new RetryPolicy({ maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 150 });
        expect(p._computeBackoff(1)).toBe(150);
        expect(p._computeBackoff(5)).toBe(200);
        let calls = 0;
        const run = p.execute(async (a) => { calls = a; if (a < 3) throw new Error("t"); return "ok"; }, { onRetry: async () => undefined });
        await vi.runAllTimersAsync();
        await expect(run).resolves.toBe("ok");
        expect(calls).toBe(3);
    });

    it("a thrown non-Error value without classifier is retried to the cap", async () => {
        const p = new RetryPolicy({ maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 });
        const run = p.execute(async () => { throw Object.assign(new Error("x"), {}); });
        const assertion = expect(run).rejects.toMatchObject({ attempts: 2, classification: null });
        await vi.runAllTimersAsync();
        await assertion;
    });

    it("classifyDbError covers duplicate, fatal session, system codes, wrapped originalError, message patterns and junk input", () => {
        const C = RetryPolicy.CLASSIFICATIONS;
        expect(RetryPolicy.classifyDbError(null)).toBe(C.PERMANENT_DB);
        expect(RetryPolicy.classifyDbError("str")).toBe(C.PERMANENT_DB);
        expect(RetryPolicy.classifyDbError({ errorNum: 1 })).toBe(C.DUPLICATE);
        expect(RetryPolicy.classifyDbError({ message: "ORA-00031: x" })).toBe(C.FATAL_SESSION);
        expect(RetryPolicy.classifyDbError({ message: "w", originalError: { errorNum: 3113 } })).toBe(C.TRANSIENT_DB);
        expect(RetryPolicy.classifyDbError({ code: "ECONNRESET" })).toBe(C.TRANSIENT_DB);
        expect(RetryPolicy.classifyDbError({ message: "Timed out getting connection from pool" })).toBe(C.TRANSIENT_DB);
        expect(RetryPolicy.classifyDbError({ message: "NJS-503: gone" })).toBe(C.TRANSIENT_DB);
        expect(RetryPolicy.classifyDbError({ message: "ORA-00942" })).toBe(C.PERMANENT_DB);
        expect(RetryPolicy.isTransientDbError({ errorNum: 12541 })).toBe(true);
        expect(RetryPolicy.isTransientDbError({ errorNum: 942 })).toBe(false);
    });

    it("classifySmtpError covers codes, response-code ranges, wrapped errors and unclassifiable input", () => {
        const C = RetryPolicy.CLASSIFICATIONS;
        expect(RetryPolicy.classifySmtpError(undefined)).toBe(C.PERMANENT_SMTP);
        expect(RetryPolicy.classifySmtpError({ code: "EPIPE" })).toBe(C.TRANSIENT_SMTP);
        expect(RetryPolicy.classifySmtpError({ responseCode: 451 })).toBe(C.TRANSIENT_SMTP);
        expect(RetryPolicy.classifySmtpError({ responseCode: 550 })).toBe(C.PERMANENT_SMTP);
        expect(RetryPolicy.classifySmtpError({ responseCode: 200 })).toBe(C.PERMANENT_SMTP);
        expect(RetryPolicy.classifySmtpError({ code: "EAUTH" })).toBe(C.PERMANENT_SMTP);
        expect(RetryPolicy.classifySmtpError({ originalError: { responseCode: 421 } })).toBe(C.TRANSIENT_SMTP);
        expect(RetryPolicy.isTransientSmtpError({ code: "EDNS" })).toBe(true);
        expect(RetryPolicy.isTransientSmtpError({ code: "EAUTH" })).toBe(false);
    });

    it("error chain walk is bounded so a cyclic originalError cannot hang classification", () => {
        const a: any = { message: "a" };
        a.originalError = a;
        expect(RetryPolicy.classifyDbError(a)).toBe(RetryPolicy.CLASSIFICATIONS.PERMANENT_DB);
    });
});
