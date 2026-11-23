"use strict";

/**
 * @fileoverview IntegrityModel: the (currently empty, frozen) table registry
 * fails closed for every key, and _buildMatch turns filters into bound,
 * typed Mongo-style match objects.
 */

import IntegrityModel, { TABLE_REGISTRY, type TableConfig } from "../../../../src/models/integrity.model";
import { fake } from "../../helpers/modelsWrapperFake";

vi.mock("../../../../src/utils/oracle-mongo-wrapper", async () => (await import("../../helpers/modelsWrapperFake")).wrapperMock);

const cfg: TableConfig = {
    key: "t", label: "T", table: "T_X", pk: "ID", project: { ID: 1 },
    verifyFn: async () => true,
    filters: { user: "USER_ID", name: "NAME", date: "CREATED_AT" },
    numericFilters: ["user"],
    live: false,
};

describe("IntegrityModel", function () {
    it("exposes a frozen registry shared by every alias", function () {
        expect(Object.isFrozen(TABLE_REGISTRY)).toBe(true);
        expect(IntegrityModel.REGISTRY).toBe(TABLE_REGISTRY);
        expect(IntegrityModel.TABLE_REGISTRY).toBe(TABLE_REGISTRY);
        expect(IntegrityModel.listTables()).toEqual([]);
    });

    it("getTableConfig only honours own registry keys (no prototype lookups)", function () {
        for (const k of ["nope", "__proto__", "constructor", "toString", ""]) {
            expect(IntegrityModel.getTableConfig(k)).toBeNull();
        }
    });

    it("an unknown table key yields empty results and never touches the database", async function () {
        expect(await IntegrityModel.getFilterOptions("nope")).toEqual({});
        expect(await IntegrityModel.sweepTampered("nope")).toEqual({ tampered: [], rowsScanned: 0, truncated: false });
        expect(await IntegrityModel.listPage("nope")).toEqual({ rows: [], total: 0 });
        expect(await IntegrityModel.getMaxPk("nope")).toBeNull();
        expect(await IntegrityModel.listSince("nope", {}, 5)).toEqual([]);
        expect(await IntegrityModel.listSince("nope", {}, undefined as never)).toEqual([]);
        expect(fake.findArgs).toHaveLength(0);
        expect(fake.aggregate).not.toHaveBeenCalled();
    });

    describe("_buildMatch", function () {
        it("returns {} for no filters and skips null/undefined and the date key", function () {
            expect(IntegrityModel._buildMatch(cfg)).toEqual({});
            expect(IntegrityModel._buildMatch(cfg, { user: null, name: undefined, date: "x" })).toEqual({});
        });

        it("coerces numeric filters to Number and the rest to String", function () {
            expect(IntegrityModel._buildMatch(cfg, { user: "42", name: 7 })).toEqual({ USER_ID: 42, NAME: "7" });
        });

        it("keeps an injection attempt as an inert string value under a whitelisted column", function () {
            const evil = "x' OR '1'='1";
            expect(IntegrityModel._buildMatch(cfg, { name: evil, "NAME; DROP": "y" })).toEqual({ NAME: evil });
        });

        it("builds a date range only from real Date bounds", function () {
            const from = new Date("2026-01-01T00:00:00Z");
            const to = new Date("2026-02-01T00:00:00Z");
            expect(IntegrityModel._buildMatch(cfg, { from, to })).toEqual({ CREATED_AT: { $gte: from, $lte: to } });
            expect(IntegrityModel._buildMatch(cfg, { from })).toEqual({ CREATED_AT: { $gte: from } });
            expect(IntegrityModel._buildMatch(cfg, { to })).toEqual({ CREATED_AT: { $lte: to } });
            expect(IntegrityModel._buildMatch(cfg, { from: "2026-01-01", to: 5 })).toEqual({});
        });

        it("ignores date bounds when the table has no date filter and numericFilters is absent", function () {
            const noDate: TableConfig = { ...cfg, filters: { user: "USER_ID" }, numericFilters: undefined };
            expect(IntegrityModel._buildMatch(noDate, { user: "5", from: new Date() })).toEqual({ USER_ID: "5" });
        });
    });
});
