"use strict";

/**
 * @fileoverview Unit tests for AuditLogFileModel — the JSON-lines text-file
 * audit fallback. fs.promises is spied so no real files are written; the
 * assertions verify the logs/Main/YYYY/MM/DD directory layout, the
 * one-JSON-object-per-line format, the 50 MB rotation ladder, and the
 * write-only read stubs.
 */

const path = require("path");
const fs = require("fs").promises;
const AuditLogFileModel = require("../../../../src/models/audit.log.file.model");

const RECORD = {
    REQUEST_ID: "req_file1",
    USER_ID: 42,
    USERNAME: "tester",
    METHOD: "POST",
    ENDPOINT: "/api/v1/things",
    PARAMS: "a=1",
    STATUS_CODE: 201,
    STATUS_CATEGORY: "2xx",
    RESPONSE_TIME_MS: 12,
    CLIENT_IP: "127.0.0.1",
    SERVER_IP: "10.0.0.1",
    CREATED_AT: "2026-07-14T00:00:00.000Z",
};

describe("AuditLogFileModel", function () {
    let mkdirSpy;
    let statSpy;
    let appendSpy;

    beforeEach(function () {
        mkdirSpy = vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
        // Default: base file doesn't exist yet → no rotation.
        statSpy = vi
            .spyOn(fs, "stat")
            .mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
        appendSpy = vi.spyOn(fs, "appendFile").mockResolvedValue(undefined);
    });

    afterEach(async function () {
        await AuditLogFileModel.drain();
        vi.restoreAllMocks();
    });

    it("writes one JSON line per record under logs/Main/YYYY/MM/DD/audit.log", async function () {
        await AuditLogFileModel.insert(RECORD);

        expect(appendSpy).toHaveBeenCalledTimes(1);
        const [filePath, content] = appendSpy.mock.calls[0];

        // Directory layout: <cwd>/logs/Main/YYYY/MM/DD/audit.log
        const rel = path.relative(process.cwd(), filePath).replace(/\\/g, "/");
        expect(rel).toMatch(/^logs\/Main\/\d{4}\/\d{2}\/\d{2}\/audit\.log$/);
        expect(mkdirSpy).toHaveBeenCalledWith(path.dirname(filePath), {
            recursive: true,
        });

        // JSON-lines format: exactly one line, parseable back to the record.
        expect(content.endsWith("\n")).toBe(true);
        expect(JSON.parse(content.trimEnd())).toEqual(RECORD);
    });

    it("insertBatch writes all records as consecutive JSON lines in one append", async function () {
        const batch = [RECORD, { ...RECORD, REQUEST_ID: "req_file2" }];
        const result = await AuditLogFileModel.insertBatch(batch);

        expect(result).toEqual({ rowsAffected: 2 });
        expect(appendSpy).toHaveBeenCalledTimes(1);
        const [, content] = appendSpy.mock.calls[0];
        const lines = content.trimEnd().split("\n");
        expect(lines).toHaveLength(2);
        expect(JSON.parse(lines[0]).REQUEST_ID).toBe("req_file1");
        expect(JSON.parse(lines[1]).REQUEST_ID).toBe("req_file2");
    });

    it("insertBatch with an empty array is a no-op", async function () {
        const result = await AuditLogFileModel.insertBatch([]);
        expect(result).toEqual({ rowsAffected: 0 });
        expect(appendSpy).not.toHaveBeenCalled();
    });

    it("rotates to audit_1.log once audit.log reaches the 50 MB cap", async function () {
        statSpy.mockImplementation(async (filePath) => {
            if (filePath.endsWith(`${path.sep}audit.log`)) {
                return { size: AuditLogFileModel.CONFIG.MAX_FILE_SIZE };
            }
            throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        });

        await AuditLogFileModel.insert(RECORD);

        const [filePath] = appendSpy.mock.calls[0];
        expect(path.basename(filePath)).toBe("audit_1.log");
    });

    it("never rejects when the underlying append fails (audit must not take a request down)", async function () {
        appendSpy.mockRejectedValue(new Error("EACCES: permission denied"));
        await expect(AuditLogFileModel.insert(RECORD)).resolves.toEqual({
            rowsAffected: 1,
        });
    });

    it("read methods return write-only stub shapes", async function () {
        expect(await AuditLogFileModel.findPaginated({}, 1, 20)).toEqual([]);
        expect(await AuditLogFileModel.countTotal({})).toBe(0);
        expect(await AuditLogFileModel.deleteMany({})).toEqual({
            rowsAffected: 0,
        });
        expect(await AuditLogFileModel.getLatestCreatedAt()).toBe(0);
        expect(await AuditLogFileModel.aggregate({})).toEqual({
            total: 0,
            success: 0,
            redirect: 0,
            clientError: 0,
            serverError: 0,
            uniqueUsers: 0,
            avgResponseTime: 0,
        });
    });
});
