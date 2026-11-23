import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Response } from "express";
import {
    postCloseTeardown,
    preCloseTeardown,
    computeShutdownBudget,
    remainingDrainMs,
    computeCrashFailsafeMs,
    finalNotifyBudgetMs,
} from "../../../src/utils/shutdown/TeardownSequence";
import HttpInFlightTracker from "../../../src/utils/shutdown/HttpInFlightTracker";
import inFlightTasks from "../../../src/utils/InFlightTaskRegistry";
import sseRegistry from "../../../src/utils/sse/SseConnectionRegistry";

const quietLogger = () => ({ notice: vi.fn(), warning: vi.fn(), error: vi.fn() });

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const waitFor = async (cond: () => boolean, ms = 2000) => {
    const end = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > end) throw new Error("waitFor timed out");
        await sleep(5);
    }
};

describe("postCloseTeardown ordering", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    const build = (calls: string[], over: Record<string, unknown> = {}) => ({
        inFlight: {
            drain: vi.fn(async () => {
                calls.push("drain");
            }),
        },
        auditLog: {
            flushPending: vi.fn(async () => {
                calls.push("audit");
            }),
        },
        db: {
            closeAll: vi.fn(async () => {
                calls.push("pools");
            }),
        },
        sharedTransporter: {
            closeTransporter: vi.fn(() => {
                calls.push("transporter");
            }),
        },
        logger: quietLogger(),
        notifyDrainMs: 1000,
        onDataTeardownComplete: vi.fn(() => {
            calls.push("marker");
        }),
        lifecycleSettled: vi.fn(async () => {
            calls.push("lifecycle");
        }),
        ...over,
    });

    it("runs tasks drain -> audit flush -> pools -> clean marker -> emails -> transporter", async () => {
        const calls: string[] = [];
        const deps = build(calls);
        await postCloseTeardown(deps as never);
        expect(calls).toEqual(["drain", "audit", "pools", "marker", "lifecycle", "transporter"]);
        expect(deps.auditLog.flushPending).toHaveBeenCalledWith({ final: true });
    });

    it("never writes the clean marker when the audit flush fails, and still closes nothing else", async () => {
        const calls: string[] = [];
        const deps = build(calls, {
            auditLog: {
                flushPending: vi.fn(async () => {
                    throw new Error("flush failed");
                }),
            },
        });
        await postCloseTeardown(deps as never);
        expect(deps.db.closeAll).not.toHaveBeenCalled();
        expect(deps.onDataTeardownComplete).not.toHaveBeenCalled();
        expect(deps.logger.error).toHaveBeenCalled();
        expect(calls).toContain("lifecycle");
    });

    it("never writes the clean marker when pool close fails", async () => {
        const calls: string[] = [];
        const deps = build(calls, {
            db: {
                closeAll: vi.fn(async () => {
                    throw new Error("pool stuck");
                }),
            },
        });
        await postCloseTeardown(deps as never);
        expect(deps.onDataTeardownComplete).not.toHaveBeenCalled();
        expect(deps.sharedTransporter.closeTransporter).not.toHaveBeenCalled();
    });

    it("continues to audit/pools when the task drain rejects", async () => {
        const calls: string[] = [];
        const deps = build(calls, {
            inFlight: {
                drain: vi.fn(async () => {
                    throw new Error("drain failed");
                }),
            },
        });
        await postCloseTeardown(deps as never);
        expect(calls.slice(0, 3)).toEqual(["audit", "pools", "marker"]);
        expect(deps.logger.warning).toHaveBeenCalled();
    });

    it("a throwing marker callback does not stop the remaining teardown", async () => {
        const calls: string[] = [];
        const deps = build(calls, {
            onDataTeardownComplete: vi.fn(() => {
                throw new Error("marker fs");
            }),
        });
        await postCloseTeardown(deps as never);
        expect(deps.sharedTransporter.closeTransporter).toHaveBeenCalled();
    });

    it("alert notifier: phase-1 flush before the drain, final drain after pools, failures tolerated", async () => {
        const calls: string[] = [];
        const alertNotifier = {
            flushForShutdown: vi.fn(async () => {
                calls.push("alert-flush");
            }),
            drainAndStop: vi.fn(async () => {
                calls.push("alert-final");
                throw new Error("smtp down");
            }),
        };
        const deps = build(calls, { alertNotifier, finalNotifyMs: () => 750 });
        await postCloseTeardown(deps as never);
        expect(calls.indexOf("alert-flush")).toBeLessThan(calls.indexOf("drain"));
        expect(calls.indexOf("alert-final")).toBeGreaterThan(calls.indexOf("pools"));
        expect(alertNotifier.drainAndStop).toHaveBeenCalledWith({ timeoutMs: 750, persist: false });
        expect(deps.sharedTransporter.closeTransporter).toHaveBeenCalled();
    });

    it("a dynamic notifyDrainMs is evaluated at drain time", async () => {
        const calls: string[] = [];
        const deps = build(calls, { notifyDrainMs: () => 321 });
        await postCloseTeardown(deps as never);
        expect(deps.inFlight.drain).toHaveBeenCalledWith(321);
    });

    describe("with the real InFlightTaskRegistry", () => {
        it("pools stay open until a tracked task settles", async () => {
            let release!: () => void;
            const task = new Promise<void>((r) => {
                release = r;
            });
            inFlightTasks.track("slow-email", task);
            const calls: string[] = [];
            const deps = build(calls, { inFlight: inFlightTasks, notifyDrainMs: 60_000 });
            const done = postCloseTeardown(deps as never);
            await sleep(30);
            expect(deps.db.closeAll).not.toHaveBeenCalled();
            expect(deps.auditLog.flushPending).not.toHaveBeenCalled();
            release();
            await done;
            expect(calls).toEqual(["audit", "pools", "marker", "lifecycle", "transporter"]);
            expect(inFlightTasks.size()).toBe(0);
        });

        it("a task that never settles is abandoned after the bounded wait (fake timers)", async () => {
            vi.useFakeTimers();
            // Fresh registry instance so the never-settling task cannot leak into other tests.
            vi.resetModules();
            const fresh = (await import("../../../src/utils/InFlightTaskRegistry")).default;
            fresh.track("hung-task", new Promise(() => undefined));
            const calls: string[] = [];
            const deps = build(calls, { inFlight: fresh, notifyDrainMs: 2500 });
            const done = postCloseTeardown(deps as never);
            await vi.advanceTimersByTimeAsync(2499);
            expect(deps.db.closeAll).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(2);
            await done;
            expect(calls).toEqual(["audit", "pools", "marker", "lifecycle", "transporter"]);
            expect(deps.logger.error).not.toHaveBeenCalled();
        });
    });
});

