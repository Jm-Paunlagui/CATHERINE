import path from "path";
import fs from "fs";
import os from "os";
import { EventEmitter } from "events";
import ServerRunMarker, { resolveMarkerPath, pendingKey, pendingList } from "../../../../src/utils/lifecycle/ServerRunMarker";
import { SERVER_RUN_MARKER } from "../../../../src/constants/serverRunMarker";
import { APP_ROOT } from "../../../../src/utils/runtimePaths";

const { VERDICTS, STATES, STOP_REASONS, SCHEMA } = { ...SERVER_RUN_MARKER, SCHEMA: SERVER_RUN_MARKER.SCHEMA };

let dir: string;
let file: string;
let nowMs: number;
let proc: EventEmitter & { pid: number };
let logger: { warning: ReturnType<typeof vi.fn> };

function make(over: Record<string, unknown> = {}) {
    return new ServerRunMarker({
        filePath: file,
        runId: "run-1",
        version: "1.2.3",
        logger,
        now: () => nowMs,
        processRef: proc,
        hostname: "host-a",
        ...over,
    } as never);
}

function write(rec: Record<string, unknown>) {
    fs.writeFileSync(file, JSON.stringify({ schema: SCHEMA, hostname: "host-a", pid: 10, version: "0.9", ...rec }));
}
const read = () => JSON.parse(fs.readFileSync(file, "utf8"));

beforeEach(() => {
    vi.useFakeTimers();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "runmarker-"));
    file = path.join(dir, "data", "server-run.json");
    nowMs = 1_000_000;
    proc = Object.assign(new EventEmitter(), { pid: 4242 });
    logger = { warning: vi.fn() };
});
afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("resolveMarkerPath", () => {
    const key = SERVER_RUN_MARKER.PATH_OVERRIDE_ENV;
    it("uses an absolute override outside production", () => {
        const p = path.resolve("/tmp/x/marker.json");
        expect(resolveMarkerPath({ [key]: p, NODE_ENV: "test" })).toEqual({ path: p, ignoredOverride: null, ignoredReason: null });
    });
    it("ignores a relative override", () => {
        const r = resolveMarkerPath({ [key]: "rel/m.json" });
        expect(r.ignoredReason).toBe("relative");
        expect(r.ignoredOverride).toBe("rel/m.json");
        expect(r.path).toBe(path.join(APP_ROOT, "data", "server-run.json"));
    });
    it("ignores an override in production (CWE-15)", () => {
        const p = path.resolve("/tmp/x/marker.json");
        const r = resolveMarkerPath({ [key]: p, NODE_ENV: "production" });
        expect(r.ignoredReason).toBe("production");
        expect(r.path).toBe(path.join(APP_ROOT, "data", "server-run.json"));
    });
    it("defaults to APP_ROOT/data with no override and reads process.env by default", () => {
        expect(resolveMarkerPath({}).ignoredOverride).toBeNull();
        expect(resolveMarkerPath().path).toMatch(/server-run\.json$/);
    });
});

describe("pendingList / pendingKey", () => {
    it("normalises arrays, single objects and junk; caps at 5", () => {
        expect(pendingList({ a: 1 })).toEqual([{ a: 1 }]);
        expect(pendingList("x")).toEqual([]);
        expect(pendingList(undefined)).toEqual([]);
        const many = Array.from({ length: 8 }, (_, i) => ({ pid: i }));
        expect(pendingList([...many, 5, null])).toEqual(many.slice(3));
    });
    it("keys by pid and bootedAt with placeholders", () => {
        expect(pendingKey({ pid: 3, bootedAt: 9 })).toBe("3:9");
        expect(pendingKey({})).toBe("?:?");
        expect(pendingKey(null)).toBe("?:?");
    });
});

