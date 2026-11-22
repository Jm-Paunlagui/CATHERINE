"use strict";

const {
    parseUpdate,
    resetUpdateCounter,
} = require("../../../../src/utils/oracle-mongo-wrapper/parsers/updateParser");

describe("updateParser — parseUpdate", function () {
    describe("validation", function () {
        it("throws when update is null", function () {
            expect(() => parseUpdate(null)).toThrow();
        });

        it("throws when update is undefined", function () {
            expect(() => parseUpdate(undefined)).toThrow();
        });

        it("throws when update is empty object", function () {
            expect(() => parseUpdate({})).toThrow();
        });

        it("throws when update has no $ operators", function () {
            expect(() => parseUpdate({ name: "Ana" })).toThrow();
        });
    });

    describe("$set", function () {
        it("produces SET clause for a single field", function () {
            const { setClause, binds } = parseUpdate({ $set: { name: "Ana" } });
            expect(setClause).toContain("SET");
            expect(setClause).toContain('"name"');
            expect(Object.values(binds)).toContain("Ana");
        });

        it("produces SET clause for multiple fields", function () {
            const { setClause, binds } = parseUpdate({
                $set: { name: "Ana", status: "active" },
            });
            expect(setClause).toContain('"name"');
            expect(setClause).toContain('"status"');
            expect(Object.values(binds)).toContain("Ana");
            expect(Object.values(binds)).toContain("active");
        });

        it("handles numeric values", function () {
            const { setClause, binds } = parseUpdate({ $set: { age: 25 } });
            expect(setClause).toContain('"age"');
            expect(Object.values(binds)).toContain(25);
        });

        it("handles null values", function () {
            const { setClause, binds } = parseUpdate({ $set: { email: null } });
            expect(setClause).toContain('"email"');
            expect(Object.values(binds)).toContain(null);
        });
    });

    describe("$unset", function () {
        it("produces SET field = NULL", function () {
            const { setClause, binds } = parseUpdate({ $unset: { temp: 1 } });
            expect(setClause).toContain('"temp" = NULL');
            expect(Object.keys(binds).length).toBe(0);
        });

        it("handles multiple fields", function () {
            const { setClause } = parseUpdate({
                $unset: { temp: 1, cache: 1 },
            });
            expect(setClause).toContain('"temp" = NULL');
            expect(setClause).toContain('"cache" = NULL');
        });
    });

    describe("$inc", function () {
        it("produces field = field + :val", function () {
            const { setClause, binds } = parseUpdate({
                $inc: { loginCount: 1 },
            });
            expect(setClause).toContain('"loginCount" = "loginCount" +');
            expect(Object.values(binds)).toContain(1);
        });

        it("handles negative increments (decrement)", function () {
            const { setClause, binds } = parseUpdate({ $inc: { score: -5 } });
            expect(setClause).toContain('"score" = "score" +');
            expect(Object.values(binds)).toContain(-5);
        });
    });

    describe("$mul", function () {
        it("produces field = field * :val", function () {
            const { setClause, binds } = parseUpdate({ $mul: { price: 1.1 } });
            expect(setClause).toContain('"price" = "price" *');
            expect(Object.values(binds)).toContain(1.1);
        });
    });

    describe("$min", function () {
        it("produces LEAST(field, :val)", function () {
            const { setClause, binds } = parseUpdate({ $min: { score: 50 } });
            expect(setClause).toContain("LEAST(");
            expect(Object.values(binds)).toContain(50);
        });
    });

    describe("$max", function () {
        it("produces GREATEST(field, :val)", function () {
            const { setClause, binds } = parseUpdate({ $max: { score: 100 } });
            expect(setClause).toContain("GREATEST(");
            expect(Object.values(binds)).toContain(100);
        });
    });

    describe("$currentDate", function () {
        it("produces field = SYSDATE", function () {
            const { setClause, binds } = parseUpdate({
                $currentDate: { updatedAt: true },
            });
            expect(setClause).toContain('"updatedAt" = SYSDATE');
            expect(Object.keys(binds).length).toBe(0);
        });
    });

    describe("$rename", function () {
        it("throws an error (not supported by Oracle)", function () {
            expect(() =>
                parseUpdate({ $rename: { oldField: "newField" } }),
            ).toThrow();
        });
    });

    describe("unsupported operator", function () {
        it("throws for unknown operators", function () {
            expect(() => parseUpdate({ $push: { arr: "val" } })).toThrow();
        });
    });

    describe("combined operators", function () {
        it("handles $set + $inc together", function () {
            const { setClause, binds } = parseUpdate({
                $set: { name: "Ana" },
                $inc: { loginCount: 1 },
            });
            expect(setClause).toContain('"name"');
            expect(setClause).toContain('"loginCount" = "loginCount" +');
            expect(Object.values(binds)).toContain("Ana");
            expect(Object.values(binds)).toContain(1);
        });

        it("handles $set + $currentDate together", function () {
            const { setClause } = parseUpdate({
                $set: { status: "active" },
                $currentDate: { updatedAt: true },
            });
            expect(setClause).toContain('"status"');
            expect(setClause).toContain("SYSDATE");
        });
    });

    describe("bind variable naming", function () {
        it("uses upd_ prefix for bind variables", function () {
            const { binds } = parseUpdate({ $set: { name: "Ana" } });
            const key = Object.keys(binds)[0];
            expect(key).toMatch(/^upd_/);
        });

        it("two separate calls produce independent bind names", function () {
            const r1 = parseUpdate({ $set: { a: 1 } });
            const r2 = parseUpdate({ $set: { a: 2 } });
            const k1 = Object.keys(r1.binds)[0];
            const k2 = Object.keys(r2.binds)[0];
            expect(k1).toMatch(/_0$/);
            expect(k2).toMatch(/_0$/);
        });
    });

    describe("resetUpdateCounter", function () {
        it("is a no-op and does not throw", function () {
            expect(() => resetUpdateCounter()).not.toThrow();
        });
    });
});
