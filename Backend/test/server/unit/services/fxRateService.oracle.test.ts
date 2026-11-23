/**
 * @fileoverview FxRateService non-demo configuration guard. The Oracle insert/lookup paths
 * load the wrapper through src's own lazy native require(), so they cannot be
 * stubbed here and are left uncovered.
 */
import { FxRateService } from "../../../../src/services/FxRateService";

const OLD_ENV = { demo: process.env.DEMO_MODE, table: process.env.MONEY_FX_TABLE };

beforeEach(() => {
    delete process.env.DEMO_MODE;
    process.env.MONEY_FX_TABLE = "T_FX_TEST";
});

afterEach(() => {
    vi.restoreAllMocks();
    if (OLD_ENV.demo === undefined) delete process.env.DEMO_MODE;
    else process.env.DEMO_MODE = OLD_ENV.demo;
    if (OLD_ENV.table === undefined) delete process.env.MONEY_FX_TABLE;
    else process.env.MONEY_FX_TABLE = OLD_ENV.table;
});

const base = { currencyCode: "USD", rate: "56.25000000", effectiveFrom: new Date("2026-01-01T00:00:00Z"), source: "BSP", setBy: "SA1" };

describe("FxRateService without a configured FX table", () => {
    it("recordRate and rateAsOf answer 503 ConfigurationError", async () => {
        delete process.env.MONEY_FX_TABLE;
        await expect(FxRateService.recordRate({ ...base })).rejects.toMatchObject({ statusCode: 503 });
        await expect(FxRateService.rateAsOf("USD")).rejects.toMatchObject({ statusCode: 503 });
    });

    it("recordRate validates currency and rate format before touching storage", async () => {
        await expect(FxRateService.recordRate({ ...base, currencyCode: "ZZZ" })).rejects.toMatchObject({ statusCode: 400 });
        await expect(FxRateService.recordRate({ ...base, rate: "1e5" })).rejects.toMatchObject({ statusCode: 400 });
        await expect(FxRateService.recordRate({ ...base, rate: 5 as never })).rejects.toMatchObject({ statusCode: 400 });
    });
});
