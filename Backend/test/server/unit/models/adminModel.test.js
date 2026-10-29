"use strict";

/**
 * @fileoverview Unit tests for the AdminModel additions: findById,
 * findByUsernames, search, setEmail, withLastSuperAdminGuard and the
 * countActiveByRole null-exclusion fix.
 *
 * No Oracle connection is ever opened:
 *   - OracleCollection.prototype.find / updateOne are spied (query-builder
 *     reads and $set writes),
 *   - config.withConnection is spied for the raw-SQL search,
 *   - Transaction.prototype.withTransaction is spied for the guard and hands
 *     the callback a fake session.
 *
 * DEMO_MODE is pinned per test because isDemoMode() is read live.
 */

const {
    OracleCollection,
    Transaction,
} = require("../../../../src/utils/oracle-mongo-wrapper");
const config = require("../../../../src/config");
const AdminModel = require("../../../../src/models/admin.model");
const demo = require("../../../../src/models/demo/demoStore");
const { ADMIN_ERRORS } = require("../../../../src/constants/errors");

const ORIGINAL_DEMO_MODE = process.env.DEMO_MODE;

/** A fake QueryBuilder chain that records every call and resolves `result`. */
function fakeQuery(result) {
    const q = {
        calls: [],
        project: vi.fn(function (p) { q.calls.push(["project", p]); return q; }),
        sort: vi.fn(function (s) { q.calls.push(["sort", s]); return q; }),
        limit: vi.fn(function (n) { q.calls.push(["limit", n]); return q; }),
        forUpdate: vi.fn(function (m) { q.calls.push(["forUpdate", m]); return q; }),
        toArray: vi.fn().mockResolvedValue(result),
        next: vi.fn().mockResolvedValue(result),
        count: vi.fn().mockResolvedValue(result),
    };
    return q;
}

/** Spies Transaction.withTransaction, giving fn a session over `lockedRows`. */
function mockGuardTransaction(lockedRows) {
    const query = fakeQuery(lockedRows);
    const txCol = {
        find: vi.fn(() => query),
        updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
        deleteOne: vi.fn().mockResolvedValue({ deletedCount: 1 }),
    };
    const session = { collection: vi.fn(() => txCol) };
    const txSpy = vi
        .spyOn(Transaction.prototype, "withTransaction")
        .mockImplementation(async (fn) => fn(session));
    return { txSpy, session, txCol, query };
}

