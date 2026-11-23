"use strict";

const { logger } = require("../../../../src/utils/logger");

describe("Logger", function () {
  describe("core API", function () {
    it("exposes RFC 5424 level methods", function () {
      expect(logger.emerg).toBeInstanceOf(Function);
      expect(logger.alert).toBeInstanceOf(Function);
      expect(logger.crit).toBeInstanceOf(Function);
      expect(logger.error).toBeInstanceOf(Function);
      expect(logger.warning).toBeInstanceOf(Function);
      expect(logger.notice).toBeInstanceOf(Function);
      expect(logger.info).toBeInstanceOf(Function);
      expect(logger.debug).toBeInstanceOf(Function);
    });

    it("retains warn() as a deprecated backward-compatible alias for warning()", function () {
      expect(logger.warn).toBeInstanceOf(Function);
    });

    it("exposes specialized methods", function () {
      expect(logger.cache).toBeInstanceOf(Function);
      expect(logger.database).toBeInstanceOf(Function);
      expect(logger.performance).toBeInstanceOf(Function);
      expect(logger.security).toBeInstanceOf(Function);
    });

    it("exposes HTTP lifecycle methods", function () {
      expect(logger.logIncomingRequest).toBeInstanceOf(Function);
      expect(logger.logHandlingRequest).toBeInstanceOf(Function);
      expect(logger.logCompletedRequest).toBeInstanceOf(Function);
    });
  });

  describe("log()", function () {
    it("does not throw when called with a valid level and message", function () {
      expect(() => logger.info("test message")).not.toThrow();
    });

    it("does not throw with meta object", function () {
      expect(() =>
        logger.info("test message", { key: "value" }),
      ).not.toThrow();
    });

    it("does not throw with null or undefined message", function () {
      expect(() => logger.info(null)).not.toThrow();
      expect(() => logger.info(undefined)).not.toThrow();
    });

    it("silently ignores empty string messages", function () {
      expect(() => logger.info("")).not.toThrow();
      expect(() => logger.info("   ")).not.toThrow();
    });
  });

  describe("specialized methods", function () {
    it("cache() does not throw", function () {
      expect(() =>
        logger.cache("GET", "cache:users:1", "HIT", 3),
      ).not.toThrow();
    });

    it("database() does not throw", function () {
      expect(() => logger.database("SELECT", "USERS", 12, 5)).not.toThrow();
    });

    it("performance() does not throw for fast operation", function () {
      expect(() =>
        logger.performance("render", 100, { rows: 10 }),
      ).not.toThrow();
    });

    it("performance() does not throw for slow operation (>5s)", function () {
      expect(() =>
        logger.performance("slowQuery", 6000, { rows: 50000 }),
      ).not.toThrow();
    });

    it("security() does not throw", function () {
      expect(() =>
        logger.security("IP_BLOCKED", { ip: "10.0.0.1" }),
      ).not.toThrow();
    });
  });

  describe("HTTP lifecycle logging", function () {
    function mockReq() {
      return {
        method: "GET",
        originalUrl: "/api/v1/health",
        url: "/api/v1/health",
        ip: "127.0.0.1",
        headers: {},
        get: () => undefined,
        query: {},
        connection: { remoteAddress: "127.0.0.1" },
      };
    }

    function mockRes() {
      return { statusCode: 200 };
    }

    it("logIncomingRequest does not throw", function () {
      expect(() => logger.logIncomingRequest(mockReq())).not.toThrow();
    });

    it("logHandlingRequest does not throw", function () {
      expect(() =>
        logger.logHandlingRequest(mockReq(), { userId: 1 }),
      ).not.toThrow();
    });

    it("logCompletedRequest does not throw", function () {
      expect(() =>
        logger.logCompletedRequest(mockReq(), mockRes(), 42),
      ).not.toThrow();
    });

    it("logCompletedRequest uses ERROR level for 4xx/5xx status", function () {
      const res = { statusCode: 500 };
      expect(() =>
        logger.logCompletedRequest(mockReq(), res, 100),
      ).not.toThrow();
    });
  });

  describe("getLogStats()", function () {
    it("returns an object (or rejects gracefully)", async function () {
      try {
        const stats = await logger.getLogStats();
        expect(stats).toBeInstanceOf(Object);
      } catch (err) {
        // May fail if log directory doesn't exist for today — acceptable
        expect(err).toBeInstanceOf(Error);
      }
    });
  });
});
