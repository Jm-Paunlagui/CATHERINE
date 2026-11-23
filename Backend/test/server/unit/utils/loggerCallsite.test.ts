import fs from "fs";
import os from "os";
import path from "path";
import { Logger } from "../../../../src/utils/logger";
import { requestContext } from "../../../../src/utils/requestContext";

let dir: string;
let baseDir: string;
let consoleOutput: boolean;
let level: string;
let stack = "";

const read = () => {
    const out: string[] = [];
    const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(fs.readFileSync(p, "utf8")); } };
    walk(dir);
    return out.join("\n");
};

/** Makes `new Error().stack` return the crafted `stack` variable for the logger's frame parsing. */
function stubStack() {
    const Real = globalThis.Error;
    class Fake extends Real {
        constructor(m?: string) { super(m); Object.defineProperty(this, "stack", { get: () => stack, configurable: true }); }
    }
    vi.stubGlobal("Error", Fake);
}

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "logger-callsite-"));
    baseDir = Logger.CONFIG.LOG_BASE_DIR;
    consoleOutput = Logger.CONFIG.CONSOLE_OUTPUT;
    level = Logger.CONFIG.CURRENT_LEVEL;
    Logger.CONFIG.LOG_BASE_DIR = dir;
    Logger.CONFIG.CONSOLE_OUTPUT = false;
    // Assertions read INFO lines: pin the level instead of inheriting the run's LOG_LEVEL.
    Logger.CONFIG.CURRENT_LEVEL = "INFO";
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    Logger.CONFIG.LOG_BASE_DIR = baseDir;
    Logger.CONFIG.CONSOLE_OUTPUT = consoleOutput;
    Logger.CONFIG.CURRENT_LEVEL = level;
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("Logger call-site extraction", () => {
    it("parses 'at fn (file:line:col)' frames and keeps caller-provided parts", async () => {
        stubStack();
        const lg = new Logger();
        stack = "Error\n    at logger\n    at doWork (/w/src/svc/work.ts:42:7)";
        await lg.info("full");
        await lg.info("keeps fn", { function: "given" });
        await lg.info("keeps file", { file: "/w/src/other.ts" });
        await lg.info("keeps line", { line: 9 });
        await lg.flush();
        vi.unstubAllGlobals();
        const out = read();
        expect(out).toContain("[doWork @ src/svc/work.ts:42] [FUNC] - full");
        expect(out).toContain("[given @ src/svc/work.ts:42] [FUNC] - keeps fn");
        expect(out).toContain("[doWork @ src/other.ts:42] [FUNC] - keeps file");
        expect(out).toContain("[doWork @ src/svc/work.ts:9] [FUNC] - keeps line");
    });

    it("when injection fails (frozen meta) the formatter parses both frame shapes itself", async () => {
        stubStack();
        const lg = new Logger();
        stack = "Error\n    at logger\n    at doWork (/w/src/a.ts:1:2)";
        await lg.log("INFO", "paren", Object.freeze({}));
        await lg.flush();
        stack = "Error\n    at logger\n    at /w/src/b.ts:3:4";
        await lg.log("INFO", "bare", Object.freeze({}));
        await lg.flush();
        stack = "Error\n    at logger\n    at ???";
        await lg.log("INFO", "junk", Object.freeze({}));
        await lg.flush();
        stack = "";
        await lg.log("INFO", "empty", Object.freeze({}));
        await lg.flush();
        vi.unstubAllGlobals();
        const out = read();
        expect(out).toContain("[doWork @ src/a.ts:1] [FUNC] - paren");
        expect(out).toContain("[anonymous @ src/b.ts:3] [FUNC] - bare");
        expect(out).toContain("[anonymous @ ] [FUNC] - junk");
        expect(out).toContain("[anonymous @ ] [FUNC] - empty");
    });

    it("LOG_CALLSITE=false disables both injection and capture", async () => {
        const prev = process.env.LOG_CALLSITE;
        process.env.LOG_CALLSITE = "false";
        try {
            const lg = new Logger();
            await lg.log("INFO", "off", Object.freeze({}));
            await lg.flush();
        } finally {
            if (prev === undefined) delete process.env.LOG_CALLSITE; else process.env.LOG_CALLSITE = prev;
        }
        expect(read()).toContain("[anonymous @ ] [FUNC] - off");
    });
});

describe("Logger colourised console line variants", () => {
    it("covers a named machine, no phase, UNKNOWN method, no request id and an unmapped level", async () => {
        Logger.CONFIG.CONSOLE_OUTPUT = true;
        const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const lg = new Logger();
        await lg.log("INFO", "http no phase", { _isHttpRequest: true, _clientMachine: "bob@1 (C) 1.1.1.1" });
        await lg.log("INFO", "plain");
        await requestContext.run({ requestId: "req_9" }, () => lg.log("INFO", "with id", { _isHttpRequest: true, method: "GET", _requestPhase: "[P]" }));
        await lg.log("WARN", "legacy alias key");
        await lg.flush();
        const lines = spy.mock.calls.map((c) => String(c[0]));
        expect(lines[0]).toContain("bob@1 (C) 1.1.1.1");
        expect(lines[0]).toContain("UNKNOWN");
        expect(lines[0]).not.toContain("[P]");
        expect(lines[1]).toContain("FUNC");
        expect(lines[1]).not.toContain("req_");
        expect(lines[2]).toContain("req_9");
        expect(lines[3]).toContain("\x1b[33mWARN");
    });
});
