import path from "path";
import fs from "fs";
import os from "os";
import { EventEmitter } from "events";
import ServerRunMarker from "../../../src/utils/lifecycle/ServerRunMarker";

let dir: string;
let file: string;
let logger: { warning: ReturnType<typeof vi.fn> };
const proc = () => Object.assign(new EventEmitter(), { pid: 77 });
const err = (code: string) => Object.assign(new Error(code), { code });

function make(fsImpl: unknown) {
    return new ServerRunMarker({ filePath: file, runId: "r", version: "1", logger: logger as never, now: () => 5, processRef: proc(), hostname: "h", fs: fsImpl as typeof fs });
}
const wrap = (over: Partial<Record<keyof typeof fs, unknown>>) => ({ ...fs, ...over });

beforeEach(() => {
    vi.useFakeTimers();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "runmarker-chaos-"));
    file = path.join(dir, "server-run.json");
    logger = { warning: vi.fn() };
});
afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("ServerRunMarker atomic write chaos", () => {
    it.each(["EPERM", "EBUSY", "EACCES"])("rename %s (AV / indexer lock) falls back to a direct write and removes the tmp file", (code) => {
        const m = make(wrap({ renameSync: () => { throw err(code); } }));
        m.start();
        expect(JSON.parse(fs.readFileSync(file, "utf8")).state).toBe("RUNNING");
        expect(fs.readdirSync(dir)).toEqual(["server-run.json"]);
        expect(logger.warning).not.toHaveBeenCalled();
        m.stop();
    });

    it("fallback survives a failing tmp cleanup", () => {
        const m = make(wrap({ renameSync: () => { throw err("EPERM"); }, unlinkSync: () => { throw err("EPERM"); } }));
        m.start();
        expect(JSON.parse(fs.readFileSync(file, "utf8")).pid).toBe(77);
        m.stop();
    });

    it("a rename failure with another code is a write failure: warns once per process, never throws, tmp removed", () => {
        const m = make(wrap({ renameSync: () => { throw err("EIO"); } }));
        m.start();
        m.noteStopping("SIGTERM", 0);
        m.noteStopping("SIGTERM", 0);
        expect(logger.warning).toHaveBeenCalledTimes(1);
        expect(logger.warning.mock.calls[0][1]).toEqual({ _noNotify: true });
        expect(fs.readdirSync(dir)).toEqual([]);
        m.stop();
    });

    it("a rename error without a code is not mistaken for a lock", () => {
        const m = make(wrap({ renameSync: () => { throw null; } }));
        m.start();
        expect(logger.warning).toHaveBeenCalledTimes(1);
        m.stop();
    });

    it("the fallback write itself failing is reported as a write failure", () => {
        const real = fs.writeFileSync;
        const m = make(wrap({
            renameSync: () => { throw err("EPERM"); },
            writeFileSync: (p: string, d: string, o: object) => { if (!String(p).endsWith(".tmp")) throw err("ENOSPC"); return real(p, d, o as never); },
        }));
        m.start();
        expect(logger.warning).toHaveBeenCalledTimes(1);
        m.stop();
    });

    it("fsync failures are ignored and the marker is still readable", () => {
        const m = make(wrap({ fsyncSync: () => { throw err("EIO"); }, closeSync: () => { throw err("EIO"); } }));
        m.start();
        expect(JSON.parse(fs.readFileSync(file, "utf8")).state).toBe("RUNNING");
        expect(logger.warning).not.toHaveBeenCalled();
        m.stop();
    });

    it("open failure for fsync is ignored", () => {
        const m = make(wrap({ openSync: () => { throw err("EMFILE"); } }));
        m.start();
        expect(fs.existsSync(file)).toBe(true);
        m.stop();
    });

    it("a throwing logger can never break the marker", () => {
        logger.warning.mockImplementation(() => { throw new Error("log down"); });
        const m = make(wrap({ writeFileSync: () => { throw err("EIO"); } }));
        expect(() => m.start()).not.toThrow();
        m.stop();
    });

    it("the exit hook is silent even when every write fails", () => {
        const m = make(wrap({}));
        m.start();
        m._fs = wrap({ writeFileSync: () => { throw err("EIO"); } }) as typeof fs;
        logger.warning.mockClear();
        expect(() => m._onExit(1)).not.toThrow();
        expect(logger.warning).not.toHaveBeenCalled();
    });

    it("a half-written (truncated) marker from a power cut reads UNREADABLE, never CLEAN", () => {
        fs.writeFileSync(file, '{"schema":1,"state":"STOP');
        expect(make(fs).readPrevious().verdict).toBe("UNREADABLE");
    });
});
