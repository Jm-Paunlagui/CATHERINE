"use strict";

/**
 * @fileoverview Unit tests for observability route-label correctness.
 *
 * Regression coverage for the Logging & Observability dashboard bug where:
 *   - Route labels were built from req.route.path alone, which EXCLUDES the
 *     Express mount prefix — so POST /api/v1/pay-period/save,
 *     POST /api/v1/rfid-management/save and POST /api/v1/subsidy-management/save
 *     all collapsed into a single "POST /save" row.
 *   - OPTIONS (CORS preflight) requests fell back to the raw URL (no req.route
 *     before routing), leaking unparameterized concrete paths such as
 *     "OPTIONS /api/v1/rfid-management/90603664/13761/history" into labels
 *     (cardinality explosion + PII exposure, CWE-200/CWE-400).
 *
 * Verifies:
 *   (a) mounted router paths produce full "baseUrl + route.path" labels
 *   (b) OPTIONS requests are excluded from route metrics entirely
 *   (c) Express param tokens are preserved (raw values never recorded)
 *   (d) unmatched requests (404) aggregate under UNMATCHED — never raw paths
 *   (e) MetricsMiddleware and ResponseTimeMiddleware emit identical keys
 *   (f) buildRouteLabel() pure-function edge cases (root mounts, trailing slash)
 *
 * Uses a scratch Express app (real routers — req.baseUrl/req.route semantics
 * must be genuine) with a sinon-faked store injected via the constructor.
 * No .env reads; no shared singletons.
 */

const { expect } = require("chai");
const sinon = require("sinon");
const express = require("express");
const request = require("supertest");

const {
  buildRouteLabel,
  shouldRecordRouteMetrics,
  UNMATCHED_ROUTE_LABEL,
} = require("../../../../src/utils/routeLabel");
const {
  MetricsMiddleware,
} = require("../../../../src/middleware/metrics/MetricsMiddleware");
const {
  ResponseTimeMiddleware,
} = require("../../../../src/middleware/performance/ResponseTimeMiddleware");

// ── Test app factory ──────────────────────────────────────────────────────────

/**
 * Build a minimal Express app mirroring the real mount layout:
 * three feature routers sharing local paths ("/save", "/verify", "/"),
 * plus a parameterized history route.
 *
 * @param {object} fakeStore        - Object with a recordRequest spy (MetricsStore shape).
 * @param {ResponseTimeMiddleware} rt - Fresh ResponseTimeMiddleware instance.
 * @returns {import('express').Express}
 */
function buildApp(fakeStore, rt) {
  const app = express();

  const metrics = new MetricsMiddleware(fakeStore);
  app.use(metrics.handle);
  app.use(rt.handle);

  const ok = (_req, res) => res.json({ ok: true });

  const payPeriod = express.Router();
  payPeriod.get("/", ok);
  payPeriod.post("/save", ok);
  payPeriod.post("/verify", ok);

  const rfid = express.Router();
  rfid.post("/save", ok);
  rfid.get("/:gid/:cardNumber/history", ok);

  const subsidy = express.Router();
  subsidy.post("/save", ok);

  app.use("/api/v1/pay-period", payPeriod);
  app.use("/api/v1/rfid-management", rfid);
  app.use("/api/v1/subsidy-management", subsidy);

  return app;
}

/** Let the res "finish" handlers run before asserting. */
function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

// ═══════════════════════════════════════════════════════════════════════════════
// buildRouteLabel() — pure function contract
// ═══════════════════════════════════════════════════════════════════════════════

describe("routeLabel.buildRouteLabel()", function () {
  it("joins baseUrl and route path for mounted routers", function () {
    const req = {
      method: "POST",
      baseUrl: "/api/v1/pay-period",
      route: { path: "/save" },
    };
    expect(buildRouteLabel(req)).to.equal("POST /api/v1/pay-period/save");
  });

  it('collapses route path "/" to the bare mount path (no trailing slash)', function () {
    const req = {
      method: "GET",
      baseUrl: "/api/v1/pay-period",
      route: { path: "/" },
    };
    expect(buildRouteLabel(req)).to.equal("GET /api/v1/pay-period");
  });

  it('keeps "/" when the route is mounted at the app root', function () {
    const req = { method: "GET", baseUrl: "", route: { path: "/" } };
    expect(buildRouteLabel(req)).to.equal("GET /");
  });

  it("preserves Express param tokens", function () {
    const req = {
      method: "GET",
      baseUrl: "/api/v1/rfid-management",
      route: { path: "/:gid/:cardNumber/history" },
    };
    expect(buildRouteLabel(req)).to.equal(
      "GET /api/v1/rfid-management/:gid/:cardNumber/history",
    );
  });

  it("returns the UNMATCHED label when no route matched — never the raw URL", function () {
    const req = {
      method: "GET",
      baseUrl: "",
      route: undefined,
      path: "/api/v1/rfid-management/90603664/13761/history",
      originalUrl: "/api/v1/rfid-management/90603664/13761/history",
    };
    const label = buildRouteLabel(req);
    expect(label).to.equal(`GET ${UNMATCHED_ROUTE_LABEL}`);
    expect(label).to.not.include("90603664");
  });

  it("uses the first entry when a route was registered with an array of paths", function () {
    const req = {
      method: "GET",
      baseUrl: "/api/v1/misc",
      route: { path: ["/a", "/b"] },
    };
    expect(buildRouteLabel(req)).to.equal("GET /api/v1/misc/a");
  });
});

