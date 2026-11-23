import fs from "fs";
import SharedTransporter from "../../../../src/services/email/SharedTransporter";
import ServerNotificationService, { ServerNotificationService as SNSClass, CHANNELS } from "../../../../src/services/email/ServerNotificationService";
import RecipientResolver from "../../../../src/services/email/RecipientResolver";
import { metricsStore } from "../../../../src/middleware/metrics";
import { logger } from "../../../../src/utils/logger";

const silence = () => {
    for (const m of ["warning", "notice", "info", "debug", "critical", "error"] as const) {
        vi.spyOn(logger, m).mockImplementation((() => undefined) as never);
    }
};

describe("ServerNotificationService (wave2)", () => {
    let svc: InstanceType<typeof SNSClass>;
    let sendMail: ReturnType<typeof vi.fn>;
    beforeEach(() => {
        silence();
        vi.stubEnv("ENABLE_SERVER_NOTIFICATIONS", "true");
        vi.stubEnv("SERVER_NOTIFY_TO", "ops@example.com");
        RecipientResolver.invalidate();
        sendMail = vi.fn().mockResolvedValue({});
        vi.spyOn(SharedTransporter, "getTransporter").mockReturnValue({ sendMail } as never);
        svc = new SNSClass();
        vi.spyOn(RecipientResolver, "getDbRecipientsWithState").mockResolvedValue({ dbUp: false, emails: [] } as never);
        vi.spyOn(metricsStore, "recordNotificationDelivery").mockImplementation(() => undefined as never);
    });
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
        RecipientResolver.invalidate();
    });

    const payload = (o: Record<string, unknown> = {}) => ({ severity: "WARNING", headline: "H", summary: "S", ...o }) as never;

    it("invalidateRecipientCache delegates to RecipientResolver", () => {
        const inv = vi.spyOn(RecipientResolver, "invalidate").mockImplementation(() => undefined as never);
        svc.invalidateRecipientCache();
        expect(inv).toHaveBeenCalledTimes(1);
    });

    it("isEnabled is case-insensitive and false when unset", () => {
        vi.stubEnv("ENABLE_SERVER_NOTIFICATIONS", "TRUE");
        expect(svc.isEnabled()).toBe(true);
        vi.stubEnv("ENABLE_SERVER_NOTIFICATIONS", "");
        expect(svc.isEnabled()).toBe(false);
    });

    it("resolveRecipients: env floor is trimmed/deduped; DB opt-ins win when the DB is up; resolver failure keeps the floor", async () => {
        vi.stubEnv("SERVER_NOTIFY_TO", " a@x.com, ,a@x.com,b@x.com ");
        await expect(svc.resolveRecipients(CHANNELS[0])).resolves.toEqual(["a@x.com", "b@x.com"]);
        (RecipientResolver.getDbRecipientsWithState as any).mockResolvedValue({ dbUp: true, emails: ["db@x.com", "", "db@x.com"] });
        await expect(svc.resolveRecipients(CHANNELS[0])).resolves.toEqual(["db@x.com"]);
        (RecipientResolver.getDbRecipientsWithState as any).mockResolvedValue({ dbUp: true, emails: [] });
        await expect(svc.resolveRecipients(CHANNELS[0])).resolves.toEqual(["a@x.com", "b@x.com"]);
        (RecipientResolver.getDbRecipientsWithState as any).mockRejectedValue(new Error("resolver exploded"));
        await expect(svc.resolveRecipients(CHANNELS[0])).resolves.toEqual(["a@x.com", "b@x.com"]);
        (RecipientResolver.getDbRecipientsWithState as any).mockRejectedValue("str");
        await expect(svc.resolveRecipients(CHANNELS[0])).resolves.toHaveLength(2);
        vi.stubEnv("SERVER_NOTIFY_TO", "");
        await expect(svc.resolveRecipients(CHANNELS[0])).resolves.toEqual([]);
    });

    it("sendChannelDigest short-circuits: unknown channel, disabled, no recipients (recorded)", async () => {
        await expect(svc.sendChannelDigest("nope", payload())).resolves.toEqual({ sent: false, reason: "unknown-channel" });
        vi.stubEnv("ENABLE_SERVER_NOTIFICATIONS", "false");
        await expect(svc.sendChannelDigest(CHANNELS[0], payload())).resolves.toEqual({ sent: false, reason: "disabled" });
        vi.stubEnv("ENABLE_SERVER_NOTIFICATIONS", "true");
        vi.stubEnv("SERVER_NOTIFY_TO", "");
        await expect(svc.sendChannelDigest(CHANNELS[0], payload({ headline: undefined }))).resolves.toEqual({ sent: false, reason: "no-recipients" });
        expect(svc.getRecentSends()).toEqual([expect.objectContaining({ sent: false, reason: "no-recipients", headline: "", notificationId: null })]);
        expect(sendMail).not.toHaveBeenCalled();
    });

    it("sends critical rows with requestId and metric-shaped rows, escaping HTML, using supplied ids and times", async () => {
        const res = await svc.sendChannelDigest("server-critical-notification", payload({
            notificationId: "NTF-1",
            firedAt: "now",
            throttleNote: "cool",
            kv: { extra: "<b>" },
            rows: [
                { level: "ALERT", module: "m<x>", message: "boom & bust", requestId: "r1", time: "t1" },
                { level: "ALERT", message: "no module", time: "t2" },
                { rule: "ORACLE_POOL_DOWN", scope: "global", description: "d", severity: "critical" },
                { rule: "R", scope: "route /x", description: "d2", severity: undefined },
            ],
        }));
        expect(res).toEqual({ sent: true, notificationId: "NTF-1", recipientCount: 1 });
        const mail = sendMail.mock.calls[0][0];
        expect(mail.to).toBe("ops@example.com");
        expect(mail.subject).toContain("[WARNING] server-critical-notification: H");
        expect(mail.html).toContain("boom &amp; bust");
        expect(mail.html).toContain("m&lt;x&gt;");
        expect(mail.html).toContain("unknown");
        expect(mail.html).not.toContain("m<x>");
        expect(mail.text).toContain("(reqId: r1)");
        expect(mail.text).toContain("- ORACLE_POOL_DOWN: d [CRITICAL]");
        expect(mail.text).toContain("- R (route /x): d2 []");
        expect(mail.text).toContain("cool");
        expect(metricsStore.recordNotificationDelivery).toHaveBeenCalledWith("server-critical-notification", true);
    });

    it("generates ids and times when omitted and uses APP_NAME in the subject", async () => {
        vi.stubEnv("APP_NAME", "MYAPP");
        const res = await svc.sendChannelDigest("server-system-notification", payload());
        expect(res.notificationId).toMatch(/^NTF-/);
        expect(sendMail.mock.calls[0][0].subject.startsWith("[MYAPP]")).toBe(true);
        expect(sendMail.mock.calls[0][0].text.startsWith("[MYAPP] H")).toBe(true);
    });

    it("chaos: SMTP down records a failed delivery, returns send-error, and never throws", async () => {
        sendMail.mockRejectedValue(new Error("ECONNREFUSED"));
        await expect(svc.sendChannelDigest(CHANNELS[1], payload())).resolves.toMatchObject({ sent: false, reason: "send-error", cause: "ECONNREFUSED", recipientCount: 1 });
        expect(metricsStore.recordNotificationDelivery).toHaveBeenCalledWith(CHANNELS[1], false, "ECONNREFUSED");
        sendMail.mockRejectedValue(undefined);
        await expect(svc.sendChannelDigest(CHANNELS[1], payload())).resolves.toMatchObject({ reason: "send-error", cause: "undefined" });
    });

    it("recent sends ring buffer is bounded to 100 and returns copies, oldest evicted", async () => {
        for (let i = 0; i < 105; i++) await svc.sendChannelDigest(CHANNELS[2], payload({ headline: `h${i}`, notificationId: `n${i}` }));
        const recent = svc.getRecentSends();
        expect(recent).toHaveLength(100);
        expect(recent[0].notificationId).toBe("n5");
        expect(recent[99].notificationId).toBe("n104");
        recent.pop();
        expect(svc.getRecentSends()).toHaveLength(100);
    });

    it("_logoAttachments returns [] with a warning when a logo is missing, descriptors otherwise", () => {
        const exists = vi.spyOn(fs, "existsSync").mockReturnValue(false);
        expect(svc._logoAttachments()).toEqual([]);
        exists.mockReturnValue(true);
        expect(svc._logoAttachments().map((a) => a.cid)).toEqual(["app-logo-light", "app-logo-dark"]);
    });

    it("_formatLocalTime honours a negative timezone offset and _fill/_fillRaw leave unknown placeholders and escape $", () => {
        vi.stubEnv("DB_TIMEZONE_OFFSET_MINUTES", "-330");
        expect(svc._formatLocalTime()).toMatch(/UTC-05:30$/);
        expect(svc._fill("{{a}} {{b}}", { a: "cost $1,000 <i>" })).toBe("cost $1,000 &lt;i&gt; {{b}}");
        expect(svc._fillRaw("{{a}} {{b}}", { a: "<i>" })).toBe("<i> {{b}}");
        expect(svc._fill("{{a}}", { a: null as never })).toBe("");
        expect(svc._fillRaw("{{a}}", { a: undefined as never })).toBe("");
    });

    it("_buildRow on a non-critical channel renders level-bearing rows as metric rows; last row gets a bottom border", () => {
        const html = svc._buildRow("server-system-notification", { level: "X", rule: "RULE", description: "d", severity: "warning" } as never, true);
        expect(html).toContain("RULE");
        expect(html).toContain("border-bottom:1px solid #f0f0f0;");
        const mid = svc._buildCriticalRow({ level: "E", message: "m", time: "t" }, false);
        expect(mid).not.toContain("border-bottom:1px solid #f0f0f0;vertical");
    });
});
