"use strict";

/**
 * @fileoverview SystemLogTailService: SSE live-tail poller over the RFC 5424
 * level files. Tails a real temp directory (clock pinned via Date-only fake
 * timers) and drives the interval/error paths with fully faked timers.
 */

import { promises as fs } from "fs";
import os from "os";
import path from "path";

import { SystemLogTailService } from "../../../../src/services/SystemLogTailService";
import tailSingleton from "../../../../src/services/SystemLogTailService";
import { logger } from "../../../../src/utils/logger";

type Sent = { event: string; data: any };

function fakeRes(opts: { flush?: boolean; throwOnWrite?: boolean } = {}) {
    const sent: Sent[] = [];
    let pendingEvent = "";
    const res: any = {
        write: vi.fn((chunk: string) => {
            if (opts.throwOnWrite) throw new Error("socket closed");
            if (chunk.startsWith("event: ")) pendingEvent = chunk.slice(7).trim();
            else if (chunk.startsWith("data: ")) sent.push({ event: pendingEvent, data: JSON.parse(chunk.slice(6)) });
        }),
    };
    if (opts.flush) res.flush = vi.fn();
    return { res, sent };
}

const line = (lvl: string, msg: string) =>
    `[H (S) 1.1.1.1] [2026-03-05 10:00:00.000] [${lvl}] [PID:1] [f @ src/a.ts:1] [FUNC] - ${msg}\n`;

