"use strict";

/**
 * @fileoverview Unit tests for AuditLogModel's storage routing — the
 * AUDIT_LOG_STORAGE (db | file | auto) state machine and the dynamic
 * AUDIT_LOG_TABLE / NODE_ENV table-name resolution.
 *
 * OracleCollection.prototype.insertOne/insertMany are spied so no Oracle
 * connection is ever attempted; AuditLogFileModel is spied so file-tier
 * delegation is observable without touching the filesystem.
 *
 * DEMO_MODE is pinned per test: isDemoMode() is read live and short-circuits
 * every method to the in-memory demo store, so an inherited DEMO_MODE=true
 * (shell or .env) would otherwise bypass the routing under test.
 */

const {
    OracleCollection,
} = require("../../../../src/utils/oracle-mongo-wrapper");
const AuditLogModel = require("../../../../src/models/audit.log.model");
const AuditLogFileModel = require("../../../../src/models/audit.log.file.model");
const demo = require("../../../../src/models/demo/demoStore");

const ORIGINAL_DEMO_MODE = process.env.DEMO_MODE;

const RECORD = {
    REQUEST_ID: "req_test123",
    METHOD: "GET",
    ENDPOINT: "/api/v1/health",
    STATUS_CODE: 200,
    STATUS_CATEGORY: "2xx",
};

function oraTableMissingError() {
    return new Error("ORA-00942: table or view does not exist");
}

