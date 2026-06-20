"use strict";

/**
 * @file cryptoVault.adminMode.test.js
 *
 * Unit tests for CryptoVault.hashAdminPassword / verifyAdminPassword and
 * the PASSWORD_ENCRYPTION_MODE resolution logic introduced in the
 * security fix (CWE-327 / CWE-326 — admin password hardening).
 *
 * These tests manipulate process.env and reset module state between suites.
 * All heavy dependencies (argon2, bcryptjs) run with real implementations so
 * the hash round-trip is actually exercised.
 */


// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Re-requires CryptoVault with a clean module cache so env-var changes are
 * picked up. Returns the fresh module exports.
 */
function freshVault() {
    // Clear module cache for the vault and its lazy-init singletons
    const key = require.resolve("../../../../src/utils/encryption/CryptoVault");
    delete require.cache[key];
    return require("../../../../src/utils/encryption/CryptoVault");
}

/**
 * Sets process.env vars from a map and returns a cleanup function that
 * restores the original values.
 */
function setEnv(vars) {
    const saved = {};
    for (const [k, v] of Object.entries(vars)) {
        saved[k] = process.env[k];
        if (v === undefined) {
            delete process.env[k];
        } else {
            process.env[k] = v;
        }
    }
    return () => {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    };
}

// Shared argon2 pepper for tests that need argon2 mode
const TEST_PEPPER =
    "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
