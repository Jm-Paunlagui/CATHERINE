/**
 * @fileoverview Branch tests for src/utils/shutdown/TeardownSequence.ts that the
 * reliability suite (test/server/reliability/teardownSequence.reliability.test.ts)
 * leaves unproven. Focus: every guarded step must CONTINUE through a failure
 * (thrown Error, non-Error rejection, synchronous throw) and every optional
 * dependency must be safely absent. All fakes are injected; no real server.
 */

import { postCloseTeardown, preCloseTeardown } from "../../../../src/utils/shutdown/TeardownSequence";
import { serverMessages } from "../../../../src/constants/messages/server.messages";

const quietLogger = () => ({ notice: vi.fn(), warning: vi.fn(), error: vi.fn() });
const fakeServer = () => ({ closeAllConnections: vi.fn(), closeIdleConnections: vi.fn() });

afterEach(() => {
    vi.useRealTimers();
});

// ─── postCloseTeardown ────────────────────────────────────────────────────────

describe("postCloseTeardown — optional deps and failure tolerance", () => {
    const base = (calls: string[], over: Record<string, unknown> = {}) => ({
        inFlight: { drain: vi.fn(async () => void calls.push("drain")) },
        auditLog: { flushPending: vi.fn(async () => void calls.push("audit")) },
        db: { closeAll: vi.fn(async () => void calls.push("pools")) },
        sharedTransporter: { closeTransporter: vi.fn(() => void calls.push("transporter")) },
        logger: quietLogger(),
        notifyDrainMs: 100,
        ...over,
    });

    it("with only the required deps (no notifier, no lifecycle, no marker) still completes the sequence", async () => {
        const calls: string[] = [];
        const deps = base(calls);
        await postCloseTeardown(deps as never);
        expect(calls).toEqual(["drain", "audit", "pools", "transporter"]);
        expect(deps.logger.notice).toHaveBeenCalledWith("All resources cleaned up.");
        expect(deps.logger.warning).not.toHaveBeenCalled();
    });

    it("a db adapter without closeAll (e.g. DEMO_MODE) is skipped, not called", async () => {
        const calls: string[] = [];
        const deps = base(calls, { db: {} });
        await postCloseTeardown(deps as never);
        expect(calls).toEqual(["drain", "audit", "transporter"]);
        expect(deps.logger.error).not.toHaveBeenCalled();
    });

    it("finalNotifyMs defaults to a 0 ms budget when the notifier is injected without one", async () => {
        const alertNotifier = { flushForShutdown: vi.fn(async () => undefined), drainAndStop: vi.fn(async () => undefined) };
        const deps = base([], { alertNotifier });
        await postCloseTeardown(deps as never);
        expect(alertNotifier.drainAndStop).toHaveBeenCalledWith({ timeoutMs: 0, persist: false });
    });

    it("phase-1 flush rejecting with an Error is logged (no notify loop) and the drain still runs", async () => {
        const calls: string[] = [];
        const alertNotifier = {
            flushForShutdown: vi.fn(async () => {
                throw new Error("oracle gone");
            }),
            drainAndStop: vi.fn(async () => undefined),
        };
        const deps = base(calls, { alertNotifier });
        await postCloseTeardown(deps as never);
        expect(deps.logger.warning).toHaveBeenCalledWith(
            serverMessages.SHUTDOWN_NOTIFIER_STEP_FAILED("phase-1 flush", "oracle gone"),
            { _noNotify: true },
        );
        expect(calls).toEqual(["drain", "audit", "pools", "transporter"]);
    });

    it("phase-1 flush throwing SYNCHRONOUSLY a non-Error value is still caught and stringified", async () => {
        const alertNotifier = {
            flushForShutdown: vi.fn(() => {
                throw "plain string";
            }),
            drainAndStop: vi.fn(async () => undefined),
        };
        const deps = base([], { alertNotifier });
        await expect(postCloseTeardown(deps as never)).resolves.toBeUndefined();
        expect(deps.logger.warning).toHaveBeenCalledWith(
            serverMessages.SHUTDOWN_NOTIFIER_STEP_FAILED("phase-1 flush", "plain string"),
            { _noNotify: true },
        );
        expect(deps.sharedTransporter.closeTransporter).toHaveBeenCalled();
    });

    it("phase-1 flush rejecting with null is stringified as 'null' rather than crashing on err.message", async () => {
        const alertNotifier = {
            flushForShutdown: vi.fn(() => Promise.reject(null)),
            drainAndStop: vi.fn(async () => undefined),
        };
        const deps = base([], { alertNotifier });
        await postCloseTeardown(deps as never);
        expect(deps.logger.warning).toHaveBeenCalledWith(
            serverMessages.SHUTDOWN_NOTIFIER_STEP_FAILED("phase-1 flush", "null"),
            { _noNotify: true },
        );
    });

    it("lifecycle emails rejecting with an Error are logged and the transporter still closes", async () => {
        const deps = base([], {
            lifecycleSettled: vi.fn(async () => {
                throw new Error("smtp timeout");
            }),
        });
        await postCloseTeardown(deps as never);
        expect(deps.logger.warning).toHaveBeenCalledWith(
            serverMessages.SHUTDOWN_STEP_FAILED("waiting for the shutdown emails", "smtp timeout"),
            { _noNotify: true },
        );
        expect(deps.sharedTransporter.closeTransporter).toHaveBeenCalled();
        expect(deps.logger.notice).toHaveBeenCalledWith("All resources cleaned up.");
    });

    it("lifecycle emails throwing a non-Error synchronously are stringified and tolerated", async () => {
        const deps = base([], {
            lifecycleSettled: vi.fn(() => {
                throw 42;
            }),
        });
        await postCloseTeardown(deps as never);
        expect(deps.logger.warning).toHaveBeenCalledWith(
            serverMessages.SHUTDOWN_STEP_FAILED("waiting for the shutdown emails", "42"),
            { _noNotify: true },
        );
        expect(deps.sharedTransporter.closeTransporter).toHaveBeenCalled();
    });

    it("a marker callback throwing a non-Error is stringified and the emails + transporter still run", async () => {
        const lifecycleSettled = vi.fn(async () => undefined);
        const deps = base([], {
            onDataTeardownComplete: () => {
                throw undefined;
            },
            lifecycleSettled,
        });
        await postCloseTeardown(deps as never);
        expect(deps.logger.warning).toHaveBeenCalledWith(
            serverMessages.SHUTDOWN_STEP_FAILED("marking the stop as clean", "undefined"),
            { _noNotify: true },
        );
        expect(lifecycleSettled).toHaveBeenCalledTimes(1);
        expect(deps.sharedTransporter.closeTransporter).toHaveBeenCalled();
    });

    it("on a cleanup failure the lifecycle emails and final notifier flush still run from the catch path", async () => {
        const lifecycleSettled = vi.fn(async () => undefined);
        const alertNotifier = { flushForShutdown: vi.fn(async () => undefined), drainAndStop: vi.fn(async () => undefined) };
        const onDataTeardownComplete = vi.fn();
        const deps = base([], {
            db: {
                closeAll: vi.fn(async () => {
                    throw new Error("ORA-12514");
                }),
            },
            lifecycleSettled,
            alertNotifier,
            onDataTeardownComplete,
            finalNotifyMs: () => 250,
        });
        await expect(postCloseTeardown(deps as never)).resolves.toBeUndefined();
        expect(deps.logger.error).toHaveBeenCalledWith("Error during shutdown cleanup", { error: "ORA-12514" });
        expect(onDataTeardownComplete).not.toHaveBeenCalled(); // pools never confirmed closed
        expect(lifecycleSettled).toHaveBeenCalledTimes(1);
        expect(alertNotifier.drainAndStop).toHaveBeenCalledWith({ timeoutMs: 250, persist: false });
        expect(deps.sharedTransporter.closeTransporter).not.toHaveBeenCalled();
    });
});

