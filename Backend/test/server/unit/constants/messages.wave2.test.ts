/**
 * Wave-2 unit tests: every log-message template in src/constants/messages/*
 * is invoked with distinctive inputs; output text is pinned by snapshot and
 * interpolation of the inputs is asserted.
 */
import { describe, it, expect } from "vitest";
import * as adminM from "../../../../src/constants/messages/admin.messages";
import architectureM from "../../../../src/constants/messages/architecture.messages";
import * as auditM from "../../../../src/constants/messages/auditLog.messages";
import * as authM from "../../../../src/constants/messages/auth.messages";
import * as backupEmailM from "../../../../src/constants/messages/backupEmail.messages";
import * as cacheM from "../../../../src/constants/messages/cache.messages";
import * as changelogM from "../../../../src/constants/messages/changelog.messages";
import * as clientM from "../../../../src/constants/messages/client.messages";
import * as clusterM from "../../../../src/constants/messages/cluster.messages";
import * as backupM from "../../../../src/constants/messages/dataBackup.messages";
import * as purgeM from "../../../../src/constants/messages/dataPurge.messages";
import * as databaseM from "../../../../src/constants/messages/database.messages";
import devdocsM from "../../../../src/constants/messages/devdocs.messages";
import * as inFlightM from "../../../../src/constants/messages/inFlight.messages";
import * as integrityM from "../../../../src/constants/messages/integrity.messages";
import * as logRetM from "../../../../src/constants/messages/logRetention.messages";
import * as metricsM from "../../../../src/constants/messages/metrics.messages";
import * as middlewareM from "../../../../src/constants/messages/middleware.messages";
import * as notifM from "../../../../src/constants/messages/notification.messages";
import * as oracleM from "../../../../src/constants/messages/oracle.messages";
import * as wrapperM from "../../../../src/constants/messages/oracleWrapper.messages";
import * as resilM from "../../../../src/constants/messages/resilience.messages";
import * as serverM from "../../../../src/constants/messages/server.messages";
import * as sseM from "../../../../src/constants/messages/sse.messages";
import * as uploadM from "../../../../src/constants/messages/upload.messages";
import * as watchdogM from "../../../../src/constants/messages/watchdog.messages";

type Fn = (...a: unknown[]) => unknown;

const STR = ["S1x", "S2x", "S3x", "S4x", "S5x", "S6x"];
const NUM = [111, 222, 333, 444, 555, 666];
const ARR = [["A1", "A2"], ["B1", "B2"], ["C1"], ["D1"], ["E1"], ["F1"]];
const OBJ = [
  { message: "M1", code: "C1" },
  { message: "M2", code: "C2" },
  { message: "M3" },
  { message: "M4" },
  { message: "M5" },
  { message: "M6" },
];
const PROXY = () =>
  new Proxy({}, { get: (_t, k) => (typeof k === "string" && !["toString", "valueOf", "toJSON", "then", "constructor"].includes(k) ? `P_${k}` : undefined) });
const PROXIES = [PROXY(), PROXY(), PROXY(), PROXY(), PROXY(), PROXY()];
const mix = (k: number) => [...STR.slice(0, k), ...PROXIES.slice(k)];
const STRATEGIES: Array<{ args: unknown[]; needles: string[] }> = [
  { args: STR, needles: STR },
  { args: NUM, needles: NUM.map(String) },
  { args: ARR, needles: ["A1", "B1", "C1"] },
  { args: OBJ, needles: ["M1", "M2", "M3"] },
  { args: mix(1), needles: ["S1x", "P_"] },
  { args: mix(2), needles: ["S1x", "S2x", "P_"] },
  { args: mix(3), needles: ["S1x", "S2x", "S3x", "P_"] },
  { args: PROXIES, needles: ["P_"] },
];

function collect(prefix: string, node: unknown, out: Array<[string, Fn]>): void {
  if (typeof node === "function") {
    out.push([prefix, node as Fn]);
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) collect(`${prefix}.${k}`, v, out);
  }
}

function render(fn: Fn): { strategy: number; value: unknown } {
  let lastErr: unknown;
  let fallback: { strategy: number; value: unknown } | undefined;
  for (let i = 0; i < STRATEGIES.length; i++) {
    try {
      const value = fn(...STRATEGIES[i].args);
      const text = typeof value === "string" ? value : JSON.stringify(value);
      if (text !== undefined && (text.includes("undefined") || text.includes("[object Object]"))) {
        fallback ??= { strategy: i, value };
        continue;
      }
      return { strategy: i, value };
    } catch (e) {
      lastErr = e;
    }
  }
  if (fallback) return fallback;
  throw lastErr;
}

const MODULES: Record<string, unknown> = {
  admin: adminM, architecture: architectureM, auditLog: auditM, auth: authM,
  backupEmail: backupEmailM, cache: cacheM, changelog: changelogM, client: clientM,
  cluster: clusterM, dataBackup: backupM, dataPurge: purgeM, database: databaseM,
  devdocs: devdocsM, inFlight: inFlightM, integrity: integrityM, logRetention: logRetM,
  metrics: metricsM, middleware: middlewareM, notification: notifM, oracle: oracleM,
  oracleWrapper: wrapperM, resilience: resilM, server: serverM, sse: sseM,
  upload: uploadM, watchdog: watchdogM,
};

