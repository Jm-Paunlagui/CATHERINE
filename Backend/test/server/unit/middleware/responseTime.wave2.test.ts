/**
 * @fileoverview ResponseTimeMiddleware: header, per-route aggregation,
 * slow thresholds, preflight exclusion and reporting helpers.
 */
import { EventEmitter } from "events";

const warn = vi.hoisted(() => vi.fn());
vi.mock("../../../../src/utils/logger", () => ({
    logger: { warning: warn, info: vi.fn(), error: vi.fn(), debug: vi.fn(), notice: vi.fn() },
}));

import { ResponseTimeMiddleware, defaultResponseTime } from "../../../../src/middleware/performance/ResponseTimeMiddleware";

let clock = 0n;
function makeRes(headers: Record<string, string> = {}) {
    const res: any = new EventEmitter();
    res.headersSent = false;
    res.hdrs = { ...headers };
    res.getHeader = (k: string) => res.hdrs[k];
    res.setHeader = (k: string, v: string) => { res.hdrs[k] = v; };
    res.writeHead = vi.fn(function () { return res; });
    return res;
}
const makeReq = (method = "GET", path = "/api/v1/x") =>
    ({ method, originalUrl: path, baseUrl: "/api/v1", route: { path: "/x" }, path, headers: {} }) as any;

describe("ResponseTimeMiddleware", () => {
    let spy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
        clock = 0n;
        warn.mockClear();
        spy = vi.spyOn(process.hrtime, "bigint").mockImplementation(() => clock);
    });
    afterEach(() => spy.mockRestore());

    function run(mw: ResponseTimeMiddleware, req: any, res: any, ms: number) {
        const next = vi.fn();
        clock = 0n;
        mw.handle(req, res, next);
        expect(next).toHaveBeenCalledOnce();
        clock = BigInt(ms) * 1_000_000n;
        res.writeHead(200);
        res.emit("finish");
    }

    it("defaults thresholds to 1000/3000", () => {
        expect(defaultResponseTime._slowThreshold).toBe(1000);
        expect(defaultResponseTime._verySlowThreshold).toBe(3000);
    });

    it("sets X-Response-Time in writeHead and forwards the original call", () => {
        const mw = new ResponseTimeMiddleware();
        const res = makeRes();
        const orig = res.writeHead;
        run(mw, makeReq(), res, 42);
        expect(res.hdrs["X-Response-Time"]).toBe("42ms");
        expect(orig).toHaveBeenCalledWith(200, undefined, undefined);
    });

    it("keeps an existing X-Response-Time and skips when headers already sent", () => {
        const mw = new ResponseTimeMiddleware();
        const preset = makeRes({ "X-Response-Time": "7ms" });
        run(mw, makeReq(), preset, 50);
        expect(preset.hdrs["X-Response-Time"]).toBe("7ms");

        const sent = makeRes();
        sent.headersSent = true;
        run(mw, makeReq(), sent, 50);
        expect(sent.hdrs["X-Response-Time"]).toBeUndefined();
    });

    it("aggregates count, min, max and counts slow and very slow requests", () => {
        const mw = new ResponseTimeMiddleware({ slowThreshold: 100, verySlowThreshold: 500 });
        run(mw, makeReq(), makeRes(), 50);
        run(mw, makeReq(), makeRes(), 200);
        run(mw, makeReq(), makeRes(), 800);
        const m = mw.getPerformanceMetrics();
        const entry: any = Object.values(m)[0];
        expect(entry.count).toBe(3);
        expect(entry.minTime).toBe(50);
        expect(entry.maxTime).toBe(800);
        expect(entry.slowCount).toBe(2);
        expect(entry.verySlowCount).toBe(1);
        expect(entry.avgTime).toBe(350);
        expect(entry.slowRate).toBe("66.67%");
        expect(entry.verySlowRate).toBe("33.33%");
        expect(warn).toHaveBeenCalledTimes(2);
    });

    it("does not warn for a fast request", () => {
        const mw = new ResponseTimeMiddleware({ slowThreshold: 100 });
        run(mw, makeReq(), makeRes(), 10);
        expect(warn).not.toHaveBeenCalled();
    });

    it("excludes CORS preflights from aggregation but still sets the header", () => {
        const mw = new ResponseTimeMiddleware();
        const req = makeReq("OPTIONS");
        req.headers = { origin: "http://x", "access-control-request-method": "POST" };
        const res = makeRes();
        run(mw, req, res, 5);
        expect(res.hdrs["X-Response-Time"]).toBe("5ms");
        expect(mw.getPerformanceMetrics()).toEqual({});
    });

    it("getSlowRoutes reports by average or slow rate, sorted desc", () => {
        const mw = new ResponseTimeMiddleware({ slowThreshold: 100, verySlowThreshold: 500 });
        const reqA = makeReq(); reqA.route = { path: "/a" };
        const reqB = makeReq(); reqB.route = { path: "/b" };
        const reqC = makeReq(); reqC.route = { path: "/c" };
        run(mw, reqA, makeRes(), 300);
        run(mw, reqB, makeRes(), 900);
        run(mw, reqC, makeRes(), 10);
        const slow = mw.getSlowRoutes();
        expect(slow.map((r) => r.avgTime)).toEqual([900, 300]);
        expect(slow[0].totalRequests).toBe(1);
        expect(slow[0].slowRate).toBe("100.00%");
    });

    it("a route under threshold but with >10% slow hits is still reported", () => {
        const mw = new ResponseTimeMiddleware({ slowThreshold: 100 });
        const req = makeReq();
        for (let i = 0; i < 8; i++) run(mw, req, makeRes(), 10);
        run(mw, req, makeRes(), 150);
        run(mw, req, makeRes(), 150);
        const slow = mw.getSlowRoutes();
        expect(slow).toHaveLength(1);
        expect(slow[0].slowRate).toBe("20.00%");
    });

    it("resetMetrics clears everything", () => {
        const mw = new ResponseTimeMiddleware();
        run(mw, makeReq(), makeRes(), 5);
        mw.resetMetrics();
        expect(mw.getPerformanceMetrics()).toEqual({});
        expect(mw.getSlowRoutes()).toEqual([]);
    });
});
