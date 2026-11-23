"use strict";

/**
 * Regression tests for four oracle-mongo-wrapper defects (G1–G4 in
 * plans/oracle-wrapper-gap-inventory.md). Each was first reproduced against a
 * real Oracle 19c through the downstream copy of this wrapper:
 *
 *   G1  count() / set operations committed a session connection
 *       (a row lock held by the transaction was released mid-flight)
 *   G2  limit()/next() + forUpdate() emitted FETCH FIRST … FOR UPDATE (ORA-02014)
 *   G3  filter-driven DML had no t0 alias, so a correlated $exists (t0."COL")
 *       failed with ORA-00904
 *   G4  $currentDate always wrote SYSDATE (TIMESTAMP columns lost fractions)
 *   G18 updateOne/replaceOne/deleteOne({}) built "t0  AND ROWNUM = 1" (invalid SQL)
 *
 * No database: a recording connection captures the SQL and execute options.
 */

const { QueryBuilder } = require("../../../../src/utils/oracle-mongo-wrapper/core/QueryBuilder");
const { OracleCollection } = require("../../../../src/utils/oracle-mongo-wrapper/core/OracleCollection");
const { parseUpdate } = require("../../../../src/utils/oracle-mongo-wrapper/parsers/updateParser");

/** A connection that records every execute() and returns a canned result. */
function recordingConn() {
    const calls: any[] = [];
    return {
        calls,
        async execute(sql, binds, opts) {
            calls.push({ sql, binds, opts });
            return { rows: [{ CNT: 0 }], rowsAffected: 0, outBinds: {} };
        },
    };
}

/** A db whose withConnection() hands out its own (pooled) recording conn. */
function fakeDb() {
    const pooled = recordingConn();
    return {
        pooled,
        oracledb: { OUT_FORMAT_OBJECT: 4002, NUMBER: 2010, DATE: 2014, BIND_OUT: 3003 },
        withConnection: (fn) => fn(pooled),
    };
}

const CORRELATED = {
    $exists: { collection: "ARCHIVE", match: { TRANS_ID: "$TRANS_ID" } },
};

