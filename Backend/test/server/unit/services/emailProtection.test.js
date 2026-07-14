"use strict";

/**
 * @fileoverview Unit tests for EmailProtectionService — budgeted primary +
 * fallback email dispatch. Stubs SharedTransporter's shared nodemailer
 * transporter (`vi.spyOn`, not a `vi.mock` factory — the module exports a
 * CJS singleton instance) so no SMTP connection is ever opened. Backoff
 * delays are fast-forwarded with `vi.useFakeTimers()` / `vi.runAllTimersAsync()`.
 */

const SharedTransporter = require("../../../../src/services/email/SharedTransporter");
const EmailProtectionService = require("../../../../src/services/email/EmailProtectionService");
const { logger } = require("../../../../src/utils/logger");
const { requestContext } = require("../../../../src/utils/requestContext");

/**
 * @param {{code?: string, responseCode?: number, message?: string}} [opts]
 * @returns {Error}
 */
function smtpError({ code, responseCode, message } = {}) {
    const err = new Error(message ?? "simulated SMTP failure");
    if (code) err.code = code;
    if (responseCode) err.responseCode = responseCode;
    return err;
}

/**
 * @param {string} [to]
 * @returns {() => object}
 */
function buildPrimaryOpts(to = "employee@example.com") {
    return () => ({
        from: "noreply@app.internal",
        to,
        subject: "[App] Test",
        html: "<p>hi</p>",
    });
}

