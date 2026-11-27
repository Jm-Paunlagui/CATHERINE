import fs from "fs";
import os from "os";
import path from "path";
import { Logger } from "../../../../src/utils/logger";
import { requestContext } from "../../../../src/utils/requestContext";

const CONFIG_KEYS = ["LOG_BASE_DIR", "CURRENT_LEVEL", "CONSOLE_OUTPUT", "MAX_FILE_SIZE", "MAX_SAFESTR_LENGTH", "DATE_OPTIONS"] as const;
const savedConfig: Record<string, unknown> = {};
const savedEnv: Record<string, string | undefined> = {};
let dir: string;

/** Every *.log file under dir (any depth), name -> contents. */
function logs(): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (d: string) => {
        if (!fs.existsSync(d)) return;
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else out[e.name] = fs.readFileSync(p, "utf8");
        }
    };
    walk(dir);
    return out;
}

function make(level = "DEBUG", env: Record<string, string> = {}) {
    Logger.CONFIG.CURRENT_LEVEL = level;
    for (const [k, v] of Object.entries(env)) {
        savedEnv[k] ??= process.env[k];
        process.env[k] = v;
    }
    return new Logger();
}

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "logger-core-"));
    for (const k of CONFIG_KEYS) savedConfig[k] = (Logger.CONFIG as Record<string, unknown>)[k];
    Logger.CONFIG.LOG_BASE_DIR = dir;
    Logger.CONFIG.CONSOLE_OUTPUT = false;
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const k of CONFIG_KEYS) (Logger.CONFIG as Record<string, unknown>)[k] = savedConfig[k];
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    for (const k of Object.keys(savedEnv)) delete savedEnv[k];
    // Windows refuses to delete a log file the logger still has open; retry briefly.
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("Logger level filtering and construction", () => {
    it("writes each RFC 5424 level (and the deprecated aliases) to its own file", async () => {
        const lg = make();
        lg.emergency("m-emergency");
        lg.emerg("m-emerg");
        lg.alert("m-alert");
        lg.critical("m-critical");
        lg.crit("m-crit");
        lg.error("m-error");
        lg.warning("m-warning");
        lg.warn("m-warn");
        lg.notice("m-notice");
        lg.info("m-info");
        lg.debug("m-debug");
        expect(await lg.flush()).toBe(true);
        const f = logs();
        expect(Object.keys(f).sort()).toEqual(["alert.log", "critical.log", "debug.log", "emergency.log", "error.log", "info.log", "notice.log", "warning.log"]);
        expect(f["emergency.log"]).toContain("m-emergency");
        expect(f["emergency.log"]).toContain("m-emerg");
        expect(f["critical.log"]).toContain("m-crit");
        expect(f["warning.log"]).toContain("m-warn");
        expect(f["info.log"]).toMatch(/\[INFO\] \[PID:\d+\]/);
    });

    it("suppresses levels below the configured one, and accepts WARN as WARNING", async () => {
        const lg = make("warn");
        lg.error("e");
        lg.warning("w");
        lg.notice("n");
        lg.debug("d");
        await lg.flush();
        expect(Object.keys(logs()).sort()).toEqual(["error.log", "warning.log"]);
    });

    it("falls back to INFO for an unknown level name", async () => {
        const lg = make("nonsense");
        lg.info("i");
        lg.debug("d");
        await lg.flush();
        expect(Object.keys(logs())).toEqual(["info.log"]);
    });

    it("an unknown level name passes the filter and writes its own file", async () => {
        const lg = make();
        await lg.log("BOGUS", "odd");
        await lg.flush();
        expect(logs()["bogus.log"]).toContain("odd");
    });

    it("ignores empty, whitespace and falsy messages", async () => {
        const lg = make();
        await lg.log("INFO", "");
        await lg.log("INFO", "   ");
        await lg.log("INFO", 0);
        await lg.log("INFO", undefined);
        expect(lg.writeQueue).toHaveLength(0);
        expect(logs()).toEqual({});
    });

    it("creates the base directory on startup and reports failure without throwing", async () => {
        const blocker = path.join(dir, "blocker");
        fs.writeFileSync(blocker, "x");
        Logger.CONFIG.LOG_BASE_DIR = path.join(blocker, "sub");
        const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
        make();
        await vi.waitFor(() => expect(err).toHaveBeenCalledWith("Failed to initialize log directory:", expect.any(String)));
    });
});

