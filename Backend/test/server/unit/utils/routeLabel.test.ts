import { buildRouteLabel, captureRouteLabel, resolveRouteLabel, shouldRecordRouteMetrics, UNMATCHED_ROUTE_LABEL } from "../../../../src/utils/routeLabel";

const req = (o: Record<string, unknown>) => o as never;

describe("buildRouteLabel", () => {
    it("labels unmatched requests with a fixed token, never the raw URL", () => {
        expect(buildRouteLabel(req({ method: "GET", originalUrl: "/secret/123" }))).toBe(`GET ${UNMATCHED_ROUTE_LABEL}`);
        expect(buildRouteLabel(req({ method: "GET", route: { path: null } }))).toBe("GET UNMATCHED");
    });
    it("joins baseUrl and route path, keeping param tokens", () => {
        expect(buildRouteLabel(req({ method: "POST", baseUrl: "/api/v1/u", route: { path: "/:id/x" } }))).toBe("POST /api/v1/u/:id/x");
    });
    it("strips the trailing slash of a mounted root route and keeps '/' at app root", () => {
        expect(buildRouteLabel(req({ method: "GET", baseUrl: "/api/v1/u", route: { path: "/" } }))).toBe("GET /api/v1/u");
        expect(buildRouteLabel(req({ method: "GET", baseUrl: "", originalUrl: "/", route: { path: "/" } }))).toBe("GET /");
    });
    it("uses the first entry of an array of paths", () => {
        expect(buildRouteLabel(req({ method: "GET", baseUrl: "/a", route: { path: ["/one", "/two"] } }))).toBe("GET /a/one");
    });
    it("reconstructs a cleared baseUrl from originalUrl and params", () => {
        expect(buildRouteLabel(req({ method: "GET", baseUrl: "", originalUrl: "/api/v1/u/42/hist?x=1", params: { id: "42" }, route: { path: "/:id/hist" } }))).toBe("GET /api/v1/u/:id/hist");
        expect(buildRouteLabel(req({ method: "GET", baseUrl: "", originalUrl: "/api/v1/u/?q=1", route: { path: "/" } }))).toBe("GET /api/v1/u");
    });
    it("handles optional params, missing params, and undecodable sequences", () => {
        expect(buildRouteLabel(req({ method: "GET", baseUrl: "", originalUrl: "/m/7", params: { id: "7" }, route: { path: "/:id?" } }))).toBe("GET /m/:id?");
        expect(buildRouteLabel(req({ method: "GET", baseUrl: "", originalUrl: "/m/:id", route: { path: "/:id" } }))).toBe("GET /m/:id");
        expect(buildRouteLabel(req({ method: "GET", baseUrl: "", originalUrl: "/m/%E0%A4/x", params: { v: "%E0%A4" }, route: { path: "/:v/x" } }))).toBe("GET /m/:v/x");
    });
    it("falls back to the bare route when the tail cannot be located", () => {
        expect(buildRouteLabel(req({ method: "GET", baseUrl: "", originalUrl: "/other", params: {}, route: { path: "/zzz" } }))).toBe("GET /zzz");
        expect(buildRouteLabel(req({ method: "GET", baseUrl: "", route: { path: "/zzz" } }))).toBe("GET /zzz");
        expect(buildRouteLabel(req({ method: "GET", baseUrl: "", url: "/p/q", route: { path: "/q" } }))).toBe("GET /p/q");
    });
});

describe("captureRouteLabel / resolveRouteLabel", () => {
    it("memoises once while the route is live and ignores later changes", () => {
        const r: Record<string, any> = { method: "GET", baseUrl: "/a", route: { path: "/b" } };
        captureRouteLabel(req(r));
        r.baseUrl = "/changed";
        captureRouteLabel(req(r));
        expect(r._routeLabel).toBe("GET /a/b");
        expect(resolveRouteLabel(req(r))).toBe("GET /a/b");
    });
    it("does not capture without a route, and resolve builds on demand", () => {
        const r: Record<string, any> = { method: "GET" };
        captureRouteLabel(req(r));
        expect(r._routeLabel).toBeUndefined();
        expect(resolveRouteLabel(req(r))).toBe("GET UNMATCHED");
    });
});

describe("shouldRecordRouteMetrics", () => {
    it("excludes preflights and observability self-traffic but not siblings", () => {
        expect(shouldRecordRouteMetrics(req({ method: "OPTIONS", originalUrl: "/x" }))).toBe(false);
        expect(shouldRecordRouteMetrics(req({ method: "GET", originalUrl: "/api/v1/metrics?x=1" }))).toBe(false);
        expect(shouldRecordRouteMetrics(req({ method: "GET", url: "/api/v1/audit-logs/stream" }))).toBe(false);
        expect(shouldRecordRouteMetrics(req({ method: "GET", path: "/api/v1/audit-logs" }))).toBe(false);
        expect(shouldRecordRouteMetrics(req({ method: "GET", originalUrl: "/api/v1/audit-logs-export" }))).toBe(true);
        expect(shouldRecordRouteMetrics(req({ method: "GET" }))).toBe(true);
    });
});
