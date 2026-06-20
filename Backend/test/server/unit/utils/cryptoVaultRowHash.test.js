"use strict";

// Salvaged from the removed tamperDetection.test.js. The TamperDetectionService
// (financial-table ROW_HASH verification) was removed with the consumption /
// wallet feature set; only the feature-agnostic CryptoVault.verifyRowHash
// primitive remains and is exercised here.

const crypto = require("crypto");
const { CryptoVault } = require("../../../../src/utils/encryption/CryptoVault");
// `expect`/`describe`/`it` are injected globally by Vitest (globals: true).

// 64-char hex string that will never match a legitimate SHA-256 digest.
const BAD_HASH = "a".repeat(64);

// ─────────────────────────────────────────────────────────────────────────────
// CryptoVault.verifyRowHash — plain-SHA-256 primitive.
// Used when verifying Oracle STANDARD_HASH(...,'SHA256') columns.
// ─────────────────────────────────────────────────────────────────────────────

function sha256hex(input) {
    return crypto.createHash("sha256").update(input, "utf8").digest("hex").toUpperCase();
}

describe("CryptoVault.verifyRowHash", function () {
    const canonical = "hello|world|123";
    const correctHash = sha256hex(canonical);

    it("returns true when canonical matches storedHash (uppercase)", function () {
        expect(CryptoVault.verifyRowHash(canonical, correctHash)).toBe(true);
    });

    it("returns true when storedHash is lowercase (case-insensitive)", function () {
        expect(CryptoVault.verifyRowHash(canonical, correctHash.toLowerCase())).toBe(true);
    });

    it("returns false when hash does not match", function () {
        expect(CryptoVault.verifyRowHash(canonical, BAD_HASH)).toBe(false);
    });

    it("returns false when canonical is null", function () {
        expect(CryptoVault.verifyRowHash(null, correctHash)).toBe(false);
    });

    it("returns false when storedHash is null", function () {
        expect(CryptoVault.verifyRowHash(canonical, null)).toBe(false);
    });

    it("returns false when storedHash is wrong length", function () {
        expect(CryptoVault.verifyRowHash(canonical, "ABCDEF")).toBe(false);
    });

    it("returns false when canonical is empty string", function () {
        expect(CryptoVault.verifyRowHash("", correctHash)).toBe(false);
    });
});
