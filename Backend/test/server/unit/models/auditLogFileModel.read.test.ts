"use strict";

/**
 * @fileoverview AuditLogFileModel read side and write edge cases: day-directory
 * resolution, JSON-lines parsing, the filter operators, pagination, aggregate
 * buckets, deleteMany, getLatestCreatedAt, and every swallow-and-warn error
 * arm. The filesystem is a virtual map behind fs.promises spies.
 */

import { promises as fs } from "fs";
import path from "path";

import AuditLogFileModel from "../../../../src/models/audit.log.file.model";
import { logger } from "../../../../src/utils/logger";

const BASE = AuditLogFileModel.CONFIG.BASE_DIR;

/** Same Manila-day formatting the model uses to name a day directory. */
function dayDir(date: Date): string {
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat("en-CA", AuditLogFileModel.CONFIG.DATE_OPTIONS)
            .formatToParts(date)
            .map(({ type, value }) => [type, value]),
    );
    return path.join(BASE, parts.year, parts.month, parts.day);
}

type VFile = { content: string; size?: number };
let files: Map<string, VFile>;

function install() {
    vi.spyOn(fs, "readdir").mockImplementation((async (dir: string) => {
        const names = [...files.keys()].filter((f) => path.dirname(f) === dir).map((f) => path.basename(f));
        if (names.length === 0) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return [...names, "readme.txt"];
    }) as never);
    vi.spyOn(fs, "stat").mockImplementation((async (p: string) => {
        const f = files.get(p);
        if (!f) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return { size: f.size ?? f.content.length };
    }) as never);
    vi.spyOn(fs, "readFile").mockImplementation((async (p: string) => files.get(p)!.content) as never);
}

const row = (over: Record<string, unknown> = {}) => ({
    REQUEST_ID: "r", USER_ID: 1, USERNAME: "alice", METHOD: "GET", ENDPOINT: "/api/x", STATUS_CATEGORY: "2xx",
    RESPONSE_TIME_MS: 10, CLIENT_IP: "1.1.1.1", CREATED_AT: "2026-03-05T04:00:00.000Z", ...over,
});
const jsonl = (...rs: unknown[]) => rs.map((r) => JSON.stringify(r)).join("\n") + "\n";

const FROM = new Date("2026-03-05T00:00:00Z");
const TO = new Date("2026-03-05T23:00:00Z");
const range = { CREATED_AT: { $gte: FROM, $lte: TO } };

