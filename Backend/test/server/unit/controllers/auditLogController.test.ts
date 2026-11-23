"use strict";

/**
 * @fileoverview AuditLogController: query parsing, response/header shaping for
 * the JSON and binary endpoints, error funnelling through catchAsync, and the
 * two SSE endpoints (shared audit poller and system-log tail). The services are
 * stubbed; req/res are hand-rolled.
 */

import { EventEmitter } from "events";

import AuditLogController from "../../../../src/controllers/AuditLogController";
import AuditLogService from "../../../../src/services/AuditLogService";
import MetricsService from "../../../../src/services/MetricsService";
import systemLogTail from "../../../../src/services/SystemLogTailService";
import { logger } from "../../../../src/utils/logger";

function mockRes() {
    const headers: Record<string, string> = {};
    const events: Array<{ event: string; data: any }> = [];
    let pending = "";
    const res: any = {
        headers,
        events,
        statusCode: 200,
        body: undefined as any,
        sent: undefined as any,
        setHeader: vi.fn((k: string, v: string) => { headers[k] = v; }),
        status(code: number) { this.statusCode = code; return this; },
        json(b: unknown) { this.body = b; return this; },
        send(b: unknown) { this.sent = b; return this; },
        flushHeaders: vi.fn(),
        write: vi.fn((chunk: string) => {
            if (chunk.startsWith("event: ")) pending = chunk.slice(7).trim();
            else if (chunk.startsWith("data: ")) events.push({ event: pending, data: JSON.parse(chunk.slice(6)) });
        }),
        flush: vi.fn(),
        once: vi.fn(),
        on: vi.fn(),
    };
    return res;
}

function mockReq(over: Record<string, unknown> = {}) {
    const req: any = new EventEmitter();
    Object.assign(req, { query: {}, params: {}, user: { id: 1, role: "ADMIN" } }, over);
    return req;
}

async function run(handler: unknown, req: unknown, res: unknown) {
    const next = vi.fn();
    await (handler as (a: unknown, b: unknown, c: unknown) => Promise<void>)(req, res, next);
    return next;
}

