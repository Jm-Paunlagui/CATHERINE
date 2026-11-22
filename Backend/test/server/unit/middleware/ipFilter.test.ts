"use strict";

const {
    IpFilterMiddleware,
} = require("../../../../src/middleware/security/IpFilterMiddleware");

describe("IpFilterMiddleware", function () {
    describe("when disabled", function () {
        it("always calls next()", () => new Promise((resolve, reject) => {
            const done = (e) => e ? reject(e) : resolve();

            const filter = new IpFilterMiddleware({ enabled: false });
            filter.handle({ ip: "1.2.3.4", path: "/" }, {}, done);
        
            }));
    });

    describe("when enabled", function () {
        it("allows an exact IP on the allowlist", () => new Promise((resolve, reject) => {
            const done = (e) => e ? reject(e) : resolve();

            const filter = new IpFilterMiddleware({
                enabled: true,
                allowedIps: ["192.168.1.10"],
            });
            filter.handle({ ip: "192.168.1.10", path: "/" }, {}, done);
        
            }));

        it("blocks an IP not on the allowlist", () => new Promise((resolve, reject) => {
            const done = (e) => e ? reject(e) : resolve();

            const filter = new IpFilterMiddleware({
                enabled: true,
                allowedIps: ["192.168.1.10"],
            });
            const res = {
                status(c) {
                    this._status = c;
                    return this;
                },
                json(b) {
                    this._body = b;
                    done();
                },
            };
            filter.handle({ ip: "10.0.0.5", path: "/api" }, res, () => {
                done(new Error("should have been blocked"));
            });
        
            }));

        it("allows an IP within a CIDR range", () => new Promise((resolve, reject) => {
            const done = (e) => e ? reject(e) : resolve();

            const filter = new IpFilterMiddleware({
                enabled: true,
                allowedIps: ["10.0.0.0/24"],
            });
            filter.handle({ ip: "10.0.0.99", path: "/" }, {}, done);
        
            }));

        it("blocks an IP outside the CIDR range", () => new Promise((resolve, reject) => {
            const done = (e) => e ? reject(e) : resolve();

            const filter = new IpFilterMiddleware({
                enabled: true,
                allowedIps: ["10.0.0.0/24"],
            });
            const res = {
                status(c) {
                    this._status = c;
                    return this;
                },
                json() {
                    done();
                },
            };
            filter.handle({ ip: "10.0.1.1", path: "/api" }, res, () => {
                done(new Error("should have been blocked"));
            });
        
            }));
    });

    describe("static helpers", function () {
        it("ipInCidr correctly classifies IPs", function () {
            expect(
                IpFilterMiddleware.ipInCidr("192.168.1.5", "192.168.1.0/24"),
            ).toBe(true);
            expect(IpFilterMiddleware.ipInCidr("192.168.2.1", "192.168.1.0/24"))
                .toBe(false);
        });

        it("extractClientIp strips ::ffff: IPv4-mapped prefix", function () {
            const req = { ip: "::ffff:10.0.0.1", socket: {} };
            expect(IpFilterMiddleware.extractClientIp(req)).toBe("10.0.0.1");
        });
    });
});