describe("Logger line format", () => {
    it("renders machine, timestamp, level, pid, call site, method, request id and meta", async () => {
        const lg = make();
        await requestContext.run({ requestId: "req_abc" }, async () => {
            await lg.info("hello world", { orderCount: 3, nested: { a: 1 } });
        });
        await lg.flush();
        const line = logs()["info.log"].trim();
        expect(line).toMatch(/^\[.+ \(S\) .+\] \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] \[INFO\] \[PID:\d+\] \[.+ @ .+:\d+\] \[FUNC\] \[req_abc\] - hello world \| META: /);
        expect(line).toContain('{"orderCount":3,"nested":{"a":1}}');
        expect(line).toContain("loggerCore.test.ts");
    });

    it("HTTP lines carry the phase, the client machine and the status/duration; no duplicate method tag when the message has one", async () => {
        const lg = make();
        const req: any = { method: "POST", originalUrl: "/api/x", ip: "10.1.1.1", get: () => "bob@77", query: {} };
        await lg.logIncomingRequest(req);
        await lg.logIncomingRequest(req, "[POST @ /api/x]");
        await lg.logCompletedRequest(req, { statusCode: 201 } as any, 12);
        await lg.logCompletedRequest(req, { statusCode: 503 } as any, 30);
        await lg.logHandlingRequest(req, { extra: "yes" });
        await lg.flush();
        const f = logs();
        const info = f["info.log"].trim().split("\n");
        expect(info[0]).toContain("[bob@77 (C) 10.1.1.1]");
        expect(info[0]).toContain("[Incoming Request] [POST] - Incoming Request");
        expect(info[1]).not.toContain("[POST] -");
        expect(info[2]).toContain('"statusCode":201,"durationMs":12');
        expect(info[3]).toContain('"extra":"yes"');
        expect(f["error.log"]).toContain('"statusCode":503');
    });

    it("marks an HTTP line without a method as UNKNOWN", async () => {
        const lg = make();
        await lg.log("INFO", "x", { _isHttpRequest: true });
        await lg.flush();
        expect(logs()["info.log"]).toContain("[UNKNOWN]");
    });

    it("client identity: header, query pair, user.userId, user.sub, anonymous; IP from req.ip, socket, connection, unknown", async () => {
        const lg = make();
        const base = { method: "GET", url: "/u", query: {} };
        await lg.logIncomingRequest({ ...base, get: () => "hdr", ip: "1.1.1.1" } as any);
        await lg.logIncomingRequest({ ...base, query: { username: "q", userId: "9" }, socket: { remoteAddress: "2.2.2.2" } } as any);
        await lg.logIncomingRequest({ ...base, user: { userId: "u1", sub: "s1" }, connection: { remoteAddress: "3.3.3.3" } } as any);
        await lg.logIncomingRequest({ ...base, user: { sub: "s2" } } as any);
        await lg.logIncomingRequest({ ...base, query: { username: "only" } } as any);
        await lg.flush();
        const lines = logs()["info.log"].trim().split("\n");
        expect(lines[0]).toContain("[hdr (C) 1.1.1.1]");
        expect(lines[1]).toContain("[q@9 (C) 2.2.2.2]");
        expect(lines[2]).toContain("[u1 (C) 3.3.3.3]");
        expect(lines[3]).toContain("[s2 (C) unknown]");
        expect(lines[4]).toContain("[anonymous@unknown (C) unknown]");
    });

    it("never trusts X-Forwarded-For for the recorded IP (CWE-290)", async () => {
        const lg = make();
        const req: any = { method: "GET", url: "/", ip: "9.9.9.9", query: {}, headers: { "x-forwarded-for": "6.6.6.6" }, get: (h: string) => (h === "X-Forwarded-For" ? "6.6.6.6" : undefined) };
        await lg.logIncomingRequest(req);
        await lg.flush();
        expect(logs()["info.log"]).toContain("(C) 9.9.9.9");
        expect(logs()["info.log"]).not.toContain("6.6.6.6");
    });

    it("shortens caller-provided file paths: src/ marker, compiled src/, cwd-relative, other", async () => {
        const lg = make();
        const cwd = process.cwd().replace(/\\/g, "/");
        for (const file of ["/x/y/src/a/b.ts", "C:\\app\\src\\c.ts", "src/d.ts", `${cwd}/lib/e.ts`, `${cwd}e2.ts`, "/p/q/r/f.ts", "g.ts"]) {
            await lg.info("m", { function: "fn", file, line: 4 });
        }
        await lg.flush();
        const out = logs()["info.log"];
        for (const expected of ["[fn @ src/a/b.ts:4]", "[fn @ src/c.ts:4]", "[fn @ src/d.ts:4]", "[fn @ lib/e.ts:4]", "[fn @ e2.ts:4]", "[fn @ r/f.ts:4]", "[fn @ g.ts:4]"]) expect(out).toContain(expected);
    });

    it("LOG_CALLSITE=false skips call-site capture", async () => {
        const lg = make("DEBUG", { LOG_CALLSITE: "false" });
        await lg.info("quiet");
        await lg.flush();
        expect(logs()["info.log"]).toContain("[anonymous @ ]");
    });

    it("parses anonymous stack frames and ignores unparseable or logger-only stacks", async () => {
        const Real = globalThis.Error;
        let stack = "";
        class Fake extends Real {
            constructor(m?: string) { super(m); Object.defineProperty(this, "stack", { value: stack, configurable: true }); }
        }
        vi.stubGlobal("Error", Fake);
        const lg = make();
        stack = "Error\n    at logger\n    at /w/src/anon.ts:10:5";
        await lg.info("anon-frame");
        stack = "Error\n    at logger\n    at gibberish";
        await lg.info("junk-frame");
        stack = "Error\n    at logger\n    at x (/w/utils/logger.ts:1:1)";
        await lg.info("only-logger");
        stack = "";
        await lg.info("empty-stack");
        await lg.flush();
        vi.unstubAllGlobals();
        const out = logs()["info.log"];
        expect(out).toContain("[anonymous @ src/anon.ts:10] [FUNC] - anon-frame");
        expect(out).toContain("[anonymous @ ] [FUNC] - junk-frame");
        expect(out).toContain("[anonymous @ ] [FUNC] - only-logger");
        expect(out).toContain("[anonymous @ ] [FUNC] - empty-stack");
    });

    it("a frozen meta object still logs (call-site injection failure is swallowed, formatter re-captures)", async () => {
        const lg = make();
        await lg.log("INFO", "frozen", Object.freeze({ k: "v" }));
        await lg.flush();
        expect(logs()["info.log"]).toMatch(/\[anonymous @ \] \[FUNC\] - frozen \| META: \{"k":"v"\}/);
    });

    it("renders the colourised console line when console output is on", async () => {
        Logger.CONFIG.CONSOLE_OUTPUT = true;
        const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const lg = make();
        const req: any = { method: "GET", url: "/c", ip: "1.1.1.1", query: {}, get: () => undefined };
        await requestContext.run({ requestId: "req_color" }, async () => {
            await lg.logIncomingRequest(req);
            await lg.logIncomingRequest(req, "[GET @ /c]");
            await lg.warning("careful", { a: 1 });
            await lg.log("BOGUS", "no color");
        });
        await lg.flush();
        const lines = spy.mock.calls.map((c) => String(c[0]));
        expect(lines).toHaveLength(4);
        expect(lines[0]).toContain("\x1b[95m[Incoming Request]");
        expect(lines[0]).toContain("req_color");
        expect(lines[1]).not.toContain("[GET\x1b");
        expect(lines[2]).toContain("\x1b[33mWARNING");
        expect(lines[2]).toContain("META:");
        expect(lines[3]).toContain("BOGUS");
    });
});

