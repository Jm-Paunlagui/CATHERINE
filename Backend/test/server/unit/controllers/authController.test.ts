"use strict";

/**
 * @fileoverview AuthController cookies and status handling with AuthService faked.
 * Security: refresh reads ONLY the signed cookie (CWE-294); logout clears both cookies.
 */

import type { Request, Response } from "express";
import AuthController from "../../../../src/controllers/AuthControllers";
import AuthService from "../../../../src/services/AuthService";
import { AppError, AUTH_ERRORS } from "../../../../src/constants/errors";

function fakeRes() {
    const res: any = { statusCode: 0, body: undefined, cookies: [] as any[], cleared: [] as any[] };
    res.status = (c: number) => ((res.statusCode = c), res);
    res.json = (b: unknown) => ((res.body = b), res);
    res.cookie = (n: string, v: string, o: unknown) => res.cookies.push([n, v, o]);
    res.clearCookie = (n: string, o: unknown) => res.cleared.push([n, o]);
    return res as Response & { statusCode: number; body: any; cookies: any[]; cleared: any[] };
}

async function run(handler: any, req: Partial<Request>) {
    const res = fakeRes();
    const err = await new Promise<unknown>((resolve) => {
        handler({ body: {}, ...req }, res, (e?: unknown) => resolve(e));
        setTimeout(() => resolve(undefined), 0);
    });
    return { res, err: err as AppError | undefined };
}

const tokens = { user: { username: "u" }, accessToken: "AT", refreshToken: "RT", refreshRecord: {} as never };

describe("AuthController", () => {
    beforeEach(() => {
        vi.spyOn(AuthService, "accessCookieOptions").mockReturnValue({ httpOnly: true, path: "/" });
        vi.spyOn(AuthService, "refreshCookieOptions").mockReturnValue({ httpOnly: true, path: "/api/v1/auth/refresh" });
    });
    afterEach(() => vi.restoreAllMocks());

    it("login sets both cookies and returns only the user (no tokens in the body)", async () => {
        const login = vi.spyOn(AuthService, "login").mockResolvedValue(tokens);
        const { res } = await run(AuthController.login, { body: { userId: "u", password: "p" } });
        expect(login).toHaveBeenCalledWith("u", "p");
        expect(res.cookies.map((c) => c[0])).toEqual([AuthService.COOKIE_NAMES.ACCESS, AuthService.COOKIE_NAMES.REFRESH]);
        expect(JSON.stringify(res.body)).not.toContain("AT");
        expect(res.body.data).toEqual({ user: tokens.user });
    });

    it("login failure reaches next() and sets no cookie", async () => {
        vi.spyOn(AuthService, "login").mockRejectedValue(new AppError("nope", 401));
        const { res, err } = await run(AuthController.login, { body: { userId: "u", password: "x" } });
        expect(err?.statusCode).toBe(401);
        expect(res.cookies).toEqual([]);
    });

    describe("refresh", () => {
        it.each([
            ["no signedCookies at all", {}],
            ["empty signedCookies", { signedCookies: {} }],
            ["tampered cookie (false)", { signedCookies: { [AuthService.COOKIE_NAMES.REFRESH]: false } }],
        ])("%s -> 401 REFRESH_TOKEN_MISSING and the service is never reached", async (_n, req) => {
            const refresh = vi.spyOn(AuthService, "refresh");
            const { err } = await run(AuthController.refresh, req as never);
            expect(err?.statusCode).toBe(401);
            expect(err?.message).toBe(AUTH_ERRORS.REFRESH_TOKEN_MISSING);
            expect(refresh).not.toHaveBeenCalled();
        });

        it("ignores an Authorization header and a plain (unsigned) cookie", async () => {
            const refresh = vi.spyOn(AuthService, "refresh");
            const { err } = await run(AuthController.refresh, {
                headers: { authorization: "Bearer RT" }, cookies: { [AuthService.COOKIE_NAMES.REFRESH]: "RT" },
            } as never);
            expect(err?.statusCode).toBe(401);
            expect(refresh).not.toHaveBeenCalled();
        });

        it("rotates: new cookies are written from the service result", async () => {
            const refresh = vi.spyOn(AuthService, "refresh").mockResolvedValue({ ...tokens, refreshToken: "RT2" });
            const { res } = await run(AuthController.refresh, { signedCookies: { [AuthService.COOKIE_NAMES.REFRESH]: "RT" } } as never);
            expect(refresh).toHaveBeenCalledWith("RT");
            expect(res.cookies[1][1]).toBe("RT2");
            expect(res.statusCode).toBe(200);
        });
    });

    it("logout revokes via the service then clears both cookies on their original paths", async () => {
        const logout = vi.spyOn(AuthService, "logout").mockResolvedValue();
        const { res } = await run(AuthController.logout, { user: { userId: "u" } as never });
        expect(logout).toHaveBeenCalledWith({ userId: "u" });
        expect(res.cleared).toEqual([
            [AuthService.COOKIE_NAMES.ACCESS, { path: "/" }],
            [AuthService.COOKIE_NAMES.REFRESH, { path: "/api/v1/auth/refresh" }],
        ]);
    });

    it("me returns the refreshed profile", async () => {
        vi.spyOn(AuthService, "getProfile").mockResolvedValue({ username: "u" });
        const { res } = await run(AuthController.me, { user: { userId: "u" } as never });
        expect(res.body.data).toEqual({ username: "u" });
    });

    it("changePassword needs an authenticated user (401) and otherwise reissues cookies", async () => {
        const change = vi.spyOn(AuthService, "changePassword").mockResolvedValue(tokens);
        const unauth = await run(AuthController.changePassword, { body: { currentPassword: "a", newPassword: "b" } });
        expect(unauth.err?.statusCode).toBe(401);
        expect(change).not.toHaveBeenCalled();
        const { res } = await run(AuthController.changePassword, { body: { currentPassword: "a", newPassword: "b" }, user: { userId: "u" } as never });
        expect(change).toHaveBeenCalledWith("u", "a", "b");
        expect(res.cookies).toHaveLength(2);
    });
});
