"use strict";

const {
    parseFilter,
    resetBindCounter,
} = require("../../../../src/utils/oracle-mongo-wrapper/parsers/filterParser");

describe("filterParser — parseFilter", function () {
    describe("empty / null filter", function () {
        it("returns empty whereClause for null", function () {
            const { whereClause, binds } = parseFilter(null);
            expect(whereClause).toBe("");
            expect(binds).toEqual({});
        });

        it("returns empty whereClause for undefined", function () {
            const { whereClause, binds } = parseFilter(undefined);
            expect(whereClause).toBe("");
            expect(binds).toEqual({});
        });

        it("returns empty whereClause for empty object", function () {
            const { whereClause, binds } = parseFilter({});
            expect(whereClause).toBe("");
            expect(binds).toEqual({});
        });
    });

    describe("equality (implicit $eq)", function () {
        it("produces WHERE with = for a string value", function () {
            const { whereClause, binds } = parseFilter({ status: "active" });
            expect(whereClause).toContain("WHERE");
            expect(whereClause).toContain('"status"');
            expect(whereClause).toContain("=");
            expect(Object.values(binds)).toContain("active");
        });

        it("produces WHERE with = for a numeric value", function () {
            const { whereClause, binds } = parseFilter({ age: 25 });
            expect(whereClause).toContain('"age"');
            expect(Object.values(binds)).toContain(25);
        });

        it("produces IS NULL for null value", function () {
            const { whereClause } = parseFilter({ status: null });
            expect(whereClause).toContain("IS NULL");
        });
    });

    describe("comparison operators", function () {
        it("$gt produces >", function () {
            const { whereClause, binds } = parseFilter({ age: { $gt: 18 } });
            expect(whereClause).toContain('"age" >');
            expect(Object.values(binds)).toContain(18);
        });

        it("$gte produces >=", function () {
            const { whereClause } = parseFilter({ age: { $gte: 18 } });
            expect(whereClause).toContain('"age" >=');
        });

        it("$lt produces <", function () {
            const { whereClause } = parseFilter({ age: { $lt: 65 } });
            expect(whereClause).toContain('"age" <');
        });

        it("$lte produces <=", function () {
            const { whereClause } = parseFilter({ age: { $lte: 65 } });
            expect(whereClause).toContain('"age" <=');
        });

        it("$ne produces <>", function () {
            const { whereClause } = parseFilter({ status: { $ne: "deleted" } });
            expect(whereClause).toContain('"status" <>');
        });

        it("$eq produces =", function () {
            const { whereClause } = parseFilter({ status: { $eq: "active" } });
            expect(whereClause).toContain('"status" =');
        });
    });

    describe("$in / $nin", function () {
        it("$in produces IN clause", function () {
            const { whereClause, binds } = parseFilter({
                role: { $in: ["admin", "user"] },
            });
            expect(whereClause).toContain("IN (");
            expect(Object.values(binds)).toContain("admin");
            expect(Object.values(binds)).toContain("user");
        });

        it("$in with empty array produces 1=0 (always false)", function () {
            const { whereClause } = parseFilter({ role: { $in: [] } });
            expect(whereClause).toContain("1=0");
        });

        it("$nin produces NOT IN clause", function () {
            const { whereClause } = parseFilter({ role: { $nin: ["banned"] } });
            expect(whereClause).toContain("NOT IN");
        });

        it("$nin with empty array produces 1=1 (always true)", function () {
            const { whereClause } = parseFilter({ role: { $nin: [] } });
            expect(whereClause).toContain("1=1");
        });

        it("$in with exactly 1000 values stays a single IN group", function () {
            const vals = Array.from({ length: 1000 }, (_, i) => i);
            const { whereClause, binds } = parseFilter({ GID: { $in: vals } });
            expect(whereClause.match(/ IN \(/g)).toHaveLength(1);
            expect(whereClause).not.toContain(" OR ");
            expect(Object.keys(binds)).toHaveLength(1000);
        });

        it("$in with >1000 values splits into OR-joined IN groups (ORA-01795)", function () {
            const vals = Array.from({ length: 2500 }, (_, i) => i);
            const { whereClause, binds } = parseFilter({ GID: { $in: vals } });
            // 2500 values → 3 groups (1000 + 1000 + 500), OR-joined
            expect(whereClause.match(/ IN \(/g)).toHaveLength(3);
            expect(whereClause.match(/ OR /g)).toHaveLength(2);
            expect(Object.keys(binds)).toHaveLength(2500);
            // Every value still bound — no raw interpolation in the IN lists
            expect(Object.values(binds)).toContain(0);
            expect(Object.values(binds)).toContain(2499);
        });

        it("$nin with >1000 values splits into AND-joined NOT IN groups", function () {
            const vals = Array.from({ length: 1500 }, (_, i) => i);
            const { whereClause, binds } = parseFilter({ GID: { $nin: vals } });
            expect(whereClause.match(/NOT IN \(/g)).toHaveLength(2);
            expect(whereClause.match(/ AND /g)).toHaveLength(1);
            expect(Object.keys(binds)).toHaveLength(1500);
        });
    });

    describe("$between / $notBetween", function () {
        it("$between produces BETWEEN clause", function () {
            const { whereClause, binds } = parseFilter({
                age: { $between: [18, 65] },
            });
            expect(whereClause).toContain("BETWEEN");
            expect(whereClause).toContain("AND");
            expect(Object.values(binds)).toContain(18);
            expect(Object.values(binds)).toContain(65);
        });

        it("$notBetween produces NOT BETWEEN clause", function () {
            const { whereClause } = parseFilter({
                age: { $notBetween: [0, 17] },
            });
            expect(whereClause).toContain("NOT BETWEEN");
        });
    });

    describe("$exists", function () {
        it("$exists: true produces IS NOT NULL", function () {
            const { whereClause } = parseFilter({ email: { $exists: true } });
            expect(whereClause).toContain("IS NOT NULL");
        });

        it("$exists: false produces IS NULL", function () {
            const { whereClause } = parseFilter({ email: { $exists: false } });
            expect(whereClause).toContain("IS NULL");
        });
    });

    describe("$regex", function () {
        it("produces REGEXP_LIKE", function () {
            const { whereClause, binds } = parseFilter({
                name: { $regex: "^J" },
            });
            expect(whereClause).toContain("REGEXP_LIKE");
            expect(Object.values(binds)).toContain("^J");
        });
    });

    describe("$like", function () {
        it("produces LIKE clause", function () {
            const { whereClause, binds } = parseFilter({
                name: { $like: "%Juan%" },
            });
            expect(whereClause).toContain("LIKE");
            expect(Object.values(binds)).toContain("%Juan%");
        });
    });

    describe("logical operators", function () {
        it("$or produces OR-joined conditions", function () {
            const { whereClause, binds } = parseFilter({
                $or: [{ status: "active" }, { role: "admin" }],
            });
            expect(whereClause).toContain("OR");
            expect(Object.values(binds)).toContain("active");
            expect(Object.values(binds)).toContain("admin");
        });

        it("$and produces AND-joined conditions", function () {
            const { whereClause } = parseFilter({
                $and: [{ status: "active" }, { age: { $gte: 18 } }],
            });
            expect(whereClause).toContain("AND");
        });

        it("$nor produces NOT (... OR ...)", function () {
            const { whereClause } = parseFilter({
                $nor: [{ status: "deleted" }, { status: "banned" }],
            });
            expect(whereClause).toContain("NOT (");
            expect(whereClause).toContain("OR");
        });

        it("$not produces NOT (...)", function () {
            const { whereClause } = parseFilter({
                $not: { status: "deleted" },
            });
            expect(whereClause).toContain("NOT (");
        });
    });

    describe("multiple fields (implicit AND)", function () {
        it("joins multiple field conditions with AND", function () {
            const { whereClause, binds } = parseFilter({
                status: "active",
                age: { $gte: 18 },
            });
            expect(whereClause).toContain("AND");
            expect(Object.values(binds)).toContain("active");
            expect(Object.values(binds)).toContain(18);
        });
    });

    describe("multiple operators on one field", function () {
        it("wraps in parentheses with AND", function () {
            const { whereClause, binds } = parseFilter({
                age: { $gte: 18, $lt: 65 },
            });
            expect(whereClause).toContain("(");
            expect(whereClause).toContain("AND");
            expect(Object.values(binds)).toContain(18);
            expect(Object.values(binds)).toContain(65);
        });
    });

    describe("bind variable isolation (concurrency safety)", function () {
        it("two separate calls produce independent bind names", function () {
            const r1 = parseFilter({ status: "a" });
            const r2 = parseFilter({ status: "b" });
            // Both should start from _0 since counters are per-call
            const keys1 = Object.keys(r1.binds);
            const keys2 = Object.keys(r2.binds);
            expect(keys1[0]).toMatch(/_0$/);
            expect(keys2[0]).toMatch(/_0$/);
        });
    });

    describe("resetBindCounter", function () {
        it("is a no-op and does not throw", function () {
            expect(() => resetBindCounter()).not.toThrow();
        });
    });

    describe("$exists (top-level subquery)", function () {
        it("produces EXISTS (SELECT 1 FROM ...)", function () {
            const { whereClause } = parseFilter({
                $exists: { collection: "ORDERS", match: { status: "active" } },
            });
            expect(whereClause).toContain("EXISTS (SELECT 1 FROM");
        });
    });

    describe("$notExists (top-level subquery)", function () {
        it("produces NOT EXISTS (SELECT 1 FROM ...)", function () {
            const { whereClause } = parseFilter({
                $notExists: {
                    collection: "ORDERS",
                    match: { status: "cancelled" },
                },
            });
            expect(whereClause).toContain("NOT EXISTS (SELECT 1 FROM");
        });
    });
});