describe("Logger argument normalisation and stringification", () => {
    it("handles zero args, one non-string arg, message+meta, and multiple trailing values", async () => {
        const lg = make();
        lg.info();
        lg.info({ obj: 1 });
        lg.info("with meta", { a: 1 });
        lg.info("with array", [1, 2]);
        lg.info("multi", "x", 5, true, null, undefined, { a: 1 }, [3], Symbol("s"));
        lg.info("indexed", { 0: "a", 1: "b" });
        lg.info("empty meta", {});
        await lg.flush();
        const out = logs()["info.log"];
        expect(out).toContain("- [Empty Log]");
        expect(out).toContain('- {"obj":1}');
        expect(out).toContain('with meta | META: {"a":1}');
        expect(out).toContain('with array [1,2] | META: {"additionalData":[[1,2]]}');
        expect(out).toContain('multi x 5 true null undefined {"a":1} [3] Symbol(s)');
        expect(out).toContain('indexed {"0":"a","1":"b"}');
        expect(out).toMatch(/empty meta\n|empty meta$/m);
    });

    it("stringifies circular, huge-number-free, bigint and primitive messages safely", async () => {
        const lg = make();
        const circ: any = { name: "c" };
        circ.self = circ;
        lg.info(circ);
        lg.info({ big: BigInt(1) });
        lg.info(true);
        lg.info(Symbol("sym"));
        lg.info([]);
        lg.info(Object.create(null));
        await lg.flush();
        const out = logs()["info.log"];
        expect(out).toContain("Circular Reference");
        expect(out).toContain("[Complex Object - Unable to Stringify]");
        expect(out).toContain("- true");
        expect(out).toContain("- Symbol(sym)");
        expect(out).toContain("- []");
    });

    it("surfaces a throwing toJSON as a stringify error rather than crashing", async () => {
        const lg = make();
        lg.info({ toJSON() { throw new Error("nope"); } });
        await lg.flush();
        expect(logs()["info.log"]).toContain("[Complex Object - Unable to Stringify]");
    });

    it("truncates long serialised objects when LOG_MAX_SAFESTR_LENGTH is set", async () => {
        Logger.CONFIG.MAX_SAFESTR_LENGTH = 20;
        const lg = make();
        lg.info({ text: "x".repeat(100) });
        await lg.flush();
        const line = logs()["info.log"];
        expect(line).toContain('{"text":"xxxxxxxx...');
        expect(line).not.toContain("x".repeat(30));
    });

    it("a toJSON that yields undefined is reported as a stringify error", async () => {
        const lg = make();
        lg.info({ toJSON: () => undefined });
        await lg.flush();
        expect(logs()["info.log"]).toContain("[Stringify Error:");
    });
});

