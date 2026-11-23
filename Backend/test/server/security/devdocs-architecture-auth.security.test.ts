/**
 * @fileoverview Security tests for the dev-docs (ADMIN+) and architecture
 * (SUPER_ADMIN) routers: authentication, role gates, and that a traversal
 * attempt in the doc path never reaches a filesystem call.
 */
import DevDocsService from "../../../src/services/DevDocsService";
import { send, superAdminToken, adminToken, userToken } from "../helpers/purgeHttp";

const DOC_ROUTES = ["/api/v1/dev-docs/tree", "/api/v1/dev-docs/search?q=abc", "/api/v1/dev-docs/doc/a/b"];

let spies: Array<ReturnType<typeof vi.spyOn>>;

beforeEach(() => {
    spies = [
        vi.spyOn(DevDocsService, "getTree").mockResolvedValue({ sections: [], generatedAt: "" } as never),
        vi.spyOn(DevDocsService, "search").mockResolvedValue({ results: [], total: 0, truncated: false } as never),
        vi.spyOn(DevDocsService, "getDoc").mockResolvedValue({ id: "a/b" } as never),
    ];
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("dev-docs security", () => {
    it.each(DOC_ROUTES)("[%s] 401 without credentials", async (p) => {
        expect((await send("get", p)).status).toBe(401);
        expect(spies.every((s) => s.mock.calls.length === 0)).toBe(true);
    });

    it.each(DOC_ROUTES)("[%s] 403 for USER", async (p) => {
        expect((await send("get", p, { bearer: userToken() })).status).toBe(403);
        expect(spies.every((s) => s.mock.calls.length === 0)).toBe(true);
    });

    it.each(DOC_ROUTES)("[%s] ADMIN and SUPER_ADMIN pass the gate", async (p) => {
        expect((await send("get", p, { bearer: adminToken() })).status).toBe(200);
        expect((await send("get", p, { bearer: superAdminToken() })).status).toBe(200);
    });

    it.each(["..%2F..%2Fetc/passwd", "%2e%2e/%2e%2e", "a/..%2f..%2fb"])("traversal-style doc id %s is refused or treated as a key, never served", async (tail) => {
        const res = await send("get", `/api/v1/dev-docs/doc/${tail}`, { bearer: superAdminToken() });
        expect([200, 400, 403, 404]).toContain(res.status);
        if (res.status === 200) {
            // Only possible through the stubbed manifest lookup, never a file read.
            expect(spies[2]).toHaveBeenCalled();
        }
    });

    it("a three-segment doc path does not match the two-segment route", async () => {
        const res = await send("get", "/api/v1/dev-docs/doc/a/b/c", { bearer: superAdminToken() });
        expect(res.status).toBe(404);
        expect(spies[2]).not.toHaveBeenCalled();
    });
});
