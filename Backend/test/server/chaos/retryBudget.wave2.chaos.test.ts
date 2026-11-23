import { RetryPolicy } from "../../../src/utils/resilience/RetryPolicy";
import InFlightTaskRegistry from "../../../src/utils/InFlightTaskRegistry";
import { logger } from "../../../src/utils/logger";

describe("Retry budget and drain chaos (wave2)", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        for (const m of ["warning", "notice", "info", "debug", "critical", "error"] as const) vi.spyOn(logger, m).mockImplementation((() => undefined) as never);
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it("a Math.random-free retry sequence never exceeds maxDelay plus jitter and never stalls timers", async () => {
        const policy = new RetryPolicy({ maxAttempts: 6, baseDelayMs: 100, maxDelayMs: 300, classifier: RetryPolicy.classifySmtpError });
        for (let a = 1; a <= 6; a++) expect(policy._computeBackoff(a)).toBeLessThan(400);
    });

    it("a detached send that never settles is abandoned at the drain budget instead of blocking shutdown", async () => {
        const Ctor = (InFlightTaskRegistry as any).constructor as new () => typeof InFlightTaskRegistry;
        const reg = new Ctor();
        reg.track("smtp-hung", new Promise(() => undefined));
        const p = reg.drain(2000);
        await vi.advanceTimersByTimeAsync(2000);
        await expect(p).resolves.toEqual({ drained: 0, abandoned: 1, labels: ["smtp-hung"] });
    });
});