describe("EmailProtectionService", function () {
    let sendMail;
    const ORIGINAL_ENV = { ...process.env };

    beforeEach(function () {
        process.env.EMAIL_RETRY_ATTEMPTS = "3";
        process.env.EMAIL_FALLBACK_RETRY_ATTEMPTS = "3";
        process.env.EMAIL_RETRY_BASE_DELAY_MS = "1";
        sendMail = vi
            .spyOn(SharedTransporter.getTransporter(), "sendMail")
            .mockResolvedValue({ messageId: "test" });
    });

    afterEach(function () {
        vi.restoreAllMocks();
        vi.useRealTimers();
        process.env = { ...ORIGINAL_ENV };
    });

    it("primary succeeds on attempt 1 → DELIVERED, attempts:1, fallback never resolved", async function () {
        const resolveRecipients = vi.fn(async () => ["admin@x.com"]);
        const fallbackBuild = vi.fn(() => ({}));

        const result = await EmailProtectionService.sendProtected({
            label: "test-flow",
            buildMailOptions: buildPrimaryOpts(),
            fallback: { resolveRecipients, buildMailOptions: fallbackBuild },
        });

        expect(result).toEqual({
            status: "DELIVERED",
            recipient: "employee@example.com",
            fallbackRecipients: [],
            attempts: 1,
            fallbackAttempts: 0,
            cause: null,
            smtpErrorCode: null,
        });
        expect(sendMail).toHaveBeenCalledTimes(1);
        expect(resolveRecipients).not.toHaveBeenCalled();
        expect(fallbackBuild).not.toHaveBeenCalled();
    });

    it("transient failure twice then success → DELIVERED attempts:3", async function () {
        vi.useFakeTimers();
        let call = 0;
        sendMail.mockImplementation(async () => {
            call += 1;
            if (call < 3) throw smtpError({ code: "ETIMEDOUT" });
            return { messageId: "ok" };
        });

        const promise = EmailProtectionService.sendProtected({
            label: "test-flow",
            buildMailOptions: buildPrimaryOpts(),
        });
        await vi.runAllTimersAsync();
        const result = await promise;

        expect(result.status).toBe("DELIVERED");
        expect(result.attempts).toBe(3);
        expect(result.cause).toBeNull();
        expect(sendMail).toHaveBeenCalledTimes(3);
    });

    it("primary exhausted (3 transient failures) → fallback resolves 2 admins → fallback delivers → FALLBACK", async function () {
        vi.useFakeTimers();
        sendMail.mockImplementation(async (opts) => {
            if (opts.to === "employee@example.com") {
                throw smtpError({ code: "ETIMEDOUT" });
            }
            return { messageId: "fallback-ok" };
        });

        const resolveRecipients = vi.fn(async () => [
            "admin1@x.com",
            "admin2@x.com",
        ]);
        const fallbackBuild = vi.fn((recipients) => ({
            from: "noreply@app.internal",
            to: recipients.join(", "),
            subject: "[App] Test — fallback",
            html: "<p>fallback</p>",
        }));

        const promise = EmailProtectionService.sendProtected({
            label: "test-flow",
            buildMailOptions: buildPrimaryOpts(),
            fallback: { resolveRecipients, buildMailOptions: fallbackBuild },
        });
        await vi.runAllTimersAsync();
        const result = await promise;

        expect(result.status).toBe("FALLBACK");
        expect(result.attempts).toBe(3);
        expect(result.fallbackAttempts).toBe(1);
        expect(result.fallbackRecipients).toEqual([
            "admin1@x.com",
            "admin2@x.com",
        ]);
        expect(result.cause).toContain("simulated SMTP failure");
        expect(result.smtpErrorCode).toBe("ETIMEDOUT"); // the primary failure that triggered the fallback
        expect(resolveRecipients).toHaveBeenCalledTimes(1);
        expect(fallbackBuild).toHaveBeenCalledWith([
            "admin1@x.com",
            "admin2@x.com",
        ]);
    });

    it("PERMANENT_SMTP (responseCode 550) on attempt 1 → skips remaining primary retries, goes straight to fallback", async function () {
        sendMail.mockImplementation(async (opts) => {
            if (opts.to === "employee@example.com") {
                throw smtpError({
                    responseCode: 550,
                    message: "mailbox unavailable",
                });
            }
            return { messageId: "fallback-ok" };
        });

        const resolveRecipients = vi.fn(async () => ["admin@x.com"]);
        const result = await EmailProtectionService.sendProtected({
            label: "test-flow",
            buildMailOptions: buildPrimaryOpts(),
            fallback: {
                resolveRecipients,
                buildMailOptions: () => ({
                    from: "noreply@app.internal",
                    to: "admin@x.com",
                    subject: "fallback",
                    html: "<p>fb</p>",
                }),
            },
        });

        expect(result.status).toBe("FALLBACK");
        expect(result.attempts).toBe(1); // primary tier stopped after exactly one attempt
        expect(result.cause).toContain("mailbox unavailable");
        // 1 primary attempt + 1 fallback attempt — no primary retries consumed.
        expect(sendMail).toHaveBeenCalledTimes(2);
    });

    it("both tiers exhausted → FAILED with cause + smtpErrorCode; never throws", async function () {
        vi.useFakeTimers();
        sendMail.mockRejectedValue(
            smtpError({ responseCode: 421, message: "throttled" }),
        );

        const resolveRecipients = vi.fn(async () => ["admin@x.com"]);
        const promise = EmailProtectionService.sendProtected({
            label: "test-flow",
            buildMailOptions: buildPrimaryOpts(),
            fallback: {
                resolveRecipients,
                buildMailOptions: () => ({
                    from: "noreply@app.internal",
                    to: "admin@x.com",
                    subject: "fallback",
                    html: "<p>fb</p>",
                }),
            },
        });
        await vi.runAllTimersAsync();
        const result = await promise;

        expect(result.status).toBe("FAILED");
        expect(result.attempts).toBe(3);
        expect(result.fallbackAttempts).toBe(3);
        expect(result.cause).toContain("primary:");
        expect(result.cause).toContain("fallback:");
        expect(result.smtpErrorCode).toBe("421");
    });

    it("no fallback provided → FAILED after primary exhaustion", async function () {
        vi.useFakeTimers();
        sendMail.mockRejectedValue(smtpError({ code: "ETIMEDOUT" }));

        const promise = EmailProtectionService.sendProtected({
            label: "test-flow",
            buildMailOptions: buildPrimaryOpts(),
        });
        await vi.runAllTimersAsync();
        const result = await promise;

        expect(result.status).toBe("FAILED");
        expect(result.attempts).toBe(3);
        expect(result.fallbackAttempts).toBe(0);
        expect(result.fallbackRecipients).toEqual([]);
        expect(result.smtpErrorCode).toBe("ETIMEDOUT");
    });

    it("fallback resolveRecipients returns [] → FAILED with cause noting no fallback recipients", async function () {
        vi.useFakeTimers();
        sendMail.mockRejectedValue(smtpError({ code: "ETIMEDOUT" }));
        const resolveRecipients = vi.fn(async () => []);

        const promise = EmailProtectionService.sendProtected({
            label: "test-flow",
            buildMailOptions: buildPrimaryOpts(),
            fallback: { resolveRecipients, buildMailOptions: () => ({}) },
        });
        await vi.runAllTimersAsync();
        const result = await promise;

        expect(result.status).toBe("FAILED");
        expect(result.fallbackAttempts).toBe(0);
        expect(result.fallbackRecipients).toEqual([]);
        expect(result.cause).toMatch(/no fallback recipients/i);
        expect(resolveRecipients).toHaveBeenCalledTimes(1);
    });

    it("fallback recipient resolution throwing → FAILED, never throws to the caller", async function () {
        vi.useFakeTimers();
        sendMail.mockRejectedValue(smtpError({ code: "ETIMEDOUT" }));
        const resolveRecipients = vi.fn(async () => {
            throw new Error("DB down");
        });

        const promise = EmailProtectionService.sendProtected({
            label: "test-flow",
            buildMailOptions: buildPrimaryOpts(),
            fallback: { resolveRecipients, buildMailOptions: () => ({}) },
        });
        await vi.runAllTimersAsync();
        const result = await promise;

        expect(result.status).toBe("FAILED");
        expect(result.cause).toContain("DB down");
    });

    // ─── observability trace (EMAIL_ATTEMPT_OK, EMAIL_DELIVERY_SUMMARY) ───────

    describe("observability logging", function () {
        let debugSpy;
        let infoSpy;

        beforeEach(function () {
            debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => {});
            infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});
        });

        it("primary delivery on attempt 1 logs EMAIL_ATTEMPT_OK (debug, tier=primary) and EMAIL_DELIVERY_SUMMARY (info, delivered:1)", async function () {
            const result = await EmailProtectionService.sendProtected({
                label: "obs-flow",
                buildMailOptions: buildPrimaryOpts("recipient@example.com"),
            });

            expect(result.status).toBe("DELIVERED");

            const okCall = debugSpy.mock.calls.find(([msg]) => msg.includes("delivered via primary"));
            expect(okCall).toBeDefined();
            const [, okMeta] = okCall;
            expect(okMeta).toMatchObject({
                label: "obs-flow",
                recipient: "recipient@example.com",
                tier: "primary",
                attempt: 1,
            });

            const summaryCall = infoSpy.mock.calls.find(([msg]) => msg.includes("delivery summary"));
            expect(summaryCall).toBeDefined();
            const [summaryMsg, summaryMeta] = summaryCall;
            expect(summaryMsg).toContain("delivered=1");
            expect(summaryMsg).toContain("fallbackDelivered=0");
            expect(summaryMsg).toContain("failed=0");
            expect(summaryMeta).toMatchObject({
                label: "obs-flow",
                delivered: 1,
                fallbackDelivered: 0,
                failed: 0,
            });
        });

        it("fallback delivery logs EMAIL_ATTEMPT_OK (debug, tier=fallback) and EMAIL_DELIVERY_SUMMARY (info, fallbackDelivered:1)", async function () {
            vi.useFakeTimers();
            sendMail.mockImplementation(async (opts) => {
                if (opts.to === "employee@example.com") {
                    throw smtpError({ code: "ETIMEDOUT" });
                }
                return { messageId: "fallback-ok" };
            });

            const promise = EmailProtectionService.sendProtected({
                label: "obs-fallback-flow",
                buildMailOptions: buildPrimaryOpts(),
                fallback: {
                    resolveRecipients: async () => ["admin1@x.com", "admin2@x.com"],
                    buildMailOptions: (recipients) => ({
                        from: "noreply@app.internal",
                        to: recipients.join(", "),
                        subject: "[App] Test — fallback",
                        html: "<p>fallback</p>",
                    }),
                },
            });
            await vi.runAllTimersAsync();
            const result = await promise;

            expect(result.status).toBe("FALLBACK");

            const okCall = debugSpy.mock.calls.find(([msg]) => msg.includes("delivered via fallback"));
            expect(okCall).toBeDefined();
            const [, okMeta] = okCall;
            expect(okMeta).toMatchObject({
                label: "obs-fallback-flow",
                recipient: "admin1@x.com, admin2@x.com",
                tier: "fallback",
                attempt: 1,
            });

            const summaryCall = infoSpy.mock.calls.find(([msg]) => msg.includes("delivery summary"));
            expect(summaryCall).toBeDefined();
            const [, summaryMeta] = summaryCall;
            expect(summaryMeta).toMatchObject({
                label: "obs-fallback-flow",
                delivered: 0,
                fallbackDelivered: 1,
                failed: 0,
            });
        });

        it("total failure (both tiers exhausted) logs EMAIL_DELIVERY_SUMMARY (info, failed:1) and no EMAIL_ATTEMPT_OK", async function () {
            vi.useFakeTimers();
            sendMail.mockRejectedValue(smtpError({ code: "ETIMEDOUT" }));

            const promise = EmailProtectionService.sendProtected({
                label: "obs-failed-flow",
                buildMailOptions: buildPrimaryOpts(),
            });
            await vi.runAllTimersAsync();
            const result = await promise;

            expect(result.status).toBe("FAILED");

            expect(debugSpy.mock.calls.some(([msg]) => msg.includes("delivered via"))).toBe(false);

            const summaryCall = infoSpy.mock.calls.find(([msg]) => msg.includes("delivery summary"));
            expect(summaryCall).toBeDefined();
            const [summaryMsg, summaryMeta] = summaryCall;
            expect(summaryMsg).toContain("failed=1");
            expect(summaryMeta).toMatchObject({
                label: "obs-failed-flow",
                delivered: 0,
                fallbackDelivered: 0,
                failed: 1,
            });
        });
    });

    // ─── requestId propagation through sendProtected() ────────────────────────

    describe("sendProtected() — requestId propagation via AsyncLocalStorage", function () {
        it("every logger.log call made during sendProtected() carries the ALS requestId", async function () {
            const observedRequestIds = [];
            vi.spyOn(logger, "log").mockImplementation(async () => {
                observedRequestIds.push(requestContext.getStore()?.requestId ?? null);
            });

            const result = await requestContext.run({ requestId: "test-req-789" }, () =>
                EmailProtectionService.sendProtected({
                    label: "requestid-email-test",
                    buildMailOptions: buildPrimaryOpts(),
                }),
            );

            expect(result.status).toBe("DELIVERED");
            expect(observedRequestIds.length).toBeGreaterThan(0);
            expect(observedRequestIds.every((id) => id === "test-req-789")).toBe(true);
        });
    });
});
