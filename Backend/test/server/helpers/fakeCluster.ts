import { EventEmitter } from "events";
import { ClusterRole } from "../../../src/utils/clusterRole";

/** A fake cluster worker: records sends, optionally throws on send/kill. */
export function makeWorker(id: number) {
    const w: any = {
        id,
        sent: [] as any[],
        sendThrows: false,
        killThrows: false,
        killed: [] as string[],
        process: {
            pid: 1000 + id,
            kill: (sig: string) => {
                if (w.killThrows) throw new Error("ESRCH");
                w.killed.push(sig);
            },
        },
        send: (m: any) => {
            if (w.sendThrows) throw new Error("EPIPE");
            w.sent.push(m);
        },
    };
    return w;
}

/** A fake cluster primary: an emitter whose fork() hands out numbered workers. */
export function makeCluster() {
    const c: any = new EventEmitter();
    c.workers = [] as any[];
    c.forkEnvs = [] as any[];
    c.forkThrows = false;
    let next = 1;
    c.fork = (env: any) => {
        if (c.forkThrows) throw new Error("EAGAIN");
        const w = makeWorker(next++);
        c.workers.push(w);
        c.forkEnvs.push(env);
        return w;
    };
    return c;
}

export function makeLogger() {
    return {
        critical: vi.fn(),
        error: vi.fn(),
        flush: vi.fn(() => Promise.resolve()),
        notice: vi.fn(),
        warning: vi.fn(),
    };
}

/** Builds supervisor deps with a controllable clock and a fake process. */
export function makeSupervisorDeps(over: Record<string, unknown> = {}) {
    const cluster = makeCluster();
    const logger = makeLogger();
    const proc: any = new EventEmitter();
    proc.exit = vi.fn();
    proc.pid = 4242;
    const clock = { t: 1_000_000 };
    const notifyCritical = vi.fn(() => Promise.resolve());
    const deps: any = {
        cluster,
        numWorkers: 3,
        forcedExitMs: 10_000,
        marginMs: 2_000,
        logger,
        notifyCritical,
        clusterRole: ClusterRole,
        processRef: proc,
        now: () => clock.t,
        runId: "run-1",
        ...over,
    };
    return { cluster, logger, proc, clock, notifyCritical, deps };
}