describe("readPrevious verdicts", () => {
    it("FIRST_BOOT when the file is missing", () => {
        expect(make().readPrevious()).toEqual({ verdict: VERDICTS.FIRST_BOOT, previous: null });
    });
    it("UNREADABLE on a non-ENOENT read error (carries cause)", () => {
        const m = make({ fs: { readFileSync: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } } });
        expect(m.readPrevious()).toMatchObject({ verdict: VERDICTS.UNREADABLE, cause: "denied" });
    });
    it("UNREADABLE when the thrown value is not an Error", () => {
        const m = make({ fs: { readFileSync: () => { throw "boom"; } } });
        expect(m.readPrevious().cause).toBe("boom");
    });
    it("UNREADABLE for malformed JSON and an empty file", () => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, "{nope");
        expect(make().readPrevious().verdict).toBe(VERDICTS.UNREADABLE);
        fs.writeFileSync(file, "");
        expect(make().readPrevious().verdict).toBe(VERDICTS.UNREADABLE);
    });
    it.each([
        ["null record", "null"],
        ["wrong schema", JSON.stringify({ schema: 99, state: "RUNNING" })],
        ["inherited state name", JSON.stringify({ schema: SCHEMA, state: "toString" })],
        ["non-string state", JSON.stringify({ schema: SCHEMA, state: 1 })],
        ["fractional pid", JSON.stringify({ schema: SCHEMA, state: "RUNNING", pid: 1.5 })],
        ["numeric version", JSON.stringify({ schema: SCHEMA, state: "RUNNING", version: 2 })],
        ["string heartbeat", JSON.stringify({ schema: SCHEMA, state: "RUNNING", lastHeartbeatAt: "x" })],
        ["non-boolean unsent flag", JSON.stringify({ schema: SCHEMA, state: "RUNNING", stopEmailUnsent: "y" })],
        ["pending of wrong type", JSON.stringify({ schema: SCHEMA, state: "RUNNING", pendingUnclean: [1] })],
        ["leader-lost of wrong type", JSON.stringify({ schema: SCHEMA, state: "RUNNING", pendingLeaderLost: 5 })],
    ])("UNREADABLE for %s", (_n, body) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, body);
        expect(make().readPrevious()).toMatchObject({ verdict: VERDICTS.UNREADABLE, previous: null, cause: "unexpected record shape" });
    });
    it("FIRST_BOOT with a cause for a record from another host", () => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        write({ state: "RUNNING", hostname: "other", lastStartNoticeAt: 5 });
        const m = make();
        expect(m.readPrevious()).toMatchObject({ verdict: VERDICTS.FIRST_BOOT, previous: null, cause: "record from another host" });
        expect(m.lastStartNoticeAt()).toBeNull();
    });
    it("CLEAN for STOPPED, exposing lastStartNoticeAt", () => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        write({ state: "STOPPED", lastStartNoticeAt: 77 });
        const m = make();
        expect(m.readPrevious().verdict).toBe(VERDICTS.CLEAN);
        expect(m.lastStartNoticeAt()).toBe(77);
        expect(m.filePath).toBe(file);
    });
    it("ignores a non-numeric lastStartNoticeAt", () => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        write({ state: "STOPPED", lastStartNoticeAt: "soon" });
        const m = make();
        m.readPrevious();
        expect(m.lastStartNoticeAt()).toBeNull();
    });
    it("HANDOVER when RUNNING under the same runId, queuing leader-lost", () => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        write({ state: "RUNNING", runId: "run-1", bootedAt: 1, lastHeartbeatAt: 2 });
        const m = make();
        expect(m.readPrevious().verdict).toBe(VERDICTS.HANDOVER);
        expect(m._pendingLeaderLost).toHaveLength(1);
        expect(m._pendingUnclean).toBeUndefined();
    });
    it("HANDOVER from a STOPPING record does not queue a leader loss", () => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        write({ state: "STOPPING", runId: "run-1" });
        const m = make();
        expect(m.readPrevious().verdict).toBe(VERDICTS.HANDOVER);
        expect(m._pendingLeaderLost).toBeUndefined();
    });
    it("UNCLEAN for RUNNING under another runId, carrying earlier pending entries", () => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        write({ state: "RUNNING", runId: "old", pendingUnclean: [{ pid: 1, bootedAt: 1 }], pendingLeaderLost: { pid: 2 } });
        const m = make();
        expect(m.readPrevious().verdict).toBe(VERDICTS.UNCLEAN);
        expect(m._pendingUnclean).toHaveLength(2);
        expect(m._pendingLeaderLost).toHaveLength(1);
    });
    it("UNCLEAN for a record without a runId and caps pending at 5", () => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        write({ state: "STOPPING", pendingUnclean: Array.from({ length: 5 }, (_, i) => ({ pid: i })) });
        const m = make();
        expect(m.readPrevious().verdict).toBe(VERDICTS.UNCLEAN);
        expect(m._pendingUnclean).toHaveLength(5);
        expect(m._pendingUnclean?.at(-1)).toMatchObject({ pid: 10, state: "STOPPING" });
    });
});

