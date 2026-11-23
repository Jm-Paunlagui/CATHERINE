"use strict";

/**
 * @fileoverview demoStore: memoised accounts, seeded audit/FX/ledger fixtures,
 * append-only reversal semantics and the Mongo-style filter matcher.
 */

import demo from "../../../../../src/models/demo/demoStore";
import { CryptoVault } from "../../../../../src/utils/encryption/CryptoVault";

describe("demoStore", function () {
    afterEach(function () {
        vi.restoreAllMocks();
    });

    describe("accounts", function () {
        it("builds admins and users once, hashed and signed, and memoises the promise", async function () {
            const hash = vi.spyOn(CryptoVault, "hashPassword").mockImplementation(async (pw: string) => `hashed:${pw}`);
            const sign = vi.spyOn(CryptoVault, "signRecord").mockImplementation(async (ctx: string) => `sig:${ctx}`);
            const first = await demo.accounts();
            expect(hash).toHaveBeenCalledTimes(1);
            expect(sign).toHaveBeenCalledTimes(2);
            const second = await demo.accounts();
            expect(second).toBe(first);
            expect(first.admins.map((a) => a.ROLE)).toEqual(["SUPER_ADMIN", "ADMIN"]);
            expect(first.users).toHaveLength(1);
            for (const a of first.admins) {
                expect(a.PASSWORD).toBe(`hashed:${demo.DEMO_PASSWORD}`);
                expect(a.SYSSIGNATURE).toBe("sig:T_ADMINS_DEV");
            }
        });
    });

    describe("audit logs", function () {
        it("seeds 200 rows spanning every status band with a consistent category", function () {
            const rows = demo.auditLogs();
            expect(rows.length).toBeGreaterThanOrEqual(200);
            const cats = new Set(rows.map((r) => r.STATUS_CATEGORY));
            expect([...cats].sort()).toEqual(["2xx", "3xx", "4xx", "5xx"]);
            for (const r of rows.slice(0, 200)) {
                expect(r.STATUS_CATEGORY).toBe(`${Math.floor(r.STATUS_CODE / 100)}xx`);
                expect(r.USERNAME === null).toBe(r.USER_ID === 0);
                expect(r.REQUEST_ID).toMatch(/^\d{13}-0000-\d{4}$/);
            }
        });

        it("auditInsert defaults CREATED_AT to now and keeps an explicit one", function () {
            vi.useFakeTimers();
            vi.setSystemTime(new Date("2030-05-05T00:00:00Z"));
            const base = { REQUEST_ID: "r", USER_ID: 1, USERNAME: "u", METHOD: "GET", ENDPOINT: "/x", PARAMS: null, STATUS_CODE: 200, STATUS_CATEGORY: "2xx", RESPONSE_TIME_MS: 1, CLIENT_IP: "1.1.1.1", SERVER_IP: "2.2.2.2" };
            const before = demo.auditLogs().length;
            expect(demo.auditInsert(base as never)).toEqual({ rowsAffected: 1 });
            const explicit = new Date("2001-01-01T00:00:00Z");
            demo.auditInsert({ ...base, CREATED_AT: explicit } as never);
            const rows = demo.auditLogs();
            expect(rows).toHaveLength(before + 2);
            expect(rows[before].CREATED_AT).toEqual(new Date("2030-05-05T00:00:00Z"));
            expect(rows[before + 1].CREATED_AT).toBe(explicit);
            expect(rows[before + 1].ID).toBe(rows[before].ID + 1);
            vi.useRealTimers();
        });
    });

    describe("FX rates", function () {
        it("appends with an incrementing id and fixed-scale string rates", function () {
            const before = demo.fxRates().length;
            const res = demo.fxRateInsert({
                CURRENCY_CODE: "GBP", RATE: "70.00000000", EFFECTIVE_FROM: new Date("2027-01-01T00:00:00Z"),
                EFFECTIVE_TO: null, SOURCE: "MANUAL", RETRIEVED_AT: new Date("2027-01-01T00:00:00Z"), SET_BY: "t",
            });
            expect(res.rowsAffected).toBe(1);
            expect(res.insertedId).toBe(before + 1);
            expect(demo.fxRates().at(-1)).toMatchObject({ ID: before + 1, RATE: "70.00000000" });
            for (const r of demo.fxRates()) expect(typeof r.RATE).toBe("string");
        });
    });

    describe("ledger", function () {
        it("inserts with optional memo / reversal defaults", function () {
            const a = demo.ledgerInsert({ DIRECTION: "DEBIT", AMOUNT: "1.0000" });
            const row = demo.ledger().find((r) => r.ID === a.insertedId);
            expect(row).toMatchObject({ MEMO: null, REVERSES_ID: null, DIRECTION: "DEBIT" });
            const b = demo.ledgerInsert({ DIRECTION: "CREDIT", AMOUNT: "2.0000", MEMO: "m", REVERSES_ID: 1 });
            expect(demo.ledger().find((r) => r.ID === b.insertedId)).toMatchObject({ MEMO: "m", REVERSES_ID: 1 });
        });

        it("reverseEntry appends an equal-and-opposite row and never mutates the original", function () {
            const credit = demo.ledger().find((r) => r.ID === 1)!;
            const snapshot = { ...credit };
            const rev = demo.reverseEntry(1, "oops");
            expect(demo.ledger().find((r) => r.ID === 1)).toEqual(snapshot);
            expect(demo.ledger().find((r) => r.ID === rev.insertedId)).toMatchObject({ DIRECTION: "DEBIT", AMOUNT: snapshot.AMOUNT, MEMO: "oops", REVERSES_ID: 1 });
            const debit = demo.ledger().find((r) => r.ID === 2)!;
            const rev2 = demo.reverseEntry(debit.ID, undefined as unknown as string);
            expect(demo.ledger().find((r) => r.ID === rev2.insertedId)).toMatchObject({ DIRECTION: "CREDIT", MEMO: "Reversal of #2" });
        });

        it("reverseEntry throws for an unknown id and appends nothing", function () {
            const n = demo.ledger().length;
            expect(() => demo.reverseEntry(999999, "x")).toThrow("Cannot reverse ledger row 999999: not found.");
            expect(demo.ledger()).toHaveLength(n);
        });
    });

    describe("platform tables", function () {
        it("exposes mutable shared collections and a monotonic vote id", function () {
            expect(demo.refreshTokens()).toBe(demo.refreshTokens());
            expect(demo.backupTokensConsumed()).toBeInstanceOf(Map);
            expect(demo.backupVotes()).toBe(demo.backupVotes());
            expect(demo.systemConfig()).toBeInstanceOf(Map);
            const a = demo.nextBackupVoteId();
            expect(demo.nextBackupVoteId()).toBe(a + 1);
        });
    });

    describe("match (filter matcher)", function () {
        const row = { n: 5, s: "Hello", d: new Date("2026-03-01T00:00:00Z"), iso: "2026-03-01T00:00:00Z", nil: null as unknown };

        it("treats empty / non-object filters as match-all", function () {
            expect(demo.match(row, undefined)).toBe(true);
            expect(demo.match(row, "x")).toBe(true);
            expect(demo.match(row, {})).toBe(true);
        });

        it("matches plain equality and arrays/dates by identity", function () {
            expect(demo.match(row, { n: 5 })).toBe(true);
            expect(demo.match(row, { n: 6 })).toBe(false);
            expect(demo.match(row, { d: row.d })).toBe(true);
            expect(demo.match(row, { d: new Date(row.d) })).toBe(false);
        });

        it("supports comparison operators incl. Date and ISO-string coercion", function () {
            expect(demo.match(row, { n: { $eq: 5 } })).toBe(true);
            expect(demo.match(row, { n: { $ne: 5 } })).toBe(false);
            expect(demo.match(row, { n: { $gt: 4, $lt: 6 } })).toBe(true);
            expect(demo.match(row, { n: { $gte: 5, $lte: 5 } })).toBe(true);
            expect(demo.match(row, { n: { $gt: 5 } })).toBe(false);
            expect(demo.match(row, { d: { $gte: new Date("2026-02-01T00:00:00Z") } })).toBe(true);
            expect(demo.match(row, { d: { $lt: "2026-02-01T00:00:00Z" } })).toBe(false);
            expect(demo.match(row, { iso: { $gte: row.d } })).toBe(true);
            expect(demo.match(row, { s: { $gt: "Abc" } })).toBe(true);
        });

        it("supports $in, $nin and $exists (non-array operands never match)", function () {
            expect(demo.match(row, { n: { $in: [1, 5] } })).toBe(true);
            expect(demo.match(row, { n: { $in: [1] } })).toBe(false);
            expect(demo.match(row, { n: { $in: 5 } })).toBe(false);
            expect(demo.match(row, { n: { $nin: [1] } })).toBe(true);
            expect(demo.match(row, { n: { $nin: [5] } })).toBe(false);
            expect(demo.match(row, { n: { $nin: "x" } })).toBe(false);
            expect(demo.match(row, { n: { $exists: true } })).toBe(true);
            expect(demo.match(row, { nil: { $exists: true } })).toBe(false);
            expect(demo.match(row, { nil: { $exists: false } })).toBe(true);
            expect(demo.match(row, { missing: { $exists: false } })).toBe(true);
        });

        it("rejects unknown operators (fail closed) instead of matching", function () {
            expect(demo.match(row, { n: { $where: "1" } })).toBe(false);
        });

        it("supports $regex with and without the i option, and null columns", function () {
            expect(demo.match(row, { s: { $regex: "^hel" } })).toBe(false);
            expect(demo.match(row, { s: { $regex: "^hel", $options: "i" } })).toBe(true);
            expect(demo.match(row, { s: { $regex: /ell/ } })).toBe(true);
            expect(demo.match(row, { nil: { $regex: "^$" } })).toBe(true);
            expect(demo.match(row, { s: { $regex: "ell", $options: "m" } })).toBe(true);
        });

        it("supports $or and $and including malformed operands", function () {
            expect(demo.match(row, { $or: [{ n: 1 }, { s: "Hello" }] })).toBe(true);
            expect(demo.match(row, { $or: [{ n: 1 }, { s: "x" }] })).toBe(false);
            expect(demo.match(row, { $or: "bad" })).toBe(false);
            expect(demo.match(row, { $and: [{ n: 5 }, { s: "Hello" }] })).toBe(true);
            expect(demo.match(row, { $and: [{ n: 5 }, { s: "x" }] })).toBe(false);
            expect(demo.match(row, { $and: {} })).toBe(false);
        });
    });
});
