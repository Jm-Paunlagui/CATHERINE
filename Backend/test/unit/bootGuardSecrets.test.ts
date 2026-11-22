"use strict";

/**
 * bootGuardSecrets.test.js — shape rule for CHANGELOG_ENCRYPTION_KEY.
 *
 * changelog.model.js#resolveKey only uses CHANGELOG_ENCRYPTION_KEY when it is
 * exactly 64 hex characters; anything else silently falls back to a key
 * derived from DATA_SIGNING_SECRET. The boot guard must therefore refuse any
 * value that is not 64 hex characters, so a misconfigured key is caught at
 * boot instead of being ignored.
 *
 * Pure — validateSecretRules only reads process.env and pushes strings.
 */

const { validateSecretRules } = require("../../src/config/bootGuard");

const KEY = "CHANGELOG_ENCRYPTION_KEY";
let snapshot;

beforeEach(function () {
    snapshot = process.env[KEY];
});
afterEach(function () {
    if (snapshot === undefined) delete process.env[KEY];
    else process.env[KEY] = snapshot;
});

function changelogViolations() {
    const violations = [];
    validateSecretRules(violations);
    return violations.filter((v) => v.includes(KEY));
}

describe("validateSecretRules — CHANGELOG_ENCRYPTION_KEY shape", function () {
    it("accepts exactly 64 hex characters", function () {
        process.env[KEY] = "a1B2".repeat(16);
        expect(changelogViolations()).toEqual([]);
    });

    it("refuses a 40-character value as too short", function () {
        process.env[KEY] = "a".repeat(40);
        const v = changelogViolations();
        expect(v).toHaveLength(1);
        expect(v[0]).toMatch(/too short/);
    });

    it("refuses 64 non-hex characters", function () {
        process.env[KEY] = "z".repeat(64);
        const v = changelogViolations();
        expect(v).toHaveLength(1);
        expect(v[0]).toMatch(/64 hex characters/);
    });

    it("refuses a 65-character hex value the model would ignore", function () {
        process.env[KEY] = "a".repeat(65);
        const v = changelogViolations();
        expect(v).toHaveLength(1);
        expect(v[0]).toMatch(/64 hex characters/);
    });

    it("refuses an unset key", function () {
        delete process.env[KEY];
        const v = changelogViolations();
        expect(v).toHaveLength(1);
        expect(v[0]).toMatch(/not set or empty/);
    });
});