describe("Logger specialised helpers", () => {
    it("cache/database/performance/security map to their levels and meta", async () => {
        const lg = make();
        lg.cache("GET", "k", "HIT", 3 as never);
        lg.cache("SET", "k2", "MISS");
        lg.database("SELECT", "T", 12 as never, 5 as never);
        lg.database("SELECT", "T2");
        lg.performance("fast", 100, { rows: 1 });
        lg.performance("slow", 6000);
        lg.security("IP_BLOCKED", { ip: "10.0.0.1" });
        await lg.flush();
        const f = logs();
        expect(f["debug.log"]).toContain('"operation":"GET","key":"k","result":"HIT","duration":"3ms"');
        expect(f["debug.log"]).toContain('"operation":"SET","key":"k2","result":"MISS"}');
        expect(f["debug.log"]).toContain('"duration":"12ms","rowCount":5');
        expect(f["debug.log"]).toContain('"table":"T2"}');
        expect(f["info.log"]).toContain('"operation":"fast","duration":"100ms","rows":1');
        expect(f["warning.log"]).toContain('"operation":"slow","duration":"6000ms"');
        expect(f["warning.log"]).toContain('"event":"IP_BLOCKED"');
    });
});

describe("Logger level subscribers", () => {
    it("delivers records at or above the ceiling and supports unsubscribe", async () => {
        const lg = make();
        const got: any[] = [];
        const off = lg.onLevel(2, (r) => got.push(r));
        await requestContext.run({ requestId: "req_tap" }, async () => {
            await lg.critical("crit-msg", { k: 1 });
            await lg.info("not-delivered");
        });
        expect(got).toHaveLength(1);
        expect(got[0]).toMatchObject({ level: "CRITICAL", message: "crit-msg", requestId: "req_tap" });
        expect(got[0].meta.k).toBe(1);
        expect(typeof got[0].timestamp).toBe("string");
        off();
        off();
        await lg.critical("after-off");
        expect(got).toHaveLength(1);
        await lg.flush();
    });

    it("skips _noNotify records, unknown levels and non-function subscribers; a throwing subscriber cannot break logging", async () => {
        const lg = make();
        const fn = vi.fn();
        lg.onLevel(7, fn);
        expect(lg.onLevel(7, "nope" as never)()).toBeUndefined();
        await lg.error("quiet", { _noNotify: true });
        await lg.log("BOGUS", "unknown");
        expect(fn).not.toHaveBeenCalled();
        const consoleErr = vi.spyOn(console, "error").mockImplementation(() => undefined);
        lg.onLevel(7, () => { throw new Error("subscriber boom"); });
        lg.onLevel(7, () => { throw "plain"; });
        await lg.error("still logged");
        expect(consoleErr).toHaveBeenCalledWith("Logger onLevel subscriber threw:", "subscriber boom");
        expect(consoleErr).toHaveBeenCalledWith("Logger onLevel subscriber threw:", "plain");
        await lg.flush();
        expect(logs()["error.log"]).toContain("still logged");
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it("a record without a request id delivers null", async () => {
        const lg = make();
        const fn = vi.fn();
        lg.onLevel(7, fn);
        await lg.info("no ctx");
        expect(fn.mock.calls[0][0].requestId).toBeNull();
    });
});

describe("Logger machine identifier", () => {
    const nets = (over: unknown) => vi.spyOn(os, "networkInterfaces").mockReturnValue(over as never);
    it.each([
        ["IPv4 external", { eth0: [{ family: "IPv6", address: "::1", internal: false }, { family: "IPv4", address: "10.0.0.5", internal: false }] }, "10.0.0.5"],
        ["numeric family", { eth0: [{ family: 4, address: "10.0.0.6", internal: false }] }, "10.0.0.6"],
        ["addressFamily", { eth0: [{ addressFamily: "IPv4", address: "10.0.0.7", internal: false }] }, "10.0.0.7"],
        ["skips internal and undefined entries", { lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }], gone: undefined, eth1: [{ family: "IPv4", address: "10.0.0.8", internal: false }] }, "10.0.0.8"],
        ["address missing keeps unknown", { eth0: [{ family: "IPv4", address: "", internal: false }] }, "unknown"],
        ["no interfaces", {}, "unknown"],
    ])("%s", (_n, interfaces, ip) => {
        nets(interfaces);
        expect(new Logger().machineIdentifier).toBe(`${os.hostname()} (S) ${ip}`);
    });
    it("falls back when the OS call throws", () => {
        vi.spyOn(os, "hostname").mockImplementation(() => { throw new Error("x"); });
        expect(new Logger().machineIdentifier).toBe("unknown (S) unknown");
    });
});