describe("AuditLogController (JSON and binary endpoints)", function () {
    beforeEach(function () {
        vi.spyOn(logger, "info").mockImplementation(async () => {});
        vi.spyOn(logger, "notice").mockImplementation(async () => {});
        vi.spyOn(logger, "warning").mockImplementation(async () => {});
        vi.spyOn(logger, "error").mockImplementation(async () => {});
    });
    afterEach(function () {
        vi.restoreAllMocks();
    });

    it("getList parses numeric params, defaults bad ones and forwards the filters", async function () {
        const spy = vi.spyOn(AuditLogService, "getList").mockResolvedValue({ rows: [] } as never);
        const res = mockRes();
        await run(AuditLogController.getList, mockReq({ query: { page: "3", pageSize: "x", method: "GET", search: "q", endpoint: "/e", statusCategory: "4xx", fromDate: "a", toDate: "b" } }), res);
        expect(spy).toHaveBeenCalledWith({ page: 3, pageSize: 20, fromDate: "a", toDate: "b", method: "GET", statusCategory: "4xx", endpoint: "/e", search: "q" });
        expect(res.body).toMatchObject({ status: "success", data: { rows: [] } });

        await run(AuditLogController.getList, mockReq({ query: { page: ["1", "2"] } }), mockRes());
        expect(spy.mock.calls[1][0]).toMatchObject({ page: 1, pageSize: 20 });
    });

    it("forwards service errors to next() instead of responding", async function () {
        const boom = new Error("db down");
        vi.spyOn(AuditLogService, "getStats").mockRejectedValue(boom);
        const res = mockRes();
        const next = await run(AuditLogController.getStats, mockReq(), res);
        expect(next).toHaveBeenCalledWith(boom);
        expect(res.body).toBeUndefined();
    });

    it("getStats and getRequestLogs return sendSuccess envelopes", async function () {
        vi.spyOn(AuditLogService, "getStats").mockResolvedValue({ total: 1 } as never);
        const getLogs = vi.spyOn(AuditLogService, "getRequestLogs").mockResolvedValue({ lines: [] } as never);
        const r1 = mockRes();
        await run(AuditLogController.getStats, mockReq({ query: { fromDate: "x" } }), r1);
        expect(r1.body.data).toEqual({ total: 1 });
        const r2 = mockRes();
        await run(AuditLogController.getRequestLogs, mockReq({ params: { requestId: "rid" }, query: { date: "2026-01-01" } }), r2);
        expect(getLogs).toHaveBeenCalledWith("rid", "2026-01-01");
        expect(r2.body.status).toBe("success");
    });

    it("exportTraceExcel strips unsafe characters from the download filename", async function () {
        vi.spyOn(AuditLogService, "exportTraceExcel").mockResolvedValue(Buffer.from("x"));
        const res = mockRes();
        await run(AuditLogController.exportTraceExcel, mockReq({ params: { requestId: 'a"b\r\nc' }, query: { date: "2026-01-01" } }), res);
        expect(res.headers["Content-Disposition"]).toBe('attachment; filename="trace-abc-2026-01-01.xlsx"');
        expect(res.headers["Content-Type"]).toContain("spreadsheetml");
        expect(Buffer.isBuffer(res.sent)).toBe(true);
    });

    it("exportExcel and exportLogs set type and sanitised names (CWE-113)", async function () {
        vi.spyOn(AuditLogService, "exportToExcel").mockResolvedValue(Buffer.from("x"));
        vi.spyOn(AuditLogService, "exportToZip").mockResolvedValue(Buffer.from("z"));
        const xl = mockRes();
        await run(AuditLogController.exportExcel, mockReq({ query: { fromDate: '2026-01-01"\r\n', toDate: "2026-01-02" } }), xl);
        expect(xl.headers["Content-Disposition"]).toBe('attachment; filename="audit-logs-2026-01-01-to-2026-01-02.xlsx"');
        const zip = mockRes();
        await run(AuditLogController.exportLogs, mockReq({ query: { fromDate: "2026-01-01", toDate: "2026-01-02" } }), zip);
        expect(zip.headers["Content-Type"]).toBe("application/zip");
        expect(zip.headers["Content-Disposition"]).toBe('attachment; filename="server-logs-2026-01-01-to-2026-01-02.zip"');
    });

    it("deleteRange returns the service result", async function () {
        vi.spyOn(AuditLogService, "deleteRange").mockResolvedValue({ deletedRows: 2, deletedDays: 1, failedDays: [] });
        const res = mockRes();
        await run(AuditLogController.deleteRange, mockReq({ query: { fromDate: "a", toDate: "b" } }), res);
        expect(res.body.data).toEqual({ deletedRows: 2, deletedDays: 1, failedDays: [] });
    });

    it("getSystemLogs parses maxPriority and defaults paging", async function () {
        const spy = vi.spyOn(AuditLogService, "getSystemLogs").mockResolvedValue({ rows: [] } as never);
        await run(AuditLogController.getSystemLogs, mockReq({ query: { maxPriority: "3", level: "info", date: "2026-01-01", search: "s", page: "0", pageSize: "junk" } }), mockRes());
        expect(spy.mock.calls[0][0]).toEqual({ date: "2026-01-01", maxPriority: 3, level: "info", page: 1, pageSize: 50, search: "s" });
        await run(AuditLogController.getSystemLogs, mockReq(), mockRes());
        expect(spy.mock.calls[1][0]).toMatchObject({ maxPriority: undefined, page: 1, pageSize: 50 });
    });
});