describe("InFlightTaskRegistry", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("track returns non-thenables untouched and counts pending tasks", async () => {
        expect(inFlightTasks.track("x", undefined as never)).toBeUndefined();
        let release!: () => void;
        const p = new Promise<void>((r) => {
            release = r;
        });
        const before = inFlightTasks.size();
        expect(inFlightTasks.track("t", p)).toBe(p);
        expect(inFlightTasks.size()).toBe(before + 1);
        release();
        await p;
        await Promise.resolve();
        expect(inFlightTasks.size()).toBe(before);
    });

    it("drain resolves with drained counts, flips the shutdown flag, and treats rejections as settled", async () => {
        const rejecting = Promise.reject(new Error("task failed"));
        inFlightTasks.track("rejecting", rejecting);
        const ok = Promise.resolve(1);
        inFlightTasks.track("ok", ok);
        const result = await inFlightTasks.drain(1000);
        expect(result).toEqual({ drained: 2, abandoned: 0, labels: [] });
        expect(inFlightTasks.isShuttingDown()).toBe(true);
    });

    it("drain with nothing pending returns immediately", async () => {
        expect(await inFlightTasks.drain(1000)).toEqual({ drained: 0, abandoned: 0, labels: [] });
    });

    it("drain reports abandoned labels after the timeout (fake timers)", async () => {
        vi.useFakeTimers();
        inFlightTasks.track("stuck-a", new Promise(() => undefined));
        const p = inFlightTasks.drain(100);
        await vi.advanceTimersByTimeAsync(101);
        const r = await p;
        expect(r.abandoned).toBeGreaterThanOrEqual(1);
        expect(r.labels).toContain("stuck-a");
    });
});