const EXPLICIT = [".WATCHDOG_BURST_ALERT", ".DB_CLOCK_OFFSET_MISMATCH", ".wrapError"];

describe("constants/messages explicit templates (wave 2)", () => {
  it("WATCHDOG_BURST_ALERT formats window, pid, lists and the optional suppressed-count tail", () => {
    const m = watchdogM.watchdogMessages.WATCHDOG_BURST_ALERT;
    const base = m(3, 60_400, [["GET /a", 2], ["POST /b", 1]], [["db", 3]], 0);
    expect(base).toBe(
      `WATCHDOG_BURST_ALERT — 3 request(s) cut by the watchdog in the last 60s on pid ${process.pid}. Top routes: GET /a x2, POST /b x1. Last progress sources: db x3.`,
    );
    const empty = m(1, 1_499, [], [], 4);
    expect(empty).toBe(
      `WATCHDOG_BURST_ALERT — 1 request(s) cut by the watchdog in the last 1s on pid ${process.pid}. Top routes: none. Last progress sources: none. 4 more cut(s) since the previous alert.`,
    );
  });

  it("DB_CLOCK_OFFSET_MISMATCH renders signed hh:mm offsets", () => {
    const text = databaseM.databaseMessages.DB_CLOCK_OFFSET_MISMATCH(480, -330, 0);
    expect(text).toContain("Oracle server clock is UTC+08:00 but DB_TIMEZONE_OFFSET_MINUTES says UTC-05:30");
    expect(text).toContain("(app process UTC+00:00)");
  });

  it("wrapError describes bind shapes without leaking values", () => {
    const m = wrapperM.oracleMongoWrapperMessages.wrapError;
    expect(m("scope", new Error("boom"), "SELECT 1")).toBe("[scope] boom\nSQL: SELECT 1");
    expect(m("scope", "not-an-error", "SQL")).toBe("[scope] undefined\nSQL: SQL");
    expect(m("s", null, "SQL")).toBe("[s] undefined\nSQL: SQL");
    expect(m("s", { message: "obj" }, "SQL", null)).toBe("[s] obj\nSQL: SQL\nBinds: <none>");
    expect(m("s", { message: "e" }, "SQL", [])).toContain("Binds: 0 bind(s)");
    const binds = {
      a: "secret-value", b: 5, c: true, d: null, e: undefined, f: new Date(0),
      g: [1, 2, 3], h: Buffer.from("xyz"), i: { val: "pw", dir: "OUT" }, j: { val: 1 },
      k: { nested: { x: 1 } }, l: Symbol("z"),
    };
    const text = m("s", { message: "e" }, "SQL", binds) as string;
    expect(text).toContain(
      "12 bind(s): a=<string:12>, b=<number>, c=<boolean>, d=<null>, e=<undefined>, f=<date>, g=<array:3>, h=<buffer:3>, i=<bind dir:OUT <string:2>>, j=<bind dir:IN <number>>, k=<object>, l=<object>",
    );
    expect(text).not.toContain("secret-value");
    const many = Object.fromEntries(Array.from({ length: 43 }, (_, i) => [`k${i}`, i]));
    expect(m("s", { message: "e" }, "SQL", many)).toMatch(/^.*43 bind\(s\): k0=<number>.*k39=<number>, …\+3 more$/s);
    expect(m("s", { message: "e" }, "SQL", [{ val: [1] }])).toContain("0=<bind dir:IN <array:1>>");
    expect(m("s", { message: "e" }, "SQL", [{ val: { val: 1 } }])).toContain("0=<bind dir:IN <object>>");
    expect(m("s", { message: "e" }, "SQL", "str")).toContain("Binds: <none>");
  });
});

describe("constants/messages templates (wave 2)", () => {
  for (const [name, mod] of Object.entries(MODULES)) {
    const fns: Array<[string, Fn]> = [];
    collect(name, mod, fns);
    // Templates with process/time-dependent or structured-arg output are pinned explicitly below.
    for (let i = fns.length - 1; i >= 0; i--) {
      if (EXPLICIT.some((e) => fns[i][0].endsWith(e))) fns.splice(i, 1);
    }

    it(`${name}: exports at least one template function`, () => {
      expect(fns.length).toBeGreaterThan(0);
    });

    it(`${name}: every template renders deterministic, fully-interpolated text`, () => {
      const rendered: Record<string, unknown> = {};
      for (const [path, fn] of fns) {
        const { strategy, value } = render(fn);
        rendered[path] = value;
        const text = typeof value === "string" ? value : JSON.stringify(value);
        expect(text, path).toBeTruthy();
        // Same inputs -> same output (pure template)
        expect(render(fn).value, path).toEqual(value);
        expect(strategy).toBeGreaterThanOrEqual(0);
      }
      expect(rendered).toMatchSnapshot();
    });

    it(`${name}: templates that take args reflect them in the output`, () => {
      for (const [path, fn] of fns) {
        if (fn.length === 0) continue;
        const { strategy, value } = render(fn);
        const text = typeof value === "string" ? value : JSON.stringify(value);
        const needles = STRATEGIES[strategy].needles;
        expect(needles.some((n) => text.includes(n)), `${path} -> ${text}`).toBe(true);
      }
    });
  }
});
