"use strict";

/**
 * @fileoverview ServerAlertLogModel: DEMO_MODE in-memory history (insert,
 * filtering, paging, retention purge) and the Oracle path with the raw
 * connection faked (SQL shape, binds, CLOB DETAILS parsing).
 */

import ServerAlertLogModel, { resolveTableName } from "../../../../src/models/serverAlertLog.model";

const fake = vi.hoisted(() => ({
    execute: vi.fn(),
    deleteMany: vi.fn(),
    tables: [] as string[],
}));

vi.mock("../../../../src/utils/oracle-mongo-wrapper", () => ({
    createDb: vi.fn(() => ({
        oracledb: { CLOB: "CLOB", STRING: "STRING", OUT_FORMAT_OBJECT: 4002 },
        withConnection: async (cb: (c: unknown) => unknown) => cb({ execute: fake.execute }),
    })),
    OracleCollection: class {
        constructor(table: string) {
            fake.tables.push(table);
        }
        deleteMany = fake.deleteMany;
    },
}));

const base = {
    alertKey: "HIGH_LATENCY::GET /x",
    rule: "HIGH_LATENCY",
    severity: "WARNING" as const,
    transition: "FIRED" as const,
    channel: "email",
    emailStatus: "SENT" as const,
};

describe("ServerAlertLogModel", function () {
    afterEach(function () {
        vi.unstubAllEnvs();
        vi.useRealTimers();
        vi.clearAllMocks();
    });

    it("resolves the table from env override, production, or the DEV default", function () {
        vi.stubEnv("SERVER_ALERT_LOG_TABLE", "MY_LOG");
        expect(resolveTableName()).toBe("MY_LOG");
        vi.stubEnv("SERVER_ALERT_LOG_TABLE", "");
        vi.stubEnv("NODE_ENV", "production");
        expect(resolveTableName()).toBe("T_SERVER_ALERT_LOG");
        vi.stubEnv("NODE_ENV", "test");
        expect(resolveTableName()).toBe("T_SERVER_ALERT_LOG_DEV");
        expect(ServerAlertLogModel.resolveTableName).toBe(resolveTableName);
    });

    describe("DEMO_MODE", function () {
        beforeEach(function () {
            vi.stubEnv("DEMO_MODE", "true");
            vi.useFakeTimers();
            vi.setSystemTime(new Date("2026-01-10T00:00:00Z"));
        });

        it("stores normalised, length-capped rows and pages them newest first", async function () {
            await ServerAlertLogModel.insertOne({ ...base, alertKey: "A".repeat(300), description: "x".repeat(2000), emailError: "e".repeat(2000), valueNum: 4, details: { a: 1 }, notificationId: "n1" });
            vi.setSystemTime(new Date("2026-01-10T00:00:05Z"));
            await ServerAlertLogModel.insertOne({ ...base, severity: "CRITICAL", rule: "R2" });

            const page = await ServerAlertLogModel.findPage();
            expect(page.total).toBe(2);
            expect(page.rows[0]).toMatchObject({ RULE: "R2", SEVERITY: "CRITICAL", VALUE_NUM: null, DESCRIPTION: null, EMAIL_ERROR: null, DETAILS: null });
            expect(page.rows[1].ALERT_KEY).toHaveLength(200);
            expect(page.rows[1].DESCRIPTION).toHaveLength(1000);
            expect(page.rows[1].EMAIL_ERROR).toHaveLength(1000);
            expect(page.rows[1]).toMatchObject({ DETAILS: { a: 1 }, NOTIFICATION_ID: "n1", VALUE_NUM: 4 });
        });

        it("tolerates missing identity fields by storing empty strings", async function () {
            vi.setSystemTime(new Date("2026-01-10T01:00:00Z")); // newer than every earlier row
            await ServerAlertLogModel.insertOne({ ...base, alertKey: undefined as never, rule: undefined as never, channel: undefined as never });
            const { rows } = await ServerAlertLogModel.findPage({}, { limit: 1 });
            expect(rows[0]).toMatchObject({ ALERT_KEY: "", RULE: "", CHANNEL: "" });
        });

        it("filters by rule, severity, alert key and time window; clamps paging", async function () {
            await ServerAlertLogModel.insertOne({ ...base, alertKey: "k-filter", rule: "FILTER_RULE", severity: "CRITICAL" });
            const hit = await ServerAlertLogModel.findPage({ rule: "FILTER_RULE", severity: "CRITICAL", alertKey: "k-filter", from: new Date("2026-01-09T00:00:00Z"), to: new Date("2026-01-11T00:00:00Z") });
            expect(hit.total).toBe(1);
            expect((await ServerAlertLogModel.findPage({ rule: "FILTER_RULE", severity: "WARNING" })).total).toBe(0);
            expect((await ServerAlertLogModel.findPage({ alertKey: "other" })).total).toBe(0);
            expect((await ServerAlertLogModel.findPage({ rule: "nope" })).total).toBe(0);
            expect((await ServerAlertLogModel.findPage({ rule: "FILTER_RULE", from: new Date("2026-01-11T00:00:00Z") })).total).toBe(0);
            expect((await ServerAlertLogModel.findPage({ rule: "FILTER_RULE", to: new Date("2026-01-09T00:00:00Z") })).total).toBe(0);

            const clamped = await ServerAlertLogModel.findPage({}, { page: -4, limit: 99999 });
            expect(clamped).toMatchObject({ page: 1, limit: 200 });
            const dflt = await ServerAlertLogModel.findPage({}, { page: "x", limit: 0 });
            expect(dflt).toMatchObject({ page: 1, limit: 50 });
        });

        it("findLatestByAlertKey and findRecent read through findPage", async function () {
            await ServerAlertLogModel.insertOne({ ...base, rule: "LATEST", alertKey: "lk" });
            expect((await ServerAlertLogModel.findLatestByAlertKey("LATEST", "lk"))?.ALERT_KEY).toBe("lk");
            expect(await ServerAlertLogModel.findLatestByAlertKey("LATEST", "absent")).toBeNull();
            expect((await ServerAlertLogModel.findRecent()).length).toBeGreaterThan(0);
            expect(await ServerAlertLogModel.findRecent(1)).toHaveLength(1);
        });

        it("keeps at most 500 rows (oldest evicted) and purges rows older than the cutoff", async function () {
            for (let i = 0; i < 510; i++) await ServerAlertLogModel.insertOne({ ...base, rule: "BULK" });
            const bulk = await ServerAlertLogModel.findPage({ rule: "BULK" }, { limit: 200 });
            expect(bulk.total).toBeLessThanOrEqual(500);

            vi.setSystemTime(new Date("2026-06-10T00:00:00Z")); // ~150 days later
            await ServerAlertLogModel.insertOne({ ...base, rule: "FRESH" });
            const removed = await ServerAlertLogModel.purgeOlderThan(100);
            expect(removed).toBeGreaterThan(0);
            expect((await ServerAlertLogModel.findPage({ rule: "BULK" })).total).toBe(0);
            expect((await ServerAlertLogModel.findPage({ rule: "FRESH" })).total).toBe(1);
            expect(await ServerAlertLogModel.purgeOlderThan(undefined as never)).toBe(0); // 180-day default keeps fresh
        });
    });

    describe("Oracle mode", function () {
        beforeEach(function () {
            vi.stubEnv("DEMO_MODE", "false");
        });

        it("inserts with a CLOB DETAILS bind (JSON or null) and autoCommit", async function () {
            fake.execute.mockResolvedValue({});
            await ServerAlertLogModel.insertOne({ ...base, details: { x: 1 }, description: "d" });
            await ServerAlertLogModel.insertOne({ ...base, details: null });
            const [sql, binds, opts] = fake.execute.mock.calls[0];
            expect(sql).toContain("INSERT INTO T_SERVER_ALERT_LOG_DEV");
            expect(binds.details).toEqual({ val: '{"x":1}', type: "CLOB" });
            expect(binds.alertKey).toBe(base.alertKey);
            expect(opts).toEqual({ autoCommit: true });
            expect(fake.execute.mock.calls[1][1].details.val).toBeNull();
        });

        it("pages with WHERE binds, parses CLOB details and degrades bad JSON to null", async function () {
            fake.execute
                .mockResolvedValueOnce({ rows: [{ CNT: 7 }] })
                .mockResolvedValueOnce({ rows: [{ ID: 1, DETAILS: '{"k":2}' }, { ID: 2, DETAILS: "{bad" }, { ID: 3, DETAILS: null }] });
            const from = new Date("2026-01-01T00:00:00Z");
            const to = new Date("2026-01-02T00:00:00Z");
            const out = await ServerAlertLogModel.findPage({ rule: "R", severity: "CRITICAL", alertKey: "K".repeat(300), from, to }, { page: 2, limit: 3 });

            const [countSql, countBinds] = fake.execute.mock.calls[0];
            expect(countSql).toContain("WHERE RULE = :rule AND SEVERITY = :severity AND ALERT_KEY = :alertKey AND CREATED_AT >= :fromDate AND CREATED_AT <= :toDate");
            expect(countBinds.alertKey).toHaveLength(200);
            expect(fake.execute.mock.calls[1][1]).toMatchObject({ skip: 3, fetchLimit: 3, fromDate: from, toDate: to });
            expect(out.total).toBe(7);
            expect(out.rows.map((r) => r.DETAILS)).toEqual([{ k: 2 }, null, null]);
        });

        it("omits WHERE with no filters and tolerates empty result sets", async function () {
            fake.execute.mockResolvedValueOnce({}).mockResolvedValueOnce({});
            const out = await ServerAlertLogModel.findPage();
            expect(fake.execute.mock.calls[0][0]).not.toContain("WHERE");
            expect(out).toMatchObject({ rows: [], total: 0 });
        });

        it("purges through deleteMany with a DB-clock cutoff, defaulting and flooring days", async function () {
            fake.deleteMany.mockResolvedValue({ deletedCount: 9 });
            expect(await ServerAlertLogModel.purgeOlderThan(30)).toBe(9);
            expect(fake.deleteMany.mock.calls[0][0]).toEqual({ CREATED_AT: { $lt: { $now: { minus: { days: 30 } } } } });
            await ServerAlertLogModel.purgeOlderThan(0);
            expect(fake.deleteMany.mock.calls[1][0].CREATED_AT.$lt.$now.minus.days).toBe(180);
            await ServerAlertLogModel.purgeOlderThan(-5);
            expect(fake.deleteMany.mock.calls[2][0].CREATED_AT.$lt.$now.minus.days).toBe(1);
            expect(fake.tables[0]).toBe("T_SERVER_ALERT_LOG_DEV");
        });

        it("propagates connection failures from insert", async function () {
            fake.execute.mockRejectedValue(new Error("ORA-12541"));
            await expect(ServerAlertLogModel.insertOne(base)).rejects.toThrow("ORA-12541");
        });
    });
});