describe("AuditLogModel — storage routing", function () {
    let insertOneMock;
    let insertManyMock;
    let fileInsertSpy;
    let fileInsertBatchSpy;

    beforeEach(function () {
        process.env.DEMO_MODE = "false";
        delete process.env.AUDIT_LOG_STORAGE;
        AuditLogModel._resetStorageForTests();
        insertOneMock = vi
            .spyOn(OracleCollection.prototype, "insertOne")
            .mockResolvedValue({ rowsAffected: 1 });
        insertManyMock = vi
            .spyOn(OracleCollection.prototype, "insertMany")
            .mockResolvedValue({ rowsAffected: 2 });
        fileInsertSpy = vi
            .spyOn(AuditLogFileModel, "insert")
            .mockResolvedValue({ rowsAffected: 1 });
        fileInsertBatchSpy = vi
            .spyOn(AuditLogFileModel, "insertBatch")
            .mockResolvedValue({ rowsAffected: 2 });
    });

    afterEach(function () {
        delete process.env.AUDIT_LOG_STORAGE;
        delete process.env.AUDIT_LOG_TABLE;
        if (ORIGINAL_DEMO_MODE === undefined) delete process.env.DEMO_MODE;
        else process.env.DEMO_MODE = ORIGINAL_DEMO_MODE;
        AuditLogModel._resetStorageForTests();
        vi.restoreAllMocks();
    });

    describe("DEMO_MODE=true", function () {
        beforeEach(function () {
            process.env.DEMO_MODE = "true";
        });

        it("insert writes the record unchanged to the demo store — no Oracle and no file", async function () {
            process.env.AUDIT_LOG_STORAGE = "db";
            const before = demo.auditLogs().length;
            const result = await AuditLogModel.insert({ ...RECORD, REQUEST_ID: "req_demo_1" });

            expect(result).toEqual({ rowsAffected: 1 });
            expect(demo.auditLogs()).toHaveLength(before + 1);
            expect(demo.auditLogs().at(-1)).toMatchObject({ ...RECORD, REQUEST_ID: "req_demo_1" });
            expect(insertOneMock).not.toHaveBeenCalled();
            expect(fileInsertSpy).not.toHaveBeenCalled();
        });

        it("insertBatch writes every record to the demo store and reports the count", async function () {
            process.env.AUDIT_LOG_STORAGE = "file";
            const before = demo.auditLogs().length;
            const batch = [
                { ...RECORD, REQUEST_ID: "req_demo_2" },
                { ...RECORD, REQUEST_ID: "req_demo_3" },
            ];
            const result = await AuditLogModel.insertBatch(batch);

            expect(result).toEqual({ rowsAffected: 2 });
            expect(demo.auditLogs()).toHaveLength(before + 2);
            expect(insertManyMock).not.toHaveBeenCalled();
            expect(fileInsertBatchSpy).not.toHaveBeenCalled();
        });
    });

    describe("AUDIT_LOG_STORAGE=db", function () {
        beforeEach(function () {
            process.env.AUDIT_LOG_STORAGE = "db";
        });

        it("routes insert to Oracle and never touches the file model", async function () {
            await AuditLogModel.insert(RECORD);
            expect(insertOneMock).toHaveBeenCalledWith(RECORD);
            expect(fileInsertSpy).not.toHaveBeenCalled();
            expect(AuditLogModel.storageInfo().mode).toBe("db");
        });

        it("propagates an Oracle write failure (no silent fallback)", async function () {
            insertOneMock.mockRejectedValue(oraTableMissingError());
            await expect(AuditLogModel.insert(RECORD)).rejects.toThrow(
                /ORA-00942/,
            );
            expect(fileInsertSpy).not.toHaveBeenCalled();
            expect(AuditLogModel.storageInfo().mode).toBe("db");
        });
    });

    describe("AUDIT_LOG_STORAGE=file", function () {
        beforeEach(function () {
            process.env.AUDIT_LOG_STORAGE = "file";
        });

        it("routes insert straight to the file model — Oracle is never called", async function () {
            await AuditLogModel.insert(RECORD);
            expect(fileInsertSpy).toHaveBeenCalledWith(RECORD);
            expect(insertOneMock).not.toHaveBeenCalled();
        });

        it("routes insertBatch to the file model", async function () {
            const batch = [RECORD, { ...RECORD, REQUEST_ID: "req_test456" }];
            await AuditLogModel.insertBatch(batch);
            expect(fileInsertBatchSpy).toHaveBeenCalledWith(batch);
            expect(insertManyMock).not.toHaveBeenCalled();
        });

        it("read methods delegate to the file model", async function () {
            const findSpy = vi
                .spyOn(AuditLogFileModel, "findPaginated")
                .mockResolvedValue([{ id: 1 }]);
            const countSpy = vi
                .spyOn(AuditLogFileModel, "countTotal")
                .mockResolvedValue(5);
            const latestSpy = vi
                .spyOn(AuditLogFileModel, "getLatestCreatedAt")
                .mockResolvedValue(1234567890);
            const aggSpy = vi
                .spyOn(AuditLogFileModel, "aggregate")
                .mockResolvedValue({
                    total: 10,
                    success: 8,
                    redirect: 1,
                    clientError: 1,
                    serverError: 0,
                    uniqueUsers: 3,
                    avgResponseTime: 42,
                });

            expect(await AuditLogModel.findPaginated({}, 1, 20)).toEqual([
                { id: 1 },
            ]);
            expect(findSpy).toHaveBeenCalledWith({}, 1, 20);

            expect(await AuditLogModel.countTotal({})).toBe(5);
            expect(countSpy).toHaveBeenCalledWith({});

            expect(await AuditLogModel.getLatestCreatedAt()).toBe(1234567890);
            expect(latestSpy).toHaveBeenCalled();

            const agg = await AuditLogModel.aggregate({});
            expect(agg).toMatchObject({
                total: 10,
                uniqueUsers: 3,
                avgResponseTime: 42,
            });
            expect(aggSpy).toHaveBeenCalled();
        });
    });

    describe("AUDIT_LOG_STORAGE=auto (default)", function () {
        it("defaults to auto-pending when the env var is unset", function () {
            expect(AuditLogModel.storageInfo().mode).toBe("auto-pending");
        });

        it("uses Oracle while writes succeed", async function () {
            process.env.AUDIT_LOG_STORAGE = "auto";
            await AuditLogModel.insert(RECORD);
            expect(insertOneMock).toHaveBeenCalled();
            expect(fileInsertSpy).not.toHaveBeenCalled();
            expect(AuditLogModel.storageInfo().mode).toBe("auto-pending");
        });

        it("switches to the file tier on ORA-00942 and re-routes the failed record", async function () {
            process.env.AUDIT_LOG_STORAGE = "auto";
            insertOneMock.mockRejectedValue(oraTableMissingError());

            await expect(AuditLogModel.insert(RECORD)).resolves.toEqual({
                rowsAffected: 1,
            });
            expect(fileInsertSpy).toHaveBeenCalledWith(RECORD);
            expect(AuditLogModel.storageInfo().mode).toBe("auto-file");
        });

        it("the switch is permanent — Oracle is not retried afterwards", async function () {
            process.env.AUDIT_LOG_STORAGE = "auto";
            insertOneMock.mockRejectedValue(oraTableMissingError());
            await AuditLogModel.insert(RECORD);
            insertOneMock.mockClear();

            await AuditLogModel.insert(RECORD);
            await AuditLogModel.insertBatch([RECORD]);
            expect(insertOneMock).not.toHaveBeenCalled();
            expect(insertManyMock).not.toHaveBeenCalled();
            expect(fileInsertSpy).toHaveBeenCalledTimes(2);
            expect(fileInsertBatchSpy).toHaveBeenCalledTimes(1);
        });

        it("a failed insertBatch re-routes the whole batch to the file tier", async function () {
            process.env.AUDIT_LOG_STORAGE = "auto";
            insertManyMock.mockRejectedValue(oraTableMissingError());
            const batch = [RECORD, { ...RECORD, REQUEST_ID: "req_test456" }];

            await expect(AuditLogModel.insertBatch(batch)).resolves.toEqual({
                rowsAffected: 2,
            });
            expect(fileInsertBatchSpy).toHaveBeenCalledWith(batch);
            expect(AuditLogModel.storageInfo().mode).toBe("auto-file");
        });
    });

    describe("table name resolution", function () {
        it("defaults to T_AUDIT_LOGS_DEV outside production (NODE_ENV=test)", function () {
            expect(AuditLogModel.storageInfo().table).toBe("T_AUDIT_LOGS_DEV");
        });

        it("defaults to T_AUDIT_LOGS in production", function () {
            const previous = process.env.NODE_ENV;
            process.env.NODE_ENV = "production";
            try {
                expect(AuditLogModel.storageInfo().table).toBe("T_AUDIT_LOGS");
            } finally {
                process.env.NODE_ENV = previous;
            }
        });

        it("AUDIT_LOG_TABLE overrides both defaults", function () {
            process.env.AUDIT_LOG_TABLE = "T_MY_CUSTOM_AUDIT";
            expect(AuditLogModel.storageInfo().table).toBe("T_MY_CUSTOM_AUDIT");
        });
    });
});
