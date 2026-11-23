"use strict";

/**
 * @fileoverview AuditLogModel storage routing: DEMO_MODE, db, file, and the
 * auto-mode first-failure fallback (db -> file, sticky), plus aggregate /
 * pagination / retention-delete behaviour in each backend.
 */

import type { AuditRecord } from "../../../../src/models/audit.log.model";

vi.mock("../../../../src/utils/oracle-mongo-wrapper", async () => (await import("../../helpers/modelsWrapperFake")).wrapperMock);

// The shared setup file can load audit.log.model before this file's vi.mock is
// registered, so load fresh instances (bound to the fake wrapper) explicitly.
let fake: typeof import("../../helpers/modelsWrapperFake").fake;
let AuditLogModel: typeof import("../../../../src/models/audit.log.model").default;
let _resetStorageForTests: () => void;
let AuditLogFileModel: typeof import("../../../../src/models/audit.log.file.model").default;
let demo: typeof import("../../../../src/models/demo/demoStore").default;

beforeAll(async function () {
    vi.resetModules();
    fake = (await import("../../helpers/modelsWrapperFake")).fake;
    const m = await import("../../../../src/models/audit.log.model");
    AuditLogModel = m.default;
    _resetStorageForTests = m._resetStorageForTests;
    AuditLogFileModel = (await import("../../../../src/models/audit.log.file.model")).default;
    demo = (await import("../../../../src/models/demo/demoStore")).default;
});

const rec = (over: Partial<AuditRecord> = {}): AuditRecord => ({
    REQUEST_ID: "r", USER_ID: 1, USERNAME: "u", METHOD: "GET", ENDPOINT: "/x", PARAMS: null,
    STATUS_CODE: 200, STATUS_CATEGORY: "2xx", RESPONSE_TIME_MS: 10, CLIENT_IP: null, SERVER_IP: null, ...over,
});

