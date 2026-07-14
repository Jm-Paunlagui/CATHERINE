"use strict";

/**
 * @fileoverview Unit tests for ErrorHandlerMiddleware's NJS-code and
 * adapter-level transient-string-pattern classification branches (Phase 2 of
 * the Data Protection reliability layer). Also asserts the pre-existing
 * ORA-XXXXX and AppError classification paths are unaffected.
 */

const {
    ErrorHandlerMiddleware,
} = require("../../../../src/middleware/errorHandling/ErrorHandlerMiddleware");

function mockReq() {
    return {
        originalUrl: "/api/v1/batch/save",
        method: "POST",
        ip: "127.0.0.1",
        id: "req_test123",
    };
}

function mockRes() {
    return {
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

describe("ErrorHandlerMiddleware — NJS + transient string classification", function () {
    let handler;

    beforeEach(function () {
        handler = new ErrorHandlerMiddleware();
    });

    describe("NJS-XXX driver errors", function () {
        it("NJS-040 (pool exhausted) → 503 DatabaseUnavailableError with a retryable hint", function () {
            const err = new Error("NJS-040: connection request timeout");
            const res = mockRes();

            handler.handle(err, mockReq(), res, () => {});

            expect(res._status).toBe(503);
            expect(res._body.status).toBe("error");
            expect(res._body.error.type).toBe("DatabaseUnavailableError");
            expect(res._body.error.hint).toMatch(/retried/i);
            // Client-facing message is sanitised — never echoes the raw NJS code.
            expect(res._body.message).not.toMatch(/NJS-040/);
        });

        it("NJS-500 (connection closed) → 503 DatabaseUnavailableError", function () {
            const err = new Error(
                "NJS-500: connection to the database was terminated",
            );
            const res = mockRes();

            handler.handle(err, mockReq(), res, () => {});

            expect(res._status).toBe(503);
            expect(res._body.error.type).toBe("DatabaseUnavailableError");
        });

        it.each(["501", "503", "510"])(
            "NJS-%s → 503 DatabaseUnavailableError",
            (code) => {
                const err = new Error(`NJS-${code}: simulated driver error`);
                const res = mockRes();

                handler.handle(err, mockReq(), res, () => {});

                expect(res._status).toBe(503);
                expect(res._body.error.type).toBe("DatabaseUnavailableError");
            },
        );

        it("an unmapped NJS code still classifies as DatabaseUnavailableError with a generic message", function () {
            const err = new Error("NJS-999: some future driver error");
            const res = mockRes();

            handler.handle(err, mockReq(), res, () => {});

            expect(res._status).toBe(503);
            expect(res._body.error.type).toBe("DatabaseUnavailableError");
            expect(res._body.message).toBe(
                "A database connection error occurred.",
            );
        });

        it("classifies an adapter-wrapped NJS message (DB_OP_FAILED prefix) without needing to unwrap originalError", function () {
            const err = Object.assign(
                new Error(
                    "DB op failed [userAccount]: NJS-040: connection request timeout",
                ),
                { originalError: new Error("NJS-040: connection request timeout") },
            );
            const res = mockRes();

            handler.handle(err, mockReq(), res, () => {});

            expect(res._status).toBe(503);
            expect(res._body.error.type).toBe("DatabaseUnavailableError");
        });
    });

    describe("adapter-level transient string patterns", function () {
        it('"Timed out getting connection" → 504 DatabaseTimeoutError with a retryable hint', function () {
            const err = new Error(
                'DB op failed [userAccount]: Timed out getting connection from "userAccount"',
            );
            const res = mockRes();

            handler.handle(err, mockReq(), res, () => {});

            expect(res._status).toBe(504);
            expect(res._body.error.type).toBe("DatabaseTimeoutError");
            expect(res._body.error.hint).toMatch(/retried/i);
        });

        it("matches case-insensitively and without needing to unwrap originalError", function () {
            const err = Object.assign(
                new Error(
                    'DB op failed [reporting]: TIMED OUT GETTING CONNECTION from "reporting"',
                ),
                { originalError: new Error("some inner driver detail") },
            );
            const res = mockRes();

            handler.handle(err, mockReq(), res, () => {});

            expect(res._status).toBe(504);
            expect(res._body.error.type).toBe("DatabaseTimeoutError");
        });
    });

    describe("existing ORA-XXXXX mapping is unaffected", function () {
        it("ORA-00001 (unique constraint) still maps to 409 DatabaseError", function () {
            const err = new Error("ORA-00001: unique constraint (X.PK) violated");
            const res = mockRes();

            handler.handle(err, mockReq(), res, () => {});

            expect(res._status).toBe(409);
            expect(res._body.error.type).toBe("DatabaseError");
            expect(res._body.error.hint).toBe("ORA-00001");
        });

        it("ORA-12541 (no listener) still maps to 503 DatabaseError via the ORA branch, not the NJS branch", function () {
            const err = new Error("ORA-12541: TNS:no listener");
            const res = mockRes();

            handler.handle(err, mockReq(), res, () => {});

            expect(res._status).toBe(503);
            expect(res._body.error.type).toBe("DatabaseError");
            expect(res._body.error.hint).toBe("ORA-12541");
        });

        it("an ORA-XXXXX message wins over the NJS branch even if the text also mentions NJS", function () {
            // The ORA branch is checked first — an ORA code anywhere in the
            // message must still classify via _classifyOracle.
            const err = new Error(
                "ORA-03113: end-of-file on communication channel (NJS wrapper)",
            );
            const res = mockRes();

            handler.handle(err, mockReq(), res, () => {});

            expect(res._status).toBe(503);
            expect(res._body.error.type).toBe("DatabaseError");
            expect(res._body.error.hint).toBe("ORA-03113");
        });
    });

    describe("other existing branches are unaffected", function () {
        it("AppError is still classified via the isOperational branch", function () {
            const err = Object.assign(new Error("Custom business error"), {
                isOperational: true,
                statusCode: 422,
                name: "ValidationError",
            });
            const res = mockRes();

            handler.handle(err, mockReq(), res, () => {});

            expect(res._status).toBe(422);
            expect(res._body.error.type).toBe("ValidationError");
        });

        it("JWT TokenExpiredError is still classified as 401 AuthenticationError", function () {
            const err = new Error("jwt expired");
            err.name = "TokenExpiredError";
            const res = mockRes();

            handler.handle(err, mockReq(), res, () => {});

            expect(res._status).toBe(401);
            expect(res._body.error.type).toBe("AuthenticationError");
        });

        it("a generic error with no recognisable pattern falls back to 500 InternalError-shaped response", function () {
            const err = new Error("totally unrelated failure");
            const res = mockRes();

            handler.handle(err, mockReq(), res, () => {});

            expect(res._status).toBe(500);
            expect(res._body.status).toBe("error");
        });
    });
});
