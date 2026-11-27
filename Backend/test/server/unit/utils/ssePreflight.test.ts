/**
 * @fileoverview Unit tests for src/utils/sse/ssePreflight.ts — the pre-upgrade
 * refusal helpers every SSE route uses.
 *
 * The contract under test: an SSE refusal carries the SAME six-key error
 * envelope as every other API error (`status, code, title, message, requestId,
 * error`), with `requestId` read from `req.id` so a client-reported failure can
 * be traced to a log line. The "nothing to stream" answer is a 200, not an error.
 */

import { sendSsePreflightError, sendSseNotStreamable } from "../../../../src/utils/sse/ssePreflight";

/** Minimal Express-like response capturing status + JSON body. */
function mockRes() {
    const res = {
        statusCode: 0 as number,
        body: undefined as unknown,
        status: vi.fn(function (this: typeof res, code: number) {
            this.statusCode = code;
            return this;
        }),
        json: vi.fn(function (this: typeof res, body: unknown) {
            this.body = body;
            return this;
        }),
    };
    return res;
}

describe("sendSsePreflightError", () => {
    it("sends requestId: null when the request carries no id (no TraceabilityMiddleware ran)", () => {
        const res = mockRes();
        sendSsePreflightError({} as never, res as never, "Too many streams", 429);
        expect(res.status).toHaveBeenCalledWith(429);
        expect(res.body).toMatchObject({ code: 429, requestId: null });
    });

    it("tolerates a missing req entirely (optional chaining) and still answers", () => {
        const res = mockRes();
        sendSsePreflightError(undefined as never, res as never, "Unavailable", 503);
        expect(res.statusCode).toBe(503);
        expect((res.body as { requestId: unknown }).requestId).toBeNull();
    });

    it("defaults opts: error.type falls back to AppError with no details/hint keys", () => {
        const res = mockRes();
        sendSsePreflightError({ id: "r-1" } as never, res as never, "Nope", 403);
        const body = res.body as { error: Record<string, unknown> };
        expect(body.error).toEqual({ type: "AppError" });
    });

    it("emits the full six-key error envelope with requestId taken from req.id", () => {
        const res = mockRes();
        sendSsePreflightError({ id: "0078812966528-0448-0001" } as never, res as never, "Forbidden scope", 403, {
            type: "AuthorizationError",
            details: [{ field: "scope", issue: "not permitted" }],
            hint: "Ask a SUPER_ADMIN.",
        });
        expect(res.status).toHaveBeenCalledTimes(1);
        expect(res.json).toHaveBeenCalledTimes(1);
        expect(Object.keys(res.body as object).sort()).toEqual(
            ["code", "error", "message", "requestId", "status", "title"],
        );
        expect(res.body).toMatchObject({
            status: "error",
            code: 403,
            title: expect.any(String),
            message: "Forbidden scope",
            requestId: "0078812966528-0448-0001",
            error: {
                type: "AuthorizationError",
                details: [{ field: "scope", issue: "not permitted" }],
                hint: "Ask a SUPER_ADMIN.",
            },
        });
    });

    it("a caller-supplied requestId in opts cannot override req.id", () => {
        const res = mockRes();
        sendSsePreflightError({ id: "real-id" } as never, res as never, "x", 400, {
            requestId: "spoofed",
        } as never);
        expect((res.body as { requestId: string }).requestId).toBe("real-id");
    });
});

describe("sendSseNotStreamable", () => {
    it("answers 200 with { streamable: false, reason } — a routine outcome, not an error", () => {
        const res = mockRes();
        sendSseNotStreamable(res as never, "NOT_CURRENT_CUTOFF");
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.body).toEqual({ streamable: false, reason: "NOT_CURRENT_CUTOFF" });
    });
});
