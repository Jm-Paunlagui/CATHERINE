import fs from "fs";
import os from "os";
import path from "path";
import { Logger } from "../../../../src/utils/logger";

type LoggerModule = typeof import("../../../../src/utils/logger");
const ENV_KEYS = ["LOG_LEVEL", "ENABLE_CONSOLE_LOGS", "NODE_ENV", "DOCKER_CONTAINER", "LOG_EXCLUDE_HEALTH", "LOG_EXCLUDE_URLS", "LOG_MAX_SAFESTR_LENGTH", "LOG_CALLSITE"];
const saved: Record<string, string | undefined> = {};
let dir: string;

/** Fresh copy of the logger module evaluated under the given env (static CONFIG is read at load). */
async function load(env: Record<string, string | undefined>, compiled?: { IS_COMPILED: boolean; APP_ROOT: string }): Promise<LoggerModule> {
    for (const [k, v] of Object.entries(env)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    vi.resetModules();
    if (compiled) vi.doMock("../../../../src/utils/runtimePaths", () => compiled);
    return import("../../../../src/utils/logger");
}

beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "logger-cfg-"));
});
afterEach(() => {
    vi.doUnmock("../../../../src/utils/runtimePaths");
    vi.resetModules();
    vi.restoreAllMocks();
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("Logger static configuration from the environment", () => {
    it("defaults: INFO level, cwd/logs, no exclusions, unlimited safe-string length", async () => {
        const { Logger: L } = await load({ LOG_LEVEL: undefined, ENABLE_CONSOLE_LOGS: undefined, NODE_ENV: "test", DOCKER_CONTAINER: undefined, LOG_EXCLUDE_HEALTH: undefined, LOG_EXCLUDE_URLS: undefined, LOG_MAX_SAFESTR_LENGTH: undefined });
        expect(L.CONFIG.CURRENT_LEVEL).toBe("INFO");
        expect(L.CONFIG.LOG_BASE_DIR).toBe(path.join(process.cwd(), "logs"));
        expect(L.CONFIG.EXCLUDED_URLS).toEqual([]);
        expect(L.CONFIG.MAX_SAFESTR_LENGTH).toBe(Infinity);
        expect(L.CONFIG.CONSOLE_OUTPUT).toBe(true);
    });
    it("a compiled exe logs next to the exe", async () => {
        const { Logger: L } = await load({}, { IS_COMPILED: true, APP_ROOT: path.join(dir, "app") });
        expect(L.CONFIG.LOG_BASE_DIR).toBe(path.join(dir, "app", "logs"));
    });
    it("collects excluded URLs and the safe-string cap", async () => {
        const { Logger: L } = await load({ LOG_EXCLUDE_HEALTH: "true", LOG_EXCLUDE_URLS: "/a,/b", LOG_MAX_SAFESTR_LENGTH: "500" });
        expect(L.CONFIG.EXCLUDED_URLS).toEqual(["/health", "/a", "/b"]);
        expect(L.CONFIG.MAX_SAFESTR_LENGTH).toBe(500);
        const { Logger: L2 } = await load({ LOG_EXCLUDE_HEALTH: "false", LOG_EXCLUDE_URLS: "/only", LOG_MAX_SAFESTR_LENGTH: undefined });
        expect(L2.CONFIG.EXCLUDED_URLS).toEqual(["/only"]);
    });
    it.each([
        ["explicitly off", { ENABLE_CONSOLE_LOGS: "false", NODE_ENV: "development" }, false],
        ["explicitly on in production", { ENABLE_CONSOLE_LOGS: "true", NODE_ENV: "production" }, true],
        ["production default off", { ENABLE_CONSOLE_LOGS: undefined, NODE_ENV: "production", DOCKER_CONTAINER: undefined }, false],
        ["docker container on in production", { ENABLE_CONSOLE_LOGS: undefined, NODE_ENV: "production", DOCKER_CONTAINER: "true" }, true],
    ])("console output %s", async (_n, env, expected) => {
        const { Logger: L } = await load(env as Record<string, string | undefined>);
        expect(L.CONFIG.CONSOLE_OUTPUT).toBe(expected);
    });
    it("an empty LOG_LEVEL string behaves as INFO", () => {
        const prev = Logger.CONFIG.CURRENT_LEVEL;
        Logger.CONFIG.CURRENT_LEVEL = "";
        try {
            expect(new Logger().currentLevel).toBe(Logger.CONFIG.LEVELS.INFO);
        } finally {
            Logger.CONFIG.CURRENT_LEVEL = prev;
        }
    });
});

describe("Logger redaction at enqueue", () => {
    let lg: Logger;
    const files = () => {
        const out: string[] = [];
        const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(fs.readFileSync(p, "utf8")); } };
        walk(dir);
        return out.join("\n");
    };
    let baseDir: string;
    let consoleOutput: boolean;
    beforeEach(() => {
        baseDir = Logger.CONFIG.LOG_BASE_DIR;
        consoleOutput = Logger.CONFIG.CONSOLE_OUTPUT;
        Logger.CONFIG.LOG_BASE_DIR = dir;
        Logger.CONFIG.CONSOLE_OUTPUT = false;
        lg = new Logger();
    });
    afterEach(() => {
        Logger.CONFIG.LOG_BASE_DIR = baseDir;
        Logger.CONFIG.CONSOLE_OUTPUT = consoleOutput;
    });

    it("_noRedact keeps raw values outside production but is ignored in production", async () => {
        process.env.NODE_ENV = "test";
        await lg.info("mail to raw.person@corp.com", { _noRedact: true, note: "raw.person@corp.com" });
        await lg.flush();
        expect(files()).toContain("raw.person@corp.com");
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir);
        process.env.NODE_ENV = "production";
        await lg.info("mail to raw.person@corp.com", { _noRedact: true, note: "raw.person@corp.com" });
        await lg.flush();
        expect(files()).not.toContain("raw.person@corp.com");
        expect(files()).toContain("r*********@corp.com");
    });

    it("request helpers prefer originalUrl, fall back to url, and accept custom messages", async () => {
        const req: any = { method: "PUT", originalUrl: "/orig", url: "/inner", ip: "1.1.1.1", query: {}, get: () => undefined };
        await lg.logIncomingRequest(req);
        await lg.logIncomingRequest({ ...req, originalUrl: undefined } as any, "custom in");
        await lg.logCompletedRequest(req, { statusCode: 200 } as any, 1, "custom done");
        await lg.logCompletedRequest({ ...req, originalUrl: undefined } as any, { statusCode: 200 } as any, 1);
        await lg.logHandlingRequest({ ...req, originalUrl: undefined } as any);
        await lg.flush();
        const text = files();
        expect(text).toContain("custom in");
        expect(text).toContain("custom done");
        expect(text).toContain("Handling Request");
    });

    it("security() works without details", async () => {
        await lg.security("LOGIN_FAILED");
        await lg.flush();
        expect(files()).toContain('"event":"LOGIN_FAILED"');
    });

    it("shortenPath survives a failing process.cwd()", async () => {
        vi.spyOn(process, "cwd").mockImplementation(() => { throw new Error("gone"); });
        await lg.info("m", { function: "f", file: "/a/b/c.ts", line: 1 });
        await lg.flush();
        vi.restoreAllMocks();
        expect(files()).toContain("[f @ /a/b/c.ts:1]");
    });

    it("reports MB and GB sizes in getLogStats", async () => {
        const mb = 1024 * 1024;
        vi.spyOn(fs.promises, "readdir").mockResolvedValue(["a.log", "b.log"] as never);
        vi.spyOn(fs.promises, "stat").mockImplementation((async (p: string) => ({ size: String(p).endsWith("a.log") ? Math.round(1.5 * mb) : 3 * 1024 * mb, birthtime: new Date(0), mtime: new Date(0) })) as never);
        const stats: any = await lg.getLogStats();
        expect(stats.files.map((f: any) => f.sizeHuman)).toEqual(["1.5 MB", "3 GB"]);
    });
});
