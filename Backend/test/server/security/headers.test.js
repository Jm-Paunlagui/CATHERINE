"use strict";

const agent = require("../helpers/request");

describe("Security Headers (Helmet)", function () {
    let headers;

    beforeAll(async function () {
        const res = await agent.get("/api/v1/health");
        headers = res.headers;
    }, 30_000);

    it("sets X-Content-Type-Options: nosniff", function () {
        expect(headers["x-content-type-options"]).toBe("nosniff");
    });

    it("sets X-Frame-Options to deny framing", function () {
        expect(headers["x-frame-options"]).toBe("DENY");
    });

    it("sets Strict-Transport-Security", function () {
        expect(headers["strict-transport-security"]).toBeDefined();
        expect(headers["strict-transport-security"]).toContain("max-age=");
    });

    it("sets Content-Security-Policy", function () {
        expect(headers["content-security-policy"]).toBeDefined();
        expect(headers["content-security-policy"]).toContain(
            "default-src 'self'",
        );
    });

    it("does not expose X-Powered-By", function () {
        expect(headers).not.toHaveProperty("x-powered-by");
    });

    it("sets Referrer-Policy", function () {
        expect(headers["referrer-policy"]).toBeDefined();
    });

    it("sets Cross-Origin-Opener-Policy", function () {
        expect(headers["cross-origin-opener-policy"]).toBeDefined();
    });
});