describe("AuditLogController.stream (shared SSE poller)", function () {
    const snapshot = (over: Record<string, unknown> = {}) => ({
        red: { r: 1 },
        totals: { requestsTotal: 100, clientErrorsTotal: 3, serverErrorsTotal: 2 },
        system: { cpu: { percent: 12 }, memory: { heapUsed: 5 * 1024 * 1024, rss: 10 * 1024 * 1024 }, eventLoopLag: 4 },
        uptime: 99,
        ...over,
    });
    const open: any[] = [];

    async function connect(user: unknown = { id: 7 }) {
        const req = mockReq({ user });
        const res = mockRes();
        await AuditLogController.stream(req, res);
        open.push(req);
        return { req, res };
    }

    beforeEach(function () {
        vi.useFakeTimers();
        vi.spyOn(logger, "info").mockImplementation(async () => {});
        vi.spyOn(logger, "notice").mockImplementation(async () => {});
        vi.spyOn(logger, "warning").mockImplementation(async () => {});
        vi.spyOn(logger, "error").mockImplementation(async () => {});
        vi.spyOn(MetricsService, "getClusterSnapshot").mockResolvedValue(snapshot() as never);
        vi.spyOn(AuditLogService, "getLatestCreatedAt").mockResolvedValue(1000);
    });

    afterEach(function () {
        for (const req of open.splice(0)) req.emit("close");
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("rejects an unauthenticated request with 401 and no SSE headers", async function () {
        const res = mockRes();
        await AuditLogController.stream(mockReq({ user: undefined }), res);
        expect(res.statusCode).toBe(401);
        expect(res.flushHeaders).not.toHaveBeenCalled();
    });

    it("upgrades to SSE, sends 'connected', and refuses a second stream for the same account with 409", async function () {
        const { res } = await connect({ id: 7 });
        expect(res.headers["Content-Type"]).toBe("text/event-stream");
        expect(res.events[0]).toMatchObject({ event: "connected", data: { pollIntervalMs: 5000 } });
        const dup = mockRes();
        await AuditLogController.stream(mockReq({ user: { id: 7 } }), dup);
        expect(dup.statusCode).toBe(409);
    });

    it("keys connections by id, then userId, then username, then 'anonymous'", async function () {
        await connect({ userId: "u-1" });
        await connect({ username: "alice" });
        await connect({});
        const again = mockRes();
        await AuditLogController.stream(mockReq({ user: {} }), again);
        expect(again.statusCode).toBe(409);
        const again2 = mockRes();
        await AuditLogController.stream(mockReq({ user: { username: "alice" } }), again2);
        expect(again2.statusCode).toBe(409);
    });

    it("first tick sets the baseline (heartbeat), then 'update' on newer rows and 'heartbeat' otherwise", async function () {
        const { res } = await connect();
        await vi.advanceTimersByTimeAsync(5000);
        expect(res.events[1]).toMatchObject({ event: "heartbeat", data: { pollCount: 1 } });
        expect(res.events[1].data.metrics.system).toMatchObject({ cpuPct: 12, memoryMb: 5, rssMb: 10, eventLoopLag: 4, uptime: 99 });

        await vi.advanceTimersByTimeAsync(5000);
        expect(res.events[2].event).toBe("heartbeat");

        vi.mocked(AuditLogService.getLatestCreatedAt).mockResolvedValue(2000);
        await vi.advanceTimersByTimeAsync(5000);
        expect(res.events[3].event).toBe("update");
    });

    it("derives per-second rates from consecutive snapshots and clamps counter resets to zero", async function () {
        const snap = vi.mocked(MetricsService.getClusterSnapshot);
        snap.mockResolvedValueOnce(snapshot({ totals: { requestsTotal: 100, errorsTotal: 10 } }) as never);
        const { res } = await connect();
        await vi.advanceTimersByTimeAsync(5000);
        expect(res.events[1].data.metrics.rates).toEqual({ reqPerSec: 0, errPerSec: 0 });

        snap.mockResolvedValueOnce(snapshot({ totals: { requestsTotal: 150, errorsTotal: 20 } }) as never);
        await vi.advanceTimersByTimeAsync(5000);
        expect(res.events[2].data.metrics.rates).toEqual({ reqPerSec: 10, errPerSec: 2 });

        snap.mockResolvedValueOnce(snapshot({ totals: { requestsTotal: 5, errorsTotal: 0 } }) as never);
        await vi.advanceTimersByTimeAsync(5000);
        expect(res.events[3].data.metrics.rates).toEqual({ reqPerSec: 0, errPerSec: 0 });
    });

    it("tolerates a sparse snapshot (no system block) and a failing snapshot (metrics: null)", async function () {
        const snap = vi.mocked(MetricsService.getClusterSnapshot);
        snap.mockResolvedValueOnce({ red: {}, totals: { requestsTotal: 1, clientErrorsTotal: 0, serverErrorsTotal: 0 } } as never);
        const { res } = await connect();
        await vi.advanceTimersByTimeAsync(5000);
        expect(res.events[1].data.metrics.system).toEqual({ cpuPct: 0, memoryMb: 0, rssMb: 0, eventLoopLag: 0, uptime: 0 });

        snap.mockRejectedValueOnce(new Error("503"));
        await vi.advanceTimersByTimeAsync(5000);
        expect(res.events[2].data.metrics).toBeNull();
    });

    it("after 5 consecutive poll failures notifies every client, clears them and stops polling", async function () {
        const latest = vi.mocked(AuditLogService.getLatestCreatedAt);
        const { res } = await connect();
        latest.mockRejectedValue(new Error("ORA-03113"));
        for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(5000);
        expect(res.events.at(-1)).toMatchObject({ event: "error", data: { code: "POLL_FAILED" } });
        const calls = latest.mock.calls.length;
        await vi.advanceTimersByTimeAsync(20_000);
        expect(latest.mock.calls.length).toBe(calls); // poller stopped
        // The account can reconnect once cleared.
        const again = mockRes();
        await AuditLogController.stream(mockReq({ user: { id: 7 } }), again);
        open.push(mockReq());
        expect(again.statusCode).toBe(200);
    });

    it("skips an overlapping tick while one is still in flight", async function () {
        let release!: (n: number) => void;
        const latest = vi.mocked(AuditLogService.getLatestCreatedAt);
        latest.mockImplementation(() => new Promise<number>((r) => { release = r; }));
        await connect();
        await vi.advanceTimersByTimeAsync(5000);
        await vi.advanceTimersByTimeAsync(5000);
        expect(latest).toHaveBeenCalledTimes(1);
        release(1);
        await vi.advanceTimersByTimeAsync(0);
    });

    it("stops the shared poller only when the last client disconnects", async function () {
        const a = await connect({ id: 1 });
        const b = await connect({ id: 2 });
        a.req.emit("close");
        await vi.advanceTimersByTimeAsync(5000);
        expect(b.res.events.some((e: any) => e.event === "heartbeat")).toBe(true);
        b.req.emit("close");
        const latest = vi.mocked(AuditLogService.getLatestCreatedAt);
        const calls = latest.mock.calls.length;
        await vi.advanceTimersByTimeAsync(10_000);
        expect(latest.mock.calls.length).toBe(calls);
    });

    it("a tick with no connections does nothing", async function () {
        const { req } = await connect();
        req.emit("close");
        await vi.advanceTimersByTimeAsync(10_000);
        expect(AuditLogService.getLatestCreatedAt).not.toHaveBeenCalled();
    });

    it("survives a write failure on a closed socket", async function () {
        const { res } = await connect();
        res.write.mockImplementation(() => { throw new Error("EPIPE"); });
        await vi.advanceTimersByTimeAsync(5000);
        expect(res.write).toHaveBeenCalled();
    });

    it("works when the response has no compression flush hook", async function () {
        const req = mockReq({ user: { id: 55 } });
        const res = mockRes();
        delete res.flush;
        await AuditLogController.stream(req, res);
        open.push(req);
        expect(res.events[0].event).toBe("connected");
    });
});

describe("AuditLogController.streamSystemLogs", function () {
    const open: any[] = [];
    let add: ReturnType<typeof vi.spyOn>;
    let remove: ReturnType<typeof vi.spyOn>;

    beforeEach(function () {
        vi.spyOn(logger, "warning").mockImplementation(async () => {});
        add = vi.spyOn(systemLogTail, "addConnection").mockImplementation(() => {});
        remove = vi.spyOn(systemLogTail, "removeConnection").mockImplementation(() => {});
        vi.spyOn(systemLogTail, "hasConnection").mockReturnValue(false);
    });
    afterEach(function () {
        for (const req of open.splice(0)) req.emit("close");
        vi.restoreAllMocks();
    });

    function connect(query: Record<string, unknown> = {}, user: unknown = { id: 9 }) {
        const req = mockReq({ query, user });
        const res = mockRes();
        AuditLogController.streamSystemLogs(req, res);
        open.push(req);
        return { req, res };
    }

    it("401s without a user", function () {
        const res = mockRes();
        AuditLogController.streamSystemLogs(mockReq({ user: undefined }), res);
        expect(res.statusCode).toBe(401);
        expect(add).not.toHaveBeenCalled();
    });

    it("409s when the account already has a tail open", function () {
        vi.mocked(systemLogTail.hasConnection).mockReturnValue(true);
        const res = mockRes();
        AuditLogController.streamSystemLogs(mockReq(), res);
        expect(res.statusCode).toBe(409);
        expect(add).not.toHaveBeenCalled();
    });

    it("rejects an unknown level with a plain JSON 400 before any SSE header", function () {
        const res = mockRes();
        AuditLogController.streamSystemLogs(mockReq({ query: { level: "loud" } }), res);
        expect(res.statusCode).toBe(400);
        expect(res.flushHeaders).not.toHaveBeenCalled();
    });

    it("defaults maxPriority to 5 when absent or out of range", function () {
        connect({});
        connect({ maxPriority: "9" }, { id: 10 });
        connect({ maxPriority: "abc" }, { id: 11 });
        expect(add.mock.calls.map((c) => c[2])).toEqual([5, 5, 5]);
    });

    it("registers with the parsed priority, normalises the level, announces 'connected' and cleans up on close", function () {
        const { req, res } = connect({ maxPriority: "2", level: "warn" });
        expect(add).toHaveBeenCalledWith("9", res, 2, "WARNING");
        expect(res.events[0]).toMatchObject({ event: "connected", data: { maxPriority: 2, level: "WARNING" } });
        req.emit("close");
        expect(remove).toHaveBeenCalledWith("9");
    });

    it("omits level from the connected payload when none is set, and tolerates no flush hook", function () {
        const req = mockReq({ query: { maxPriority: "0" } });
        const res = mockRes();
        delete res.flush;
        AuditLogController.streamSystemLogs(req, res);
        open.push(req);
        expect(res.events[0].data).not.toHaveProperty("level");
        expect(res.events[0].data.maxPriority).toBe(0);
    });
});