describe("oracle-mongo-wrapper defect regressions", function () {
    describe("G1 — reads on a session never commit", function () {
        it("count() on a session connection runs with autoCommit false", async function () {
            const db = fakeDb();
            const session = recordingConn();
            await new QueryBuilder("T", { A: 1 }, db, session).count();
            expect(session.calls).toHaveLength(1);
            expect(session.calls[0].opts.autoCommit).toBe(false);
        });

        it("count() without a session still auto-commits its pooled connection", async function () {
            const db = fakeDb();
            await new QueryBuilder("T", { A: 1 }, db).count();
            expect(db.pooled.calls[0].opts.autoCommit).toBe(true);
        });

        it("a set operation on a session connection runs with autoCommit false", async function () {
            const db = fakeDb();
            const session = recordingConn();
            const a = new OracleCollection("T1", db, session);
            const b = new OracleCollection("T2", db, session);
            await OracleCollection.union(a.find({}).project({ ID: 1 }), b.find({}).project({ ID: 1 })).toArray();
            expect(session.calls[0].opts.autoCommit).toBe(false);
        });
    });

    describe("G2 — forUpdate with paging", function () {
        const build = (fn) => fn(new QueryBuilder("T", { STATUS: "P" }, fakeDb()))._buildSQL().sql;

        it("never places FETCH FIRST / OFFSET in the locking query block", function () {
            const sql = build((q) => q.sort({ ID: 1 }).skip(5).limit(1).forUpdate(true));
            expect(sql).not.toMatch(/ROWS ONLY\s+FOR UPDATE/);
            expect(sql).toMatch(/WHERE "STATUS" = :\w+ AND t0\.ROWID IN \(SELECT t0\.ROWID FROM "T" t0 WHERE "STATUS" = :\w+ ORDER BY "ID" ASC OFFSET 5 ROWS FETCH FIRST 1 ROWS ONLY\) ORDER BY "ID" ASC FOR UPDATE$/);
        });

        it("repeats the same bind name rather than adding a second bind", function () {
            const qb = new QueryBuilder("T", { STATUS: "P" }, fakeDb()).limit(1).forUpdate("nowait");
            const { sql, binds } = qb._buildSQL();
            expect(Object.keys(binds)).toHaveLength(1);
            const name = Object.keys(binds)[0];
            expect(sql.split(`:${name}`)).toHaveLength(3);
            expect(sql).toMatch(/FOR UPDATE NOWAIT$/);
        });

        it("next() locks through the ROWID subquery", async function () {
            const session = recordingConn();
            await new QueryBuilder("T", {}, fakeDb(), session).forUpdate(true).next();
            expect(session.calls[0].sql).toBe(
                'SELECT * FROM "T" t0 WHERE t0.ROWID IN (SELECT t0.ROWID FROM "T" t0 FETCH FIRST 1 ROWS ONLY) FOR UPDATE',
            );
        });

        it("keeps the plain form when there is no paging", function () {
            expect(build((q) => q.forUpdate("skip locked"))).toBe(
                'SELECT * FROM "T" t0 WHERE "STATUS" = :where_STATUS_0 FOR UPDATE SKIP LOCKED',
            );
        });

        it("supports OF columns and WAIT n", function () {
            expect(build((q) => q.forUpdate({ of: ["GID"], wait: 5 }))).toMatch(/FOR UPDATE OF t0\."GID" WAIT 5$/);
            expect(build((q) => q.forUpdate({ skipLocked: true }))).toMatch(/FOR UPDATE SKIP LOCKED$/);
        });

        it("rejects unknown or contradictory lock modes", function () {
            const qb = () => new QueryBuilder("T", {}, fakeDb());
            expect(() => qb().forUpdate("no wait")).toThrow(TypeError);
            expect(() => qb().forUpdate({ wait: 5, nowait: true })).toThrow(TypeError);
            expect(() => qb().forUpdate({ wait: -1 })).toThrow(TypeError);
            expect(() => qb().forUpdate({ wait: 1.5 })).toThrow(TypeError);
            expect(() => qb().forUpdate({ of: [] })).toThrow(TypeError);
        });

        it("forUpdate(false) clears the lock", function () {
            expect(build((q) => q.forUpdate(true).forUpdate(false))).not.toMatch(/FOR UPDATE/);
        });
    });

    describe("G3 — filter-driven statements alias their table t0", function () {
        const run = async (fn) => {
            const session = recordingConn();
            await fn(new OracleCollection("TX", fakeDb(), session));
            return session.calls.map((c) => c.sql);
        };
        const correlated = /EXISTS \(SELECT 1 FROM "ARCHIVE" WHERE "TRANS_ID" = t0\."TRANS_ID"\)/;

        it("deleteMany", async function () {
            const [sql] = await run((c) => c.deleteMany({ CUTOFF_ID: 1, ...CORRELATED }));
            expect(sql).toMatch(/^DELETE FROM "TX" t0 WHERE /);
            expect(sql).toMatch(correlated);
        });

        it("updateMany", async function () {
            const [sql] = await run((c) => c.updateMany(CORRELATED, { $set: { S: "X" } }));
            expect(sql).toMatch(/^UPDATE "TX" t0 SET /);
            expect(sql).toMatch(correlated);
        });

        it("updateOne / deleteOne pick the row from an aliased subquery", async function () {
            const sqls = await run(async (c) => {
                await c.updateOne(CORRELATED, { $set: { S: "X" } });
                await c.deleteOne(CORRELATED);
            });
            for (const sql of sqls) expect(sql).toMatch(/\(SELECT ROWID FROM "TX" t0 WHERE EXISTS/);
        });

        it("countDocuments, findOne and distinct", async function () {
            const sqls = await run(async (c) => {
                await c.countDocuments(CORRELATED);
                await c.findOne(CORRELATED);
                await c.distinct("S", CORRELATED);
            });
            for (const sql of sqls) expect(sql).toMatch(/FROM "TX" t0 WHERE EXISTS/);
        });
    });

    describe("G18 — single-row statements with an empty filter", function () {
        it("updateOne / replaceOne / deleteOne({}) pick one row with valid SQL", async function () {
            const session = recordingConn();
            const c = new OracleCollection("TX", fakeDb(), session);
            await c.updateOne({}, { $set: { S: "X" } });
            await c.replaceOne({}, { S: "X" });
            await c.deleteOne({});
            expect(session.calls).toHaveLength(3);
            for (const { sql } of session.calls) {
                expect(sql).toMatch(/\(SELECT ROWID FROM "TX" t0 WHERE ROWNUM = 1\)/);
                expect(sql).not.toMatch(/t0\s+AND ROWNUM/);
            }
        });

        it("a non-empty filter keeps its predicate before ROWNUM", async function () {
            const session = recordingConn();
            await new OracleCollection("TX", fakeDb(), session).deleteOne({ A: 1 });
            expect(session.calls[0].sql).toMatch(/t0 WHERE "A" = :\w+ AND ROWNUM = 1\)/);
        });
    });

    describe("G4 — $currentDate type", function () {
        it("true and { $type: 'date' } stamp SYSDATE", function () {
            expect(parseUpdate({ $currentDate: { A: true } }).setClause).toBe('SET "A" = SYSDATE');
            expect(parseUpdate({ $currentDate: { A: { $type: "date" } } }).setClause).toBe('SET "A" = SYSDATE');
        });

        it("{ $type: 'timestamp' } stamps SYSTIMESTAMP", function () {
            expect(parseUpdate({ $currentDate: { A: { $type: "timestamp" } } }).setClause).toBe(
                'SET "A" = SYSTIMESTAMP',
            );
        });

        it("rejects any other value instead of guessing", function () {
            expect(() => parseUpdate({ $currentDate: { A: false } })).toThrow(/\$currentDate\.A/);
            expect(() => parseUpdate({ $currentDate: { A: { $type: "time" } } })).toThrow(/\$currentDate\.A/);
            expect(() => parseUpdate({ $currentDate: { A: "now" } })).toThrow(/\$currentDate\.A/);
        });
    });
});
