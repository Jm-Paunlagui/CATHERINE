import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import { RequestWatchdog } from "../../../src/utils/progress/RequestWatchdog";
import { IdleWatchdog } from "../../../src/utils/progress/IdleWatchdog";
import { ProgressScope } from "../../../src/utils/progress/ProgressScope";
import { WatchdogBurstDetector } from "../../../src/utils/progress/WatchdogBurstDetector";
import { metricsStore } from "../../../src/middleware/metrics/MetricsStore";
import { logger } from "../../../src/utils/logger";
import { REQUEST_ERRORS } from "../../../src/constants/errors";

const SWEEP_MS = 1000;
const LIMITS = { defaultMs: 10_000, longMs: 60_000 };

type FakeRes = EventEmitter & {
    headersSent: boolean;
    writableEnded: boolean;
    statusCode: number;
    locals?: Record<string, unknown>;
    headers: Record<string, string>;
    body: unknown;
    destroyed: boolean;
    setHeader(k: string, v: string): void;
    getHeader(k: string): string | undefined;
    status(c: number): FakeRes;
    json(b: unknown): FakeRes;
    destroy(): void;
};

const makeRes = (): FakeRes => {
    const res = new EventEmitter() as FakeRes;
    res.headersSent = false;
    res.writableEnded = false;
    res.statusCode = 200;
    res.headers = {};
    res.body = undefined;
    res.destroyed = false;
    res.setHeader = (k, v) => {
        res.headers[k.toLowerCase()] = v;
    };
    res.getHeader = (k) => res.headers[k.toLowerCase()];
    res.status = (c) => {
        res.statusCode = c;
        return res;
    };
    res.json = (b) => {
        res.body = b;
        res.headersSent = true;
        return res;
    };
    res.destroy = () => {
        res.destroyed = true;
    };
    return res;
};

const makeReq = (method: string, url: string) => ({
    method,
    url,
    socket: { bytesRead: 0, bytesWritten: 0 },
});

