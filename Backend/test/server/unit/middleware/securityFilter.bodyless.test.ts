"use strict";

/**
 * @fileoverview Unit — SecurityFilterMiddleware GET/HEAD body guard (CVE-2026-123864).
 *
 * A GET/HEAD that declares a body (any Transfer-Encoding, or Content-Length > 0)
 * is refused 400 BodyNotAllowedError at chain step 2, with Connection: close,
 * one warning line (method, path, ip only), no strike, and regardless of the
 * method whitelist. The guard is the LAST check, so every existing refusal keeps
 * its status and strike (U9).
 *
 * Mocks are local on purpose: securityFilter.test.js's mocks lack `headers` and
 * `setHeader`, and U13/U14 lock in that such requests/responses still work.
 */

const {
    SecurityFilterMiddleware,
} = require("../../../../src/middleware/security/SecurityFilterMiddleware");
const { logger } = require("../../../../src/utils/logger");
const {
    middlewareMessages,
} = require("../../../../src/constants/messages/middleware.messages");
const { REQUEST_ERRORS } = require("../../../../src/constants/errors");

const IP = "127.0.0.1";

function mockReq({ method = "GET", path = "/api/v1/health/stream", headers, omitHeaders = false }: Record<string, any> = {}) {
    const req: Record<string, any> = {
        ip: IP,
        path,
        originalUrl: path,
        method,
        connection: { remoteAddress: IP },
    };
    if (!omitHeaders) req.headers = headers ?? {};
    return req;
}

function mockRes({ withSetHeader = true }: Record<string, any> = {}) {
    let _status, _body;
    const _headers: Record<string, any> = {};
    const res: Record<string, any> = {
        _headers,
        get _status() {
            return _status;
        },
        get _body() {
            return _body;
        },
        status(c) {
            _status = c;
            return this;
        },
        json(b) {
            _body = b;
            return this;
        },
    };
    if (withSetHeader) {
        res.setHeader = (k, v) => {
            _headers[String(k).toLowerCase()] = v;
        };
    }
    return res;
}

/** Runs the filter once; returns { res, next } with `next` a vi.fn. */
function run(filter, reqOpts, resOpts?) {
    const req = mockReq(reqOpts);
    const res = mockRes(resOpts);
    const next = vi.fn();
    filter.handle(req, res, next);
    return { req, res, next };
}

function expectRefused({ res, next }) {
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(400);
    expect(res._body?.error?.type).toBe("BodyNotAllowedError");
}

let warnSpy;
beforeEach(function () {
    warnSpy = vi.spyOn(logger, "warning").mockImplementation(() => {});
});
afterEach(function () {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});

