"use strict";

/**
 * @fileoverview Unit tests for ClusterCacheSync — the cross-worker cache
 * invalidation coordinator. The real cluster module is substituted with fakes
 * via the documented ClusterCacheSync._cluster / _send injection points, so no
 * actual worker processes are forked.
 *
 * These guard the correctness property that matters for a financial system:
 * an invalidation on ANY worker must reach EVERY other worker, and applying a
 * relayed invalidation must NOT re-broadcast (no message storms).
 */

const { expect } = require("chai");
const {
    ClusterCacheSync,
} = require("../../../../src/middleware/cache/ClusterCacheSync");

// Minimal fake CacheStore capturing the ops applied to it.
function fakeStore() {
    return {
        ops: [],
        del(keys) {
            this.ops.push(["del", keys]);
        },
        delByPattern(p) {
            this.ops.push(["delByPattern", p]);
        },
        flush() {
            this.ops.push(["flush"]);
        },
    };
}

// Minimal fake registry resolving named stores.
function fakeRegistry(stores) {
    return {
        resolve(name) {
            if (!stores[name]) throw new Error(`no store ${name}`);
            return stores[name];
        },
    };
}

describe("ClusterCacheSync", function () {
    let savedCluster, savedSend, savedCanSend, savedApplying;

    beforeEach(function () {
        savedCluster = ClusterCacheSync._cluster;
        savedSend = ClusterCacheSync._send;
        savedCanSend = ClusterCacheSync._canSend;
        savedApplying = ClusterCacheSync._applyingRemote;
        // Tests control worker-mode via _cluster.isWorker; assume IPC present.
        ClusterCacheSync._canSend = () => true;
    });

    afterEach(function () {
        ClusterCacheSync._cluster = savedCluster;
        ClusterCacheSync._send = savedSend;
        ClusterCacheSync._canSend = savedCanSend;
        ClusterCacheSync._applyingRemote = savedApplying;
    });

    describe("broadcast()", function () {
        it("is a no-op outside a cluster worker (single-process mode)", function () {
            ClusterCacheSync._cluster = { isWorker: false };
            let sent = 0;
            ClusterCacheSync._send = () => sent++;
            ClusterCacheSync.broadcast("subsidy", "flush");
            expect(sent).to.equal(0);
        });

        it("sends a namespaced envelope when running as a worker", function () {
            ClusterCacheSync._cluster = { isWorker: true };
            const sent = [];
            ClusterCacheSync._send = (m) => sent.push(m);
            ClusterCacheSync._applyingRemote = false;
            ClusterCacheSync.broadcast("billing", "delByPattern", "billing");
            expect(sent).to.have.lengthOf(1);
            expect(sent[0]).to.include({
                ch: ClusterCacheSync.CHANNEL,
                store: "billing",
                op: "delByPattern",
                arg: "billing",
            });
        });

        it("does NOT broadcast while applying a remote op (no storms)", function () {
            ClusterCacheSync._cluster = { isWorker: true };
            let sent = 0;
            ClusterCacheSync._send = () => sent++;
            ClusterCacheSync._applyingRemote = true;
            ClusterCacheSync.broadcast("subsidy", "flush");
            expect(sent).to.equal(0);
        });

        it("swallows IPC send failures (stale-until-TTL fallback)", function () {
            ClusterCacheSync._cluster = { isWorker: true };
            ClusterCacheSync._send = () => {
                throw new Error("channel closed");
            };
            ClusterCacheSync._applyingRemote = false;
            expect(() =>
                ClusterCacheSync.broadcast("subsidy", "flush"),
            ).to.not.throw();
        });
    });

    describe("applyRemote()", function () {
        it("ignores messages that are not cache-sync envelopes", function () {
            const store = fakeStore();
            const reg = fakeRegistry({ subsidy: store });
            expect(
                ClusterCacheSync.applyRemote(reg, { ch: "other", op: "flush" }),
            ).to.equal(false);
            expect(store.ops).to.have.lengthOf(0);
        });

        it("applies a del op to the named store", function () {
            const store = fakeStore();
            const reg = fakeRegistry({ subsidy: store });
            const ok = ClusterCacheSync.applyRemote(reg, {
                ch: ClusterCacheSync.CHANNEL,
                store: "subsidy",
                op: "del",
                arg: ["k1", "k2"],
            });
            expect(ok).to.equal(true);
            expect(store.ops).to.deep.equal([["del", ["k1", "k2"]]]);
        });

        it("applies delByPattern and flush ops", function () {
            const store = fakeStore();
            const reg = fakeRegistry({ billing: store });
            ClusterCacheSync.applyRemote(reg, {
                ch: ClusterCacheSync.CHANNEL,
                store: "billing",
                op: "delByPattern",
                arg: "billing",
            });
            ClusterCacheSync.applyRemote(reg, {
                ch: ClusterCacheSync.CHANNEL,
                store: "billing",
                op: "flush",
                arg: null,
            });
            expect(store.ops).to.deep.equal([
                ["delByPattern", "billing"],
                ["flush"],
            ]);
        });

        it("sets the re-entrancy guard while applying, then clears it", function () {
            const store = fakeStore();
            // Capture the guard value at the moment the store op runs.
            let guardDuringApply = null;
            store.flush = () => {
                guardDuringApply = ClusterCacheSync._applyingRemote;
            };
            const reg = fakeRegistry({ subsidy: store });
            ClusterCacheSync.applyRemote(reg, {
                ch: ClusterCacheSync.CHANNEL,
                store: "subsidy",
                op: "flush",
            });
            expect(guardDuringApply).to.equal(true);
            expect(ClusterCacheSync._applyingRemote).to.equal(false);
        });

        it("returns false (does not throw) for an unregistered store", function () {
            const reg = fakeRegistry({});
            expect(
                ClusterCacheSync.applyRemote(reg, {
                    ch: ClusterCacheSync.CHANNEL,
                    store: "ghost",
                    op: "flush",
                }),
            ).to.equal(false);
        });
    });

    describe("initPrimary()", function () {
        it("relays a worker's message to every OTHER worker", function () {
            const relayed = new Map(); // workerId → messages received
            const makeWorker = (id) => ({
                id,
                send(m) {
                    if (!relayed.has(id)) relayed.set(id, []);
                    relayed.get(id).push(m);
                },
            });
            let messageHandler;
            ClusterCacheSync._cluster = {
                workers: { 1: makeWorker(1), 2: makeWorker(2), 3: makeWorker(3) },
                on(event, fn) {
                    if (event === "message") messageHandler = fn;
                },
            };

            ClusterCacheSync.initPrimary();
            const msg = {
                ch: ClusterCacheSync.CHANNEL,
                store: "subsidy",
                op: "flush",
                arg: null,
            };
            // Worker 1 originated the invalidation.
            messageHandler(ClusterCacheSync._cluster.workers[1], msg);

            expect(relayed.has(1)).to.equal(false); // originator skipped
            expect(relayed.get(2)).to.deep.equal([msg]);
            expect(relayed.get(3)).to.deep.equal([msg]);
        });

        it("ignores non-cache-sync messages on the primary", function () {
            const w2 = { id: 2, sent: [], send(m) { this.sent.push(m); } };
            let messageHandler;
            ClusterCacheSync._cluster = {
                workers: { 1: { id: 1, send() {} }, 2: w2 },
                on(event, fn) {
                    if (event === "message") messageHandler = fn;
                },
            };
            ClusterCacheSync.initPrimary();
            messageHandler(ClusterCacheSync._cluster.workers[1], {
                ch: "something-else",
            });
            expect(w2.sent).to.have.lengthOf(0);
        });
    });
});