// ─── preCloseTeardown ─────────────────────────────────────────────────────────

describe("preCloseTeardown — server capability and grace fallbacks", () => {
    it("legacy sseDrainGraceMs is honoured when forceCloseAfterMs is absent", async () => {
        vi.useFakeTimers();
        const server = fakeServer();
        preCloseTeardown({ sseRegistry: { endAll: vi.fn() }, server: server as never, sseDrainGraceMs: 200, logger: quietLogger() });
        await vi.advanceTimersByTimeAsync(199);
        expect(server.closeAllConnections).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
    });

    it("without a tracker the handle's shortenTo is an inert no-op: the fixed grace still governs the close", async () => {
        vi.useFakeTimers();
        const server = fakeServer();
        const handle = preCloseTeardown({
            sseRegistry: { endAll: vi.fn() },
            server: server as never,
            forceCloseAfterMs: 300,
            logger: quietLogger(),
        });
        expect(() => handle.shortenTo(0)).not.toThrow();
        await vi.advanceTimersByTimeAsync(299);
        expect(server.closeAllConnections).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
        expect(handle.idleCuts).toEqual([]);
    });

    it("with neither grace option the force-close fires on the next tick (0 ms)", async () => {
        vi.useFakeTimers();
        const server = fakeServer();
        const endAll = vi.fn();
        preCloseTeardown({ sseRegistry: { endAll }, server: server as never, logger: quietLogger() });
        expect(endAll).toHaveBeenCalledWith("server_shutdown");
        await vi.advanceTimersByTimeAsync(0);
        expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
    });

    it("a server without closeIdleConnections/closeAllConnections (Node < 18.2) never throws", async () => {
        vi.useFakeTimers();
        const endAll = vi.fn();
        let count = 1;
        let onFinish: () => void = () => undefined;
        expect(() =>
            preCloseTeardown({
                sseRegistry: { endAll },
                server: {} as never,
                forceCloseAfterMs: 100,
                minGraceMs: 0,
                logger: quietLogger(),
                reason: "custom",
                httpInFlight: { activeCount: () => count, beginShutdown: (cb: () => void) => void (onFinish = cb) },
                waitNoticeMs: 0,
            }),
        ).not.toThrow();
        expect(endAll).toHaveBeenCalledWith("custom");
        count = 0;
        expect(() => onFinish()).not.toThrow();
        await expect(vi.advanceTimersByTimeAsync(200)).resolves.not.toThrow();
    });
});

