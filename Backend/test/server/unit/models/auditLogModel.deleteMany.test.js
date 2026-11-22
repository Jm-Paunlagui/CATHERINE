"use strict";

/**
 * AuditLogModel.deleteMany must report rowsAffected in DB mode. The Oracle wrapper
 * returns { acknowledged, deletedCount }; AuditLogService.deleteLogsByRange reads
 * rowsAffected (what the demo and file branches return), so DB mode used to report
 * 0 rows deleted no matter how many were removed (proven on Oracle 19c, 2026-11-22).
 */

const { OracleCollection } = require("../../../../src/utils/oracle-mongo-wrapper");

describe("AuditLogModel.deleteMany (DB storage)", function () {
    let AuditLogModel;
    const saved = { storage: process.env.AUDIT_LOG_STORAGE, demo: process.env.DEMO_MODE };

    beforeAll(function () {
        process.env.AUDIT_LOG_STORAGE = "db";
        process.env.DEMO_MODE = "false";
        AuditLogModel = require("../../../../src/models/audit.log.model").default;
        AuditLogModel._resetStorageForTests?.();
    });

    afterAll(function () {
        process.env.AUDIT_LOG_STORAGE = saved.storage;
        process.env.DEMO_MODE = saved.demo;
        AuditLogModel._resetStorageForTests?.();
        vi.restoreAllMocks();
    });

    it("maps the wrapper's deletedCount to rowsAffected", async function () {
        vi.spyOn(OracleCollection.prototype, "deleteMany").mockResolvedValue({ acknowledged: true, deletedCount: 7 });
        await expect(AuditLogModel.deleteMany({ REQUEST_ID: "x" })).resolves.toEqual({ rowsAffected: 7 });
    });
});
