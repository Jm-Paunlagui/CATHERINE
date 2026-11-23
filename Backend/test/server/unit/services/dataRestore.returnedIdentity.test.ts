"use strict";

/**
 * DataRestoreService._returnedIdentity: an identity-table restore remaps foreign
 * keys and re-signs rows by the NEW identity each insert RETURNs. A missing value
 * must stop the restore (the throw rolls its transaction back) instead of mapping
 * rows to `undefined`.
 */

const DataRestoreService = require("../../../../src/services/DataRestoreService").default;

describe("DataRestoreService._returnedIdentity", function () {
    it("returns the numeric identity of the row", function () {
        expect(DataRestoreService._returnedIdentity([{ ID: 41 }, { ID: 42 }], 1, "T_X", "ID")).toBe(42);
    });

    it.each([
        ["no row at that index", [], 0],
        ["a NULL identity", [{ ID: null }], 0],
        ["the pk column missing", [{ OTHER: 7 }], 0],
    ])("throws on %s", function (_label, returning, idx) {
        expect(() => DataRestoreService._returnedIdentity(returning, idx, "T_X", "ID")).toThrow(
            /Restore of T_X: no identity value returned for row 0/,
        );
    });
});
