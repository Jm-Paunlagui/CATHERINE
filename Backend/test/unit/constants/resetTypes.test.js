"use strict";

/**
 * Unit tests for the wallet reset-type taxonomy (src/constants/resetTypes.js).
 * Pure — no DB, no HTTP.
 */

const {
    RESET_TYPES,
    LEGACY_RESET_TYPE_MAP,
    normalizeResetType,
} = require("../../../src/constants/resetTypes");

describe("resetTypes", function () {
    describe("RESET_TYPES", function () {
        it("exposes the four canonical values", function () {
            expect(RESET_TYPES).toEqual({
                ONBOARD: "ONBOARD",
                FIRST_HALF: "FIRST_HALF",
                SECOND_HALF: "SECOND_HALF",
                RESET_REQUEST: "RESET_REQUEST",
            });
        });

        it("is frozen (immutable)", function () {
            expect(Object.isFrozen(RESET_TYPES)).toBe(true);
        });
    });

    describe("normalizeResetType", function () {
        it("maps each legacy value to its canonical name", function () {
            expect(normalizeResetType("INIT")).toBe(RESET_TYPES.ONBOARD);
            expect(normalizeResetType("AUTO_EMEAL")).toBe(
                RESET_TYPES.FIRST_HALF,
            );
            expect(normalizeResetType("MID_PERIOD")).toBe(
                RESET_TYPES.RESET_REQUEST,
            );
        });

        it("passes canonical values through unchanged", function () {
            for (const v of Object.values(RESET_TYPES)) {
                expect(normalizeResetType(v)).toBe(v);
            }
        });

        it("passes unknown values through unchanged", function () {
            expect(normalizeResetType("SOMETHING_ELSE")).toBe("SOMETHING_ELSE");
        });

        it("LEGACY_RESET_TYPE_MAP only targets canonical values", function () {
            const canonical = new Set(Object.values(RESET_TYPES));
            for (const target of Object.values(LEGACY_RESET_TYPE_MAP)) {
                expect(canonical.has(target)).toBe(true);
            }
        });
    });
});
