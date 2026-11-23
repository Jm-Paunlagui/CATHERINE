/**
 * @fileoverview HTTP integration tests for /api/v1/changelog and the release
 * train endpoint. Real app, real ChangelogService/ReleaseService validation;
 * only the encrypted file model is stubbed.
 */
import ChangelogModel from "../../../../src/models/changelog.model";
import { send, superAdminToken } from "../../helpers/purgeHttp";

const entries = [
    { id: "a", version: "1.0.0", title: "T", authors: ["secret-name"], coAuthors: ["co-name"] },
    { id: "b", version: "0.9.0", title: "U", authors: ["x"] },
];

const body = { displayDate: "2026-01-02", version: "1.1.0", title: "New", message: "Msg", type: "feat" };

beforeEach(() => {
    vi.spyOn(ChangelogModel, "listAll").mockReturnValue(entries as never);
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("GET /changelog/public*", () => {
    it("lists entries with author names stripped, without authentication", async () => {
        const res = await send("get", "/api/v1/changelog/public");
        expect(res.status).toBe(200);
        expect(res.body.data).toHaveLength(2);
        expect(JSON.stringify(res.body)).not.toContain("secret-name");
        expect(JSON.stringify(res.body)).not.toContain("co-name");
    });

    it("latest returns the newest public entry", async () => {
        const res = await send("get", "/api/v1/changelog/public/latest");
        expect(res.status).toBe(200);
        expect(res.body.data).toEqual({ id: "a", version: "1.0.0", title: "T" });
    });

    it("latest returns data null on an empty store", async () => {
        vi.spyOn(ChangelogModel, "listAll").mockReturnValue([] as never);
        const res = await send("get", "/api/v1/changelog/public/latest");
        expect(res.status).toBe(200);
        expect(res.body.data).toBeNull();
    });
});

describe("GET /changelog (authenticated)", () => {
    it("returns the full record, including authors, to a signed-in caller", async () => {
        const res = await send("get", "/api/v1/changelog", { bearer: superAdminToken() });
        expect(res.status).toBe(200);
        expect(res.body.data[0].authors).toEqual(["secret-name"]);
    });

    it("401 without credentials", async () => {
        expect((await send("get", "/api/v1/changelog")).status).toBe(401);
    });
});

describe("mutations (SUPER_ADMIN)", () => {
    it("POST creates and answers 201", async () => {
        const create = vi.spyOn(ChangelogModel, "create").mockReturnValue({ id: "n", ...body } as never);
        const res = await send("post", "/api/v1/changelog", { bearer: superAdminToken(), body });
        expect(res.status).toBe(201);
        expect(res.body.data.id).toBe("n");
        expect(create).toHaveBeenCalled();
    });

    it("POST with an invalid version answers 400 and writes nothing", async () => {
        const create = vi.spyOn(ChangelogModel, "create");
        const res = await send("post", "/api/v1/changelog", { bearer: superAdminToken(), body: { ...body, version: "v1" } });
        expect(res.status).toBe(400);
        expect(create).not.toHaveBeenCalled();
    });

    it("POST with missing fields answers 400", async () => {
        const res = await send("post", "/api/v1/changelog", { bearer: superAdminToken(), body: { title: "x" } });
        expect(res.status).toBe(400);
    });

    it("PUT updates a partial body", async () => {
        const upd = vi.spyOn(ChangelogModel, "update").mockReturnValue({ id: "a", title: "Z" } as never);
        const res = await send("put", "/api/v1/changelog/a", { bearer: superAdminToken(), body: { title: "Z" } });
        expect(res.status).toBe(200);
        expect(upd).toHaveBeenCalledWith("a", { title: "Z" });
    });

    it("PUT with an invalid type answers 400", async () => {
        const res = await send("put", "/api/v1/changelog/a", { bearer: superAdminToken(), body: { type: "hax" } });
        expect(res.status).toBe(400);
    });

    it("DELETE removes the entry", async () => {
        const del = vi.spyOn(ChangelogModel, "delete").mockReturnValue(undefined as never);
        const res = await send("delete", "/api/v1/changelog/a", { bearer: superAdminToken() });
        expect(res.status).toBe(200);
        expect(res.body.data).toBeNull();
        expect(del).toHaveBeenCalledWith("a");
    });
});

describe("GET /changelog/release/current", () => {
    it("returns the derived release state", async () => {
        vi.spyOn(ChangelogModel, "listAll").mockReturnValue([{ version: "2.0.0-rc.1" }] as never);
        const res = await send("get", "/api/v1/changelog/release/current", { bearer: superAdminToken() });
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ stage: "rc", nextActions: ["cut"] });
    });
});
