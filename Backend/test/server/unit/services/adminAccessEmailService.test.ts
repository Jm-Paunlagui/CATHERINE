import fs from "fs";

import AdminAccessEmailService from "../../../../src/services/AdminAccessEmailService";
import AdminModel from "../../../../src/models/admin.model";
import UserModel from "../../../../src/models/user.model";
import SharedTransporter from "../../../../src/services/email/SharedTransporter";
import { AppError } from "../../../../src/constants/errors";
import { logger } from "../../../../src/utils/logger";

const sendMail = vi.fn();
const saved: Record<string, string | undefined> = {};
const mockAdmin = (row: unknown) => vi.spyOn(AdminModel, "findByUsername").mockResolvedValue(row as never);
const mockUser = (row: unknown) => vi.spyOn(UserModel, "findByUsername").mockResolvedValue(row as never);
const rejects = async (p: Promise<unknown>) => (await p.then(() => null, (e) => e)) as any;

beforeEach(() => {
    saved.FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL;
    sendMail.mockReset().mockResolvedValue({});
    vi.spyOn(SharedTransporter, "getTransporter").mockReturnValue({ sendMail } as never);
    vi.spyOn(SharedTransporter, "getDefaultFrom").mockReturnValue("from@x.test");
    for (const lvl of ["info", "warning"] as const) vi.spyOn(logger, lvl).mockImplementation(() => undefined as never);
});
afterEach(() => {
    vi.restoreAllMocks();
    if (saved.FRONTEND_BASE_URL === undefined) delete process.env.FRONTEND_BASE_URL; else process.env.FRONTEND_BASE_URL = saved.FRONTEND_BASE_URL;
});

describe("profileContactFor", () => {
    it("prefers the admin record's address", async () => {
        mockAdmin({ EMAIL: "admin@x.test" });
        const user = mockUser(null);
        expect(await AdminAccessEmailService.profileContactFor("bob")).toEqual({ address: "admin@x.test", conflict: false });
        expect(user).not.toHaveBeenCalled();
    });
    it("falls back to the user record, then to null", async () => {
        mockAdmin(null);
        mockUser({ EMAIL: "user@x.test" });
        expect((await AdminAccessEmailService.profileContactFor("bob")).address).toBe("user@x.test");
        mockUser(null);
        expect((await AdminAccessEmailService.profileContactFor("bob")).address).toBeNull();
    });
});

describe("resolveRecipient", () => {
    it("uses the profile address and masks it as the hint", async () => {
        mockAdmin({ EMAIL: "alice@x.test" });
        expect(await AdminAccessEmailService.resolveRecipient("alice", undefined)).toEqual({ address: "alice@x.test", source: "PROFILE", hint: "a***@x.test" });
        expect(await AdminAccessEmailService.resolveRecipient("alice", "   ")).toMatchObject({ source: "PROFILE" });
    });
    it("refuses an override when an address is already on file (no redirecting a reset)", async () => {
        mockAdmin({ EMAIL: "alice@x.test" });
        const err = await rejects(AdminAccessEmailService.resolveRecipient("alice", "evil@x.test"));
        expect(err).toBeInstanceOf(AppError);
        expect(err.statusCode).toBe(400);
        expect(logger.warning).toHaveBeenCalled();
    });
    it("treats a non-string override object as present", async () => {
        mockAdmin({ EMAIL: "alice@x.test" });
        expect((await rejects(AdminAccessEmailService.resolveRecipient("alice", { a: 1 }))).statusCode).toBe(400);
    });
    it("requires an override when there is no address on file", async () => {
        mockAdmin(null); mockUser(null);
        expect((await rejects(AdminAccessEmailService.resolveRecipient("bob", null))).statusCode).toBe(422);
    });
    it("accepts a valid single override and trims it", async () => {
        mockAdmin(null); mockUser(null);
        expect(await AdminAccessEmailService.resolveRecipient("bob", "  new@x.test ")).toEqual({ address: "new@x.test", source: "OVERRIDE", hint: "n***@x.test" });
    });
    it.each(["a@x.test, b@x.test", "not-an-email", "x@y"])("rejects an invalid override %j", async (bad) => {
        mockAdmin(null); mockUser(null);
        expect((await rejects(AdminAccessEmailService.resolveRecipient("bob", bad))).statusCode).toBe(400);
    });
    it("maps lookup failures to 503", async () => {
        vi.spyOn(AdminModel, "findByUsername").mockRejectedValue(new Error("db down"));
        expect((await rejects(AdminAccessEmailService.resolveRecipient("bob", null))).statusCode).toBe(503);
        vi.spyOn(AdminModel, "findByUsername").mockRejectedValue("plain");
        expect((await rejects(AdminAccessEmailService.resolveRecipient("bob", null))).statusCode).toBe(503);
    });
});

