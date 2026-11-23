"use strict";

/**
 * @fileoverview HTTP-level auth session lifecycle: REAL app, middleware chain,
 * AuthController, AuthService (JWT + registry + revocation). Persistence and
 * hashing edges are faked. Complements login/refresh/logout suites with the
 * signed-cookie rules and the logout -> access-token-dead guarantee.
 */

import request from "supertest";
import app from "../../../../src/app";
import AdminModel from "../../../../src/models/admin.model";
import UserModel from "../../../../src/models/user.model";
import AuthRefreshTokenModel from "../../../../src/models/auth.refresh.token.model";
import { CryptoVault } from "../../../../src/utils/encryption/CryptoVault";
import { loginLockout } from "../../../../src/middleware/authentication/LoginLockoutMiddleware";
import { refreshTokenRegistry } from "../../../../src/utils/auth/RefreshTokenRegistry";
import { revokedSessions } from "../../../../src/utils/auth/RevokedSessionSet";
import { AUTH_ERRORS } from "../../../../src/constants/errors";

const HASH = "$argon2id$v=19$m=8,t=1,p=1$c2FsdA$aGFzaA";
const adminRow = () => ({ ID: 3, USERNAME: "adm", PASSWORD: HASH, EMAIL: null, ROLE: "ADMIN", IS_ACTIVE: "Y", SYSSIGNATURE: "s" }) as never;

describe("auth session over HTTP", () => {
    let agent: ReturnType<typeof request.agent>;
    let csrf: string;

    beforeAll(async () => {
        agent = request.agent(app);
        csrf = (await agent.get("/api/v1/csrf/token")).body?.token;
    });

    beforeEach(() => {
        refreshTokenRegistry.clear();
        revokedSessions.clear();
        vi.spyOn(loginLockout, "checkAsync").mockResolvedValue({ locked: false });
        vi.spyOn(loginLockout, "recordFailureAsync").mockResolvedValue();
        vi.spyOn(loginLockout, "recordSuccessAsync").mockResolvedValue();
        vi.spyOn(AdminModel, "findByUsername").mockImplementation(async (u) => (u === "adm" ? adminRow() : null));
        vi.spyOn(UserModel, "findByUsername").mockResolvedValue(null);
        vi.spyOn(CryptoVault, "verifyRecord").mockResolvedValue(true);
        vi.spyOn(CryptoVault, "verifyAdminPassword").mockResolvedValue({ matched: true, newHash: null, expired: false } as never);
        vi.spyOn(CryptoVault, "adminNeedsRehash").mockReturnValue(false);
        vi.spyOn(AuthRefreshTokenModel, "insert").mockResolvedValue();
        vi.spyOn(AuthRefreshTokenModel, "purgeExpired").mockResolvedValue(0);
        vi.spyOn(AuthRefreshTokenModel, "rotate").mockResolvedValue({ outcome: "ok" });
        vi.spyOn(AuthRefreshTokenModel, "revokeFamily").mockResolvedValue(1);
    });
    afterEach(() => vi.restoreAllMocks());

    const post = (a: any, url: string, body: object = {}) => a.post(url).set("x-csrf-token", csrf).send(body);
    const cookieNames = (res: request.Response) => ((res.headers["set-cookie"] as unknown as string[]) ?? []).map((c) => c.split("=")[0]);

    it("login sets both signed httpOnly cookies, the refresh one path-scoped, and returns no token in the body", async () => {
        const res = await post(agent, "/api/v1/auth/login", { userId: "adm", password: "pw" });
        expect(res.status).toBe(200);
        expect(cookieNames(res)).toEqual(expect.arrayContaining(["app.access-token", "app.refresh-token"]));
        const cookies = res.headers["set-cookie"] as unknown as string[];
        const refresh = cookies.find((c) => c.startsWith("app.refresh-token"))!;
        expect(refresh).toMatch(/Path=\/api\/v1\/auth\/refresh/);
        expect(refresh).toMatch(/HttpOnly/);
        expect(JSON.stringify(res.body)).not.toMatch(/accessToken|refreshToken/);
    });

    it("refresh without any cookie -> 401 REFRESH_TOKEN_MISSING; an unsigned plain cookie is not accepted", async () => {
        const fresh = request.agent(app);
        const t = (await fresh.get("/api/v1/csrf/token")).body?.token;
        const none = await fresh.post("/api/v1/auth/refresh").set("x-csrf-token", t).send({});
        expect(none.status).toBe(401);
        expect(none.body.message).toBe(AUTH_ERRORS.REFRESH_TOKEN_MISSING);
        const plain = await fresh.post("/api/v1/auth/refresh").set("x-csrf-token", t).set("Cookie", "app.refresh-token=abc").send({});
        expect(plain.status).toBe(401);
    });

    it("login -> refresh rotates the cookie pair; logout then kills the replayed access token at once (440)", async () => {
        const a = request.agent(app);
        const token = (await a.get("/api/v1/csrf/token")).body?.token;
        const send = (url: string) => a.post(url).set("x-csrf-token", token).send({});
        const login = await a.post("/api/v1/auth/login").set("x-csrf-token", token).send({ userId: "adm", password: "pw" });
        expect(login.status).toBe(200);
        const accessCookie = (login.headers["set-cookie"] as unknown as string[]).find((c) => c.startsWith("app.access-token"))!.split(";")[0];

        const refreshed = await send("/api/v1/auth/refresh");
        expect(refreshed.status).toBe(200);
        expect(AuthRefreshTokenModel.rotate).toHaveBeenCalledTimes(1);

        expect((await a.get("/api/v1/auth/me")).status).toBe(200);
        const out = await send("/api/v1/auth/logout");
        expect(out.status).toBe(200);
        expect(cookieNames(out)).toEqual(expect.arrayContaining(["app.access-token", "app.refresh-token"]));
        expect(AuthRefreshTokenModel.revokeFamily).toHaveBeenCalled();

        const replay = await request(app).get("/api/v1/auth/me").set("Cookie", accessCookie);
        expect(replay.status).toBe(440);
    });

    it("wrong credentials -> 401 generic message, a lockout failure is recorded and no cookie is set", async () => {
        vi.mocked(CryptoVault.verifyAdminPassword).mockResolvedValue({ matched: false, expired: false } as never);
        const b = request.agent(app);
        const token = (await b.get("/api/v1/csrf/token")).body?.token;
        const res = await b.post("/api/v1/auth/login").set("x-csrf-token", token).send({ userId: "adm", password: "bad" });
        expect(res.status).toBe(401);
        expect(res.body.message).toBe(AUTH_ERRORS.INVALID_CREDENTIALS);
        expect(cookieNames(res)).not.toContain("app.access-token");
        expect(loginLockout.recordFailureAsync).toHaveBeenCalledWith("adm");
    });

    it("change-password is not reachable without authentication", async () => {
        const anon = request.agent(app);
        const token = (await anon.get("/api/v1/csrf/token")).body?.token;
        const res = await anon.patch("/api/v1/auth/change-password").set("x-csrf-token", token).send({ currentPassword: "a", newPassword: "b" });
        expect(res.status).toBe(401);
    });
});
