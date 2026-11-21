"use strict";

// `expect`, `describe`, `it` → injected globally by Vitest (globals: true)
const { formatUtcStamp } = require("../../../../src/utils/formatUtcStamp");

describe("formatUtcStamp", function () {
    const d = new Date("2026-11-03T06:32:05.672Z");

    it("short form matches Node's dateStyle medium + timeStyle short, on any engine", function () {
        expect(formatUtcStamp(d)).toBe("Nov 3, 2026, 6:32 AM");
    });

    it("seconds form matches Node's dateStyle medium + timeStyle medium", function () {
        expect(formatUtcStamp(d, { seconds: true })).toBe("Nov 3, 2026, 6:32:05 AM");
    });

    it("never uses JavaScriptCore's ' at ' date-time joiner", function () {
        expect(formatUtcStamp(d)).not.toContain(" at ");
    });

    it("renders in UTC regardless of the process timezone, including PM and midnight", function () {
        expect(formatUtcStamp(new Date("2026-01-09T23:05:00Z"))).toBe("Jan 9, 2026, 11:05 PM");
        expect(formatUtcStamp(new Date("2026-01-09T00:00:00Z"))).toBe("Jan 9, 2026, 12:00 AM");
    });
});