describe("routeLabel.shouldRecordRouteMetrics()", function () {
  it("excludes OPTIONS requests", function () {
    expect(shouldRecordRouteMetrics({ method: "OPTIONS" })).to.be.false;
  });

  it("includes all business methods", function () {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]) {
      expect(shouldRecordRouteMetrics({ method })).to.be.true;
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// MetricsMiddleware — recorded labels through a real Express router stack
// ═══════════════════════════════════════════════════════════════════════════════

describe("MetricsMiddleware — route labels (mounted routers)", function () {
  let fakeStore;
  let rt;
  let app;

  beforeEach(function () {
    fakeStore = { recordRequest: sinon.spy() };
    rt = new ResponseTimeMiddleware({ slowThreshold: 60_000 });
    app = buildApp(fakeStore, rt);
  });

  /** All route labels recorded so far. */
  const recordedRoutes = () => fakeStore.recordRequest.args.map((a) => a[0]);

  it("records full mounted paths — sibling routers' /save never collapse", async function () {
    await request(app).post("/api/v1/pay-period/save").send({});
    await request(app).post("/api/v1/rfid-management/save").send({});
    await request(app).post("/api/v1/subsidy-management/save").send({});
    await tick();

    expect(recordedRoutes()).to.have.members([
      "POST /api/v1/pay-period/save",
      "POST /api/v1/rfid-management/save",
      "POST /api/v1/subsidy-management/save",
    ]);
    expect(recordedRoutes()).to.not.include("POST /save");
  });

  it('records router root "/" as the bare mount path (no trailing slash)', async function () {
    await request(app).get("/api/v1/pay-period");
    await tick();

    expect(recordedRoutes()).to.deep.equal(["GET /api/v1/pay-period"]);
  });

  it("preserves param tokens — raw GID/card values never enter labels", async function () {
    await request(app).get("/api/v1/rfid-management/90603664/13761/history");
    await tick();

    expect(recordedRoutes()).to.deep.equal([
      "GET /api/v1/rfid-management/:gid/:cardNumber/history",
    ]);
    expect(JSON.stringify(recordedRoutes())).to.not.include("90603664");
    expect(JSON.stringify(recordedRoutes())).to.not.include("13761");
  });

  it("does not record OPTIONS (CORS preflight) requests at all", async function () {
    await request(app)
      .options("/api/v1/rfid-management/90603664/13761/history")
      .set("Origin", "http://localhost:3000")
      .set("Access-Control-Request-Method", "GET");
    await tick();

    expect(fakeStore.recordRequest.called).to.be.false;
  });

  it("aggregates unmatched requests (404) under UNMATCHED — never raw paths", async function () {
    await request(app).get("/api/v1/does-not-exist/12345/secret");
    await tick();

    expect(recordedRoutes()).to.deep.equal([`GET ${UNMATCHED_ROUTE_LABEL}`]);
    expect(JSON.stringify(recordedRoutes())).to.not.include("does-not-exist");
  });

  it("repeated unmatched probes with distinct paths produce ONE label (cardinality cap)", async function () {
    await request(app).get("/api/v1/x/1");
    await request(app).get("/api/v1/x/2");
    await request(app).get("/api/v1/x/3");
    await tick();

    const unique = new Set(recordedRoutes());
    expect(unique.size).to.equal(1);
    expect(unique.has(`GET ${UNMATCHED_ROUTE_LABEL}`)).to.be.true;
  });

  it("passes method, status code, and a numeric duration to the store", async function () {
    await request(app).post("/api/v1/pay-period/verify").send({});
    await tick();

    const [route, method, statusCode, durationMs] =
      fakeStore.recordRequest.firstCall.args;
    expect(route).to.equal("POST /api/v1/pay-period/verify");
    expect(method).to.equal("POST");
    expect(statusCode).to.equal(200);
    expect(durationMs).to.be.a("number");
    expect(durationMs).to.be.at.least(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ResponseTimeMiddleware — identical keys, same exclusions
// ═══════════════════════════════════════════════════════════════════════════════

describe("ResponseTimeMiddleware — per-route keys match MetricsMiddleware", function () {
  let fakeStore;
  let rt;
  let app;

  beforeEach(function () {
    fakeStore = { recordRequest: sinon.spy() };
    rt = new ResponseTimeMiddleware({ slowThreshold: 60_000 });
    app = buildApp(fakeStore, rt);
  });

  it("aggregates under the full mounted, parameterized label", async function () {
    await request(app).post("/api/v1/subsidy-management/save").send({});
    await request(app).get("/api/v1/rfid-management/90603664/13761/history");
    await tick();

    const keys = Object.keys(rt.getPerformanceMetrics());
    expect(keys).to.have.members([
      "POST /api/v1/subsidy-management/save",
      "GET /api/v1/rfid-management/:gid/:cardNumber/history",
    ]);
  });

  it("emits exactly the same keys MetricsMiddleware records (single source of truth)", async function () {
    await request(app).post("/api/v1/pay-period/save").send({});
    await request(app).get("/api/v1/pay-period");
    await tick();

    const rtKeys = Object.keys(rt.getPerformanceMetrics()).sort();
    const storeKeys = fakeStore.recordRequest.args.map((a) => a[0]).sort();
    expect(rtKeys).to.deep.equal(storeKeys);
  });

  it("excludes OPTIONS from per-route aggregation but still sets X-Response-Time", async function () {
    const res = await request(app)
      .options("/api/v1/pay-period/save")
      .set("Origin", "http://localhost:3000")
      .set("Access-Control-Request-Method", "POST");
    await tick();

    expect(Object.keys(rt.getPerformanceMetrics())).to.have.lengthOf(0);
    expect(res.headers["x-response-time"]).to.match(/^\d+ms$/);
  });

  it("buckets unmatched requests under UNMATCHED", async function () {
    await request(app).get("/totally/unknown/123");
    await tick();

    const keys = Object.keys(rt.getPerformanceMetrics());
    expect(keys).to.deep.equal([`GET ${UNMATCHED_ROUTE_LABEL}`]);
  });
});
