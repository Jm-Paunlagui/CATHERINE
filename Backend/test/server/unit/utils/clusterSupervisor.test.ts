import { ClusterSupervisor } from "../../../../src/utils/cluster/ClusterSupervisor";
import { ClusterRpcHub } from "../../../../src/utils/cluster/ClusterRpcHub";
import { CLUSTER_IPC } from "../../../../src/constants/clusterIpc";
import { makeSupervisorDeps } from "../../helpers/fakeCluster";

const flush = async () => { await vi.advanceTimersByTimeAsync(0); };

describe("ClusterSupervisor", () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    describe("start / election", () => {
        it("forks N workers, worker 1 is the cron leader, and stamps the run id", () => {
            const { deps, cluster, logger } = makeSupervisorDeps();
            const sup = new ClusterSupervisor(deps);
            sup.start();
            expect(cluster.workers).toHaveLength(3);
            expect(cluster.forkEnvs.map((e: any) => e.CRON_LEADER)).toEqual(["true", "false", "false"]);
            expect(cluster.forkEnvs.every((e: any) => Object.values(e).includes("run-1"))).toBe(true);
            expect(sup.liveCount).toBe(3);
            expect(sup.getLeader()).toBe(cluster.workers[0]);
            expect(sup.getLiveWorkers()).toHaveLength(3);
            expect(logger.critical).not.toHaveBeenCalled();
        });

        it("start is idempotent", () => {
            const { deps, cluster } = makeSupervisorDeps();
            const sup = new ClusterSupervisor(deps);
            sup.start();
            sup.start();
            expect(cluster.workers).toHaveLength(3);
        });

        it("announces shared state when a hub is injected, per-worker limits otherwise", () => {
            const a = makeSupervisorDeps();
            new ClusterSupervisor(a.deps).start();
            expect(a.logger.notice.mock.calls.map((c) => c[0]).join("\n")).toContain("CLUSTER_PER_WORKER_LIMITS");

            const b = makeSupervisorDeps();
            const hub = new ClusterRpcHub({ logger: b.logger, getLiveWorkers: () => [], getLeader: () => null });
            new ClusterSupervisor({ ...b.deps, rpcHub: hub }).start();
            expect(b.logger.notice.mock.calls.map((c) => c[0]).join("\n")).toContain("CLUSTER_SHARED_STATE_READY");
        });

        it("single worker cluster still elects exactly one leader", () => {
            const { deps, cluster } = makeSupervisorDeps({ numWorkers: 1 });
            const sup = new ClusterSupervisor(deps);
            sup.start();
            expect(cluster.workers).toHaveLength(1);
            expect(sup.getLeader()).toBe(cluster.workers[0]);
        });

        it("a broken election verdict (zero leaders) logs critical and emails", () => {
            const { deps, logger, notifyCritical } = makeSupervisorDeps({
                clusterRole: { cronLeaderEnv: () => "false", electionHealth: () => ({ leaderCount: 0, severity: "critical" }) },
            });
            const sup = new ClusterSupervisor(deps);
            sup.start();
            expect(logger.critical).toHaveBeenCalledTimes(1);
            expect(notifyCritical).toHaveBeenCalledTimes(1);
        });

        it("multiple leaders logs critical and emails", () => {
            const { deps, logger, notifyCritical } = makeSupervisorDeps({
                clusterRole: { cronLeaderEnv: () => "true", electionHealth: () => ({ leaderCount: 2, severity: "critical" }) },
            });
            new ClusterSupervisor(deps).start();
            expect(logger.critical).toHaveBeenCalledTimes(1);
            expect(notifyCritical).toHaveBeenCalledTimes(1);
        });

        it("a throwing or rejecting notifier never breaks the primary", async () => {
            const throwing = makeSupervisorDeps({
                notifyCritical: () => { throw new Error("smtp down"); },
                clusterRole: { cronLeaderEnv: () => "false", electionHealth: () => ({ leaderCount: 0, severity: "critical" }) },
            });
            expect(() => new ClusterSupervisor(throwing.deps).start()).not.toThrow();
            const rejecting = makeSupervisorDeps({
                notifyCritical: () => Promise.reject(new Error("smtp down")),
                clusterRole: { cronLeaderEnv: () => "false", electionHealth: () => ({ leaderCount: 0, severity: "critical" }) },
            });
            expect(() => new ClusterSupervisor(rejecting.deps).start()).not.toThrow();
            await flush();
        });

        it("cluster events are wired: listening marks the worker and notifies the hub; disconnect warns", () => {
            const { deps, cluster, logger } = makeSupervisorDeps();
            const onWorkerListening = vi.fn();
            const hub: any = { onWorkerListening, onWorkerExit: vi.fn(), handleMessage: vi.fn(() => false) };
            const sup = new ClusterSupervisor({ ...deps, rpcHub: hub });
            sup.start();
            cluster.emit("listening", cluster.workers[0]);
            expect(onWorkerListening).toHaveBeenCalledWith(cluster.workers[0]);
            cluster.emit("disconnect", cluster.workers[1]);
            expect(logger.warning).toHaveBeenCalled();
        });

        it("listening without a hub does not throw", () => {
            const { deps, cluster } = makeSupervisorDeps();
            new ClusterSupervisor(deps).start();
            expect(() => cluster.emit("listening", cluster.workers[0])).not.toThrow();
        });
    });

    describe("respawn", () => {
        it("a non-leader exit respawns after BACKOFF_BASE_MS and keeps the leader", async () => {
            const { deps, cluster } = makeSupervisorDeps();
            const sup = new ClusterSupervisor(deps);
            sup.start();
            cluster.emit("exit", cluster.workers[1], 1, null);
            expect(sup.liveCount).toBe(2);
            expect(cluster.workers).toHaveLength(3);
            await vi.advanceTimersByTimeAsync(ClusterSupervisor.BACKOFF_BASE_MS);
            expect(cluster.workers).toHaveLength(4);
            expect(sup.liveCount).toBe(3);
            expect(cluster.forkEnvs[3].CRON_LEADER).toBe("false");
        });

        it("a leader exit re-forks a replacement leader", async () => {
            const { deps, cluster } = makeSupervisorDeps();
            const sup = new ClusterSupervisor(deps);
            sup.start();
            cluster.emit("exit", cluster.workers[0], null, "SIGKILL");
            expect(sup.getLeader()).toBeNull();
            await vi.advanceTimersByTimeAsync(ClusterSupervisor.BACKOFF_BASE_MS);
            expect(cluster.forkEnvs[3].CRON_LEADER).toBe("true");
            expect(sup.getLeader()).toBe(cluster.workers[3]);
        });

        it("exit is reported to the hub so pending RPCs fail", () => {
            const { deps, cluster } = makeSupervisorDeps();
            const onWorkerExit = vi.fn();
            const sup = new ClusterSupervisor({ ...deps, rpcHub: { onWorkerExit, onWorkerListening: vi.fn(), handleMessage: () => false } });
            sup.start();
            cluster.emit("exit", cluster.workers[2], 0, null);
            expect(onWorkerExit).toHaveBeenCalledWith(cluster.workers[2]);
        });

        it("a failing re-fork logs critical and does not throw out of the timer", async () => {
            const { deps, cluster, logger } = makeSupervisorDeps();
            new ClusterSupervisor(deps).start();
            cluster.emit("exit", cluster.workers[0], 1, null);
            cluster.forkThrows = true;
            await vi.advanceTimersByTimeAsync(ClusterSupervisor.BACKOFF_BASE_MS);
            expect(logger.critical).toHaveBeenCalled();
            expect(String(logger.critical.mock.calls[0][0])).toContain("EAGAIN");
        });

        it("the respawn timer does nothing if a stop began meanwhile", async () => {
            const { deps, cluster } = makeSupervisorDeps();
            const sup = new ClusterSupervisor(deps);
            sup.start();
            cluster.emit("exit", cluster.workers[1], 1, null);
            sup.shutdown("SIGTERM"); // clears pending respawns
            await vi.advanceTimersByTimeAsync(ClusterSupervisor.BACKOFF_BASE_MS * 2);
            expect(cluster.workers).toHaveLength(3);
        });

        it("the respawn timer bails out if the supervisor turned fatal after it was armed", async () => {
            const { deps, cluster } = makeSupervisorDeps();
            const sup = new ClusterSupervisor(deps);
            sup.start();
            cluster.emit("exit", cluster.workers[1], 1, null);
            // Boot-fatal clears timers, so arm a second exit only after the flag flips via crash loop elsewhere.
            sup._onBootFatal(cluster.workers[2], "EADDRINUSE");
            await vi.advanceTimersByTimeAsync(ClusterSupervisor.BACKOFF_MAX_MS);
            expect(cluster.workers).toHaveLength(3);
            expect(sup.fatal).toBe(true);
        });
    });

    describe("messages", () => {
        it("non-object messages are ignored", () => {
            const { deps, cluster } = makeSupervisorDeps();
            const sup = new ClusterSupervisor(deps);
            sup.start();
            expect(() => { cluster.emit("message", cluster.workers[0], null); cluster.emit("message", cluster.workers[0], "x"); }).not.toThrow();
            expect(sup.fatal).toBe(false);
        });

        it("a message consumed by the hub never reaches the boot-fatal / relay handlers", () => {
            const { deps, cluster } = makeSupervisorDeps();
            const hub: any = { handleMessage: vi.fn(() => true), onWorkerListening: vi.fn(), onWorkerExit: vi.fn() };
            const sup = new ClusterSupervisor({ ...deps, rpcHub: hub });
            sup.start();
            cluster.emit("message", cluster.workers[1], { cmd: CLUSTER_IPC.BOOT_FATAL, code: "EACCES" });
            expect(sup.fatal).toBe(false);
        });

        it("unknown cmd falls through harmlessly when the hub does not claim it", () => {
            const { deps, cluster } = makeSupervisorDeps();
            const hub: any = { handleMessage: vi.fn(() => false), onWorkerListening: vi.fn(), onWorkerExit: vi.fn() };
            const sup = new ClusterSupervisor({ ...deps, rpcHub: hub });
            sup.start();
            cluster.emit("message", cluster.workers[1], { cmd: "app:other" });
            expect(sup.fatal).toBe(false);
        });

        it("boot fatal before listening stops the cluster with exit code 1 and no respawn", async () => {
            const { deps, cluster, proc, logger, notifyCritical } = makeSupervisorDeps();
            const sup = new ClusterSupervisor(deps);
            sup.start();
            cluster.emit("message", cluster.workers[1], { cmd: CLUSTER_IPC.BOOT_FATAL, code: "EADDRINUSE" });
            expect(sup.fatal).toBe(true);
            expect(sup.stopping).toBe(true);
            expect(logger.critical).toHaveBeenCalled();
            expect(notifyCritical).toHaveBeenCalled();
            for (const w of cluster.workers) expect(w.sent).toContainEqual({ cmd: CLUSTER_IPC.SHUTDOWN, signal: "BOOT_FATAL" });
            for (const w of [...cluster.workers]) cluster.emit("exit", w, 0, null);
            await flush();
            expect(proc.exit).toHaveBeenCalledWith(1);
            expect(cluster.workers).toHaveLength(3);
        });

        it("boot fatal with a missing code reports 'unknown'; a second one is ignored", () => {
            const { deps, cluster, logger } = makeSupervisorDeps();
            const sup = new ClusterSupervisor(deps);
            sup.start();
            sup._onBootFatal(cluster.workers[1], undefined);
            expect(String(logger.critical.mock.calls[0][0])).toContain("unknown");
            sup._onBootFatal(cluster.workers[2], "EACCES");
            expect(logger.critical).toHaveBeenCalledTimes(1);
        });

        it("boot-fatal from a worker that is already listening is only a warning", () => {
            const { deps, cluster, logger } = makeSupervisorDeps();
            const sup = new ClusterSupervisor(deps);
            sup.start();
            cluster.emit("listening", cluster.workers[1]);
            cluster.emit("message", cluster.workers[1], { cmd: CLUSTER_IPC.BOOT_FATAL, code: "EACCES" });
            expect(sup.fatal).toBe(false);
            expect(logger.warning).toHaveBeenCalled();
            expect(logger.critical).not.toHaveBeenCalled();
        });

        it("critical relay from a non-leader is forwarded to the leader", () => {
            const { deps, cluster } = makeSupervisorDeps();
            new ClusterSupervisor(deps).start();
            cluster.emit("message", cluster.workers[1], { cmd: CLUSTER_IPC.CRIT_RELAY, record: { a: 1 } });
            expect(cluster.workers[0].sent).toContainEqual({ cmd: CLUSTER_IPC.CRIT_RELAY, record: { a: 1 } });
        });

        it("critical relay from the leader itself is dropped", () => {
            const { deps, cluster, logger } = makeSupervisorDeps();
            new ClusterSupervisor(deps).start();
            cluster.emit("message", cluster.workers[0], { cmd: CLUSTER_IPC.CRIT_RELAY, record: {} });
            expect(cluster.workers[0].sent).toHaveLength(0);
            expect(String(logger.warning.mock.calls.at(-1)![0])).toContain("sender is the leader");
        });

        it("critical relay with no leader is dropped", () => {
            const { deps, cluster, logger } = makeSupervisorDeps();
            new ClusterSupervisor(deps).start();
            cluster.emit("exit", cluster.workers[0], 1, null);
            cluster.emit("message", cluster.workers[1], { cmd: CLUSTER_IPC.CRIT_RELAY, record: {} });
            expect(String(logger.warning.mock.calls.at(-1)![0])).toContain("no leader");
        });

        it("critical relay to an unreachable leader is dropped with a warning", () => {
            const { deps, cluster, logger } = makeSupervisorDeps();
            new ClusterSupervisor(deps).start();
            cluster.workers[0].sendThrows = true;
            cluster.emit("message", cluster.workers[1], { cmd: CLUSTER_IPC.CRIT_RELAY, record: {} });
            expect(String(logger.warning.mock.calls.at(-1)![0])).toContain("leader unreachable");
        });

        it("critical relay is ignored while stopping", () => {
            const { deps, cluster } = makeSupervisorDeps();
            const sup = new ClusterSupervisor(deps);
            sup.start();
            sup.shutdown("SIGTERM");
            cluster.workers[0].sent.length = 0;
            cluster.emit("message", cluster.workers[1], { cmd: CLUSTER_IPC.CRIT_RELAY, record: {} });
            expect(cluster.workers[0].sent).toHaveLength(0);
        });
    });

    describe("shutdown", () => {
        it("signals trigger a graceful stop: SHUTDOWN to all, exit 0 once all exit cleanly", async () => {
            const { deps, cluster, proc, logger } = makeSupervisorDeps();
            const sup = new ClusterSupervisor(deps);
            sup.start();
            proc.emit("SIGTERM");
            expect(sup.stopping).toBe(true);
            for (const w of cluster.workers) expect(w.sent).toEqual([{ cmd: CLUSTER_IPC.SHUTDOWN, signal: "SIGTERM" }]);
            for (const w of [...cluster.workers]) cluster.emit("exit", w, 0, null);
            await flush();
            expect(proc.exit).toHaveBeenCalledTimes(1);
            expect(proc.exit).toHaveBeenCalledWith(0);
            expect(logger.flush).toHaveBeenCalledWith(ClusterSupervisor.LOGGER_FLUSH_MS);
        });

        it("exit code is the highest worker code; signal or non-numeric code counts as 1", async () => {
            const { deps, cluster, proc } = makeSupervisorDeps();
            const sup = new ClusterSupervisor(deps);
            sup.start();
            sup.shutdown("SIGINT");
            cluster.emit("exit", cluster.workers[0], 0, null);
            cluster.emit("exit", cluster.workers[1], 7, null);
            cluster.emit("exit", cluster.workers[2], 0, "SIGKILL");
            await flush();
            expect(proc.exit).toHaveBeenCalledWith(7);
        });

        it("non-numeric exit code counts as failure", async () => {
            const { deps, cluster, proc } = makeSupervisorDeps({ numWorkers: 1 });
            const sup = new ClusterSupervisor(deps);
            sup.start();
            sup.shutdown("SIGINT");
            cluster.emit("exit", cluster.workers[0], undefined, null);
            await flush();
            expect(proc.exit).toHaveBeenCalledWith(1);
        });

        it("shutdown is idempotent and keeps the largest minExitCode", async () => {
            const { deps, cluster, proc } = makeSupervisorDeps({ numWorkers: 1 });
            const sup = new ClusterSupervisor(deps);
            sup.start();
            sup.shutdown("A");
            sup.shutdown("B", { minExitCode: 1 });
            expect(cluster.workers[0].sent).toHaveLength(1);
            cluster.emit("exit", cluster.workers[0], 0, null);
            await flush();
            expect(proc.exit).toHaveBeenCalledWith(1);
        });

        it("with no live workers the stop finishes at once", async () => {
            const { deps, proc } = makeSupervisorDeps();
            const sup = new ClusterSupervisor(deps);
            sup.shutdown("SIGTERM");
            await flush();
            expect(proc.exit).toHaveBeenCalledWith(0);
        });

        it("a worker that cannot be messaged does not abort the stop", () => {
            const { deps, cluster } = makeSupervisorDeps();
            const sup = new ClusterSupervisor(deps);
            sup.start();
            cluster.workers[0].sendThrows = true;
            expect(() => sup.shutdown("SIGTERM")).not.toThrow();
            expect(cluster.workers[1].sent).toHaveLength(1);
        });

        it("a flush that rejects still exits", async () => {
            const { deps, cluster, proc, logger } = makeSupervisorDeps({ numWorkers: 1 });
            logger.flush.mockRejectedValue(new Error("disk"));
            const sup = new ClusterSupervisor(deps);
            sup.start();
            sup.shutdown("SIGTERM");
            cluster.emit("exit", cluster.workers[0], 0, null);
            await flush();
            expect(proc.exit).toHaveBeenCalledWith(0);
        });

        it("a logger without flush still exits", async () => {
            const { deps, cluster, proc, logger } = makeSupervisorDeps({ numWorkers: 1 });
            (logger as any).flush = undefined;
            const sup = new ClusterSupervisor(deps);
            sup.start();
            sup.shutdown("SIGTERM");
            cluster.emit("exit", cluster.workers[0], 0, null);
            await flush();
            expect(proc.exit).toHaveBeenCalledWith(0);
        });

        it("the failsafe fires at forcedExitMs + marginMs: SIGKILL, bounded email, exit 1", async () => {
            const { deps, cluster, proc, notifyCritical } = makeSupervisorDeps();
            const sup = new ClusterSupervisor(deps);
            sup.start();
            sup.shutdown("SIGTERM");
            await vi.advanceTimersByTimeAsync(deps.forcedExitMs + deps.marginMs - 1);
            expect(proc.exit).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
            for (const w of cluster.workers) expect(w.killed).toEqual(["SIGKILL"]);
            expect(notifyCritical).toHaveBeenCalledTimes(1);
            expect(proc.exit).toHaveBeenCalledWith(1);
        });

        it("failsafe: a notifier that never resolves is bounded by NOTIFY_BOUND_MS", async () => {
            const { deps, proc } = makeSupervisorDeps({ notifyCritical: () => new Promise(() => {}) });
            const sup = new ClusterSupervisor(deps);
            sup.start();
            sup.shutdown("SIGTERM");
            await vi.advanceTimersByTimeAsync(deps.forcedExitMs + deps.marginMs);
            expect(proc.exit).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(ClusterSupervisor.NOTIFY_BOUND_MS);
            expect(proc.exit).toHaveBeenCalledWith(1);
        });

        it("failsafe: kill failures and a throwing notifier are swallowed", async () => {
            const { deps, cluster, proc } = makeSupervisorDeps({ notifyCritical: () => { throw new Error("x"); } });
            const sup = new ClusterSupervisor(deps);
            sup.start();
            cluster.workers[0].killThrows = true;
            cluster.workers[1].process = undefined;
            sup.shutdown("SIGTERM");
            await vi.advanceTimersByTimeAsync(deps.forcedExitMs + deps.marginMs);
            expect(cluster.workers[2].killed).toEqual(["SIGKILL"]);
            expect(proc.exit).toHaveBeenCalledWith(1);
        });

        it("failsafe is a no-op after a clean finish", async () => {
            const { deps, cluster, proc } = makeSupervisorDeps({ numWorkers: 1 });
            const sup = new ClusterSupervisor(deps);
            sup.start();
            sup.shutdown("SIGTERM");
            cluster.emit("exit", cluster.workers[0], 0, null);
            await vi.advanceTimersByTimeAsync(deps.forcedExitMs + deps.marginMs + 10_000);
            expect(proc.exit).toHaveBeenCalledTimes(1);
        });

        it("_forceExit twice only exits once", async () => {
            const { deps, proc } = makeSupervisorDeps();
            const sup = new ClusterSupervisor(deps);
            await sup._forceExit(1);
            await sup._forceExit(1);
            await flush();
            expect(proc.exit).toHaveBeenCalledTimes(1);
        });
    });
});
