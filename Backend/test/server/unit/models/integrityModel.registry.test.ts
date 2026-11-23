"use strict";

/**
 * @fileoverview IntegrityModel with an installed registry: the per-table
 * branches that are unreachable while the shipped TABLE_REGISTRY is empty.
 * getTableConfig hit/miss (own keys only), the catalog listing, enum filter
 * options, the keyset tamper sweep (batching, cursor, cap, verifyFn
 * true/false/throws), offset paging, the live-tail MAX(pk) cursor and delta.
 *
 * The oracle-mongo-wrapper is the recording fake, so every assertion is on
 * the match object / cursor chain the model hands the wrapper.
 */

import IntegrityModel, { TABLE_REGISTRY, type TableConfig } from "../../../../src/models/integrity.model";
import { fake } from "../../helpers/modelsWrapperFake";

vi.mock("../../../../src/utils/oracle-mongo-wrapper", async () => (await import("../../helpers/modelsWrapperFake")).wrapperMock);

type Row = Record<string, unknown>;

const verifyOrders = vi.fn(async (row: Row) => row.ROW_HASH !== "bad");
const verifyLogs = vi.fn(async () => true);

const ORDERS: TableConfig = {
    key: "orders",
    label: "Orders",
    table: "T_ORDERS",
    pk: "ORDER_ID",
    project: { ORDER_ID: 1, CUSTOMER_ID: 1, STATUS: 1, AMOUNT: 1, CREATED_AT: 1, ROW_HASH: 1 },
    verifyFn: verifyOrders,
    filters: { customer: "CUSTOMER_ID", status: "STATUS", date: "CREATED_AT" },
    numericFilters: ["customer"],
    enums: {
        status: { column: "STATUS" },
        customer: { column: "CUSTOMER_ID", source: "T_CUSTOMERS", label: "NAME" },
        region: { column: "REGION_CODE", source: "T_REGIONS" },
    },
    live: true,
};

const LOGS: TableConfig = {
    key: "logs",
    label: "Logs",
    table: "T_LOGS",
    pk: "LOG_ID",
    project: { LOG_ID: 1, ROW_HASH: 1 },
    verifyFn: verifyLogs,
    filters: { actor: "ACTOR" },
    live: false,
};

const REGISTRY = Object.freeze({ orders: ORDERS, logs: LOGS });

/** n descending-PK rows starting at `top`. */
function rows(top: number, n: number, over: (pk: number) => Row = () => ({})): Row[] {
    return Array.from({ length: n }, (_, i) => ({ ORDER_ID: top - i, ROW_HASH: "ok", ...over(top - i) }));
}

