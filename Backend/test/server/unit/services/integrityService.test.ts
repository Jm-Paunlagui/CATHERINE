/**
 * @fileoverview Unit tests for IntegrityService: allow-list enforcement, cached
 * tamper sweeps, paging clamps, browse/export modes and live-tail deltas.
 * IntegrityModel is stubbed (its registry is empty in the template).
 */
import "../../../../src/config/cacheStores";
import IntegrityService from "../../../../src/services/IntegrityService";
import IntegrityModel from "../../../../src/models/integrity.model";
import { registry } from "../../../../src/middleware/cache";

const verifyFn = vi.fn();
const cfg = {
    key: "orders",
    label: "Orders",
    table: "T_ORDERS",
    pk: "ID",
    project: {},
    verifyFn,
    filters: { customer: "CUSTOMER_ID", date: "CREATED_AT" },
    enums: { status: { column: "STATUS" } },
    live: true,
};

const tamperedRows = (n: number) => Array.from({ length: n }, (_v, i) => ({ ID: String(i + 1), ROW_HASH: "x" }));

beforeEach(() => {
    registry.resolve("integrity").flush();
    verifyFn.mockReset();
    vi.spyOn(IntegrityModel, "getTableConfig").mockImplementation((k: string) => (k === "orders" ? (cfg as never) : null));
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("IntegrityService table allow-list", () => {
    it.each(["nope", "", "__proto__", "constructor", "orders; DROP TABLE T_ADMINS_DEV"])(
        "rejects unknown table key %j with 400 before touching the model",
        async (key) => {
            const sweep = vi.spyOn(IntegrityModel, "sweepTampered");
            await expect(IntegrityService.getTamperFeed(key)).rejects.toMatchObject({ statusCode: 400 });
            await expect(IntegrityService.browsePage(key)).rejects.toMatchObject({ statusCode: 400 });
            await expect(IntegrityService.exportRows(key)).rejects.toMatchObject({ statusCode: 400 });
            await expect(IntegrityService.rescan(key)).rejects.toMatchObject({ statusCode: 400 });
            await expect(IntegrityService.getFilterOptions(key)).rejects.toMatchObject({ statusCode: 400 });
            await expect(IntegrityService.getMaxPk(key)).rejects.toMatchObject({ statusCode: 400 });
            await expect(IntegrityService.getLiveDelta(key, {}, 0)).rejects.toMatchObject({ statusCode: 400 });
            expect(sweep).not.toHaveBeenCalled();
        },
    );

    it("listTables delegates to the model catalogue", () => {
        const cat = [{ key: "orders" }];
        vi.spyOn(IntegrityModel, "listTables").mockReturnValue(cat as never);
        expect(IntegrityService.listTables()).toBe(cat);
    });
});

describe("IntegrityService.getFilterOptions", () => {
    it("returns {} without querying when the table has no enums", async () => {
        vi.spyOn(IntegrityModel, "getTableConfig").mockReturnValue({ ...cfg, enums: undefined } as never);
        const spy = vi.spyOn(IntegrityModel, "getFilterOptions");
        expect(await IntegrityService.getFilterOptions("orders")).toEqual({});
        expect(spy).not.toHaveBeenCalled();
    });

    it("caches options so the model runs once", async () => {
        const spy = vi.spyOn(IntegrityModel, "getFilterOptions").mockResolvedValue({ status: [{ value: "A", label: "A" }] });
        const a = await IntegrityService.getFilterOptions("orders");
        const b = await IntegrityService.getFilterOptions("orders");
        expect(a).toEqual(b);
        expect(spy).toHaveBeenCalledTimes(1);
    });
});

describe("IntegrityService tamper feed", () => {
    const sweep = () =>
        vi.spyOn(IntegrityModel, "sweepTampered").mockResolvedValue({ tampered: tamperedRows(5), rowsScanned: 100, truncated: false });

    it("sweeps once, tags rows TAMPERED with a numeric id and pages them", async () => {
        const spy = sweep();
        const out = await IntegrityService.getTamperFeed("orders", {}, { page: 2, limit: 2 });
        expect(out.total).toBe(5);
        expect(out.page).toBe(2);
        expect(out.limit).toBe(2);
        expect(out.rows.map((r) => r.id)).toEqual([3, 4]);
        expect(out.rows[0].integrity).toBe("TAMPERED");
        expect(out.rowsScanned).toBe(100);
        expect(out.truncated).toBe(false);
        await IntegrityService.getTamperFeed("orders", {}, { page: 1, limit: 2 });
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it("clamps page and limit (non-numeric, zero, huge)", async () => {
        sweep();
        const a = await IntegrityService.getTamperFeed("orders", {}, { page: "x", limit: 0 });
        expect([a.page, a.limit]).toEqual([1, 50]);
        const b = await IntegrityService.getTamperFeed("orders", {}, { page: -4, limit: 9999 });
        expect([b.page, b.limit]).toEqual([1, 200]);
        const c = await IntegrityService.getTamperFeed("orders");
        expect([c.page, c.limit]).toEqual([1, 50]);
    });

    it("keys the cache by scope (filters and dates) so scopes never share a sweep", async () => {
        const spy = sweep();
        await IntegrityService.getTamperFeed("orders", { customer: "1" });
        await IntegrityService.getTamperFeed("orders", { customer: "2" });
        await IntegrityService.getTamperFeed("orders", { customer: "1", from: new Date("2026-01-01T00:00:00Z") });
        await IntegrityService.getTamperFeed("orders", { customer: "1", to: new Date("2026-02-01T00:00:00Z") });
        await IntegrityService.getTamperFeed("orders", { customer: "1", date: "ignored" });
        expect(spy).toHaveBeenCalledTimes(4);
    });

    it("reports truncation and no tamper warning when nothing is tampered", async () => {
        vi.spyOn(IntegrityModel, "sweepTampered").mockResolvedValue({ tampered: [], rowsScanned: 7, truncated: true });
        const out = await IntegrityService.getTamperFeed("orders");
        expect(out).toMatchObject({ total: 0, truncated: true, rowsScanned: 7 });
        expect(new Date(out.scannedAt).toString()).not.toBe("Invalid Date");
    });

    it("does not cache a failed sweep", async () => {
        const spy = vi.spyOn(IntegrityModel, "sweepTampered").mockRejectedValueOnce(new Error("ORA-1"));
        await expect(IntegrityService.getTamperFeed("orders")).rejects.toThrow("ORA-1");
        spy.mockResolvedValue({ tampered: [], rowsScanned: 1, truncated: false });
        await expect(IntegrityService.getTamperFeed("orders")).resolves.toMatchObject({ total: 0 });
    });

    it("rescan forces a fresh sweep, resets to page 1 and records the actor", async () => {
        const spy = sweep();
        await IntegrityService.getTamperFeed("orders");
        const out = await IntegrityService.rescan("orders", {}, { limit: 3, actor: "SA1" });
        expect(spy).toHaveBeenCalledTimes(2);
        expect(out).toMatchObject({ page: 1, limit: 3 });
        await IntegrityService.rescan("orders");
        expect(spy).toHaveBeenCalledTimes(3);
    });
});

describe("IntegrityService.browsePage", () => {
    it("annotates each row with its verdict and reports the swept scope", async () => {
        vi.spyOn(IntegrityModel, "listPage").mockResolvedValue({ rows: [{ ID: "1" }, { ID: "2" }], total: 9 });
        vi.spyOn(IntegrityModel, "sweepTampered").mockResolvedValue({ tampered: tamperedRows(3), rowsScanned: 9, truncated: true });
        verifyFn.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        const out = await IntegrityService.browsePage("orders", {}, { page: 1, limit: 2 });
        expect(out.rows).toEqual([
            { ID: "1", id: 1, integrity: "VERIFIED" },
            { ID: "2", id: 2, integrity: "TAMPERED" },
        ]);
        expect(out).toMatchObject({ total: 9, tamperedInScope: 3, sweepTruncated: true });
    });

    it("uses default paging when none supplied", async () => {
        const list = vi.spyOn(IntegrityModel, "listPage").mockResolvedValue({ rows: [], total: 0 });
        vi.spyOn(IntegrityModel, "sweepTampered").mockResolvedValue({ tampered: [], rowsScanned: 0, truncated: false });
        await IntegrityService.browsePage("orders");
        expect(list).toHaveBeenCalledWith("orders", {}, { page: 1, limit: 50 });
    });

    it("tolerates a model returning null rows", async () => {
        vi.spyOn(IntegrityModel, "listPage").mockResolvedValue({ rows: null as never, total: 0 });
        vi.spyOn(IntegrityModel, "sweepTampered").mockResolvedValue({ tampered: [], rowsScanned: 0, truncated: false });
        expect((await IntegrityService.browsePage("orders")).rows).toEqual([]);
    });
});

describe("IntegrityService.exportRows", () => {
    beforeEach(() => {
        vi.spyOn(IntegrityModel, "sweepTampered").mockResolvedValue({ tampered: tamperedRows(5), rowsScanned: 50, truncated: false });
    });

    it("tamper mode (default) exports only swept rows and flags truncation at maxRows", async () => {
        const list = vi.spyOn(IntegrityModel, "listPage");
        const out = await IntegrityService.exportRows("orders", {}, { maxRows: 2 });
        expect(out.mode).toBe("tamper");
        expect(out.rows).toHaveLength(2);
        expect(out.total).toBe(5);
        expect(out.truncated).toBe(true);
        expect(list).not.toHaveBeenCalled();
        const full = await IntegrityService.exportRows("orders", {}, { mode: "bogus" });
        expect(full.truncated).toBe(false);
        expect(full.rows).toHaveLength(5);
    });

    it("all mode lists every row with verdicts and flags truncation from the total", async () => {
        const list = vi.spyOn(IntegrityModel, "listPage").mockResolvedValue({ rows: [{ ID: "1" }], total: 4 });
        verifyFn.mockResolvedValue(true);
        const out = await IntegrityService.exportRows("orders", {}, { mode: "all", maxRows: 999_999 });
        expect(list).toHaveBeenCalledWith("orders", {}, { page: 1, limit: 50_000 });
        expect(out).toMatchObject({ mode: "all", total: 4, truncated: true, rowsScanned: 50 });
        expect(out.rows[0].integrity).toBe("VERIFIED");
    });

    it("clamps maxRows below 1 to the default", async () => {
        const list = vi.spyOn(IntegrityModel, "listPage").mockResolvedValue({ rows: [], total: 0 });
        await IntegrityService.exportRows("orders", {}, { mode: "all", maxRows: -5 });
        expect(list).toHaveBeenCalledWith("orders", {}, { page: 1, limit: 1 });
    });
});

describe("IntegrityService live tail", () => {
    it("getMaxPk delegates for a known table", async () => {
        const spy = vi.spyOn(IntegrityModel, "getMaxPk").mockResolvedValue(42);
        expect(await IntegrityService.getMaxPk("orders", { a: 1 })).toBe(42);
        expect(spy).toHaveBeenCalledWith("orders", { a: 1 });
    });

    it("getLiveDelta returns the unchanged cursor when nothing is new", async () => {
        vi.spyOn(IntegrityModel, "listSince").mockResolvedValue([]);
        expect(await IntegrityService.getLiveDelta("orders", {}, 7)).toEqual({ newCount: 0, maxPk: 7, tampered: [] });
        expect((await IntegrityService.getLiveDelta("orders", {}, undefined as never)).maxPk).toBeNull();
    });

    it("getLiveDelta reports new rows, the last pk and only tampered rows", async () => {
        const since = vi.spyOn(IntegrityModel, "listSince").mockResolvedValue([{ ID: "8" }, { ID: "9" }]);
        verifyFn.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        const out = await IntegrityService.getLiveDelta("orders", {}, 7, 10);
        expect(since).toHaveBeenCalledWith("orders", {}, 7, 10);
        expect(out.newCount).toBe(2);
        expect(out.maxPk).toBe(9);
        expect(out.tampered).toEqual([{ ID: "9", id: 9, integrity: "TAMPERED" }]);
    });
});
