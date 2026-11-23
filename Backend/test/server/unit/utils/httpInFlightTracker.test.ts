import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import HttpInFlightTracker from "../../../../src/utils/shutdown/HttpInFlightTracker";

type FakeRes = EventEmitter & {
    headersSent: boolean;
    headers: Record<string, string>;
    setHeader: (k: string, v: string) => void;
    getHeader: (k: string) => string | undefined;
};

const makeRes = (contentType?: string): FakeRes => {
    const res = new EventEmitter() as FakeRes;
    res.headersSent = false;
    res.headers = {};
    if (contentType) res.headers["content-type"] = contentType;
    res.setHeader = (k, v) => {
        res.headers[k.toLowerCase()] = v;
    };
    res.getHeader = (k) => res.headers[k.toLowerCase()];
    return res;
};

const makeReq = (method: string, url: string, extra: Record<string, unknown> = {}): IncomingMessage =>
    ({ method, url, ...extra }) as unknown as IncomingMessage;

const track = (t: HttpInFlightTracker, res: FakeRes, req: IncomingMessage) =>
    t._track(req, res as unknown as ServerResponse);

describe("HttpInFlightTracker", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("counts a request until finish, and settles only once", () => {
        const t = new HttpInFlightTracker({ scopeOf: () => undefined });
        const onSettle = vi.fn();
        t.beginShutdown(onSettle);
        const res = makeRes();
        track(t, res, makeReq("GET", "/a"));
        expect(t.activeCount()).toBe(1);
        res.emit("finish");
        res.emit("close");
        expect(t.activeCount()).toBe(0);
        expect(onSettle).toHaveBeenCalledTimes(1);
    });

    it("settles on close without finish (client abort)", () => {
        const t = new HttpInFlightTracker({ scopeOf: () => undefined });
        const res = makeRes();
        track(t, res, makeReq("GET", "/a"));
        res.emit("close");
        expect(t.activeCount()).toBe(0);
    });

    it("does not count SSE streams as in-flight requests", () => {
        const t = new HttpInFlightTracker({ scopeOf: () => undefined });
        track(t, makeRes("text/event-stream; charset=utf-8"), makeReq("GET", "/stream"));
        track(t, makeRes("application/json"), makeReq("GET", "/x"));
        expect(t.activeCount()).toBe(1);
        expect(t.activeSummary().map((s) => s.path)).toEqual(["/x"]);
    });

    it("beginShutdown marks open responses Connection: close, skipping sent headers", () => {
        const t = new HttpInFlightTracker({ scopeOf: () => undefined });
        const open = makeRes();
        const sent = makeRes();
        sent.headersSent = true;
        track(t, open, makeReq("GET", "/a"));
        track(t, sent, makeReq("GET", "/b"));
        t.beginShutdown(() => undefined);
        expect(open.getHeader("connection")).toBe("close");
        expect(sent.getHeader("connection")).toBeUndefined();
    });

    it("marks requests arriving after shutdown began as Connection: close", () => {
        const t = new HttpInFlightTracker({ scopeOf: () => undefined });
        t.beginShutdown(() => undefined);
        const res = makeRes();
        track(t, res, makeReq("GET", "/late"));
        expect(res.getHeader("connection")).toBe("close");
    });

    it("swallows a throwing setHeader and a throwing onSettle", () => {
        const t = new HttpInFlightTracker({ scopeOf: () => undefined });
        const res = makeRes();
        res.setHeader = () => {
            throw new Error("boom");
        };
        track(t, res, makeReq("GET", "/a"));
        expect(() =>
            t.beginShutdown(() => {
                throw new Error("settle boom");
            }),
        ).not.toThrow();
        expect(() => res.emit("finish")).not.toThrow();
        expect(t.activeCount()).toBe(0);
    });

    it("attach() tracks every request emitted by the server", () => {
        const t = new HttpInFlightTracker({ scopeOf: () => undefined });
        const server = new EventEmitter();
        expect(t.attach(server as never)).toBe(t);
        const res = makeRes();
        server.emit("request", makeReq("POST", "/p?x=1"), res);
        expect(t.activeCount()).toBe(1);
        expect(t.activeSummary()[0]).toMatchObject({ method: "POST", path: "/p" });
    });

    it("activeSummary masks numeric ids, prefers the route template, orders oldest first, honours limit", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
        const t = new HttpInFlightTracker({ scopeOf: () => undefined });
        track(t, makeRes(), makeReq("GET", "/users/12345/orders"));
        vi.advanceTimersByTime(1000);
        track(
            t,
            makeRes(),
            makeReq("GET", "/api/9999", { route: { path: "/:id" }, baseUrl: "/api" }),
        );
        vi.advanceTimersByTime(500);
        track(t, makeRes(), makeReq("DELETE", "/z"));

        const all = t.activeSummary();
        expect(all.map((s) => s.path)).toEqual(["/users/:n/orders", "/api/:id", "/z"]);
        expect(all.map((s) => s.ageMs)).toEqual([1500, 500, 0]);
        expect(t.activeSummary(2)).toHaveLength(2);
    });

    it("reports idleMs from the scope, and null when the scope throws or is absent", () => {
        const throwing = new HttpInFlightTracker({
            scopeOf: () => {
                throw new Error("x");
            },
        });
        track(throwing, makeRes(), makeReq("GET", "/a"));
        expect(throwing.activeSummary()[0].idleMs).toBeNull();

        const scoped = new HttpInFlightTracker({ scopeOf: () => ({ idleMs: () => 42 }) });
        track(scoped, makeRes(), makeReq("GET", "/a"));
        expect(scoped.activeSummary()[0].idleMs).toBe(42);

        const none = new HttpInFlightTracker({ scopeOf: () => undefined });
        track(none, makeRes(), makeReq("GET", "/a"));
        expect(none.activeSummary()[0].idleMs).toBeNull();
    });

    it("works with the default watchdog scope lookup (no scope for a bare request)", () => {
        const t = new HttpInFlightTracker();
        track(t, makeRes(), makeReq("GET", "/a"));
        expect(t.activeSummary()[0].idleMs).toBeNull();
    });
});
