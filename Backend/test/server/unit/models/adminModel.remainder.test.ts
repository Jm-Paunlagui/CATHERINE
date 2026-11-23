"use strict";

/**
 * @fileoverview AdminModel remainder: lookups, notify-recipient resolution,
 * name maps, insert/update/delete in demo and Oracle modes, search limit
 * clamping, and session-routed writes. Complements adminModel.test.ts.
 */

import AdminModel from "../../../../src/models/admin.model";
import demo from "../../../../src/models/demo/demoStore";
import { logger } from "../../../../src/utils/logger";
import { fake } from "../../helpers/modelsWrapperFake";

vi.mock("../../../../src/utils/oracle-mongo-wrapper", async () => (await import("../../helpers/modelsWrapperFake")).wrapperMock);

const mkAdmin = (over: Record<string, unknown> = {}) => ({
    ID: 1, USERNAME: "root", PASSWORD: "h", EMAIL: "root@x.io", ROLE: "SUPER_ADMIN", IS_ACTIVE: "Y",
    CAN_RECEIVE_SRV_CRIT: "N", CAN_RECEIVE_SRV_DEPS: "N", CAN_RECEIVE_SRV_RED: "N", CAN_RECEIVE_SRV_SYS: "N",
    CREATED_AT: new Date(0), UPDATED_AT: new Date(0), ...over,
});

