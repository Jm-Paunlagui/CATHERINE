import fs from "fs";

import BackupEmailService from "../../../../src/services/BackupEmailService";
import AdminModel from "../../../../src/models/admin.model";
import SharedTransporter from "../../../../src/services/email/SharedTransporter";
import { logger } from "../../../../src/utils/logger";

const sendMail = vi.fn();
const ENV_KEYS = ["BACKUP_EMAIL_ENABLED"];
const saved: Record<string, string | undefined> = {};
const admins = (rows: Record<string, unknown>[]) => vi.spyOn(AdminModel, "findAll").mockResolvedValue(rows as never);

beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    sendMail.mockReset().mockResolvedValue({ messageId: "m" });
    vi.spyOn(SharedTransporter, "getTransporter").mockReturnValue({ sendMail } as never);
    vi.spyOn(SharedTransporter, "getDefaultFrom").mockReturnValue("from@x.test");
    for (const lvl of ["info", "warning"] as const) vi.spyOn(logger, lvl).mockImplementation(() => undefined as never);
});
afterEach(() => {
    vi.restoreAllMocks();
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe("BackupEmailService.isEnabled", () => {
    it.each([[undefined, true], ["true", true], ["FALSE", false], ["false", false]])("BACKUP_EMAIL_ENABLED=%s -> %s", (v, expected) => {
        if (v === undefined) delete process.env.BACKUP_EMAIL_ENABLED; else process.env.BACKUP_EMAIL_ENABLED = v;
        expect(BackupEmailService.isEnabled()).toBe(expected);
    });
});

describe("_resolveRecipientEmails", () => {
    it("targets the acting admin plus active super admins, de-duplicated", async () => {
        admins([
            { ID: 1, ROLE: "ADMIN", EMAIL: "actor@x.test" },
            { ID: 2, ROLE: "SUPER_ADMIN", IS_ACTIVE: "Y", EMAIL: "root@x.test" },
            { ID: 3, ROLE: "SUPER_ADMIN", IS_ACTIVE: "N", EMAIL: "inactive@x.test" },
            { ID: 4, ROLE: "ADMIN", EMAIL: "other@x.test" },
            { ID: 5, ROLE: "SUPER_ADMIN", EMAIL: "root@x.test" },
            { ID: 6, ROLE: "SUPER_ADMIN", IS_ACTIVE: "Y", EMAIL: "not an address" },
        ]);
        expect(await BackupEmailService._resolveRecipientEmails("1")).toEqual(["actor@x.test", "root@x.test"]);
    });
    it("returns an empty list and warns when the admin lookup fails", async () => {
        vi.spyOn(AdminModel, "findAll").mockRejectedValue(new Error("db down"));
        expect(await BackupEmailService._resolveRecipientEmails(1)).toEqual([]);
        expect(logger.warning).toHaveBeenCalledTimes(1);
    });
});

describe("sendPurgeNotification", () => {
    const base = { scopeLabel: "Everything", totalRows: 12, tableCount: 3, adminId: 1, requestId: "req-1" };

    it("skips when disabled", async () => {
        process.env.BACKUP_EMAIL_ENABLED = "false";
        expect(await BackupEmailService.sendPurgeNotification(base)).toEqual({ sent: false, reason: "disabled" });
        expect(sendMail).not.toHaveBeenCalled();
    });
    it("skips with no recipients", async () => {
        admins([]);
        expect(await BackupEmailService.sendPurgeNotification(base)).toEqual({ sent: false, reason: "no-recipients" });
        expect(sendMail).not.toHaveBeenCalled();
    });
    it("sends one mail to all recipients with subject, text, html and attachments", async () => {
        admins([{ ID: 1, ROLE: "ADMIN", EMAIL: "a@x.test" }, { ID: 2, ROLE: "SUPER_ADMIN", EMAIL: "b@x.test" }]);
        const res = await BackupEmailService.sendPurgeNotification(base);
        expect(res).toEqual({ sent: true, recipientCount: 2 });
        const mail = sendMail.mock.calls[0][0];
        expect(mail.from).toBe("from@x.test");
        expect(mail.to).toBe("a@x.test, b@x.test");
        expect(mail.subject).toMatch(/Data purge completed — 3 table\(s\), 12 row\(s\) deleted/);
        expect(mail.text).toContain("Scope: Everything");
        expect(mail.text).toContain("Request ID: req-1");
        expect(mail.html).toContain("Admin #1");
        expect(mail.html).not.toMatch(/\{\{\w+\}\}/);
        expect(Array.isArray(mail.attachments)).toBe(true);
    });
    it("applies defaults for missing scope, counts and request id", async () => {
        admins([{ ID: 1, ROLE: "ADMIN", EMAIL: "a@x.test" }]);
        await BackupEmailService.sendPurgeNotification({ adminId: 1 });
        const mail = sendMail.mock.calls[0][0];
        expect(mail.subject).toMatch(/0 table\(s\), 0 row\(s\)/);
        expect(mail.text).toContain("(scope not provided)");
        expect(mail.text).toContain("Request ID: n/a");
    });
    it("reports a send error without throwing", async () => {
        admins([{ ID: 1, ROLE: "ADMIN", EMAIL: "a@x.test" }]);
        sendMail.mockRejectedValue(new Error("smtp 550"));
        expect(await BackupEmailService.sendPurgeNotification(base)).toEqual({ sent: false, reason: "send-error", cause: "smtp 550", recipientCount: 1 });
        expect(logger.warning).toHaveBeenCalledTimes(1);
    });
    it("stringifies non-Error send failures", async () => {
        admins([{ ID: 1, ROLE: "ADMIN", EMAIL: "a@x.test" }]);
        sendMail.mockRejectedValue("plain string");
        expect((await BackupEmailService.sendPurgeNotification(base)).cause).toBe("plain string");
    });
    it("converts unexpected failures (e.g. template unreadable) into a result", async () => {
        admins([{ ID: 1, ROLE: "ADMIN", EMAIL: "a@x.test" }]);
        vi.spyOn(fs, "readFileSync").mockImplementation(() => { throw new Error("ENOENT template"); });
        expect(await BackupEmailService.sendPurgeNotification(base)).toEqual({ sent: false, reason: "unexpected-error", cause: "ENOENT template" });
        expect(sendMail).not.toHaveBeenCalled();
    });
    it("stringifies non-Error unexpected failures", async () => {
        admins([{ ID: 1, ROLE: "ADMIN", EMAIL: "a@x.test" }]);
        vi.spyOn(fs, "readFileSync").mockImplementation(() => { throw "weird"; });
        expect((await BackupEmailService.sendPurgeNotification(base)).cause).toBe("weird");
    });
});

describe("rendering helpers", () => {
    it("_buildHtml escapes HTML in every variable and leaves unknown placeholders alone", () => {
        vi.spyOn(fs, "readFileSync").mockReturnValue("<p>{{scopeLabel}}|{{requestId}}|{{nope}}|{{triggeredBy}}</p>");
        const html = BackupEmailService._buildHtml({ adminId: "<b>1</b>", requestId: null, scopeLabel: `<script>alert("x")</script> & 'q'`, tableCount: 1, rowCount: 2 });
        expect(html).toBe("<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#x27;q&#x27;|n/a|{{nope}}|Admin #&lt;b&gt;1&lt;/b&gt;</p>");
    });
    it("_formatLocalTime renders a UTC offset label", () => {
        expect(BackupEmailService._formatLocalTime()).toMatch(/UTC[+-]\d{2}:\d{2}$/);
    });
    it("_logoAttachments is empty when either logo is missing, populated when both exist", () => {
        const exists = vi.spyOn(fs, "existsSync").mockReturnValueOnce(true).mockReturnValueOnce(false);
        expect(BackupEmailService._logoAttachments()).toEqual([]);
        exists.mockReturnValue(true);
        const att = BackupEmailService._logoAttachments();
        expect(att.map((a) => a.cid)).toEqual(["app-logo-light", "app-logo-dark"]);
    });
    it("_buildPlainText lists the facts", () => {
        const text = BackupEmailService._buildPlainText({ adminId: 9, requestId: undefined, scopeLabel: "S", tableCount: 2, rowCount: 5 });
        expect(text).toContain("Triggered by: Admin #9");
        expect(text).toContain("Rows deleted: 5");
        expect(text).toContain("Request ID: n/a");
    });
});