describe("_buildVars / rendering", () => {
    const args = { username: "bob", role: "SUPER_ADMIN", tempPassword: "Pw<1>", expiresAt: Date.UTC(2026, 0, 2, 3, 4, 5), kind: "granted" as const };

    it("builds granted copy with the role label and a sign-in URL", () => {
        process.env.FRONTEND_BASE_URL = "https://app.test/";
        const v = AdminAccessEmailService._buildVars(args);
        expect(v.badge).toBe("Access granted");
        expect(v.intro).toContain("Super Admin");
        expect(v.signInUrl).toBe("https://app.test/auth");
        expect(v.signInLabel).toBe("https://app.test/auth");
        expect(v.expiresAtLabel).toMatch(/UTC[+-]\d{2}:\d{2}$/);
    });
    it("builds reset copy, falls back to the raw role and a generic sign-in label", () => {
        delete process.env.FRONTEND_BASE_URL;
        const v = AdminAccessEmailService._buildVars({ ...args, kind: "reset", role: "CUSTOM" });
        expect(v.badge).toBe("Password reset");
        expect(v.subject).toMatch(/password was reset/);
        expect(v.roleLabel).toBe("CUSTOM");
        expect(v.signInUrl).toBe("");
        expect(v.signInLabel).toMatch(/sign-in page/);
    });
    it("_buildHtml escapes the temporary password and leaves unknown placeholders", () => {
        vi.spyOn(fs, "readFileSync").mockReturnValue("{{tempPassword}} {{unknown}} {{username}}");
        const html = AdminAccessEmailService._buildHtml(AdminAccessEmailService._buildVars({ ...args, username: "<x>" }));
        expect(html).toBe("Pw&lt;1&gt; {{unknown}} &lt;x&gt;");
    });
    it("_buildPlainText includes the robot note only when set", () => {
        const v = AdminAccessEmailService._buildVars(args);
        expect(AdminAccessEmailService._buildPlainText(v)).toContain("Temporary password:  Pw<1>");
        expect(AdminAccessEmailService._buildPlainText({ ...v, robotNote: "ROBOT-NOTE" })).toContain("ROBOT-NOTE");
        expect(AdminAccessEmailService._buildPlainText(v)).not.toContain("ROBOT-NOTE");
    });
    it("_logoAttachments needs both logos", () => {
        const exists = vi.spyOn(fs, "existsSync").mockReturnValueOnce(false);
        expect(AdminAccessEmailService._logoAttachments()).toEqual([]);
        exists.mockReturnValueOnce(true).mockReturnValueOnce(false);
        expect(AdminAccessEmailService._logoAttachments()).toEqual([]);
        exists.mockReturnValue(true);
        expect(AdminAccessEmailService._logoAttachments().map((a) => a.cid)).toEqual(["app-logo-light", "app-logo-dark"]);
    });
});

describe("sendTemporaryPassword", () => {
    const args = { to: "bob@x.test", source: "PROFILE" as const, username: "bob", role: "ADMIN", tempPassword: "Pw1", expiresAt: 1_700_000_000_000, kind: "reset" as const };

    it("delivers and logs success", async () => {
        expect(await AdminAccessEmailService.sendTemporaryPassword(args)).toEqual({ delivered: true });
        const mail = sendMail.mock.calls[0][0];
        expect(mail).toMatchObject({ from: "from@x.test", to: "bob@x.test" });
        expect(mail.html).not.toMatch(/\{\{\w+\}\}/);
        expect(logger.info).toHaveBeenCalledTimes(1);
    });
    it("reports a send error", async () => {
        sendMail.mockRejectedValue(new Error("550 rejected"));
        expect(await AdminAccessEmailService.sendTemporaryPassword(args)).toEqual({ delivered: false, reason: "send-error", cause: "550 rejected" });
        sendMail.mockRejectedValue("str");
        expect((await AdminAccessEmailService.sendTemporaryPassword(args)).cause).toBe("str");
    });
    it("reports an unexpected error such as a missing template", async () => {
        vi.spyOn(fs, "readFileSync").mockImplementation(() => { throw new Error("no template"); });
        expect(await AdminAccessEmailService.sendTemporaryPassword(args)).toEqual({ delivered: false, reason: "unexpected-error", cause: "no template" });
        vi.spyOn(fs, "readFileSync").mockImplementation(() => { throw "bare"; });
        expect((await AdminAccessEmailService.sendTemporaryPassword(args)).cause).toBe("bare");
        expect(sendMail).not.toHaveBeenCalled();
    });
});
