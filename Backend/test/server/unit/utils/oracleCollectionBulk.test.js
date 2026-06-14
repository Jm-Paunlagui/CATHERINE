"use strict";

/**
 * @fileoverview Unit tests for the oracle-mongo-wrapper bulk additions:
 *   - insertMany options { returning, batchErrors }
 *   - bulkUpdateByKeys (set-based per-key UPDATE via executeMany)
 *
 * No Oracle connection is required. A fake `db` supplies the oracledb type
 * constants, and a fake bound `conn` captures the SQL + binds + options passed
 * to executeMany so we can assert the generated statement and the result
 * mapping. Constructing the collection WITH an explicit conn (3rd arg) routes
 * insertMany / bulkUpdateByKeys straight onto that connection (the session
 * binding path), so no withTransaction wiring is needed.
 */

const { expect } = require("chai");
const {
    OracleCollection,
} = require("../../../../src/utils/oracle-mongo-wrapper/core/OracleCollection");

// Fake oracledb type constants — identity sentinels are enough for assertions.
const ORACLEDB = {
    NUMBER: "NUMBER",
    STRING: "STRING",
    DATE: "DATE",
    BIND_OUT: "BIND_OUT",
    OUT_FORMAT_OBJECT: "OBJECT",
};

/** Builds a fake bound connection whose executeMany returns `result`. */
function fakeConn(result) {
    const calls = [];
    return {
        calls,
        async executeMany(sql, rows, options) {
            calls.push({ sql, rows, options });
            return typeof result === "function"
                ? result(sql, rows, options)
                : result;
        },
    };
}

const fakeDb = { oracledb: ORACLEDB };

describe("OracleCollection.insertMany — options", function () {
    it("RETURNING defaults to ID and maps insertedIds (backward compatible)", async function () {
        const conn = fakeConn({
            rowsAffected: 2,
            outBinds: [{ out_ID: [1] }, { out_ID: [2] }],
        });
        const coll = new OracleCollection("USERS", fakeDb, conn);
        const res = await coll.insertMany([
            { NAME: "Ana" },
            { NAME: "Ben" },
        ]);
        expect(conn.calls[0].sql).to.match(/RETURNING "ID" INTO :out_ID/);
        expect(res.insertedCount).to.equal(2);
        expect(res.insertedIds).to.deep.equal([1, 2]);
    });

    it("custom returning column maps result.returning per row", async function () {
        const conn = fakeConn({
            rowsAffected: 2,
            outBinds: [{ out_WALLET_ID: [7] }, { out_WALLET_ID: [8] }],
        });
        const coll = new OracleCollection("TAP_WALLET", fakeDb, conn);
        const res = await coll.insertMany(
            [{ GID: 1, CUTOFF_ID: 5 }, { GID: 2, CUTOFF_ID: 5 }],
            { returning: ["WALLET_ID"] },
        );
        expect(conn.calls[0].sql).to.match(
            /RETURNING "WALLET_ID" INTO :out_WALLET_ID/,
        );
        expect(res.returning).to.deep.equal([
            { WALLET_ID: 7 },
            { WALLET_ID: 8 },
        ]);
    });

    it("returning: [] omits the RETURNING clause entirely", async function () {
        const conn = fakeConn({ rowsAffected: 1, outBinds: undefined });
        const coll = new OracleCollection("T_CUTOFF_DATE", fakeDb, conn);
        await coll.insertMany([{ CUTOFF_ID: 100, PAY_PERIOD: "Jun-30" }], {
            returning: [],
        });
        expect(conn.calls[0].sql).to.not.match(/RETURNING/);
    });

    it("batchErrors:true forwards the flag and maps reported offsets", async function () {
        const conn = fakeConn({
            rowsAffected: 2,
            batchErrors: [{ offset: 1, message: "ORA-00001: unique" }],
        });
        const coll = new OracleCollection("TAP_SUBSIDY_UPLOAD", fakeDb, conn);
        const res = await coll.insertMany(
            [{ GID: 1 }, { GID: 2 }, { GID: 3 }],
            { returning: [], batchErrors: true },
        );
        expect(conn.calls[0].options.batchErrors).to.equal(true);
        expect(res.batchErrors).to.deep.equal([
            { offset: 1, message: "ORA-00001: unique" },
        ]);
    });

    it("rejects returning + batchErrors together (mutually exclusive)", async function () {
        const coll = new OracleCollection("X", fakeDb, fakeConn({}));
        let threw = null;
        try {
            await coll.insertMany([{ A: 1 }], {
                returning: ["ID"],
                batchErrors: true,
            });
        } catch (e) {
            threw = e;
        }
        expect(threw).to.not.equal(null);
        expect(threw.message).to.match(/mutually exclusive/);
    });

    it("throws on an empty documents array", async function () {
        const coll = new OracleCollection("X", fakeDb, fakeConn({}));
        let threw = null;
        try {
            await coll.insertMany([]);
        } catch (e) {
            threw = e;
        }
        expect(threw).to.not.equal(null);
    });
});

