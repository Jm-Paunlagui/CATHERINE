import fs from "fs";
import os from "os";
import path from "path";
import AuditLogService from "../../../../src/services/AuditLogService";

const LINE = (ts: string, level: string, msg: string) =>
    `[vm (S) 10.0.0.1] [${ts}] [${level}] [PID:1] [fn @ src/x.ts:1] [FUNC] - ${msg}`;

let base: string;
let dir: string;
const write = (name: string, content: string) => fs.writeFileSync(path.join(dir, name), content);

beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "audit-wave2-"));
    dir = path.join(base, "2026", "03", "05");
    fs.mkdirSync(dir, { recursive: true });
});

afterEach(() => {
    delete process.env.SYSTEM_LOG_MAX_READ_BYTES;
    vi.useRealTimers();
    fs.rmSync(base, { recursive: true, force: true });
});

const get = (params: Parameters<typeof AuditLogService.getSystemLogs>[0] = {}) =>
    AuditLogService.getSystemLogs({ date: "2026-03-05", maxPriority: 7, ...params }, { logBaseDir: base });

describe("AuditLogService.getSystemLogs wave2", () => {
    it("rejects malformed dates, unknown levels and out-of-range priorities with 400", async () => {
        await expect(get({ date: "2026/03/05" })).rejects.toMatchObject({ statusCode: 400 });
        await expect(get({ level: "loud" })).rejects.toMatchObject({ statusCode: 400 });
        await expect(get({ maxPriority: 9 })).rejects.toMatchObject({ statusCode: 400 });
        await expect(get({ maxPriority: 2.5 })).rejects.toMatchObject({ statusCode: 400 });
        await expect(get({ maxPriority: -1 })).rejects.toMatchObject({ statusCode: 400 });
    });

    it("defaults the date to today in Asia/Manila and returns an empty page when that directory is missing", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2031-07-08T18:30:00Z")); // already 2031-07-09 in Manila (UTC+8)
        const r = await AuditLogService.getSystemLogs({ maxPriority: 7 }, { logBaseDir: base });
        expect(r).toEqual({ rows: [], total: 0, page: 1, pageSize: 50, totalPages: 0, truncatedFiles: [] });
        fs.mkdirSync(path.join(base, "2031", "07", "09"), { recursive: true });
        fs.writeFileSync(path.join(base, "2031", "07", "09", "info.log"), LINE("2031-07-09 02:30:00.000", "INFO", "manila day") + "\n");
        const r2 = await AuditLogService.getSystemLogs({ maxPriority: 7 }, { logBaseDir: base });
        expect(r2.rows.map((x) => x.message)).toEqual(["manila day"]);
    });

    it("filters by level or by priority ceiling and skips non-log files", async () => {
        write("info.log", LINE("2026-03-05 10:00:00.000", "INFO", "i") + "\n");
        write("error.log", LINE("2026-03-05 10:00:01.000", "ERROR", "e") + "\n");
        write("warn.log", LINE("2026-03-05 10:00:02.000", "WARNING", "legacy warn") + "\n");
        write("notes.txt", "ignored\n");
        expect((await get({ level: "ERROR" })).rows.map((r) => r.message)).toEqual(["e"]);
        expect((await get({ maxPriority: 4 })).rows.map((r) => r.message)).toEqual(["legacy warn", "e"]);
        expect((await get({ maxPriority: 7 })).total).toBe(3);
        expect((await get({ level: "", maxPriority: 5 })).total).toBe(2); // empty level means no level filter
    });

    it("sorts newest first with timestamp-less lines last and paginates with capped sizes", async () => {
        write(
            "info.log",
            [
                LINE("2026-03-05 10:00:00.000", "INFO", "old"),
                "raw line without any structure",
                LINE("2026-03-05 10:00:09", "INFO", "new second-precision"),
                "another structureless line",
                "",
                "   ",
            ].join("\n"),
        );
        const r = await get();
        expect(r.rows.map((x) => x.message)).toEqual([
            "new second-precision",
            "old",
            "raw line without any structure",
            "another structureless line",
        ]);
        expect(r.rows[2].level).toBe("INFO");
        const p2 = await get({ page: 2, pageSize: 3 });
        expect(p2).toMatchObject({ page: 2, pageSize: 3, total: 4, totalPages: 2 });
        expect(p2.rows).toHaveLength(1);
        const capped = await get({ page: -4, pageSize: 100000 });
        expect(capped).toMatchObject({ page: 1, pageSize: 200 });
        const fallback = await get({ page: "x" as never, pageSize: 0 });
        expect(fallback).toMatchObject({ page: 1, pageSize: 50 });
    });

    it("searches case-insensitively, ignores a blank needle and caps the needle length", async () => {
        write(
            "info.log",
            [LINE("2026-03-05 10:00:00.000", "INFO", "Backup finished"), LINE("2026-03-05 10:00:01.000", "INFO", "login ok"), LINE("2026-03-05 10:00:02.000", "INFO", "x".repeat(100))].join("\n"),
        );
        expect((await get({ search: "BACKUP" })).rows.map((r) => r.message)).toEqual(["Backup finished"]);
        expect((await get({ search: "   " })).total).toBe(3);
        expect((await get({ search: "nothing-matches" })).total).toBe(0);
        // only the first 100 characters of the needle are used
        expect((await get({ search: "x".repeat(150) })).total).toBe(1);
    });

    it("tail-reads a file larger than the byte cap, dropping the partial first line and reporting it", async () => {
        const lines = Array.from({ length: 40 }, (_, i) => LINE(`2026-03-05 10:00:${String(i).padStart(2, "0")}.000`, "INFO", `msg-${i}`));
        write("info.log", lines.join("\n") + "\n");
        process.env.SYSTEM_LOG_MAX_READ_BYTES = "600";
        const r = await get();
        expect(r.truncatedFiles).toEqual(["info.log"]);
        expect(r.total).toBeLessThan(40);
        expect(r.rows[0].message).toBe("msg-39");
        // a cap smaller than one line leaves no complete line at all
        write("error.log", LINE("2026-03-05 10:00:00.000", "ERROR", "x".repeat(400)));
        process.env.SYSTEM_LOG_MAX_READ_BYTES = "50";
        const tiny = await get({ level: "ERROR" });
        expect(tiny).toMatchObject({ total: 0, truncatedFiles: ["error.log"] });
    });

    it("skips empty and unreadable files instead of failing the page", async () => {
        write("info.log", "");
        fs.mkdirSync(path.join(dir, "error.log")); // opening succeeds, reading throws EISDIR
        write("notice.log", LINE("2026-03-05 10:00:00.000", "NOTICE", "still served") + "\n");
        const r = await get({ maxPriority: 7 });
        expect(r.rows.map((x) => x.message)).toEqual(["still served"]);
        expect(r.truncatedFiles).toEqual([]);
    });

    it("falls back to the module log directory, today's date and the default priority when called bare", async () => {
        const r = await AuditLogService.getSystemLogs();
        expect(Array.isArray(r.rows)).toBe(true);
        expect(r).toMatchObject({ page: 1, pageSize: 50 });
        expect(r.total).toBeGreaterThanOrEqual(0);
        expect(AuditLogService.LOG_BASE_DIR).toBe(path.join(process.cwd(), "logs"));
    });

    it("never lets a crafted date escape the log directory", async () => {
        await expect(get({ date: "../../2026-03-05" })).rejects.toMatchObject({ statusCode: 400 });
    });

    it("_parseSystemLine reads every phase tag, both request-id shapes, the method and META", () => {
        const parse = (tags: string) => AuditLogService._parseSystemLine(`[H] [2026-03-05 10:00:00.000] [INFO] [fn @ a.ts:1]${tags} - msg | META: {"a":1}`, "info");
        expect(parse(" [Incoming Request] [1700000000000-1234-5678] [GET]")).toMatchObject({
            phase: "Incoming", requestId: "1700000000000-1234-5678", method: "GET", message: "msg", meta: '{"a":1}',
        });
        expect(parse(" [Handling Request] [req_abc-1] [POST]")).toMatchObject({ phase: "Handling", requestId: "req_abc-1", method: "POST" });
        expect(parse(" [Request Complete] [] [PUT]")).toMatchObject({ phase: "Complete", requestId: null, method: "PUT" });
        expect(AuditLogService._parseSystemLine("", "info")).toBeNull();
        expect(AuditLogService._parseSystemLine(5 as never, "info")).toBeNull();
        expect(AuditLogService._parseSystemLine("plain text", "")).toMatchObject({ level: null, message: "plain text", meta: null });
    });
});