describe("AuditLogModel storage routing", function () {
    afterEach(function () {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
        vi.clearAllMocks();
        _resetStorageForTests();
        fake.insertOne.mockReset();
        fake.insertMany.mockReset();
    });

    describe("storage mode resolution", function () {
        it("resolves table name from env, production, or the DEV default", function () {
            vi.stubEnv("AUDIT_LOG_TABLE", "CUSTOM");
            expect(AuditLogModel.storageInfo().table).toBe("CUSTOM");
            vi.stubEnv("AUDIT_LOG_TABLE", "");
            vi.stubEnv("NODE_ENV", "production");
            expect(AuditLogModel.storageInfo().table).toBe("T_AUDIT_LOGS");
            vi.stubEnv("NODE_ENV", "test");
            expect(AuditLogModel.storageInfo().table).toBe("T_AUDIT_LOGS_DEV");
        });

        it.each([["db", "db"], ["FILE", "file"], ["auto", "auto-pending"], ["", "auto-pending"], ["weird", "auto-pending"]])(
            "AUDIT_LOG_STORAGE=%s -> %s", function (raw, mode) {
                vi.stubEnv("AUDIT_LOG_STORAGE", raw);
                expect(AuditLogModel.storageInfo().mode).toBe(mode);
            },
        );
    });

    describe("DEMO_MODE", function () {
        let logs: Array<Record<string, unknown>>;

        beforeEach(function () {
            vi.stubEnv("DEMO_MODE", "true");
            logs = [
                { ID: 1, USER_ID: 1, STATUS_CATEGORY: "2xx", RESPONSE_TIME_MS: 100, CREATED_AT: new Date("2026-01-01T00:00:00Z") },
                { ID: 2, USER_ID: 2, STATUS_CATEGORY: "5xx", RESPONSE_TIME_MS: 300, CREATED_AT: new Date("2026-01-03T00:00:00Z") },
                { ID: 3, USER_ID: 0, STATUS_CATEGORY: "4xx", CREATED_AT: new Date("2026-01-02T00:00:00Z") },
                { ID: 4, USER_ID: 1, STATUS_CATEGORY: null, RESPONSE_TIME_MS: null, CREATED_AT: new Date("2026-01-04T00:00:00Z") },
            ];
            vi.spyOn(demo, "auditLogs").mockReturnValue(logs as never);
        });

        it("insert and insertBatch write to the demo store only", async function () {
            const ins = vi.spyOn(demo, "auditInsert").mockReturnValue({ rowsAffected: 1 });
            expect(await AuditLogModel.insert(rec())).toEqual({ rowsAffected: 1 });
            expect(await AuditLogModel.insertBatch([rec(), rec()])).toEqual({ rowsAffected: 2 });
            expect(ins).toHaveBeenCalledTimes(3);
            expect(fake.insertOne).not.toHaveBeenCalled();
        });

        it("findPaginated filters, sorts newest-first and slices the requested page", async function () {
            expect((await AuditLogModel.findPaginated({}, 1, 2)).map((r) => r.ID)).toEqual([4, 2]);
            expect((await AuditLogModel.findPaginated({}, 2, 2)).map((r) => r.ID)).toEqual([3, 1]);
            expect((await AuditLogModel.findPaginated({ USER_ID: 1 }, 1, 10)).map((r) => r.ID)).toEqual([4, 1]);
        });

        it("countTotal honours the filter", async function () {
            expect(await AuditLogModel.countTotal({})).toBe(4);
            expect(await AuditLogModel.countTotal({ STATUS_CATEGORY: "5xx" })).toBe(1);
        });

        it("deleteMany removes only matches in place and reports the count", async function () {
            expect(await AuditLogModel.deleteMany({ CREATED_AT: { $lt: new Date("2026-01-03T00:00:00Z") } })).toEqual({ rowsAffected: 2 });
            expect(logs.map((l) => l.ID)).toEqual([2, 4]);
            expect(await AuditLogModel.deleteMany({ USER_ID: 99 })).toEqual({ rowsAffected: 0 });
        });

        it("getLatestCreatedAt is 0 for an empty store, otherwise the max timestamp", async function () {
            expect(await AuditLogModel.getLatestCreatedAt()).toBe(new Date("2026-01-04T00:00:00Z").getTime());
            logs.length = 0;
            expect(await AuditLogModel.getLatestCreatedAt()).toBe(0);
        });

        it("aggregate buckets by category, averages latency and counts unique real users (ignoring $or)", async function () {
            const stats = await AuditLogModel.aggregate({});
            expect(stats).toEqual({ total: 4, success: 1, redirect: 0, clientError: 1, serverError: 1, uniqueUsers: 2, avgResponseTime: 100 });
            // $or narrows the category counts but is ignored by the unique-user count
            expect(await AuditLogModel.aggregate({ $or: [{ ID: -1 }] })).toMatchObject({ total: 0, uniqueUsers: 2 });
            expect(await AuditLogModel.aggregate({ STATUS_CATEGORY: "none" })).toMatchObject({ total: 0, avgResponseTime: 0, uniqueUsers: 0 });
        });
    });

    describe("db mode", function () {
        beforeEach(function () {
            vi.stubEnv("DEMO_MODE", "false");
            vi.stubEnv("AUDIT_LOG_STORAGE", "db");
        });

        it("insert / insertBatch go to the collection and DB errors are NOT swallowed", async function () {
            fake.insertOne.mockResolvedValue({ ok: 1 });
            fake.insertMany.mockResolvedValue({ ok: 2 });
            expect(await AuditLogModel.insert(rec())).toEqual({ ok: 1 });
            expect(await AuditLogModel.insertBatch([rec()])).toEqual({ ok: 2 });
            fake.insertOne.mockRejectedValueOnce(new Error("ORA-03113"));
            const file = vi.spyOn(AuditLogFileModel, "insert");
            await expect(AuditLogModel.insert(rec())).rejects.toThrow("ORA-03113");
            expect(file).not.toHaveBeenCalled();
        });

        it("findPaginated passes the filter with newest-first sort and skip/limit", async function () {
            fake.toArray.mockResolvedValue([{ ID: 1 }]);
            expect(await AuditLogModel.findPaginated({ A: 1 }, 3, 20)).toEqual([{ ID: 1 }]);
            expect(fake.findArgs.at(-1)).toEqual({ A: 1 });
            expect(fake.chain).toEqual([
                { op: "sort", arg: { CREATED_AT: -1 } },
                { op: "skip", arg: 40 },
                { op: "limit", arg: 20 },
            ]);
        });

        it("countTotal, deleteMany and getLatestCreatedAt", async function () {
            fake.count.mockResolvedValue(9);
            expect(await AuditLogModel.countTotal({ A: 1 })).toBe(9);
            fake.deleteMany.mockResolvedValue({ deletedCount: 4 });
            expect(await AuditLogModel.deleteMany({ A: 1 })).toEqual({ rowsAffected: 4 });
            fake.toArray.mockResolvedValueOnce([]);
            expect(await AuditLogModel.getLatestCreatedAt()).toBe(0);
            const at = new Date("2026-05-05T00:00:00Z");
            fake.toArray.mockResolvedValueOnce([{ CREATED_AT: at }]);
            expect(await AuditLogModel.getLatestCreatedAt()).toBe(at.getTime());
            expect(fake.chain).toContainEqual({ op: "limit", arg: 1 });
        });

        it("aggregate runs two bound pipelines and strips $or from the unique-user filter", async function () {
            fake.aggregate
                .mockResolvedValueOnce([{ STATUS_CATEGORY: "2xx", CNT: 3, RESPTIME: 30 }, { STATUS_CATEGORY: "5xx", CNT: 1, RESPTIME: 10 }])
                .mockResolvedValueOnce([{ USER_ID: 1 }, { USER_ID: 2 }]);
            const stats = await AuditLogModel.aggregate({ $or: [{ X: 1 }], STATUS_CODE: 200 });
            expect(stats).toEqual({ total: 4, success: 3, redirect: 0, clientError: 0, serverError: 1, uniqueUsers: 2, avgResponseTime: 10 });
            const [first, second] = fake.aggregate.mock.calls.map((c) => c[0]);
            expect(first[0]).toEqual({ $match: { $or: [{ X: 1 }], STATUS_CODE: 200 } });
            expect(second[0]).toEqual({ $match: { STATUS_CODE: 200, USER_ID: { $gt: 0 } } });
        });

        it("aggregate tolerates a null unique-user result", async function () {
            fake.aggregate.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
            expect(await AuditLogModel.aggregate({})).toMatchObject({ total: 0, uniqueUsers: 0 });
        });
    });

    describe("file mode", function () {
        beforeEach(function () {
            vi.stubEnv("DEMO_MODE", "false");
            vi.stubEnv("AUDIT_LOG_STORAGE", "file");
        });

        it("delegates every operation to AuditLogFileModel and never touches Oracle", async function () {
            const r = rec();
            const s = {
                insert: vi.spyOn(AuditLogFileModel, "insert").mockResolvedValue({ f: 1 } as never),
                batch: vi.spyOn(AuditLogFileModel, "insertBatch").mockResolvedValue({ f: 2 } as never),
                page: vi.spyOn(AuditLogFileModel, "findPaginated").mockResolvedValue([{ ID: 7 }] as never),
                count: vi.spyOn(AuditLogFileModel, "countTotal").mockResolvedValue(5 as never),
                del: vi.spyOn(AuditLogFileModel, "deleteMany").mockResolvedValue({ rowsAffected: 2 } as never),
                latest: vi.spyOn(AuditLogFileModel, "getLatestCreatedAt").mockResolvedValue(77 as never),
                agg: vi.spyOn(AuditLogFileModel, "aggregate").mockResolvedValue({ total: 1 } as never),
            };
            expect(await AuditLogModel.insert(r)).toEqual({ f: 1 });
            expect(await AuditLogModel.insertBatch([r])).toEqual({ f: 2 });
            expect(await AuditLogModel.findPaginated({ a: 1 }, 2, 5)).toEqual([{ ID: 7 }]);
            expect(await AuditLogModel.countTotal({})).toBe(5);
            expect(await AuditLogModel.deleteMany({})).toEqual({ rowsAffected: 2 });
            expect(await AuditLogModel.getLatestCreatedAt()).toBe(77);
            expect(await AuditLogModel.aggregate({ m: 1 })).toEqual({ total: 1 });
            expect(s.page).toHaveBeenCalledWith({ a: 1 }, 2, 5);
            expect(fake.insertOne).not.toHaveBeenCalled();
            expect(fake.aggregate).not.toHaveBeenCalled();
        });
    });

    describe("auto mode fallback", function () {
        beforeEach(function () {
            vi.stubEnv("DEMO_MODE", "false");
            vi.stubEnv("AUDIT_LOG_STORAGE", "auto");
        });

        it("falls back to file on the first DB failure and stays on file afterwards", async function () {
            fake.insertOne.mockRejectedValue(new Error("ORA-12541"));
            const file = vi.spyOn(AuditLogFileModel, "insert").mockResolvedValue({ f: 1 } as never);
            expect(await AuditLogModel.insert(rec())).toEqual({ f: 1 });
            expect(AuditLogModel.storageInfo().mode).toBe("auto-file");
            await AuditLogModel.insert(rec());
            expect(fake.insertOne).toHaveBeenCalledTimes(1); // db no longer attempted
            expect(file).toHaveBeenCalledTimes(2);
        });

        it("a successful DB write keeps auto-pending (a later failure may still fall back)", async function () {
            fake.insertMany.mockResolvedValue({ ok: 1 });
            expect(await AuditLogModel.insertBatch([rec()])).toEqual({ ok: 1 });
            expect(AuditLogModel.storageInfo().mode).toBe("auto-pending");
        });

        it("reads use the DB while pending", async function () {
            fake.count.mockResolvedValue(3);
            expect(await AuditLogModel.countTotal({})).toBe(3);
        });
    });
});
