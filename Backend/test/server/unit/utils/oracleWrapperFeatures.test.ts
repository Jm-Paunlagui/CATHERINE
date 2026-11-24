"use strict";

/**
 * oracle-mongo-wrapper features built from the gap inventory
 * (plans/oracle-wrapper-gap-inventory.md) for statements CATHERINE itself runs:
 *
 *   G6   `$now` server-time arithmetic in a filter (alert-log retention purge)
 *   G10  Transaction.withReadOnlyTransaction (backup multi-table snapshot)
 *   G11  deleteMany(filter, { limit }) bounded delete (refresh-token purge)
 *   G17  updateMany / deleteMany multi-row RETURNING (revoke a user's sessions)
 *
 * No database: a recording connection captures SQL, binds and options.
 * The same statements are verified against Oracle 19c separately.
 */

const { OracleCollection } = require("../../../../src/utils/oracle-mongo-wrapper/core/OracleCollection");
const { Transaction } = require("../../../../src/utils/oracle-mongo-wrapper/Transaction");
const { parseFilter } = require("../../../../src/utils/oracle-mongo-wrapper/parsers/filterParser");

const ORACLEDB = { OUT_FORMAT_OBJECT: 4002, BIND_OUT: 3003, NUMBER: 2010, DATE: 2014, STRING: 2001 };

function recordingConn(result: any = { rows: [], rowsAffected: 0, outBinds: {} }) {
    const calls: any[] = [];
    return {
        calls,
        rolledBack: 0,
        async execute(sql, binds, opts) {
            calls.push({ sql, binds, opts });
            return typeof result === "function" ? result(sql) : result;
        },
        async rollback() {
            this.rolledBack++;
        },
    };
}

function fakeDb(conn) {
    return {
        oracledb: ORACLEDB,
        withConnection: (fn) => fn(conn),
        withTransaction: (fn) => fn(conn),
    };
}

