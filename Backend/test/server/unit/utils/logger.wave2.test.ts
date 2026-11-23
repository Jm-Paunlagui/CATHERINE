import fs from "fs";
import os from "os";
import path from "path";
import { Logger } from "../../../../src/utils/logger";
import { requestContext } from "../../../../src/utils/requestContext";

const CONFIG_KEYS = ["LOG_BASE_DIR", "CURRENT_LEVEL", "CONSOLE_OUTPUT", "MAX_FILE_SIZE", "MAX_SAFESTR_LENGTH"] as const;
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
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "logger-wave2-"));
    for (const k of CONFIG_KEYS) savedConfig[k] = (Logger.CONFIG as Record<string, unknown>)[k];
    Logger.CONFIG.LOG_BASE_DIR = dir;
    Logger.CONFIG.CONSOLE_OUTPUT = false;
});
afterEach(() => {
    vi.restoreAllMocks();
    for (const k of CONFIG_KEYS) (Logger.CONFIG as Record<string, unknown>)[k] = savedConfig[k];
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    for (const k of Object.keys(savedEnv)) delete savedEnv[k];
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("Logger wave2: constructor and machine identifier", () => {
    it("treats WARN as WARNING and an unknown level as INFO", async () => {
        const warn = make("warn");
        expect(warn.currentLevel).toBe(Logger.CONFIG.LEVELS.WARNING);
        const bogus = make("nonsense");
        expect(bogus.currentLevel).toBe(Logger.CONFIG.LEVELS.INFO);
        await bogus.debug("filtered out");
        await bogus.flush();
        expect(Object.keys(logs())).not.toContain("debug.log");
    });

    it("reads the queue cap from LOG_MAX_QUEUE_LENGTH", () => {
        expect(make("INFO", { LOG_MAX_QUEUE_LENGTH: "7" })._maxQueueLength).toBe(7);
    });

    it("identifies the host by its first external IPv4, including legacy numeric families", () => {
        vi.spyOn(os, "networkInterfaces").mockReturnValue({
            lo: [{ address: "127.0.0.1", family: "IPv4", internal: true } as never],
            skip: undefined as never,
            v6: [{ address: "::1", family: "IPv6", internal: false } as never],
            old: [{ address: "10.1.2.3", family: 4, internal: false } as never],
            later: [{ address: "10.9.9.9", family: "IPv4", internal: false } as never],
        });
        expect(make().machineIdentifier).toBe(`${os.hostname()} (S) 10.1.2.3`);
        vi.spyOn(os, "networkInterfaces").mockReturnValue({
            alt: [{ address: "10.4.4.4", family: undefined, addressFamily: "IPv4", internal: false } as never],
            none: [{ address: "", family: "IPv4", internal: false } as never],
        });
        expect(make().machineIdentifier).toBe(`${os.hostname()} (S) 10.4.4.4`);
        vi.spyOn(os, "networkInterfaces").mockReturnValue({ only6: [{ address: "::2", family: "IPv6", internal: false } as never] });
        expect(make().machineIdentifier).toBe(`${os.hostname()} (S) unknown`);
    });

    it("falls back to a placeholder when the host cannot be inspected", () => {
        vi.spyOn(os, "hostname").mockImplementation(() => { throw new Error("nope"); });
        expect(make().machineIdentifier).toBe("unknown (S) unknown");
    });

    it("survives a log directory that cannot be created at startup", async () => {
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const blocker = path.join(dir, "file");
        fs.writeFileSync(blocker, "x");
        Logger.CONFIG.LOG_BASE_DIR = path.join(blocker, "sub");
        make();
        await new Promise((r) => setTimeout(r, 50));
        expect(errSpy.mock.calls.some((c) => String(c[0]).includes("Failed to create log directory") || String(c[0]).includes("Failed to initialize"))).toBe(true);
    });
});

describe("Logger wave2: level subscribers", () => {
    it("delivers records to subscribers by priority, honours _noNotify and unsubscribe, and ignores non-functions", async () => {
        const lg = make();
        const crit: string[] = [];
        const all: string[] = [];
        const off = lg.onLevel(2, (r) => crit.push(r.level));
        lg.onLevel(7, (r) => all.push(`${r.level}:${r.message}`));
        expect(lg.onLevel(2, "nope" as never)()).toBeUndefined();
        await lg.info("hello");
        await lg.critical("boom");
        await lg.critical("quiet", { _noNotify: true });
        expect(crit).toEqual(["CRITICAL"]);
        expect(all).toEqual(["INFO:hello", "CRITICAL:boom"]);
        off();
        off(); // idempotent
        await lg.critical("after unsubscribe");
        expect(crit).toEqual(["CRITICAL"]);
        await lg.flush();
    });

    it("a throwing subscriber is reported to stderr and never breaks the write path", async () => {
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const lg = make();
        lg.onLevel(7, () => { throw new Error("subscriber bug"); });
        lg.onLevel(7, () => { throw "plain string"; });
        await lg.warning("still written");
        await lg.flush();
        expect(errSpy.mock.calls.map((c) => c[1])).toEqual(["subscriber bug", "plain string"]);
        expect(logs()["warning.log"]).toContain("still written");
    });
});

describe("Logger wave2: formatting", () => {
    it("writes plain entries with HTTP phase, method, request id from context and meta", async () => {
        const lg = make();
        await lg.log("INFO", "[GET @ /x] done", { _isHttpRequest: true, method: "GET", _requestPhase: "[Request Complete]", status: 200 });
        await lg.log("INFO", "request body", { _isHttpRequest: true, _requestPhase: "[Incoming Request]", _clientMachine: "client-9" });
        await lg.flush();
        await requestContext.run({ requestId: "req_ctx1" } as never, async () => {
            await lg.info("in context");
            await lg.flush();
        });
        const lines = logs()["info.log"].trim().split("\n");
        expect(lines[0]).toContain("[Request Complete] - [GET @ /x] done");
        expect(lines[0]).not.toContain("[GET] -");
        expect(lines[0]).toContain('| META: {"status":200}');
        expect(lines[1]).toMatch(/^\[client-9\] /);
        expect(lines[1]).toContain("[Incoming Request] [UNKNOWN] - request body");
        expect(lines[2]).toContain("[req_ctx1] - in context");
    });

    it("renders colourised console output with the same structure", async () => {
        const out = vi.spyOn(console, "log").mockImplementation(() => {});
        Logger.CONFIG.CONSOLE_OUTPUT = true;
        const lg = make();
        await requestContext.run({ requestId: "req_color" } as never, async () => {
            await lg.log("INFO", "plain colour", { extra: 1 });
        });
        await lg.log("INFO", "[POST @ /y] ok", { _isHttpRequest: true, method: "POST", _requestPhase: "[Handling Request]", _clientMachine: "m1" });
        await lg.log("INFO", "no method token", { _isHttpRequest: true });
        await lg.flush();
        const lines = out.mock.calls.map((c) => String(c[0]));
        expect(lines).toHaveLength(3);
        expect(lines[0]).toContain(Logger.CONFIG.COLORS.INFO);
        expect(lines[0]).toContain("req_color");
        expect(lines[0]).toContain("META: ");
        expect(lines[1]).toContain("[Handling Request]");
        expect(lines[1]).toContain("m1");
        expect(lines[1]).not.toContain(`${Logger.CONFIG.COLORS.METHOD}POST`);
        expect(lines[2]).toContain("UNKNOWN");
    });

    it("serialises circular, unserialisable, long and empty values safely", async () => {
        const lg = make();
        const circ: Record<string, unknown> = { name: "c" };
        circ.self = circ;
        await lg.log("INFO", circ);
        await lg.log("INFO", { big: 10n });
        await lg.flush();
        lg._maxSafeStrLength = 40;
        await lg.log("INFO", { long: "y".repeat(200) });
        await lg.log("INFO", 42);
        await lg.log("INFO", true);
        await lg.log("INFO", Symbol("s") as never);
        await lg.log("INFO", "ok", { value: 1n });
        await lg.log("INFO", "with null meta value", { n: null });
        await lg.flush();
        const text = logs()["info.log"];
        expect(text).toContain("[Circular Reference]");
        expect(text).toContain("[Complex Object - Unable to Stringify]");
        expect(text).toContain("y".repeat(10) + "...");
        expect(text).toContain("- 42");
        expect(text).toContain("- true");
        expect(text).toContain("- Symbol(s)");
    });

    it("ignores empty messages and uses placeholders for empty-ish values", async () => {
        const lg = make();
        await lg.log("INFO", "   ");
        await lg.log("INFO", "");
        await lg.log("INFO", null);
        await lg.log("NOT_A_LEVEL", "x");
        lg.writeQueue.push({ level: "INFO", message: null, meta: {}, requestId: null });
        lg.writeQueue.push({ level: "INFO", message: "   ", meta: {}, requestId: null });
        await lg.log("INFO", "kick");
        await lg.flush();
        const text = logs()["info.log"];
        expect(text.match(/\[Empty Message\]/g)).toHaveLength(2);
        expect(text).toContain("kick");
    });

    it("shortens file paths from meta to a src-relative or trailing form", async () => {
        const lg = make();
        const cwd = process.cwd().replace(/\\/g, "/");
        await lg.log("INFO", "a", { function: "fa", file: "/abs/proj/src/mod/a.ts", line: 3 });
        await lg.log("INFO", "b", { function: "fb", file: "src/b.ts", line: 4 });
        await lg.log("INFO", "c", { function: "fc", file: `${cwd}/lib/c.ts`, line: 5 });
        await lg.log("INFO", "d", { function: "fd", file: "/other/place/d.ts", line: 6 });
        await lg.log("INFO", "e", { function: "fe", file: cwd, line: 7 });
        await lg.flush();
        const text = logs()["info.log"];
        expect(text).toContain("[fa @ src/mod/a.ts:3]");
        expect(text).toContain("[fb @ src/b.ts:4]");
        expect(text).toContain("[fc @ lib/c.ts:5]");
        expect(text).toContain("[fd @ place/d.ts:6]");
        expect(text).toContain("[fe @ :7]");
    });

    it("omits the call site when LOG_CALLSITE=false", async () => {
        const lg = make("DEBUG", { LOG_CALLSITE: "false" });
        await lg.info("no callsite");
        await lg.flush();
        expect(logs()["info.log"]).toContain("[anonymous @ ]");
    });
});

describe("Logger wave2: argument normalisation", () => {
    it("handles zero, one, plain-meta and mixed argument shapes", async () => {
        const lg = make();
        await lg.info();
        await lg.info("one");
        await lg.info("with meta", { k: "v" });
        await lg.info("array meta", ["a", "b"]);
        await lg.info("many", 1, null, undefined, { o: 1 }, true);
        await lg.info("empty obj", {});
        await lg.flush();
        const text = logs()["info.log"];
        expect(text).toContain("[Empty Log]");
        expect(text).toContain('| META: {"k":"v"}');
        expect(text).toContain('array meta ["a","b"]');
        expect(text).toContain('many 1 null undefined {"o":1} true');
        expect(text).toContain("empty obj");
    });
});

describe("Logger wave2: rotation, backpressure and stats", () => {
    it("rolls to a numbered file when the size cap is reached and to a timestamped one when all slots are full", async () => {
        const lg = make();
        Logger.CONFIG.MAX_FILE_SIZE = 1;
        await lg.info("first");
        await lg.flush();
        await lg.info("second");
        await lg.flush();
        await lg.info("third");
        await lg.flush();
        expect(Object.keys(logs()).sort()).toEqual(["info.log", "info_1.log", "info_2.log"]);
        vi.spyOn(fs.promises, "stat").mockResolvedValue({ size: 5 } as never);
        await lg.info("overflow of slots");
        await lg.flush();
        expect(Object.keys(logs()).some((n) => /^info_\d{10,}\.log$/.test(n))).toBe(true);
    });

    it("drops the oldest queued entries when the disk stalls and reports the gap as CRITICAL", async () => {
        const lg = make("DEBUG", { LOG_MAX_QUEUE_LENGTH: "2" });
        const realAppend = fs.promises.appendFile;
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        let first = true;
        vi.spyOn(fs.promises, "appendFile").mockImplementation(async (...a: Parameters<typeof realAppend>) => {
            if (first) { first = false; await gate; }
            return realAppend.apply(fs.promises, a);
        });
        for (let i = 0; i < 6; i++) await lg.info(`line-${i}`);
        expect(lg._droppedCount).toBeGreaterThan(0);
        release();
        await lg.flush();
        const all = Object.values(logs()).join("\n");
        expect(all).toContain("Log write queue overflowed");
        expect(all).toContain("line-5");
        expect(lg._droppedCount).toBe(0);
    });

    it("reports a single dropped entry in the singular", async () => {
        const lg = make("DEBUG", { LOG_MAX_QUEUE_LENGTH: "1" });
        const realAppend = fs.promises.appendFile;
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        let first = true;
        vi.spyOn(fs.promises, "appendFile").mockImplementation(async (...a: Parameters<typeof realAppend>) => {
            if (first) { first = false; await gate; }
            return realAppend.apply(fs.promises, a);
        });
        await lg.info("held");
        await lg.info("queued");
        await lg.info("replaces queued");
        release();
        await lg.flush();
        expect(Object.values(logs()).join("\n")).toContain("1 oldest entry DROPPED");
    });

    it("flush gives up at its deadline when a write never completes", async () => {
        vi.useFakeTimers();
        try {
            const lg = make();
            vi.spyOn(fs.promises, "appendFile").mockImplementation(() => new Promise<void>(() => {}));
            await lg.info("stuck");
            const p = lg.flush(50);
            await vi.advanceTimersByTimeAsync(100);
            expect(await p).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it("a failing append is reported on stderr and does not stop later lines", async () => {
        const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const lg = make();
        const real = fs.promises.appendFile;
        let calls = 0;
        vi.spyOn(fs.promises, "appendFile").mockImplementation(async (...a: Parameters<typeof real>) => {
            if (calls++ === 0) throw new Error("disk full");
            return real.apply(fs.promises, a);
        });
        await lg.info("lost");
        await lg.info("kept");
        await lg.flush();
        expect(errSpy.mock.calls.some((c) => String(c[0]).startsWith("Failed to write INFO log"))).toBe(true);
        expect(logs()["info.log"]).toContain("kept");
    });

    it("getLogStats lists today's files with human sizes, and reports errors", async () => {
        const lg = make();
        await lg.info("stat me");
        await lg.flush();
        const stats = await lg.getLogStats();
        expect(stats.error).toBeUndefined();
        expect(stats.totalFiles).toBe(1);
        expect(stats.files?.[0]).toMatchObject({ name: "info.log" });
        expect(stats.files?.[0].sizeHuman).toMatch(/Bytes|KB/);
        const empty = fs.mkdtempSync(path.join(os.tmpdir(), "logger-wave2-empty-"));
        Logger.CONFIG.LOG_BASE_DIR = empty;
        const missing = await make().getLogStats();
        expect(missing.error).toEqual(expect.any(String));
        fs.rmSync(empty, { recursive: true, force: true });
    });
});