describe("AdminModel — Oracle path (DEMO_MODE=false)", function () {
    beforeEach(function () {
        process.env.DEMO_MODE = "false";
    });

    afterEach(function () {
        if (ORIGINAL_DEMO_MODE === undefined) delete process.env.DEMO_MODE;
        else process.env.DEMO_MODE = ORIGINAL_DEMO_MODE;
        vi.restoreAllMocks();
    });

    describe("countActiveByRole", function () {
        it("omits the USERNAME predicate when the exclusion is null", async function () {
            const q = fakeQuery(2);
            const findSpy = vi.spyOn(OracleCollection.prototype, "find").mockReturnValue(q);

            const n = await AdminModel.countActiveByRole("SUPER_ADMIN", null);

            expect(n).toBe(2);
            expect(findSpy).toHaveBeenCalledWith({ ROLE: "SUPER_ADMIN", IS_ACTIVE: "Y" });
            expect(findSpy.mock.calls[0][0]).not.toHaveProperty("USERNAME");
        });

        it("omits the USERNAME predicate when the exclusion is undefined", async function () {
            const findSpy = vi
                .spyOn(OracleCollection.prototype, "find")
                .mockReturnValue(fakeQuery(1));

            await AdminModel.countActiveByRole("SUPER_ADMIN");

            expect(findSpy.mock.calls[0][0]).toEqual({ ROLE: "SUPER_ADMIN", IS_ACTIVE: "Y" });
        });

        it("adds USERNAME $ne when an exclusion is given", async function () {
            const findSpy = vi
                .spyOn(OracleCollection.prototype, "find")
                .mockReturnValue(fakeQuery(0));

            await AdminModel.countActiveByRole("SUPER_ADMIN", "alice");

            expect(findSpy.mock.calls[0][0]).toEqual({
                ROLE: "SUPER_ADMIN",
                IS_ACTIVE: "Y",
                USERNAME: { $ne: "alice" },
            });
        });
    });

    describe("findById", function () {
        it("queries by numeric ID with the full projection", async function () {
            const row = { ID: 7, USERNAME: "alice" };
            const q = fakeQuery(row);
            const findSpy = vi.spyOn(OracleCollection.prototype, "find").mockReturnValue(q);

            await expect(AdminModel.findById("7")).resolves.toBe(row);
            expect(findSpy).toHaveBeenCalledWith({ ID: 7 });
            expect(q.project.mock.calls[0][0]).toMatchObject({
                ID: 1,
                USERNAME: 1,
                PASSWORD: 1,
                SYSSIGNATURE: 1,
            });
            expect(q.next).toHaveBeenCalledTimes(1);
        });

        it.each([null, undefined, "", "abc", NaN])(
            "returns null without querying for %p",
            async function (bad) {
                const findSpy = vi.spyOn(OracleCollection.prototype, "find");
                await expect(AdminModel.findById(bad)).resolves.toBeNull();
                expect(findSpy).not.toHaveBeenCalled();
            },
        );
    });

    describe("findByUsernames", function () {
        it("issues one bound $in query with de-duplicated names", async function () {
            const q = fakeQuery([{ USERNAME: "a" }]);
            const findSpy = vi.spyOn(OracleCollection.prototype, "find").mockReturnValue(q);

            await AdminModel.findByUsernames(["a", "b", "a", "", null]);

            expect(findSpy).toHaveBeenCalledTimes(1);
            expect(findSpy).toHaveBeenCalledWith({ USERNAME: { $in: ["a", "b"] } });
            expect(q.project.mock.calls[0][0]).not.toHaveProperty("PASSWORD");
        });

        it("returns [] without querying for an empty list", async function () {
            const findSpy = vi.spyOn(OracleCollection.prototype, "find");
            await expect(AdminModel.findByUsernames([])).resolves.toEqual([]);
            expect(findSpy).not.toHaveBeenCalled();
        });
    });

    describe("search", function () {
        function mockSearchConnection(rows = []) {
            const execute = vi.fn().mockResolvedValue({ rows });
            const spy = vi
                .spyOn(config, "withConnection")
                .mockImplementation(async (_name, cb) => cb({ execute }));
            return { execute, spy };
        }

        it("binds an upper-cased, %-wrapped needle and uses ESCAPE", async function () {
            const { execute, spy } = mockSearchConnection([{ USERNAME: "ALICE" }]);

            const rows = await AdminModel.search("  alice  ", 10);

            expect(rows).toEqual([{ USERNAME: "ALICE" }]);
            expect(spy).toHaveBeenCalledWith("appDb", expect.any(Function));
            const [sql, binds] = execute.mock.calls[0];
            expect(binds).toEqual({ q: "%ALICE%", lim: 10 });
            expect(sql).toMatch(/UPPER\(USERNAME\) LIKE :q ESCAPE '\\'/);
            expect(sql).toMatch(/UPPER\(EMAIL\)\s+LIKE :q ESCAPE '\\'/);
            expect(sql).toMatch(/FETCH FIRST :lim ROWS ONLY/);
            // Never interpolated.
            expect(sql).not.toContain("ALICE");
            expect(sql).not.toMatch(/PASSWORD|SYSSIGNATURE/);
        });

        it("escapes LIKE wildcards and the escape character", async function () {
            const { execute } = mockSearchConnection();

            await AdminModel.search("50%_a\\b");

            expect(execute.mock.calls[0][1].q).toBe("%50\\%\\_A\\\\B%");
        });

        it.each([
            [undefined, 20],
            [0, 20],
            [-5, 20],
            ["abc", 20],
            [1, 1],
            [7.9, 7],
            [50, 50],
            [51, 50],
            [10_000, 50],
        ])("clamps limit %p to %p", async function (limit, expected) {
            const { execute } = mockSearchConnection();
            await AdminModel.search("x", limit);
            expect(execute.mock.calls[0][1].lim).toBe(expected);
        });

        it("caps the needle at 100 characters", async function () {
            const { execute } = mockSearchConnection();
            await AdminModel.search("a".repeat(500));
            expect(execute.mock.calls[0][1].q).toBe(`%${"A".repeat(100)}%`);
        });

        it.each(["", "   ", null, undefined])(
            "returns [] without a query for blank %p",
            async function (q) {
                const { spy } = mockSearchConnection();
                await expect(AdminModel.search(q)).resolves.toEqual([]);
                expect(spy).not.toHaveBeenCalled();
            },
        );
    });

    describe("setEmail", function () {
        it("$sets EMAIL and UPDATED_AT keyed on USERNAME", async function () {
            const upd = vi
                .spyOn(OracleCollection.prototype, "updateOne")
                .mockResolvedValue({ modifiedCount: 1 });

            await AdminModel.setEmail("alice", "  alice@example.com ");

            expect(upd).toHaveBeenCalledTimes(1);
            const [filter, update] = upd.mock.calls[0];
            expect(filter).toEqual({ USERNAME: "alice" });
            expect(update.$set.EMAIL).toBe("alice@example.com");
            expect(update.$set.UPDATED_AT).toBeInstanceOf(Date);
            expect(update.$set).not.toHaveProperty("SYSSIGNATURE");
        });

        it("stores NULL for a blank address", async function () {
            const upd = vi
                .spyOn(OracleCollection.prototype, "updateOne")
                .mockResolvedValue({ modifiedCount: 1 });
            await AdminModel.setEmail("alice", "   ");
            expect(upd.mock.calls[0][1].$set.EMAIL).toBeNull();
        });
    });

    describe("withLastSuperAdminGuard", function () {
        it("locks active SUPER_ADMIN rows FOR UPDATE without FETCH FIRST", async function () {
            const { txSpy, session, query } = mockGuardTransaction([{ ID: 1 }, { ID: 2 }]);
            const fn = vi.fn().mockResolvedValue("done");

            await expect(AdminModel.withLastSuperAdminGuard(1, fn)).resolves.toBe("done");

            expect(txSpy).toHaveBeenCalledTimes(1);
            expect(session.collection).toHaveBeenCalledWith("T_ADMINS_DEV");
            const txCol = session.collection.mock.results[0].value;
            expect(txCol.find).toHaveBeenCalledWith({ ROLE: "SUPER_ADMIN", IS_ACTIVE: "Y" });
            expect(query.forUpdate).toHaveBeenCalledWith(true);
            expect(query.limit).not.toHaveBeenCalled();
            expect(fn).toHaveBeenCalledWith(session);
        });

        it("throws 409 LAST_ACTIVE_SUPER_ADMIN and never runs fn for the last one", async function () {
            mockGuardTransaction([{ ID: 1 }]);
            const fn = vi.fn();

            const err = await AdminModel.withLastSuperAdminGuard("1", fn).catch((e) => e);

            expect(err.isOperational).toBe(true);
            expect(err.statusCode).toBe(409);
            expect(err.message).toBe(ADMIN_ERRORS.LAST_ACTIVE_SUPER_ADMIN);
            expect(fn).not.toHaveBeenCalled();
        });

        it("error message has no top-level comma and balanced brackets", function () {
            const msg = ADMIN_ERRORS.LAST_ACTIVE_SUPER_ADMIN;
            expect(msg).not.toContain(",");
            for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"]]) {
                expect(msg.split(open).length).toBe(msg.split(close).length);
            }
        });

        it("runs fn when the target is not an active SUPER_ADMIN", async function () {
            mockGuardTransaction([{ ID: 1 }]);
            const fn = vi.fn().mockResolvedValue(42);
            await expect(AdminModel.withLastSuperAdminGuard(99, fn)).resolves.toBe(42);
            expect(fn).toHaveBeenCalledTimes(1);
        });

        it("propagates an error from fn (transaction rolls back)", async function () {
            mockGuardTransaction([{ ID: 1 }, { ID: 2 }]);
            const boom = new Error("write failed");
            await expect(
                AdminModel.withLastSuperAdminGuard(1, async () => { throw boom; }),
            ).rejects.toBe(boom);
        });

        it("routes session writes to the transaction-bound collection", async function () {
            const { session, txCol } = mockGuardTransaction([{ ID: 1 }, { ID: 2 }]);
            const poolUpdate = vi.spyOn(OracleCollection.prototype, "updateOne");
            const poolDelete = vi.spyOn(OracleCollection.prototype, "deleteOne");

            await AdminModel.withLastSuperAdminGuard(1, async (s) => {
                expect(s).toBe(session);
                await AdminModel.setActive("alice", "N", "sig", s);
                await AdminModel.updateRole("alice", "ADMIN", "sig", s);
                await AdminModel.deleteAdmin("alice", s);
            });

            expect(txCol.updateOne).toHaveBeenCalledTimes(2);
            expect(txCol.deleteOne).toHaveBeenCalledWith({ USERNAME: "alice" });
            expect(poolUpdate).not.toHaveBeenCalled();
            expect(poolDelete).not.toHaveBeenCalled();
        });
    });
});

