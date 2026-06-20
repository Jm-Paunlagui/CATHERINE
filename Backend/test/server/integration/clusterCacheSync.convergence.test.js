"use strict";

/**
 * @fileoverview Multi-worker convergence + chaos for ClusterCacheSync, using
 * REAL CacheRegistry + CacheStore instances (one independent set per simulated
 * worker) and the REAL ClusterCacheSync relay logic. No processes are forked;
 * the IPC fabric is simulated in-process by routing each worker's broadcast
 * envelope to the others via ClusterCacheSync.applyRemote — exactly what the
 * primary relay does between real workers.
 *
 * Proves the property clustering MUST hold for a financial cache:
 *   C1  an invalidation on ANY worker reaches EVERY other worker (convergence)
 *   C2  applying a relayed invalidation does NOT re-broadcast (no storm)
 *   C3  del / delByPattern / flush all propagate with correct semantics
 *   C4  a worker that throws while relaying does not block the other workers
 *   C5  an IPC send failure degrades gracefully (origin updated; no crash)
 */

const {
    CacheRegistry,
} = require("../../../src/middleware/cache/CacheRegistry");
const {
    ClusterCacheSync,
} = require("../../../src/middleware/cache/ClusterCacheSync");

const STORES = {
    subsidy: { ttl: 600, maxKeys: 500 },
    billing: { ttl: 1800, maxKeys: 1000 },
};

/** Builds N independent workers, each a real registry with the same stores. */
function makeWorkers(n) {
    return Array.from({ length: n }, () => {
        const registry = new CacheRegistry();
        registry.registerAll(STORES);
        return registry;
    });
}

/** Seeds the same keys into every worker's stores so we can watch them clear. */
function seedAll(workers) {
    for (const reg of workers) {
        reg.resolve("subsidy").set("subsidy:year=2026:month=3", { rows: 1 });
        reg.resolve("subsidy").set("subsidy:type=years", [2026]);
        reg.resolve("billing").set("billing:page=1", { total: 9 });
    }
}