describe("preCloseTeardown against a real http.Server", () => {
    let server: http.Server;
    let tracker: HttpInFlightTracker;
    let port: number;
    let releaseSlow: (() => void) | null;
    let slowStarted: boolean;
    const sockets = new Set<import("node:net").Socket>();

    beforeEach(async () => {
        releaseSlow = null;
        slowStarted = false;
        tracker = new HttpInFlightTracker({ scopeOf: () => undefined });
        server = http.createServer((req, res) => {
            if (req.url === "/slow") {
                slowStarted = true;
                releaseSlow = () => {
                    res.statusCode = 200;
                    res.end("slow-done");
                };
                return;
            }
            if (req.url === "/stream") {
                res.writeHead(200, { "Content-Type": "text/event-stream" });
                res.write(": open\n\n");
                sseRegistry.register(res as unknown as Response);
                req.on("close", () => sseRegistry.unregister(res as unknown as Response));
                return;
            }
            res.end("ok");
        });
        tracker.attach(server);
        server.on("connection", (s) => {
            sockets.add(s);
            s.on("close", () => sockets.delete(s));
        });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
        port = (server.address() as AddressInfo).port;
    });

    afterEach(async () => {
        for (const s of sockets) s.destroy();
        await new Promise<void>((r) => server.close(() => r()));
    });

    const get = (path: string) =>
        new Promise<{ status: number; body: string; connection: string | undefined }>((resolve, reject) => {
            const req = http.get({ host: "127.0.0.1", port, path, agent: false }, (res) => {
                let body = "";
                res.setEncoding("utf8");
                res.on("data", (c) => (body += c));
                res.on("end", () =>
                    resolve({ status: res.statusCode ?? 0, body, connection: res.headers.connection }),
                );
            });
            req.on("error", reject);
        });

    it("lets an in-flight request finish inside the grace window and marks it Connection: close", async () => {
        const logger = quietLogger();
        const slow = get("/slow");
        await waitFor(() => slowStarted);
        expect(tracker.activeCount()).toBe(1);

        const handle = preCloseTeardown({
            sseRegistry,
            server,
            forceCloseAfterMs: 5000,
            minGraceMs: 10,
            logger,
            httpInFlight: tracker,
            waitNoticeMs: 0,
        });
        expect(handle.idleCuts).toEqual([]);
        releaseSlow!();
        const res = await slow;
        expect(res.status).toBe(200);
        expect(res.body).toBe("slow-done");
        expect(res.connection).toBe("close");
        await waitFor(() => tracker.activeCount() === 0);
        expect(logger.warning).not.toHaveBeenCalled();
    });

    it("sends the SSE shutdown frame and ends the stream, then runs the surface teardown", async () => {
        const frames = await new Promise<string>((resolve, reject) => {
            const req = http.get({ host: "127.0.0.1", port, path: "/stream", agent: false }, (res) => {
                let buf = "";
                res.setEncoding("utf8");
                res.on("data", (c) => {
                    buf += c;
                    if (buf.includes(": open") && !buf.includes("shutdown")) {
                        waitFor(() => sseRegistry.size() === 1).then(() => {
                            preCloseTeardown({
                                sseRegistry,
                                server,
                                forceCloseAfterMs: 2000,
                                minGraceMs: 10,
                                logger: quietLogger(),
                                httpInFlight: tracker,
                                waitNoticeMs: 0,
                            });
                        }, reject);
                    }
                });
                res.on("end", () => resolve(buf));
            });
            req.on("error", reject);
        });
        expect(frames).toContain("event: shutdown");
        expect(frames).toContain('data: {"reason":"server_shutdown"}');
        expect(sseRegistry.size()).toBe(0);
    });

    it("force-closes a request that outlives the grace window and reports the cut", async () => {
        const logger = quietLogger();
        const onRequestsCut = vi.fn();
        const slow = get("/slow").then(
            () => "completed",
            () => "aborted",
        );
        await waitFor(() => slowStarted);
        preCloseTeardown({
            sseRegistry,
            server,
            forceCloseAfterMs: 80,
            minGraceMs: 10,
            logger,
            httpInFlight: tracker,
            onRequestsCut,
            waitNoticeMs: 0,
        });
        expect(await slow).toBe("aborted");
        expect(onRequestsCut).toHaveBeenCalledTimes(1);
        const [summary, graceMs, total, opts] = onRequestsCut.mock.calls[0];
        expect(summary[0]).toMatchObject({ method: "GET", path: "/slow" });
        expect(graceMs).toBe(80);
        expect(total).toBe(1);
        expect(opts).toEqual({ reason: "cap" });
        expect(logger.warning).toHaveBeenCalled();
    });

    it("shortenTo cuts a hung request sooner than the original grace", async () => {
        const slow = get("/slow").then(
            () => "completed",
            () => "aborted",
        );
        await waitFor(() => slowStarted);
        const handle = preCloseTeardown({
            sseRegistry,
            server,
            forceCloseAfterMs: 60_000,
            minGraceMs: 10,
            logger: quietLogger(),
            httpInFlight: tracker,
            waitNoticeMs: 0,
        });
        handle.shortenTo(30);
        expect(await slow).toBe("aborted");
    });

    it("without a tracker, force-closes after the grace period", async () => {
        const slow = get("/slow").then(
            () => "completed",
            () => "aborted",
        );
        await waitFor(() => slowStarted);
        preCloseTeardown({
            sseRegistry,
            server,
            forceCloseAfterMs: 50,
            logger: quietLogger(),
        });
        expect(await slow).toBe("aborted");
    });

    it("an SSE broadcast failure is logged and does not stop the teardown", () => {
        const logger = quietLogger();
        const closeAll = vi.fn();
        const closeIdle = vi.fn();
        const fakeServer = { closeAllConnections: closeAll, closeIdleConnections: closeIdle };
        preCloseTeardown({
            sseRegistry: {
                endAll: () => {
                    throw new Error("registry broke");
                },
            },
            server: fakeServer as never,
            forceCloseAfterMs: 0,
            logger,
        });
        expect(logger.warning).toHaveBeenCalledWith("SSE shutdown broadcast failed", {
            error: "registry broke",
        });
        expect(closeIdle).toHaveBeenCalled();
    });
});

