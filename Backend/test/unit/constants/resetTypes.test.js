"use strict";

/**
 * Unit tests for the wallet reset-type taxonomy (src/constants/resetTypes.js).
 * Pure — no DB, no HTTP.
 */

const { expect } = require("chai");
const {
    RESET_TYPES,
    LEGACY_RESET_TYPE_MAP,
    normalizeResetType,
} = require("../../../src/constants/resetTypes");

describe("resetTypes", function () {
    describe("RESET_TYPES", function () {
        it("exposes the four canonical values", function () {
            expect(RESET_TYPES).to.deep.equal({
                ONBOARD: "ONBOARD",
                FIRST_HALF: "FIRST_HALF",
                SECOND_HALF: "SECOND_HALF",
                RESET_REQUEST: "RESET_REQUEST",
            });
        });

        it("is frozen (immutable)", function () {
            expect(Object.isFrozen(RESET_TYPES)).to.be.true;
        });
    });

    describe("normalizeResetType", function () {
        it("maps each legacy value to its canonical name", function () {
            expect(normalizeResetType("INIT")).to.equal(RESET_TYPES.ONBOARD);
            expect(normalizeResetType("AUTO_EMEAL")).to.equal(RESET_TYPES.FIRST_HALF);
            expect(normalizeResetType("MID_PERIOD")).to.equal(RESET_TYPES.RESET_REQUEST);
        });

        it("passes canonical values through unchanged", function () {
            for (const v of Object.values(RESET_TYPES)) {
                expect(normalizeResetType(v)).to.equal(v);
            }
        });

        it("passes unknown values through unchanged", function () {
            expect(normalizeResetType("SOMETHING_ELSE")).to.equal("SOMETHING_ELSE");
        });

        it("LEGACY_RESET_TYPE_MAP only targets canonical values", function () {
            const canonical = new Set(Object.values(RESET_TYPES));
            for (const target of Object.values(LEGACY_RESET_TYPE_MAP)) {
                expect(canonical.has(target)).to.be.true;
            }
        });
    });
});