describe("AuditLogFileModel read paths", function () {
    let warn: ReturnType<typeof vi.spyOn>;

    beforeEach(function () {
        files = new Map();
        warn = vi.spyOn(logger, "warning").mockImplementation(async () => {});
        install();
    });

    afterEach(function () {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    describe("findPaginated", function () {
        beforeEach(function () {
            const d = dayDir(FROM);
            files.set(
                path.join(d, "audit.log"),
                {
                    content:
                        jsonl(row({ REQUEST_ID: "old", CREATED_AT: "2026-03-05T01:00:00.000Z" }), row({ REQUEST_ID: "mid", CREATED_AT: "2026-03-05T02:00:00.000Z", USERNAME: "bob" })) +
                        "{not json\n\n",
                },
            );
            files.set(path.join(d, "audit_1.log"), { content: jsonl(row({ REQUEST_ID: "new", CREATED_AT: "2026-03-05T03:00:00.000Z", STATUS_CATEGORY: "5xx" })) });
            files.set(path.join(d, "audit_1700000000000.log"), { content: jsonl(row({ REQUEST_ID: "ts", CREATED_AT: "2026-03-05T05:00:00.000Z" })) });
            files.set(path.join(d, "other.log"), { content: jsonl(row({ REQUEST_ID: "ignored" })) });
        });

        it("returns matching rows newest first, skipping malformed lines and non-audit files", async function () {
            const out = await AuditLogFileModel.findPaginated(range, 1, 10);
            expect(out.map((r) => r.REQUEST_ID)).toEqual(["ts", "new", "mid", "old"]);
        });

        it("slices by page", async function () {
            const out = await AuditLogFileModel.findPaginated(range, 2, 2);
            expect(out.map((r) => r.REQUEST_ID)).toEqual(["mid", "old"]);
        });

        it("defaults an open-ended range to today", async function () {
            vi.useFakeTimers({ toFake: ["Date"] });
            vi.setSystemTime(new Date("2026-03-05T06:00:00Z"));
            const out = await AuditLogFileModel.findPaginated({}, 1, 10);
            expect(out.length).toBe(4);
            const onlyFrom = await AuditLogFileModel.findPaginated({ CREATED_AT: { $gte: FROM } }, 1, 10);
            expect(onlyFrom.length).toBe(4);
        });

        it("applies equality, $or, $gt, $regex and Date conditions", async function () {
            vi.useFakeTimers({ toFake: ["Date"] });
            vi.setSystemTime(new Date("2026-03-05T06:00:00Z")); // an exact-Date CREATED_AT leaves the range open: it defaults to today
            const f = (extra: Record<string, unknown>) => AuditLogFileModel.findPaginated({ ...range, ...extra }, 1, 10);
            expect((await f({ USERNAME: "bob" })).map((r) => r.REQUEST_ID)).toEqual(["mid"]);
            expect((await f({ $or: [{ USERNAME: "bob" }, { REQUEST_ID: "old" }] })).length).toBe(2);
            expect((await f({ $or: [{ USERNAME: "nobody" }] })).length).toBe(0);
            expect((await f({ $or: "bad" })).length).toBe(0);
            expect((await f({ RESPONSE_TIME_MS: { $gt: 9 } })).length).toBe(4);
            expect((await f({ RESPONSE_TIME_MS: { $gt: 10 } })).length).toBe(0);
            expect((await f({ MISSING: { $gt: 1 } })).length).toBe(0);
            expect((await f({ USERNAME: { $regex: "^AL" } })).length).toBe(3);
            expect((await f({ MISSING: { $regex: "x" } })).length).toBe(0);
            expect((await f({ USERNAME: { $regex: "(" } })).length).toBe(0); // invalid regex never matches
            expect((await f({ CREATED_AT: { $gte: new Date("2026-03-05T02:30:00Z"), $lte: new Date("2026-03-05T04:00:00Z") } })).map((r) => r.REQUEST_ID)).toEqual(["new"]);
            expect((await f({ CREATED_AT: new Date("2026-03-05T01:00:00Z") })).map((r) => r.REQUEST_ID)).toEqual(["old"]);
            expect((await f({ CREATED_AT: new Date("2030-01-01T00:00:00Z") })).length).toBe(0);
        });

        it("compares range bounds given as Dates against Date or garbage record values", async function () {
            files.set(path.join(dayDir(FROM), "audit_2.log"), { content: jsonl(row({ REQUEST_ID: "bad-ts", CREATED_AT: "garbage" })) });
            const out = await AuditLogFileModel.findPaginated({ CREATED_AT: { $gte: FROM, $lte: TO } }, 1, 20);
            expect(out.map((r) => r.REQUEST_ID)).not.toContain("bad-ts");
            const gteOnly = await AuditLogFileModel.findPaginated({ CREATED_AT: { $gte: FROM, $lte: TO }, REQUEST_ID: "ts" }, 1, 1);
            expect(gteOnly).toHaveLength(1);
        });

        it("skips files over the 50 MB read cap and files that vanish", async function () {
            files.set(path.join(dayDir(FROM), "audit_3.log"), { content: jsonl(row({ REQUEST_ID: "big" })), size: 60 * 1024 * 1024 });
            const out = await AuditLogFileModel.findPaginated(range, 1, 20);
            expect(out.map((r) => r.REQUEST_ID)).not.toContain("big");
            vi.spyOn(fs, "stat").mockRejectedValue(Object.assign(new Error("gone"), { code: "ENOENT" }));
            expect(await AuditLogFileModel.findPaginated(range, 1, 20)).toEqual([]);
        });

        it("warns and returns [] on a non-ENOENT read failure", async function () {
            vi.spyOn(fs, "readdir").mockRejectedValue(Object.assign(new Error("EACCES"), { code: "EACCES" }));
            expect(await AuditLogFileModel.findPaginated(range, 1, 10)).toEqual([]);
            expect(warn).toHaveBeenCalledWith("Audit log file read failed (findPaginated)", { error: "EACCES" });

            vi.spyOn(fs, "readdir").mockResolvedValue(["audit.log"] as never);
            vi.spyOn(fs, "stat").mockRejectedValue(Object.assign(new Error("EIO"), { code: "EIO" }));
            expect(await AuditLogFileModel.findPaginated(range, 1, 10)).toEqual([]);
        });
    });

    describe("countTotal and aggregate", function () {
        beforeEach(function () {
            files.set(path.join(dayDir(FROM), "audit.log"), {
                content: jsonl(
                    row({ STATUS_CATEGORY: "2xx", USER_ID: 1, RESPONSE_TIME_MS: 10 }),
                    row({ STATUS_CATEGORY: "3xx ", USER_ID: 2, RESPONSE_TIME_MS: 20 }),
                    row({ STATUS_CATEGORY: "4xx", USER_ID: 2, RESPONSE_TIME_MS: undefined }),
                    row({ STATUS_CATEGORY: "5xx", USER_ID: 0, RESPONSE_TIME_MS: 31 }),
                    row({ STATUS_CATEGORY: undefined, USER_ID: null }),
                ),
            });
        });

        it("counts matching rows", async function () {
            expect(await AuditLogFileModel.countTotal(range)).toBe(5);
            expect(await AuditLogFileModel.countTotal({ ...range, STATUS_CATEGORY: "4xx" })).toBe(1);
        });

        it("buckets by status category, counts unique positive user ids and averages response time", async function () {
            expect(await AuditLogFileModel.aggregate(range)).toEqual({
                total: 5, success: 1, redirect: 1, clientError: 1, serverError: 1, uniqueUsers: 2, avgResponseTime: 14,
            });
        });

        it("reports an all-zero aggregate for an empty range", async function () {
            expect(await AuditLogFileModel.aggregate({ CREATED_AT: { $gte: new Date("2020-01-01T00:00:00Z"), $lte: new Date("2020-01-01T23:00:00Z") } })).toMatchObject({ total: 0, avgResponseTime: 0 });
        });

        it("degrade to zeros with a warning when the filesystem fails", async function () {
            vi.spyOn(fs, "readdir").mockRejectedValue(Object.assign(new Error("EACCES"), { code: "EACCES" }));
            expect(await AuditLogFileModel.countTotal(range)).toBe(0);
            expect(await AuditLogFileModel.aggregate(range)).toMatchObject({ total: 0, uniqueUsers: 0 });
            expect(warn).toHaveBeenCalledTimes(2);
        });
    });

    describe("deleteMany", function () {
        it("returns zero without a complete date range", async function () {
            expect(await AuditLogFileModel.deleteMany({})).toEqual({ rowsAffected: 0 });
            expect(await AuditLogFileModel.deleteMany({ CREATED_AT: { $gte: FROM } })).toEqual({ rowsAffected: 0 });
        });

        it("counts the lines it removes per day and removes each directory", async function () {
            const d = dayDir(FROM);
            files.set(path.join(d, "audit.log"), { content: jsonl(row(), row()) });
            files.set(path.join(d, "audit_1.log"), { content: jsonl(row()) });
            const rm = vi.spyOn(fs, "rm").mockResolvedValue(undefined);
            const out = await AuditLogFileModel.deleteMany(range);
            expect(out).toEqual({ rowsAffected: 3 });
            expect(rm).toHaveBeenCalledWith(d, { recursive: true, force: true });
        });

        it("keeps going when one day fails", async function () {
            files.set(path.join(dayDir(FROM), "audit.log"), { content: jsonl(row()) });
            const rm = vi.spyOn(fs, "rm").mockRejectedValue(new Error("EBUSY"));
            await expect(AuditLogFileModel.deleteMany(range)).resolves.toBeTypeOf("object");
            expect(rm).toHaveBeenCalledTimes(1);
        });

        it("warns and returns zero on an unexpected failure", async function () {
            const bad: any = { CREATED_AT: { get $gte(): Date { throw new Error("boom"); }, $lte: TO } };
            expect(await AuditLogFileModel.deleteMany(bad)).toEqual({ rowsAffected: 0 });
            expect(warn).toHaveBeenCalledWith("Audit log file delete failed", { error: "boom" });
        });
    });

    describe("getLatestCreatedAt", function () {
        beforeEach(function () {
            vi.useFakeTimers({ toFake: ["Date"] });
            vi.setSystemTime(new Date("2026-03-05T06:00:00Z"));
        });

        it("returns the newest valid timestamp across today and yesterday", async function () {
            const today = new Date();
            const yesterday = new Date(today.getTime() - 86_400_000);
            files.set(path.join(dayDir(today), "audit.log"), { content: jsonl(row({ CREATED_AT: "2026-03-05T05:00:00.000Z" }), row({ CREATED_AT: "garbage" })) });
            files.set(path.join(dayDir(yesterday), "audit.log"), { content: jsonl(row({ CREATED_AT: "2026-03-04T23:00:00.000Z" })) });
            expect(await AuditLogFileModel.getLatestCreatedAt()).toBe(Date.parse("2026-03-05T05:00:00.000Z"));
        });

        it("returns 0 when there are no files or the read fails", async function () {
            expect(await AuditLogFileModel.getLatestCreatedAt()).toBe(0);
            vi.spyOn(fs, "readdir").mockRejectedValue(Object.assign(new Error("EACCES"), { code: "EACCES" }));
            expect(await AuditLogFileModel.getLatestCreatedAt()).toBe(0);
            expect(warn).toHaveBeenCalledWith("Audit log file read failed (getLatestCreatedAt)", { error: "EACCES" });
        });
    });

    describe("write edge cases", function () {
        beforeEach(function () {
            vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
            vi.spyOn(fs, "appendFile").mockResolvedValue(undefined);
        });

        afterEach(async function () {
            await AuditLogFileModel.drain();
        });

        it("tolerates EEXIST from mkdir but warns on other mkdir failures", async function () {
            (fs.mkdir as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(Object.assign(new Error("exists"), { code: "EEXIST" }));
            await AuditLogFileModel.insert(row());
            expect(fs.appendFile).toHaveBeenCalledTimes(1);

            (fs.mkdir as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(Object.assign(new Error("EACCES"), { code: "EACCES" }));
            await AuditLogFileModel.insert(row());
            expect(fs.appendFile).toHaveBeenCalledTimes(1);
            expect(warn).toHaveBeenCalledWith("Audit log file write failed", { error: "EACCES" });
        });

        it("falls through the rotation ladder and finally to a timestamped file", async function () {
            vi.useFakeTimers({ toFake: ["Date"] });
            vi.setSystemTime(new Date("2026-03-05T06:00:00Z"));
            const full = 50 * 1024 * 1024;
            vi.spyOn(fs, "stat").mockImplementation((async (p: string) => {
                if (/audit(_\d{1,3})?\.log$/.test(p)) return { size: p.endsWith("audit_2.log") ? 1 : full };
                return { size: full };
            }) as never);
            await AuditLogFileModel.insert(row());
            expect((fs.appendFile as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(/audit_2\.log$/);

            vi.spyOn(fs, "stat").mockResolvedValue({ size: full } as never);
            await AuditLogFileModel.insert(row());
            expect((fs.appendFile as unknown as ReturnType<typeof vi.fn>).mock.calls[1][0]).toMatch(/audit_\d{13}\.log$/);
        });

        it("propagates a non-ENOENT stat error as a swallowed, warned write failure", async function () {
            vi.spyOn(fs, "stat").mockRejectedValue(Object.assign(new Error("EIO"), { code: "EIO" }));
            await AuditLogFileModel.insert(row());
            expect(fs.appendFile).not.toHaveBeenCalled();
            expect(warn).toHaveBeenCalledWith("Audit log file write failed", { error: "EIO" });
        });

        it("insertBatch treats a non-array as empty", async function () {
            expect(await AuditLogFileModel.insertBatch(null as never)).toEqual({ rowsAffected: 0 });
        });
    });
});
