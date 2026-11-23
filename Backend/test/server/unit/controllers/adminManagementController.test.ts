"use strict";

/**
 * @fileoverview AdminManagementController: thin HTTP layer. The service is
 * faked; request parsing, caller derivation, status codes and the 401 fail-closed
 * on a missing actor id are real.
 */

import type { Request, Response } from "express";
import AdminManagementController from "../../../../src/controllers/AdminManagementController";
import AdminManagementService from "../../../../src/services/AdminManagementService";
import { defaultSecurityFilter } from "../../../../src/middleware/security/SecurityFilterMiddleware";
import { AppError, ADMIN_ERRORS, AUTH_ERRORS } from "../../../../src/constants/errors";

function fakeRes() {
    const res: any = { statusCode: 0, body: undefined, headers: {}, sent: undefined };
    res.status = (c: number) => ((res.statusCode = c), res);
    res.json = (b: unknown) => ((res.body = b), res);
    res.set = (h: Record<string, string>) => ((res.headers = h), res);
    res.send = (b: unknown) => ((res.sent = b), res);
    return res as Response & { statusCode: number; body: any; headers: Record<string, string>; sent: unknown };
}

/** Runs a catchAsync handler and resolves with whatever reached next(). */
async function run(handler: any, req: Partial<Request>) {
    const res = fakeRes();
    const err = await new Promise<unknown>((resolve) => {
        handler({ body: {}, params: {}, query: {}, ...req }, res, (e?: unknown) => resolve(e));
        setImmediate(() => resolve(undefined));
        // Allow microtasks to settle before the macrotask above wins.
    });
    await new Promise((r) => setTimeout(r, 0));
    return { res, err };
}

const USER = { userId: "root", id: 11, role: "SUPER_ADMIN" };

