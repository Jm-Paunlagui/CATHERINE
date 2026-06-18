#!/usr/bin/env node
"use strict";

/**
 * seed-template.js — Seeds demo accounts into T_USERS_DEV and T_ADMINS_DEV.
 *
 * Creates:
 *   admin   / Demo@123  → SUPER_ADMIN (T_ADMINS_DEV)
 *   manager / Demo@123  → ADMIN       (T_ADMINS_DEV)
 *   user    / Demo@123  → USER        (T_USERS_DEV)
 *
 * Passwords are hashed with Argon2id (CryptoVault) and admin rows are
 * HMAC-signed (SYSSIGNATURE), so this MUST run through the app — raw SQL
 * cannot produce valid hashes or signatures.
 *
 * Usage:
 *   cd Backend
 *   npm run db:seed:template
 *
 * Safe to re-run: skips accounts that already exist.
 */

const dotenv = require("dotenv");
dotenv.config({ path: ".env" });

const { CryptoVault } = require("../src/utils/encryption/CryptoVault");
const {
    createDb,
    OracleCollection,
} = require("../src/utils/oracle-mongo-wrapper");

const DEMO_PASSWORD = "Demo@123";

const ADMINS = [
    { username: "admin", role: "SUPER_ADMIN" },
    { username: "manager", role: "ADMIN" },
];

const USERS = [
    {
        username: "user",
        firstName: "Demo",
        lastName: "User",
        email: "user@demo.local",
    },
];

async function seed() {
    const db = createDb("appDb");

    const adminsCol = new OracleCollection("T_ADMINS_DEV", db);
    const usersCol = new OracleCollection("T_USERS_DEV", db);

    console.log("\n🔑  Hashing demo password with Argon2id…");
    const pwHash = await CryptoVault.hashPassword(DEMO_PASSWORD);

    const force = process.argv.includes("--force");
    if (force)
        console.log(
            "   ⚡  --force mode: existing accounts will be re-hashed and re-signed.\n",
        );

    // ── Seed admins ───────────────────────────────────────────────────────────
    for (const a of ADMINS) {
        const existing = await adminsCol.find({ USERNAME: a.username }).next();
        if (existing && !force) {
            console.log(
                `   ⏭  T_ADMINS_DEV: "${a.username}" already exists — skipped. (use --force to re-sign)`,
            );
            continue;
        }

        const sig = await CryptoVault.signRecord("T_ADMINS_DEV", {
            USERNAME: a.username,
            PASSWORD: pwHash,
            ROLE: a.role,
            IS_ACTIVE: "Y",
        });

        if (existing && force) {
            // Re-hash password and re-sign the row
            await adminsCol.updateOne(
                { USERNAME: a.username },
                {
                    $set: {
                        PASSWORD: pwHash,
                        ROLE: a.role,
                        IS_ACTIVE: "Y",
                        SYSSIGNATURE: sig,
                        UPDATED_AT: new Date(),
                    },
                },
            );
            console.log(
                `   🔄  T_ADMINS_DEV: "${a.username}" re-hashed & re-signed (${a.role}).`,
            );
        } else {
            await adminsCol.insertOne({
                USERNAME: a.username,
                PASSWORD: pwHash,
                ROLE: a.role,
                IS_ACTIVE: "Y",
                SYSSIGNATURE: sig,
            });
            console.log(
                `   ✅  T_ADMINS_DEV: "${a.username}" created (${a.role}).`,
            );
        }
    }

    // ── Seed users ────────────────────────────────────────────────────────────
    for (const u of USERS) {
        const existing = await usersCol.find({ USERNAME: u.username }).next();
        if (existing) {
            console.log(
                `   ⏭  T_USERS_DEV:  "${u.username}" already exists — skipped.`,
            );
            continue;
        }

        await usersCol.insertOne({
            USERNAME: u.username,
            PASSWORD: pwHash,
            FIRST_NAME: u.firstName ?? null,
            LAST_NAME: u.lastName ?? null,
            EMAIL: u.email ?? null,
            IS_ACTIVE: "Y",
        });
        console.log(`   ✅  T_USERS_DEV:  "${u.username}" created.`);
    }

    console.log(
        "\n🎉  Seed complete. Demo credentials: admin / manager / user — password: Demo@123\n",
    );

    // Graceful shutdown — close the Oracle pool
    try {
        const oracledb = require("oracledb");
        await oracledb.getPool("appDb").close(0);
    } catch (_) {
        // Pool may not exist yet if this is the first run
    }
    process.exit(0);
}

seed().catch((err) => {
    console.error("\n❌  Seed failed:", err.message);
    process.exit(1);
});