describe("IntegrityModel with an installed registry", function () {
    let prev: typeof IntegrityModel.REGISTRY;

    beforeEach(function () {
        prev = IntegrityModel.REGISTRY;
        IntegrityModel.REGISTRY = REGISTRY;
        fake.findArgs.length = 0;
        fake.toArray.mockReset();
        fake.next.mockReset();
        fake.count.mockReset();
        fake.aggregate.mockReset();
        verifyOrders.mockClear();
        verifyLogs.mockClear();
    });

    afterEach(function () {
        IntegrityModel.REGISTRY = prev;
    });

    describe("getTableConfig", function () {
        it("returns null for unknown, prototype and near-miss keys", function () {
            for (const k of ["nope", "__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", "ORDERS", " orders", "T_ORDERS", ""]) {
                expect(IntegrityModel.getTableConfig(k)).toBeNull();
            }
        });

        it("returns the exact registered config object for an own key", function () {
            expect(IntegrityModel.getTableConfig("orders")).toBe(ORDERS);
            expect(IntegrityModel.getTableConfig("logs")).toBe(LOGS);
        });
    });

    describe("listTables", function () {
        it("describes every table without exposing table names, projections or verifiers", function () {
            expect(IntegrityModel.listTables()).toEqual([
                { key: "orders", label: "Orders", pk: "ORDER_ID", filters: ["customer", "status", "date"], enums: ["status", "customer", "region"], live: true },
                { key: "logs", label: "Logs", pk: "LOG_ID", filters: ["actor"], enums: [], live: false },
            ]);
        });
    });

    describe("getFilterOptions", function () {
        it("returns {} for an unknown key and for a table with no enums, without querying", async function () {
            expect(await IntegrityModel.getFilterOptions("nope")).toEqual({});
            expect(await IntegrityModel.getFilterOptions("logs")).toEqual({});
            expect(fake.aggregate).not.toHaveBeenCalled();
            expect(fake.toArray).not.toHaveBeenCalled();
        });

        it("builds DISTINCT options (dropping null/empty) and labelled options from the lookup table", async function () {
            fake.aggregate.mockImplementation(async (pipeline: Array<Record<string, Record<string, unknown>>>) => {
                const col = Object.keys(pipeline[1].$sort)[0];
                if (col === "STATUS") return [{ STATUS: "OPEN" }, { STATUS: null }, { STATUS: "" }, { STATUS: "CLOSED" }];
                return null; // REGION_CODE: driver returned nothing
            });
            fake.toArray.mockResolvedValueOnce([
                { CUSTOMER_ID: 1, NAME: "Acme" },
                { CUSTOMER_ID: 2, NAME: null },
                { CUSTOMER_ID: null, NAME: "orphan" },
            ]);

            const out = await IntegrityModel.getFilterOptions("orders");

            expect(out).toEqual({
                status: [{ value: "OPEN", label: "OPEN" }, { value: "CLOSED", label: "CLOSED" }],
                customer: [{ value: "1", label: "#1 · Acme" }, { value: "2", label: "#2" }],
                region: [],
            });
            expect(fake.aggregate).toHaveBeenCalledWith([{ $group: { _id: "$STATUS" } }, { $sort: { STATUS: 1 } }]);
            expect(fake.aggregate).toHaveBeenCalledWith([{ $group: { _id: "$REGION_CODE" } }, { $sort: { REGION_CODE: 1 } }]);
            expect(fake.findArgs).toEqual([{}]);
            expect(fake.chain).toEqual([
                { op: "project", arg: { CUSTOMER_ID: 1, NAME: 1 } },
                { op: "sort", arg: { CUSTOMER_ID: 1 } },
                { op: "limit", arg: 1000 },
            ]);
            const tables = fake.ctor.map((a) => a[0]);
            expect(tables).toEqual(expect.arrayContaining(["T_ORDERS", "T_CUSTOMERS", "T_REGIONS"]));
        });

        it("treats a null labelled-lookup result as no options", async function () {
            fake.aggregate.mockResolvedValue([]);
            fake.toArray.mockResolvedValueOnce(null);
            expect(await IntegrityModel.getFilterOptions("orders")).toEqual({ status: [], customer: [], region: [] });
        });
    });

    describe("sweepTampered", function () {
        it("returns the empty result for an unknown key without querying", async function () {
            expect(await IntegrityModel.sweepTampered("nope", { customer: 1 })).toEqual({ tampered: [], rowsScanned: 0, truncated: false });
            expect(fake.findArgs).toHaveLength(0);
        });

        it("keyset-batches by descending PK, returns only failing rows, and stops on a short batch", async function () {
            fake.toArray
                .mockResolvedValueOnce(rows(10, 2, (pk) => (pk === 9 ? { ROW_HASH: "bad" } : {})))
                .mockResolvedValueOnce(rows(8, 2))
                .mockResolvedValueOnce(rows(6, 1, () => ({ ROW_HASH: "bad" })));

            const res = await IntegrityModel.sweepTampered("orders", { customer: "42", status: "OPEN" }, { batch: 2 });

            expect(res).toEqual({
                tampered: [{ ORDER_ID: 9, ROW_HASH: "bad" }, { ORDER_ID: 6, ROW_HASH: "bad" }],
                rowsScanned: 5,
                truncated: false,
            });
            const base = { CUSTOMER_ID: 42, STATUS: "OPEN" };
            expect(fake.findArgs).toEqual([
                base,
                { ...base, ORDER_ID: { $lt: 9 } },
                { ...base, ORDER_ID: { $lt: 7 } },
            ]);
            expect(fake.chain).toEqual([
                { op: "project", arg: ORDERS.project },
                { op: "sort", arg: { ORDER_ID: -1 } },
                { op: "limit", arg: 2 },
            ]);
            expect(verifyOrders).toHaveBeenCalledTimes(5);
        });

        it("binds numeric filters as numbers and the rest as strings, plus the date range", async function () {
            fake.toArray.mockResolvedValueOnce([]);
            const from = new Date("2026-01-01T00:00:00Z");
            const to = new Date("2026-01-31T00:00:00Z");
            await IntegrityModel.sweepTampered("orders", { customer: "7", status: 3, from, to, unknown: "x" });
            expect(fake.findArgs[0]).toEqual({ CUSTOMER_ID: 7, STATUS: "3", CREATED_AT: { $gte: from, $lte: to } });
            expect(typeof (fake.findArgs[0] as Row).CUSTOMER_ID).toBe("number");
            expect(typeof (fake.findArgs[0] as Row).STATUS).toBe("string");
        });

        it("ends on an empty (or null) batch after an exact multiple of the batch size", async function () {
            fake.toArray.mockResolvedValueOnce(rows(4, 2)).mockResolvedValueOnce(rows(2, 2)).mockResolvedValueOnce(null);
            const res = await IntegrityModel.sweepTampered("orders", {}, { batch: 2 });
            expect(res).toEqual({ tampered: [], rowsScanned: 4, truncated: false });
            expect(fake.toArray).toHaveBeenCalledTimes(3);
        });

        it("stops and flags truncated once the sweep cap is reached", async function () {
            fake.toArray.mockResolvedValue(rows(100, 2));
            const res = await IntegrityModel.sweepTampered("orders", {}, { batch: 2, cap: 3 });
            expect(res.truncated).toBe(true);
            expect(res.rowsScanned).toBe(4);
            expect(fake.toArray).toHaveBeenCalledTimes(2);
        });

        it("raises a cap below the batch size up to one full batch", async function () {
            fake.toArray.mockResolvedValue(rows(100, 5));
            const res = await IntegrityModel.sweepTampered("orders", {}, { batch: 5, cap: 1 });
            expect(res).toMatchObject({ rowsScanned: 5, truncated: true });
            expect(fake.toArray).toHaveBeenCalledTimes(1);
        });

        it("uses the default batch for missing/NaN/zero batch and clamps a negative batch to 1", async function () {
            for (const batch of [undefined, Number.NaN, 0]) {
                fake.toArray.mockResolvedValueOnce([]);
                await IntegrityModel.sweepTampered("orders", {}, { batch });
                expect(fake.chain.at(-1)).toEqual({ op: "limit", arg: 5000 });
            }
            fake.toArray.mockResolvedValueOnce([]);
            await IntegrityModel.sweepTampered("orders", {}, { batch: -3 });
            expect(fake.chain.at(-1)).toEqual({ op: "limit", arg: 1 });
            fake.toArray.mockResolvedValueOnce([]);
            await IntegrityModel.sweepTampered("orders");
            expect(fake.findArgs.at(-1)).toEqual({});
        });

        it("propagates a verifyFn failure instead of reporting rows as clean", async function () {
            fake.toArray.mockResolvedValueOnce(rows(3, 2));
            verifyOrders.mockRejectedValueOnce(new Error("signing key unavailable"));
            await expect(IntegrityModel.sweepTampered("orders", {}, { batch: 2 })).rejects.toThrow("signing key unavailable");
        });

        it("reports every row when verifyFn returns false for all of them", async function () {
            fake.toArray.mockResolvedValueOnce([{ LOG_ID: 2 }, { LOG_ID: 1 }]);
            verifyLogs.mockResolvedValue(false);
            const res = await IntegrityModel.sweepTampered("logs", { actor: "root" }, { batch: 10 });
            verifyLogs.mockResolvedValue(true);
            expect(res).toEqual({ tampered: [{ LOG_ID: 2 }, { LOG_ID: 1 }], rowsScanned: 2, truncated: false });
            expect(fake.findArgs[0]).toEqual({ ACTOR: "root" });
        });
    });

    describe("listPage", function () {
        let pageChain: Array<{ op: string; arg: unknown }>;

        beforeEach(function () {
            pageChain = [];
        });

        function primeRows(result: Row[] | null) {
            fake.toArray.mockImplementationOnce(async () => {
                pageChain = [...fake.chain];
                return result;
            });
        }

        it("returns the empty page for an unknown key without querying", async function () {
            expect(await IntegrityModel.listPage("nope")).toEqual({ rows: [], total: 0 });
            expect(fake.findArgs).toHaveLength(0);
        });

        it("returns rows and total for the scoped slice with skip/limit from page/limit", async function () {
            primeRows(rows(5, 2));
            fake.count.mockResolvedValueOnce(12);
            const res = await IntegrityModel.listPage("orders", { customer: "3" }, { page: 3, limit: 2 });
            expect(res).toEqual({ rows: rows(5, 2), total: 12 });
            expect(fake.findArgs).toEqual([{ CUSTOMER_ID: 3 }, { CUSTOMER_ID: 3 }]);
            expect(pageChain).toEqual([
                { op: "project", arg: ORDERS.project },
                { op: "sort", arg: { ORDER_ID: -1 } },
                { op: "skip", arg: 4 },
                { op: "limit", arg: 2 },
            ]);
        });

        it("defaults page 1 / limit 50, clamps limit to 200, page to >= 1, and maps null rows to []", async function () {
            primeRows(null);
            fake.count.mockResolvedValueOnce(0);
            expect(await IntegrityModel.listPage("orders")).toEqual({ rows: [], total: 0 });
            expect(pageChain.slice(2)).toEqual([{ op: "skip", arg: 0 }, { op: "limit", arg: 50 }]);

            primeRows([]);
            fake.count.mockResolvedValueOnce(0);
            await IntegrityModel.listPage("orders", {}, { page: -4, limit: 10_000 });
            expect(pageChain.slice(2)).toEqual([{ op: "skip", arg: 0 }, { op: "limit", arg: 200 }]);

            primeRows([]);
            fake.count.mockResolvedValueOnce(0);
            await IntegrityModel.listPage("orders", {}, { page: 2, limit: -1 });
            expect(pageChain.slice(2)).toEqual([{ op: "skip", arg: 1 }, { op: "limit", arg: 1 }]);
        });
    });

    describe("getMaxPk", function () {
        it("returns null for an unknown key without querying", async function () {
            expect(await IntegrityModel.getMaxPk("nope")).toBeNull();
            expect(fake.findArgs).toHaveLength(0);
        });

        it("reads MAX(pk) via a pk-only projection sorted descending, limit 1", async function () {
            fake.next.mockResolvedValueOnce({ ORDER_ID: "42" });
            expect(await IntegrityModel.getMaxPk("orders", { customer: "9" })).toBe(42);
            expect(fake.findArgs).toEqual([{ CUSTOMER_ID: 9 }]);
            expect(fake.chain).toEqual([
                { op: "project", arg: { ORDER_ID: 1 } },
                { op: "sort", arg: { ORDER_ID: -1 } },
                { op: "limit", arg: 1 },
            ]);
        });

        it("returns null for an empty slice and reuses the cached collection", async function () {
            fake.next.mockResolvedValue(null);
            await IntegrityModel.getMaxPk("orders");
            const built = fake.ctor.length;
            expect(await IntegrityModel.getMaxPk("orders")).toBeNull();
            expect(fake.ctor.length).toBe(built);
            expect(fake.findArgs.at(-1)).toEqual({});
        });
    });

    describe("listSince", function () {
        it("returns [] for an unknown key or a null/undefined cursor without querying", async function () {
            expect(await IntegrityModel.listSince("nope", {}, 5)).toEqual([]);
            expect(await IntegrityModel.listSince("orders", {}, null as never)).toEqual([]);
            expect(await IntegrityModel.listSince("orders", {}, undefined as never)).toEqual([]);
            expect(fake.findArgs).toHaveLength(0);
        });

        it("returns rows after the cursor ascending, bounded by cap, with the pk bound as a number", async function () {
            fake.toArray.mockResolvedValueOnce([{ ORDER_ID: 6 }]);
            expect(await IntegrityModel.listSince("orders", { status: "OPEN" }, "5" as never, 25)).toEqual([{ ORDER_ID: 6 }]);
            expect(fake.findArgs[0]).toEqual({ STATUS: "OPEN", ORDER_ID: { $gt: 5 } });
            expect(fake.chain).toEqual([
                { op: "project", arg: ORDERS.project },
                { op: "sort", arg: { ORDER_ID: 1 } },
                { op: "limit", arg: 25 },
            ]);
        });

        it("the pk bound overrides a same-named filter column", async function () {
            const pkFilter: TableConfig = { ...ORDERS, key: "pkf", filters: { id: "ORDER_ID" } };
            IntegrityModel.REGISTRY = Object.freeze({ pkf: pkFilter });
            fake.toArray.mockResolvedValueOnce([]);
            await IntegrityModel.listSince("pkf", { id: "1" }, 100);
            expect(fake.findArgs[0]).toEqual({ ORDER_ID: { $gt: 100 } });
        });

        it("defaults cap to 500, maps 0/NaN cap to 500, clamps negative cap to 1, null rows to []", async function () {
            fake.toArray.mockResolvedValue(null);
            expect(await IntegrityModel.listSince("orders", undefined, 0)).toEqual([]);
            expect(fake.chain.at(-1)).toEqual({ op: "limit", arg: 500 });
            expect(fake.findArgs.at(-1)).toEqual({ ORDER_ID: { $gt: 0 } });
            await IntegrityModel.listSince("orders", {}, 1, 0);
            expect(fake.chain.at(-1)).toEqual({ op: "limit", arg: 500 });
            await IntegrityModel.listSince("orders", {}, 1, Number.NaN);
            expect(fake.chain.at(-1)).toEqual({ op: "limit", arg: 500 });
            await IntegrityModel.listSince("orders", {}, 1, -9);
            expect(fake.chain.at(-1)).toEqual({ op: "limit", arg: 1 });
        });
    });

    describe("prototype keys on the query methods", function () {
        // getTableConfig uses an own-property check, but the query methods index
        // REGISTRY directly. A prototype key therefore resolves to Object.prototype
        // or Object itself; the service layer gates every call through
        // getTableConfig first. Locked here: no such key ever reaches the DB.
        it("getFilterOptions yields {} for prototype keys", async function () {
            for (const k of ["__proto__", "constructor", "toString"]) {
                expect(await IntegrityModel.getFilterOptions(k)).toEqual({});
            }
        });

        it("sweep/page/max/since reject with a TypeError before any query is built", async function () {
            for (const k of ["__proto__", "constructor"]) {
                await expect(IntegrityModel.sweepTampered(k)).rejects.toThrow(TypeError);
                await expect(IntegrityModel.listPage(k)).rejects.toThrow(TypeError);
                await expect(IntegrityModel.getMaxPk(k)).rejects.toThrow(TypeError);
                await expect(IntegrityModel.listSince(k, {}, 1)).rejects.toThrow(TypeError);
            }
            expect(fake.findArgs).toHaveLength(0);
            expect(fake.aggregate).not.toHaveBeenCalled();
        });
    });
});

describe("IntegrityModel registry restore", function () {
    it("the shipped frozen empty registry is back in place after the suite above", function () {
        expect(IntegrityModel.REGISTRY).toBe(TABLE_REGISTRY);
        expect(IntegrityModel.listTables()).toEqual([]);
        expect(IntegrityModel.getTableConfig("orders")).toBeNull();
    });
});