describe("SecurityFilterMiddleware — GET/HEAD body guard (unit)", function () {
    it("U1: GET with Transfer-Encoding: chunked → 400 BodyNotAllowedError envelope", function () {
        const filter = new SecurityFilterMiddleware();
        const out = run(filter, { headers: { "transfer-encoding": "chunked" } });
        expectRefused(out);
        expect(out.res._body.message).toBe(REQUEST_ERRORS.BODY_NOT_ALLOWED);
        expect(out.res._body.code).toBe(400);
        expect(out.res._body.requestId).toBeTruthy();
    });

    it("U2: GET with Content-Length: 5 → 400", function () {
        const filter = new SecurityFilterMiddleware();
        expectRefused(run(filter, { path: "/api/v1/health/live", headers: { "content-length": "5" } }));
    });

    it("U3: HEAD with Transfer-Encoding: chunked → 400", function () {
        const filter = new SecurityFilterMiddleware();
        expectRefused(run(filter, { method: "HEAD", headers: { "transfer-encoding": "chunked" } }));
    });

    it("U4: any Transfer-Encoding value (empty, identity) → 400", function () {
        const filter = new SecurityFilterMiddleware();
        expectRefused(run(filter, { headers: { "transfer-encoding": "" } }));
        expectRefused(run(filter, { headers: { "transfer-encoding": "identity" } }));
    });

    it("U5: whitelisted /health is not exempt → 400", function () {
        const filter = new SecurityFilterMiddleware();
        expectRefused(run(filter, { path: "/health", headers: { "content-length": "5" } }));
    });

    it("U6: refusal logs once (method/path/ip only), sets Connection: close, no strike", function () {
        const filter = new SecurityFilterMiddleware();
        const path = "/api/v1/health/stream";
        const out = run(filter, { path, headers: { "transfer-encoding": "chunked", "content-length": "5" } });
        expectRefused(out);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        const expected = middlewareMessages.GET_BODY_REFUSED?.(IP, "GET", path);
        expect(expected).toBeTypeOf("string");
        expect(warnSpy).toHaveBeenCalledWith(expected);
        const logged = warnSpy.mock.calls[0][0];
        expect(logged).not.toContain("chunked");
        expect(logged).not.toContain("5");
        expect(out.res._headers.connection).toBe("close");
        expect(filter._suspiciousIPs.size).toBe(0);
    });

    it("U7 (control): Content-Length 0 / 000 / no body headers → next()", function () {
        const filter = new SecurityFilterMiddleware();
        for (const headers of [{ "content-length": "0" }, { "content-length": "000" }, {}]) {
            const { next, res } = run(filter, { headers });
            expect(next).toHaveBeenCalledTimes(1);
            expect(res._status).toBeUndefined();
        }
    });

    it("U8 (control): POST / PUT / PATCH / DELETE with chunked body → next()", function () {
        const filter = new SecurityFilterMiddleware();
        for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
            const { next } = run(filter, { method, path: "/api/v1/metrics/frontend", headers: { "transfer-encoding": "chunked" } });
            expect(next).toHaveBeenCalledTimes(1);
        }
    });

    it("U9: precedence — GET /.env with Content-Length 5 stays 404 NotFound with one strike", function () {
        const filter = new SecurityFilterMiddleware();
        const { res, next } = run(filter, { path: "/.env", headers: { "content-length": "5" } });
        expect(next).not.toHaveBeenCalled();
        expect(res._status).toBe(404);
        expect(res._body.error.type).toBe("NotFound");
        expect(filter._suspiciousIPs.get(IP)?.count).toBe(1);
    });

    it("U10 (control): option rejectBodyOnBodylessMethods:false disables the guard", function () {
        const filter = new SecurityFilterMiddleware({ rejectBodyOnBodylessMethods: false });
        const { next } = run(filter, { headers: { "transfer-encoding": "chunked" } });
        expect(next).toHaveBeenCalledTimes(1);
    });

    describe("U11: SECURITY_FILTER_REJECT_GET_BODY env switch", function () {
        it("exact 'false' disables (control)", function () {
            vi.stubEnv("SECURITY_FILTER_REJECT_GET_BODY", "false");
            const filter = new SecurityFilterMiddleware();
            const { next } = run(filter, { headers: { "transfer-encoding": "chunked" } });
            expect(next).toHaveBeenCalledTimes(1);
        });

        it.each([["FALSE"], ["0"]])("%s leaves the guard on → 400", function (value) {
            vi.stubEnv("SECURITY_FILTER_REJECT_GET_BODY", value);
            const filter = new SecurityFilterMiddleware();
            expectRefused(run(filter, { headers: { "transfer-encoding": "chunked" } }));
        });

        it("unset leaves the guard on → 400", function () {
            vi.stubEnv("SECURITY_FILTER_REJECT_GET_BODY", undefined);
            const filter = new SecurityFilterMiddleware();
            expectRefused(run(filter, { headers: { "transfer-encoding": "chunked" } }));
        });
    });

    it("U12: Content-Length '5abc' is not a body; ' 7 ' is → 400", function () {
        const filter = new SecurityFilterMiddleware();
        const loose = run(filter, { headers: { "content-length": "5abc" } });
        expect(loose.next).toHaveBeenCalledTimes(1);
        expectRefused(run(filter, { headers: { "content-length": " 7 " } }));
    });

    it("U13 (control): request with no headers property → next(), no throw", function () {
        const filter = new SecurityFilterMiddleware();
        let out;
        expect(() => {
            out = run(filter, { omitHeaders: true });
        }).not.toThrow();
        expect(out.next).toHaveBeenCalledTimes(1);
    });

    it("U14: response without setHeader still refuses 400, no throw", function () {
        const filter = new SecurityFilterMiddleware();
        let out;
        expect(() => {
            out = run(filter, { headers: { "transfer-encoding": "chunked" } }, { withSetHeader: false });
        }).not.toThrow();
        expectRefused(out);
    });
});
