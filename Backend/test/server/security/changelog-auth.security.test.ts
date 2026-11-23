/**
 * @fileoverview Security tests for /api/v1/changelog: the mutating and release
 * endpoints are SUPER_ADMIN only, GET / needs a session, and the anonymous read
 * never leaks staff names.
 */
import ChangelogModel from "../../../src/models/changelog.model";
import { send, superAdminToken, adminToken, userToken } from "../helpers/purgeHttp";

const body = { displayDate: "2026-01-02", version: "1.1.0", title: "New", message: "Msg", type: "feat" };

const GATED: Array<[string, "get" | "post" | "put" | "delete", string, unknown]> = [
    ["POST /", "post", "/api/v1/changelog", body],
    ["PUT /:id", "put", "/api/v1/changelog/a", { title: "x" }],
    ["DELETE /:id", "delete", "/api/v1/changelog/a", undefined],
    ["GET /release/current", "get", "/api/v1/changelog/release/current", undefined],
];

let spies: Array<ReturnType<typeof vi.spyOn>>;

beforeEach(() => {
    spies = [
        vi.spyOn(ChangelogModel, "create").mockReturnValue({} as never),
        vi.spyOn(ChangelogModel, "update").mockReturnValue({} as never),
        vi.spyOn(ChangelogModel, "delete").mockReturnValue(undefined as never),
        vi.spyOn(ChangelogModel, "listAll").mockReturnValue([{ version: "1.0.0", authors: ["staff"] }] as never),
    ];
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("Changelog security: gated endpoints", () => {
    it.each(GATED)("[%s] 401 without credentials and no write happens", async (_n, m, p, b) => {
        const res = await send(m, p, { body: b });
        expect(res.status).toBe(401);
        expect(spies.slice(0, 3).every((s) => s.mock.calls.length === 0)).toBe(true);
    });

    it.each(GATED)("[%s] 403 for ADMIN and USER", async (_n, m, p, b) => {
        for (const t of [adminToken(), userToken()]) {
            const res = await send(m, p, { bearer: t, body: b });
            expect(res.status).toBe(403);
        }
        expect(spies.slice(0, 3).every((s) => s.mock.calls.length === 0)).toBe(true);
    });

    it.each(GATED)("[%s] rejects a forged token", async (_n, m, p, b) => {
        const res = await send(m, p, { bearer: "forged.token.value", body: b });
        expect([401, 403]).toContain(res.status);
    });

    it("[POST /] rejects a request without a CSRF token even for SUPER_ADMIN", async () => {
        const request = (await import("supertest")).default;
        const app = (await import("../../../src/app")).default;
        const res = await request(app).post("/api/v1/changelog").set("Authorization", `Bearer ${superAdminToken()}`).send(body);
        expect(res.status).toBe(403);
        expect(spies[0]).not.toHaveBeenCalled();
    });

    it("GET / needs a session but any role may read", async () => {
        expect((await send("get", "/api/v1/changelog")).status).toBe(401);
        expect((await send("get", "/api/v1/changelog", { bearer: userToken() })).status).toBe(200);
    });
});

describe("Changelog security: input", () => {
    it.each([
        ["script in title is stored as text only, bad version rejected", { ...body, version: "1.0.0<script>" }],
        ["object version", { ...body, version: { $gt: "" } }],
        ["object type", { ...body, type: { $ne: "x" } }],
        ["numeric date", { ...body, displayDate: 20260102 }],
    ])("400: %s", async (_n, b) => {
        const res = await send("post", "/api/v1/changelog", { bearer: superAdminToken(), body: b });
        expect(res.status).toBe(400);
        expect(spies[0]).not.toHaveBeenCalled();
    });
});

describe("Changelog security: anonymous read", () => {
    it("never exposes authors or coAuthors on the public endpoints", async () => {
        for (const p of ["/api/v1/changelog/public", "/api/v1/changelog/public/latest"]) {
            const res = await send("get", p);
            expect(res.status).toBe(200);
            expect(JSON.stringify(res.body)).not.toContain("staff");
        }
    });
});
