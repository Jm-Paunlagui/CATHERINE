"use strict";

const { expect } = require("chai");
const {
  CsrfMiddleware,
} = require("../../../../src/middleware/security/CsrfMiddleware");

describe("CsrfMiddleware (unit)", function () {
  describe("constructor", function () {
    it("creates an instance with a provided secret", function () {
      const csrf = new CsrfMiddleware({
        secret: "test-secret-32chars-abcdefghij",
      });
      expect(csrf).to.be.an("object");
      expect(csrf.handle).to.be.a("function");
      expect(csrf.tokenHandler).to.be.a("function");
      expect(csrf.refreshHandler).to.be.a("function");
      expect(csrf.statusHandler).to.be.a("function");
    });

    it("throws in ALL environments when no secret is provided (CWE-352 fail-fast fix)", function () {
      // Security fix: CSRF_SECRET is now required regardless of NODE_ENV.
      // The previous "dev fallback" was a vulnerability — a missing secret in
      // production was only caught at startup, and dev environments used a
      // predictable static secret that could be exploited if accidentally deployed.
      const origEnv = process.env.NODE_ENV;
      const origSecret = process.env.CSRF_SECRET;
      process.env.NODE_ENV = "production";
      delete process.env.CSRF_SECRET;
      try {
        expect(() => new CsrfMiddleware({ secret: undefined })).to.throw(
          /CSRF_SECRET environment variable is required/,
        );
      } finally {
        process.env.NODE_ENV = origEnv;
        if (origSecret !== undefined) process.env.CSRF_SECRET = origSecret;
      }
    });

    it("throws in development too when no CSRF_SECRET is configured (fail-fast — no dev fallback)", function () {
      // Security fix: the dev-secret fallback ("dev-csrf-secret-...") was removed.
      // Even in development, CSRF_SECRET must be explicitly set.
      const origEnv = process.env.NODE_ENV;
      const origSecret = process.env.CSRF_SECRET;
      process.env.NODE_ENV = "development";
      delete process.env.CSRF_SECRET;
      try {
        expect(() => new CsrfMiddleware({ secret: undefined })).to.throw(
          /CSRF_SECRET environment variable is required/,
        );
      } finally {
        process.env.NODE_ENV = origEnv;
        if (origSecret !== undefined) process.env.CSRF_SECRET = origSecret;
      }
    });
  });

  describe("cookie name", function () {
    it("uses __Host- prefix when secure", function () {
      const csrf = new CsrfMiddleware({
        secret: "test-secret",
        forceSecure: true,
      });
      // Access via statusHandler to check cookie name
      const req = { ip: "127.0.0.1", cookies: {}, get: () => undefined };
      const body = {};
      const res = {
        json(b) {
          Object.assign(body, b);
        },
      };
      csrf.statusHandler(req, res);
      expect(body.status.cookieName).to.equal("__Host-psifi.x-csrf-token");
    });

    it("uses non-prefixed name when not secure", function () {
      const csrf = new CsrfMiddleware({
        secret: "test-secret",
        forceSecure: false,
      });
      const req = { ip: "127.0.0.1", cookies: {}, get: () => undefined };
      const body = {};
      const res = {
        json(b) {
          Object.assign(body, b);
        },
      };
      csrf.statusHandler(req, res);
      expect(body.status.cookieName).to.equal("psifi.x-csrf-token");
    });
  });

  describe("statusHandler", function () {
    it("returns status with enabled=true, methods, tokenSources", function () {
      const csrf = new CsrfMiddleware({
        secret: "test-secret",
        forceSecure: false,
      });
      const req = { ip: "127.0.0.1", cookies: {}, get: () => undefined };
      const body = {};
      const res = {
        json(b) {
          Object.assign(body, b);
        },
      };
      csrf.statusHandler(req, res);

      expect(body.success).to.be.true;
      expect(body.status.enabled).to.be.true;
      expect(body.status.methods.protected).to.include("POST");
      expect(body.status.methods.safe).to.include("GET");
      expect(body.status.tokenSources).to.be.an("array");
      expect(body.status.headerName).to.equal("x-csrf-token");
    });

    it("detects when CSRF cookie is present", function () {
      const csrf = new CsrfMiddleware({
        secret: "test-secret",
        forceSecure: false,
      });
      const cookieName = "psifi.x-csrf-token";
      const req = {
        ip: "127.0.0.1",
        cookies: { [cookieName]: "some-value" },
        get: () => undefined,
      };
      const body = {};
      const res = {
        json(b) {
          Object.assign(body, b);
        },
      };
      csrf.statusHandler(req, res);

      expect(body.status.hasSecret).to.be.true;
      expect(body.message).to.include("active with a valid secret cookie");
    });

    it("detects when CSRF cookie is missing", function () {
      const csrf = new CsrfMiddleware({
        secret: "test-secret",
        forceSecure: false,
      });
      const req = { ip: "127.0.0.1", cookies: {}, get: () => undefined };
      const body = {};
      const res = {
        json(b) {
          Object.assign(body, b);
        },
      };
      csrf.statusHandler(req, res);

      expect(body.status.hasSecret).to.be.false;
      expect(body.message).to.include("no secret cookie found");
    });
  });

  describe("refreshHandler", function () {
    it("returns 400 when no existing CSRF cookie is present", function () {
      const csrf = new CsrfMiddleware({
        secret: "test-secret",
        forceSecure: false,
      });
      const req = { ip: "127.0.0.1", cookies: {}, get: () => undefined };
      let statusCode;
      const body = {};
      const res = {
        status(c) {
          statusCode = c;
          return this;
        },
        json(b) {
          Object.assign(body, b);
        },
      };
      csrf.refreshHandler(req, res);

      expect(statusCode).to.equal(400);
      expect(body.success).to.be.false;
      expect(body.code).to.equal("NO_CSRF_SESSION");
    });
  });
});