describe("oracle-mongo-wrapper features", function () {
    describe("G6 — $now server-time operand", function () {
        it("binds the amount and compares against the database's wall-clock time", function () {
            const { whereClause, binds } = parseFilter({ CREATED_AT: { $lt: { $now: { minus: { days: 30 } } } } });
            expect(whereClause).toBe(`WHERE "CREATED_AT" < CAST(SYSTIMESTAMP AS TIMESTAMP) - NUMTODSINTERVAL(:where_CREATED_AT_now_0, 'DAY')`);
            expect(binds).toEqual({ where_CREATED_AT_now_0: 30 });
        });

        it("supports plain $now and combined units", function () {
            expect(parseFilter({ T: { $gte: { $now: true } } }).whereClause).toBe(`WHERE "T" >= CAST(SYSTIMESTAMP AS TIMESTAMP)`);
            // A TIMESTAMP WITH TIME ZONE column compares with SYSTIMESTAMP itself.
            expect(parseFilter({ T: { $gte: { $now: { withTimeZone: true } } } }).whereClause).toBe(`WHERE "T" >= SYSTIMESTAMP`);
            const { whereClause } = parseFilter({ T: { $lt: { $now: { minus: { hours: 2 }, plus: { minutes: 5 } } } } });
            expect(whereClause).toMatch(/CAST\(SYSTIMESTAMP AS TIMESTAMP\) - NUMTODSINTERVAL\(:\w+, 'HOUR'\) \+ NUMTODSINTERVAL\(:\w+, 'MINUTE'\)$/);
        });

        it("never interpolates the amount", function () {
            const { whereClause } = parseFilter({ T: { $lt: { $now: { minus: { days: 7 } } } } });
            expect(whereClause).not.toMatch(/\b7\b/);
        });

        it.each([
            [{ $now: { back: { days: 1 } } }],
            [{ $now: { minus: { weeks: 1 } } }],
            [{ $now: { minus: { days: -1 } } }],
            [{ $now: { minus: { days: "1; DROP" } } }],
            [{ $now: "now" }],
        ])("rejects %j", function (operand) {
            expect(() => parseFilter({ T: { $lt: operand } })).toThrow(TypeError);
        });
    });

    describe("G10 — withReadOnlyTransaction", function () {
        it("issues SET TRANSACTION READ ONLY first and rolls back after", async function () {
            const conn = recordingConn({ rows: [{ CNT: 0 }], rowsAffected: 0 });
            const out = await new Transaction(fakeDb(conn)).withReadOnlyTransaction(async (session) => {
                await session.collection("T_A").countDocuments({});
                await session.execute("SELECT 1 FROM DUAL");
                return "done";
            });
            expect(out).toBe("done");
            expect(conn.calls[0].sql).toBe("SET TRANSACTION READ ONLY");
            expect(conn.calls).toHaveLength(3);
            expect(conn.rolledBack).toBe(1);
        });

        it("still rolls back when the reads throw", async function () {
            const conn = recordingConn();
            await expect(
                new Transaction(fakeDb(conn)).withReadOnlyTransaction(async () => {
                    throw new Error("ORA-01555: snapshot too old");
                }),
            ).rejects.toThrow(/ORA-01555/);
            expect(conn.rolledBack).toBe(1);
        });

        it("reads inside never auto-commit", async function () {
            const conn = recordingConn({ rows: [{ CNT: 0 }] });
            await new Transaction(fakeDb(conn)).withReadOnlyTransaction((session) => session.collection("T_A").countDocuments({}));
            expect(conn.calls[1].opts.autoCommit).toBe(false);
        });
    });

    describe("G11 — bounded deleteMany", function () {
        it("appends ROWNUM <= :del_limit after the filter", async function () {
            const conn = recordingConn({ rowsAffected: 3 });
            const r = await new OracleCollection("T_TOKENS", fakeDb(conn)).deleteMany({ EXPIRES_AT: { $lt: new Date(0) } }, { limit: 500 });
            expect(r.deletedCount).toBe(3);
            expect(conn.calls[0].sql).toBe(`DELETE FROM "T_TOKENS" t0 WHERE "EXPIRES_AT" < :where_EXPIRES_AT_0 AND ROWNUM <= :del_limit`);
            expect(conn.calls[0].binds.del_limit).toBe(500);
        });

        it("works with an empty filter and keeps an OR group intact", async function () {
            const conn = recordingConn({ rowsAffected: 0 });
            const col = new OracleCollection("T", fakeDb(conn));
            await col.deleteMany({}, { limit: 1 });
            await col.deleteMany({ $or: [{ A: 1 }, { B: 2 }] }, { limit: 2 });
            expect(conn.calls[0].sql).toBe(`DELETE FROM "T" t0 WHERE ROWNUM <= :del_limit`);
            expect(conn.calls[1].sql).toMatch(/WHERE \("A" = :\w+ OR "B" = :\w+\) AND ROWNUM <= :del_limit$/);
        });

        it.each([[0], [-1], [1.5], [NaN], ["10"]])("rejects limit %p", async function (limit) {
            const col = new OracleCollection("T", fakeDb(recordingConn()));
            await expect(col.deleteMany({}, { limit })).rejects.toThrow(TypeError);
        });

        it("without limit is unchanged", async function () {
            const conn = recordingConn({ rowsAffected: 0 });
            await new OracleCollection("T", fakeDb(conn)).deleteMany({ A: 1 });
            expect(conn.calls[0].sql).toBe(`DELETE FROM "T" t0 WHERE "A" = :where_A_0`);
        });
    });

    describe("G17 — multi-row RETURNING", function () {
        it("updateMany returns one object per updated row", async function () {
            const conn = recordingConn({ rowsAffected: 3, outBinds: { out_FAMILY_ID: ["f1", "f2", "f1"], out_ID: ["7", "8", "9"] } });
            const r = await new OracleCollection("T_TOKENS", fakeDb(conn)).updateMany(
                { USER_ID: "u1", REVOKED_AT: null },
                { $set: { REVOKE_REASON: "logout" } },
                { returning: ["FAMILY_ID", "ID"] },
            );
            expect(conn.calls[0].sql).toMatch(/ WHERE "USER_ID" = :\w+ AND "REVOKED_AT" IS NULL RETURNING "FAMILY_ID", "ID" INTO :out_FAMILY_ID, :out_ID$/);
            expect(conn.calls[0].binds.out_FAMILY_ID).toEqual({ dir: ORACLEDB.BIND_OUT });
            expect(r.returning).toEqual([
                { FAMILY_ID: "f1", ID: "7" },
                { FAMILY_ID: "f2", ID: "8" },
                { FAMILY_ID: "f1", ID: "9" },
            ]);
        });

        it("deleteMany returns the deleted rows, with a limit", async function () {
            const conn = recordingConn({ rowsAffected: 2, outBinds: { out_ID: ["1", "2"] } });
            const r = await new OracleCollection("T", fakeDb(conn)).deleteMany({ A: 1 }, { limit: 2, returning: ["ID"] });
            expect(conn.calls[0].sql).toBe(`DELETE FROM "T" t0 WHERE "A" = :where_A_0 AND ROWNUM <= :del_limit RETURNING "ID" INTO :out_ID`);
            expect(r.returning).toEqual([{ ID: "1" }, { ID: "2" }]);
        });

        it("an update that matched nothing returns an empty list", async function () {
            const conn = recordingConn({ rowsAffected: 0, outBinds: { out_ID: [] } });
            const r = await new OracleCollection("T", fakeDb(conn)).updateMany({ A: 1 }, { $set: { B: 2 } }, { returning: ["ID"] });
            expect(r.returning).toEqual([]);
        });

        it("no returning option: no RETURNING clause and no returning key", async function () {
            const conn = recordingConn({ rowsAffected: 1 });
            const r = await new OracleCollection("T", fakeDb(conn)).updateMany({ A: 1 }, { $set: { B: 2 } });
            expect(conn.calls[0].sql).not.toMatch(/RETURNING/);
            expect(r).not.toHaveProperty("returning");
        });
    });
});
