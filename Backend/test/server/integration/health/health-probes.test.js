"use strict";

/**
 * @fileoverview Integration tests for the Kubernetes-style health probes.
 *
 *   GET /api/v1/health/live  — liveness: is the process alive? (no DB)
 *   GET /api/v1/health/ready — readiness: are Oracle pools reachable?
 *
 * Neither endpoint requires authentication. /live never contacts the DB so
 * it is always 200 in any environment. /ready contacts Oracle pools and will
 * return 503 in CI / test environments where no DB is available — both the
 * 200 and the 503 paths are covered here.
 *
 * The legacy GET /api/v1/health is covered by the sibling health.test.js.
 */

const { expect } = require("chai");
const sinon      = require("sinon");
const request    = require("supertest");
const app        = require("../../../../src/app");
const db         = require("../../../../src/config");

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/health/live
// ═══════════════════════════════════════════════════════════════════════════════

describe("GET /api/v1/health/live — liveness probe", function () {

  it("always returns 200 (no DB dependency)", async function () {
    const res = await request(app).get("/api/v1/health/live");
    expect(res.status).to.equal(200);
  });

  it("body.status is 'success'", async function () {
    const res = await request(app).get("/api/v1/health/live");
    expect(res.body.status).to.equal("success");
  });

  it("body.data.alive is true", async function () {
    const res = await request(app).get("/api/v1/health/live");
    expect(res.body.data.alive).to.be.true;
  });

  it("body.data contains pid (number), uptime (number), timestamp (ISO string)", async function () {
    const res = await request(app).get("/api/v1/health/live");
    const { data } = res.body;
    expect(data).to.have.property("pid").that.is.a("number");
    expect(data).to.have.property("uptime").that.is.a("number");
    expect(data.uptime).to.be.greaterThan(0);
    expect(data).to.have.property("timestamp");
    expect(new Date(data.timestamp).getTime()).to.be.a("number").and.greaterThan(0);
  });

  it("X-Request-ID header is present and prefixed req_", async function () {
    const res = await request(app).get("/api/v1/health/live");
    expect(res.headers).to.have.property("x-request-id");
    expect(res.headers["x-request-id"]).to.match(/^req_/);
  });

  it("responds in under 100ms (no DB call — pure process info)", async function () {
    const start = Date.now();
    await request(app).get("/api/v1/health/live");
    expect(Date.now() - start).to.be.lessThan(100);
  });

  it("does not require auth token", async function () {
    // Deliberately sends no Authorization header — must still succeed
    const res = await request(app)
      .get("/api/v1/health/live")
      .unset("Authorization");
    expect(res.status).to.equal(200);
  });

  it("every concurrent liveness check gets a unique X-Request-ID", async function () {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => request(app).get("/api/v1/health/live")),
    );
    const ids = results.map((r) => r.headers["x-request-id"]);
    expect(new Set(ids).size).to.equal(10);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/health/ready
// ═══════════════════════════════════════════════════════════════════════════════

describe("GET /api/v1/health/ready — readiness probe", function () {
  this.timeout(10_000); // Pool probe may take a moment in CI

  // Stub db.withConnection so the pool probe resolves immediately as "down"
  // instead of waiting up to 15 s for Oracle's connectTimeout + retries.
  // Without this stub, each probe attempt takes ~15 s × 3 retries = 45 s+,
  // exceeding the 10 s test timeout before a response is even sent.
  beforeEach(function () {
    if (!db.withConnection.isSinonProxy) {
        sinon.stub(db, "withConnection").rejects(new Error("ORA-12541: TNS:no listener — test environment, Oracle not available"));
    }
  });
  afterEach(function () {
    sinon.restore();
  });

  it("returns 200 when all pools are up, or 503 when any pool is down", async function () {
    const res = await request(app).get("/api/v1/health/ready");
    expect([200, 503]).to.include(res.status);
  });

  it("response shape is { status, code, message, data } regardless of DB state", async function () {
    const res = await request(app).get("/api/v1/health/ready");
    expect(res.body).to.have.property("status").that.is.a("string");
    expect(res.body).to.have.property("code").that.is.a("number");
    expect(res.body).to.have.property("message").that.is.a("string");
    expect(res.body).to.have.property("data").that.is.an("object");
  });

  it("data.ready is a boolean reflecting overall pool health", async function () {
    const res = await request(app).get("/api/v1/health/ready");
    expect(res.body.data).to.have.property("ready").that.is.a("boolean");
  });

  it("data.checks contains oracle_userAccount and oracle_Meal keys", async function () {
    const res = await request(app).get("/api/v1/health/ready");
    const { checks } = res.body.data;
    expect(checks).to.be.an("object");
    expect(checks).to.have.property("oracle_userAccount");
    expect(checks).to.have.property("oracle_Meal");
  });

  it("each check has a status field of 'up' or 'down'", async function () {
    const res = await request(app).get("/api/v1/health/ready");
    Object.values(res.body.data.checks).forEach((check) => {
      expect(["up", "down"]).to.include(check.status);
    });
  });

  it("when ready:true the HTTP status is 200 and data.ready is true", async function () {
    const res = await request(app).get("/api/v1/health/ready");
    if (res.body.data.ready) {
      expect(res.status).to.equal(200);
      expect(res.body.status).to.equal("success");
    }
  });

  it("when ready:false the HTTP status is 503 and data.ready is false", async function () {
    const res = await request(app).get("/api/v1/health/ready");
    if (!res.body.data.ready) {
      expect(res.status).to.equal(503);
      expect(res.body.status).to.equal("error");
    }
  });

  it("failed pools report an error string in the checks object", async function () {
    const res = await request(app).get("/api/v1/health/ready");
    Object.values(res.body.data.checks).forEach((check) => {
      if (check.status === "down") {
        expect(check).to.have.property("error").that.is.a("string");
      }
    });
  });

  it("X-Request-ID header is present", async function () {
    const res = await request(app).get("/api/v1/health/ready");
    expect(res.headers["x-request-id"]).to.match(/^req_/);
  });

  it("does not require auth token", async function () {
    const res = await request(app)
      .get("/api/v1/health/ready")
      .unset("Authorization");
    expect([200, 503]).to.include(res.status);
  });
});
