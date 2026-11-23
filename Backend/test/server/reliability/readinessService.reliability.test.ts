/**
 * @fileoverview Reliability tests for ReadinessService: probe timeout, saturation
 * classification, breaker interaction and in-flight de-duplication. The DB
 * adapter is stubbed and time is faked; no sleeps, no real connections.
 */
import db from "../../../src/config";
import { POOL_NAMES, READINESS_GATING_POOLS } from "../../../src/config/database";
import { evaluate, probePool, HEALTH_PROBE_TIMEOUT_MS, _isSaturationError } from "../../../src/services/ReadinessService";

const anyDb = db as unknown as Record<string, any>;
const GATING = READINESS_GATING_POOLS[0];
const NON_GATING = POOL_NAMES.find((p) => !READINESS_GATING_POOLS.includes(p));

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("ReadinessService.probePool", () => {
    it("reports up with latency when the round trip succeeds and runs SELECT 1", async () => {
        const execute = vi.fn().mockResolvedValue({});
        vi.spyOn(anyDb, "withConnection").mockImplementation(async (_p: any, fn: any) => fn({ execute }));
        const r = await probePool(GATING);
        expect(r.status).toBe("up");
        expect(r.state).toBe("up");
        expect(typeof r.latencyMs).toBe("number");
        expect(execute).toHaveBeenCalledWith("SELECT 1 FROM DUAL");
    });

    it("bypasses the breaker so a probe can close it", async () => {
        const spy = vi.spyOn(anyDb, "withConnection").mockResolvedValue(undefined);
        await probePool(GATING);
        expect(spy.mock.calls[0][0]).toBe(GATING);
        expect(spy.mock.calls[0][2]).toEqual({ bypassBreaker: true });
    });

    it("times out a hung probe without waiting for it and swallows its later rejection", async () => {
        vi.useFakeTimers();
        let rejectProbe: (e: Error) => void = () => {};
        vi.spyOn(anyDb, "withConnection").mockReturnValue(new Promise((_r, rej) => (rejectProbe = rej)));
        const pending = probePool(GATING);
        await vi.advanceTimersByTimeAsync(HEALTH_PROBE_TIMEOUT_MS);
        expect(await pending).toEqual({ status: "down", state: "down", error: "probe timeout", latencyMs: HEALTH_PROBE_TIMEOUT_MS });
        // The loser rejecting afterwards must not become an unhandled rejection.
        rejectProbe(new Error("late"));
        await vi.advanceTimersByTimeAsync(0);
    });

    it("classifies NJS-076 as saturated and hides the raw error", async () => {
        vi.spyOn(anyDb, "withConnection").mockRejectedValue(new Error("NJS-076: queue full secret-host"));
        const r = await probePool(GATING);
        expect(r).toEqual({ status: "down", state: "saturated", error: "probe failed" });
    });

    it("classifies any other failure as down, including non-Error throws", async () => {
        const spy = vi.spyOn(anyDb, "withConnection").mockRejectedValue(new Error("ORA-12541"));
        expect((await probePool(GATING)).state).toBe("down");
        spy.mockImplementation(() => {
            throw "boom";
        });
        expect((await probePool(GATING)).state).toBe("down");
    });

    it("_isSaturationError handles empty input", () => {
        expect(_isSaturationError("")).toBe(false);
        expect(_isSaturationError(undefined as never)).toBe(false);
        expect(_isSaturationError("x NJS-076 y")).toBe(true);
    });
});

describe("ReadinessService.evaluate", () => {
    it("is ready when every pool is up and records probe success", async () => {
        vi.spyOn(anyDb, "withConnection").mockResolvedValue(undefined);
        const rec = vi.spyOn(anyDb, "recordProbeSuccess").mockImplementation(() => {});
        vi.spyOn(anyDb, "isPoolHealthy").mockReturnValue(true);
        const r = await evaluate();
        expect(r.ready).toBe(true);
        expect(Object.keys(r.checks)).toEqual(POOL_NAMES.map((p) => `oracle_${p}`));
        expect(rec).toHaveBeenCalledTimes(POOL_NAMES.length);
    });

    it("is not ready when a gating pool is down, and does not record success for it", async () => {
        vi.spyOn(anyDb, "withConnection").mockImplementation(async (p: any) => {
            if (p === GATING) throw new Error("ORA-03113");
        });
        const rec = vi.spyOn(anyDb, "recordProbeSuccess").mockImplementation(() => {});
        vi.spyOn(anyDb, "isPoolHealthy").mockReturnValue(true);
        const r = await evaluate();
        expect(r.ready).toBe(false);
        expect(rec).not.toHaveBeenCalledWith(GATING);
    });

    it("a saturated gating pool blocks readiness but a saturated non-gating pool does not", async () => {
        vi.spyOn(anyDb, "recordProbeSuccess").mockImplementation(() => {});
        vi.spyOn(anyDb, "isPoolHealthy").mockReturnValue(true);
        const spy = vi.spyOn(anyDb, "withConnection").mockImplementation(async (p: any) => {
            if (p === GATING) throw new Error("NJS-076");
        });
        expect((await evaluate()).ready).toBe(false);
        if (NON_GATING) {
            spy.mockImplementation(async (p: any) => {
                if (p === NON_GATING) throw new Error("NJS-076");
            });
            expect((await evaluate()).ready).toBe(true);
        }
    });

    it("an open breaker keeps the service not-ready even when the probe succeeds", async () => {
        vi.spyOn(anyDb, "withConnection").mockResolvedValue(undefined);
        vi.spyOn(anyDb, "recordProbeSuccess").mockImplementation(() => {});
        vi.spyOn(anyDb, "isPoolHealthy").mockImplementation((p: any) => p !== GATING);
        expect((await evaluate()).ready).toBe(false);
    });

    it("tolerates an adapter without breaker hooks", async () => {
        vi.spyOn(anyDb, "withConnection").mockResolvedValue(undefined);
        vi.spyOn(anyDb, "recordProbeSuccess", "get" as never).mockReturnValue(undefined as never);
        vi.spyOn(anyDb, "isPoolHealthy", "get" as never).mockReturnValue(undefined as never);
        expect((await evaluate()).ready).toBe(true);
    });

    it("concurrent callers share one in-flight evaluation, and the next call starts a new one", async () => {
        const spy = vi.spyOn(anyDb, "withConnection").mockResolvedValue(undefined);
        vi.spyOn(anyDb, "recordProbeSuccess").mockImplementation(() => {});
        vi.spyOn(anyDb, "isPoolHealthy").mockReturnValue(true);
        const [a, b] = await Promise.all([evaluate(), evaluate()]);
        expect(a).toBe(b);
        expect(spy).toHaveBeenCalledTimes(POOL_NAMES.length);
        await evaluate();
        expect(spy).toHaveBeenCalledTimes(POOL_NAMES.length * 2);
    });
});