describe("Logger backpressure, rotation and failure", () => {
    it("drops the OLDEST entries over the cap, then reports the gap as CRITICAL", async () => {
        const lg = make("DEBUG", { LOG_MAX_QUEUE_LENGTH: "2" });
        for (let i = 0; i < 6; i++) lg.info(`line-${i}`);
        await vi.waitFor(() => expect(lg._droppedCount).toBeGreaterThan(0));
        const dropped = lg._droppedCount;
        await lg.flush();
        const f = logs();
        expect(f["info.log"]).toContain("line-5");
        expect(f["info.log"]).not.toContain("line-1");
        expect(f["critical.log"]).toContain(`${dropped} oldest entries DROPPED (cap 2)`);
        expect(lg._droppedCount).toBe(0);
    });

    it("uses the singular for a single dropped entry", async () => {
        const lg = make("DEBUG", { LOG_MAX_QUEUE_LENGTH: "1" });
        lg.info("a");
        lg.info("b");
        lg.info("c");
        await lg.flush();
        expect(logs()["critical.log"]).toContain("1 oldest entry DROPPED (cap 1)");
    });

    it("rolls over to numbered files when the size limit is hit, and to a timestamped one when all are full", async () => {
        Logger.CONFIG.MAX_FILE_SIZE = 5;
        const lg = make();
        await lg.info("first line is long enough");
        await lg.flush();
        await lg.info("second");
        await lg.flush();
        expect(Object.keys(logs()).sort()).toEqual(["info.log", "info_1.log"]);

        Logger.CONFIG.MAX_FILE_SIZE = 0;
        vi.spyOn(Date, "now").mockReturnValue(1234567890);
        await lg.info("third");
        await lg.flush();
        expect(logs()["info_1234567890.log"]).toContain("third");
    });

    it("a write failure is reported to stderr, not thrown", async () => {
        const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const lg = make();
        const blocker = path.join(dir, "file");
        fs.writeFileSync(blocker, "");
        Logger.CONFIG.LOG_BASE_DIR = path.join(blocker, "nested");
        await lg.info("lost");
        await lg.flush();
        expect(err).toHaveBeenCalledWith("Failed to create log directory:", expect.any(String), expect.any(String));
        expect(err).toHaveBeenCalledWith("Failed to write INFO log:", expect.any(String));
    });

    it("a stat error other than ENOENT aborts the write with a report", async () => {
        const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
        vi.spyOn(fs.promises, "stat").mockRejectedValue(Object.assign(new Error("denied"), { code: "EACCES" }));
        const lg = make();
        await lg.info("x");
        await lg.flush();
        expect(err).toHaveBeenCalledWith("Failed to write INFO log:", "denied");
    });

    it("an unexpected failure while computing the log path is caught per entry and when reporting drops", async () => {
        const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const lg = make("DEBUG", { LOG_MAX_QUEUE_LENGTH: "1" });
        Logger.CONFIG.DATE_OPTIONS = { timeZone: "Not/AZone" } as never;
        lg.info("a");
        lg.info("b");
        lg.info("c");
        await vi.waitFor(() => expect(err).toHaveBeenCalledWith("Error reporting dropped logs:", expect.any(String)));
        expect(err).toHaveBeenCalledWith("Error processing write queue:", expect.any(String));
        Logger.CONFIG.DATE_OPTIONS = savedConfig.DATE_OPTIONS as never;
        await lg.flush();
    });

    it("flush gives up at the deadline while a write is in flight, then reports drained", async () => {
        const lg = make();
        lg.info("pending");
        expect(await lg.flush(0)).toBe(false);
        expect(await lg.flush(-5)).toBe(false);
        expect(await lg.flush()).toBe(true);
    });
});