describe("preCloseTeardown timing with fake timers", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    const fakeServer = () => ({ closeAllConnections: vi.fn(), closeIdleConnections: vi.fn() });

    it("with no requests in flight, closes connections after only minGraceMs", async () => {
        vi.useFakeTimers();
        const server = fakeServer();
        const tracker = new HttpInFlightTracker({ scopeOf: () => undefined });
        preCloseTeardown({
            sseRegistry: { endAll: vi.fn() },
            server: server as never,
            forceCloseAfterMs: 30_000,
            minGraceMs: 500,
            logger: quietLogger(),
            httpInFlight: tracker,
        });
        await vi.advanceTimersByTimeAsync(499);
        expect(server.closeAllConnections).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2);
        expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
    });

    it("emits periodic waiting notices and force-closes exactly at the grace cap", async () => {
        vi.useFakeTimers();
        const server = fakeServer();
        const logger = quietLogger();
        const hung = { activeCount: () => 1, beginShutdown: vi.fn() };
        preCloseTeardown({
            sseRegistry: { endAll: vi.fn() },
            server: server as never,
            forceCloseAfterMs: 10_000,
            logger,
            httpInFlight: hung,
            waitNoticeMs: 3000,
        });
        const noticesBefore = logger.notice.mock.calls.length;
        await vi.advanceTimersByTimeAsync(9000);
        expect(logger.notice.mock.calls.length - noticesBefore).toBe(3);
        expect(server.closeAllConnections).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1001);
        expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
        const afterCut = logger.notice.mock.calls.length;
        await vi.advanceTimersByTimeAsync(10_000);
        expect(logger.notice.mock.calls.length).toBe(afterCut);
    });

    it("records idle cuts and passes them to the hook when the drain completes", async () => {
        vi.useFakeTimers();
        const server = fakeServer();
        const onRequestsCut = vi.fn();
        let count = 1;
        let settle: () => void = () => undefined;
        const handle = preCloseTeardown({
            sseRegistry: { endAll: vi.fn() },
            server: server as never,
            forceCloseAfterMs: 10_000,
            minGraceMs: 0,
            logger: quietLogger(),
            httpInFlight: {
                activeCount: () => count,
                beginShutdown: (cb: () => void) => {
                    settle = cb;
                },
            },
            onRequestsCut,
            waitNoticeMs: 0,
        });
        handle.recordIdleCut({ method: "GET", path: "/x", ageMs: 5, idleMs: 5 });
        count = 0;
        settle();
        expect(onRequestsCut).toHaveBeenCalledWith(
            [{ method: "GET", path: "/x", ageMs: 5, idleMs: 5 }],
            10_000,
            1,
            { reason: "idle" },
        );
        await vi.advanceTimersByTimeAsync(1);
        expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
    });
});