describe("preCloseTeardown — in-flight tracker branches", () => {
    const run = (over: Record<string, unknown>) => {
        const server = fakeServer();
        const logger = quietLogger();
        const handle = preCloseTeardown({
            sseRegistry: { endAll: vi.fn() },
            server: server as never,
            forceCloseAfterMs: 1000,
            minGraceMs: 0,
            logger,
            waitNoticeMs: 0,
            ...over,
        } as never);
        return { server, logger, handle };
    };

    it("a finished response that is NOT the last one keeps waiting (no early close)", async () => {
        vi.useFakeTimers();
        let count = 2;
        let onFinish: () => void = () => undefined;
        const { server, logger } = run({
            httpInFlight: { activeCount: () => count, beginShutdown: (cb: () => void) => void (onFinish = cb) },
        });
        const idleBefore = server.closeIdleConnections.mock.calls.length;
        count = 1;
        onFinish();
        expect(server.closeIdleConnections.mock.calls.length).toBe(idleBefore + 1); // its socket dropped
        await vi.advanceTimersByTimeAsync(10);
        expect(server.closeAllConnections).not.toHaveBeenCalled();
        expect(logger.notice).not.toHaveBeenCalledWith(expect.stringContaining("every in-flight request finished"));
    });

    it("finishing before the cap clears the periodic notice timer — no further 'still waiting' notices", async () => {
        vi.useFakeTimers();
        let count = 1;
        let onFinish: () => void = () => undefined;
        const { server, logger } = run({
            httpInFlight: { activeCount: () => count, beginShutdown: (cb: () => void) => void (onFinish = cb) },
            waitNoticeMs: 100,
        });
        await vi.advanceTimersByTimeAsync(250);
        const waiting = () => logger.notice.mock.calls.filter(([m]) => String(m).includes("still waiting")).length;
        expect(waiting()).toBe(2);
        count = 0;
        onFinish();
        await vi.advanceTimersByTimeAsync(5000);
        expect(waiting()).toBe(2);
        expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
        expect(logger.notice).toHaveBeenCalledWith(expect.stringContaining("every in-flight request finished"));
    });

    it("a throwing activeSummary inside the waiting notice never breaks the wait", async () => {
        vi.useFakeTimers();
        const { server } = run({
            httpInFlight: {
                activeCount: () => 1,
                beginShutdown: vi.fn(),
                activeSummary: (n?: number) => {
                    if (n === 3) throw new Error("summary broke");
                    return [];
                },
            },
            waitNoticeMs: 100,
        });
        await expect(vi.advanceTimersByTimeAsync(500)).resolves.not.toThrow();
        await vi.advanceTimersByTimeAsync(600);
        expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
    });

    it("cap reached with zero still running (tracker drained without a callback): closes without a cut warning", async () => {
        vi.useFakeTimers();
        let count = 1;
        const onRequestsCut = vi.fn();
        const { server, logger } = run({
            httpInFlight: { activeCount: () => count, beginShutdown: vi.fn() },
            onRequestsCut,
        });
        count = 0;
        await vi.advanceTimersByTimeAsync(1000);
        expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
        expect(onRequestsCut).not.toHaveBeenCalled();
        expect(logger.warning).not.toHaveBeenCalled();
    });

    it("cap cut with a tracker lacking activeSummary passes an empty summary to the hook", async () => {
        vi.useFakeTimers();
        const onRequestsCut = vi.fn();
        const { logger } = run({
            httpInFlight: { activeCount: () => 3, beginShutdown: vi.fn() },
            onRequestsCut,
        });
        await vi.advanceTimersByTimeAsync(1000);
        expect(logger.warning).toHaveBeenCalledWith(serverMessages.SHUTDOWN_REQUESTS_CUT(3, 1000));
        expect(onRequestsCut).toHaveBeenCalledWith([], 1000, 3, { reason: "cap" });
    });

    it("cap cut without an onRequestsCut hook only warns and closes", async () => {
        vi.useFakeTimers();
        const { server, logger } = run({ httpInFlight: { activeCount: () => 1, beginShutdown: vi.fn() } });
        await vi.advanceTimersByTimeAsync(1000);
        expect(logger.warning).toHaveBeenCalledWith(serverMessages.SHUTDOWN_REQUESTS_CUT(1, 1000));
        expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
    });

    it("a throwing cut hook at the cap is logged and the sockets still close", async () => {
        vi.useFakeTimers();
        const { server, logger } = run({
            httpInFlight: { activeCount: () => 1, beginShutdown: vi.fn(), activeSummary: () => [] },
            onRequestsCut: () => {
                throw new Error("mailer down");
            },
        });
        await vi.advanceTimersByTimeAsync(1000);
        expect(logger.warning).toHaveBeenCalledWith(serverMessages.SHUTDOWN_CUT_HOOK_FAILED("mailer down"));
        expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
    });

    it("idle cuts with no hook are still counted in a warning when the wait ends", async () => {
        vi.useFakeTimers();
        let count = 1;
        let onFinish: () => void = () => undefined;
        const { handle, logger } = run({
            httpInFlight: { activeCount: () => count, beginShutdown: (cb: () => void) => void (onFinish = cb) },
        });
        handle.recordIdleCut({ method: "POST", path: "/a", ageMs: 1 });
        handle.recordIdleCut({ method: "GET", path: "/b", ageMs: 2 });
        count = 0;
        onFinish();
        expect(logger.warning).toHaveBeenCalledWith(serverMessages.SHUTDOWN_IDLE_CUTS(2));
        expect(handle.idleCuts).toHaveLength(2);
    });

    it("a throwing hook while reporting idle cuts is logged, not propagated", async () => {
        vi.useFakeTimers();
        const { handle, logger, server } = run({
            httpInFlight: { activeCount: () => 1, beginShutdown: vi.fn() },
            onRequestsCut: (_s: unknown, _g: unknown, _t: unknown, opts: { reason: string }) => {
                if (opts.reason === "idle") throw new Error("idle hook broke");
            },
        });
        handle.recordIdleCut({ method: "GET", path: "/x", ageMs: 9, idleMs: 9 });
        await vi.advanceTimersByTimeAsync(1000);
        expect(logger.warning).toHaveBeenCalledWith(serverMessages.SHUTDOWN_CUT_HOOK_FAILED("idle hook broke"));
        expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
    });

    it("idle cuts are capped at 20 entries in the hook payload but the total is reported", async () => {
        vi.useFakeTimers();
        const onRequestsCut = vi.fn();
        let count = 1;
        let onFinish: () => void = () => undefined;
        const { handle } = run({
            httpInFlight: { activeCount: () => count, beginShutdown: (cb: () => void) => void (onFinish = cb) },
            onRequestsCut,
        });
        for (let i = 0; i < 25; i++) handle.recordIdleCut({ method: "GET", path: `/r${i}`, ageMs: i });
        count = 0;
        onFinish();
        const [summary, , total, opts] = onRequestsCut.mock.calls[0];
        expect(summary).toHaveLength(20);
        expect(total).toBe(25);
        expect(opts).toEqual({ reason: "idle" });
    });

    it("shortenTo after the wait already finished is a no-op", async () => {
        vi.useFakeTimers();
        let count = 1;
        let onFinish: () => void = () => undefined;
        const { handle, server } = run({
            httpInFlight: { activeCount: () => count, beginShutdown: (cb: () => void) => void (onFinish = cb) },
        });
        count = 0;
        onFinish();
        await vi.advanceTimersByTimeAsync(1);
        expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
        handle.shortenTo(0);
        await vi.advanceTimersByTimeAsync(2000);
        expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
    });

    it("shortenTo can only pull the deadline in, never push it out", async () => {
        vi.useFakeTimers();
        const { handle, server } = run({ httpInFlight: { activeCount: () => 1, beginShutdown: vi.fn() } });
        await vi.advanceTimersByTimeAsync(400);
        handle.shortenTo(60_000); // asks for MORE time than the 600 ms left
        await vi.advanceTimersByTimeAsync(600);
        expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
    });

    it("the last request finishing synchronously inside beginShutdown: cut timer, notices and shortenTo are inert", async () => {
        vi.useFakeTimers();
        let count = 1;
        const onRequestsCut = vi.fn();
        const { handle, server, logger } = run({
            httpInFlight: {
                activeCount: () => count,
                beginShutdown: (cb: () => void) => {
                    count = 0; // drained between activeCount() and beginShutdown()
                    cb();
                },
            },
            onRequestsCut,
            waitNoticeMs: 100,
        });
        handle.shortenTo(0);
        await vi.advanceTimersByTimeAsync(2000);
        expect(server.closeAllConnections).toHaveBeenCalledTimes(1); // only finish's close
        expect(onRequestsCut).not.toHaveBeenCalled();
        expect(logger.warning).not.toHaveBeenCalled();
        expect(logger.notice.mock.calls.filter(([m]) => String(m).includes("still waiting"))).toHaveLength(0);
    });
});