describe("Logger.getLogStats", () => {
    it("lists today's log files with human sizes and ignores other files", async () => {
        const lg = make();
        await lg.info("a line");
        await lg.flush();
        const logDir = path.dirname(Object.keys(logs()).length ? (() => { const walk = (d: string): string => { const e = fs.readdirSync(d, { withFileTypes: true }); const f = e.find((x) => x.isFile()); return f ? path.join(d, f.name) : walk(path.join(d, e.find((x) => x.isDirectory())!.name)); }; return walk(dir); })() : dir);
        fs.writeFileSync(path.join(logDir, "empty.log"), "");
        fs.writeFileSync(path.join(logDir, "big.log"), "z".repeat(2048));
        fs.writeFileSync(path.join(logDir, "note.txt"), "ignored");
        const stats: any = await lg.getLogStats();
        expect(stats.directory).toBe(logDir);
        expect(stats.files.map((f: any) => f.name).sort()).toEqual(["big.log", "empty.log", "info.log"]);
        expect(stats.totalFiles).toBe(3);
        expect(stats.files.find((f: any) => f.name === "empty.log").sizeHuman).toBe("0 Bytes");
        expect(stats.files.find((f: any) => f.name === "big.log").sizeHuman).toBe("2 KB");
        expect(stats.files.find((f: any) => f.name === "info.log").sizeHuman).toMatch(/ Bytes$/);
    });
    it("returns an error object when today's directory does not exist", async () => {
        const stats: any = await make().getLogStats();
        expect(stats.error).toMatch(/ENOENT/);
        expect(stats.directory).toContain(dir);
    });
});

describe("Logger.createHttpLoggerMiddleware", () => {
    it("logs the incoming request, wraps res.end to log completion once, and forwards to next", async () => {
        const lg = make();
        const end = vi.fn(() => "ended");
        const res: any = { statusCode: 404, end };
        const next = vi.fn();
        const req: any = { method: "GET", originalUrl: "/missing", ip: "5.5.5.5", query: {}, get: () => undefined };
        lg.createHttpLoggerMiddleware()(req, res, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(res.end("body")).toBe("ended");
        expect(end).toHaveBeenCalledWith("body");
        await lg.flush();
        const f = logs();
        expect(f["info.log"]).toContain("Incoming Request");
        expect(f["error.log"]).toContain("Request Complete");
        expect(f["error.log"]).toContain('"statusCode":404');
    });
});
