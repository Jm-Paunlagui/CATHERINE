"use strict";

/**
 * FxRateService.test.js — the currency-conversion accounting rules (plan §5.2).
 *
 * The load-bearing rule is §3.0 rule 4 / §3.7.10: a historical figure converts
 * with the rate that was EFFECTIVE ON ITS OWN DATE, so inserting a newer rate
 * never rewrites a past report. These tests drive the DEMO_MODE fixture path
 * (an in-memory, append-only rate table), which is exactly where the resolution
 * logic lives — no Oracle required.
 *
 * The demo fixture (src/models/demo/demoStore.js) ships two USD windows:
 *   USD  56.25000000  effective 2026-01-01 … 2026-06-30
 *   USD  58.10000000  effective 2026-07-01 … (open)
 * so a June date must resolve to 56.25 even though a newer 58.10 row exists.
 *
 * Pure logic + in-memory fixture — no DB, no HTTP.
 */

const { FxRateService, RATE_SCALE } = require("../../src/services/FxRateService");

// FxRateService reads isDemoMode() live (String(DEMO_MODE)==="true"), so we can
// arm/disarm the fixture path per describe block.
const ORIGINAL_DEMO = process.env.DEMO_MODE;
const ORIGINAL_FX_TABLE = process.env.MONEY_FX_TABLE;

function armDemo() {
    process.env.DEMO_MODE = "true";
    delete process.env.MONEY_FX_TABLE; // demo path must not need a table
}
function disarm() {
    if (ORIGINAL_DEMO === undefined) delete process.env.DEMO_MODE;
    else process.env.DEMO_MODE = ORIGINAL_DEMO;
    if (ORIGINAL_FX_TABLE === undefined) delete process.env.MONEY_FX_TABLE;
    else process.env.MONEY_FX_TABLE = ORIGINAL_FX_TABLE;
}

describe("FxRateService — rate storage scale", function () {
    it("exposes scale 8 (a rate is NUMBER(19,8), never a posting)", function () {
        expect(FxRateService.rateScale).toBe(8);
        expect(RATE_SCALE).toBe(8);
    });
});

describe("FxRateService.rateAsOf — resolves the rate in force ON THE DATE", function () {
    beforeEach(armDemo);
    afterEach(disarm);

    it("a historical date resolves the OLD rate even though a newer one exists", async function () {
        const june = new Date("2026-06-15T00:00:00Z");
        const r = await FxRateService.rateAsOf("USD", june);
        // The June figure must NOT see the July 58.10 row.
        expect(r.rate).toBe("56.25000000");
        expect(r.currencyCode).toBe("USD");
    });

    it("a current date resolves the NEWER open-ended rate", async function () {
        const august = new Date("2026-08-15T00:00:00Z");
        const r = await FxRateService.rateAsOf("USD", august);
        expect(r.rate).toBe("58.10000000");
    });

    it("the boundary day belongs to the window that covers it", async function () {
        // 2026-07-01 is the EFFECTIVE_FROM of the new window.
        const boundary = new Date("2026-07-01T00:00:00Z");
        const r = await FxRateService.rateAsOf("USD", boundary);
        expect(r.rate).toBe("58.10000000");
    });

    it("INSERTING a newer rate does NOT change what a past date resolves to (rule 4)", async function () {
        const june = new Date("2026-06-15T00:00:00Z");
        const before = await FxRateService.rateAsOf("USD", june);

        // Append a brand-new, currently-effective rate (append-only, §3.7.9).
        await FxRateService.recordRate({
            currencyCode: "USD",
            rate: "60.00000000",
            effectiveFrom: new Date("2026-09-01T00:00:00Z"),
            source: "MANUAL",
            setBy: "test",
        });

        const after = await FxRateService.rateAsOf("USD", june);
        // The historical figure is untouched — that is the whole point.
        expect(after.rate).toBe(before.rate);
        expect(after.rate).toBe("56.25000000");

        // And a September date now sees the new rate.
        const sept = await FxRateService.rateAsOf("USD", new Date("2026-09-15T00:00:00Z"));
        expect(sept.rate).toBe("60.00000000");
    });

    it("throws 404 when no rate covers the date (before any window opens)", async function () {
        const tooEarly = new Date("2020-01-01T00:00:00Z");
        await expect(FxRateService.rateAsOf("USD", tooEarly)).rejects.toMatchObject({
            statusCode: 404,
        });
    });

    it("throws 400 on an unknown currency rather than guessing", async function () {
        await expect(FxRateService.rateAsOf("ZZZ", new Date())).rejects.toMatchObject({
            statusCode: 400,
        });
    });
});

