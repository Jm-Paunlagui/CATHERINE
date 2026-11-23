/**
 * @fileoverview ErrorHandlerMiddleware wave 2: classifier branches (JWT, body
 * parser, multer, Oracle, fallback), envelope shape, Retry-After, headers-sent,
 * watchdog guard, notFound and response-body capture.
 */
import { EventEmitter } from "events";

const log = vi.hoisted(() => ({ notice: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock("../../../../src/utils/logger", () => ({ logger: log }));

import { ErrorHandlerMiddleware } from "../../../../src/middleware/errorHandling/ErrorHandlerMiddleware";

const cors = { applyToErrorResponse: vi.fn((_req: unknown, _res: unknown, done: () => void) => done()) };

function mkRes(extra: Record<string, unknown> = {}) {
    const res: any = {
        locals: {},
        headersSent: false,
        writableEnded: false,
        hdrs: {} as Record<string, string>,
        getHeader(k: string) { return this.hdrs[k]; },
        setHeader(k: string, v: string) { this.hdrs[k] = v; },
        status(c: number) { this.code = c; return this; },
        json(b: unknown) { this.body = b; return this; },
        destroy: vi.fn(),
        ...extra,
    };
    return res;
}
const mkReq = (over: Record<string, unknown> = {}) =>
    ({ originalUrl: "/api/v1/x", method: "GET", ip: "1.2.3.4", id: "rid-1", headers: {}, ...over }) as any;
const named = (name: string, message: string, extra: Record<string, unknown> = {}) =>
    Object.assign(new Error(message), { name }, extra) as any;

describe("ErrorHandlerMiddleware wave2", () => {
    let h: ErrorHandlerMiddleware;
    const env = process.env.NODE_ENV;
    beforeEach(() => {
        h = new ErrorHandlerMiddleware({ cors: cors as any });
        Object.values(log).forEach((f) => f.mockClear());
        cors.applyToErrorResponse.mockClear();
    });
    afterEach(() => { process.env.NODE_ENV = env; });

    it("default constructor resolves the shared CORS policy", () => {
        const d = new ErrorHandlerMiddleware();
        expect(typeof d._cors.applyToErrorResponse).toBe("function");
    });

    it.each([
        ["JsonWebTokenError", /malformed/i],
        ["TokenExpiredError", /expired/i],
        ["NotBeforeError", /not yet valid/i],
    ])("%s -> 401 AuthenticationError", (name, msg) => {
        const res = mkRes();
        h.handle(named(name, "jwt"), mkReq(), res, null);
        expect(res.code).toBe(401);
        expect(res.body.error.type).toBe("AuthenticationError");
        expect(res.body.message).toMatch(msg);
    });

    it.each([
        [{ type: "entity.parse.failed" }, 400, "ParseError"],
        [{ type: "entity.too.large" }, 413, "PayloadTooLargeError"],
        [{ type: "encoding.unsupported" }, 415, "UnsupportedMediaTypeError"],
    ])("body-parser %o -> %i %s", (extra, code, type) => {
        const res = mkRes();
        h.handle(named("Error", "x", extra), mkReq(), res, null);
        expect(res.code).toBe(code);
        expect(res.body.error.type).toBe(type);
    });

    it("status 400 with 'invalid' in message passes the message through as BadRequestError", () => {
        const res = mkRes();
        h.handle(named("Error", "Invalid header value", { status: 400 }), mkReq(), res, null);
        expect(res.code).toBe(400);
        expect(res.body.message).toBe("Invalid header value");
        expect(res.body.error.type).toBe("BadRequestError");
    });

    it("status 400 without 'invalid' falls through to the generic envelope", () => {
        const res = mkRes();
        h.handle(named("Error", "nope", { status: 400 }), mkReq(), res, null);
        expect(res.code).toBe(400);
        expect(res.body.message).toBe("Internal server error");
    });

    it.each([
        ["LIMIT_FILE_SIZE", 413, "PayloadTooLargeError", /maximum allowed size/],
        ["LIMIT_FILE_COUNT", 400, "ValidationError", /Too many files/],
        ["LIMIT_UNEXPECTED_FILE", 400, "ValidationError", /unexpected field/],
    ])("MulterError %s", (code, status, type, msg) => {
        const res = mkRes();
        h.handle(named("MulterError", "unexpected field", { code }), mkReq(), res, null);
        expect(res.code).toBe(status);
        expect(res.body.error.type).toBe(type);
        expect(res.body.message).toMatch(msg);
    });

    it("operational error: uses status, name, details, hint, reasons", () => {
        const res = mkRes();
        h.handle(named("ValidationError", "bad", { isOperational: true, statusCode: 422, details: [{ f: 1 }], hint: "fix", reasons: ["r"] }), mkReq(), res, null);
        expect(res.code).toBe(422);
        expect(res.body.error).toMatchObject({ type: "ValidationError", details: [{ f: 1 }], hint: "fix", reasons: ["r"] });
        expect(log.warning).toHaveBeenCalled();
    });

    it("operational error without a status defaults to 500, and uses err.status and AppError type fallback", () => {
        const a = mkRes();
        h.handle(Object.assign(new Error("boom"), { name: "", isOperational: true }), mkReq(), a, null);
        expect(a.code).toBe(500);
        expect(a.body.error.type).toBe("AppError");
        const b = mkRes();
        h.handle(Object.assign(new Error("teapot"), { isOperational: true, status: 418 }), mkReq(), b, null);
        expect(b.code).toBe(418);
    });

    it("unknown ORA code maps to a generic 500 without leaking the raw message", () => {
        const res = mkRes();
        h.handle(new Error("ORA-99999: SELECT secret FROM t WHERE a=:1"), mkReq(), res, null);
        expect(res.code).toBe(500);
        expect(res.body.error.type).toBe("DatabaseError");
        expect(res.body.error.hint).toBe("ORA-99999");
        expect(JSON.stringify(res.body)).not.toMatch(/secret|SELECT/);
        expect(log.error).toHaveBeenCalledWith(expect.stringContaining("SELECT secret"), expect.any(Object));
    });

    it("unknown NJS code falls back to 503 DatabaseUnavailableError", () => {
        const res = mkRes();
        h.handle(new Error("NJS-99999 something"), mkReq(), res, null);
        expect(res.code).toBe(503);
        expect(res.body.error.type).toBe("DatabaseUnavailableError");
    });

    it("NJS-076 sets Retry-After: 1 unless one is already set", () => {
        const res = mkRes();
        h.handle(new Error("NJS-076: queue is full"), mkReq(), res, null);
        expect(res.code).toBe(429);
        expect(res.hdrs["Retry-After"]).toBe("1");
        const pre = mkRes();
        pre.hdrs["Retry-After"] = "30";
        h.handle(new Error("NJS-076: queue is full"), mkReq(), pre, null);
        expect(pre.hdrs["Retry-After"]).toBe("30");
    });

    it("retryAfterSec on an operational error becomes Retry-After and a notice-level log for the drain type", () => {
        const res = mkRes();
        h.handle(named("ServerShuttingDown", "draining", { isOperational: true, statusCode: 503, retryAfterSec: 5 }), mkReq(), res, null);
        expect(res.hdrs["Retry-After"]).toBe("5");
        expect(log.notice).toHaveBeenCalled();
        expect(log.error).not.toHaveBeenCalled();
        const pre = mkRes();
        pre.hdrs["Retry-After"] = "9";
        h.handle(named("ServerShuttingDown", "draining", { isOperational: true, statusCode: 503, retryAfterSec: 5 }), mkReq(), pre, null);
        expect(pre.hdrs["Retry-After"]).toBe("9");
    });

    it("5xx logs at error with stack; 4xx logs at warning", () => {
        h.handle(new Error("kaboom"), mkReq(), mkRes(), null);
        expect(log.error).toHaveBeenCalledWith("kaboom", expect.objectContaining({ statusCode: 500, stack: expect.any(String), requestId: "rid-1" }));
        h.handle(named("JsonWebTokenError", "bad"), mkReq(), mkRes(), null);
        expect(log.warning).toHaveBeenCalled();
    });

    it("fallback keeps an explicit status and hides the error name in production", () => {
        process.env.NODE_ENV = "production";
        const res = mkRes();
        h.handle(named("CustomErr", "x", { status: 502 }), mkReq(), res, null);
        expect(res.code).toBe(502);
        expect(res.body.error.type).toBe("InternalError");
        process.env.NODE_ENV = "test";
        const res2 = mkRes();
        h.handle(named("CustomErr", "x"), mkReq(), res2, null);
        expect(res2.body.error.type).toBe("CustomErr");
    });

    it("stack is exposed only in development", () => {
        process.env.NODE_ENV = "development";
        const dev = mkRes();
        h.handle(new Error("x"), mkReq(), dev, null);
        expect(typeof dev.body.error.stack).toBe("string");
        for (const e of ["production", "test"]) {
            process.env.NODE_ENV = e;
            const r = mkRes();
            h.handle(new Error("x"), mkReq(), r, null);
            expect(r.body.error).not.toHaveProperty("stack");
        }
    });

    it("requestId is null when the request has none", () => {
        const res = mkRes();
        h.handle(new Error("x"), mkReq({ id: undefined }), res, null);
        expect(res.body.requestId).toBeNull();
    });

    it("watchdog-terminated responses are ignored entirely", () => {
        const res = mkRes({ locals: { __watchdogTerminated: true } });
        h.handle(new Error("late"), mkReq(), res, null);
        expect(res.body).toBeUndefined();
        expect(log.error).not.toHaveBeenCalled();
    });

    it("res.locals missing is tolerated", () => {
        const res = mkRes({ locals: undefined });
        h.handle(new Error("x"), mkReq(), res, null);
        expect(res.code).toBe(500);
    });

    it("headers already sent: destroys an open response, leaves a finished one", () => {
        const open = mkRes({ headersSent: true });
        h.handle(new Error("mid-stream"), mkReq(), open, null);
        expect(open.destroy).toHaveBeenCalled();
        expect(open.body).toBeUndefined();
        const done = mkRes({ headersSent: true, writableEnded: true });
        h.handle(new Error("mid-stream"), mkReq(), done, null);
        expect(done.destroy).not.toHaveBeenCalled();
    });

    it("sends via the CORS policy", () => {
        h.handle(new Error("x"), mkReq(), mkRes(), null);
        expect(cors.applyToErrorResponse).toHaveBeenCalledOnce();
    });

    it("notFoundHandler returns a 404 envelope", () => {
        const res = mkRes();
        h.notFoundHandler(mkReq({ method: "POST", originalUrl: "/nope" }), res, null);
        expect(res.code).toBe(404);
        expect(res.body.message).toBe("Route POST /nope not found");
        expect(res.body.error.type).toBe("NotFoundError");
    });

    describe("captureResponseBody", () => {
        function capRes() {
            const written: unknown[] = [];
            const res: any = mkRes();
            res.write = vi.fn((c: unknown) => { written.push(c); return true; });
            res.end = vi.fn();
            return res;
        }
        it("skips SSE requests", () => {
            const res = capRes();
            const origWrite = res.write;
            const next = vi.fn();
            h.captureResponseBody(mkReq({ headers: { accept: "text/event-stream" } }), res, next);
            expect(next).toHaveBeenCalled();
            expect(res.write).toBe(origWrite);
        });
        it("captures string and Buffer chunks and still forwards them", () => {
            const res = capRes();
            const origWrite = res.write, origEnd = res.end;
            const next = vi.fn();
            h.captureResponseBody(mkReq(), res, next);
            res.write("ab");
            res.write(Buffer.from("cd"));
            res.end("ef");
            expect(res.locals.body).toBe("abcdef");
            expect(origWrite).toHaveBeenCalledTimes(2);
            expect(origEnd).toHaveBeenCalledWith("ef");
            expect(next).toHaveBeenCalled();
        });
        it("end() with no chunk captures what was written", () => {
            const res = capRes();
            h.captureResponseBody(mkReq(), res, vi.fn());
            res.write("only");
            res.end();
            expect(res.locals.body).toBe("only");
        });
        it("caps capture at 64 KiB via write and via end", () => {
            const a = capRes();
            h.captureResponseBody(mkReq(), a, vi.fn());
            a.write(Buffer.alloc(64 * 1024 + 1));
            a.write("more"); // already capped
            a.end("tail");
            expect(a.locals.body).toMatch(/too large/);
            const b = capRes();
            h.captureResponseBody(mkReq(), b, vi.fn());
            b.end(Buffer.alloc(64 * 1024 + 1));
            expect(b.locals.body).toMatch(/too large/);
        });
    });
});