describe("AdminModel remainder", function () {
    afterEach(function () {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
        vi.clearAllMocks();
    });

    describe("static helpers", function () {
        it("buildSignedFields signs exactly four fields and defaults IS_ACTIVE to Y", function () {
            expect(AdminModel.buildSignedFields({ USERNAME: "u", PASSWORD: "p", ROLE: "ADMIN", EMAIL: "leak", ID: 3 })).toEqual({ USERNAME: "u", PASSWORD: "p", ROLE: "ADMIN", IS_ACTIVE: "Y" });
            expect(AdminModel.buildSignedFields({ USERNAME: "u", PASSWORD: "p", ROLE: "ADMIN", IS_ACTIVE: "N" }).IS_ACTIVE).toBe("N");
            expect(AdminModel.SIGN_CONTEXT).toBe("T_ADMINS_DEV");
            expect(AdminModel.SEARCH_MAX_LIMIT).toBe(50);
            expect(Object.isFrozen(AdminModel.SERVER_NOTIFY_FLAG_COLUMNS)).toBe(true);
        });
    });

    describe("DEMO_MODE", function () {
        let admins: ReturnType<typeof mkAdmin>[];

        beforeEach(function () {
            vi.stubEnv("DEMO_MODE", "true");
            admins = [
                mkAdmin(),
                mkAdmin({ ID: 2, USERNAME: "amy", EMAIL: null, ROLE: "ADMIN", CAN_RECEIVE_SRV_CRIT: "Y" }),
                mkAdmin({ ID: 3, USERNAME: "bob", EMAIL: " bob@x.io ", ROLE: "ADMIN", CAN_RECEIVE_SRV_CRIT: "Y" }),
                mkAdmin({ ID: 4, USERNAME: "off", EMAIL: "off@x.io", ROLE: "ADMIN", IS_ACTIVE: "N", CAN_RECEIVE_SRV_CRIT: "Y" }),
                mkAdmin({ ID: 5, USERNAME: "dup", EMAIL: "bob@x.io", ROLE: "ADMIN", CAN_RECEIVE_SRV_CRIT: "Y" }),
            ];
            vi.spyOn(demo, "accounts").mockResolvedValue({ admins, users: [] } as never);
        });

        it("findByUsername / findAll / existsByUsername", async function () {
            expect((await AdminModel.findByUsername("amy"))!.ID).toBe(2);
            expect(await AdminModel.findByUsername("ghost")).toBeNull();
            expect((await AdminModel.findAll()).map((a) => a.USERNAME)).toEqual(["amy", "bob", "dup", "off", "root"]);
            expect(await AdminModel.existsByUsername("amy")).toBe(true);
            expect(await AdminModel.existsByUsername("ghost")).toBe(false);
        });

        it("findById rejects null / blank / NaN ids without lookup and returns null when absent", async function () {
            for (const bad of [null, undefined, "", "abc"] as never[]) expect(await AdminModel.findById(bad)).toBeNull();
            expect(await AdminModel.findById("99")).toBeNull();
            expect((await AdminModel.findById("3"))!.USERNAME).toBe("bob");
        });

        it("findByUsernames de-duplicates, drops blanks / non-strings and projects safe columns", async function () {
            const rows = await AdminModel.findByUsernames(["amy", "amy", "", 5 as never, "ghost", "root"]);
            expect(rows.map((r) => r.USERNAME).sort()).toEqual(["amy", "root"]);
            expect(rows[0]).not.toHaveProperty("PASSWORD");
            expect(rows.find((r) => r.USERNAME === "amy")!.EMAIL).toBeNull();
            expect(await AdminModel.findByUsernames(undefined as never)).toEqual([]);
        });

        it("search matches username or email, sorts, limits, and returns [] for blank queries", async function () {
            expect((await AdminModel.search("X.IO", 2)).map((r) => r.USERNAME)).toEqual(["bob", "dup"]);
            expect(await AdminModel.search("   ")).toEqual([]);
            expect(await AdminModel.search(undefined as never)).toEqual([]);
            expect((await AdminModel.search("amy"))[0].EMAIL).toBeNull();
        });

        it("countActiveByRole honours the exclusion", async function () {
            expect(await AdminModel.countActiveByRole("ADMIN")).toBe(3);
            expect(await AdminModel.countActiveByRole("ADMIN", "amy")).toBe(2);
        });

        it("findServerNotifyRecipients returns active, trimmed, de-duplicated, non-empty emails", async function () {
            expect((await AdminModel.findServerNotifyRecipients("server-critical-notification")).sort()).toEqual(["bob@x.io"]);
            expect(await AdminModel.findServerNotifyRecipients("not-a-channel")).toEqual([]);
            expect(await AdminModel.findServerNotifyRecipients("constructor")).toEqual([]);
            expect(await AdminModel.findServerNotifyRecipients("server-system-notification")).toEqual([]);
        });

        it("getNamesByIds maps ids to usernames and skips non-numeric ids", async function () {
            expect(await AdminModel.getNamesByIds(["1", 3, "x", 3])).toEqual(new Map([[1, "root"], [3, "bob"]]));
            expect(await AdminModel.getNamesByIds([])).toEqual(new Map());
            expect(await AdminModel.getNamesByIds(undefined as never)).toEqual(new Map());
            expect(await AdminModel.getNamesByIds(["nan"])).toEqual(new Map());
        });

        it("getNamesByIds swallows lookup failures into an empty map", async function () {
            vi.spyOn(demo, "accounts").mockRejectedValue(new Error("boom"));
            expect(await AdminModel.getNamesByIds([1])).toEqual(new Map());
        });

        it("insertAdmin applies defaults (inactive notify flags, active, null email)", async function () {
            await AdminModel.insertAdmin({ username: "n", password: "p", role: "ADMIN", sysSignature: "sig" });
            expect(admins.at(-1)).toMatchObject({ ID: 6, USERNAME: "n", EMAIL: null, IS_ACTIVE: "Y", CAN_RECEIVE_SRV_CRIT: "N", SYSSIGNATURE: "sig" });
            await AdminModel.insertAdmin({ username: "m", password: "p", role: "ADMIN", sysSignature: "s", isActive: "N", email: "m@x" });
            expect(admins.at(-1)).toMatchObject({ IS_ACTIVE: "N", EMAIL: "m@x" });
        });

        it("setNotifyFlags maps known channels, normalises values, ignores unknown ones", async function () {
            await AdminModel.setNotifyFlags("amy", { "server-red-metrics-notification": "Y", "server-system-notification": "maybe" as never, bogus: "Y" });
            expect(admins[1]).toMatchObject({ CAN_RECEIVE_SRV_RED: "Y", CAN_RECEIVE_SRV_SYS: "N" });
            expect(admins[1]).not.toHaveProperty("bogus");
            const stamp = admins[1].UPDATED_AT;
            await AdminModel.setNotifyFlags("amy", { bogus: "Y" });
            await AdminModel.setNotifyFlags("amy", undefined as never);
            expect(admins[1].UPDATED_AT).toBe(stamp); // no-op writes nothing
        });

        it("setEmail trims, nulls blanks and non-strings", async function () {
            await AdminModel.setEmail("amy", "  a@x.io ");
            expect(admins[1].EMAIL).toBe("a@x.io");
            await AdminModel.setEmail("amy", "   ");
            expect(admins[1].EMAIL).toBeNull();
            await AdminModel.setEmail("amy", 5 as never);
            expect(admins[1].EMAIL).toBeNull();
        });

        it("updateCredentials / updateRole / setActive change only the named admin and bump UPDATED_AT", async function () {
            await AdminModel.updateCredentials("amy", "newhash", "sig1");
            expect(admins[1]).toMatchObject({ PASSWORD: "newhash", SYSSIGNATURE: "sig1" });
            await AdminModel.updateRole("amy", "SUPER_ADMIN", "sig2");
            await AdminModel.setActive("amy", "N", "sig3");
            expect(admins[1]).toMatchObject({ ROLE: "SUPER_ADMIN", IS_ACTIVE: "N", SYSSIGNATURE: "sig3" });
            expect(admins[1].UPDATED_AT.getTime()).toBeGreaterThan(0);
            expect(admins[0].PASSWORD).toBe("h");
            await expect(AdminModel.updateRole("ghost", "ADMIN", "s")).resolves.toBeUndefined();
        });

        it("deleteAdmin removes the named admin, ignores unknown names, and never opens a session", async function () {
            await AdminModel.deleteAdmin("amy");
            expect(admins.map((a) => a.USERNAME)).not.toContain("amy");
            const n = admins.length;
            await AdminModel.deleteAdmin("ghost");
            expect(admins).toHaveLength(n);
            expect(fake.deleteOne).not.toHaveBeenCalled();
        });

        it("guard blocks the sole active SUPER_ADMIN, logging a warning, but allows when another exists", async function () {
            const warn = vi.spyOn(logger, "warning").mockImplementation(() => undefined as never);
            const fn = vi.fn().mockResolvedValue("ok");
            await expect(AdminModel.withLastSuperAdminGuard(1, fn)).rejects.toMatchObject({ statusCode: 409 });
            expect(warn).toHaveBeenCalledTimes(1);
            expect(fn).not.toHaveBeenCalled();
            admins.push(mkAdmin({ ID: 9, USERNAME: "second" }));
            expect(await AdminModel.withLastSuperAdminGuard("1", fn)).toBe("ok");
            expect(fn).toHaveBeenCalledWith(null);
        });
    });

    describe("Oracle mode", function () {
        beforeEach(function () {
            vi.stubEnv("DEMO_MODE", "false");
        });

        it("findByUsername and existsByUsername bind the username as a filter value", async function () {
            fake.next.mockResolvedValue({ ID: 1 });
            await AdminModel.findByUsername("a' OR 1=1");
            expect(fake.findArgs.at(-1)).toEqual({ USERNAME: "a' OR 1=1" });
            fake.count.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
            expect(await AdminModel.existsByUsername("a")).toBe(true);
            expect(await AdminModel.existsByUsername("a")).toBe(false);
        });

        it("findById rejects invalid ids before querying", async function () {
            const n = fake.findArgs.length;
            for (const bad of [null, undefined, "", "abc"] as never[]) expect(await AdminModel.findById(bad)).toBeNull();
            expect(fake.findArgs).toHaveLength(n);
        });

        it("findAll sorts by USERNAME", async function () {
            fake.toArray.mockResolvedValue([]);
            await AdminModel.findAll();
            expect(fake.chain.at(-1)).toEqual({ op: "sort", arg: { USERNAME: 1 } });
        });

        it("search clamps the limit (default, max, truncation) and returns rows or []", async function () {
            fake.db.withConnection.mockImplementation(async (fn: (c: unknown) => unknown) => fn({ execute: fake.aggregate }));
            fake.aggregate.mockResolvedValue({ rows: [{ ID: 1 }] });
            expect(await AdminModel.search("a", 9999)).toEqual([{ ID: 1 }]);
            expect(fake.aggregate.mock.calls.at(-1)![1]).toEqual({ q: "%A%", lim: 50 });
            await AdminModel.search("a", "abc" as never);
            expect(fake.aggregate.mock.calls.at(-1)![1].lim).toBe(20);
            await AdminModel.search("a", 0);
            expect(fake.aggregate.mock.calls.at(-1)![1].lim).toBe(20);
            await AdminModel.search("a", 7.9);
            expect(fake.aggregate.mock.calls.at(-1)![1].lim).toBe(7);
            fake.aggregate.mockResolvedValue(undefined);
            expect(await AdminModel.search("a")).toEqual([]);
        });

        it("findServerNotifyRecipients queries the flag column and de-duplicates emails", async function () {
            fake.toArray.mockResolvedValue([{ EMAIL: " a@x " }, { EMAIL: "a@x" }, { EMAIL: null }, { EMAIL: "  " }]);
            expect(await AdminModel.findServerNotifyRecipients("server-dependencies-notification")).toEqual(["a@x"]);
            expect(fake.findArgs.at(-1)).toEqual({ IS_ACTIVE: "Y", CAN_RECEIVE_SRV_DEPS: "Y" });
            expect(fake.chain[0]).toEqual({ op: "project", arg: { EMAIL: 1 } });
        });

        it("getNamesByIds queries $in on numeric ids, tolerates null rows and DB errors", async function () {
            fake.toArray.mockResolvedValueOnce([{ ID: "2", USERNAME: "amy" }]);
            expect(await AdminModel.getNamesByIds(["2", "x"])).toEqual(new Map([[2, "amy"]]));
            expect(fake.findArgs.at(-1)).toEqual({ ID: { $in: [2] } });
            fake.toArray.mockResolvedValueOnce(undefined);
            expect(await AdminModel.getNamesByIds([1])).toEqual(new Map());
            fake.toArray.mockRejectedValueOnce(new Error("ORA-03113"));
            expect(await AdminModel.getNamesByIds([1])).toEqual(new Map());
        });

        it("insertAdmin writes defaults for optional columns", async function () {
            fake.insertOne.mockResolvedValue({});
            await AdminModel.insertAdmin({ username: "u", password: "p", role: "ADMIN", sysSignature: "s" });
            expect(fake.insertOne).toHaveBeenLastCalledWith(expect.objectContaining({ USERNAME: "u", EMAIL: null, IS_ACTIVE: "Y", CAN_RECEIVE_SRV_CRIT: "N", SYSSIGNATURE: "s" }));
            await AdminModel.insertAdmin({ username: "u", password: "p", role: "ADMIN", sysSignature: "s", isActive: "N", email: "e" });
            expect(fake.insertOne).toHaveBeenLastCalledWith(expect.objectContaining({ EMAIL: "e", IS_ACTIVE: "N" }));
        });

        it("updates go through the shared collection, or the session's when one is supplied", async function () {
            fake.updateOne.mockResolvedValue({});
            const sessionUpdate = vi.fn().mockResolvedValue({});
            const sessionDelete = vi.fn().mockResolvedValue({});
            const session = { collection: vi.fn(() => ({ updateOne: sessionUpdate, deleteOne: sessionDelete })) };

            await AdminModel.setNotifyFlags("u", { "server-critical-notification": "Y" });
            expect(fake.updateOne.mock.calls.at(-1)![1].$set).toMatchObject({ CAN_RECEIVE_SRV_CRIT: "Y" });
            await AdminModel.setNotifyFlags("u", { "server-critical-notification": "Y" }, session as never);
            expect(sessionUpdate.mock.calls[0][0]).toEqual({ USERNAME: "u" });
            await AdminModel.updateRole("u", "ADMIN", "s", session as never);
            await AdminModel.setActive("u", "N", "s", session as never);
            expect(sessionUpdate).toHaveBeenCalledTimes(3);
            expect(session.collection).toHaveBeenCalledWith("T_ADMINS_DEV");

            await AdminModel.updateCredentials("u", "h", "s");
            expect(fake.updateOne.mock.calls.at(-1)![1].$set).toMatchObject({ PASSWORD: "h", SYSSIGNATURE: "s" });

            await AdminModel.deleteAdmin("u");
            expect(fake.deleteOne).toHaveBeenCalledWith({ USERNAME: "u" });
            await AdminModel.deleteAdmin("u", session as never);
            expect(sessionDelete).toHaveBeenCalledWith({ USERNAME: "u" });
        });

        it("setNotifyFlags with only unknown channels issues no write", async function () {
            const n = fake.updateOne.mock.calls.length;
            await AdminModel.setNotifyFlags("u", { nope: "Y" });
            expect(fake.updateOne.mock.calls).toHaveLength(n);
        });

        it("guard tolerates a null row set from the locked select", async function () {
            fake.withTransaction.mockImplementation(async (fn: (s: unknown) => unknown) => fn({
                collection: () => ({ find: () => ({ project: () => ({ forUpdate: () => ({ toArray: async () => undefined }) }) }) }),
            }));
            const fn = vi.fn().mockResolvedValue(1);
            expect(await AdminModel.withLastSuperAdminGuard(1, fn)).toBe(1);
        });
    });
});
