/**
 * @fileoverview Reliability: HealthStreamHub under server drain, flapping pools
 * and abrupt client drops (heartbeat keeps flowing to survivors).
 */
import { EventEmitter } from "events";

const dbMock = vi.hoisted(() => ({
    setPoolHealthWatched: vi.fn(),
    onPoolHealthCheck: vi.fn(() => vi.fn()),
    onPoolHealthChange: vi.fn(() => vi.fn()),
}));
const evaluate = vi.hoisted(() => vi.fn());

vi.mock("../../../src/config", () => ({ default: dbMock }));
vi.mock("../../../src/services/ReadinessService", () => ({ evaluate }));

import hub from "../../../src/services/HealthStreamHub";
import SseConnectionRegistry from "../../../src/utils/sse/SseConnectionRegistry";

function fakeRes(failAfter = Infinity) {
    let n = 0;
    return {
        written: [] as string[],
        ended: false,
        setHeader: vi.fn(),
        flushHeaders: vi.fn(),
        write(c: string) {
            if (n++ >= failAfter) throw new Error("ECONNRESET");
            this.written.push(c);
            return true;
        },
        end() { this.ended = true; },
    } as any;
}
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe("HealthStreamHub reliability", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        evaluate.mockReset();
        evaluate.mockResolvedValue({ ready: true });
        hub._resetForTests();
    });
    afterEach(() => {
        hub._resetForTests();
        vi.useRealTimers();
    });

    it("a client that drops mid-stream is removed while survivors keep their heartbeat", async () => {
        const dying = fakeRes(3); // retry + status + 1 heartbeat, then dies
        const alive = fakeRes();
        hub.open(new EventEmitter() as any, dying, "1.1.1.1");
        hub.open(new EventEmitter() as any, alive, "2.2.2.2");
        await flush();
        await vi.advanceTimersByTimeAsync(15000);
        await vi.advanceTimersByTimeAsync(15000);
        expect(hub.size()).toBe(1);
        expect(hub._perIp.has("1.1.1.1")).toBe(false);
        const beats = alive.written.filter((w: string) => w.startsWith("event: heartbeat"));
        expect(beats.length).toBeGreaterThanOrEqual(2);
    });

    it("endAll sends a shutdown frame, ends sockets and unregisters every client", async () => {
        const a = fakeRes();
        const req = new EventEmitter() as any;
        hub.open(req, a, "1.1.1.1");
        await flush();
        SseConnectionRegistry.endAll("server_shutdown");
        expect(a.written.join("")).toContain("event: shutdown");
        expect(a.ended).toBe(true);
        expect(hub.size()).toBe(0);
        expect(dbMock.setPoolHealthWatched).toHaveBeenLastCalledWith(false);
        expect(SseConnectionRegistry.size()).toBe(0);
    });

    it("a flapping pool yields exactly one frame per verdict change", async () => {
        const a = fakeRes();
        hub.open(new EventEmitter() as any, a, "1.1.1.1");
        await flush();
        for (const ready of [false, false, true, true, false]) {
            evaluate.mockResolvedValue({ ready });
            hub._requestEvaluate();
            await flush();
        }
        const verdicts = a.written
            .filter((w: string) => w.startsWith("event: status"))
            .map((w: string) => JSON.parse(w.split("data: ")[1]).ready);
        expect(verdicts).toEqual([true, false, true, false]);
    });

    it("a reopen after everyone left starts from a clean verdict", async () => {
        evaluate.mockResolvedValue({ ready: false });
        const r1 = new EventEmitter() as any;
        hub.open(r1, fakeRes(), "1.1.1.1");
        await flush();
        r1.emit("close");
        expect(hub._last).toBeNull();
        const b = fakeRes();
        hub.open(new EventEmitter() as any, b, "1.1.1.1");
        expect(b.written.some((w: string) => w.startsWith("event: status"))).toBe(false);
    });
});
