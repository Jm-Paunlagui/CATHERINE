/**
 * @fileoverview HTTP integration tests for /api/v1/architecture and
 * /api/v1/dev-docs: response shape, no-store headers and role gates.
 * DevDocsService is stubbed; the architecture maps are the real models.
 */
import DevDocsService from "../../../../src/services/DevDocsService";
import ArchitectureService from "../../../../src/services/ArchitectureService";
import { send, superAdminToken, adminToken, userToken } from "../../helpers/purgeHttp";

const doc = {
    id: "guides/intro",
    title: "Intro",
    markdown: "# hi",
    sizeBytes: 4,
    docCommittedAt: "2026-01-01",
    sourceCommittedAt: null,
    freshness: "CURRENT",
    internalPath: "/etc/secret",
};

afterEach(() => {
    vi.restoreAllMocks();
    ArchitectureService.invalidate();
});

describe("GET /architecture", () => {
    it.each(["/api/v1/architecture", "/api/v1/architecture/runtime"])("%s serves the validated map with no-store", async (p) => {
        const res = await send("get", p, { bearer: superAdminToken() });
        expect(res.status).toBe(200);
        expect(Object.keys(res.body.data).sort()).toEqual(["edgeKinds", "edges", "flows", "layers", "layout", "meta", "nodes"]);
        expect(res.headers["cache-control"]).toBe("private, no-store, max-age=0");
        expect(res.headers.pragma).toBe("no-cache");
    });

    it("500 with a generic message when the map cannot be built", async () => {
        vi.spyOn(ArchitectureService, "getMap").mockImplementation(() => {
            throw new (require("../../../../src/constants/errors").AppError)("Map unavailable", 500);
        });
        const res = await send("get", "/api/v1/architecture", { bearer: superAdminToken() });
        expect(res.status).toBe(500);
    });

    it("is SUPER_ADMIN only", async () => {
        expect((await send("get", "/api/v1/architecture")).status).toBe(401);
        expect((await send("get", "/api/v1/architecture", { bearer: adminToken() })).status).toBe(403);
        expect((await send("get", "/api/v1/architecture/runtime", { bearer: userToken() })).status).toBe(403);
    });
});

describe("GET /dev-docs", () => {
    it("tree projects only public fields", async () => {
        vi.spyOn(DevDocsService, "getTree").mockResolvedValue({
            sections: [{ name: "guides", docs: [{ ...doc, absPath: "/x" }] }],
            generatedAt: "now",
        } as never);
        const res = await send("get", "/api/v1/dev-docs/tree", { bearer: adminToken() });
        expect(res.status).toBe(200);
        expect(res.body.data.sections[0].docs[0]).toEqual({
            id: "guides/intro",
            title: "Intro",
            sizeBytes: 4,
            docCommittedAt: "2026-01-01",
            sourceCommittedAt: null,
            freshness: "CURRENT",
        });
        expect(res.headers["cache-control"]).toContain("no-store");
    });

    it("doc rejoins the two segments into the manifest key and projects fields", async () => {
        const get = vi.spyOn(DevDocsService, "getDoc").mockResolvedValue(doc as never);
        const res = await send("get", "/api/v1/dev-docs/doc/guides/intro", { bearer: superAdminToken() });
        expect(res.status).toBe(200);
        expect(get).toHaveBeenCalledWith("guides/intro");
        expect(res.body.data.markdown).toBe("# hi");
        expect(JSON.stringify(res.body)).not.toContain("/etc/secret");
    });

    it("doc with an unknown key is a 404 from the service", async () => {
        const { AppError } = require("../../../../src/constants/errors");
        vi.spyOn(DevDocsService, "getDoc").mockRejectedValue(new AppError("Not found", 404));
        const res = await send("get", "/api/v1/dev-docs/doc/guides/missing", { bearer: adminToken() });
        expect(res.status).toBe(404);
    });

    it("search passes q and returns only projected hits", async () => {
        const search = vi.spyOn(DevDocsService, "search").mockResolvedValue({
            results: [{ id: "a/b", title: "T", heading: "H", snippet: "s", line: 3, secret: "x" }],
            total: 5,
            truncated: true,
        } as never);
        const res = await send("get", "/api/v1/dev-docs/search?q=token", { bearer: adminToken() });
        expect(res.status).toBe(200);
        expect(search).toHaveBeenCalledWith("token");
        expect(res.body.data).toEqual({
            results: [{ id: "a/b", title: "T", heading: "H", snippet: "s", line: 3 }],
            total: 5,
            truncated: true,
        });
    });
});
