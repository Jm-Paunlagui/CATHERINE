import { ClusterSupervisor } from "../../../src/utils/cluster/ClusterSupervisor";
import { CLUSTER_IPC } from "../../../src/constants/clusterIpc";
import { makeSupervisorDeps } from "../helpers/fakeCluster";

const flush = async () => { await vi.advanceTimersByTimeAsync(0); };

describe("cluster supervisor chaos", () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it("crash loop: respawn delay doubles per exit inside the window", async () => {
        const { deps, cluster, logger } = makeSupervisorDeps({ numWorkers: 2 });
        const sup = new ClusterSupervisor(deps);
        sup.start();
        const delays: number[] = [];
        for (let i = 0; i < 4; i++) {
            const victim = cluster.workers.at(-1);
            cluster.emit("exit", victim, 1, null);
            delays.push(Number(/in (\d+)ms/.exec(String(logger.warning.mock.calls.at(-1)![0]))![1]));
            await vi.advanceTimersByTimeAsync(ClusterSupervisor.BACKOFF_MAX_MS);
        }
        expect(delays).toEqual([1000, 2000, 4000, 8000]);
        expect(sup.fatal).toBe(false);
    });

    it("backoff is capped at BACKOFF_MAX_MS when the window is widened", () => {
        const { deps, cluster, logger } = makeSupervisorDeps({ numWorkers: 2 });
        const sup = new ClusterSupervisor(deps);
        const prev = ClusterSupervisor.CRASH_LOOP_MAX;
        ClusterSupervisor.CRASH_LOOP_MAX = 100;
        try {
            sup.start();
            for (let i = 0; i < 8; i++) cluster.emit("exit", cluster.workers[1], 1, null);
            const last = String(logger.warning.mock.calls.at(-1)![0]);
            expect(last).toContain(`in ${ClusterSupervisor.BACKOFF_MAX_MS}ms`);
        } finally {
            ClusterSupervisor.CRASH_LOOP_MAX = prev;
        }
    });

    it("exits older than the window are forgotten so a slow flap never trips the cap", async () => {
        const { deps, cluster, clock } = makeSupervisorDeps({ numWorkers: 2 });
        const sup = new ClusterSupervisor(deps);
        sup.start();
        for (let i = 0; i < 12; i++) {
            cluster.emit("exit", cluster.workers.at(-1), 1, null);
            clock.t += ClusterSupervisor.CRASH_LOOP_WINDOW_MS + 1;
            await vi.advanceTimersByTimeAsync(ClusterSupervisor.BACKOFF_BASE_MS);
        }
        expect(sup.fatal).toBe(false);
        expect(sup.liveCount).toBe(2);
    });

    it("crash loop trips at CRASH_LOOP_MAX exits: no more forks, leader alive keeps serving", async () => {
        const { deps, cluster, logger, notifyCritical, proc } = makeSupervisorDeps({ numWorkers: 2 });
        const sup = new ClusterSupervisor(deps);
        sup.start();
        // Non-leader keeps dying; leader (worker 1) survives.
        for (let i = 0; i < ClusterSupervisor.CRASH_LOOP_MAX; i++) {
            cluster.emit("exit", cluster.workers.at(-1), 1, null);
            if (!sup.fatal) await vi.advanceTimersByTimeAsync(ClusterSupervisor.BACKOFF_MAX_MS);
        }
        expect(sup.fatal).toBe(true);
        expect(logger.critical.mock.calls.some((c) => String(c[0]).includes("CLUSTER_CRASH_LOOP_TRIPPED"))).toBe(true);
        expect(notifyCritical).toHaveBeenCalled();
        const forks = cluster.workers.length;
        await vi.advanceTimersByTimeAsync(ClusterSupervisor.BACKOFF_MAX_MS * 3);
        expect(cluster.workers).toHaveLength(forks);
        expect(sup.stopping).toBe(false);
        expect(proc.exit).not.toHaveBeenCalled();
        expect(sup.getLeader()).toBe(cluster.workers[0]);
    });

    it("crash loop with the leader dead and siblings alive stops the siblings and exits 1", async () => {
        const { deps, cluster, proc, logger } = makeSupervisorDeps({ numWorkers: 3 });
        const sup = new ClusterSupervisor(deps);
        sup.start();
        cluster.emit("exit", cluster.workers[0], 1, null); // leader dies, respawn pending
        // fill the window with more exits so the cap trips on a leaderless cluster
        for (let i = 0; i < ClusterSupervisor.CRASH_LOOP_MAX - 1; i++) cluster.emit("exit", cluster.workers[1], 1, null);
        expect(sup.fatal).toBe(true);
        expect(sup.stopping).toBe(true);
        expect(logger.critical.mock.calls.some((c) => String(c[0]).includes("CLUSTER_LEADERLESS_STOP"))).toBe(true);
        for (const w of sup.getLiveWorkers() as any[]) expect(w.sent).toContainEqual({ cmd: CLUSTER_IPC.SHUTDOWN, signal: "CRASH_LOOP" });
        for (const w of sup.getLiveWorkers()) cluster.emit("exit", w, 0, null);
        await flush();
        expect(proc.exit).toHaveBeenCalledWith(1);
    });

    it("crash loop with every worker gone exits 1 with the no-workers-left notice", async () => {
        const { deps, cluster, proc, logger } = makeSupervisorDeps({ numWorkers: 1 });
        const sup = new ClusterSupervisor(deps);
        sup.start();
        for (let i = 0; i < ClusterSupervisor.CRASH_LOOP_MAX; i++) {
            cluster.emit("exit", cluster.workers.at(-1), 1, null);
            await vi.advanceTimersByTimeAsync(ClusterSupervisor.BACKOFF_MAX_MS);
        }
        await flush();
        expect(sup.fatal).toBe(true);
        expect(proc.exit).toHaveBeenCalledWith(1);
        expect(logger.critical.mock.calls.some((c) => String(c[0]).includes("CLUSTER_NO_WORKERS_LEFT"))).toBe(true);
    });

    it("after a crash loop trips with the leader alive, losing the leader stops the survivors (exit 1)", async () => {
        const { deps, cluster, proc, logger } = makeSupervisorDeps({ numWorkers: 3 });
        const sup = new ClusterSupervisor(deps);
        sup.start();
        for (let i = 0; i < ClusterSupervisor.CRASH_LOOP_MAX; i++) cluster.emit("exit", cluster.workers[1], 1, null);
        expect(sup.fatal).toBe(true);
        expect(sup.stopping).toBe(false);
        expect(sup.liveCount).toBe(2); // leader + one sibling
        cluster.emit("exit", cluster.workers[0], 1, null);
        expect(sup.stopping).toBe(true);
        expect(logger.critical.mock.calls.some((c) => String(c[0]).includes("CLUSTER_LEADERLESS_STOP"))).toBe(true);
        expect(cluster.workers[2].sent).toContainEqual({ cmd: CLUSTER_IPC.SHUTDOWN, signal: "LEADER_LOST" });
        cluster.emit("exit", cluster.workers[2], 0, null);
        await flush();
        expect(proc.exit).toHaveBeenCalledWith(1);
    });

    it("silent worker on stop: failsafe SIGKILLs the stragglers and exits 1 even though nobody exits", async () => {
        const { deps, cluster, proc } = makeSupervisorDeps();
        const sup = new ClusterSupervisor(deps);
        sup.start();
        sup.shutdown("SIGTERM");
        cluster.emit("exit", cluster.workers[0], 0, null);
        await vi.advanceTimersByTimeAsync(deps.forcedExitMs + deps.marginMs);
        await flush();
        expect(cluster.workers[1].killed).toEqual(["SIGKILL"]);
        expect(cluster.workers[2].killed).toEqual(["SIGKILL"]);
        expect(cluster.workers[0].killed).toEqual([]);
        expect(proc.exit).toHaveBeenCalledWith(1);
    });

    it("a stop during a pending respawn cancels it and exits without forking", async () => {
        const { deps, cluster, proc } = makeSupervisorDeps({ numWorkers: 1 });
        const sup = new ClusterSupervisor(deps);
        sup.start();
        cluster.emit("exit", cluster.workers[0], 1, null);
        sup.shutdown("SIGTERM");
        await flush();
        expect(proc.exit).toHaveBeenCalledWith(0);
        await vi.advanceTimersByTimeAsync(ClusterSupervisor.BACKOFF_MAX_MS);
        expect(cluster.workers).toHaveLength(1);
    });

    it("leader exit during a stop is not respawned and the leader slot stays empty", () => {
        const { deps, cluster } = makeSupervisorDeps();
        const sup = new ClusterSupervisor(deps);
        sup.start();
        sup.shutdown("SIGTERM");
        cluster.emit("exit", cluster.workers[0], 0, null);
        expect(sup.getLeader()).toBeNull();
        expect(cluster.workers).toHaveLength(3);
    });
});