describe("shutdown budget arithmetic", () => {
    it("computeShutdownBudget reserves the post-drain time and notify drain", () => {
        expect(
            computeShutdownBudget({
                forcedExitMs: 30_000,
                postDrainReserveMs: 5000,
                safetyMarginMs: 1000,
                notifyDrainMs: 4000,
                pendingTasks: 2,
                minGraceMs: 500,
            }),
        ).toEqual({ phaseBudgetMs: 24_000, requestGraceMs: 20_000, drainReservedMs: 4000 });
    });

    it("computeShutdownBudget honours min and max grace and skips drain reserve with no tasks", () => {
        const base = { postDrainReserveMs: 0, safetyMarginMs: 0, notifyDrainMs: 4000, minGraceMs: 500 };
        expect(computeShutdownBudget({ ...base, forcedExitMs: 100, pendingTasks: 0 }).requestGraceMs).toBe(500);
        expect(
            computeShutdownBudget({ ...base, forcedExitMs: 30_000, pendingTasks: 0, maxGraceMs: 8000 }),
        ).toMatchObject({ requestGraceMs: 8000, drainReservedMs: 0 });
    });

    it("remainingDrainMs is clamped to [0, notifyDrainMs]", () => {
        expect(remainingDrainMs({ phaseDeadline: 10_000, now: 0, notifyDrainMs: 4000 })).toBe(4000);
        expect(remainingDrainMs({ phaseDeadline: 1000, now: 0, notifyDrainMs: 4000 })).toBe(1000);
        expect(remainingDrainMs({ phaseDeadline: 0, now: 500, notifyDrainMs: 4000 })).toBe(0);
    });

    it("crash failsafe and final-notify budgets", () => {
        expect(
            computeCrashFailsafeMs({ crashGraceMs: 1, notifyDrainClampMs: 2, postDrainReserveMs: 3, safetyMarginMs: 4 }),
        ).toBe(10);
        expect(finalNotifyBudgetMs({ failsafeFireAt: 1000, now: 400, reserveMs: 100 })).toBe(500);
        expect(finalNotifyBudgetMs({ failsafeFireAt: 1000, now: 990, reserveMs: 100 })).toBe(0);
    });
});
