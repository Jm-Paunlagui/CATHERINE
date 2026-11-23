import SharedTransporter from "../../../src/services/email/SharedTransporter";
import EmailProtectionService from "../../../src/services/email/EmailProtectionService";
import { RetryPolicy } from "../../../src/utils/resilience/RetryPolicy";
import InFlightTaskRegistry from "../../../src/utils/InFlightTaskRegistry";
import { logger } from "../../../src/utils/logger";

describe("SMTP outage chaos (wave2)", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        for (const m of ["warning", "notice", "info", "debug", "critical", "error"] as const) vi.spyOn(logger, m).mockImplementation((() => undefined) as never);
        vi.stubEnv("EMAIL_RETRY_ATTEMPTS", "4");
        vi.stubEnv("EMAIL_FALLBACK_RETRY_ATTEMPTS", "2");
        vi.stubEnv("EMAIL_RETRY_BASE_DELAY_MS", "100");
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it("a flapping relay recovers mid-budget: transient failures back off exponentially and the send is DELIVERED", async () => {
        vi.spyOn(Math, "random").mockReturnValue(0);
        const sendMail = vi.spyOn(SharedTransporter.getTransporter(), "sendMail")
            .mockRejectedValueOnce(Object.assign(new Error("reset"), { code: "ECONNRESET" }))
            .mockRejectedValueOnce(Object.assign(new Error("busy"), { responseCode: 451 }))
            .mockResolvedValueOnce({ rejected: [] } as never);
        const p = EmailProtectionService.sendProtected({ label: "flap", buildMailOptions: () => ({ to: "u@x.com" }) as never });
        await vi.advanceTimersByTimeAsync(99);
        expect(sendMail).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(sendMail).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(200);
        await expect(p).resolves.toMatchObject({ status: "DELIVERED", attempts: 3 });
    });

    it("SMTP down on both tiers exhausts the retry budget exactly once per tier and reports FAILED", async () => {
        const sendMail = vi.spyOn(SharedTransporter.getTransporter(), "sendMail").mockRejectedValue(Object.assign(new Error("down"), { code: "ETIMEDOUT" }));
        const p = EmailProtectionService.sendProtected({
            label: "dead",
            buildMailOptions: () => ({ to: "u@x.com" }) as never,
            fallback: { resolveRecipients: async () => ["ops@x.com"], buildMailOptions: () => ({ to: "ops@x.com" }) as never },
        });
        await vi.runAllTimersAsync();
        await expect(p).resolves.toMatchObject({ status: "FAILED", attempts: 4, fallbackAttempts: 2, smtpErrorCode: "ETIMEDOUT" });
        expect(sendMail).toHaveBeenCalledTimes(6);
    });

});