describe("RequestWatchdog (fake timers)", () => {
    let clock = 0;
    let idle: IdleWatchdog;
    let server: EventEmitter;
    let burstEmit: ReturnType<typeof vi.fn<(message: string, meta: Record<string, unknown>) => void>>;
    let burst: WatchdogBurstDetector;
    let cors: { applyToErrorResponse: ReturnType<typeof vi.fn<(req: unknown, res: unknown, done: () => void) => void>> };
    let wd: RequestWatchdog;

    const advance = (ms: number) => {
        for (let left = ms; left > 0; left -= SWEEP_MS) {
            const step = Math.min(SWEEP_MS, left);
            clock += step;
            vi.advanceTimersByTime(step);
        }
    };

    const fire = (method: string, url: string) => {
        const req = makeReq(method, url);
        const res = makeRes();
        server.emit("request", req, res);
        return { req, res };
    };

    beforeEach(() => {
        vi.useFakeTimers();
        clock = 1_000_000;
        vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
        vi.spyOn(logger, "warning").mockImplementation(() => undefined as never);
        vi.spyOn(metricsStore, "recordWatchdogTermination").mockImplementation(() => undefined);
        idle = new IdleWatchdog({ sweepMs: SWEEP_MS, now: () => clock, dbCallCapMs: 1_800_000 });
        burstEmit = vi.fn<(message: string, meta: Record<string, unknown>) => void>();
        burst = new WatchdogBurstDetector({ burst: 3, windowMs: 600_000, now: () => clock, emit: burstEmit });
        cors = {
            applyToErrorResponse: vi.fn<(req: unknown, res: unknown, done: () => void) => void>((_req, _res, done) => done()),
        };
        wd = new RequestWatchdog({ limits: LIMITS, idleWatchdog: idle, now: () => clock, cors, burstDetector: burst });
        server = new EventEmitter();
        wd.attach(server as unknown as Server);
        idle.start();
    });

    afterEach(() => {
        idle.stop();
        RequestWatchdog.setShutdownHook(null);
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("cuts an idle request with a 504 RequestStalledError envelope", () => {
        const { req, res } = fire("GET", "/api/v1/things/123");
        const scope = RequestWatchdog.scopeOf(req as never) as ProgressScope;
        expect(scope).toBeInstanceOf(ProgressScope);

        advance(LIMITS.defaultMs + SWEEP_MS * 2);

        expect(res.statusCode).toBe(504);
        const body = res.body as { status: string; code: number; error: { type: string } };
        expect(body.status).toBe("error");
        expect(body.code).toBe(504);
        expect(body.error.type).toBe("RequestStalledError");
        expect(res.headers.connection).toBe("close");
        expect(res.locals?.__watchdogTerminated).toBe(true);
        expect(cors.applyToErrorResponse).toHaveBeenCalledTimes(1);
        expect(scope.aborted).toBe(true);
        expect(scope.abortError?.message).toBe(REQUEST_ERRORS.STALLED);
        expect((scope.abortError as { statusCode?: number }).statusCode).toBe(504);
        expect(metricsStore.recordWatchdogTermination).toHaveBeenCalledTimes(1);
    });

    it("cuts only once even though sweeps keep running", () => {
        const { res } = fire("GET", "/api/v1/things");
        advance(LIMITS.defaultMs + SWEEP_MS * 10);
        expect(cors.applyToErrorResponse).toHaveBeenCalledTimes(1);
        expect(res.statusCode).toBe(504);
    });

    it("does not cut a request that keeps making progress", () => {
        const { req, res } = fire("GET", "/api/v1/things");
        const scope = RequestWatchdog.scopeOf(req as never) as ProgressScope;
        for (let i = 0; i < 30; i++) {
            advance(SWEEP_MS);
            scope.touch("db-call");
        }
        expect(scope.aborted).toBe(false);
        expect(res.statusCode).toBe(200);
        expect(cors.applyToErrorResponse).not.toHaveBeenCalled();
    });

    it("treats socket byte movement as progress and a frozen socket as idle", () => {
        const { req, res } = fire("POST", "/api/v1/upload");
        const scope = RequestWatchdog.scopeOf(req as never) as ProgressScope;
        for (let i = 0; i < 20; i++) {
            req.socket.bytesRead += 100;
            advance(SWEEP_MS);
        }
        expect(scope.aborted).toBe(false);
        expect(scope.lastSource).toBe("socket-io");

        advance(LIMITS.defaultMs + SWEEP_MS * 2);
        expect(scope.aborted).toBe(true);
        expect(res.statusCode).toBe(504);
    });

    it("exempts SSE routes by route rule", () => {
        const { req, res } = fire("GET", "/api/v1/health/stream");
        const scope = RequestWatchdog.scopeOf(req as never) as ProgressScope;
        expect(scope.idleLimitMs).toBe(Infinity);
        advance(LIMITS.longMs * 5);
        expect(scope.aborted).toBe(false);
        expect(res.destroyed).toBe(false);
    });

    it("exempts a text/event-stream response on a non-exempt route", () => {
        const { req, res } = fire("GET", "/api/v1/custom/feed");
        const scope = RequestWatchdog.scopeOf(req as never) as ProgressScope;
        res.setHeader("Content-Type", "text/event-stream");
        advance(LIMITS.defaultMs * 5);
        expect(scope.aborted).toBe(false);
        expect(scope.lastSource).toBe("sse-exempt");
        expect(res.destroyed).toBe(false);
    });

    it("gives long-running routes the long idle window", () => {
        const { req, res } = fire("POST", "/api/v1/data-purge/execute");
        const scope = RequestWatchdog.scopeOf(req as never) as ProgressScope;
        expect(scope.idleLimitMs).toBe(LIMITS.longMs);
        advance(LIMITS.defaultMs * 3);
        expect(scope.aborted).toBe(false);
        advance(LIMITS.longMs);
        expect(res.statusCode).toBe(504);
    });

    it("destroys the socket instead of writing when headers were already sent", () => {
        const { res } = fire("GET", "/api/v1/things");
        res.headersSent = true;
        advance(LIMITS.defaultMs + SWEEP_MS * 2);
        expect(res.destroyed).toBe(true);
        expect(res.body).toBeUndefined();
        expect(res.locals?.__watchdogTerminated).toBe(true);
        expect(cors.applyToErrorResponse).not.toHaveBeenCalled();
    });

    it("unregisters the request when the response finishes", () => {
        const { res } = fire("GET", "/api/v1/things");
        expect(idle.size).toBe(1);
        res.emit("finish");
        expect(idle.size).toBe(0);
        res.emit("close");
        advance(LIMITS.defaultMs * 3);
        expect(cors.applyToErrorResponse).not.toHaveBeenCalled();
    });

    it("invokes the shutdown hook with the cut, and survives a throwing hook", () => {
        const hook = vi.fn();
        RequestWatchdog.setShutdownHook(hook);
        fire("GET", "/api/v1/things");
        advance(LIMITS.defaultMs + SWEEP_MS * 2);
        expect(hook).toHaveBeenCalledTimes(1);
        const arg = hook.mock.calls[0][0];
        expect(arg.method).toBe("GET");
        expect(arg.path).toBe("/api/v1/things/…");
        expect(arg.idleMs).toBeGreaterThan(LIMITS.defaultMs);

        RequestWatchdog.setShutdownHook(() => {
            throw new Error("hook boom");
        });
        const { res } = fire("GET", "/api/v1/other");
        expect(() => advance(LIMITS.defaultMs + SWEEP_MS * 2)).not.toThrow();
        expect(res.statusCode).toBe(504);
    });

    it("three cuts inside the window raise exactly one burst alert", () => {
        fire("GET", "/api/v1/a");
        fire("GET", "/api/v1/b");
        fire("GET", "/api/v1/c");
        advance(LIMITS.defaultMs + SWEEP_MS * 2);
        expect(burstEmit).toHaveBeenCalledTimes(1);

        fire("GET", "/api/v1/d");
        advance(LIMITS.defaultMs + SWEEP_MS * 2);
        expect(burstEmit).toHaveBeenCalledTimes(1);
    });

    it("two cuts stay below the burst threshold", () => {
        fire("GET", "/api/v1/a");
        fire("GET", "/api/v1/b");
        advance(LIMITS.defaultMs + SWEEP_MS * 2);
        expect(burstEmit).not.toHaveBeenCalled();
    });

    it("a throwing burst detector or metrics store does not break the cut", () => {
        vi.spyOn(metricsStore, "recordWatchdogTermination").mockImplementation(() => {
            throw new Error("metrics down");
        });
        const throwing = {
            record: () => {
                throw new Error("detector down");
            },
        };
        const wd2 = new RequestWatchdog({ limits: LIMITS, idleWatchdog: idle, now: () => clock, cors, burstDetector: throwing });
        const server2 = new EventEmitter();
        wd2.attach(server2 as unknown as Server);
        const res = makeRes();
        server2.emit("request", makeReq("GET", "/api/v1/x"), res);
        advance(LIMITS.defaultMs + SWEEP_MS * 2);
        expect(res.statusCode).toBe(504);
    });
});

describe("IdleWatchdog event-loop stall guard (fake timers)", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("touches every scope instead of cutting when a sweep is very late", () => {
        vi.spyOn(logger, "warning").mockImplementation(() => undefined as never);
        let clock = 0;
        const idle = new IdleWatchdog({ sweepMs: 1000, stallFactor: 3, now: () => clock, dbCallCapMs: 1000 });
        const scope = new ProgressScope({ idleLimitMs: 5000, now: () => clock });
        const onIdle = vi.fn();
        idle.register(scope, onIdle);
        idle.sweep(0);
        clock = 60_000;
        idle.sweep(60_000);
        expect(onIdle).not.toHaveBeenCalled();
        expect(scope.lastSource).toBe("event-loop-stall");
        for (clock = 62_000; clock <= 66_000; clock += 2000) idle.sweep(clock);
        expect(onIdle).toHaveBeenCalledTimes(1);
    });

    it("counts an in-flight DB call as progress until the cap, then cuts", () => {
        let clock = 0;
        const idle = new IdleWatchdog({ sweepMs: 1000, stallFactor: 1000, now: () => clock, dbCallCapMs: 20_000 });
        const scope = new ProgressScope({ idleLimitMs: 5000, now: () => clock });
        const onIdle = vi.fn();
        idle.register(scope, onIdle);
        scope.markBusy();
        for (clock = 1000; clock < 20_000; clock += 1000) idle.sweep(clock);
        expect(onIdle).not.toHaveBeenCalled();
        expect(scope.lastSource).toBe("db-inflight");
        for (; clock <= 40_000; clock += 1000) idle.sweep(clock);
        expect(onIdle).toHaveBeenCalledTimes(1);
    });
});

describe("ProgressScope abort propagation", () => {
    it("aborts children, runs hooks, and ignores touch after abort", () => {
        let clock = 0;
        const parent = new ProgressScope({ idleLimitMs: 1000, now: () => clock });
        const child = new ProgressScope({ parent, now: () => clock });
        const hook = vi.fn();
        child.onAbort(hook);
        const err = new Error("stalled");
        parent.abort(err);
        expect(child.aborted).toBe(true);
        expect(hook).toHaveBeenCalledWith(err);
        expect(() => child.throwIfAborted()).toThrow(err);
        clock = 500;
        child.touch("late");
        expect(child.lastSource).toBe("start");
    });

    it("child touch refreshes the parent idle clock", () => {
        let clock = 0;
        const parent = new ProgressScope({ idleLimitMs: 1000, now: () => clock });
        const child = new ProgressScope({ parent, now: () => clock });
        clock = 900;
        child.touch("db");
        expect(parent.idleMs(clock)).toBe(0);
        expect(parent.lastSource).toBe("db");
    });
});
