"use strict";

/**
 * @fileoverview UserModel: DEMO_MODE in-memory path and Oracle path
 * (collection faked; asserts values travel as filter objects, never SQL text).
 */

import UserModel from "../../../../src/models/user.model";
import demo from "../../../../src/models/demo/demoStore";
import { fake } from "../../helpers/modelsWrapperFake";

vi.mock("../../../../src/utils/oracle-mongo-wrapper", async () => (await import("../../helpers/modelsWrapperFake")).wrapperMock);

const mkUser = (over: Record<string, unknown> = {}) => ({
    ID: 1, USERNAME: "zed", PASSWORD: "h", FIRST_NAME: null, LAST_NAME: null, EMAIL: null,
    IS_ACTIVE: "Y", CREATED_AT: new Date(0), UPDATED_AT: new Date(0), ...over,
});

describe("UserModel", function () {
    afterEach(function () {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
        vi.clearAllMocks();
    });

    describe("DEMO_MODE", function () {
        let users: ReturnType<typeof mkUser>[];

        beforeEach(function () {
            vi.stubEnv("DEMO_MODE", "true");
            users = [mkUser({ USERNAME: "zed" }), mkUser({ ID: 2, USERNAME: "amy", PASSWORD: "p2" })];
            vi.spyOn(demo, "accounts").mockResolvedValue({ admins: [], users } as never);
        });

        it("findByUsername is case-sensitive and returns null when absent", async function () {
            expect((await UserModel.findByUsername("amy"))!.ID).toBe(2);
            expect(await UserModel.findByUsername("AMY")).toBeNull();
            expect(fake.findArgs).toHaveLength(0);
        });

        it("findAll sorts by username and strips PASSWORD", async function () {
            const all = await UserModel.findAll();
            expect(all.map((u) => u.USERNAME)).toEqual(["amy", "zed"]);
            for (const u of all) expect(u).not.toHaveProperty("PASSWORD");
        });

        it("existsByUsername reports presence", async function () {
            expect(await UserModel.existsByUsername("zed")).toBe(true);
            expect(await UserModel.existsByUsername("nobody")).toBe(false);
        });

        it("insertUser applies defaults and honours explicit optional fields", async function () {
            await UserModel.insertUser({ username: "n1", password: "hash" });
            expect(users.at(-1)).toMatchObject({ ID: 3, USERNAME: "n1", PASSWORD: "hash", FIRST_NAME: null, LAST_NAME: null, EMAIL: null, IS_ACTIVE: "Y" });
            await UserModel.insertUser({ username: "n2", password: "h2", firstName: "F", lastName: "L", email: "e@x", isActive: "N" });
            expect(users.at(-1)).toMatchObject({ FIRST_NAME: "F", LAST_NAME: "L", EMAIL: "e@x", IS_ACTIVE: "N" });
        });

        it("updatePassword changes only the matching row and is a no-op for unknown users", async function () {
            await UserModel.updatePassword("amy", "new");
            expect(users[1].PASSWORD).toBe("new");
            expect(users[0].PASSWORD).toBe("h");
            await expect(UserModel.updatePassword("ghost", "x")).resolves.toBeUndefined();
            expect(users.map((u) => u.PASSWORD)).toEqual(["h", "new"]);
        });

        it("deleteUser removes the match and ignores unknown users", async function () {
            await UserModel.deleteUser("zed");
            expect(users.map((u) => u.USERNAME)).toEqual(["amy"]);
            await UserModel.deleteUser("ghost");
            expect(users).toHaveLength(1);
            expect(fake.deleteOne).not.toHaveBeenCalled();
        });
    });

    describe("Oracle mode", function () {
        beforeEach(function () {
            vi.stubEnv("DEMO_MODE", "false");
        });

        it("lazily builds one T_USERS_DEV collection on the appDb pool and reuses it", async function () {
            fake.next.mockResolvedValue(mkUser());
            await UserModel.findByUsername("a");
            await UserModel.findByUsername("b");
            const usersCtor = fake.ctor.filter((c) => c[0] === "T_USERS_DEV");
            expect(usersCtor).toHaveLength(1);
        });

        it("findByUsername binds the username as a filter value with the PASSWORD projection", async function () {
            fake.next.mockResolvedValue(mkUser());
            const injection = "x' OR '1'='1";
            expect(await UserModel.findByUsername(injection)).toMatchObject({ USERNAME: "zed" });
            expect(fake.findArgs.at(-1)).toEqual({ USERNAME: injection });
            expect(fake.chain[0].op).toBe("project");
            expect(fake.chain[0].arg).toMatchObject({ PASSWORD: 1, USERNAME: 1 });
        });

        it("findAll never projects PASSWORD and sorts by USERNAME", async function () {
            fake.toArray.mockResolvedValue([]);
            await UserModel.findAll();
            const proj = fake.chain.find((c) => c.op === "project")!.arg as Record<string, number>;
            expect(proj).not.toHaveProperty("PASSWORD");
            expect(fake.chain.find((c) => c.op === "sort")!.arg).toEqual({ USERNAME: 1 });
        });

        it("existsByUsername is true only for a positive count", async function () {
            fake.count.mockResolvedValueOnce(1);
            expect(await UserModel.existsByUsername("a")).toBe(true);
            fake.count.mockResolvedValueOnce(0);
            expect(await UserModel.existsByUsername("a")).toBe(false);
            expect(fake.findArgs.at(-1)).toEqual({ USERNAME: "a" });
        });

        it("insertUser writes defaults for omitted optional fields", async function () {
            fake.insertOne.mockResolvedValue({});
            await UserModel.insertUser({ username: "u", password: "h" });
            expect(fake.insertOne).toHaveBeenCalledWith({ USERNAME: "u", PASSWORD: "h", FIRST_NAME: null, LAST_NAME: null, EMAIL: null, IS_ACTIVE: "Y" });
            await UserModel.insertUser({ username: "u", password: "h", firstName: "F", lastName: "L", email: "e", isActive: "N" });
            expect(fake.insertOne).toHaveBeenLastCalledWith({ USERNAME: "u", PASSWORD: "h", FIRST_NAME: "F", LAST_NAME: "L", EMAIL: "e", IS_ACTIVE: "N" });
        });

        it("updatePassword and deleteUser scope by USERNAME filter", async function () {
            fake.updateOne.mockResolvedValue({});
            fake.deleteOne.mockResolvedValue({});
            await UserModel.updatePassword("u", "newhash");
            const [filter, update] = fake.updateOne.mock.calls[0];
            expect(filter).toEqual({ USERNAME: "u" });
            expect(update.$set.PASSWORD).toBe("newhash");
            expect(update.$set.UPDATED_AT).toBeInstanceOf(Date);
            await UserModel.deleteUser("u");
            expect(fake.deleteOne).toHaveBeenCalledWith({ USERNAME: "u" });
        });

        it("propagates database errors", async function () {
            fake.deleteOne.mockRejectedValue(new Error("ORA-03113"));
            await expect(UserModel.deleteUser("u")).rejects.toThrow("ORA-03113");
        });
    });
});
