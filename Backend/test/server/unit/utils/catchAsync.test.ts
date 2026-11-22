"use strict";

const { catchAsync } = require("../../../../src/utils/catchAsync");

describe("catchAsync", function () {
    function mockReq() {
        return { method: "GET", path: "/test" };
    }

    function mockRes() {
        return {
            _status: undefined as any,
            _body: undefined as any,
            status(code) {
                this._status = code;
                return this;
            },
            json(body) {
                this._body = body;
                return this;
            },
        };
    }

    it("returns a function", function () {
        const wrapped = catchAsync(async () => {});
        expect(wrapped).toBeInstanceOf(Function);
    });

    it("calls the wrapped function with req, res, next", async function () {
        // Was a mocha-style `done` test: Vitest passes a context object, not `done`, so the
        // call threw inside the handler and catchAsync routed it to the stub next() — the
        // test could pass without its assertions ever running.
        const req = mockReq();
        const res = mockRes();
        const next = vi.fn();
        const seen: unknown[] = [];

        const wrapped = catchAsync(async (r, s, n) => {
            seen.push(r, s, n);
        });

        wrapped(req, res, next);
        await new Promise((r) => setImmediate(r));

        expect(seen[0]).toBe(req);
        expect(seen[1]).toBe(res);
        expect(seen[2]).toBe(next);
        expect(next).not.toHaveBeenCalled();
    });

    it("calls next() with the error when the async function rejects", () => new Promise<void>((resolve, reject) => {
        const done = (e?) => e ? reject(e) : resolve();

        const error = new Error("test failure");

        const wrapped = catchAsync(async () => {
            throw error;
        });

        wrapped(mockReq(), mockRes(), (err) => {
            expect(err).toBe(error);
            done();
        });
    
        }));

    it("does not call next() when the async function resolves", () => new Promise<void>((resolve, reject) => {
        const done = (e?) => e ? reject(e) : resolve();

        const wrapped = catchAsync(async (req, res) => {
            res.json({ ok: true });
        });

        const res = mockRes();
        let nextCalled = false;

        wrapped(mockReq(), res, () => {
            nextCalled = true;
        });

        setTimeout(() => {
            expect(nextCalled).toBe(false);
            expect(res._body).toEqual({ ok: true });
            done();
        }, 20);
    
        }));

    it("handles synchronous functions that return a value", () => new Promise<void>((resolve, reject) => {
        const done = (e?) => e ? reject(e) : resolve();

        const wrapped = catchAsync((req, res) => {
            res.json({ sync: true });
        });

        const res = mockRes();
        wrapped(mockReq(), res, (_err) => {
            done(new Error("next should not be called"));
        });

        setTimeout(() => {
            expect(res._body).toEqual({ sync: true });
            done();
        }, 20);
    
        }));

    it("forwards synchronous throws to next()", () => new Promise<void>((resolve, reject) => {
        const done = (e?) => e ? reject(e) : resolve();

        const error = new Error("sync throw");
        const wrapped = catchAsync(() => {
            throw error;
        });

        wrapped(mockReq(), mockRes(), (err) => {
            expect(err).toBe(error);
            done();
        });
    
        }));
});