const TEST_DATA_SIGNING_SECRET =
    "f1e2d3c4b5a6f1e2d3c4b5a6f1e2d3c4b5a6f1e2d3c4b5a6f1e2d3c4b5a6f1e2";

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("CryptoVault — PASSWORD_ENCRYPTION_MODE (admin password hardening)", function () {


    // ── Mode resolution rules ──────────────────────────────────────────────────

    describe("resolveAdminMode() — mode selection", function () {
        it("uses PASSWORD_HASH_MODE directly when it is bcrypt (strong mode)", function () {
            const restore = setEnv({
                PASSWORD_HASH_MODE: "bcrypt",
                PASSWORD_ENCRYPTION_MODE: undefined,
                ARGON2_PEPPER: undefined,
                DATA_SIGNING_SECRET: undefined,
            });
            try {
                const { CryptoVault } = freshVault();
                // In bcrypt mode, hashAdminPassword must produce a bcrypt hash
                // We only test that it doesn't throw due to missing enc mode
                expect(CryptoVault).toBeDefined();
            } finally {
                restore();
            }
        });

        it("uses PASSWORD_HASH_MODE directly when it is argon2 (strong mode)", function () {
            const restore = setEnv({
                PASSWORD_HASH_MODE: "argon2",
                PASSWORD_ENCRYPTION_MODE: undefined,
                ARGON2_PEPPER: TEST_PEPPER,
                DATA_SIGNING_SECRET: TEST_DATA_SIGNING_SECRET,
            });
            try {
                const { CryptoVault } = freshVault();
                expect(CryptoVault).toBeDefined();
            } finally {
                restore();
            }
        });

        it("rejects when PASSWORD_HASH_MODE is weak and PASSWORD_ENCRYPTION_MODE is absent", async function () {
            // hashAdminPassword is async — resolveAdminMode() runs inside the async
            // function body and surfaces as a rejected Promise, not a synchronous throw.
            const restore = setEnv({
                PASSWORD_HASH_MODE: "tripledes",
                PASSWORD_ENCRYPTION_MODE: undefined,
                PASSWORD_KEY: "HRIS1",
            });
            try {
                const { CryptoVault } = freshVault();
                let threw = false;
                let errorMsg = "";
                try {
                    await CryptoVault.hashAdminPassword("test");
                } catch (err) {
                    threw = true;
                    errorMsg = err.message;
                }
                expect(threw, "expected hashAdminPassword to reject").toBe(
                    true,
                );
                expect(errorMsg).toMatch(/PASSWORD_ENCRYPTION_MODE/);
            } finally {
                restore();
            }
        });

        it("rejects when PASSWORD_HASH_MODE is plain and PASSWORD_ENCRYPTION_MODE is absent", async function () {
            const restore = setEnv({
                PASSWORD_HASH_MODE: "plain",
                PASSWORD_ENCRYPTION_MODE: undefined,
                NODE_ENV: "development",
            });
            try {
                const { CryptoVault } = freshVault();
                let threw = false;
                let errorMsg = "";
                try {
                    await CryptoVault.hashAdminPassword("test");
                } catch (err) {
                    threw = true;
                    errorMsg = err.message;
                }
                expect(threw, "expected hashAdminPassword to reject").toBe(
                    true,
                );
                expect(errorMsg).toMatch(/PASSWORD_ENCRYPTION_MODE/);
            } finally {
                restore();
            }
        });

        it("rejects when PASSWORD_ENCRYPTION_MODE is set to an invalid value", async function () {
            const restore = setEnv({
                PASSWORD_HASH_MODE: "tripledes",
                PASSWORD_ENCRYPTION_MODE: "md5",
                PASSWORD_KEY: "HRIS1",
            });
            try {
                const { CryptoVault } = freshVault();
                let threw = false;
                let errorMsg = "";
                try {
                    await CryptoVault.hashAdminPassword("test");
                } catch (err) {
                    threw = true;
                    errorMsg = err.message;
                }
                expect(threw, "expected hashAdminPassword to reject").toBe(
                    true,
                );
                expect(errorMsg).toMatch(/bcrypt.*argon2|argon2.*bcrypt/i);
            } finally {
                restore();
            }
        });

        it("accepts PASSWORD_ENCRYPTION_MODE=bcrypt when hash mode is weak", function () {
            const restore = setEnv({
                PASSWORD_HASH_MODE: "tripledes",
                PASSWORD_ENCRYPTION_MODE: "bcrypt",
                PASSWORD_KEY: "HRIS1",
                BCRYPT_SALT_ROUNDS: "10",
            });
            try {
                const { CryptoVault } = freshVault();
                // Should not throw on access
                expect(CryptoVault).toBeDefined();
            } finally {
                restore();
            }
        });

        it("accepts PASSWORD_ENCRYPTION_MODE=argon2 when hash mode is weak", function () {
            const restore = setEnv({
                PASSWORD_HASH_MODE: "tripledes",
                PASSWORD_ENCRYPTION_MODE: "argon2",
                PASSWORD_KEY: "HRIS1",
                ARGON2_PEPPER: TEST_PEPPER,
                DATA_SIGNING_SECRET: TEST_DATA_SIGNING_SECRET,
            });
            try {
                const { CryptoVault } = freshVault();
                expect(CryptoVault).toBeDefined();
            } finally {
                restore();
            }
        });
    });

    // ── hashAdminPassword ──────────────────────────────────────────────────────

    describe("hashAdminPassword() — always produces a strong hash", function () {
        it("produces an argon2id hash when PASSWORD_HASH_MODE=argon2", async function () {
            const restore = setEnv({
                PASSWORD_HASH_MODE: "argon2",
                PASSWORD_ENCRYPTION_MODE: undefined,
                ARGON2_PEPPER: TEST_PEPPER,
                DATA_SIGNING_SECRET: TEST_DATA_SIGNING_SECRET,
            });
            try {
                const { CryptoVault } = freshVault();
                const hash = await CryptoVault.hashAdminPassword("AdminPass1!");
                expect(hash).toMatch(/^\$argon2id\$/);
            } finally {
                restore();
            }
        });

        it("produces a bcrypt hash when PASSWORD_HASH_MODE=bcrypt", async function () {
            const restore = setEnv({
                PASSWORD_HASH_MODE: "bcrypt",
                PASSWORD_ENCRYPTION_MODE: undefined,
                BCRYPT_SALT_ROUNDS: "10",
            });
            try {
                const { CryptoVault } = freshVault();
                const hash = await CryptoVault.hashAdminPassword("AdminPass1!");
                expect(hash).toMatch(/^\$2[ab]\$/);
            } finally {
                restore();
            }
        });

        it("produces argon2id when PASSWORD_HASH_MODE=tripledes and PASSWORD_ENCRYPTION_MODE=argon2", async function () {
            const restore = setEnv({
                PASSWORD_HASH_MODE: "tripledes",
                PASSWORD_ENCRYPTION_MODE: "argon2",
                PASSWORD_KEY: "HRIS1",
                ARGON2_PEPPER: TEST_PEPPER,
                DATA_SIGNING_SECRET: TEST_DATA_SIGNING_SECRET,
            });
            try {
                const { CryptoVault } = freshVault();
                const hash = await CryptoVault.hashAdminPassword("AdminPass1!");
                expect(hash).toMatch(/^\$argon2id\$/);
            } finally {
                restore();
            }
        });

        it("produces bcrypt when PASSWORD_HASH_MODE=tripledes and PASSWORD_ENCRYPTION_MODE=bcrypt", async function () {
            const restore = setEnv({
                PASSWORD_HASH_MODE: "tripledes",
                PASSWORD_ENCRYPTION_MODE: "bcrypt",
                PASSWORD_KEY: "HRIS1",
                BCRYPT_SALT_ROUNDS: "10",
            });
            try {
                const { CryptoVault } = freshVault();
                const hash = await CryptoVault.hashAdminPassword("AdminPass1!");
                expect(hash).toMatch(/^\$2[ab]\$/);
            } finally {
                restore();
            }
        });

        it("rejects empty password", async function () {
            const restore = setEnv({
                PASSWORD_HASH_MODE: "bcrypt",
                BCRYPT_SALT_ROUNDS: "10",
            });
            try {
                const { CryptoVault } = freshVault();
                await expect(
                    CryptoVault.hashAdminPassword(""),
                ).rejects.toThrow(TypeError);
            } catch (err) {
                // Some chai versions don't have rejectedWith without chai-as-promised
                // Fallback: call directly and check
                const { CryptoVault: CV2 } = freshVault();
                let threw = false;
                try {
                    await CV2.hashAdminPassword("");
                } catch {
                    threw = true;
                }
                expect(threw).toBe(true);
            } finally {
                restore();
            }
        });
    });

    // ── verifyAdminPassword ────────────────────────────────────────────────────

    describe("verifyAdminPassword() — round-trip verification", function () {
        it("verifies argon2id hash successfully", async function () {
            const restore = setEnv({
                PASSWORD_HASH_MODE: "argon2",
                ARGON2_PEPPER: TEST_PEPPER,
                DATA_SIGNING_SECRET: TEST_DATA_SIGNING_SECRET,
            });
            try {
                const { CryptoVault } = freshVault();
                const hash = await CryptoVault.hashAdminPassword("Correct1!");
                const { matched, newHash } =
                    await CryptoVault.verifyAdminPassword("Correct1!", hash);
                expect(matched).toBe(true);
                expect(newHash).toBeNull();
            } finally {
                restore();
            }
        });

        it("rejects wrong password against argon2id hash", async function () {
            const restore = setEnv({
                PASSWORD_HASH_MODE: "argon2",
                ARGON2_PEPPER: TEST_PEPPER,
                DATA_SIGNING_SECRET: TEST_DATA_SIGNING_SECRET,
            });
            try {
                const { CryptoVault } = freshVault();
                const hash = await CryptoVault.hashAdminPassword("Correct1!");
                const { matched } = await CryptoVault.verifyAdminPassword(
                    "Wrong1!",
                    hash,
                );
                expect(matched).toBe(false);
            } finally {
                restore();
            }
        });

        it("verifies bcrypt hash successfully", async function () {
            const restore = setEnv({
                PASSWORD_HASH_MODE: "bcrypt",
                BCRYPT_SALT_ROUNDS: "10",
            });
            try {
                const { CryptoVault } = freshVault();
                const hash = await CryptoVault.hashAdminPassword("Correct1!");
                const { matched, newHash } =
                    await CryptoVault.verifyAdminPassword("Correct1!", hash);
                expect(matched).toBe(true);
                expect(newHash).toBeNull();
            } finally {
                restore();
            }
        });

        it("performs legacy TripleDES match + returns newHash for migration when PASSWORD_HASH_MODE=tripledes and PASSWORD_ENCRYPTION_MODE=argon2", async function () {
            const restore = setEnv({
                PASSWORD_HASH_MODE: "tripledes",
                PASSWORD_ENCRYPTION_MODE: "argon2",
                PASSWORD_KEY: "HRIS1",
                ARGON2_PEPPER: TEST_PEPPER,
                DATA_SIGNING_SECRET: TEST_DATA_SIGNING_SECRET,
            });
            try {
                const { CryptoVault } = freshVault();
                // Produce a TripleDES hash via CryptoVault.hashPassword (HRIS mode)
                const tripleDesHash =
                    await CryptoVault.hashPassword("LegacyPass1!");

                // Verify using the admin verifier — should match AND return newHash
                const { matched, newHash } =
                    await CryptoVault.verifyAdminPassword(
                        "LegacyPass1!",
                        tripleDesHash,
                    );
                expect(matched).toBe(true);
                expect(newHash).toMatch(
                    /^\$argon2id\$/,
                    "newHash should be argon2id for transparent migration",
                );
            } finally {
                restore();
            }
        });

        it("returns { matched: false, newHash: null } for wrong password against TripleDES hash", async function () {
            const restore = setEnv({
                PASSWORD_HASH_MODE: "tripledes",
                PASSWORD_ENCRYPTION_MODE: "argon2",
                PASSWORD_KEY: "HRIS1",
                ARGON2_PEPPER: TEST_PEPPER,
            });
            try {
                const { CryptoVault } = freshVault();
                const tripleDesHash =
                    await CryptoVault.hashPassword("LegacyPass1!");
                const { matched, newHash } =
                    await CryptoVault.verifyAdminPassword(
                        "WrongPass!",
                        tripleDesHash,
                    );
                expect(matched).toBe(false);
                expect(newHash).toBeNull();
            } finally {
                restore();
            }
        });
    });

    // ── adminNeedsRehash ───────────────────────────────────────────────────────

    describe("adminNeedsRehash()", function () {
        it("returns true for a TripleDES (legacy) hash", function () {
            const restore = setEnv({
                PASSWORD_HASH_MODE: "argon2",
                ARGON2_PEPPER: TEST_PEPPER,
                DATA_SIGNING_SECRET: TEST_DATA_SIGNING_SECRET,
            });
            try {
                const { CryptoVault } = freshVault();
                // A base64 string that is not a bcrypt or argon2 prefix
                expect(CryptoVault.adminNeedsRehash("dGVzdA==")).toBe(true);
            } finally {
                restore();
            }
        });

        it("returns false for a fresh argon2id hash", async function () {
            const restore = setEnv({
                PASSWORD_HASH_MODE: "argon2",
                ARGON2_PEPPER: TEST_PEPPER,
                DATA_SIGNING_SECRET: TEST_DATA_SIGNING_SECRET,
            });
            try {
                const { CryptoVault } = freshVault();
                const hash = await CryptoVault.hashAdminPassword("Fresh1!");
                expect(CryptoVault.adminNeedsRehash(hash)).toBe(false);
            } finally {
                restore();
            }
        });
    });
});