describe("SystemLogTailService", function () {
    let base: string;
    let dir: string;
    let svc: SystemLogTailService;

    beforeEach(async function () {
        vi.spyOn(logger, "info").mockImplementation(async () => {});
        vi.spyOn(logger, "notice").mockImplementation(async () => {});
        vi.spyOn(logger, "warning").mockImplementation(async () => {});
        vi.spyOn(logger, "error").mockImplementation(async () => {});
        base = await fs.mkdtemp(path.join(os.tmpdir(), "systail-"));
        dir = path.join(base, "2026", "03", "05");
        await fs.mkdir(dir, { recursive: true });
        svc = new SystemLogTailService({ logBaseDir: base });
    });

    afterEach(async function () {
        // Stop any timer a test left running before removing files.
        for (const id of [...svc._connections.keys()]) svc.removeConnection(id);
        vi.useRealTimers();
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
        await fs.rm(base, { recursive: true, force: true });
    });

    describe("construction and connection registry", function () {
        it("defaults to the audit service log directory and exports a singleton", function () {
            expect(new SystemLogTailService()._logBaseDir).toMatch(/logs$/);
            expect(tailSingleton.SystemLogTailService).toBe(SystemLogTailService);
        });

        it("reads the poll interval from env with a 5s fallback", function () {
            expect(svc._pollIntervalMs()).toBe(5000);
            vi.stubEnv("SYSTEM_LOG_STREAM_POLL_MS", "750");
            expect(svc._pollIntervalMs()).toBe(750);
        });

        it("registers, reports and removes connections, coercing a bad maxPriority to 5", function () {
            vi.useFakeTimers();
            const { res } = fakeRes();
            svc.addConnection("u1", res, 2.5 as number, "");
            expect(svc.hasConnection("u1")).toBe(true);
            expect(svc._connections.get("u1")).toMatchObject({ maxPriority: 5, level: null, pollCount: 0 });
            expect(svc._timer).not.toBeNull();

            svc.removeConnection("ghost"); // unknown id: still stopped-check, no throw
            expect(svc._timer).not.toBeNull();
            svc.removeConnection("u1");
            expect(svc.hasConnection("u1")).toBe(false);
            expect(svc._timer).toBeNull();
        });

        it("starts one timer for many connections and keeps it until the last leaves", function () {
            vi.useFakeTimers();
            svc.addConnection("a", fakeRes().res, 5);
            const timer = svc._timer;
            svc.addConnection("b", fakeRes().res, 5, "ERROR");
            expect(svc._timer).toBe(timer);
            svc.removeConnection("a");
            expect(svc._timer).toBe(timer);
            svc.removeConnection("b");
            expect(svc._timer).toBeNull();
        });
    });

    describe("interval driver", function () {
        it("ticks on the interval, skips overlapping ticks and routes tick errors", async function () {
            vi.useFakeTimers();
            let release!: () => void;
            const tick = vi.spyOn(svc, "_tick").mockImplementation(() => new Promise<void>((r) => { release = r; }));
            svc.addConnection("u", fakeRes().res, 5);

            await vi.advanceTimersByTimeAsync(5000);
            await vi.advanceTimersByTimeAsync(5000); // previous tick still running
            expect(tick).toHaveBeenCalledTimes(1);
            release();
            await vi.advanceTimersByTimeAsync(0);
            await vi.advanceTimersByTimeAsync(5000);
            expect(tick).toHaveBeenCalledTimes(2);

            tick.mockRejectedValue(new Error("boom"));
            release();
            await vi.advanceTimersByTimeAsync(5000);
            expect(svc._consecutiveErrors).toBe(1);
        });
    });

    describe("_onTickError", function () {
        it("counts errors, then after five notifies clients, clears connections and stops the timer", function () {
            vi.useFakeTimers();
            const { res, sent } = fakeRes();
            svc.addConnection("u", res, 5);
            for (let i = 0; i < 4; i++) svc._onTickError(new Error("x"));
            expect(svc.hasConnection("u")).toBe(true);
            svc._onTickError(undefined as unknown as Error);
            expect(sent.at(-1)).toMatchObject({ event: "error", data: { code: "POLL_FAILED" } });
            expect(svc._connections.size).toBe(0);
            expect(svc._timer).toBeNull();
        });

        it("tolerates a missing timer when the cap is reached", function () {
            svc._consecutiveErrors = 4;
            svc._onTickError(new Error("x"));
            expect(svc._timer).toBeNull();
        });
    });

    describe("_tick", function () {
        beforeEach(function () {
            vi.useFakeTimers({ toFake: ["Date"] });
            vi.setSystemTime(new Date("2026-03-05T04:00:00Z")); // 12:00 in Manila, same date
        });

        it("does nothing with no connections", async function () {
            const readdir = vi.spyOn(fs, "readdir");
            await svc._tick();
            expect(readdir).not.toHaveBeenCalled();
        });

        it("heartbeats when the day directory is missing and marks it initialised", async function () {
            vi.setSystemTime(new Date("2026-04-01T04:00:00Z"));
            const { res, sent } = fakeRes({ flush: true });
            svc._connections.set("u", { res, maxPriority: 5, level: null, pollCount: 0 });
            await svc._tick();
            expect(sent).toEqual([{ event: "heartbeat", data: expect.objectContaining({ pollCount: 1 }) }]);
            expect(res.flush).toHaveBeenCalled();
            expect(svc._initializedDir).toBe(true);
        });

        it("skips pre-existing content on the first scan, then streams only appended lines", async function () {
            await fs.writeFile(path.join(dir, "info.log"), line("INFO", "old"));
            await fs.writeFile(path.join(dir, "notes.txt"), "x");
            const { res, sent } = fakeRes();
            svc._connections.set("u", { res, maxPriority: 6, level: null, pollCount: 0 });

            await svc._tick();
            expect(sent.map((s) => s.event)).toEqual(["heartbeat"]);

            await fs.appendFile(path.join(dir, "info.log"), line("INFO", "new one") + "\n");
            await svc._tick();
            expect(sent[1].event).toBe("lines");
            expect(sent[1].data.lines.map((l: any) => l.message)).toEqual(["new one"]);
            expect(sent[1].data.dropped).toBe(0);

            await svc._tick(); // unchanged size
            expect(sent[2].event).toBe("heartbeat");
        });

        it("reads a file that appears after the first scan from byte zero", async function () {
            const { res, sent } = fakeRes();
            svc._connections.set("u", { res, maxPriority: 6, level: null, pollCount: 0 });
            await svc._tick();
            await fs.writeFile(path.join(dir, "error.log"), line("ERROR", "fresh"));
            await svc._tick();
            expect(sent[1].data.lines[0].message).toBe("fresh");
        });

        it("filters per connection by priority ceiling and by exact level", async function () {
            const a = fakeRes();
            const b = fakeRes();
            svc._connections.set("ceiling", { res: a.res, maxPriority: 3, level: null, pollCount: 0 });
            svc._connections.set("exact", { res: b.res, maxPriority: 0, level: "INFO", pollCount: 0 });
            await svc._tick();
            await fs.writeFile(path.join(dir, "error.log"), line("ERROR", "e"));
            await fs.writeFile(path.join(dir, "info.log"), line("INFO", "i") + "\n   \n");
            await svc._tick();
            expect(a.sent[1].data.lines.map((l: any) => l.message)).toEqual(["e"]);
            expect(b.sent[1].data.lines.map((l: any) => l.message)).toEqual(["i"]);
        });

        it("detects rotation (file shrank) and re-reads from the start", async function () {
            const file = path.join(dir, "info.log");
            await fs.writeFile(file, line("INFO", "a very long original line ".repeat(4)));
            const { res, sent } = fakeRes();
            svc._connections.set("u", { res, maxPriority: 6, level: null, pollCount: 0 });
            await svc._tick();
            await fs.writeFile(file, line("INFO", "r"));
            await svc._tick();
            expect(logger.warning).toHaveBeenCalled();
            expect(sent[1].data.lines.map((l: any) => l.message)).toEqual(["r"]);
        });

        it("caps lines per tick and reports how many were dropped", async function () {
            const { res, sent } = fakeRes();
            svc._connections.set("u", { res, maxPriority: 6, level: null, pollCount: 0 });
            await svc._tick();
            await fs.writeFile(path.join(dir, "info.log"), Array.from({ length: 230 }, (_, i) => line("INFO", `m${i}`)).join(""));
            await svc._tick();
            expect(sent[1].data.lines).toHaveLength(200);
            expect(sent[1].data.dropped).toBe(30);
        });

        it("resets offsets when the Manila date rolls over", async function () {
            const { res } = fakeRes();
            svc._connections.set("u", { res, maxPriority: 6, level: null, pollCount: 0 });
            await svc._tick();
            expect(svc._currentDir).toBe(dir);
            svc._offsets.set("info.log", 99);
            vi.setSystemTime(new Date("2026-03-06T04:00:00Z"));
            await svc._tick();
            expect(svc._offsets.size).toBe(0);
            expect(svc._currentDir).toBe(path.join(base, "2026", "03", "06"));
        });

        it("skips a file that vanishes between readdir and stat", async function () {
            await fs.writeFile(path.join(dir, "info.log"), "x");
            const { res, sent } = fakeRes();
            svc._connections.set("u", { res, maxPriority: 6, level: null, pollCount: 0 });
            vi.spyOn(fs, "stat").mockRejectedValue(new Error("ENOENT"));
            await svc._tick();
            expect(sent[0].event).toBe("heartbeat");
        });

        it("clears the error streak after a good tick", async function () {
            await fs.writeFile(path.join(dir, "info.log"), "");
            svc._connections.set("u", { res: fakeRes().res, maxPriority: 6, level: null, pollCount: 0 });
            svc._consecutiveErrors = 3;
            await svc._tick();
            expect(svc._consecutiveErrors).toBe(0);
        });
    });

    describe("_readDelta and _safeSend", function () {
        it("returns an empty string for an empty range or unreadable file", async function () {
            expect(await svc._readDelta("/nope", 5, 5)).toBe("");
            expect(await svc._readDelta(path.join(base, "missing.log"), 0, 10)).toBe("");
        });

        it("reads exactly the requested byte range", async function () {
            const f = path.join(base, "r.log");
            await fs.writeFile(f, "0123456789");
            expect(await svc._readDelta(f, 3, 7)).toBe("3456");
        });

        it("swallows write errors from a closed socket", function () {
            const { res } = fakeRes({ throwOnWrite: true });
            expect(() => svc._safeSend(res, "heartbeat", {})).not.toThrow();
        });
    });
});