describe("OracleCollection.bulkUpdateByKeys", function () {
    it("builds SET from non-key columns and WHERE from keys, via executeMany", async function () {
        const conn = fakeConn({ rowsAffected: 2 });
        const coll = new OracleCollection("TAP_WALLET", fakeDb, conn);
        const res = await coll.bulkUpdateByKeys(
            [
                { WALLET_ID: 7, ROW_HASH: "ab" },
                { WALLET_ID: 8, ROW_HASH: "cd" },
            ],
            { keys: ["WALLET_ID"] },
        );
        const { sql, rows } = conn.calls[0];
        expect(sql).to.match(
            /UPDATE "TAP_WALLET" SET "ROW_HASH" = :s0 WHERE "WALLET_ID" = :k0/,
        );
        // Each bind row carries its set value (s0) and key value (k0).
        expect(rows[0]).to.deep.equal({ s0: "ab", k0: 7 });
        expect(rows[1]).to.deep.equal({ s0: "cd", k0: 8 });
        expect(res.modifiedCount).to.equal(2);
    });

    it("supports composite keys (multiple WHERE columns)", async function () {
        const conn = fakeConn({ rowsAffected: 1 });
        const coll = new OracleCollection("T_EMP_MASTER_LIST", fakeDb, conn);
        await coll.bulkUpdateByKeys(
            [{ GID: 1, CARD_NUMBER: 100, EMP_NAME: "NEW" }],
            { keys: ["GID", "CARD_NUMBER"] },
        );
        const { sql, rows } = conn.calls[0];
        expect(sql).to.match(/SET "EMP_NAME" = :s0/);
        expect(sql).to.match(
            /WHERE "GID" = :k0 AND "CARD_NUMBER" = :k1/,
        );
        expect(rows[0]).to.deep.equal({ s0: "NEW", k0: 1, k1: 100 });
    });

    it("throws when keys are missing", async function () {
        const coll = new OracleCollection("X", fakeDb, fakeConn({}));
        let threw = null;
        try {
            await coll.bulkUpdateByKeys([{ ID: 1, V: 2 }], {});
        } catch (e) {
            threw = e;
        }
        expect(threw).to.not.equal(null);
    });

    it("throws when no non-key columns remain to update", async function () {
        const coll = new OracleCollection("X", fakeDb, fakeConn({}));
        let threw = null;
        try {
            await coll.bulkUpdateByKeys([{ ID: 1 }], { keys: ["ID"] });
        } catch (e) {
            threw = e;
        }
        expect(threw).to.not.equal(null);
    });

    it("throws on an empty rows array", async function () {
        const coll = new OracleCollection("X", fakeDb, fakeConn({}));
        let threw = null;
        try {
            await coll.bulkUpdateByKeys([], { keys: ["ID"] });
        } catch (e) {
            threw = e;
        }
        expect(threw).to.not.equal(null);
    });
});

