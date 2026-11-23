import { describe, it, expect } from "vitest";
import {
  IDLE_FLOOR_MS, DEFAULT_IDLE_MS, LONG_IDLE_MS, EXEMPT, LONG_RULES, EXEMPT_RULES,
  DB_CALL_CAP_DEFAULT_MS, resolveIdleLimits, resolveDbCallProgressCap, classifyRoute, normalizePath,
} from "../../../../src/constants/requestWatchdog";

describe("requestWatchdog constants (wave 2)", () => {
  it("exposes the documented defaults", () => {
    expect(IDLE_FLOOR_MS).toBe(65_000);
    expect(DEFAULT_IDLE_MS).toBe(120_000);
    expect(LONG_IDLE_MS).toBe(600_000);
    expect(DB_CALL_CAP_DEFAULT_MS).toBe(1_800_000);
    expect(EXEMPT).toBe(Infinity);
    expect(Object.isFrozen(LONG_RULES)).toBe(true);
    expect(Object.isFrozen(EXEMPT_RULES)).toBe(true);
  });

  describe("resolveIdleLimits", () => {
    it("uses defaults with no env and no warnings", () => {
      expect(resolveIdleLimits({})).toEqual({ defaultMs: 120_000, longMs: 600_000, warnings: [] });
    });
    it("treats empty string as unset", () => {
      expect(resolveIdleLimits({ REQUEST_IDLE_TIMEOUT_MS: "" }).warnings).toEqual([]);
    });
    it("accepts in-range values (truncating decimals without a warning only when equal)", () => {
      const r = resolveIdleLimits({ REQUEST_IDLE_TIMEOUT_MS: "90000", REQUEST_IDLE_TIMEOUT_LONG_MS: "900000" });
      expect(r).toEqual({ defaultMs: 90_000, longMs: 900_000, warnings: [] });
    });
    it("clamps below the floor and above the max, reporting both", () => {
      const r = resolveIdleLimits({ REQUEST_IDLE_TIMEOUT_MS: "1000", REQUEST_IDLE_TIMEOUT_LONG_MS: "99999999" });
      expect(r.defaultMs).toBe(65_000);
      expect(r.longMs).toBe(1_800_000);
      expect(r.warnings).toEqual([
        { name: "REQUEST_IDLE_TIMEOUT_MS", raw: "1000", applied: 65_000 },
        { name: "REQUEST_IDLE_TIMEOUT_LONG_MS", raw: "99999999", applied: 1_800_000 },
      ]);
    });
    it("falls back and warns on non-numeric input", () => {
      const r = resolveIdleLimits({ REQUEST_IDLE_TIMEOUT_MS: "abc" });
      expect(r.defaultMs).toBe(120_000);
      expect(r.warnings).toEqual([{ name: "REQUEST_IDLE_TIMEOUT_MS", raw: "abc", applied: 120_000 }]);
    });
    it("defaults to process.env when no argument given", () => {
      const prev = process.env.REQUEST_IDLE_TIMEOUT_MS;
      process.env.REQUEST_IDLE_TIMEOUT_MS = "100000";
      try {
        expect(resolveIdleLimits().defaultMs).toBe(100_000);
      } finally {
        if (prev === undefined) delete process.env.REQUEST_IDLE_TIMEOUT_MS;
        else process.env.REQUEST_IDLE_TIMEOUT_MS = prev;
      }
    });
  });

  describe("resolveDbCallProgressCap", () => {
    it("defaults, accepts, clamps and rejects", () => {
      expect(resolveDbCallProgressCap({})).toEqual({ capMs: 1_800_000, warnings: [] });
      expect(resolveDbCallProgressCap({ DB_CALL_PROGRESS_CAP_MS: "100000" }).capMs).toBe(100_000);
      expect(resolveDbCallProgressCap({ DB_CALL_PROGRESS_CAP_MS: "5" })).toEqual({
        capMs: 65_000, warnings: [{ name: "DB_CALL_PROGRESS_CAP_MS", raw: "5", applied: 65_000 }],
      });
      expect(resolveDbCallProgressCap({ DB_CALL_PROGRESS_CAP_MS: "9999999999" }).capMs).toBe(3_600_000);
      expect(resolveDbCallProgressCap({ DB_CALL_PROGRESS_CAP_MS: "x" })).toEqual({
        capMs: 1_800_000, warnings: [{ name: "DB_CALL_PROGRESS_CAP_MS", raw: "x", applied: 1_800_000 }],
      });
    });
    it("reads process.env by default", () => {
      const prev = process.env.DB_CALL_PROGRESS_CAP_MS;
      process.env.DB_CALL_PROGRESS_CAP_MS = "200000";
      try {
        expect(resolveDbCallProgressCap().capMs).toBe(200_000);
      } finally {
        if (prev === undefined) delete process.env.DB_CALL_PROGRESS_CAP_MS;
        else process.env.DB_CALL_PROGRESS_CAP_MS = prev;
      }
    });
  });

  describe("normalizePath", () => {
    it("strips query, prefix, case and trailing slashes", () => {
      expect(normalizePath("/API/v1/Audit-Logs/Stream/?a=1")).toBe("/audit-logs/stream");
      expect(normalizePath("/api/v1")).toBe("/");
      expect(normalizePath("/api/v1/")).toBe("/");
      expect(normalizePath("/x///")).toBe("/x");
      expect(normalizePath("/")).toBe("/");
      expect(normalizePath(undefined)).toBe("/");
      expect(normalizePath("")).toBe("/");
    });
  });

  describe("classifyRoute", () => {
    it.each([
      ["GET", "/api/v1/health/stream", "exempt"],
      ["GET", "/api/v1/audit-logs/stream", "exempt"],
      ["GET", "/api/v1/audit-logs/system-logs/stream", "exempt"],
      ["GET", "/api/v1/integrity/stream", "exempt"],
      ["POST", "/api/v1/health/stream", "default"],
      ["POST", "/api/v1/data-purge/backup", "long"],
      ["POST", "/api/v1/data-purge/restore/preview", "long"],
      ["GET", "/api/v1/data-purge/backups/abc/download", "long"],
      ["POST", "/api/v1/data-purge/backups/abc/verify", "long"],
      ["GET", "/api/v1/data-purge/backup", "default"],
      ["POST", "/api/v1/admin-management/5/revoke", "long"],
      ["DELETE", "/api/v1/admin-management/5", "long"],
      ["GET", "/api/v1/admin-management/5", "default"],
      ["GET", "/api/v1/audit-logs/export/excel", "long"],
      ["GET", "/api/v1/audit-logs/42/export/trace", "long"],
      ["GET", "/api/v1/integrity/abc/export", "long"],
      ["GET", "/api/v1/audit-logs/export", "default"],
      ["get", "/api/v1/audit-logs/export/logs/", "long"],
      [undefined, "/api/v1/users", "default"],
    ] as Array<[string | undefined, string, string]>)("%s %s -> %s", (m, u, expected) => {
      expect(classifyRoute(m, u)).toBe(expected);
    });
    it("handles undefined url", () => {
      expect(classifyRoute("GET", undefined)).toBe("default");
    });
  });
});
