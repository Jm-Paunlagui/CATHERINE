/**
 * @fileoverview CacheMiddleware wave 2: read-through, coalescing, shouldCache,
 * stale-write guard and the three invalidation flavours.
 */
import { EventEmitter } from "events";

const log = vi.hoisted(() => ({ notice: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock("../../../../src/utils/logger", () => ({ logger: log }));

import { CacheMiddleware } from "../../../../src/middleware/cache/CacheMiddleware";
import { CacheStore } from "../../../../src/middleware/cache/CacheStore";
import { runInScope } from "../../../../src/utils/progress/progress";

function mkRes() {
    const res: any = new EventEmitter();
    res.statusCode = 200;
    res.hdrs = {};
    res.set = (k: string, v: string) => { res.hdrs[k] = v; };
    res.json = vi.fn((d: unknown) => { res.sent = d; return res; });
    return res;
}
const req = (method = "GET") => ({ method }) as any;
const tick = () => new Promise<void>((r) => setImmediate(r));

describe("CacheMiddleware.read", () => {
    let store: CacheStore;
    beforeEach(() => {
        store = new CacheStore("w2-" + Math.random().toString(36).slice(2), { ttl: 0 });
        CacheMiddleware._inflight.clear();
        Object.values(log).forEach((f) => f.mockClear());
    });

    it("bypasses write verbs and custom bypass methods", async () => {
        const next = vi.fn();
        await CacheMiddleware.read(store, () => "k")(req("POST"), mkRes(), next);
        await CacheMiddleware.read(store, () => "k", { bypassMethods: ["GET"] })(req("GET"), mkRes(), next);
        expect(next).toHaveBeenCalledTimes(2);
        expect(CacheMiddleware._inflight.size).toBe(0);
    });

    it("a throwing keyFn is logged and bypassed", async () => {
        const next = vi.fn();
        await CacheMiddleware.read(store, () => { throw new Error("bad key"); })(req(), mkRes(), next);
        expect(next).toHaveBeenCalled();
        expect(log.warning).toHaveBeenCalled();
    });

    it("MISS stores a 2xx JSON body and the next call is a HIT", async () => {
        const mw = CacheMiddleware.read(store, () => "k");
        const res = mkRes();
        const next = vi.fn();
        await mw(req(), res, next);
        expect(res.hdrs["X-Cache"]).toBe("MISS");
        expect(res.hdrs["X-Cache-Key"]).toBe("k");
        res.json({ a: 1 });
        res.emit("close");
        expect(store.get("k")).toEqual({ a: 1 });

        const res2 = mkRes();
        const next2 = vi.fn();
        await mw(req(), res2, next2);
        expect(next2).not.toHaveBeenCalled();
        expect(res2.hdrs["X-Cache"]).toBe("HIT");
        expect(res2.sent).toEqual({ a: 1 });
    });

    it("setHeaders:false suppresses X-Cache headers on MISS and HIT", async () => {
        const mw = CacheMiddleware.read(store, () => "k", { setHeaders: false });
        const res = mkRes();
        await mw(req(), res, vi.fn());
        res.json({ a: 1 });
        res.emit("close");
        const hit = mkRes();
        await mw(req(), hit, vi.fn());
        expect(res.hdrs).toEqual({});
        expect(hit.hdrs).toEqual({});
    });

    it("does not cache non-2xx or when shouldCache says no, and honours ttl", async () => {
        const setSpy = vi.spyOn(store, "set");
        const mw = CacheMiddleware.read(store, () => "k", { shouldCache: (_r, b: any) => b.ok, ttl: 9 });
        const bad = mkRes(); bad.statusCode = 500;
        await mw(req(), bad, vi.fn());
        bad.json({ ok: true }); bad.emit("close");
        const skip = mkRes();
        await mw(req(), skip, vi.fn());
        skip.json({ ok: false }); skip.emit("close");
        expect(setSpy).not.toHaveBeenCalled();
        const good = mkRes();
        await mw(req(), good, vi.fn());
        good.json({ ok: true }); good.emit("close");
        expect(setSpy).toHaveBeenCalledWith("k", { ok: true }, 9);
    });

    it("stale-write guard: skips the store write when the store was flushed mid-request", async () => {
        const mw = CacheMiddleware.read(store, () => "k");
        const res = mkRes();
        await mw(req(), res, vi.fn());
        store.flush();
        res.json({ stale: true });
        res.emit("close");
        expect(store.get("k")).toBeUndefined();
        expect(log.debug).toHaveBeenCalled();
    });

    it("coalesces followers behind one leader (COALESCED) and releases on close", async () => {
        const mw = CacheMiddleware.read(store, () => "k");
        const lead = mkRes(), f1 = mkRes(), f2 = mkRes();
        const nextLead = vi.fn(), n1 = vi.fn(), n2 = vi.fn();
        await mw(req(), lead, nextLead);
        const p1 = mw(req(), f1, n1);
        const p2 = mw(req(), f2, n2);
        expect(CacheMiddleware._inflight.size).toBe(1);
        lead.json({ v: 1 });
        lead.emit("close");
        await Promise.all([p1, p2]);
        expect(n1).not.toHaveBeenCalled();
        expect(f1.hdrs["X-Cache"]).toBe("COALESCED");
        expect(f2.sent).toEqual({ v: 1 });
        expect(CacheMiddleware._inflight.size).toBe(0);
    });

    it("coalesced followers honour setHeaders:false", async () => {
        const mw = CacheMiddleware.read(store, () => "k", { setHeaders: false });
        const lead = mkRes(), f = mkRes();
        await mw(req(), lead, vi.fn());
        const p = mw(req(), f, vi.fn());
        lead.json({ v: 1 }); lead.emit("close");
        await p;
        expect(f.hdrs).toEqual({});
        expect(f.sent).toEqual({ v: 1 });
    });

    it("coalesce:false never registers a flight", async () => {
        const mw = CacheMiddleware.read(store, () => "k", { coalesce: false });
        const a = mkRes(), b = mkRes();
        const na = vi.fn(), nb = vi.fn();
        await mw(req(), a, na);
        await mw(req(), b, nb);
        expect(na).toHaveBeenCalled();
        expect(nb).toHaveBeenCalled();
        expect(CacheMiddleware._inflight.size).toBe(0);
    });

    it("failed leader: one follower becomes the new leader, the other waits on it", async () => {
        const mw = CacheMiddleware.read(store, () => "k");
        const lead = mkRes(), f1 = mkRes(), f2 = mkRes();
        const n1 = vi.fn(), n2 = vi.fn();
        await mw(req(), lead, vi.fn());
        const p1 = mw(req(), f1, n1);
        const p2 = mw(req(), f2, n2);
        lead.statusCode = 500;
        lead.emit("close"); // leader failed, nothing cached
        await tick();
        // f1 woke first and became leader (controller runs); f2 waits on it
        expect(n1).toHaveBeenCalledOnce();
        expect(n2).not.toHaveBeenCalled();
        f1.json({ ok: 1 });
        f1.emit("close");
        await Promise.all([p1, p2]);
        expect(f2.hdrs["X-Cache"]).toBe("COALESCED");
        expect(f2.sent).toEqual({ ok: 1 });
    });

    it("second wait also fails: the follower runs the controller itself", async () => {
        const mw = CacheMiddleware.read(store, () => "k");
        const lead = mkRes(), f1 = mkRes(), f2 = mkRes();
        const n1 = vi.fn(), n2 = vi.fn();
        await mw(req(), lead, vi.fn());
        const p1 = mw(req(), f1, n1);
        const p2 = mw(req(), f2, n2);
        lead.emit("close");
        await tick();
        f1.statusCode = 503;
        f1.emit("close");
        await Promise.all([p1, p2]);
        expect(n2).toHaveBeenCalledOnce();
    });

    it("followers follow and unfollow the leader's progress scope", async () => {
        const mw = CacheMiddleware.read(store, () => "k");
        const leaderScope: any = { follow: vi.fn(), unfollow: vi.fn(), touch: vi.fn() };
        const followerScope: any = { follow: vi.fn(), unfollow: vi.fn(), touch: vi.fn() };
        const lead = mkRes(), f = mkRes();
        await runInScope(leaderScope, () => mw(req(), lead, vi.fn()) as Promise<void>);
        const p = runInScope(followerScope, () => mw(req(), f, vi.fn()) as Promise<void>);
        lead.json({ v: 1 }); lead.emit("close");
        await p;
        expect(followerScope.follow).toHaveBeenCalledWith(leaderScope);
        expect(followerScope.unfollow).toHaveBeenCalled();
        expect(followerScope.touch).toHaveBeenCalledWith("coalesce-wake");
    });

    it("followers on a failed leader also follow the replacement leader's scope", async () => {
        const mw = CacheMiddleware.read(store, () => "k");
        const mk = (): any => ({ follow: vi.fn(), unfollow: vi.fn(), touch: vi.fn() });
        const s0 = mk(), s1 = mk(), s2 = mk();
        const lead = mkRes(), f1 = mkRes(), f2 = mkRes();
        await runInScope(s0, () => mw(req(), lead, vi.fn()) as Promise<void>);
        const p1 = runInScope(s1, () => mw(req(), f1, vi.fn()) as Promise<void>);
        const p2 = runInScope(s2, () => mw(req(), f2, vi.fn()) as Promise<void>);
        lead.emit("close");
        await tick();
        f1.json({ ok: 1 }); f1.emit("close");
        await Promise.all([p1, p2]);
        expect(s2.follow).toHaveBeenCalledTimes(2);
    });
});

describe("CacheMiddleware invalidation", () => {
    let a: CacheStore, b: CacheStore;
    beforeEach(() => {
        a = new CacheStore("inv-a-" + Math.random());
        b = new CacheStore("inv-b-" + Math.random());
        Object.values(log).forEach((f) => f.mockClear());
    });

    it("invalidate: exact keys, multiple stores, only after 2xx", async () => {
        a.set("x", 1); a.set("y", 2); b.set("x", 1);
        const mw = CacheMiddleware.invalidate([a, b], () => ["x", "y"]);
        const res = mkRes();
        const next = vi.fn();
        mw(req("POST"), res, next);
        expect(next).toHaveBeenCalled();
        res.json({ ok: true });
        await tick();
        expect(a.keys()).toEqual([]);
        expect(b.keys()).toEqual([]);

        a.set("x", 1);
        const bad = mkRes(); bad.statusCode = 400;
        CacheMiddleware.invalidate(a, () => "x")(req("POST"), bad, vi.fn());
        bad.json({});
        await tick();
        expect(a.has("x")).toBe(true);
    });

    it("invalidate: pattern mode with array and single targets, null no-op, keyFn error logged", async () => {
        a.set("users:1", 1); a.set("users:2", 2); a.set("other", 3);
        const res = mkRes();
        CacheMiddleware.invalidate(a, () => ["users:", "other"], { usePattern: true })(req("POST"), res, vi.fn());
        res.json({});
        await tick();
        expect(a.keys()).toEqual([]);

        a.set("users:1", 1);
        const single = mkRes();
        CacheMiddleware.invalidate(a, () => "users:", { usePattern: true })(req("POST"), single, vi.fn());
        single.json({});
        await tick();
        expect(a.keys()).toEqual([]);

        a.set("keep", 1);
        const nul = mkRes();
        CacheMiddleware.invalidate(a, () => null)(req("POST"), nul, vi.fn());
        nul.json({});
        await tick();
        expect(a.has("keep")).toBe(true);

        const err = mkRes();
        CacheMiddleware.invalidate(a, () => { throw new Error("kf"); })(req("POST"), err, vi.fn());
        err.json({});
        await tick();
        expect(log.error).toHaveBeenCalled();
    });

    it("invalidate with a single string key (non-array target)", async () => {
        a.set("solo", 1);
        const res = mkRes();
        CacheMiddleware.invalidate(a, () => "solo")(req("DELETE"), res, vi.fn());
        res.json({});
        await tick();
        expect(a.has("solo")).toBe(false);
    });

    it("invalidateOnFinish: 2xx only, array/single/empty/null targets, pattern mode, error logged", () => {
        a.set("k1", 1); a.set("k2", 2); a.set("p:1", 3);
        const run = (fn: any, opts: any, status = 200) => {
            const res = mkRes(); res.statusCode = status;
            const next = vi.fn();
            CacheMiddleware.invalidateOnFinish(a, fn, opts)(req("GET"), res, next);
            expect(next).toHaveBeenCalled();
            res.emit("finish");
        };
        run(() => "k1", {}, 500);
        expect(a.has("k1")).toBe(true);
        run(() => "k1", {});
        expect(a.has("k1")).toBe(false);
        run(() => [], {});
        run(() => null, {});
        expect(a.has("k2")).toBe(true);
        run(() => ["k2"], {});
        expect(a.has("k2")).toBe(false);
        run(() => ["p:"], { usePattern: true });
        expect(a.has("p:1")).toBe(false);
        run(() => { throw new Error("x"); }, {});
        expect(log.error).toHaveBeenCalled();
        run(() => "k1", {}, 199);
    });

    it("invalidateWhere: predicate delete after 2xx only; predicate error logged", async () => {
        a.set("a1", 1); a.set("b1", 2);
        const res = mkRes();
        CacheMiddleware.invalidateWhere([a], (k) => k.startsWith("a"))(req("POST"), res, vi.fn());
        res.json({});
        await tick();
        expect(a.keys()).toEqual(["b1"]);

        const bad = mkRes(); bad.statusCode = 404;
        CacheMiddleware.invalidateWhere(a, () => true)(req("POST"), bad, vi.fn());
        bad.json({});
        await tick();
        expect(a.has("b1")).toBe(true);

        const err = mkRes();
        CacheMiddleware.invalidateWhere(a, () => { throw new Error("p"); })(req("POST"), err, vi.fn());
        err.json({});
        await tick();
        expect(log.error).toHaveBeenCalled();
    });
});
