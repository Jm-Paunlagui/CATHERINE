"use strict";

/**
 * @fileoverview IntegrityModel allow-list security (CWE-89 / CWE-1321).
 *
 * Uses the REAL oracle-mongo-wrapper SQL builder; only createDb() is replaced
 * by a capturing connection, so the assertions are on the exact SQL text and
 * bind map Oracle would receive. Proven here:
 *   - a client `table` key never reaches SQL — only the registry's own table
 *     and column names do;
 *   - client filter KEYS are mapped through the table's filter dict (unknown,
 *     column-name and prototype keys are dropped);
 *   - client filter VALUES travel as binds, never as SQL text;
 *   - numeric filters cannot carry SQL text (bound as numbers).
 */

import IntegrityModel, { type TableConfig } from "../../../src/models/integrity.model";

const cap = vi.hoisted(() => {
    const calls: Array<{ sql: string; binds: Record<string, unknown> }> = [];
    const results: unknown[][] = [];
    const db = {
        oracledb: { OUT_FORMAT_OBJECT: 4002 },
        withConnection: async (fn: (conn: unknown) => unknown) =>
            fn({
                execute: async (sql: string, binds: Record<string, unknown>) => {
                    calls.push({ sql, binds });
                    return { rows: results.shift() ?? [] };
                },
            }),
    };
    return { calls, results, db };
});

vi.mock("../../../src/utils/oracle-mongo-wrapper", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../src/utils/oracle-mongo-wrapper")>()),
    createDb: () => cap.db,
}));

const ORDERS: TableConfig = {
    key: "orders",
    label: "Orders",
    table: "T_ORDERS",
    pk: "ORDER_ID",
    project: { ORDER_ID: 1, CUSTOMER_ID: 1, STATUS: 1, CREATED_AT: 1, ROW_HASH: 1 },
    verifyFn: async (row) => row.ROW_HASH === "ok",
    filters: { customer: "CUSTOMER_ID", status: "STATUS", date: "CREATED_AT" },
    numericFilters: ["customer"],
    enums: { status: { column: "STATUS" } },
    live: true,
};

const ALLOWED_IDENTIFIERS = new Set(["T_ORDERS", "ORDER_ID", "CUSTOMER_ID", "STATUS", "CREATED_AT", "ROW_HASH"]);

const SQLI = [
    "x' OR '1'='1",
    "'; DROP TABLE T_ORDERS; --",
    "1 UNION SELECT PASSWORD FROM T_ADMINS_DEV--",
    "\" OR 1=1 --",
];

const HOSTILE_KEYS = [
    "T_ADMINS_DEV",
    "T_ORDERS",
    "orders; DROP TABLE T_ORDERS",
    "orders' --",
    "orders\" WHERE 1=1 --",
    "../orders",
    "ORDERS",
];

