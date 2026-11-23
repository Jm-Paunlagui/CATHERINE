import { ConsoleManager } from "../../../../src/utils/consoleManager";
import { logger } from "../../../../src/utils/logger";

let out: ReturnType<typeof vi.spyOn>;
let consoleLog: ReturnType<typeof vi.spyOn>;
let consoleClear: ReturnType<typeof vi.spyOn>;
let notice: ReturnType<typeof vi.spyOn>;
let warning: ReturnType<typeof vi.spyOn>;
let info: ReturnType<typeof vi.spyOn>;
const origTitle = process.title;
const origTty = process.stdout.isTTY;
const origPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const origAppName = process.env.APP_NAME;

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 1, 12, 0, 0));
    out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    consoleClear = vi.spyOn(console, "clear").mockImplementation(() => undefined);
    notice = vi.spyOn(logger, "notice").mockImplementation(() => undefined as never);
    warning = vi.spyOn(logger, "warning").mockImplementation(() => undefined as never);
    info = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    process.title = origTitle;
    Object.defineProperty(process.stdout, "isTTY", { value: origTty, configurable: true });
    Object.defineProperty(process, "platform", origPlatform);
    if (origAppName === undefined) delete process.env.APP_NAME; else process.env.APP_NAME = origAppName;
});

const setTty = (v: boolean) => Object.defineProperty(process.stdout, "isTTY", { value: v, configurable: true });
const setPlatform = (v: string) => Object.defineProperty(process, "platform", { value: v, configurable: true });

describe("ConsoleManager", () => {
    it("initialize sets title, prints the banner, schedules clearing, registers cleanup, and is idempotent", () => {
        const on = vi.spyOn(process, "on").mockImplementation(() => process);
        process.env.APP_NAME = "TestApp";
        const m = new ConsoleManager();
        m.initialize();
        m.initialize();
        expect(process.title).toBe("TestApp");
        expect(m.isInitialized).toBe(true);
        expect(m.clearIntervalId).not.toBeNull();
        expect(consoleLog).toHaveBeenCalled();
        expect(on.mock.calls.map((c) => c[0])).toEqual(["SIGTERM", "SIGINT", "exit"]);
        expect(notice).toHaveBeenCalledWith("Console Manager initialized successfully");
        const cleanup = on.mock.calls[0][1] as () => void;
        cleanup();
        expect(m.clearIntervalId).toBeNull();
        cleanup();
        expect(m.getStatus()).toMatchObject({ initialized: true, intervalActive: false, processTitle: "TestApp" });
    });

    it("uses the default title without APP_NAME", () => {
        delete process.env.APP_NAME;
        new ConsoleManager().setProcessTitle();
        expect(process.title).toBe("CATHERINE Backend Server");
    });

    it("warns when the runtime refuses the title or the setter throws", () => {
        const m = new ConsoleManager();
        const desc = Object.getOwnPropertyDescriptor(process, "title");
        let behave: "ignore" | "throw" = "ignore";
        Object.defineProperty(process, "title", {
            configurable: true,
            get: () => "other",
            set: () => { if (behave === "throw") throw new Error("denied"); },
        });
        try {
            m.setProcessTitle();
            expect(warning).toHaveBeenCalledWith(expect.stringContaining("Failed to set process title. Current: other"));
            behave = "throw";
            m.setProcessTitle();
            expect(warning).toHaveBeenLastCalledWith("Error setting process title:", { error: "denied" });
        } finally {
            if (desc) Object.defineProperty(process, "title", desc);
        }
    });

    it("clearConsole is a no-op without a TTY (escape bytes would pollute redirected logs)", () => {
        setTty(false);
        new ConsoleManager().clearConsole();
        expect(out).not.toHaveBeenCalled();
        expect(consoleClear).not.toHaveBeenCalled();
    });

    it("clearConsole uses the Windows or Unix escape sequence on a TTY", () => {
        setTty(true);
        const m = new ConsoleManager();
        setPlatform("win32");
        m.clearConsole();
        expect(out).toHaveBeenLastCalledWith("\x1B[2J\x1B[0f");
        setPlatform("linux");
        m.clearConsole();
        expect(out).toHaveBeenLastCalledWith("\x1B[2J\x1B[3J\x1B[H");
        expect(consoleClear).toHaveBeenCalledTimes(2);
    });

    it("clearConsole logs and survives a write failure", () => {
        setTty(true);
        out.mockImplementation(() => { throw new Error("EPIPE"); });
        new ConsoleManager().clearConsole();
        expect(warning).toHaveBeenCalledWith("Error clearing console:", { error: "EPIPE" });
    });

    it("clears only when the calendar day changes, checked hourly", () => {
        setTty(true);
        const m = new ConsoleManager();
        m.setupDailyConsoleClear();
        vi.advanceTimersByTime(60 * 60 * 1000);
        expect(info).not.toHaveBeenCalled();
        vi.setSystemTime(new Date(2026, 5, 2, 0, 30, 0));
        vi.advanceTimersByTime(60 * 60 * 1000);
        expect(info).toHaveBeenCalledWith("Console cleared for new day", expect.objectContaining({ date: new Date(2026, 5, 2).toDateString() }));
        expect(m.lastClearDate).toBe(new Date(2026, 5, 2).toDateString());
        m.checkAndClearConsole();
        expect(info).toHaveBeenCalledTimes(1);
        clearInterval(m.clearIntervalId!);
    });

    it("manualClear and forceReset clear, re-print the banner and log; forceReset refreshes the date", () => {
        setTty(false);
        const m = new ConsoleManager();
        m.lastClearDate = "stale";
        m.manualClear();
        expect(info).toHaveBeenLastCalledWith("Console manually cleared");
        m.forceReset();
        expect(info).toHaveBeenLastCalledWith("Console force reset completed");
        expect(m.lastClearDate).toBe(new Date().toDateString());
    });

    it("reports status with the next midnight", () => {
        const s = new ConsoleManager().getStatus();
        expect(s.initialized).toBe(false);
        expect(s.intervalActive).toBe(false);
        expect(s.nextClearCheck).toBe(new Date(2026, 5, 2, 0, 0, 0, 0).toISOString());
    });
});
