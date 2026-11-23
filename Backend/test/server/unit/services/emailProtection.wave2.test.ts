import SharedTransporter from "../../../../src/services/email/SharedTransporter";
import EmailProtectionService from "../../../../src/services/email/EmailProtectionService";
import ServerNotificationService, { ServerNotificationService as SNSClass, CHANNELS } from "../../../../src/services/email/ServerNotificationService";
import RecipientResolver from "../../../../src/services/email/RecipientResolver";
import { logger } from "../../../../src/utils/logger";

const silence = () => {
    for (const m of ["warning", "notice", "info", "debug", "critical", "error"] as const) {
        vi.spyOn(logger, m).mockImplementation((() => undefined) as never);
    }
};
const smtp = (o: { code?: string; responseCode?: number; message?: string } = {}) =>
    Object.assign(new Error(o.message ?? "smtp fail"), o.code ? { code: o.code } : {}, o.responseCode ? { responseCode: o.responseCode } : {});
const primary = (to: unknown = "user@example.com") => () => ({ from: "a@b.c", to, subject: "s", html: "h" }) as never;

describe("EmailProtectionService (wave2)", () => {
    let sendMail: ReturnType<typeof vi.fn>;
    beforeEach(() => {
        vi.useFakeTimers();
        silence();
        vi.stubEnv("EMAIL_RETRY_ATTEMPTS", "3");
        vi.stubEnv("EMAIL_FALLBACK_RETRY_ATTEMPTS", "2");
        vi.stubEnv("EMAIL_RETRY_BASE_DELAY_MS", "1");
        sendMail = vi.spyOn(SharedTransporter.getTransporter(), "sendMail").mockResolvedValue({ messageId: "m" } as never) as never;
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    const run = async (opts: Parameters<typeof EmailProtectionService.sendProtected>[0]) => {
        const p = EmailProtectionService.sendProtected(opts);
        await vi.runAllTimersAsync();
        return p;
    };

    it("PARTIAL: string and object rejected addresses are reported, masked in logs, and not retried", async () => {
        sendMail.mockResolvedValue({ rejected: ["bad@x.com", { address: "obj@x.com" }] });
        const res = await run({ label: "multi", buildMailOptions: primary(["a@x.com", "bad@x.com", "obj@x.com"]) });
        expect(res.status).toBe("PARTIAL");
        expect(res.rejectedRecipients).toEqual(["bad@x.com", "obj@x.com"]);
        expect(res.cause).toBe("SMTP rejected 2 recipient(s)");
        expect(res.attempts).toBe(1);
        expect(sendMail).toHaveBeenCalledTimes(1);
        const warned = (logger.warning as any).mock.calls.flat().join(" ");
        expect(warned).not.toContain("bad@x.com");
    });

    it("an info without a rejected array is still DELIVERED", async () => {
        sendMail.mockResolvedValue(undefined);
        const res = await run({ buildMailOptions: primary() });
        expect(res.status).toBe("DELIVERED");
    });

    it("chaos: SMTP down on every attempt and no fallback -> FAILED with the transient error code and exhausted attempts", async () => {
        sendMail.mockRejectedValue(smtp({ code: "ECONNECTION", message: "connect refused" }));
        const res = await run({ label: "down", buildMailOptions: primary() });
        expect(res).toMatchObject({ status: "FAILED", attempts: 3, fallbackAttempts: 0, cause: "connect refused", smtpErrorCode: "ECONNECTION" });
        expect(sendMail).toHaveBeenCalledTimes(3);
    });

    it("permanent 5xx response is not retried and its responseCode becomes the error code", async () => {
        sendMail.mockRejectedValue(smtp({ responseCode: 550, message: "mailbox unavailable" }));
        const res = await run({ buildMailOptions: primary() });
        expect(res).toMatchObject({ status: "FAILED", attempts: 1, smtpErrorCode: "550" });
        expect(sendMail).toHaveBeenCalledTimes(1);
    });

    it("a rejected non-object value yields null error code and stringified cause", async () => {
        sendMail.mockRejectedValue("plain string failure");
        const res = await run({ buildMailOptions: primary() });
        expect(res.status).toBe("FAILED");
        expect(res.smtpErrorCode).toBeNull();
        expect(res.cause).toBe("plain string failure");
    });

    it("an error with only a string code and no message falls back to that code for diagnostics", async () => {
        sendMail.mockRejectedValue(Object.assign(new Error(""), { code: "EAUTH" }));
        const res = await run({ buildMailOptions: primary() });
        expect(res.smtpErrorCode).toBe("EAUTH");
    });

    it("fallback with an invalid shape is treated as no fallback", async () => {
        sendMail.mockRejectedValue(smtp({ responseCode: 554 }));
        const resolveRecipients = vi.fn();
        const res = await run({ buildMailOptions: primary(), fallback: { resolveRecipients, buildMailOptions: "no" as never } });
        expect(res.status).toBe("FAILED");
        expect(resolveRecipients).not.toHaveBeenCalled();
    });

    it("fallback recipient resolution throwing is folded into the failure cause", async () => {
        sendMail.mockRejectedValue(smtp({ responseCode: 554, message: "rejected" }));
        const res = await run({
            buildMailOptions: primary(),
            fallback: { resolveRecipients: async () => { throw new Error("db down"); }, buildMailOptions: () => ({}) as never },
        });
        expect(res.status).toBe("FAILED");
        expect(res.cause).toBe("rejected; fallback recipient resolution failed: db down");
    });

    it("fallback resolving to null/empty reports no fallback recipients", async () => {
        sendMail.mockRejectedValue(smtp({ responseCode: 554, message: "rejected" }));
        const res = await run({
            buildMailOptions: primary(),
            fallback: { resolveRecipients: async () => null as never, buildMailOptions: () => ({}) as never },
        });
        expect(res.cause).toBe("rejected (no fallback recipients available)");
    });

    it("fallback tier: primary exhausted then fallback transient-retries and succeeds -> FALLBACK", async () => {
        sendMail
            .mockRejectedValueOnce(smtp({ responseCode: 554 }))
            .mockRejectedValueOnce(smtp({ code: "ETIMEDOUT" }))
            .mockResolvedValueOnce({});
        const build = vi.fn(() => ({ to: "admin@x.com" }) as never);
        const res = await run({ label: "fb", buildMailOptions: primary(), fallback: { resolveRecipients: async () => ["admin@x.com", "ops@x.com"], buildMailOptions: build } });
        expect(res).toMatchObject({ status: "FALLBACK", attempts: 1, fallbackAttempts: 2, fallbackRecipients: ["admin@x.com", "ops@x.com"], smtpErrorCode: "554" });
        expect(build).toHaveBeenCalledWith(["admin@x.com", "ops@x.com"]);
    });

    it("chaos: both tiers fail -> FAILED combining both causes; fallback error code wins", async () => {
        sendMail
            .mockRejectedValueOnce(smtp({ responseCode: 554, message: "p" }))
            .mockRejectedValue(smtp({ code: "ECONNRESET", message: "f" }));
        const res = await run({ buildMailOptions: primary(), fallback: { resolveRecipients: async () => ["a@x.com"], buildMailOptions: () => ({}) as never } });
        expect(res).toMatchObject({ status: "FAILED", cause: "primary: p; fallback: f", fallbackAttempts: 2, smtpErrorCode: "ECONNRESET" });
    });

    it("env attempt budgets fall back to defaults when invalid", async () => {
        vi.stubEnv("EMAIL_RETRY_ATTEMPTS", "zero");
        sendMail.mockRejectedValue(smtp({ code: "ESOCKET" }));
        const res = await run({ buildMailOptions: primary() });
        expect(res.attempts).toBe(3);
    });

    it("buildMailOptions returning nothing keeps the last recipient and still sends", async () => {
        sendMail.mockRejectedValue(smtp({ responseCode: 554 }));
        const res = await run({ buildMailOptions: (() => undefined) as never });
        expect(res.recipient).toBeNull();
    });
});