/** Every double-quoted identifier in a SQL string. */
function quotedIdentifiers(sql: string): string[] {
    return [...sql.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** Every bare SQL identifier-like token after FROM. */
function fromTargets(sql: string): string[] {
    return [...sql.matchAll(/FROM\s+"?([A-Za-z0-9_$#]+)"?/gi)].map((m) => m[1]);
}

describe("IntegrityModel registry — SQL allow-list and bind safety (real SQL builder)", function () {
    let prev: typeof IntegrityModel.REGISTRY;

    beforeEach(function () {
        prev = IntegrityModel.REGISTRY;
        IntegrityModel.REGISTRY = Object.freeze({ orders: ORDERS });
        cap.calls.length = 0;
        cap.results.length = 0;
    });

    afterEach(function () {
        IntegrityModel.REGISTRY = prev;
    });

    it("hostile table keys resolve to nothing and never produce a query", async function () {
        for (const k of HOSTILE_KEYS) {
            expect(IntegrityModel.getTableConfig(k)).toBeNull();
            expect(await IntegrityModel.sweepTampered(k, { status: "x" })).toEqual({ tampered: [], rowsScanned: 0, truncated: false });
            expect(await IntegrityModel.listPage(k)).toEqual({ rows: [], total: 0 });
            expect(await IntegrityModel.getMaxPk(k)).toBeNull();
            expect(await IntegrityModel.listSince(k, {}, 1)).toEqual([]);
            expect(await IntegrityModel.getFilterOptions(k)).toEqual({});
        }
        expect(cap.calls).toHaveLength(0);
    });

    it("prototype keys never resolve a config and never reach SQL", async function () {
        for (const k of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
            expect(IntegrityModel.getTableConfig(k)).toBeNull();
            await IntegrityModel.sweepTampered(k).catch(() => undefined);
            await IntegrityModel.listPage(k).catch(() => undefined);
            await IntegrityModel.getMaxPk(k).catch(() => undefined);
            await IntegrityModel.listSince(k, {}, 1).catch(() => undefined);
            await IntegrityModel.getFilterOptions(k);
        }
        expect(cap.calls).toHaveLength(0);
    });

    it("the installed registry is frozen: a new key cannot be planted at runtime", function () {
        expect(() => {
            (IntegrityModel.REGISTRY as Record<string, TableConfig>).evil = { ...ORDERS, key: "evil", table: "T_ADMINS_DEV" };
        }).toThrow(TypeError);
        expect(IntegrityModel.getTableConfig("evil")).toBeNull();
    });

    it("the catalog exposes no physical table name, projection or verifier", function () {
        const [entry] = IntegrityModel.listTables();
        expect(Object.keys(entry).sort()).toEqual(["enums", "filters", "key", "label", "live", "pk"]);
        expect(JSON.stringify(entry)).not.toContain("T_ORDERS");
        expect(JSON.stringify(entry)).not.toContain("ROW_HASH");
    });

    it("every query shape names only registry identifiers and binds every filter value", async function () {
        const payload = SQLI[0];
        const hostileFilters = JSON.parse(
            JSON.stringify({
                status: payload,
                customer: "7",
                CUSTOMER_ID: "1 OR 1=1",
                "STATUS = 'x' OR 1=1 --": "y",
                T_ADMINS_DEV: "z",
            }).replace("{", "{\"__proto__\":{\"polluted\":\"OR 1=1\"},\"constructor\":{\"prototype\":{\"x\":1}},"),
        ) as Record<string, unknown>;

        cap.results.push([{ ORDER_ID: 3, ROW_HASH: "ok" }, { ORDER_ID: 2, ROW_HASH: "bad" }]);
        const swept = await IntegrityModel.sweepTampered("orders", hostileFilters, { batch: 5 });
        expect(swept.tampered).toEqual([{ ORDER_ID: 2, ROW_HASH: "bad" }]);

        cap.results.push([], []);
        await IntegrityModel.listPage("orders", hostileFilters, { page: 2, limit: 10 });
        cap.results.push([{ ORDER_ID: 9 }]);
        expect(await IntegrityModel.getMaxPk("orders", hostileFilters)).toBe(9);
        cap.results.push([]);
        await IntegrityModel.listSince("orders", hostileFilters, 9, 50);

        expect(cap.calls.length).toBeGreaterThanOrEqual(5);
        for (const { sql, binds } of cap.calls) {
            for (const id of quotedIdentifiers(sql)) expect(ALLOWED_IDENTIFIERS.has(id)).toBe(true);
            expect(fromTargets(sql).length).toBeGreaterThan(0);
            for (const t of fromTargets(sql)) expect(t.toUpperCase()).toBe("T_ORDERS");
            expect(quotedIdentifiers(sql)).toContain("STATUS");
            expect(sql).not.toContain(payload);
            expect(sql).not.toMatch(/OR 1=1|OR '1'='1|T_ADMINS_DEV|DROP|UNION|polluted|--/i);
            const values = Object.values(binds);
            expect(values).toContain(payload);
            expect(values).toContain(7);
            expect(values).not.toContain("1 OR 1=1");
            expect(values).not.toContain("OR 1=1");
            expect(values).not.toContain("y");
            expect(values).not.toContain("z");
        }
    });

    it.each(SQLI)("string filter payload travels as a bind, never as SQL text: %s", async function (payload) {
        cap.results.push([]);
        await IntegrityModel.sweepTampered("orders", { status: payload });
        const [{ sql, binds }] = cap.calls;
        expect(sql).not.toContain(payload);
        expect(Object.values(binds)).toEqual(expect.arrayContaining([payload]));
    });

    it("a numeric filter cannot smuggle SQL: non-numeric text binds as NaN, not as a string", async function () {
        cap.results.push([]);
        await IntegrityModel.sweepTampered("orders", { customer: "1 OR 1=1" });
        const [{ sql, binds }] = cap.calls;
        expect(sql).not.toContain("1 OR 1=1");
        const values = Object.values(binds);
        expect(values.some((v) => typeof v === "number" && Number.isNaN(v))).toBe(true);
        expect(values.some((v) => typeof v === "string")).toBe(false);
    });

    it("the DISTINCT enum lookup reads only the registry table and column", async function () {
        cap.results.push([{ STATUS: "OPEN" }]);
        expect(await IntegrityModel.getFilterOptions("orders")).toEqual({ status: [{ value: "OPEN", label: "OPEN" }] });
        expect(cap.calls).toHaveLength(1);
        const [{ sql }] = cap.calls;
        // The wrapper's own CTE alias ("stage_N") is the only non-registry identifier.
        const foreign = quotedIdentifiers(sql).filter((id) => !ALLOWED_IDENTIFIERS.has(id) && !/^stage_\d+$/.test(id));
        expect(foreign).toEqual([]);
        expect(fromTargets(sql)).toContain("T_ORDERS");
        expect(quotedIdentifiers(sql)).toContain("STATUS");
    });
});