describe("FxRateService.rateAsOf — display scale is a formatting concern, not a stored one", function () {
    beforeEach(armDemo);
    afterEach(disarm);

    // The service always returns the RATE at storage scale 8; how many places a
    // currency SHOWS is the registry's job (a 3-decimal and a 4-decimal currency
    // each render at their own display scale via formatMoney). Here we assert the
    // service does not itself truncate to a display scale — it hands back the
    // exact stored string for both a scale-2 (USD) and a sub-unit (JPY) currency.
    it("returns the full scale-8 rate for a scale-2 display currency (USD)", async function () {
        const r = await FxRateService.rateAsOf("USD", new Date("2026-08-01T00:00:00Z"));
        expect(r.rate).toMatch(/^\d+\.\d{8}$/);
    });

    it("returns the full scale-8 rate for a sub-unit currency (JPY, displayScale 0)", async function () {
        const r = await FxRateService.rateAsOf("JPY", new Date("2026-08-01T00:00:00Z"));
        expect(r.rate).toBe("0.38500000");
        expect(r.rate).toMatch(/^\d+\.\d{8}$/);
    });
});

describe("FxRateService.recordRate — append-only, string rate only", function () {
    beforeEach(armDemo);
    afterEach(disarm);

    it("REJECTS a JS-number rate (a rate must never round-trip a double)", async function () {
        await expect(
            FxRateService.recordRate({
                currencyCode: "USD",
                rate: 58.1, // a number, not a string
                effectiveFrom: new Date(),
                source: "MANUAL",
                setBy: "test",
            }),
        ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("REJECTS a non-numeric rate string", async function () {
        await expect(
            FxRateService.recordRate({
                currencyCode: "USD",
                rate: "not-a-rate",
                effectiveFrom: new Date(),
                source: "MANUAL",
                setBy: "test",
            }),
        ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("REJECTS an unknown currency", async function () {
        await expect(
            FxRateService.recordRate({
                currencyCode: "ZZZ",
                rate: "1.00000000",
                effectiveFrom: new Date(),
                source: "MANUAL",
                setBy: "test",
            }),
        ).rejects.toMatchObject({ statusCode: 400 });
    });

    it("appends a valid rate and makes it resolvable as of its effective date", async function () {
        await FxRateService.recordRate({
            currencyCode: "GBP",
            rate: "72.50000000",
            effectiveFrom: new Date("2026-05-01T00:00:00Z"),
            source: "MANUAL",
            setBy: "test",
        });
        const r = await FxRateService.rateAsOf("GBP", new Date("2026-05-15T00:00:00Z"));
        expect(r.rate).toBe("72.50000000");
        expect(r.source).toBe("MANUAL");
    });
});

describe("FxRateService — inert without a table when NOT in demo mode (§3.7.9)", function () {
    beforeEach(function () {
        // Force the LIVE path with no table configured.
        if (ORIGINAL_DEMO === undefined) delete process.env.DEMO_MODE;
        else process.env.DEMO_MODE = "false";
        process.env.DEMO_MODE = "false";
        delete process.env.MONEY_FX_TABLE;
    });
    afterEach(disarm);

    it("throws 503 (inert) on lookup with no MONEY_FX_TABLE and no demo mode", async function () {
        await expect(
            FxRateService.rateAsOf("USD", new Date("2026-08-01T00:00:00Z")),
        ).rejects.toMatchObject({ statusCode: 503 });
    });
});
