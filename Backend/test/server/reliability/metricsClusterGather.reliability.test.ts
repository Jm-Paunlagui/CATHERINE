import MetricsService from "../../../src/services/MetricsService";
import { metricsStore } from "../../../src/middleware/metrics";
import { logger } from "../../../src/utils/logger";
import { clusterRpc, ClusterRpcError } from "../../../src/utils/cluster/ClusterRpcClient";
import { CLUSTER_RPC_ERROR_CODES as E, CLUSTER_RPC_TIMEOUTS, CLUSTER_RPC_LIMITS, CLUSTER_RPC_METHODS } from "../../../src/constants/clusterIpc";

const MB = 1024 * 1024;
const localSnap = (): any => ({
    uptime: 1, red: {}, totals: {},
    system: { memory: { heapUsed: MB, heapTotal: 2 * MB, heapSizeLimit: 100 * MB }, eventLoopLag: 0 },
    dependencies: { oracle: {}, smtp: { status: "up", consecutiveFailures: 0 } },
});
const workerPart = (workerId: number) => ({ workerId, pid: 10 + workerId, isLeader: workerId === 1, value: { snapshot: localSnap(), extras: {} } });

/** The service keeps a static share + log throttle; each case starts at a strictly later clock. */
let clockBase = Date.now();

describe("MetricsService cluster gather reliability", () => {
    let call: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
        vi.useFakeTimers();
        clockBase += 10 * CLUSTER_RPC_LIMITS.REJECT_LOG_GAP_MS;
        vi.setSystemTime(clockBase);
        vi.spyOn(clusterRpc, "active", "get").mockReturnValue(true);
        call = vi.spyOn(clusterRpc, "call");
        vi.spyOn(metricsStore, "getSnapshot").mockReturnValue(localSnap());
        vi.spyOn(logger, "warning").mockImplementation((() => undefined) as any);
    });
    afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

    it("merges every worker's part into one cluster snapshot", async () => {
        call.mockResolvedValue({ parts: [workerPart(1), workerPart(2)], missing: [] });
        const merged: any = await MetricsService.getClusterSnapshot();
        expect(merged.cluster).toEqual({ workers: 2, responded: 2, missing: [] });
        expect(call).toHaveBeenCalledWith("all", CLUSTER_RPC_METHODS.METRICS_SNAPSHOT, {}, { timeoutMs: CLUSTER_RPC_TIMEOUTS.METRICS_CLIENT_MS });
        expect(logger.warning).not.toHaveBeenCalled();
    });

    it("concurrent callers share one gather within the share window", async () => {
        call.mockResolvedValue({ parts: [workerPart(1)], missing: [] });
        const [a, b] = await Promise.all([MetricsService.getClusterSnapshot(), MetricsService.getClusterSnapshot()]);
        expect(a).toBe(b);
        expect(call).toHaveBeenCalledTimes(1);
        // after the window a fresh gather happens
        vi.setSystemTime(Date.now() + CLUSTER_RPC_TIMEOUTS.METRICS_SHARE_MS);
        await MetricsService.getClusterSnapshot();
        expect(call).toHaveBeenCalledTimes(2);
    });

    it("a silent primary degrades to this worker's own snapshot, flagged degraded, instead of failing the scrape", async () => {
        call.mockRejectedValue(new ClusterRpcError(E.TIMEOUT, "metrics.snapshot timed out"));
        const snap: any = await MetricsService.getClusterSnapshot();
        expect(snap.cluster).toEqual({ workers: 1, responded: 1, missing: [], degraded: true });
        expect(snap.uptime).toBe(1);
    });

    it("a gather with no usable part also degrades", async () => {
        call.mockResolvedValue({ parts: [{ junk: true }], missing: [2] });
        const snap: any = await MetricsService.getClusterSnapshot();
        expect(snap.cluster.degraded).toBe(true);
    });

    it("a malformed reply (no parts array) degrades rather than throwing", async () => {
        call.mockResolvedValue("garbage");
        const snap: any = await MetricsService.getClusterSnapshot();
        expect(snap.cluster.degraded).toBe(true);
    });

    it("a partial gather is served and logged once per throttle window", async () => {
        call.mockResolvedValue({ parts: [workerPart(1)], missing: [2] });
        const first: any = await MetricsService.getClusterSnapshot();
        expect(first.cluster.missing).toEqual([2]);
        expect(first.cluster.workers).toBe(2);
        expect(logger.warning).toHaveBeenCalledTimes(1);
        vi.setSystemTime(Date.now() + CLUSTER_RPC_TIMEOUTS.METRICS_SHARE_MS);
        await MetricsService.getClusterSnapshot();
        expect(logger.warning).toHaveBeenCalledTimes(1); // throttled
        vi.setSystemTime(Date.now() + CLUSTER_RPC_LIMITS.REJECT_LOG_GAP_MS);
        await MetricsService.getClusterSnapshot();
        expect(logger.warning).toHaveBeenCalledTimes(2);
    });

    it("a partial gather holds every alert rule so a missing worker is never read as recovery", async () => {
        call.mockResolvedValue({ parts: [workerPart(1)], missing: [2] });
        const snap: any = await MetricsService.getClusterSnapshot();
        expect(MetricsService.evaluateAlertHolds(snap)).toContain("*");
    });

    it("a degraded snapshot also holds every alert rule", async () => {
        call.mockRejectedValue(new Error("ipc down"));
        const snap: any = await MetricsService.getClusterSnapshot();
        expect(MetricsService.evaluateAlertHolds(snap)).toContain("*");
    });
});
