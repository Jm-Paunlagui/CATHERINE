"use strict";

/**
 * moneyFetchTypeHandler.test.js — the driver-level read fence (plan §5.2, §3.0 rule 3b).
 *
 * node-oracledb returns a NUMBER as a JavaScript double by default, so a
 * NUMBER(19,4) money value or a NUMBER(19,8) rate is ALREADY ROUNDED before any
 * application code — or money.js — can see it. moneySafeFetchTypeHandler asks the
 * driver to hand back any SCALED number (scale > 0) as a STRING instead, which
 * Money.from() then parses losslessly.
 *
 * BOTH halves matter and are asserted here:
 *   • the money guarantee — a scaled NUMBER (money/rate) becomes a STRING;
 *   • the regression guard — a scale-0 NUMBER (status code, id, count) is LEFT
 *     ALONE, so the handler did not stringify the whole application.
 *
 * This is the fast Vitest twin of the live-DB round-trip in
 * test/oracle-mongo-wrapper/test.js §32 (which needs a real Oracle). Here we feed
 * the handler metaData-shaped objects directly — pure, no connection.
 */

const { oracledb, moneySafeFetchTypeHandler, EXECUTE_OPTIONS } = require("../../src/config/adapters/oracle");

/** Build a metaData-shaped object the way the driver passes it to the handler. */
function meta({ dbType = oracledb.DB_TYPE_NUMBER, scale = 0 } = {}) {
    return { dbType, scale };
}

describe("moneySafeFetchTypeHandler — scaled NUMBER → STRING", function () {
    it("stringifies a NUMBER(19,4) money column (scale 4)", function () {
        const out = moneySafeFetchTypeHandler(meta({ scale: 4 }));
        expect(out).toEqual({ type: oracledb.STRING });
    });

    it("stringifies a NUMBER(19,8) rate column (scale 8)", function () {
        const out = moneySafeFetchTypeHandler(meta({ scale: 8 }));
        expect(out).toEqual({ type: oracledb.STRING });
    });

    it("stringifies any scale >= 1 (scale 1 and 2)", function () {
        expect(moneySafeFetchTypeHandler(meta({ scale: 1 }))).toEqual({ type: oracledb.STRING });
        expect(moneySafeFetchTypeHandler(meta({ scale: 2 }))).toEqual({ type: oracledb.STRING });
    });
});

describe("moneySafeFetchTypeHandler — unscaled NUMBER stays a JS number (regression guard)", function () {
    it("leaves a scale-0 NUMBER (id / count) alone", function () {
        // undefined = default driver handling → stays a JS number.
        expect(moneySafeFetchTypeHandler(meta({ scale: 0 }))).toBeUndefined();
    });

    it("leaves a NUMBER(3) status code alone (scale 0)", function () {
        // A NUMBER(3) HTTP status column is precision 3, scale 0 — must stay numeric.
        expect(moneySafeFetchTypeHandler({ dbType: oracledb.DB_TYPE_NUMBER, scale: 0 })).toBeUndefined();
    });
});

describe("moneySafeFetchTypeHandler — non-NUMBER types are untouched", function () {
    it("leaves VARCHAR2 alone", function () {
        expect(moneySafeFetchTypeHandler({ dbType: oracledb.DB_TYPE_VARCHAR, scale: 0 })).toBeUndefined();
    });

    it("leaves DATE alone", function () {
        expect(moneySafeFetchTypeHandler({ dbType: oracledb.DB_TYPE_DATE, scale: 0 })).toBeUndefined();
    });

    it("leaves a scaled non-NUMBER alone (only NUMBER is fenced)", function () {
        // Even with a scale, a non-NUMBER dbType is not our concern.
        expect(moneySafeFetchTypeHandler({ dbType: oracledb.DB_TYPE_VARCHAR, scale: 4 })).toBeUndefined();
    });
});

describe("EXECUTE_OPTIONS wires the handler", function () {
    it("uses moneySafeFetchTypeHandler as its fetchTypeHandler", function () {
        expect(EXECUTE_OPTIONS.fetchTypeHandler).toBe(moneySafeFetchTypeHandler);
    });

    it("is frozen so the read fence cannot be silently swapped out", function () {
        expect(Object.isFrozen(EXECUTE_OPTIONS)).toBe(true);
    });
});
