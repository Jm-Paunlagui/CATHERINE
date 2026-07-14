"use strict";

/**
 * @fileoverview Unit tests for AuditLogModel's storage routing — the
 * AUDIT_LOG_STORAGE (db | file | auto) state machine and the dynamic
 * AUDIT_LOG_TABLE / NODE_ENV table-name resolution.
 *
 * OracleCollection.prototype.insertOne/insertMany are spied so no Oracle
 * connection is ever attempted; AuditLogFileModel is spied so file-tier
 * delegation is observable without touching the filesystem.
 */

const {
    OracleCollection,
} = require("../../../../src/utils/oracle-mongo-wrapper");
const AuditLogModel = require("../../../../src/models/audit.log.model");
const AuditLogFileModel = require("../../../../src/models/audit.log.file.model");

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
        vi.restoreAllMocks();
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

        it("read methods return the file model's empty stub shapes", async function () {
            expect(await AuditLogModel.findPaginated({}, 1, 20)).toEqual([]);
            expect(await AuditLogModel.countTotal({})).toBe(0);
            expect(await AuditLogModel.getLatestCreatedAt()).toBe(0);
            expect(await AuditLogModel.aggregate({})).toMatchObject({
                total: 0,
                uniqueUsers: 0,
                avgResponseTime: 0,
            });
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
            expect(AuditLogModel.storageInfo().table).toBe(
                "T_MY_CUSTOM_AUDIT",
            );
        });
    });
});
