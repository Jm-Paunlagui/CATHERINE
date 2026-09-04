"use strict";

/**
 * ScopedSsePoller.test.js — the SSE sharing/isolation/ordering invariants
 * (plan §5.2 items 8a/8b/8c).
 *
 * A SCOPE is a sharing unit: every connection on the same key shares ONE
 * readCursor() per tick; a second distinct key costs one more query; and — the
 * load-bearing one for a money stream — the cache PURGE (onChange) must run
 * BEFORE the "update" event is broadcast, or the client refetches into stale
 * cache (a stale-balance read, CWE-200-adjacent).
 *
 * We drive the shared interval with fake timers and a fake `res` that records
 * every event, so no HTTP and no DB are needed.
 */

const ScopedSsePoller = require("../../src/utils/sse/ScopedSsePoller");

/** A minimal Express-response stand-in that records SSE frames. */
function makeRes(sink) {
    return {
        headers: {},
        setHeader(k, v) {
            this.headers[k] = v;
        },
        flushHeaders() {},
        flush() {},
        write(chunk) {
            // Parse "event: NAME\n" lines so tests can assert on event names.
            const m = /^event: (.+)\n$/.exec(chunk);
            if (m) sink.push({ res: this, event: m[1] });
        },
    };
}

/** Event names seen by a given res, in order. */
function eventsFor(sink, res) {
    return sink.filter((e) => e.res === res).map((e) => e.event);
}

describe("ScopedSsePoller — constructor discipline", function () {
    it("requires a readCursor function", function () {
        expect(() => new ScopedSsePoller({})).toThrow(TypeError);
    });
});

describe("ScopedSsePoller — one query per SCOPE, not per connection (8a)", function () {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("ten connections on one key share ONE readCursor call per tick", async function () {
        let reads = 0;
        const poller = new ScopedSsePoller({
            name: "t",
            pollIntervalMs: 1000,
            readCursor: () => {
                reads++;
                return "sig-1";
            },
        });
        const sink = [];
        const closers = [];
        for (let i = 0; i < 10; i++) {
            const res = makeRes(sink);
            closers.push(poller.open(res, { key: "acct:5", meta: { id: 5 } }));
        }

        await vi.advanceTimersByTimeAsync(1000); // one tick
        expect(reads).toBe(1); // ten connections, ONE query

        closers.forEach((c) => c());
    });

    it("a second distinct key costs exactly one more query per tick", async function () {
        let reads = 0;
        const poller = new ScopedSsePoller({
            name: "t",
            pollIntervalMs: 1000,
            readCursor: () => {
                reads++;
                return "sig";
            },
        });
        const sink = [];
        const a = poller.open(makeRes(sink), { key: "acct:1", meta: { id: 1 } });
        const b = poller.open(makeRes(sink), { key: "acct:2", meta: { id: 2 } });

        await vi.advanceTimersByTimeAsync(1000);
        expect(reads).toBe(2); // two scopes → two queries

        a();
        b();
    });
});

describe("ScopedSsePoller — scope isolation / bulkhead (8b)", function () {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("one scope's repeated failure does not evict a healthy scope", async function () {
        const poller = new ScopedSsePoller({
            name: "t",
            pollIntervalMs: 1000,
            maxPollErrors: 2,
            readCursor: (scope) => {
                if (scope.meta.id === "bad") throw new Error("db down");
                return "ok";
            },
        });
        const sink = [];
        const good = makeRes(sink);
        poller.open(good, { key: "good", meta: { id: "good" } });
        poller.open(makeRes(sink), { key: "bad", meta: { id: "bad" } });

        // Tick past the bad scope's error threshold.
        await vi.advanceTimersByTimeAsync(3000);

        // The bad scope was dropped (got an "error" event); the good scope is
        // still receiving heartbeats and never saw an error.
        const goodEvents = eventsFor(sink, good);
        expect(goodEvents).toContain("connected");
        expect(goodEvents).toContain("heartbeat");
        expect(goodEvents).not.toContain("error");
    });
});

describe("ScopedSsePoller — cache purge happens BEFORE the update broadcast (8c, blocking)", function () {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("onChange (purge) is called strictly before the client is told 'update'", async function () {
        const order = [];
        let cursor = "sig-0";
        const poller = new ScopedSsePoller({
            name: "t",
            pollIntervalMs: 1000,
            readCursor: () => cursor,
            onChange: () => order.push("purge"),
        });
        // A res whose write records the moment the "update" frame is emitted.
        const res = {
            setHeader() {},
            flushHeaders() {},
            flush() {},
            write(chunk) {
                if (/^event: update\n$/.test(chunk)) order.push("broadcast");
            },
        };
        poller.open(res, { key: "acct:9", meta: { id: 9 } });

        // Tick 1 locks in the baseline (no change yet).
        await vi.advanceTimersByTimeAsync(1000);
        expect(order).toEqual([]);

        // Now the ledger changes → next tick must purge THEN broadcast.
        cursor = "sig-1";
        await vi.advanceTimersByTimeAsync(1000);
        expect(order).toEqual(["purge", "broadcast"]);
    });

    it("a null cursor (gate closed / no rows) never counts as a change", async function () {
        let cursor = "sig-0";
        const changes = [];
        const poller = new ScopedSsePoller({
            name: "t",
            pollIntervalMs: 1000,
            readCursor: () => cursor,
            onChange: () => changes.push("changed"),
        });
        const sink = [];
        poller.open(makeRes(sink), { key: "k", meta: {} });

        await vi.advanceTimersByTimeAsync(1000); // baseline
        cursor = null; // gate closed
        await vi.advanceTimersByTimeAsync(1000);
        expect(changes).toEqual([]); // null is not a change
    });
});

describe("ScopedSsePoller — lifecycle: shared interval stops when the last scope closes", function () {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("stops polling once every connection has disconnected", async function () {
        let reads = 0;
        const poller = new ScopedSsePoller({
            name: "t",
            pollIntervalMs: 1000,
            readCursor: () => {
                reads++;
                return "s";
            },
        });
        const sink = [];
        const close = poller.open(makeRes(sink), { key: "k", meta: {} });

        await vi.advanceTimersByTimeAsync(1000);
        expect(reads).toBe(1);

        close(); // last connection gone → interval cleared
        await vi.advanceTimersByTimeAsync(5000);
        expect(reads).toBe(1); // no further polling
    });
});
