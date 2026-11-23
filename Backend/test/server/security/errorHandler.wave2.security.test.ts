/**
 * @fileoverview Security: ErrorHandlerMiddleware never leaks stack traces, SQL,
 * bind values or driver internals in production, through a real Express app.
 */
import express from "express";
import request from "supertest";

vi.mock("../../../src/utils/logger", () => ({
    logger: { notice: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { ErrorHandlerMiddleware } from "../../../src/middleware/errorHandling/ErrorHandlerMiddleware";

function appWith(thrower: () => never) {
    const eh = new ErrorHandlerMiddleware({ cors: { applyToErrorResponse: (_q: unknown, _s: unknown, d: () => void) => d() } as any });
    const app = express();
    app.use(express.json());
    app.get("/boom", () => thrower());
    app.use(eh.notFoundHandler);
    app.use(eh.handle as any);
    return app;
}

describe("ErrorHandler security", () => {
    const env = process.env.NODE_ENV;
    afterEach(() => { process.env.NODE_ENV = env; });

    it.each(["production", "test"])("no stack trace in the %s body", async (e) => {
        process.env.NODE_ENV = e;
        const res = await request(appWith(() => { throw new Error("secret internal /srv/app/file.ts"); })).get("/boom");
        expect(res.status).toBe(500);
        expect(res.text).not.toMatch(/\bat .*\(.*:\d+:\d+\)/);
        expect(res.text).not.toMatch(/secret internal|file\.ts/);
        expect(res.body.error).not.toHaveProperty("stack");
        expect(res.body.message).toBe("Internal server error");
    });

    it("Oracle errors never reveal SQL or binds", async () => {
        process.env.NODE_ENV = "production";
        const res = await request(appWith(() => { throw new Error("ORA-00942: table USERS_SECRET does not exist, sql=SELECT * FROM USERS_SECRET WHERE pw=:1"); })).get("/boom");
        expect(res.text).not.toMatch(/USERS_SECRET|SELECT|:1/);
        expect(res.body.error.type).toBe("DatabaseError");
    });

    it("production masks the error class name", async () => {
        process.env.NODE_ENV = "production";
        class InternalDbPoolError extends Error {}
        const res = await request(appWith(() => { throw new InternalDbPoolError("x"); })).get("/boom");
        expect(res.body.error.type).toBe("InternalError");
        expect(res.text).not.toMatch(/InternalDbPoolError/);
    });

    it("malformed JSON returns a generic 400 that does not echo the body", async () => {
        process.env.NODE_ENV = "production";
        const app = appWith(() => { throw new Error("n/a"); });
        const res = await request(app).post("/boom").set("Content-Type", "application/json").send('{"password": "hunter2"');
        expect(res.status).toBe(400);
        expect(res.text).not.toMatch(/hunter2/);
        expect(res.body.error.type).toBe("ParseError");
    });

    it("unknown routes get a 404 envelope", async () => {
        const res = await request(appWith(() => { throw new Error("x"); })).get("/missing");
        expect(res.status).toBe(404);
        expect(res.body.error.type).toBe("NotFoundError");
    });
});
