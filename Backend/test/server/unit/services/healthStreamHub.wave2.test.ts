/**
 * @fileoverview Unit tests for HealthStreamHub: admission caps, SSE framing,
 * verdict change detection, coalesced evaluation and teardown.
 */
import { EventEmitter } from "events";

const dbMock = vi.hoisted(() => ({
    setPoolHealthWatched: vi.fn(),
    onPoolHealthCheck: vi.fn(),
    onPoolHealthChange: vi.fn(),
}));
const evaluate = vi.hoisted(() => vi.fn());
const shuttingDown = vi.hoisted(() => vi.fn(() => false));

vi.mock("../../../../src/config", () => ({ default: dbMock }));
vi.mock("../../../../src/services/ReadinessService", () => ({ evaluate }));
vi.mock("../../../../src/utils/InFlightTaskRegistry", () => ({ default: { isShuttingDown: shuttingDown } }));

import hub, { HealthStreamHub } from "../../../../src/services/HealthStreamHub";
import SseConnectionRegistry from "../../../../src/utils/sse/SseConnectionRegistry";

function fakeRes(opts: { throwOnWrite?: boolean; flush?: boolean } = {}) {
    const res: any = {
        headers: {} as Record<string, string>,
        written: [] as string[],
        setHeader(k: string, v: string) { this.headers[k] = v; },
        flushHeaders: vi.fn(),
        write(chunk: string) {
            if (opts.throwOnWrite) throw new Error("EPIPE");
            this.written.push(chunk);
            return true;
        },
        end: vi.fn(),
    };
    if (opts.flush) res.flush = vi.fn();
    return res;
}
const fakeReq = () => new EventEmitter() as any;
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe("HealthStreamHub", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        evaluate.mockReset();
        evaluate.mockResolvedValue({ ready: true });
        shuttingDown.mockReturnValue(false);
        dbMock.setPoolHealthWatched.mockClear();
        dbMock.onPoolHealthCheck.mockReset();
        dbMock.onPoolHealthChange.mockReset();
        dbMock.onPoolHealthCheck.mockReturnValue(vi.fn());
        dbMock.onPoolHealthChange.mockReturnValue(vi.fn());
        hub._resetForTests();
        dbMock.setPoolHealthWatched.mockClear();
    });
    afterEach(() => {
        hub._resetForTests();
        vi.useRealTimers();
    });

    it("sets SSE headers, flushes and sends the retry hint on open", () => {
        const res = fakeRes({ flush: true });
        hub.open(fakeReq(), res, "1.1.1.1");
        expect(res.headers["Content-Type"]).toBe("text/event-stream");
        expect(res.headers["X-Accel-Buffering"]).toBe("no");
        expect(res.flushHeaders).toHaveBeenCalled();
        expect(res.written[0]).toBe("retry: 3000\n\n");
        expect(res.flush).toHaveBeenCalled();
        expect(hub.size()).toBe(1);
    });

    it("starts the shared loop once and publishes the first verdict", async () => {
        const a = fakeRes();
        const b = fakeRes();
        hub.open(fakeReq(), a, "1.1.1.1");
        hub.open(fakeReq(), b, "2.2.2.2");
        expect(dbMock.setPoolHealthWatched).toHaveBeenCalledTimes(1);
        expect(dbMock.setPoolHealthWatched).toHaveBeenCalledWith(true);
        await flush();
        const frame = 'event: status\ndata: {"ready":true,"cause":null}\n\n';
        expect(a.written).toContain(frame);
        expect(b.written).toContain(frame);
    });

    it("replays the last verdict to a late joiner and does not rebroadcast an unchanged verdict", async () => {
        const a = fakeRes();
        hub.open(fakeReq(), a, "1.1.1.1");
        await flush();
        const b = fakeRes();
        hub.open(fakeReq(), b, "2.2.2.2");
        expect(b.written.some((w: string) => w.startsWith("event: status"))).toBe(true);
        await flush();
        const statusFramesA = a.written.filter((w: string) => w.startsWith("event: status"));
        expect(statusFramesA).toHaveLength(1);
    });

    it("broadcasts cause=database when readiness flips to false", async () => {
        const a = fakeRes();
        hub.open(fakeReq(), a, "1.1.1.1");
        await flush();
        evaluate.mockResolvedValue({ ready: false });
        hub._requestEvaluate();
        await flush();
        expect(a.written.at(-1)).toBe('event: status\ndata: {"ready":false,"cause":"database"}\n\n');
    });

    it("coalesces evaluation requests: one running, one queued", async () => {
        let release!: (v: { ready: boolean }) => void;
        evaluate.mockReturnValueOnce(new Promise((r) => { release = r; }));
        hub.open(fakeReq(), fakeRes(), "1.1.1.1");
        hub._requestEvaluate();
        hub._requestEvaluate();
        expect(evaluate).toHaveBeenCalledTimes(1);
        expect(hub._pending).toBe(true);
        release({ ready: true });
        await flush();
        expect(evaluate).toHaveBeenCalledTimes(2);
        expect(hub._pending).toBe(false);
    });

    it("logs and survives a failing evaluation", async () => {
        evaluate.mockRejectedValueOnce(new Error("probe exploded"));
        const a = fakeRes();
        hub.open(fakeReq(), a, "1.1.1.1");
        await flush();
        expect(hub._evaluating).toBe(false);
        expect(a.written.some((w: string) => w.startsWith("event: status"))).toBe(false);
    });

    it("does not evaluate with zero clients or while the server is draining", async () => {
        hub._requestEvaluate();
        expect(evaluate).not.toHaveBeenCalled();
        shuttingDown.mockReturnValue(true);
        hub.open(fakeReq(), fakeRes(), "1.1.1.1");
        await flush();
        expect(evaluate).not.toHaveBeenCalled();
    });

    it("pool check events only re-evaluate when they contradict the last verdict", async () => {
        hub.open(fakeReq(), fakeRes(), "1.1.1.1");
        await flush();
        const onCheck = dbMock.onPoolHealthCheck.mock.calls[0][0];
        evaluate.mockClear();
        onCheck({ ok: true }); // agrees with ready:true
        expect(evaluate).not.toHaveBeenCalled();
        onCheck({ ok: false }); // contradicts
        expect(evaluate).toHaveBeenCalledTimes(1);
        await flush();
    });

    it("a check event with no known verdict triggers evaluation; pool change always does", async () => {
        let release!: (v: { ready: boolean }) => void;
        evaluate.mockReturnValueOnce(new Promise((r) => { release = r; }));
        hub.open(fakeReq(), fakeRes(), "1.1.1.1");
        expect(hub._last).toBeNull();
        const onCheck = dbMock.onPoolHealthCheck.mock.calls[0][0];
        const onChange = dbMock.onPoolHealthChange.mock.calls[0][0];
        onCheck({ ok: true });
        onChange();
        expect(hub._pending).toBe(true);
        release({ ready: true });
        await flush();
    });

    it("works when the db exposes no health hooks", async () => {
        const saved = { ...dbMock };
        delete (dbMock as any).setPoolHealthWatched;
        delete (dbMock as any).onPoolHealthCheck;
        delete (dbMock as any).onPoolHealthChange;
        try {
            const a = fakeRes();
            hub.open(fakeReq(), a, "1.1.1.1");
            await flush();
            expect(a.written.some((w: string) => w.startsWith("event: status"))).toBe(true);
            hub._resetForTests();
        } finally {
            Object.assign(dbMock, saved);
        }
    });

    it("heartbeats and safety-evaluates on their timers", async () => {
        const a = fakeRes();
        hub.open(fakeReq(), a, "1.1.1.1");
        await flush();
        evaluate.mockClear();
        await vi.advanceTimersByTimeAsync(15000);
        expect(a.written.some((w: string) => w.startsWith("event: heartbeat\ndata: {\"t\":"))).toBe(true);
        await vi.advanceTimersByTimeAsync(15000);
        expect(evaluate).toHaveBeenCalled();
    });

    it("close tears down: per-IP count, loop stop, unsubscribe, last verdict reset", async () => {
        const unsubCheck = vi.fn(() => { throw new Error("gone"); });
        const unsubChange = vi.fn();
        dbMock.onPoolHealthCheck.mockReturnValue(unsubCheck);
        dbMock.onPoolHealthChange.mockReturnValue(unsubChange);
        const r1 = fakeReq();
        const r2 = fakeReq();
        const a = fakeRes();
        const b = fakeRes();
        hub.open(r1, a, "1.1.1.1");
        hub.open(r2, b, "1.1.1.1");
        await flush();
        r1.emit("close");
        expect(hub.size()).toBe(1);
        expect(hub._perIp.get("1.1.1.1")).toBe(1);
        expect(dbMock.setPoolHealthWatched).not.toHaveBeenCalledWith(false);
        r2.emit("close");
        r2.emit("close"); // idempotent
        expect(hub.size()).toBe(0);
        expect(hub._perIp.has("1.1.1.1")).toBe(false);
        expect(dbMock.setPoolHealthWatched).toHaveBeenCalledWith(false);
        expect(unsubCheck).toHaveBeenCalledTimes(1);
        expect(unsubChange).toHaveBeenCalledTimes(1);
        expect(hub._last).toBeNull();
        expect(hub._heartbeat).toBeNull();
        expect(SseConnectionRegistry.size()).toBe(0);
    });

    it("_remove ignores an unknown response", () => {
        expect(() => hub._remove(fakeRes())).not.toThrow();
    });

    it("a dead socket is torn down instead of throwing", () => {
        const dead = fakeRes({ throwOnWrite: true });
        expect(() => hub.open(fakeReq(), dead, "9.9.9.9")).not.toThrow();
        // retry write failed before registration, so the client is still registered; a later write drops it
        hub._broadcast("heartbeat", { t: 1 });
        expect(hub.size()).toBe(0);
    });

    it("canAccept enforces the per-IP and global caps", () => {
        const small = new HealthStreamHub();
        expect(small.canAccept("x")).toBe(true);
        for (let i = 0; i < 50; i++) small._perIp.set("x", (small._perIp.get("x") ?? 0) + 1);
        expect(small.canAccept("x")).toBe(false);
        expect(small.canAccept("y")).toBe(true);
        for (let i = 0; i < 2000; i++) small._clients.set({} as any, { ip: "z" + i, teardown: () => {} });
        expect(small.canAccept("fresh")).toBe(false);
    });

    it("exposes tuning constants on the singleton", () => {
        expect(hub.HEALTH_STREAM_HEARTBEAT_MS).toBe(15000);
        expect(hub.HEALTH_STREAM_RETRY_MS).toBe(3000);
        expect(hub.HEALTH_STREAM_MAX_PER_IP).toBe(50);
        expect(hub.HealthStreamHub).toBe(HealthStreamHub);
    });

    it("payload carries only ready and cause (no pool names or codes)", async () => {
        evaluate.mockResolvedValue({ ready: false, pools: { appDb: { error: "ORA-12541 host db01" } } });
        const a = fakeRes();
        hub.open(fakeReq(), a, "1.1.1.1");
        await flush();
        const all = a.written.join("");
        expect(all).not.toMatch(/ORA-|db01|appDb/);
    });
});
