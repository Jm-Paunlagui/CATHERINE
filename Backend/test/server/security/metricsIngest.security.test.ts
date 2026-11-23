import MetricsService from "../../../src/services/MetricsService";
import { metricsStore } from "../../../src/middleware/metrics";
import { logger } from "../../../src/utils/logger";

describe("MetricsService.ingestFrontendMetrics input hardening", () => {
    let vital: ReturnType<typeof vi.spyOn>;
    let error: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
        vital = vi.spyOn(metricsStore, "recordFrontendVital").mockImplementation((() => undefined) as any);
        error = vi.spyOn(metricsStore, "recordFrontendError").mockImplementation((() => undefined) as any);
        for (const m of ["notice", "info", "debug"] as const) vi.spyOn(logger, m).mockImplementation((() => undefined) as any);
    });
    afterEach(() => { vi.restoreAllMocks(); });

    const reject = async (payload: unknown) => {
        const err: any = await MetricsService.ingestFrontendMetrics(payload).then(() => null, (e) => e);
        expect(err).not.toBeNull();
        return err;
    };

    it.each([["an object", {}], ["a string", "x"], ["null", null], ["undefined", undefined], ["a number", 5]])("rejects %s with 400", async (_n, payload) => {
        expect((await reject(payload)).statusCode).toBe(400);
        expect(vital).not.toHaveBeenCalled();
    });

    it("rejects an empty batch", async () => {
        expect((await reject([])).statusCode).toBe(400);
    });

    it("rejects an oversized batch (51 events) before recording anything", async () => {
        const batch = Array.from({ length: 51 }, () => ({ type: "vital", name: "LCP", value: 1 }));
        expect((await reject(batch)).statusCode).toBe(400);
        expect(vital).not.toHaveBeenCalled();
    });

    it("accepts exactly 50 events", async () => {
        const batch = Array.from({ length: 50 }, () => ({ type: "vital", name: "LCP", value: 1 }));
        await MetricsService.ingestFrontendMetrics(batch);
        expect(vital).toHaveBeenCalledTimes(50);
    });

    it("truncates oversized names, messages and stacks (memory bound)", async () => {
        await MetricsService.ingestFrontendMetrics([
            { type: "vital", name: "N".repeat(5000), value: 1, rating: "good" },
            { type: "error", message: "M".repeat(5000), stack: "S".repeat(9000) },
        ]);
        expect(vital.mock.calls[0][0]).toHaveLength(200);
        expect(error.mock.calls[0][0]).toHaveLength(500);
        expect(error.mock.calls[0][1]).toHaveLength(2000);
    });

    it("coerces hostile values: non-numeric value -> 0, missing name -> UNKNOWN, missing rating -> unknown", async () => {
        await MetricsService.ingestFrontendMetrics([{ type: "vital", value: "<script>" }, { type: "vital", name: "CLS", value: Infinity, rating: null }]);
        expect(vital.mock.calls[0]).toEqual(["UNKNOWN", 0, "unknown", {}]);
        expect(vital.mock.calls[1][1]).toBe(Infinity);
        expect(vital.mock.calls[1][2]).toBe("unknown");
    });

    it("skips non-object items and unknown event types instead of failing the batch", async () => {
        await MetricsService.ingestFrontendMetrics([null, "str", 7, { type: "weird" }, { type: "vital", name: "FID", value: 3 }]);
        expect(vital).toHaveBeenCalledTimes(1);
        expect(error).not.toHaveBeenCalled();
    });

    it("an error event with no message or stack stores empty strings and an empty context", async () => {
        await MetricsService.ingestFrontendMetrics([{ type: "error" }]);
        expect(error).toHaveBeenCalledWith("", "", {});
    });

    it("passes a client context through as data only", async () => {
        await MetricsService.ingestFrontendMetrics([{ type: "error", message: "m", context: { url: "/x" } }]);
        expect(error.mock.calls[0][2]).toEqual({ url: "/x" });
    });
});
