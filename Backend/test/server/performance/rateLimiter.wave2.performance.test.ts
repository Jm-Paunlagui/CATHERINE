/**
 * @fileoverview Performance: RateLimiterMiddleware per-key memory is O(1) and
 * the hot path stays cheap under many distinct keys and a hot key.
 */
import { RateLimiterMiddleware } from "../../../src/middleware/security/RateLimiterMiddleware";

const res = () => {
    const r: any = { locals: {}, setHeader() {}, status() { return r; }, json() { return r; }, once() {} };
    return r;
};

describe("RateLimiter performance", () => {
    it("20k hits on one key keep a constant number of store entries", () => {
        const m = new RateLimiterMiddleware({ max: 1_000_000, windowMs: 60_000 });
        const req: any = { method: "GET", path: "/p", ip: "1.1.1.1", headers: {}, socket: {} };
        const t0 = performance.now();
        for (let i = 0; i < 20000; i++) m.handle(req, res(), () => {});
        expect(performance.now() - t0).toBeLessThan(5000);
        expect(m._store.keys().length).toBeLessThanOrEqual(2);
    });

    it("5k distinct keys use at most two window entries each", () => {
        const m = new RateLimiterMiddleware({ max: 10, windowMs: 60_000 });
        for (let i = 0; i < 5000; i++) {
            m.handle({ method: "GET", path: "/p", ip: `10.0.${i >> 8}.${i & 255}`, headers: {}, socket: {} } as any, res(), () => {});
        }
        expect(m._store.keys().length).toBeLessThanOrEqual(10000);
    });

    it("a refused flood stays refused and does not grow the store", () => {
        const m = new RateLimiterMiddleware({ max: 1, windowMs: 60_000 });
        const req: any = { method: "GET", path: "/p", ip: "2.2.2.2", headers: {}, socket: {} };
        m.handle(req, res(), () => {});
        const before = m._store.keys().length;
        let passed = 0;
        for (let i = 0; i < 5000; i++) m.handle(req, res(), () => { passed++; });
        expect(passed).toBe(0);
        expect(m._store.keys().length).toBe(before);
    });
});