describe("lifecycle writes", () => {
    it("start writes RUNNING, heartbeats, and is idempotent", () => {
        const m = make();
        m.start();
        m.start();
        expect(read()).toMatchObject({ state: "RUNNING", pid: 4242, bootedAt: 1_000_000, hostname: "host-a" });
        nowMs += 30_000;
        vi.advanceTimersByTime(SERVER_RUN_MARKER.HEARTBEAT_INTERVAL_MS);
        expect(read().lastHeartbeatAt).toBe(1_030_000);
        expect(proc.listenerCount("exit")).toBe(1);
        m.stop();
    });
    it("heartbeat does not overwrite a STOPPING record", () => {
        const m = make();
        m.start();
        m.noteStopping("SIGTERM", 0);
        nowMs += 99;
        vi.advanceTimersByTime(30_000);
        expect(read().state).toBe(STATES.STOPPING);
        expect(read().lastHeartbeatAt).toBe(1_000_000);
        m.stop();
    });
    it("start swallows an unref-less timer and mkdir failures", () => {
        const m = make({ fs: { ...fs, mkdirSync: () => { throw new Error("x"); }, writeFileSync: () => { throw new Error("w"); }, unlinkSync: () => { throw new Error("u"); } } });
        expect(() => m.start()).not.toThrow();
        expect(logger.warning).toHaveBeenCalledTimes(1);
        m.stop();
    });
    it("a failed first write unlinks the stale record", () => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        write({ state: "STOPPED" });
        const real = fs;
        const m = make({ fs: { ...real, writeFileSync: (p: string, d: string, o: object) => { if (String(p).endsWith(".tmp")) throw new Error("full"); return real.writeFileSync(p, d, o); } } });
        m.start();
        expect(fs.existsSync(file)).toBe(false);
        m.stop();
    });
    it("start never throws when now() throws", () => {
        const m = make({ now: () => { throw new Error("clock"); } });
        expect(() => m.start()).not.toThrow();
    });
    it("calls before start are no-ops", () => {
        const m = make();
        m.noteStopping("SIGTERM", 0);
        m.noteForcedExit(5);
        m.noteStopUnreported();
        m.noteTeardownComplete(0);
        m.noteExitCodeRaised(1);
        expect(fs.existsSync(file)).toBe(false);
    });
    it("noteStopping: SIGNAL for exit 0, CRASH for non-zero, custom reason honoured, unreported flagged", () => {
        const a = make();
        a.start();
        a.noteStopping("SIGINT", 0);
        a.noteTeardownComplete(0);
        expect(read()).toMatchObject({ state: "STOPPED", stopReason: STOP_REASONS.SIGNAL, exitCode: 0, stopSignal: "SIGINT" });
        a.stop();
        const b = make();
        b.start();
        b.noteStopping("SIGTERM", 1);
        expect(b._reason).toBe(STOP_REASONS.CRASH);
        b.stop();
        const c = make();
        c.start();
        c.noteStopping("DISCONNECT", 0, { unreported: true, reason: STOP_REASONS.PRIMARY_DISCONNECT });
        expect(c._reason).toBe(STOP_REASONS.PRIMARY_DISCONNECT);
        expect(read().unreported).toBe(true);
        c.stop();
    });
    it("a crash already raised keeps CRASH/reported over a later reason", () => {
        const m = make();
        m.start();
        m.noteExitCodeRaised(1);
        m.noteStopping("DISCONNECT", 0, { unreported: true, reason: STOP_REASONS.PRIMARY_DISCONNECT });
        expect(m._reason).toBe(STOP_REASONS.CRASH);
        expect(m._unreported).toBeUndefined();
        m.stop();
    });
    it("noteForcedExit records FORCED_EXIT in RUNNING and, once STOPPED, as a complete STOPPED record with code 1", () => {
        const m = make();
        m.start();
        m.noteForcedExit(1800);
        expect(read()).toMatchObject({ state: "RUNNING", forcedAfterMs: 1800 });
        m.noteTeardownComplete(0);
        m.noteForcedExit(1800);
        expect(read()).toMatchObject({ state: "STOPPED", exitCode: 1, stopReason: STOP_REASONS.FORCED_EXIT });
        m.stop();
    });
    it("noteStopUnreported marks the record, in RUNNING and after STOPPED", () => {
        const m = make();
        m.start();
        m.noteStopUnreported();
        expect(read()).toMatchObject({ unreported: true, stopEmailUnsent: true, state: "RUNNING" });
        m.noteTeardownComplete(0);
        m.noteStopUnreported();
        expect(read()).toMatchObject({ state: "STOPPED", stopEmailUnsent: true });
        m.stop();
    });
    it("noteTeardownComplete stops the heartbeat and writes STOPPED once (stoppedAt is kept)", () => {
        const m = make();
        m.start();
        m.noteTeardownComplete(0);
        const first = read().stoppedAt;
        nowMs += 5000;
        m.noteTeardownComplete(0);
        expect(read().stoppedAt).toBe(first);
        expect(m._timer).toBeNull();
    });
    it("noteExitCodeRaised: after STOPPED rewrites with the higher code and CRASH reason", () => {
        const m = make();
        m.start();
        m.noteStopping("SIGTERM", 0);
        m.noteTeardownComplete(0);
        m.noteExitCodeRaised(2);
        expect(read()).toMatchObject({ state: "STOPPED", exitCode: 2, stopReason: STOP_REASONS.CRASH });
        m.noteExitCodeRaised(1);
        expect(read().exitCode).toBe(2);
        m.stop();
    });
    it("noteExitCodeRaised during a clean stop takes reason/unreported; STOPPING rewrites, RUNNING does not", () => {
        const m = make();
        m.start();
        m.noteExitCodeRaised(0, { reason: STOP_REASONS.PRIMARY_DISCONNECT });
        expect(read().unreported).toBeUndefined();
        m.noteStopping("SIGTERM", 0);
        m.noteExitCodeRaised(0, { unreported: true, reason: STOP_REASONS.PRIMARY_DISCONNECT });
        expect(m._reason).toBe(STOP_REASONS.PRIMARY_DISCONNECT);
        expect(read().unreported).toBe(true);
        m.noteExitCodeRaised(Number.NaN);
        expect(m._raisedExitCode).toBe(0);
        m.stop();
    });
    it("clearPendingUnclean drops all or only the keyed entries and rewrites by state", () => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        write({ state: "RUNNING", runId: "old", pendingUnclean: [{ pid: 1, bootedAt: 1 }, { pid: 2, bootedAt: 2 }] });
        const m = make();
        m.readPrevious();
        expect(m._pendingUnclean).toHaveLength(3);
        m.clearPendingUnclean(["1:1"]);
        expect(m._pendingUnclean).toHaveLength(2);
        m.start();
        m.clearPendingUnclean(["2:2"]);
        expect(read().pendingUnclean).toHaveLength(1);
        m.noteTeardownComplete(0);
        m.clearPendingUnclean();
        expect(read().pendingUnclean).toBeUndefined();
        expect(read().state).toBe("STOPPED");
        m.clearPendingUnclean();
        m.stop();
    });
    it("clearPendingLeaderLost mirrors clearPendingUnclean", () => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        write({ state: "RUNNING", runId: "run-1", pendingLeaderLost: [{ pid: 7, bootedAt: 7 }] });
        const m = make();
        m.clearPendingLeaderLost();
        m.readPrevious();
        expect(m._pendingLeaderLost).toHaveLength(2);
        m.clearPendingLeaderLost(["7:7"]);
        expect(m._pendingLeaderLost).toHaveLength(1);
        m.start();
        m.clearPendingLeaderLost(["10:?"]);
        m.clearPendingLeaderLost(["10:undefined", "x"]);
        m.noteTeardownComplete(0);
        m.clearPendingLeaderLost();
        expect(read().pendingLeaderLost).toBeUndefined();
        m.stop();
    });
    it("recordStartNotice persists the time (RUNNING and STOPPED) and works before start", () => {
        const m = make();
        m.recordStartNotice(55);
        expect(fs.existsSync(file)).toBe(false);
        m.start();
        m.recordStartNotice(66);
        expect(read().lastStartNoticeAt).toBe(66);
        m.noteTeardownComplete(0);
        m.recordStartNotice(88);
        expect(read()).toMatchObject({ state: "STOPPED", lastStartNoticeAt: 88 });
        m.stop();
    });
    it("the exit hook writes a final STOPPED record with the exit code, synchronously and silently", () => {
        const m = make();
        m.start();
        proc.emit("exit", 3);
        expect(read()).toMatchObject({ state: "STOPPED", exitCode: 3, stopReason: STOP_REASONS.EXIT });
        expect(logger.warning).not.toHaveBeenCalled();
    });
    it("exit hook is swallowed when the clock throws", () => {
        const m = make();
        m.start();
        m._now = () => { throw new Error("x"); };
        expect(() => m._onExit(0)).not.toThrow();
        m.stop();
    });
    it("stop tolerates a throwing clearInterval target", () => {
        const m = make();
        m._timer = 1 as never;
        const spy = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => { throw new Error("x"); });
        expect(() => m.stop()).not.toThrow();
        spy.mockRestore();
        expect(m._timer).toBeNull();
    });
    it("note* methods swallow a throwing clock", () => {
        const m = make();
        m.start();
        m._now = () => { throw new Error("x"); };
        expect(() => { m.noteStopping("S", 0); m.noteTeardownComplete(0); m.noteForcedExit(1); }).not.toThrow();
        m.stop();
    });
});
