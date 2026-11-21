"use strict";

/**
 * CSRF token sent in the request BODY (`_csrf` or `csrfToken`), not the header.
 *
 * Until the TypeScript pass, the csrf-csrf option was misspelt
 * (`getTokenFromRequest` instead of `getCsrfTokenFromRequest`), so the library
 * fell back to its header-only default and a body token was never read. This
 * locks in that a protected route accepts a valid body token and still refuses
 * a missing or forged one.
 */

const request = require("supertest");
const app = require("../../../src/app").default;

const PROTECTED = "/api/v1/auth/login";
const CREDENTIALS = { userId: "csrf-body-test", password: "wrong-password-1" };
const isCsrfRefusal = (res) => res.status === 403 && res.body?.code === "CSRF_TOKEN_INVALID";

describe("CSRF token in the request body", function () {
    let agent;
    let token;

    beforeEach(async function () {
        agent = request.agent(app);
        token = (await agent.get("/api/v1/csrf/token")).body.token;
        expect(token).toEqual(expect.any(String));
    });

    it("refuses a protected POST with no token at all", async function () {
        const res = await agent.post(PROTECTED).send(CREDENTIALS);
        expect(isCsrfRefusal(res)).toBe(true);
    });

    it("accepts a valid token in body._csrf", async function () {
        const res = await agent.post(PROTECTED).send({ ...CREDENTIALS, _csrf: token });
        expect(isCsrfRefusal(res)).toBe(false);
    });

    it("accepts a valid token in body.csrfToken", async function () {
        const res = await agent.post(PROTECTED).send({ ...CREDENTIALS, csrfToken: token });
        expect(isCsrfRefusal(res)).toBe(false);
    });

    it("refuses a forged token in the body", async function () {
        const res = await agent.post(PROTECTED).send({ ...CREDENTIALS, _csrf: "forged-token-abc123" });
        expect(isCsrfRefusal(res)).toBe(true);
    });
});
