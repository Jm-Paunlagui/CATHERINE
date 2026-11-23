import NodeCache from "node-cache";
import { SlidingWindowCounter } from "../../../../src/middleware/security/SlidingWindowCounter";

const W = 1000;

describe("SlidingWindowCounter", () => {
    let c: SlidingWindowCounter;
    beforeEach(() => {
        c = new SlidingWindowCounter();
    });
    afterEach(() => c.close());

    it("admits up to max within a window, then refuses with retryAt", () => {
        const a = c.hit("k", 2, W, 0);
        expect(a).toMatchObject({ allowed: true, count: 1, remaining: 1, resetAt: 1000, bucket: 0 });
        c.hit("k", 2, W, 1);
        const r = c.hit("k", 2, W, 2);
        expect(r).toMatchObject({ allowed: false, remaining: 0, resetAt: 1000 });
        // current window spent: retry lands in the following window
        expect(r.retryAt).toBeGreaterThan(1000);
        expect(c.hit("k", 2, W, r.retryAt as number).allowed).toBe(true);
    });

    it("weights the previous window (retryAt inside current window)", () => {
        c.hit("k", 4, W, 0);
        c.hit("k", 4, W, 1);
        c.hit("k", 4, W, 2);
        c.hit("k", 4, W, 3);
        c.hit("k", 4, W, 1000); // curr=1, prev=4
        const r = c.hit("k", 4, W, 1001);
        expect(r.allowed).toBe(true);
        c.hit("k", 4, W, 1002);
        const blocked = c.hit("k", 4, W, 1003);
        expect(blocked.allowed).toBe(false);
        expect(blocked.retryAt).toBeGreaterThan(1003);
        expect(blocked.retryAt).toBeLessThanOrEqual(2000);
    });

    it("keeps keys independent", () => {
        c.hit("a", 1, W, 0);
        expect(c.hit("a", 1, W, 1).allowed).toBe(false);
        expect(c.hit("b", 1, W, 1).allowed).toBe(true);
    });

    describe("refund", () => {
        it("deletes a bucket holding one hit", () => {
            const h = c.hit("k", 1, W, 0);
            expect(c.refund("k", h.bucket as number, W, 5)).toBe(true);
            expect(c.hit("k", 1, W, 6).allowed).toBe(true);
        });

        it("decrements a bucket holding several hits", () => {
            c.hit("k", 5, W, 0);
            const h = c.hit("k", 5, W, 1);
            expect(c.refund("k", h.bucket as number, W, 2)).toBe(true);
            expect(c.store.get("k:0")).toBe(1);
        });

        it("is a no-op for aged-out, missing or non-finite buckets", () => {
            const h = c.hit("k", 5, W, 0);
            expect(c.refund("k", h.bucket as number, W, 5000)).toBe(false);
            expect(c.refund("k", NaN, W, 5)).toBe(false);
            expect(c.refund("nope", 0, W, 5)).toBe(false);
        });
    });

    it("del, flushAll, size, stats and close work", () => {
        c.hit("a", 5, W, 0);
        c.hit("b", 5, W, 0);
        expect(c.size).toBe(2);
        expect(c.del("a:0")).toBe(1);
        expect(c.getStats()).toHaveProperty("keys");
        c.flushAll();
        expect(c.size).toBe(0);
    });

    it("uses an injected store and tolerates one without close()", () => {
        const store = new NodeCache();
        const c2 = new SlidingWindowCounter({ store });
        expect(c2.store).toBe(store);
        const bare = new SlidingWindowCounter({ store: { close: undefined } as unknown as NodeCache });
        expect(() => bare.close()).not.toThrow();
        store.close();
    });

    it("throws from set once maxKeys is exceeded (store-full failure mode)", () => {
        const small = new SlidingWindowCounter({ maxKeys: 1 });
        small.hit("a", 5, W, 0);
        expect(() => small.hit("b", 5, W, 0)).toThrow();
        small.close();
    });
});
