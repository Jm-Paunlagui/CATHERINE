import { WatchdogBurstDetector } from "../../../../src/utils/progress/WatchdogBurstDetector";

const cut = (path = "/api/v1/a", lastSource = "db-call") => ({ method: "GET", path, lastSource });

type BurstMeta = { watchdogBurst: { count: number; more: number; topRoutes: Array<[string, number]>; topSources: Array<[string, number]> } };
const burstOf = (meta: unknown) => (meta as BurstMeta).watchdogBurst;

describe("WatchdogBurstDetector", () => {
    let clock: number;
    let emit: ReturnType<typeof vi.fn<(message: string, meta: Record<string, unknown>) => void>>;
    const make = (over: { burst?: number; windowMs?: number } = {}) =>
        new WatchdogBurstDetector({ burst: 3, windowMs: 10_000, now: () => clock, emit, ...over });

    beforeEach(() => {
        clock = 1_000_000;
        emit = vi.fn<(message: string, meta: Record<string, unknown>) => void>();
    });

    it("emits nothing below the threshold", () => {
        const d = make();
        expect(d.record(cut())).toBe(false);
        expect(d.record(cut())).toBe(false);
        expect(emit).not.toHaveBeenCalled();
    });

    it("emits exactly one alert when the burst size is reached", () => {
        const d = make();
        d.record(cut());
        d.record(cut());
        expect(d.record(cut())).toBe(true);
        expect(emit).toHaveBeenCalledTimes(1);
        const [message, meta] = emit.mock.calls[0];
        expect(message).toContain("WATCHDOG_BURST_ALERT");
        expect(burstOf(meta).count).toBe(3);
        expect(burstOf(meta).more).toBe(0);
    });

    it("does not re-alert during the cooldown and reports the extra cuts afterwards", () => {
        const d = make();
        for (let i = 0; i < 3; i++) d.record(cut());
        for (let i = 0; i < 5; i++) {
            clock += 100;
            expect(d.record(cut())).toBe(false);
        }
        expect(emit).toHaveBeenCalledTimes(1);

        clock += 10_000;
        d.record(cut());
        d.record(cut());
        expect(d.record(cut())).toBe(true);
        expect(emit).toHaveBeenCalledTimes(2);
        expect(burstOf(emit.mock.calls[1][1]).more).toBe(5);
        expect(emit.mock.calls[1][0]).toContain("5 more cut(s)");
    });

    it("does not count cuts that fell outside the sliding window", () => {
        const d = make();
        d.record(cut());
        d.record(cut());
        clock += 10_000;
        expect(d.record(cut())).toBe(false);
        expect(emit).not.toHaveBeenCalled();
    });

    it("lists top routes and sources by frequency", () => {
        const d = make();
        d.record(cut("/x", "db-call"));
        d.record(cut("/x", "db-call"));
        d.record(cut("/y", "socket-io"));
        const meta = burstOf(emit.mock.calls[0][1]);
        expect(meta.topRoutes[0]).toEqual(["GET /x", 2]);
        expect(meta.topSources[0]).toEqual(["db-call", 2]);
    });

    it("is disabled when burst is 0", () => {
        const d = make({ burst: 0 });
        for (let i = 0; i < 10; i++) expect(d.record(cut())).toBe(false);
        expect(emit).not.toHaveBeenCalled();
    });

    it("never throws when the emitter throws", () => {
        const d = new WatchdogBurstDetector({
            burst: 1,
            windowMs: 10_000,
            now: () => clock,
            emit: () => {
                throw new Error("boom");
            },
        });
        expect(() => d.record(cut())).not.toThrow();
        expect(d.record(cut())).toBe(false);
    });

    it("reset forgets all state", () => {
        const d = make();
        for (let i = 0; i < 3; i++) d.record(cut());
        d.reset();
        clock += 1;
        d.record(cut());
        d.record(cut());
        expect(emit).toHaveBeenCalledTimes(1);
        expect(d.record(cut())).toBe(true);
        expect(emit).toHaveBeenCalledTimes(2);
    });

    describe("resolveConfig", () => {
        it("uses defaults for missing or invalid values", () => {
            expect(WatchdogBurstDetector.resolveConfig({} as NodeJS.ProcessEnv)).toEqual({ burst: 3, windowMs: 600_000 });
            expect(
                WatchdogBurstDetector.resolveConfig({ WATCHDOG_ALERT_BURST: "-1", WATCHDOG_ALERT_WINDOW_MS: "5" } as unknown as NodeJS.ProcessEnv),
            ).toEqual({ burst: 3, windowMs: 600_000 });
        });
        it("accepts valid values including burst 0", () => {
            expect(
                WatchdogBurstDetector.resolveConfig({ WATCHDOG_ALERT_BURST: "0", WATCHDOG_ALERT_WINDOW_MS: "5000" } as unknown as NodeJS.ProcessEnv),
            ).toEqual({ burst: 0, windowMs: 5000 });
        });
    });
});
