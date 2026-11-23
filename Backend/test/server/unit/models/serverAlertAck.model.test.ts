"use strict";

/**
 * @fileoverview ServerAlertAckModel: table-name resolution, the DEMO_MODE
 * in-memory set, and the Oracle path (collection calls faked).
 */

import ServerAlertAckModel, { resolveTableName } from "../../../../src/models/serverAlertAck.model";

const collection = vi.hoisted(() => ({
    updateOne: vi.fn(),
    deleteOne: vi.fn(),
    findOne: vi.fn(),
    toArray: vi.fn(),
    ctorArgs: [] as unknown[][],
}));

vi.mock("../../../../src/utils/oracle-mongo-wrapper", () => ({
    createDb: vi.fn(() => ({ name: "fake-db" })),
    OracleCollection: class {
        constructor(...args: unknown[]) {
            collection.ctorArgs.push(args);
        }
        updateOne = collection.updateOne;
        deleteOne = collection.deleteOne;
        findOne = collection.findOne;
        find() {
            return { toArray: collection.toArray };
        }
    },
}));

describe("ServerAlertAckModel", function () {
    afterEach(function () {
        vi.unstubAllEnvs();
        vi.clearAllMocks();
    });

    describe("resolveTableName", function () {
        it("prefers the env override, then production, then the DEV default", function () {
            vi.stubEnv("SERVER_ALERT_ACK_TABLE", "CUSTOM_ACK");
            expect(resolveTableName()).toBe("CUSTOM_ACK");
            vi.stubEnv("SERVER_ALERT_ACK_TABLE", "");
            vi.stubEnv("NODE_ENV", "production");
            expect(resolveTableName()).toBe("T_SERVER_ALERT_ACK");
            vi.stubEnv("NODE_ENV", "test");
            expect(resolveTableName()).toBe("T_SERVER_ALERT_ACK_DEV");
            expect(ServerAlertAckModel.resolveTableName).toBe(resolveTableName);
        });
    });

    describe("DEMO_MODE (in memory)", function () {
        beforeEach(function () {
            vi.stubEnv("DEMO_MODE", "true");
        });

        it("upserts, overwrites on re-ack, truncates key/note, and reads back", async function () {
            const exp = new Date("2030-01-01T00:00:00Z");
            await ServerAlertAckModel.upsert({ alertKey: "K".repeat(300), ackedBy: "7", expiresAt: exp, severityAtAck: "WARNING", note: "n".repeat(900) });
            const key = "K".repeat(200);
            const first = await ServerAlertAckModel.findOne(key);
            expect(first).toMatchObject({ ALERT_KEY: key, ACKED_BY: 7, EXPIRES_AT: exp, SEVERITY_AT_ACK: "WARNING" });
            expect(first!.NOTE).toHaveLength(500);

            await ServerAlertAckModel.upsert({ alertKey: key, ackedBy: 8, expiresAt: exp, severityAtAck: "CRITICAL" });
            const second = await ServerAlertAckModel.findOne(key);
            expect(second).toMatchObject({ ACKED_BY: 8, SEVERITY_AT_ACK: "CRITICAL", NOTE: null });
            expect((await ServerAlertAckModel.findAll()).map((r) => r.ALERT_KEY)).toContain(key);
        });

        it("remove reports whether a row existed and findOne returns null for unknown keys", async function () {
            await ServerAlertAckModel.upsert({ alertKey: "demo-k", ackedBy: 1, expiresAt: new Date(), severityAtAck: "WARNING", note: null });
            expect(await ServerAlertAckModel.remove("demo-k")).toBe(true);
            expect(await ServerAlertAckModel.remove("demo-k")).toBe(false);
            expect(await ServerAlertAckModel.findOne("demo-k")).toBeNull();
            expect(collection.updateOne).not.toHaveBeenCalled();
        });
    });

    describe("Oracle mode", function () {
        beforeEach(function () {
            vi.stubEnv("DEMO_MODE", "false");
        });

        it("upserts through updateOne with upsert:true on the resolved table", async function () {
            collection.updateOne.mockResolvedValue({});
            const exp = new Date("2030-01-01T00:00:00Z");
            await ServerAlertAckModel.upsert({ alertKey: "a::b", ackedBy: 3, expiresAt: exp, severityAtAck: "CRITICAL", note: "why" });
            const [filter, update, opts] = collection.updateOne.mock.calls[0];
            expect(filter).toEqual({ ALERT_KEY: "a::b" });
            expect(update.$set).toMatchObject({ ACKED_BY: 3, EXPIRES_AT: exp, SEVERITY_AT_ACK: "CRITICAL", NOTE: "why" });
            expect(opts).toEqual({ upsert: true });
            expect(collection.ctorArgs[0][0]).toBe("T_SERVER_ALERT_ACK_DEV");
        });

        it("remove is true only when a row was deleted (missing result counts as false)", async function () {
            collection.deleteOne.mockResolvedValueOnce({ deletedCount: 1 });
            expect(await ServerAlertAckModel.remove("k")).toBe(true);
            collection.deleteOne.mockResolvedValueOnce({ deletedCount: 0 });
            expect(await ServerAlertAckModel.remove("k")).toBe(false);
            collection.deleteOne.mockResolvedValueOnce(undefined);
            expect(await ServerAlertAckModel.remove("k")).toBe(false);
        });

        it("findOne and findAll delegate to the collection", async function () {
            collection.findOne.mockResolvedValue({ ALERT_KEY: "k" });
            collection.toArray.mockResolvedValue([{ ALERT_KEY: "k" }]);
            expect(await ServerAlertAckModel.findOne("k")).toEqual({ ALERT_KEY: "k" });
            expect(collection.findOne).toHaveBeenCalledWith({ ALERT_KEY: "k" });
            expect(await ServerAlertAckModel.findAll()).toEqual([{ ALERT_KEY: "k" }]);
        });

        it("propagates a database failure to the caller", async function () {
            collection.updateOne.mockRejectedValue(new Error("ORA-00942"));
            await expect(
                ServerAlertAckModel.upsert({ alertKey: "k", ackedBy: 1, expiresAt: new Date(), severityAtAck: "WARNING" }),
            ).rejects.toThrow("ORA-00942");
        });
    });
});
