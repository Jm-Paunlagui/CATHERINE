/**
 * @fileoverview Security tests for /api/v1/integrity: SUPER_ADMIN only on every
 * route, and the :table path parameter is a pure allow-list key that can never
 * reach SQL or the prototype chain.
 */
import IntegrityModel from "../../../src/models/integrity.model";
import { registry } from "../../../src/middleware/cache";
import { send, superAdminToken, adminToken, userToken } from "../helpers/purgeHttp";

const ROUTES: Array<[string, "get" | "post", string]> = [
    ["GET /tables", "get", "/api/v1/integrity/tables"],
    ["GET /stream", "get", "/api/v1/integrity/stream?table=orders"],
    ["GET /:t/tamper", "get", "/api/v1/integrity/orders/tamper"],
    ["GET /:t/filter-options", "get", "/api/v1/integrity/orders/filter-options"],
    ["GET /:t/browse", "get", "/api/v1/integrity/orders/browse"],
    ["GET /:t/export", "get", "/api/v1/integrity/orders/export"],
    ["POST /:t/rescan", "post", "/api/v1/integrity/orders/rescan"],
];

let sweep: ReturnType<typeof vi.spyOn>;
let listPage: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    registry.resolve("integrity").flush();
    sweep = vi.spyOn(IntegrityModel, "sweepTampered").mockResolvedValue({ tampered: [], rowsScanned: 0, truncated: false });
    listPage = vi.spyOn(IntegrityModel, "listPage").mockResolvedValue({ rows: [], total: 0 });
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("Integrity security: role gate", () => {
    it.each(ROUTES)("[%s] 401 without credentials", async (_n, m, p) => {
        expect((await send(m, p)).status).toBe(401);
    });

    it.each(ROUTES)("[%s] 403 for ADMIN and USER", async (_n, m, p) => {
        expect((await send(m, p, { bearer: adminToken() })).status).toBe(403);
        expect((await send(m, p, { bearer: userToken() })).status).toBe(403);
        expect(sweep).not.toHaveBeenCalled();
        expect(listPage).not.toHaveBeenCalled();
    });

    it.each(ROUTES)("[%s] rejects a forged token", async (_n, m, p) => {
        expect([401, 403]).toContain((await send(m, p, { bearer: "a.b.c" })).status);
    });
});

describe("Integrity security: injected :table", () => {
    const PAYLOADS = [
        "nope",
        "__proto__",
        "constructor",
        "hasOwnProperty",
        "orders%27%3B%20DROP%20TABLE%20T_ADMINS_DEV%3B--",
        "T_ADMINS_DEV",
        "orders%20OR%201%3D1",
        "%24where",
    ];

    it.each(PAYLOADS)("tamper/browse/export/filter-options/rescan reject %s with 400 and never query (400, or 403 from the security filter)", async (t) => {
        for (const [m, tail] of [
            ["get", "tamper"],
            ["get", "browse"],
            ["get", "export"],
            ["get", "filter-options"],
            ["post", "rescan"],
        ] as const) {
            const res = await send(m, `/api/v1/integrity/${t}/${tail}`, { bearer: superAdminToken() });
            expect([400, 403]).toContain(res.status);
        }
        expect(sweep).not.toHaveBeenCalled();
        expect(listPage).not.toHaveBeenCalled();
    });

    it("an unknown error does not echo the injected key back", async () => {
        const res = await send("get", "/api/v1/integrity/zzINJECTEDzz/tamper", { bearer: superAdminToken() });
        expect(JSON.stringify(res.body)).not.toContain("zzINJECTEDzz");
    });
});

describe("Integrity security: filter smuggling", () => {
    beforeEach(() => {
        vi.spyOn(IntegrityModel, "getTableConfig").mockImplementation(((k: string) =>
            k === "orders"
                ? { key: "orders", pk: "ID", filters: { customer: "C" }, verifyFn: async () => true, live: true }
                : null) as never);
    });

    it("drops operator-style and over-long filter keys before they reach the model", async () => {
        const q = "customer=7&%24ne=1&a%27b=2&" + "k".repeat(60) + "=3";
        const res = await send("get", `/api/v1/integrity/orders/tamper?${q}`, { bearer: superAdminToken() });
        expect(res.status).toBe(200);
        const filters = sweep.mock.calls[0][1] as Record<string, unknown>;
        expect(Object.keys(filters).sort()).toEqual(["customer", "from", "to"]);
    });

    it("object-valued filter params (customer[$ne]=1) are ignored", async () => {
        const res = await send("get", "/api/v1/integrity/orders/tamper?customer[$ne]=1", { bearer: superAdminToken() });
        expect(res.status).toBe(200);
        expect(Object.keys(sweep.mock.calls[0][1] as object).sort()).toEqual(["from", "to"]);
    });
});