describe("OracleCollection bulk — bind-type inference & sizing", function () {
    it("infers NUMBER, DATE, and STRING bind types per column", async function () {
        const conn = fakeConn({ rowsAffected: 1, outBinds: undefined });
        const coll = new OracleCollection("T", fakeDb, conn);
        const when = new Date("2026-04-17T00:00:00Z");
        await coll.insertMany([{ N: 42, D: when, S: "hello" }], {
            returning: [],
        });
        const defs = conn.calls[0].options.bindDefs;
        expect(defs.v0.type).to.equal(ORACLEDB.NUMBER);
        expect(defs.v1.type).to.equal(ORACLEDB.DATE);
        expect(defs.v2.type).to.equal(ORACLEDB.STRING);
    });

    it("sizes string binds by UTF-8 BYTE length, not character count", async function () {
        // 'ñ' and 'é' are 2 bytes each in UTF-8. A 200-char multi-byte name
        // can exceed char-count*2; byte sizing must cover the real byte length.
        const conn = fakeConn({ rowsAffected: 1, outBinds: undefined });
        const coll = new OracleCollection("T", fakeDb, conn);
        const name = "ñ".repeat(120); // 120 chars, 240 bytes
        await coll.insertMany([{ EMP_NAME: name }], { returning: [] });
        const def = conn.calls[0].options.bindDefs.v0;
        expect(def.type).to.equal(ORACLEDB.STRING);
        // maxSize must be at least the true byte length (240), which the old
        // char-count sizing (chars only) would have under-counted.
        expect(def.maxSize).to.be.at.least(Buffer.byteLength(name, "utf8"));
    });

    it("scans all rows for a non-null sample when the first row's column is null", async function () {
        const conn = fakeConn({ rowsAffected: 2, outBinds: undefined });
        const coll = new OracleCollection("T", fakeDb, conn);
        await coll.insertMany([{ N: null }, { N: 7 }], { returning: [] });
        // Type resolved from the second row's number, not defaulted to STRING.
        expect(conn.calls[0].options.bindDefs.v0.type).to.equal(ORACLEDB.NUMBER);
    });

    it("bulkUpdateByKeys sizes value binds by byte length too", async function () {
        const conn = fakeConn({ rowsAffected: 1 });
        const coll = new OracleCollection("T", fakeDb, conn);
        const hash = "é".repeat(80); // 160 bytes
        await coll.bulkUpdateByKeys([{ ID: 1, ROW_HASH: hash }], {
            keys: ["ID"],
        });
        const def = conn.calls[0].options.bindDefs.s0;
        expect(def.maxSize).to.be.at.least(Buffer.byteLength(hash, "utf8"));
    });
});

describe("OracleCollection bulk — session binding", function () {
    it("insertMany runs on the bound connection (does NOT open a new transaction)", async function () {
        const conn = fakeConn({ rowsAffected: 1, outBinds: undefined });
        const dbThatThrows = {
            oracledb: ORACLEDB,
            withTransaction() {
                throw new Error("must not open a transaction when session-bound");
            },
        };
        const coll = new OracleCollection("T", dbThatThrows, conn);
        await coll.insertMany([{ A: 1 }], { returning: [] });
        expect(conn.calls).to.have.lengthOf(1); // ran straight on the conn
    });

    it("insertMany without a bound conn routes through db.withTransaction", async function () {
        const conn = fakeConn({ rowsAffected: 1, outBinds: undefined });
        let routed = false;
        const db = {
            oracledb: ORACLEDB,
            async withTransaction(fn) {
                routed = true;
                return fn(conn);
            },
        };
        const coll = new OracleCollection("T", db); // no conn
        await coll.insertMany([{ A: 1 }], { returning: [] });
        expect(routed).to.equal(true);
        expect(conn.calls).to.have.lengthOf(1);
    });

    it("bulkUpdateByKeys runs on the bound connection without a new transaction", async function () {
        const conn = fakeConn({ rowsAffected: 1 });
        const dbThatThrows = {
            oracledb: ORACLEDB,
            withTransaction() {
                throw new Error("must not open a transaction when session-bound");
            },
        };
        const coll = new OracleCollection("T", dbThatThrows, conn);
        await coll.bulkUpdateByKeys([{ ID: 1, V: 2 }], { keys: ["ID"] });
        expect(conn.calls).to.have.lengthOf(1);
    });
});
