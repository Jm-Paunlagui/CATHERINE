/**
 * @fileoverview HTTP integration tests for /api/v1/integrity. Real controller,
 * real IntegrityService and cache; IntegrityModel (empty registry in the
 * template) is stubbed with one fake table.
 */
import IntegrityModel from "../../../../src/models/integrity.model";
import { registry } from "../../../../src/middleware/cache";
import { send, superAdminToken } from "../../helpers/purgeHttp";

const verifyFn = vi.fn();
const cfg = { key: "orders", label: "Orders", table: "T_ORDERS", pk: "ID", project: {}, verifyFn, filters: { customer: "C" }, live: true };
const bearer = () => superAdminToken();

beforeEach(() => {
    registry.resolve("integrity").flush();
    verifyFn.mockReset().mockResolvedValue(true);
    vi.spyOn(IntegrityModel, "getTableConfig").mockImplementation((k: string) => (k === "orders" ? (cfg as never) : null));
    vi.spyOn(IntegrityModel, "sweepTampered").mockResolvedValue({ tampered: [{ ID: "5" }, { ID: "6" }], rowsScanned: 20, truncated: false });
    vi.spyOn(IntegrityModel, "listPage").mockResolvedValue({ rows: [{ ID: "1" }], total: 1 });
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("GET /integrity/tables", () => {
    it("returns the catalogue", async () => {
        vi.spyOn(IntegrityModel, "listTables").mockReturnValue([{ key: "orders" }] as never);
        const res = await send("get", "/api/v1/integrity/tables", { bearer: bearer() });
        expect(res.status).toBe(200);
        expect(res.body.data.tables).toEqual([{ key: "orders" }]);
    });
});

describe("GET /integrity/:table/tamper", () => {
    it("returns the tampered feed with paging", async () => {
        const res = await send("get", "/api/v1/integrity/orders/tamper?page=1&limit=1&customer=7", { bearer: bearer() });
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ total: 2, limit: 1, rowsScanned: 20 });
        expect(res.body.data.rows).toHaveLength(1);
        expect((IntegrityModel.sweepTampered as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({ customer: "7" });
    });

    it("400 for an invalid date range", async () => {
        const res = await send("get", "/api/v1/integrity/orders/tamper?from=2026-02-01&to=2026-01-01", { bearer: bearer() });
        expect(res.status).toBe(400);
    });

    it("400 for an unparseable date", async () => {
        expect((await send("get", "/api/v1/integrity/orders/tamper?from=zzz", { bearer: bearer() })).status).toBe(400);
    });
});

describe("GET /integrity/:table/filter-options", () => {
    it("returns options", async () => {
        vi.spyOn(IntegrityModel, "getTableConfig").mockReturnValue({ ...cfg, enums: { s: { column: "S" } } } as never);
        vi.spyOn(IntegrityModel, "getFilterOptions").mockResolvedValue({ s: [{ value: "A", label: "A" }] });
        const res = await send("get", "/api/v1/integrity/orders/filter-options", { bearer: bearer() });
        expect(res.status).toBe(200);
        expect(res.body.data.options.s).toHaveLength(1);
    });
});

describe("GET /integrity/:table/browse", () => {
    it("annotates rows with verdicts", async () => {
        verifyFn.mockResolvedValue(false);
        const res = await send("get", "/api/v1/integrity/orders/browse", { bearer: bearer() });
        expect(res.status).toBe(200);
        expect(res.body.data.rows[0]).toMatchObject({ id: 1, integrity: "TAMPERED" });
        expect(res.body.data.tamperedInScope).toBe(2);
    });
});

describe("GET /integrity/:table/export", () => {
    it("defaults to tamper mode", async () => {
        const res = await send("get", "/api/v1/integrity/orders/export", { bearer: bearer() });
        expect(res.status).toBe(200);
        expect(res.body.data.mode).toBe("tamper");
    });

    it("supports mode=all", async () => {
        const res = await send("get", "/api/v1/integrity/orders/export?mode=all", { bearer: bearer() });
        expect(res.body.data.mode).toBe("all");
        expect(res.body.data.total).toBe(1);
    });

    it("any other mode value is treated as tamper", async () => {
        const res = await send("get", "/api/v1/integrity/orders/export?mode=bogus", { bearer: bearer() });
        expect(res.body.data.mode).toBe("tamper");
    });
});

describe("POST /integrity/:table/rescan", () => {
    it("forces a fresh sweep taking scope from the body", async () => {
        await send("get", "/api/v1/integrity/orders/tamper", { bearer: bearer() });
        const sweep = IntegrityModel.sweepTampered as ReturnType<typeof vi.fn>;
        expect(sweep).toHaveBeenCalledTimes(1);
        const res = await send("post", "/api/v1/integrity/orders/rescan", { bearer: bearer(), body: { customer: "9", limit: 1 } });
        expect(res.status).toBe(200);
        expect(res.body.data.limit).toBe(1);
        expect(sweep).toHaveBeenCalledTimes(2);
        expect(sweep.mock.calls[1][1]).toMatchObject({ customer: "9" });
    });

    it("rescans the same scope twice without reusing the cache", async () => {
        const sweep = IntegrityModel.sweepTampered as ReturnType<typeof vi.fn>;
        await send("post", "/api/v1/integrity/orders/rescan", { bearer: bearer(), body: {} });
        await send("post", "/api/v1/integrity/orders/rescan", { bearer: bearer() });
        expect(sweep).toHaveBeenCalledTimes(2);
    });
});

describe("GET /integrity/stream pre-flight", () => {
    it("400 for a table that does not exist", async () => {
        const res = await send("get", "/api/v1/integrity/stream?table=nope", { bearer: bearer() });
        expect(res.status).toBe(400);
    });

    it("401 for a token without a session", async () => {
        expect((await send("get", "/api/v1/integrity/stream?table=orders")).status).toBe(401);
    });
});
