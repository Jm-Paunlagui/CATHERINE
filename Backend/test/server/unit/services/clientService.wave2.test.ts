import ClientService from "../../../../src/services/ClientService";
import { logger } from "../../../../src/utils/logger";

describe("ClientService (wave2)", () => {
    afterEach(() => vi.restoreAllMocks());

    describe("logError", () => {
        it("logs the payload with the user id", async () => {
            const spy = vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
            await ClientService.logError(
                { message: "boom", stack: "s", componentStack: "c", url: "/x", userAgent: "ua", timestamp: "t" },
                { userId: "u1" } as never,
            );
            expect(spy).toHaveBeenCalledTimes(1);
            const [msg, meta] = spy.mock.calls[0] as [string, Record<string, unknown>];
            expect(msg).toContain("u1");
            expect(meta).toEqual({ message: "boom", stack: "s", componentStack: "c", url: "/x", userAgent: "ua", timestamp: "t" });
        });

        it("falls back to 'unknown' user and tolerates a missing payload", async () => {
            const spy = vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
            await ClientService.logError(undefined as never, undefined);
            const [msg, meta] = spy.mock.calls[0] as [string, Record<string, unknown>];
            expect(msg).toContain("unknown");
            expect(meta.message).toBeUndefined();
        });
    });

    describe("logHelpMiss", () => {
        it("logs a warning with surface, user and role", async () => {
            const spy = vi.spyOn(logger, "warning").mockImplementation(() => undefined as never);
            await ClientService.logHelpMiss({ query: " reset pw ", surface: "assistant" }, { userId: "u2", role: "admin" });
            const [msg, meta] = spy.mock.calls[0] as [string, Record<string, unknown>];
            expect(msg).toContain("reset pw");
            expect(meta).toEqual({ query: "reset pw", surface: "assistant", userId: "u2", role: "admin" });
        });

        it("accepts the 'center' surface", async () => {
            const spy = vi.spyOn(logger, "warning").mockImplementation(() => undefined as never);
            await ClientService.logHelpMiss({ query: "q", surface: "center" }, undefined);
            expect((spy.mock.calls[0][1] as Record<string, unknown>).surface).toBe("center");
        });

        it("defaults unknown surface, user and role", async () => {
            const spy = vi.spyOn(logger, "warning").mockImplementation(() => undefined as never);
            await ClientService.logHelpMiss({ query: "q", surface: "evil" }, undefined);
            expect(spy.mock.calls[0][1]).toEqual({ query: "q", surface: "unknown", userId: "unknown", role: "unknown" });
        });

        it("strips control characters so a query cannot forge log lines", async () => {
            const spy = vi.spyOn(logger, "warning").mockImplementation(() => undefined as never);
            await ClientService.logHelpMiss({ query: "a\r\nFAKE\u0000line" }, undefined);
            expect((spy.mock.calls[0][1] as Record<string, unknown>).query).toBe("a FAKE line");
        });

        it("truncates to 120 characters", async () => {
            const spy = vi.spyOn(logger, "warning").mockImplementation(() => undefined as never);
            await ClientService.logHelpMiss({ query: "x".repeat(500) }, undefined);
            expect((spy.mock.calls[0][1] as { query: string }).query).toHaveLength(120);
        });

        it("drops blank, whitespace-only, control-only and non-string queries", async () => {
            const spy = vi.spyOn(logger, "warning").mockImplementation(() => undefined as never);
            await ClientService.logHelpMiss({ query: "   " }, undefined);
            await ClientService.logHelpMiss({ query: "\n\t" }, undefined);
            await ClientService.logHelpMiss({ query: 7 as never }, undefined);
            await ClientService.logHelpMiss(undefined as never, undefined);
            expect(spy).not.toHaveBeenCalled();
        });
    });
});
