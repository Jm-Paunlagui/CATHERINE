"use strict";

/**
 * Tests for the integrity projection factory (src/utils/integrity/signedFields.js).
 *
 * The CENTRAL guarantee (plan §3.4): signer and verifier build byte-identical
 * payloads because they share ONE projection, and money spellings collapse to a
 * single canonical form so a value signed from a string verifies against the
 * same value fetched as an Oracle number. Both are the classes of failure that
 * produced permanent false-TAMPERED results in the reference system.
 */

const {
    makeSignedFields,
    canonicalMoney,
    canonicalPlain,
} = require("../../src/utils/integrity/signedFields");

describe("canonicalMoney — collapses every spelling of an amount", function () {
    it("maps integers, trailing-zero, and string forms to one scale-4 string", function () {
        expect(canonicalMoney(1500)).toBe("1500.0000");
        expect(canonicalMoney("1500")).toBe("1500.0000");
        expect(canonicalMoney("1500.00")).toBe("1500.0000");
        expect(canonicalMoney("1500.0000")).toBe("1500.0000");
        expect(canonicalMoney("1500.5")).toBe("1500.5000");
    });

    it("treats null / undefined / empty as zero, deterministically", function () {
        expect(canonicalMoney(null)).toBe("0.0000");
        expect(canonicalMoney(undefined)).toBe("0.0000");
        expect(canonicalMoney("")).toBe("0.0000");
    });
});

describe("canonicalPlain — stable non-money projection", function () {
    it("distinguishes null/undefined (→ '') from other values", function () {
        expect(canonicalPlain(null)).toBe("");
        expect(canonicalPlain(undefined)).toBe("");
        expect(canonicalPlain(0)).toBe("0");
        expect(canonicalPlain("x")).toBe("x");
    });
});

describe("makeSignedFields — one projection, shared by signer & verifier", function () {
    const projector = makeSignedFields({
        domain: "T_DEMO_LEDGER",
        fields: ["ID", "DIRECTION"],
        moneyFields: ["AMOUNT"],
    });

    it("projects money fields through the canonicaliser", function () {
        const p = projector.project({ ID: 7, DIRECTION: "CREDIT", AMOUNT: 1500 });
        expect(p).toEqual({ ID: "7", DIRECTION: "CREDIT", AMOUNT: "1500.0000" });
    });

    it("PROPERTY: two spellings of the same row project identically", function () {
        const a = projector.project({ ID: 7, DIRECTION: "CREDIT", AMOUNT: 1500 });
        const b = projector.project({ ID: "7", DIRECTION: "CREDIT", AMOUNT: "1500.00" });
        expect(a).toEqual(b);
    });

    it("sign → verify round-trips for the same row", async function () {
        const row = { ID: 7, DIRECTION: "CREDIT", AMOUNT: "1500.0000" };
        const sig = await projector.sign(row);
        expect(await projector.verify(row, sig)).toBe(true);
    });

    it("verifies a row signed from a STRING and read back as a NUMBER", async function () {
        // Write-time: money came in as a string. Read-time: Oracle handed a number.
        const sig = await projector.sign({ ID: 7, DIRECTION: "CREDIT", AMOUNT: "1500.00" });
        const fetched = { ID: 7, DIRECTION: "CREDIT", AMOUNT: 1500 };
        expect(await projector.verify(fetched, sig)).toBe(true);
    });

    it("rejects a genuinely mutated amount", async function () {
        const sig = await projector.sign({ ID: 7, DIRECTION: "CREDIT", AMOUNT: "1500.00" });
        expect(await projector.verify({ ID: 7, DIRECTION: "CREDIT", AMOUNT: "1500.01" }, sig)).toBe(
            false,
        );
    });

    it("rejects a wrong domain (cross-entity replay blocked)", async function () {
        const other = makeSignedFields({
            domain: "T_OTHER",
            fields: ["ID", "DIRECTION"],
            moneyFields: ["AMOUNT"],
        });
        const sig = await projector.sign({ ID: 7, DIRECTION: "CREDIT", AMOUNT: "1500.00" });
        expect(await other.verify({ ID: 7, DIRECTION: "CREDIT", AMOUNT: "1500.00" }, sig)).toBe(
            false,
        );
    });

    it("throws on an invalid spec", function () {
        expect(() => makeSignedFields({ domain: "", fields: [] })).toThrow();
        expect(() => makeSignedFields({ domain: "X", fields: "nope" })).toThrow();
    });
});