describe("ClusterCacheSync — multi-worker convergence + chaos", function () {
    let savedCluster, savedSend, savedCanSend, savedApplying;
    let workers;
    let originIndex;

    beforeEach(function () {
        savedCluster = ClusterCacheSync._cluster;
        savedSend = ClusterCacheSync._send;
        savedCanSend = ClusterCacheSync._canSend;
        savedApplying = ClusterCacheSync._applyingRemote;

        workers = makeWorkers(8);
        seedAll(workers);

        // Simulate the cluster fabric: this process is a worker, IPC is up,
        // and a broadcast relays to every OTHER worker (the primary's job).
        ClusterCacheSync._cluster = { isWorker: true };
        ClusterCacheSync._canSend = () => true;
        ClusterCacheSync._send = (msg) => {
            workers.forEach((reg, i) => {
                if (i !== originIndex) ClusterCacheSync.applyRemote(reg, msg);
            });
        };
    });

    afterEach(function () {
        ClusterCacheSync._cluster = savedCluster;
        ClusterCacheSync._send = savedSend;
        ClusterCacheSync._canSend = savedCanSend;
        ClusterCacheSync._applyingRemote = savedApplying;
    });

    // ── C1 / C3: delByPattern converges across all workers ──────────────────
    it("a delByPattern on one worker clears that namespace on ALL workers", function () {
        originIndex = 2;
        // Worker 2 saved subsidy data → invalidate the whole subsidy namespace.
        workers[originIndex].resolve("subsidy").delByPattern("subsidy");

        for (let i = 0; i < workers.length; i++) {
            const subsidyKeys = workers[i]
                .resolve("subsidy")
                .keys()
                .filter((k) => k.includes("subsidy"));
            expect(subsidyKeys, `worker ${i} subsidy keys`).toHaveLength(0);
            // Other namespaces are untouched on every worker.
            expect(workers[i].resolve("billing").keys()).toHaveLength(1);
        }
    });

    // ── C3: exact-key del converges ─────────────────────────────────────────
    it("an exact-key del on one worker removes that key on ALL workers", function () {
        originIndex = 0;
        workers[0].resolve("subsidy").del("subsidy:type=years");
        for (let i = 0; i < workers.length; i++) {
            expect(
                workers[i].resolve("subsidy").has("subsidy:type=years"),
            ).toBe(false);
            // The other subsidy key survives (surgical, not a flush).
            expect(
                workers[i].resolve("subsidy").has("subsidy:year=2026:month=3"),
            ).toBe(true);
        }
    });

    // ── C3: flush converges ─────────────────────────────────────────────────
    it("a flush on one worker empties that store on ALL workers", function () {
        originIndex = 5;
        workers[5].resolve("billing").flush();
        for (let i = 0; i < workers.length; i++) {
            expect(workers[i].resolve("billing").keys()).toHaveLength(0);
            // subsidy store on every worker is untouched.
            expect(
                workers[i].resolve("subsidy").keys().length,
            ).toBeGreaterThan(0);
        }
    });

    // ── C2: applying a relayed op does not re-broadcast (no storm) ──────────
    it("relayed invalidations do not re-broadcast (no message storm)", function () {
        originIndex = 1;
        let sendCount = 0;
        const baseSend = ClusterCacheSync._send;
        ClusterCacheSync._send = (msg) => {
            sendCount++;
            baseSend(msg);
        };
        workers[1].resolve("subsidy").delByPattern("subsidy");
        // Exactly ONE outbound broadcast (from the origin). The 7 relayed
        // applications must NOT trigger further broadcasts.
        expect(sendCount).toBe(1);
    });

    // ── C4: a worker throwing during relay does not block the others ────────
    it("convergence continues even if one worker throws while applying", function () {
        originIndex = 0;
        // Make worker 4's subsidy store throw on delByPattern.
        const victim = workers[4].resolve("subsidy");
        const realDel = victim.delByPattern.bind(victim);
        victim.delByPattern = () => {
            throw new Error("worker 4 store exploded");
        };

        // Relay that tolerates a per-worker failure (mirrors initPrimary's
        // try/catch around w.send): wrap each applyRemote.
        ClusterCacheSync._send = (msg) => {
            workers.forEach((reg, i) => {
                if (i === originIndex) return;
                try {
                    ClusterCacheSync.applyRemote(reg, msg);
                } catch {
                    /* a dead/erroring worker must not block the rest */
                }
            });
        };

        expect(() =>
            workers[0].resolve("subsidy").delByPattern("subsidy"),
        ).not.toThrow();

        // Every healthy worker converged; the guard is left clean for reuse.
        victim.delByPattern = realDel;
        for (let i = 0; i < workers.length; i++) {
            if (i === 4) continue;
            expect(
                workers[i]
                    .resolve("subsidy")
                    .keys()
                    .filter((k) => k.includes("subsidy")),
                `worker ${i}`,
            ).toHaveLength(0);
        }
        expect(ClusterCacheSync._applyingRemote).toBe(false);
    });

    // ── C5: IPC send failure degrades gracefully ────────────────────────────
    it("an IPC send failure updates the origin and never crashes the request", function () {
        originIndex = 3;
        ClusterCacheSync._send = () => {
            throw new Error("ECONNRESET on IPC channel");
        };
        // The write path must still succeed locally despite the relay failing.
        expect(() =>
            workers[3].resolve("subsidy").delByPattern("subsidy"),
        ).not.toThrow();
        // Origin is updated; siblings are stale-until-TTL (acceptable bound).
        expect(
            workers[3]
                .resolve("subsidy")
                .keys()
                .filter((k) => k.includes("subsidy")),
        ).toHaveLength(0);
        expect(
            workers[0]
                .resolve("subsidy")
                .keys()
                .filter((k) => k.includes("subsidy")),
        ).toHaveLength(2);
    });

    // ── initPrimary relay tolerates a dead worker (w.send throws) ───────────
    it("initPrimary keeps relaying to healthy workers when one worker's send throws", function () {
        const received = new Map();
        const mkWorker = (id, broken) => ({
            id,
            send(m) {
                if (broken) throw new Error(`worker ${id} is dead`);
                received.set(id, (received.get(id) || []).concat([m]));
            },
        });
        let handler;
        ClusterCacheSync._cluster = {
            workers: { 1: mkWorker(1), 2: mkWorker(2, true), 3: mkWorker(3) },
            on(ev, fn) {
                if (ev === "message") handler = fn;
            },
        };
        ClusterCacheSync.initPrimary();
        const msg = {
            ch: ClusterCacheSync.CHANNEL,
            store: "subsidy",
            op: "flush",
            arg: null,
        };
        // Worker 1 originates; relay must reach 3 even though 2 throws.
        expect(() =>
            handler(ClusterCacheSync._cluster.workers[1], msg),
        ).not.toThrow();
        expect(received.has(1)).toBe(false); // origin skipped
        expect(received.get(3)).toEqual([msg]); // healthy sibling reached
    });
});
