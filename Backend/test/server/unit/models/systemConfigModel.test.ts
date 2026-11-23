"use strict";

/**
 * @fileoverview SystemConfigModel: DEMO_MODE store and Oracle upsert shape.
 */

import SystemConfigModel from "../../../../src/models/system.config.model";
import demo from "../../../../src/models/demo/demoStore";
import { fake } from "../../helpers/modelsWrapperFake";

vi.mock("../../../../src/utils/oracle-mongo-wrapper", async () => (await import("../../helpers/modelsWrapperFake")).wrapperMock);

describe("SystemConfigModel", function () {
    afterEach(function () {
        vi.unstubAllEnvs();
        vi.clearAllMocks();
        demo.systemConfig().clear();
    });

    it("targets the _DEV table on the appDb pool", function () {
        expect(fake.ctor.some((c) => c[0] === "T_SYSTEM_CONFIG_DEV")).toBe(true);
    });

    describe("DEMO_MODE", function () {
        beforeEach(function () {
            vi.stubEnv("DEMO_MODE", "true");
        });

        it("findByKey returns null for unknown keys and a defensive copy for known ones", async function () {
            expect(await SystemConfigModel.findByKey("NOPE")).toBeNull();
            await SystemConfigModel.upsert({ key: "K", value: "v", updatedBy: 5, rowHash: "h" });
            const a = await SystemConfigModel.findByKey("K");
            a!.CONFIG_VALUE = "mutated";
            expect((await SystemConfigModel.findByKey("K"))!.CONFIG_VALUE).toBe("v");
        });

        it("upsert stores signed fields with defaults and returns the key", async function () {
            const key = await SystemConfigModel.upsert({ key: "MODE", value: "AUTO", updatedBy: 40001, rowHash: "abc" });
            expect(key).toBe("MODE");
            expect(demo.systemConfig().get("MODE")).toMatchObject({
                CONFIG_KEY: "MODE", CONFIG_VALUE: "AUTO", VALUE_TYPE: "STRING", UPDATED_BY: "40001", ROW_HASH: "abc", DESCRIPTION: null,
            });
        });

        it("upsert keeps the previous DESCRIPTION unless a new one is supplied", async function () {
            await SystemConfigModel.upsert({ key: "K", value: "1", valueType: "NUMBER", description: "seeded", updatedBy: "1", rowHash: "h1" });
            await SystemConfigModel.upsert({ key: "K", value: "2", updatedBy: "2", rowHash: "h2" });
            expect(demo.systemConfig().get("K")).toMatchObject({ DESCRIPTION: "seeded", CONFIG_VALUE: "2", VALUE_TYPE: "STRING", UPDATED_BY: "2" });
            await SystemConfigModel.upsert({ key: "K", value: "3", description: "new", updatedBy: "3", rowHash: "h3" });
            expect(demo.systemConfig().get("K")!.DESCRIPTION).toBe("new");
        });

        it("null updatedBy / rowHash are stored as null", async function () {
            await SystemConfigModel.upsert({ key: "N", value: "v", updatedBy: null as never, rowHash: undefined as never });
            expect(demo.systemConfig().get("N")).toMatchObject({ UPDATED_BY: null, ROW_HASH: null });
            expect(fake.updateOne).not.toHaveBeenCalled();
        });
    });

    describe("Oracle mode", function () {
        beforeEach(function () {
            vi.stubEnv("DEMO_MODE", "false");
        });

        it("findByKey binds the key as a string filter value", async function () {
            fake.next.mockResolvedValue({ CONFIG_KEY: "7" });
            expect(await SystemConfigModel.findByKey(7 as never)).toEqual({ CONFIG_KEY: "7" });
            expect(fake.findArgs.at(-1)).toEqual({ CONFIG_KEY: "7" });
        });

        it("upsert uses updateOne with upsert:true and omits DESCRIPTION when not supplied", async function () {
            fake.updateOne.mockResolvedValue({});
            const key = await SystemConfigModel.upsert({ key: "M", value: "v", updatedBy: 9, rowHash: "r" });
            expect(key).toBe("M");
            const [filter, update, opts] = fake.updateOne.mock.calls[0];
            expect(filter).toEqual({ CONFIG_KEY: "M" });
            expect(update.$set).toMatchObject({ CONFIG_VALUE: "v", VALUE_TYPE: "STRING", UPDATED_BY: "9", ROW_HASH: "r" });
            expect(update.$set).not.toHaveProperty("DESCRIPTION");
            expect(opts).toEqual({ upsert: true });
        });

        it("upsert includes DESCRIPTION when given and nulls missing updatedBy/rowHash", async function () {
            fake.updateOne.mockResolvedValue({});
            await SystemConfigModel.upsert({ key: "M", value: "v", valueType: "BOOLEAN", description: "d", updatedBy: null as never, rowHash: null as never });
            const update = fake.updateOne.mock.calls[0][1];
            expect(update.$set).toMatchObject({ DESCRIPTION: "d", VALUE_TYPE: "BOOLEAN", UPDATED_BY: null, ROW_HASH: null });
        });

        it("a hostile key is passed as data, and DB failure propagates", async function () {
            fake.updateOne.mockRejectedValue(new Error("ORA-00001"));
            await expect(SystemConfigModel.upsert({ key: "'; DROP TABLE x;--", value: "v", updatedBy: 1, rowHash: "h" })).rejects.toThrow("ORA-00001");
            expect(fake.updateOne.mock.calls[0][0]).toEqual({ CONFIG_KEY: "'; DROP TABLE x;--" });
        });
    });
});