describe("AdminManagementController", () => {
    afterEach(() => vi.restoreAllMocks());

    it("search trims q, and defaults a missing q to empty (service decides)", async () => {
        const s = vi.spyOn(AdminManagementService, "searchAccounts").mockResolvedValue([{ username: "a" }]);
        const { res } = await run(AdminManagementController.search, { query: { q: "  ab " } });
        expect(s).toHaveBeenCalledWith("ab");
        expect(res.statusCode).toBe(200);
        await run(AdminManagementController.search, { query: {} });
        expect(s).toHaveBeenLastCalledWith("");
    });

    it("search forwards the service's 400 to next()", async () => {
        vi.spyOn(AdminManagementService, "searchAccounts").mockRejectedValue(new AppError("bad", 400));
        const { err } = await run(AdminManagementController.search, { query: { q: "" } });
        expect((err as AppError).statusCode).toBe(400);
    });

    it("list returns 200 with the admins", async () => {
        vi.spyOn(AdminManagementService, "listAdmins").mockResolvedValue([{ username: "a" }]);
        const { res } = await run(AdminManagementController.list, {});
        expect(res.body.data).toEqual([{ username: "a" }]);
    });

    it("create passes legacy fields RAW, derives the caller from the JWT and answers 201; flags null becomes undefined", async () => {
        const add = vi.spyOn(AdminManagementService, "addAdmin").mockResolvedValue({ username: "n" });
        const { res } = await run(AdminManagementController.create, {
            body: { username: "n", role: "USER", retainPassword: true, newPassword: "x", flags: null, overrideEmail: "a@b.test" },
            user: USER as never,
        });
        expect(res.statusCode).toBe(201);
        expect(add).toHaveBeenCalledWith({
            username: "n", role: "USER", caller: { username: "root", role: "SUPER_ADMIN" },
            overrideEmail: "a@b.test", retainPassword: true, newPassword: "x", flags: undefined,
        });
    });

    it("caller falls back to sub, then to an empty username when unauthenticated (service then refuses)", async () => {
        const add = vi.spyOn(AdminManagementService, "addAdmin").mockResolvedValue({});
        await run(AdminManagementController.create, { body: { flags: { isActive: "Y" } }, user: { sub: "subject", role: "ADMIN" } as never });
        expect(add.mock.calls[0][0].caller).toEqual({ username: "subject", role: "ADMIN" });
        expect(add.mock.calls[0][0].flags).toEqual({ isActive: "Y" });
        await run(AdminManagementController.create, {});
        expect(add.mock.calls[1][0].caller).toEqual({ username: "", role: undefined });
    });

    it.each([
        [true, true], [1, true], ["true", true], ["1", true],
        [false, false], ["false", false], [0, false], [undefined, false], ["yes", false],
    ])("update reads changePassword=%j as %s (string 'false' must not be truthy)", async (input, expected) => {
        const upd = vi.spyOn(AdminManagementService, "updateAdmin").mockResolvedValue({ username: "bob", role: "ADMIN" });
        const { res } = await run(AdminManagementController.update, {
            params: { username: "bob" }, body: { role: "ADMIN", changePassword: input, newPassword: undefined }, user: USER as never,
        });
        expect(upd.mock.calls[0][0].changePassword).toBe(expected);
        expect(res.statusCode).toBe(200);
    });

    it("resetPassword tolerates a missing body; resetSignature passes the caller", async () => {
        const rp = vi.spyOn(AdminManagementService, "resetPassword").mockResolvedValue({ username: "bob" });
        const rs = vi.spyOn(AdminManagementService, "resetSignature").mockResolvedValue({ username: "bob" });
        await run(AdminManagementController.resetPassword, { params: { username: "bob" }, body: undefined, user: USER as never });
        expect(rp).toHaveBeenCalledWith("bob", { overrideEmail: undefined, caller: { username: "root", role: "SUPER_ADMIN" } });
        await run(AdminManagementController.resetSignature, { params: { username: "bob" }, user: USER as never });
        expect(rs).toHaveBeenCalledWith("bob", { caller: { username: "root", role: "SUPER_ADMIN" } });
    });

    describe("unblockIp", () => {
        it.each(["", "not-an-ip", "999.1.1.1", "1.2.3.4; rm -rf /"])("rejects %j with 400 INVALID_IP and never calls the filter", async (ip) => {
            const unblock = vi.spyOn(defaultSecurityFilter, "unblockClusterWide").mockResolvedValue(true);
            const { err } = await run(AdminManagementController.unblockIp, { body: { ip }, user: USER as never });
            expect((err as AppError).statusCode).toBe(400);
            expect((err as AppError).message).toBe(ADMIN_ERRORS.INVALID_IP);
            expect(unblock).not.toHaveBeenCalled();
        });

        it("rejects a missing ip", async () => {
            const { err } = await run(AdminManagementController.unblockIp, { body: {} });
            expect((err as AppError).statusCode).toBe(400);
        });

        it("clears a literal IPv4/IPv6 and audits the actor, 'unknown' when there is none", async () => {
            const unblock = vi.spyOn(defaultSecurityFilter, "unblockClusterWide").mockResolvedValue(true);
            const { res } = await run(AdminManagementController.unblockIp, { body: { ip: " 10.0.0.9 " }, user: USER as never });
            expect(unblock).toHaveBeenCalledWith("10.0.0.9", "root");
            expect(res.body.data).toEqual({ ip: "10.0.0.9", cleared: true });
            await run(AdminManagementController.unblockIp, { body: { ip: "::1" } });
            expect(unblock).toHaveBeenLastCalledWith("::1", "unknown");
        });
    });

    describe("backup-bound actions", () => {
        it("remove and revoke bind the caller's username and numeric id", async () => {
            const del = vi.spyOn(AdminManagementService, "deleteAdmin").mockResolvedValue({ username: "bob" });
            const rev = vi.spyOn(AdminManagementService, "revokeAccess").mockResolvedValue({ username: "bob", isActive: "N" });
            await run(AdminManagementController.remove, { params: { username: "bob" }, body: { backupToken: "t" }, user: USER as never });
            expect(del).toHaveBeenCalledWith({ username: "bob", backupToken: "t", callerUsername: "root", callerId: 11 });
            await run(AdminManagementController.revoke, { params: { username: "bob" }, body: { backupToken: "t" }, user: USER as never });
            expect(rev).toHaveBeenCalledWith({ username: "bob", backupToken: "t", callerUsername: "root", callerId: 11 });
        });

        it("falls back to userId when no numeric id is on the token", async () => {
            const del = vi.spyOn(AdminManagementService, "deleteAdmin").mockResolvedValue({ username: "bob" });
            await run(AdminManagementController.remove, { params: { username: "bob" }, body: {}, user: { userId: "root" } as never });
            expect(del.mock.calls[0][0].callerId).toBe("root");
        });

        it.each(["remove", "revoke", "revokeBackup"] as const)("%s without an authenticated actor -> 401, service never called", async (name) => {
            const spies = [
                vi.spyOn(AdminManagementService, "deleteAdmin"),
                vi.spyOn(AdminManagementService, "revokeAccess"),
                vi.spyOn(AdminManagementService, "buildRevokeBackup"),
            ];
            const { err } = await run(AdminManagementController[name], { params: { username: "bob" }, body: {}, user: { role: "SUPER_ADMIN" } as never });
            expect((err as AppError).statusCode).toBe(401);
            expect((err as AppError).message).toBe(AUTH_ERRORS.AUTHENTICATION_REQUIRED);
            for (const s of spies) expect(s).not.toHaveBeenCalled();
        });

        it("revokeBackup streams the zip with the token headers and passes the request id (null when absent)", async () => {
            const build = vi.spyOn(AdminManagementService, "buildRevokeBackup").mockResolvedValue({
                zipBuffer: Buffer.from("zip"), filename: "b.zip", token: "tok", expiresAt: 123, totalRows: 1, tableCount: 1, rowCounts: {},
            });
            const { res } = await run(AdminManagementController.revokeBackup, { params: { username: "bob" }, user: USER as never, id: "req_1" } as never);
            expect(res.headers).toMatchObject({ "Content-Type": "application/zip", "X-Backup-Token": "tok", "X-Backup-Token-Expires-At": "123" });
            expect(res.headers["Content-Disposition"]).toBe('attachment; filename="b.zip"');
            expect(res.sent).toEqual(Buffer.from("zip"));
            expect(build).toHaveBeenCalledWith({ username: "bob", actorId: 11, requestId: "req_1" });
            await run(AdminManagementController.revokeBackup, { params: { username: "bob" }, user: USER as never });
            expect(build).toHaveBeenLastCalledWith({ username: "bob", actorId: 11, requestId: null });
        });
    });

    it("updatePermissions defaults missing flags to {} so the service validates", async () => {
        const up = vi.spyOn(AdminManagementService, "updatePermissions").mockResolvedValue({ username: "bob", flags: {} });
        await run(AdminManagementController.updatePermissions, { params: { username: "bob" }, body: {} });
        expect(up).toHaveBeenCalledWith({ username: "bob", flags: {} });
        await run(AdminManagementController.updatePermissions, { params: { username: "bob" }, body: { flags: { isActive: "N" } } });
        expect(up).toHaveBeenLastCalledWith({ username: "bob", flags: { isActive: "N" } });
    });
});
