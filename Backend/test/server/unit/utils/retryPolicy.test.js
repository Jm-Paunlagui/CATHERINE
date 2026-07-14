"use strict";

/**
 * @fileoverview Unit tests for RetryPolicy — the classification table (DB +
 * SMTP), exponential backoff timing, exhaustion metadata, and the
 * idempotency-probe early-resolve hook.
 */

const {
    RetryPolicy,
} = require("../../../../src/utils/resilience/RetryPolicy");
const { logger } = require("../../../../src/utils/logger");
const { requestContext } = require("../../../../src/utils/requestContext");

function oraError(code, message) {
    return new Error(
        message ?? `ORA-${String(code).padStart(5, "0")}: simulated`,
    );
}

describe("RetryPolicy", function () {
    describe("constructor validation", function () {
        it("throws RangeError for non-positive maxAttempts", function () {
            expect(() => new RetryPolicy({ maxAttempts: 0 })).toThrow(
                RangeError,
            );
            expect(() => new RetryPolicy({ maxAttempts: -1 })).toThrow(
                RangeError,
            );
            expect(() => new RetryPolicy({ maxAttempts: 1.5 })).toThrow(
                RangeError,
            );
        });

        it("throws RangeError for a negative baseDelayMs", function () {
            expect(() => new RetryPolicy({ baseDelayMs: -1 })).toThrow(
                RangeError,
            );
        });

        it("throws RangeError when maxDelayMs < baseDelayMs", function () {
            expect(
                () => new RetryPolicy({ baseDelayMs: 500, maxDelayMs: 100 }),
            ).toThrow(RangeError);
        });

        it("throws TypeError when classifier is not a function", function () {
            expect(() => new RetryPolicy({ classifier: "nope" })).toThrow(
                TypeError,
            );
        });

        it("accepts valid options without throwing", function () {
            expect(
                () =>
                    new RetryPolicy({
                        maxAttempts: 5,
                        baseDelayMs: 10,
                        maxDelayMs: 100,
                        classifier: RetryPolicy.classifyDbError,
                        label: "test",
                    }),
            ).not.toThrow();
        });
    });

    // ─── classifyDbError() — full classification table ─────────────────────

    describe("classifyDbError() — TRANSIENT_DB", function () {
        it.each([3113, 3114, 12170, 12541, 12514, 12560, 1013])(
            "classifies ORA-%s as TRANSIENT_DB",
            (code) => {
                expect(RetryPolicy.classifyDbError(oraError(code))).toBe(
                    "TRANSIENT_DB",
                );
            },
        );

        it("classifies a plain 'timed out getting connection' message as TRANSIENT_DB", function () {
            expect(
                RetryPolicy.classifyDbError(
                    new Error(
                        'Timed out getting connection from "userAccount"',
                    ),
                ),
            ).toBe("TRANSIENT_DB");
        });

        it("classifies the adapter-wrapped DB_OP_FAILED acquire-timeout message as TRANSIENT_DB", function () {
            expect(
                RetryPolicy.classifyDbError(
                    new Error(
                        'DB op failed [userAccount]: Timed out getting connection from "userAccount"',
                    ),
                ),
            ).toBe("TRANSIENT_DB");
        });

        it.each(["040", "500", "501", "503", "510"])(
            "classifies NJS-%s as TRANSIENT_DB",
            (code) => {
                expect(
                    RetryPolicy.classifyDbError(
                        new Error(`NJS-${code}: simulated driver error`),
                    ),
                ).toBe("TRANSIENT_DB");
            },
        );

        it.each(["ECONNRESET", "ETIMEDOUT"])(
            "classifies err.code=%s as TRANSIENT_DB",
            (code) => {
                const err = Object.assign(new Error("network blip"), {
                    code,
                });
                expect(RetryPolicy.classifyDbError(err)).toBe("TRANSIENT_DB");
            },
        );

        it("unwraps err.originalError to find a transient ORA code (adapter-wrapped errors)", function () {
            const wrapped = Object.assign(
                new Error(
                    "DB op failed [userAccount]: ORA-03113: end-of-file on communication channel",
                ),
                { originalError: oraError(3113) },
            );
            expect(RetryPolicy.classifyDbError(wrapped)).toBe("TRANSIENT_DB");
        });

        it("prefers err.errorNum over message parsing when present", function () {
            const err = Object.assign(new Error("opaque wrapped text"), {
                errorNum: 3114,
            });
            expect(RetryPolicy.classifyDbError(err)).toBe("TRANSIENT_DB");
        });
    });

    describe("classifyDbError() — FATAL_SESSION", function () {
        it.each([28, 31])("classifies ORA-%s as FATAL_SESSION", (code) => {
            expect(RetryPolicy.classifyDbError(oraError(code))).toBe(
                "FATAL_SESSION",
            );
        });
    });

    describe("classifyDbError() — DUPLICATE", function () {
        it("classifies ORA-00001 as DUPLICATE", function () {
            expect(RetryPolicy.classifyDbError(oraError(1))).toBe(
                "DUPLICATE",
            );
        });
    });

    describe("classifyDbError() — PERMANENT_DB", function () {
        it.each([904, 2291, 1400, 1722])(
            "classifies ORA-%s as PERMANENT_DB",
            (code) => {
                expect(RetryPolicy.classifyDbError(oraError(code))).toBe(
                    "PERMANENT_DB",
                );
            },
        );

        it("classifies a non-ORA, non-transient error as PERMANENT_DB", function () {
            expect(
                RetryPolicy.classifyDbError(new Error("something else")),
            ).toBe("PERMANENT_DB");
        });

        it("classifies null/undefined input as PERMANENT_DB", function () {
            expect(RetryPolicy.classifyDbError(null)).toBe("PERMANENT_DB");
            expect(RetryPolicy.classifyDbError(undefined)).toBe(
                "PERMANENT_DB",
            );
        });
    });

    // ─── classifySmtpError() — full classification table ────────────────────

    describe("classifySmtpError()", function () {
        it.each([
            "ETIMEDOUT",
            "ECONNECTION",
            "ESOCKET",
            "ECONNRESET",
            "EDNS",
            "EPIPE",
        ])("classifies nodemailer err.code=%s as TRANSIENT_SMTP", (code) => {
            const err = Object.assign(new Error("smtp blip"), { code });
            expect(RetryPolicy.classifySmtpError(err)).toBe("TRANSIENT_SMTP");
        });

        it.each([421, 450, 499])(
            "classifies responseCode=%i as TRANSIENT_SMTP",
            (responseCode) => {
                expect(
                    RetryPolicy.classifySmtpError({ responseCode }),
                ).toBe("TRANSIENT_SMTP");
            },
        );

        it.each([500, 550])(
            "classifies responseCode=%i as PERMANENT_SMTP",
            (responseCode) => {
                expect(
                    RetryPolicy.classifySmtpError({ responseCode }),
                ).toBe("PERMANENT_SMTP");
            },
        );

        it("defaults an unclassifiable SMTP error to PERMANENT_SMTP", function () {
            expect(
                RetryPolicy.classifySmtpError(new Error("plain failure")),
            ).toBe("PERMANENT_SMTP");
            expect(
                RetryPolicy.classifySmtpError(
                    Object.assign(new Error("auth"), { code: "EAUTH" }),
                ),
            ).toBe("PERMANENT_SMTP");
            expect(RetryPolicy.classifySmtpError(null)).toBe(
                "PERMANENT_SMTP",
            );
        });
    });

    describe("isTransientDbError() / isTransientSmtpError()", function () {
        it("isTransientDbError() is true only for the TRANSIENT_DB classification", function () {
            expect(RetryPolicy.isTransientDbError(oraError(3113))).toBe(true);
            expect(RetryPolicy.isTransientDbError(oraError(28))).toBe(false);
            expect(RetryPolicy.isTransientDbError(oraError(1))).toBe(false);
        });

        it("isTransientSmtpError() is true only for the TRANSIENT_SMTP classification", function () {
            expect(
                RetryPolicy.isTransientSmtpError({ responseCode: 450 }),
            ).toBe(true);
            expect(
                RetryPolicy.isTransientSmtpError({ responseCode: 550 }),
            ).toBe(false);
        });
    });

    // ─── execute() — retry + backoff ─────────────────────────────────────────

    describe("execute() — retry behaviour", function () {
        it("resolves on the first attempt without retrying", async function () {
            const policy = new RetryPolicy({
                maxAttempts: 3,
                classifier: RetryPolicy.classifyDbError,
            });
            const fn = vi.fn().mockResolvedValue("ok");

            const result = await policy.execute(fn);

            expect(result).toBe("ok");
            expect(fn).toHaveBeenCalledTimes(1);
        });

        it("PERMANENT_DB errors fail immediately without any retry", async function () {
            const policy = new RetryPolicy({
                maxAttempts: 10,
                classifier: RetryPolicy.classifyDbError,
                label: "permanent-test",
            });
            const fn = vi.fn(async () => {
                throw oraError(904);
            });

            await expect(policy.execute(fn)).rejects.toMatchObject({
                attempts: 1,
                classification: "PERMANENT_DB",
            });
            expect(fn).toHaveBeenCalledTimes(1);
        });

        it("DUPLICATE errors fail immediately without any retry", async function () {
            const policy = new RetryPolicy({
                maxAttempts: 10,
                classifier: RetryPolicy.classifyDbError,
            });
            const fn = vi.fn(async () => {
                throw oraError(1);
            });

            await expect(policy.execute(fn)).rejects.toMatchObject({
                attempts: 1,
                classification: "DUPLICATE",
            });
            expect(fn).toHaveBeenCalledTimes(1);
        });

        it("FATAL_SESSION errors get exactly one retry regardless of maxAttempts, then fail", async function () {
            const policy = new RetryPolicy({
                maxAttempts: 10,
                baseDelayMs: 1,
                maxDelayMs: 5,
                classifier: RetryPolicy.classifyDbError,
                label: "fatal-test",
            });
            const fn = vi.fn(async () => {
                throw oraError(28);
            });

            await expect(policy.execute(fn)).rejects.toMatchObject({
                attempts: 2,
                classification: "FATAL_SESSION",
            });
            expect(fn).toHaveBeenCalledTimes(2);
        });

        it("TRANSIENT_DB errors retry up to the configured maxAttempts then fail, attaching attempts+classification", async function () {
            const policy = new RetryPolicy({
                maxAttempts: 3,
                baseDelayMs: 1,
                maxDelayMs: 5,
                classifier: RetryPolicy.classifyDbError,
                label: "exhaust-test",
            });
            const fn = vi.fn(async () => {
                throw oraError(3113);
            });

            await expect(policy.execute(fn)).rejects.toMatchObject({
                attempts: 3,
                classification: "TRANSIENT_DB",
            });
            expect(fn).toHaveBeenCalledTimes(3);
        });

        it("retries a TRANSIENT_DB failure and succeeds once the transient condition clears", async function () {
            const policy = new RetryPolicy({
                maxAttempts: 5,
                baseDelayMs: 1,
                maxDelayMs: 5,
                classifier: RetryPolicy.classifyDbError,
                label: "recover-test",
            });
            let call = 0;
            const fn = vi.fn(async () => {
                call += 1;
                if (call < 3) throw oraError(3113);
                return "recovered";
            });

            const result = await policy.execute(fn);

            expect(result).toBe("recovered");
            expect(fn).toHaveBeenCalledTimes(3);
        });

        it("with no classifier configured, retries every failure up to maxAttempts (classification=null)", async function () {
            const policy = new RetryPolicy({
                maxAttempts: 3,
                baseDelayMs: 1,
                maxDelayMs: 5,
            });
            const fn = vi.fn(async () => {
                throw new Error("generic failure");
            });

            await expect(policy.execute(fn)).rejects.toMatchObject({
                attempts: 3,
                classification: null,
            });
            expect(fn).toHaveBeenCalledTimes(3);
        });
    });

    describe("execute() — exponential backoff timing", function () {
        afterEach(function () {
            vi.restoreAllMocks();
            vi.useRealTimers();
        });

        it("computes delays as min(base*2^(n-1), cap) with zero jitter observable at Math.random()=0", async function () {
            vi.spyOn(Math, "random").mockReturnValue(0);
            vi.useFakeTimers();
            const setTimeoutSpy = vi.spyOn(global, "setTimeout");

            const policy = new RetryPolicy({
                maxAttempts: 6,
                baseDelayMs: 200,
                maxDelayMs: 5000,
                classifier: RetryPolicy.classifyDbError,
                label: "backoff-timing-test",
            });

            let call = 0;
            const fn = vi.fn(async () => {
                call += 1;
                if (call <= 5) throw oraError(3113);
                return "done";
            });

            const promise = policy.execute(fn);
            await vi.runAllTimersAsync();
            const result = await promise;

            expect(result).toBe("done");
            expect(fn).toHaveBeenCalledTimes(6);

            const delays = setTimeoutSpy.mock.calls
                .map(([, ms]) => ms)
                .filter((ms) => typeof ms === "number" && ms >= 100);
            // base*2^0, base*2^1, base*2^2, base*2^3, base*2^4 — the 5th
            // exponential value (base*2^5=6400) would exceed the 5000 cap,
            // but only 5 backoffs occur here (6 attempts total).
            expect(delays).toEqual([200, 400, 800, 1600, 3200]);
        });

        it("caps the delay at maxDelayMs once the exponential value exceeds it", async function () {
            vi.spyOn(Math, "random").mockReturnValue(0);
            vi.useFakeTimers();
            const setTimeoutSpy = vi.spyOn(global, "setTimeout");

            const policy = new RetryPolicy({
                maxAttempts: 8,
                baseDelayMs: 200,
                maxDelayMs: 5000,
                classifier: RetryPolicy.classifyDbError,
                label: "backoff-cap-test",
            });

            let call = 0;
            const fn = vi.fn(async () => {
                call += 1;
                if (call <= 7) throw oraError(3113);
                return "done";
            });

            const promise = policy.execute(fn);
            await vi.runAllTimersAsync();
            await promise;

            const delays = setTimeoutSpy.mock.calls
                .map(([, ms]) => ms)
                .filter((ms) => typeof ms === "number" && ms >= 100);
            // 200, 400, 800, 1600, 3200, then capped at 5000, 5000
            expect(delays).toEqual([200, 400, 800, 1600, 3200, 5000, 5000]);
        });
    });

    describe("execute() — onRetry early-resolve (idempotency probe)", function () {
        it("resolves immediately with probe.resolved when onRetry finds a prior committed result", async function () {
            const policy = new RetryPolicy({
                maxAttempts: 5,
                baseDelayMs: 1,
                maxDelayMs: 5,
                classifier: RetryPolicy.classifyDbError,
            });
            const fn = vi.fn(async () => {
                throw oraError(3113);
            });
            const onRetry = vi.fn(async () => ({
                resolved: { TRXN_ID: "abc123" },
            }));

            const result = await policy.execute(fn, { onRetry });

            expect(result).toEqual({ TRXN_ID: "abc123" });
            expect(fn).toHaveBeenCalledTimes(1);
            expect(onRetry).toHaveBeenCalledTimes(1);
        });

        it("the onRetry probe still fires on the final (budget-exhausting) attempt", async function () {
            const policy = new RetryPolicy({
                maxAttempts: 1,
                classifier: RetryPolicy.classifyDbError,
            });
            const fn = vi.fn(async () => {
                throw oraError(3113);
            });
            const onRetry = vi.fn(async () => ({
                resolved: "found-on-last-try",
            }));

            const result = await policy.execute(fn, { onRetry });

            expect(result).toBe("found-on-last-try");
            expect(onRetry).toHaveBeenCalledTimes(1);
        });

        it("continues retrying when onRetry resolves without a `resolved` key", async function () {
            const policy = new RetryPolicy({
                maxAttempts: 3,
                baseDelayMs: 1,
                maxDelayMs: 5,
                classifier: RetryPolicy.classifyDbError,
            });
            let call = 0;
            const fn = vi.fn(async () => {
                call += 1;
                if (call < 2) throw oraError(3113);
                return "ok";
            });
            const onRetry = vi.fn(async () => undefined);

            const result = await policy.execute(fn, { onRetry });

            expect(result).toBe("ok");
            expect(onRetry).toHaveBeenCalledTimes(1);
        });

        it("onRetry is invoked with the caught error and current attempt number", async function () {
            const policy = new RetryPolicy({
                maxAttempts: 2,
                baseDelayMs: 1,
                maxDelayMs: 5,
                classifier: RetryPolicy.classifyDbError,
            });
            const err = oraError(3113);
            const fn = vi.fn(async () => {
                throw err;
            });
            const onRetry = vi.fn(async () => undefined);

            await expect(policy.execute(fn, { onRetry })).rejects.toThrow();

            expect(onRetry).toHaveBeenNthCalledWith(1, err, 1);
            expect(onRetry).toHaveBeenNthCalledWith(2, err, 2);
        });
    });

    // ─── execute() — observability trace (ATTEMPT_START/OK/FAIL, BACKOFF, IDEMPOTENT_RESOLVE) ───

    describe("execute() — observability logging", function () {
        let debugSpy;
        let infoSpy;

        beforeEach(function () {
            debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => {});
            infoSpy = vi.spyOn(logger, "info").mockImplementation(() => {});
        });

        afterEach(function () {
            vi.restoreAllMocks();
            vi.useRealTimers();
        });

        it("happy path logs ATTEMPT_START then ATTEMPT_OK, with structured meta (label, attempt)", async function () {
            const policy = new RetryPolicy({
                maxAttempts: 3,
                classifier: RetryPolicy.classifyDbError,
                label: "happy-path-test",
            });
            const fn = vi.fn().mockResolvedValue("ok");

            const result = await policy.execute(fn);

            expect(result).toBe("ok");

            const debugMessages = debugSpy.mock.calls.map(([msg]) => msg);
            expect(debugMessages.some((m) => m.includes("Attempt 1/3 starting"))).toBe(true);
            expect(debugMessages.some((m) => /Attempt 1 succeeded in \d+ms/.test(m))).toBe(true);

            const [startMsg, startMeta] = debugSpy.mock.calls[0];
            expect(startMsg).toContain("happy-path-test");
            expect(startMeta).toMatchObject({ label: "happy-path-test", attempt: 1, max: 3 });

            const [okMsg, okMeta] = debugSpy.mock.calls[1];
            expect(okMsg).toContain("happy-path-test");
            expect(okMeta).toMatchObject({ label: "happy-path-test", attempt: 1 });
            expect(typeof okMeta.ms).toBe("number");
        });

        it("a transient retry logs ATTEMPT_FAIL (debug, with classification) then BACKOFF (debug, with delayMs) before the retried attempt", async function () {
            vi.useFakeTimers();
            const policy = new RetryPolicy({
                maxAttempts: 3,
                baseDelayMs: 1,
                maxDelayMs: 5,
                classifier: RetryPolicy.classifyDbError,
                label: "retry-trace-test",
            });
            let call = 0;
            const fn = vi.fn(async () => {
                call += 1;
                if (call < 2) throw oraError(3113);
                return "recovered";
            });

            const promise = policy.execute(fn);
            await vi.runAllTimersAsync();
            const result = await promise;

            expect(result).toBe("recovered");

            const failCall = debugSpy.mock.calls.find(([msg]) => msg.includes("Attempt 1 failed"));
            expect(failCall).toBeDefined();
            const [failMsg, failMeta] = failCall;
            expect(failMsg).toContain("TRANSIENT_DB");
            expect(failMeta).toMatchObject({
                label: "retry-trace-test",
                attempt: 1,
                classification: "TRANSIENT_DB",
            });
            expect(typeof failMeta.cause).toBe("string");

            const backoffCall = debugSpy.mock.calls.find(([msg]) => msg.includes("Backing off"));
            expect(backoffCall).toBeDefined();
            const [, backoffMeta] = backoffCall;
            expect(backoffMeta).toMatchObject({ label: "retry-trace-test", attempt: 1 });
            expect(typeof backoffMeta.delayMs).toBe("number");
        });

        it("IDEMPOTENT_RESOLVE fires (info) with label + key when onRetry returns {resolved}", async function () {
            const policy = new RetryPolicy({
                maxAttempts: 5,
                baseDelayMs: 1,
                maxDelayMs: 5,
                classifier: RetryPolicy.classifyDbError,
                label: "ack-lost-test",
            });
            const fn = vi.fn(async () => {
                throw oraError(3113);
            });
            const onRetry = vi.fn(async () => ({
                resolved: { ID: "trxn-abc-123" },
            }));

            const result = await policy.execute(fn, { onRetry });

            expect(result).toEqual({ ID: "trxn-abc-123" });
            expect(infoSpy).toHaveBeenCalledTimes(1);
            const [infoMsg, infoMeta] = infoSpy.mock.calls[0];
            expect(infoMsg).toContain("ack-lost-test");
            expect(infoMsg).toContain("trxn-abc-123");
            expect(infoMeta).toMatchObject({ label: "ack-lost-test", attempt: 1, key: "trxn-abc-123" });
        });
    });

    // ─── requestId propagation (core deliverable — proves the trace is traceable) ───

    describe("execute() — requestId propagation via AsyncLocalStorage", function () {
        afterEach(function () {
            vi.restoreAllMocks();
        });

        it("every logger.log call made during execute() carries the ALS requestId, including across the backoff sleep", async function () {
            const observedRequestIds = [];
            vi.spyOn(logger, "log").mockImplementation(async (level, message, meta) => {
                // Read the ALS store synchronously, exactly like logger.log()
                // itself does internally — proves the context is still active
                // at the moment each call happens, even after an `await`
                // inside RetryPolicy (attempt loop, backoff sleep). Mocked
                // (no pass-through) so no real log file I/O happens in tests.
                observedRequestIds.push(requestContext.getStore()?.requestId ?? null);
            });

            const policy = new RetryPolicy({
                maxAttempts: 3,
                baseDelayMs: 1,
                maxDelayMs: 2,
                classifier: RetryPolicy.classifyDbError,
                label: "requestid-trace-test",
            });
            let call = 0;
            const fn = vi.fn(async () => {
                call += 1;
                if (call < 2) throw oraError(3113);
                return "ok";
            });

            const result = await requestContext.run({ requestId: "test-req-123" }, () =>
                policy.execute(fn),
            );

            expect(result).toBe("ok");
            // At least ATTEMPT_START, ATTEMPT_FAIL, RETRYING, BACKOFF, ATTEMPT_START, ATTEMPT_OK.
            expect(observedRequestIds.length).toBeGreaterThanOrEqual(4);
            expect(observedRequestIds.every((id) => id === "test-req-123")).toBe(true);
        });

        it("logger.log observes no requestId when called outside any requestContext.run()", async function () {
            const observedRequestIds = [];
            vi.spyOn(logger, "log").mockImplementation(async (level, message, meta) => {
                observedRequestIds.push(requestContext.getStore()?.requestId ?? null);
            });

            const policy = new RetryPolicy({
                maxAttempts: 1,
                classifier: RetryPolicy.classifyDbError,
                label: "no-context-test",
            });
            const fn = vi.fn().mockResolvedValue("ok");

            await policy.execute(fn);

            expect(observedRequestIds.length).toBeGreaterThan(0);
            expect(observedRequestIds.every((id) => id === null)).toBe(true);
        });
    });
});
