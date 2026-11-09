"use strict";

/**
 * @fileoverview dbTimezoneOffsetMinutes — the one reader of
 * DB_TIMEZONE_OFFSET_MINUTES. The call-site defects it closes are proven in
 * test/server/unit/services/dbTimezoneOffset.defects.test.js.
 */

const { dbTimezoneOffsetMinutes, verifyDbClockOffset, DEFAULT_DB_TZ_OFFSET_MINUTES } = require("../../../../src/utils/dbTimezone");
const { logger } = require("../../../../src/utils/logger");

let saved;

beforeEach(function () {
    saved = process.env.DB_TIMEZONE_OFFSET_MINUTES;
});

afterEach(function () {
    vi.restoreAllMocks();
    if (saved === undefined) delete process.env.DB_TIMEZONE_OFFSET_MINUTES;
    else process.env.DB_TIMEZONE_OFFSET_MINUTES = saved;
});

function withValue(value) {
    if (value === undefined) delete process.env.DB_TIMEZONE_OFFSET_MINUTES;
    else process.env.DB_TIMEZONE_OFFSET_MINUTES = value;
}

describe("dbTimezoneOffsetMinutes", function () {
    it("defaults to 480 (UTC+8)", function () {
        expect(DEFAULT_DB_TZ_OFFSET_MINUTES).toBe(480);
    });

    it.each([
        ["+8h"],
        ["480.5"],
        ["28800"], // seconds instead of minutes
        ["841"],
        ["-721"],
        ["NaN"],
    ])("falls back to the default and warns for %j", function (value) {
        const warn = vi.spyOn(logger, "warning").mockImplementation(() => {});
        withValue(value);

        expect(dbTimezoneOffsetMinutes()).toBe(480);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain(`"${value}"`);
    });

    it("warns once per distinct bad value, not on every call", function () {
        const warn = vi.spyOn(logger, "warning").mockImplementation(() => {});
        withValue("8 hours");

        dbTimezoneOffsetMinutes();
        dbTimezoneOffsetMinutes();
        dbTimezoneOffsetMinutes();

        expect(warn).toHaveBeenCalledTimes(1);
    });

    it.each([[undefined], [""], ["   "]])("treats %j as unset: default, no warning", function (value) {
        const warn = vi.spyOn(logger, "warning").mockImplementation(() => {});
        withValue(value);

        expect(dbTimezoneOffsetMinutes()).toBe(480);
        expect(warn).not.toHaveBeenCalled();
    });

    it.each([
        ["480", 480],
        [" 480 ", 480],
        ["0", 0],
        ["-330", -330],
        ["345", 345],
        ["840", 840],
        ["-720", -720],
    ])("honours a valid value %j → %i", function (value, expected) {
        const warn = vi.spyOn(logger, "warning").mockImplementation(() => {});
        withValue(value);

        expect(dbTimezoneOffsetMinutes()).toBe(expected);
        expect(warn).not.toHaveBeenCalled();
    });
});

describe("verifyDbClockOffset", function () {
    /** Fake src/config adapter whose SYSTIMESTAMP offset is `offMin` (or throws). */
    function fakeDb(offMin) {
        const execute = vi.fn(async () => {
            if (offMin instanceof Error) throw offMin;
            return { rows: [{ OFF_MIN: offMin }] };
        });
        return {
            execute,
            db: {
                oracledb: { OUT_FORMAT_OBJECT: 4002 },
                withConnection: vi.fn(async (name, cb) => cb({ execute })),
            },
        };
    }

    it("stays quiet when database, setting and app agree (UTC+8)", async function () {
        const warn = vi.spyOn(logger, "warning").mockImplementation(() => {});
        withValue("480");
        const { db } = fakeDb(480);

        const r = await verifyDbClockOffset(db, { appOffsetMinutes: 480 });

        expect(r).toEqual({ dbOffsetMinutes: 480, configuredMinutes: 480, appOffsetMinutes: 480, match: true });
        expect(warn).not.toHaveBeenCalled();
        expect(db.withConnection.mock.calls[0][0]).toBe("appDb");
    });

    it("warns once when the database clock is UTC but the app and setting are UTC+8 (the observed defect)", async function () {
        const warn = vi.spyOn(logger, "warning").mockImplementation(() => {});
        withValue("480");
        const { db } = fakeDb(0);

        const r = await verifyDbClockOffset(db, { appOffsetMinutes: 480 });

        expect(r.match).toBe(false);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain("UTC+00:00");
        expect(warn.mock.calls[0][0]).toContain("UTC+08:00");
        expect(warn.mock.calls[0][0]).toContain("DEFAULT SYSTIMESTAMP");
    });

    it("warns when the app process zone differs even if the setting matches the database", async function () {
        const warn = vi.spyOn(logger, "warning").mockImplementation(() => {});
        withValue("0");
        const { db } = fakeDb(0);

        const r = await verifyDbClockOffset(db, { appOffsetMinutes: 480 });

        expect(r.match).toBe(false);
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it("formats negative and half-hour offsets", async function () {
        const warn = vi.spyOn(logger, "warning").mockImplementation(() => {});
        withValue("345");
        const { db } = fakeDb(-210);

        await verifyDbClockOffset(db, { appOffsetMinutes: 345 });

        expect(warn.mock.calls[0][0]).toContain("UTC-03:30");
        expect(warn.mock.calls[0][0]).toContain("UTC+05:45");
    });

    it("never throws when the database is unreachable: warns and returns null", async function () {
        const warn = vi.spyOn(logger, "warning").mockImplementation(() => {});
        const { db } = fakeDb(new Error("ORA-12541: no listener"));

        await expect(verifyDbClockOffset(db, { appOffsetMinutes: 480 })).resolves.toBeNull();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain("ORA-12541");
    });

    it("accepts array-shaped rows and rejects a non-numeric offset", async function () {
        vi.spyOn(logger, "warning").mockImplementation(() => {});
        withValue("480");
        const execute = vi.fn(async () => ({ rows: [[480]] }));
        const db = { withConnection: async (n, cb) => cb({ execute }) };
        await expect(verifyDbClockOffset(db, { appOffsetMinutes: 480 })).resolves.toMatchObject({ match: true });

        const bad = { withConnection: async (n, cb) => cb({ execute: async () => ({ rows: [{ OFF_MIN: null }] }) }) };
        await expect(verifyDbClockOffset(bad, { appOffsetMinutes: 480 })).resolves.toBeNull();
    });
});