describe("AdminModel — DEMO_MODE branches", function () {
    beforeEach(function () {
        process.env.DEMO_MODE = "true";
        // Fixture mirroring demoStore's accounts, minus the Argon2 hashing
        // (which needs ARGON2_PEPPER); a fresh copy per test keeps writes isolated.
        const admins = [
            { ID: 1, USERNAME: "admin", PASSWORD: "h", ROLE: "SUPER_ADMIN", IS_ACTIVE: "Y", SYSSIGNATURE: "s" },
            { ID: 2, USERNAME: "manager", PASSWORD: "h", ROLE: "ADMIN", IS_ACTIVE: "Y", SYSSIGNATURE: "s" },
        ];
        vi.spyOn(demo, "accounts").mockResolvedValue({ admins, users: [] });
    });

    afterEach(function () {
        if (ORIGINAL_DEMO_MODE === undefined) delete process.env.DEMO_MODE;
        else process.env.DEMO_MODE = ORIGINAL_DEMO_MODE;
        vi.restoreAllMocks();
    });

    it("never touches Oracle", async function () {
        const findSpy = vi.spyOn(OracleCollection.prototype, "find");
        const connSpy = vi.spyOn(config, "withConnection");
        const txSpy = vi.spyOn(Transaction.prototype, "withTransaction");

        await AdminModel.findById(1);
        await AdminModel.search("adm");
        await AdminModel.countActiveByRole("SUPER_ADMIN", null);
        await AdminModel.setEmail("admin", "a@demo.local");
        await AdminModel.withLastSuperAdminGuard(2, async () => {});

        expect(findSpy).not.toHaveBeenCalled();
        expect(connSpy).not.toHaveBeenCalled();
        expect(txSpy).not.toHaveBeenCalled();
    });

    it("findById resolves the demo admin by numeric id", async function () {
        expect((await AdminModel.findById("1")).USERNAME).toBe("admin");
        expect(await AdminModel.findById(999)).toBeNull();
    });

    it("countActiveByRole counts everyone when the exclusion is null", async function () {
        expect(await AdminModel.countActiveByRole("SUPER_ADMIN", null)).toBe(1);
        expect(await AdminModel.countActiveByRole("SUPER_ADMIN", "admin")).toBe(0);
    });

    it("search is case-insensitive, matches literally and never returns secrets", async function () {
        const rows = await AdminModel.search("MAN");
        expect(rows.map((r) => r.USERNAME)).toEqual(["manager"]);
        expect(rows[0]).not.toHaveProperty("PASSWORD");
        expect(rows[0]).not.toHaveProperty("SYSSIGNATURE");
        expect(await AdminModel.search("%")).toEqual([]);
        expect(await AdminModel.search("a", 1)).toHaveLength(1);
    });

    it("setEmail persists to the demo row", async function () {
        await AdminModel.setEmail("manager", "m@demo.local");
        expect((await AdminModel.findByUsername("manager")).EMAIL).toBe("m@demo.local");
    });

    it("guard refuses the only active SUPER_ADMIN and runs fn(null) otherwise", async function () {
        const fn = vi.fn().mockResolvedValue("ok");
        await expect(AdminModel.withLastSuperAdminGuard(1, fn)).rejects.toMatchObject({
            statusCode: 409,
        });
        expect(fn).not.toHaveBeenCalled();

        await expect(AdminModel.withLastSuperAdminGuard(2, fn)).resolves.toBe("ok");
        expect(fn).toHaveBeenCalledWith(null);
    });
});
