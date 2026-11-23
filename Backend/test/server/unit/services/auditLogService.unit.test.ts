"use strict";

/**
 * @fileoverview Unit tests for AuditLogService read/export/delete paths:
 * endpoint normalisation, list/stat shaping, request-trace reading, the system
 * log browser, Excel/ZIP exports and range deletion. The DB model and the
 * filesystem are faked; the system-log browser reads a real temp directory.
 */

import { promises as fs } from "fs";
import os from "os";
import path from "path";
import ExcelJS from "exceljs";

import AuditLogService from "../../../../src/services/AuditLogService";
import AuditLogModel from "../../../../src/models/audit.log.model";
import { logger } from "../../../../src/utils/logger";

async function rejection(p: Promise<unknown>): Promise<any> {
    try {
        await p;
    } catch (err) {
        return err;
    }
    throw new Error("expected rejection");
}

const REQ_ID = "0078812966528-0448-0000";

describe("AuditLogService", function () {
    beforeEach(function () {
        vi.spyOn(logger, "info").mockImplementation(async () => {});
        vi.spyOn(logger, "warning").mockImplementation(async () => {});
    });

    afterEach(function () {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    describe("_normalizeEndpointFilter", function () {
        it("returns null for non-strings, blanks and bare verbs", function () {
            const n = AuditLogService._normalizeEndpointFilter;
            expect(n(undefined)).toBeNull();
            expect(n(42 as unknown as string)).toBeNull();
            expect(n("   ")).toBeNull();
            expect(n("get")).toBeNull();
        });

        it("strips a leading HTTP verb but never mangles a path containing a space", function () {
            const n = AuditLogService._normalizeEndpointFilter;
            expect(n("GET /api/v1/auth/login")).toBe("/api/v1/auth/login");
            expect(n("/api/v1/auth/login")).toBe("/api/v1/auth/login");
            expect(n("/odd path/here")).toBe("/odd path/here");
            expect(n("POST    ")).toBeNull();
        });

        it("caps oversized values at 500 chars", function () {
            expect(n500().length).toBe(500);
            function n500() {
                return AuditLogService._normalizeEndpointFilter("/" + "a".repeat(900)) as string;
            }
        });
    });

    describe("getList", function () {
        let find: ReturnType<typeof vi.spyOn>;
        let count: ReturnType<typeof vi.spyOn>;
        beforeEach(function () {
            find = vi.spyOn(AuditLogModel, "findPaginated").mockResolvedValue([{ a: 1 }] as never);
            count = vi.spyOn(AuditLogModel, "countTotal").mockResolvedValue(250 as never);
        });

        it("caps page size at 100 and computes totalPages", async function () {
            const out = await AuditLogService.getList({ page: 2, pageSize: 500 });
            expect(find).toHaveBeenCalledWith({}, 2, 100);
            expect(count).toHaveBeenCalledWith({});
            expect(out).toMatchObject({ total: 250, page: 2, pageSize: 100, totalPages: 3 });
        });

        it("rejects an inverted or unparseable date range with 400", async function () {
            const e1 = await rejection(
                AuditLogService.getList({ page: 1, pageSize: 10, fromDate: "2026-02-02", toDate: "2026-01-01" }),
            );
            expect(e1.statusCode).toBe(400);
            const e2 = await rejection(
                AuditLogService.getList({ page: 1, pageSize: 10, fromDate: "nope", toDate: "2026-01-01" }),
            );
            expect(e2.statusCode).toBe(400);
            expect(find).not.toHaveBeenCalled();
        });

        it("builds date, method, status and exact endpoint filters", async function () {
            await AuditLogService.getList({
                page: 1,
                pageSize: 10,
                fromDate: "2026-01-01",
                toDate: "2026-01-02",
                method: "GET",
                statusCategory: "4xx",
                endpoint: "GET /api/x",
            });
            const filter = find.mock.calls[0][0] as any;
            expect(filter.METHOD).toBe("GET");
            expect(filter.STATUS_CATEGORY).toBe("4xx");
            expect(filter.ENDPOINT).toBe("/api/x");
            expect(filter.CREATED_AT.$gte).toEqual(new Date("2026-01-01"));
            expect(filter.CREATED_AT.$lte.getHours()).toBe(23);
        });

        it("escapes regex metacharacters in search and adds USER_ID only for integers", async function () {
            await AuditLogService.getList({ page: 1, pageSize: 10, search: " a.b(c) " });
            const text = (find.mock.calls[0][0] as any).$or;
            expect(text[0].USERNAME.$regex).toBe("a\\.b\\(c\\)");
            expect(text).toHaveLength(4);

            await AuditLogService.getList({ page: 1, pageSize: 10, search: "42" });
            const numeric = (find.mock.calls[1][0] as any).$or;
            expect(numeric).toHaveLength(5);
            expect(numeric[4]).toEqual({ USER_ID: 42 });
        });

        it("caps the search term at 100 characters (ReDoS guard)", async function () {
            await AuditLogService.getList({ page: 1, pageSize: 10, search: "x".repeat(400) });
            expect((find.mock.calls[0][0] as any).$or[0].USERNAME.$regex).toHaveLength(100);
        });
    });

    describe("getStats", function () {
        const agg = (over: Record<string, number> = {}) => ({
            total: 100, success: 70, redirect: 10, clientError: 10, serverError: 10,
            uniqueUsers: 3, avgResponseTime: 12, ...over,
        });

        it("excludes 4xx from availability and reports independent error shares", async function () {
            vi.spyOn(AuditLogModel, "aggregate").mockResolvedValue(agg() as never);
            const out: any = await AuditLogService.getStats({ fromDate: "2026-01-01", toDate: "2026-01-31" });
            expect(out.successRate).toBeCloseTo((80 / 90) * 100, 0);
            expect(out.clientErrorRate).toBe(10);
            expect(out.serverErrorRate).toBe(10);
            expect(out.fromDate).toBe(new Date("2026-01-01").toISOString());
        });

        it("defaults to a trailing 30-day window and reports 100% / 0% on empty data", async function () {
            vi.useFakeTimers();
            vi.setSystemTime(new Date("2026-06-15T10:00:00Z"));
            const spy = vi
                .spyOn(AuditLogModel, "aggregate")
                .mockResolvedValue(agg({ total: 0, success: 0, redirect: 0, clientError: 0, serverError: 0 }) as never);
            const out: any = await AuditLogService.getStats({});
            expect(out.successRate).toBe(100);
            expect(out.clientErrorRate).toBe(0);
            expect(out.serverErrorRate).toBe(0);
            const range = (spy.mock.calls[0][0] as any).CREATED_AT;
            expect(range.$gte.getTime()).toBe(Date.now() - 30 * 86_400_000);
        });

        it("reports 100% availability when every request was a client error", async function () {
            vi.spyOn(AuditLogModel, "aggregate").mockResolvedValue(
                agg({ total: 5, success: 0, redirect: 0, clientError: 5, serverError: 0 }) as never,
            );
            const out: any = await AuditLogService.getStats({});
            expect(out.successRate).toBe(100);
            expect(out.clientErrorRate).toBe(100);
        });
    });

    describe("getRequestLogs", function () {
        it("rejects malformed request ids and dates with 400", async function () {
            for (const bad of ["", "abc", "../etc", "req_" + "a".repeat(40)]) {
                const err = await rejection(AuditLogService.getRequestLogs(bad, "2026-01-01"));
                expect(err.statusCode).toBe(400);
            }
            const err = await rejection(AuditLogService.getRequestLogs(REQ_ID, "2026/01/01"));
            expect(err.statusCode).toBe(400);
            const err2 = await rejection(AuditLogService.getRequestLogs(REQ_ID, undefined));
            expect(err2.statusCode).toBe(400);
        });

        it("returns no lines when the day directory is missing", async function () {
            vi.spyOn(fs, "readdir").mockRejectedValue(new Error("ENOENT"));
            await expect(AuditLogService.getRequestLogs(REQ_ID, "2026-01-01")).resolves.toEqual({
                requestId: REQ_ID,
                lines: [],
            });
        });

        it("merges matching lines across level files, sorts by time, skips oversized/unreadable files", async function () {
            vi.spyOn(fs, "readdir").mockResolvedValue([
                "info.log", "error.log", "huge.log", "debug.log", "notes.txt", "warn_2.log",
            ] as never);
            vi.spyOn(fs, "stat").mockImplementation((async (p: string) => ({
                size: p.endsWith("debug.log") ? 11 * 1024 * 1024 : 10,
            })) as never);
            vi.spyOn(fs, "readFile").mockImplementation((async (p: string) => {
                if (p.endsWith("warn_2.log")) throw new Error("EACCES");
                if (p.endsWith("error.log"))
                    return `[H] [2026-01-01 10:00:05.000] [ERROR] x [${REQ_ID}] [Request Complete] - done\nunrelated\n`;
                return [
                    `[H] [2026-01-01 10:00:05] [INFO] [${REQ_ID}] [Request Complete] - second precision complete`,
                    `[H] [2026-01-01 10:00:05] [INFO] [${REQ_ID}] [Incoming Request] - second precision incoming`,
                    `[H] [2026-01-01 10:00:05] [INFO] [${REQ_ID}] [FUNC] - handler`,
                    `[H] [2026-01-01 09:00:00.100] [INFO] [${REQ_ID}] early`,
                    "no timestamp line [" + REQ_ID + "]",
                ].join("\n");
            }) as never);

            const out = await AuditLogService.getRequestLogs(REQ_ID, "2026-01-01");
            expect(out.lines[0]).toContain("no timestamp");
            expect(out.lines[1]).toContain("early");
            const phases = out.lines.slice(2).map((l) => (l.includes("Incoming") ? "in" : l.includes("Complete") ? "done" : "mid"));
            expect(phases).toEqual(["in", "mid", "done", "done"]);
            expect(out.lines).toHaveLength(6);
        });

        it("accepts the legacy req_ id format", async function () {
            vi.spyOn(fs, "readdir").mockResolvedValue([] as never);
            await expect(AuditLogService.getRequestLogs("req_abc-1_Z", "2026-01-01")).resolves.toMatchObject({
                lines: [],
            });
        });
    });

    describe("_parseSystemLine", function () {
        const full =
            `[HOST (S) 1.2.3.4] [2026-03-05 10:00:00.123] [ERROR] [PID:12] [fn @ src/a.ts:10] [Incoming Request] [POST] [${REQ_ID}] - boom | META: {"a":1}`;

        it("extracts every structured field", function () {
            expect(AuditLogService._parseSystemLine(full, "info")).toEqual({
                ts: "2026-03-05 10:00:00.123",
                level: "ERROR",
                machine: "HOST (S) 1.2.3.4",
                pid: 12,
                location: "fn @ src/a.ts:10",
                phase: "Incoming",
                method: "POST",
                requestId: REQ_ID,
                message: "boom",
                meta: '{"a":1}',
            });
        });

        it("recognises Complete/Handling phases and legacy request ids", function () {
            const mk = (tag: string) =>
                AuditLogService._parseSystemLine(`[H] [fn @ a.ts:1] [${tag}] [req_abc] [] - m`, "info");
            expect(mk("Request Complete")?.phase).toBe("Complete");
            expect(mk("Handling Request")?.phase).toBe("Handling");
            expect(mk("GET")?.requestId).toBe("req_abc");
        });

        it("degrades gracefully on malformed lines and returns null for empty/non-string", function () {
            const out = AuditLogService._parseSystemLine("just text", "warning");
            expect(out).toMatchObject({ ts: null, machine: null, pid: null, location: null, level: "WARNING", message: "just text", meta: null });
            expect(AuditLogService._parseSystemLine("   ", "info")).toBeNull();
            expect(AuditLogService._parseSystemLine(5 as unknown as string, "info")).toBeNull();
            expect(AuditLogService._parseSystemLine("x", "" as string)?.level).toBeNull();
        });

        it("handles a header with no location bracket", function () {
            const out = AuditLogService._parseSystemLine("[H] [2026-03-05 10:00:00] [INFO] - plain", "info");
            expect(out).toMatchObject({ location: null, phase: null, method: null, message: "plain" });
        });
    });

    describe("getSystemLogs", function () {
        let base: string;
        const DATE = "2026-03-05";
        const line = (ts: string, lvl: string, msg: string) =>
            `[H (S) 1.1.1.1] [${ts}] [${lvl}] [PID:1] [f @ src/a.ts:1] [FUNC] - ${msg}`;

        beforeEach(async function () {
            base = await fs.mkdtemp(path.join(os.tmpdir(), "auditlog-sys-"));
            const dir = path.join(base, "2026", "03", "05");
            await fs.mkdir(dir, { recursive: true });
            await fs.writeFile(path.join(dir, "error.log"), [line("2026-03-05 10:00:02", "ERROR", "err one"), "garbage line"].join("\n") + "\n");
            await fs.writeFile(path.join(dir, "info.log"), [line("2026-03-05 10:00:01", "INFO", "info one"), line("2026-03-05 10:00:03", "INFO", "Needle here")].join("\n") + "\n");
            await fs.writeFile(path.join(dir, "debug.log"), line("2026-03-05 10:00:04", "DEBUG", "dbg") + "\n");
            await fs.writeFile(path.join(dir, "warn.log"), line("2026-03-05 10:00:05", "WARNING", "legacy warn") + "\n");
            await fs.writeFile(path.join(dir, "notice.log"), "");
            await fs.writeFile(path.join(dir, "readme.txt"), "ignore me");
            await fs.mkdir(path.join(dir, "alert_1.log")); // unreadable "file" (a directory)
        });

        afterEach(async function () {
            vi.unstubAllEnvs();
            await fs.rm(base, { recursive: true, force: true });
        });

        it("applies the default priority ceiling (NOTICE) and sorts newest first with untimed rows last", async function () {
            const out = await AuditLogService.getSystemLogs({ date: DATE }, { logBaseDir: base });
            expect(out.rows.map((r) => r.message)).toEqual(["legacy warn", "err one", "garbage line"]);
            expect(out).toMatchObject({ total: 3, page: 1, pageSize: 50, totalPages: 1, truncatedFiles: [] });
        });

        it("maxPriority 7 includes debug; level filter overrides the ceiling and accepts the warn alias", async function () {
            const all = await AuditLogService.getSystemLogs({ date: DATE, maxPriority: 7 }, { logBaseDir: base });
            expect(all.total).toBe(6);
            const warn = await AuditLogService.getSystemLogs({ date: DATE, level: "WARN", maxPriority: 0 }, { logBaseDir: base });
            expect(warn.rows.map((r) => r.message)).toEqual(["legacy warn"]);
            const info = await AuditLogService.getSystemLogs({ date: DATE, level: "info" }, { logBaseDir: base });
            expect(info.total).toBe(2);
        });

        it("searches case-insensitively on the message and ignores a blank needle", async function () {
            const hit = await AuditLogService.getSystemLogs({ date: DATE, maxPriority: 7, search: "  NEEDLE " }, { logBaseDir: base });
            expect(hit.rows.map((r) => r.message)).toEqual(["Needle here"]);
            const blank = await AuditLogService.getSystemLogs({ date: DATE, maxPriority: 7, search: "   " }, { logBaseDir: base });
            expect(blank.total).toBe(6);
        });

        it("paginates with a clamped page and page size", async function () {
            const p2 = await AuditLogService.getSystemLogs({ date: DATE, maxPriority: 7, page: 2, pageSize: 4 }, { logBaseDir: base });
            expect(p2).toMatchObject({ page: 2, pageSize: 4, totalPages: 2 });
            expect(p2.rows).toHaveLength(2);
            const clamped = await AuditLogService.getSystemLogs({ date: DATE, page: -3, pageSize: 99999 }, { logBaseDir: base });
            expect(clamped).toMatchObject({ page: 1, pageSize: 200 });
            const fallback = await AuditLogService.getSystemLogs({ date: DATE, page: "x" as never, pageSize: 0 }, { logBaseDir: base });
            expect(fallback).toMatchObject({ page: 1, pageSize: 50 });
        });

        it("reads only the tail window of oversized files, drops the partial first line and reports truncation", async function () {
            vi.stubEnv("SYSTEM_LOG_MAX_READ_BYTES", "150");
            const out = await AuditLogService.getSystemLogs({ date: DATE, level: "info" }, { logBaseDir: base });
            expect(out.truncatedFiles).toEqual(["info.log"]);
            expect(out.rows.map((r) => r.message)).toEqual(["Needle here"]);
        });

        it("yields no rows from a truncated window that holds no newline", async function () {
            vi.stubEnv("SYSTEM_LOG_MAX_READ_BYTES", "20");
            const out = await AuditLogService.getSystemLogs({ date: DATE, level: "debug" }, { logBaseDir: base });
            expect(out.total).toBe(0);
            expect(out.truncatedFiles).toEqual(["debug.log"]);
        });

        it("returns an empty page when the day directory does not exist", async function () {
            const out = await AuditLogService.getSystemLogs({ date: "2020-01-01" }, { logBaseDir: base });
            expect(out).toMatchObject({ rows: [], total: 0, totalPages: 0, truncatedFiles: [] });
        });

        it("defaults the date to today in Asia/Manila", async function () {
            vi.useFakeTimers();
            vi.setSystemTime(new Date("2026-03-05T20:00:00Z")); // already 2026-03-06 in Manila
            const readdir = vi.spyOn(fs, "readdir").mockRejectedValue(new Error("ENOENT"));
            await AuditLogService.getSystemLogs({}, { logBaseDir: base });
            expect(readdir.mock.calls[0][0]).toBe(path.join(base, "2026", "03", "06"));
        });

        it("rejects a bad date, level and priority with 400", async function () {
            const o = { logBaseDir: base };
            expect((await rejection(AuditLogService.getSystemLogs({ date: "../../etc" }, o))).statusCode).toBe(400);
            expect((await rejection(AuditLogService.getSystemLogs({ date: DATE, level: "loud" }, o))).statusCode).toBe(400);
            for (const bad of [-1, 8, 2.5, NaN]) {
                expect((await rejection(AuditLogService.getSystemLogs({ date: DATE, maxPriority: bad }, o))).statusCode).toBe(400);
            }
        });

        it("treats an empty-string level as no level filter", async function () {
            const out = await AuditLogService.getSystemLogs({ date: DATE, level: "" }, { logBaseDir: base });
            expect(out.total).toBe(3);
        });
    });

    describe("exportToExcel", function () {
        it("rejects missing, unparseable and inverted ranges with 400", async function () {
            for (const args of [
                {}, { fromDate: "2026-01-01" }, { fromDate: "bad", toDate: "2026-01-02" },
                { fromDate: "2026-02-01", toDate: "2026-01-01" },
            ]) {
                expect((await rejection(AuditLogService.exportToExcel(args))).statusCode).toBe(400);
            }
        });

        it("builds an Audit Records sheet and a Summary sheet, defaulting missing cells", async function () {
            vi.spyOn(AuditLogModel, "findPaginated").mockResolvedValue([
                { REQUEST_ID: "r1", USERNAME: "u", METHOD: "GET", ENDPOINT: "/x", STATUS_CODE: 200, RESPONSE_TIME_MS: 5, CLIENT_IP: "1.1.1.1", CREATED_AT: new Date("2026-01-01T00:00:00Z") },
                { CREATED_AT: { not: "a date" } },
            ] as never);
            vi.spyOn(AuditLogModel, "aggregate").mockResolvedValue({
                total: 2, success: 1, redirect: 0, clientError: 0, serverError: 1, uniqueUsers: 1, avgResponseTime: 5,
            } as never);

            const buf = await AuditLogService.exportToExcel({ fromDate: "2026-01-01", toDate: "2026-01-02" });
            const wb = new ExcelJS.Workbook();
            await wb.xlsx.load(buf as never);
            const records = wb.getWorksheet("Audit Records")!;
            expect(records.getRow(2).getCell(2).value).toBe("r1");
            expect(records.getRow(3).getCell(3).value).toBe("");
            expect(records.getRow(3).getCell(7).value).toBe(0);
            const summary = wb.getWorksheet("Summary")!;
            expect(summary.getRow(4).getCell(1).value).toBe("Total Requests");
            expect(summary.getRow(4).getCell(2).value).toBe(2);
        });
    });

    describe("exportTraceExcel", function () {
        it("validates the request id and date", async function () {
            expect((await rejection(AuditLogService.exportTraceExcel("bad", "2026-01-01"))).statusCode).toBe(400);
            expect((await rejection(AuditLogService.exportTraceExcel(REQ_ID, "01-01-2026"))).statusCode).toBe(400);
            expect((await rejection(AuditLogService.exportTraceExcel(REQ_ID, undefined))).statusCode).toBe(400);
        });

        it("404s when no audit row matches the request id", async function () {
            vi.spyOn(AuditLogModel, "findPaginated").mockResolvedValue([] as never);
            vi.spyOn(AuditLogService, "getRequestLogs").mockResolvedValue({ requestId: REQ_ID, lines: [] });
            expect((await rejection(AuditLogService.exportTraceExcel(REQ_ID, "2026-01-01"))).statusCode).toBe(404);
        });

        it("writes a summary row and one trace row per log line with phase, message and location", async function () {
            vi.spyOn(AuditLogModel, "findPaginated").mockResolvedValue([
                { METHOD: "GET", STATUS_CODE: 200, RESPONSE_TIME_MS: 7, USERNAME: "u", ENDPOINT: "/e", PARAMS: "p=1" },
            ] as never);
            vi.spyOn(AuditLogService, "getRequestLogs").mockResolvedValue({
                requestId: REQ_ID,
                lines: [
                    "[H] [2026-01-01 10:00:00.001] [INFO] [f @ src/a.ts:3] [Incoming Request] - in",
                    "[H] [Handling Request] - handling",
                    "[H] [Request Complete] - done",
                    "plain function line",
                ],
            });
            const buf = await AuditLogService.exportTraceExcel(REQ_ID, "2026-01-01");
            const wb = new ExcelJS.Workbook();
            await wb.xlsx.load(buf as never);
            expect(wb.getWorksheet("Request Summary")!.getRow(2).getCell(6).value).toBe("p=1");
            const trace = wb.getWorksheet("Log Trace")!;
            expect([2, 3, 4, 5].map((r) => trace.getRow(r).getCell(2).value)).toEqual(["Incoming", "Handling", "Complete", "Function"]);
            expect(trace.getRow(2).getCell(3).value).toBe("in");
            expect(trace.getRow(2).getCell(4).value).toBe("f @ src/a.ts:3");
            expect(trace.getRow(2).getCell(1).value).toBe("2026-01-01 10:00:00.001");
            expect(trace.getRow(5).getCell(3).value).toBe("plain function line");
            expect(trace.getRow(5).getCell(4).value).toBe("");
        });

        it("defaults blank summary fields to empty values", async function () {
            vi.spyOn(AuditLogModel, "findPaginated").mockResolvedValue([{}] as never);
            vi.spyOn(AuditLogService, "getRequestLogs").mockResolvedValue({ requestId: REQ_ID, lines: [] });
            const buf = await AuditLogService.exportTraceExcel(REQ_ID, "2026-01-01");
            const wb = new ExcelJS.Workbook();
            await wb.xlsx.load(buf as never);
            expect(wb.getWorksheet("Request Summary")!.getRow(2).getCell(3).value).toBe(0);
        });
    });

    describe("exportToZip", function () {
        it("rejects missing or invalid ranges with 400", async function () {
            expect((await rejection(AuditLogService.exportToZip({}))).statusCode).toBe(400);
            expect((await rejection(AuditLogService.exportToZip({ fromDate: "x", toDate: "2026-01-01" }))).statusCode).toBe(400);
            expect((await rejection(AuditLogService.exportToZip({ fromDate: "2026-02-01", toDate: "2026-01-01" }))).statusCode).toBe(400);
        });

        it("zips each day, skipping non-log files, symlinks, lstat failures and traversal names", async function () {
            vi.spyOn(fs, "readdir").mockImplementation((async (dir: string) => {
                if (dir.endsWith(path.join("2026", "01", "01")))
                    return ["a.log", "notes.txt", "link.log", "gone.log", "../evil.log"];
                throw new Error("ENOENT");
            }) as never);
            const lstat = vi.spyOn(fs, "lstat").mockImplementation((async (p: string) => {
                if (p.endsWith("gone.log")) throw new Error("ENOENT");
                return { isFile: () => !p.endsWith("link.log") };
            }) as never);

            const buf = await AuditLogService.exportToZip({ fromDate: "2026-01-01", toDate: "2026-01-02" });
            expect(buf.subarray(0, 2).toString()).toBe("PK");
            const lstatted = lstat.mock.calls.map((c) => path.basename(String(c[0])));
            expect(lstatted).toContain("a.log");
            expect(logger.warning).toHaveBeenCalledTimes(1);
        });
    });

    describe("deleteRange", function () {
        it("rejects missing or invalid ranges with 400 before touching the DB", async function () {
            const del = vi.spyOn(AuditLogModel, "deleteMany");
            expect((await rejection(AuditLogService.deleteRange({}))).statusCode).toBe(400);
            expect((await rejection(AuditLogService.deleteRange({ fromDate: "x", toDate: "2026-01-02" }))).statusCode).toBe(400);
            expect((await rejection(AuditLogService.deleteRange({ fromDate: "2026-02-01", toDate: "2026-01-01" }))).statusCode).toBe(400);
            expect(del).not.toHaveBeenCalled();
        });

        it("counts removed day directories and reports days that survive or fail removal", async function () {
            vi.useFakeTimers();
            vi.spyOn(AuditLogModel, "deleteMany").mockResolvedValue({ rowsAffected: 7 });
            const rmCalls: string[] = [];
            let rmFailuresFor05 = 0;
            vi.spyOn(fs, "stat").mockImplementation((async (p: string) => {
                // 01-01 missing; 01-02 removed; 01-03 still present after rm; 01-04 rm throws; 01-05 flaky once
                if (p.endsWith(path.join("01", "01"))) throw new Error("ENOENT");
                if (p.endsWith(path.join("01", "03"))) return {};
                if (p.endsWith(path.join("01", "02")) && rmCalls.some((c) => c.endsWith(path.join("01", "02")))) throw new Error("ENOENT");
                if (p.endsWith(path.join("01", "05")) && rmCalls.some((c) => c.endsWith(path.join("01", "05")))) throw new Error("ENOENT");
                return {};
            }) as never);
            vi.spyOn(fs, "rm").mockImplementation((async (p: string) => {
                rmCalls.push(p);
                if (p.endsWith(path.join("01", "04"))) throw new Error("EPERM");
                if (p.endsWith(path.join("01", "05")) && rmFailuresFor05++ === 0) throw new Error("EBUSY");
            }) as never);

            const pending = AuditLogService.deleteRange({ fromDate: "2026-01-01", toDate: "2026-01-05" });
            await vi.advanceTimersByTimeAsync(1000);
            const out = await pending;

            expect(out).toEqual({ deletedRows: 7, deletedDays: 2, failedDays: ["2026-01-03", "2026-01-04"] });
            expect(rmFailuresFor05).toBe(2); // retried once, then succeeded
        });

        it("treats a missing rowsAffected as zero", async function () {
            vi.spyOn(AuditLogModel, "deleteMany").mockResolvedValue(undefined as never);
            vi.spyOn(fs, "stat").mockRejectedValue(new Error("ENOENT"));
            const out = await AuditLogService.deleteRange({ fromDate: "2026-01-01", toDate: "2026-01-01" });
            expect(out).toEqual({ deletedRows: 0, deletedDays: 0, failedDays: [] });
        });
    });

    describe("getLatestCreatedAt and statics", function () {
        it("delegates to the model", async function () {
            vi.spyOn(AuditLogModel, "getLatestCreatedAt").mockResolvedValue(123);
            await expect(AuditLogService.getLatestCreatedAt()).resolves.toBe(123);
        });

        it("exposes a read-only log base dir", function () {
            expect(AuditLogService.LOG_BASE_DIR).toMatch(/logs$/);
            expect(() => {
                (AuditLogService as unknown as Record<string, unknown>).LOG_BASE_DIR = "/tmp/x";
            }).toThrow(TypeError);
        });
    });
});
