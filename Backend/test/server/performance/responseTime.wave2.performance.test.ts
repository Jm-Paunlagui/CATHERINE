/**
 * @fileoverview Performance: ResponseTimeMiddleware overhead and bounded state.
 */
import { EventEmitter } from "events";
import { ResponseTimeMiddleware } from "../../../src/middleware/performance/ResponseTimeMiddleware";

function drive(mw: ResponseTimeMiddleware, path: string) {
    const res: any = new EventEmitter();
    const h: Record<string, string> = {};
    res.headersSent = false;
    res.getHeader = (k: string) => h[k];
    res.setHeader = (k: string, v: string) => { h[k] = v; };
    res.writeHead = function () { return res; };
    const req: any = { method: "GET", originalUrl: path, baseUrl: "/api/v1", route: { path }, path, headers: {} };
    mw.handle(req, res, () => {});
    res.writeHead(200);
    res.emit("finish");
}

describe("ResponseTimeMiddleware performance", () => {
    it("handles 20k requests on one route in constant state", () => {
        const mw = new ResponseTimeMiddleware({ slowThreshold: 60_000, verySlowThreshold: 120_000 });
        const t0 = performance.now();
        for (let i = 0; i < 20000; i++) drive(mw, "/hot");
        const elapsed = performance.now() - t0;
        const metrics: any = mw.getPerformanceMetrics();
        expect(Object.keys(metrics)).toHaveLength(1);
        expect(Object.values(metrics)[0]).toMatchObject({ count: 20000, slowCount: 0 });
        expect(elapsed).toBeLessThan(5000);
    });

    it("state grows with distinct route labels only, not with request count", () => {
        const mw = new ResponseTimeMiddleware();
        for (let i = 0; i < 500; i++) drive(mw, `/r${i % 25}`);
        expect(Object.keys(mw.getPerformanceMetrics())).toHaveLength(25);
    });
});
