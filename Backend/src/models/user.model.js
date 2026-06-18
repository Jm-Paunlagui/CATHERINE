"use strict";

/**
 * @fileoverview UserModel — standalone regular-user accounts (T_USERS_DEV).
 *
 * Generic, project-agnostic replacement for the HRIS U_USERS coupling. The login
 * identifier is USERNAME; PASSWORD holds an Argon2id hash. A T_USERS_DEV account with
 * no matching T_ADMINS_DEV row authenticates at USER level.
 *
 * In DEMO_MODE every method reads from the in-memory demo store — no Oracle
 * connection is opened (the OracleCollection is lazily created only when needed).
 */

const { createDb, OracleCollection } = require("../utils/oracle-mongo-wrapper");
const { isDemoMode } = require("../config/demoMode");
const demo = require("./demo/demoStore");

const PROJECTION = {
    ID: 1,
    USERNAME: 1,
    PASSWORD: 1,
    FIRST_NAME: 1,
    LAST_NAME: 1,
    EMAIL: 1,
    IS_ACTIVE: 1,
    CREATED_AT: 1,
    UPDATED_AT: 1,
};

let _col = null;
/** Lazily resolves the T_USERS_DEV collection (never called in DEMO_MODE). */
function col() {
    if (!_col) _col = new OracleCollection("T_USERS_DEV", createDb("appDb"));
    return _col;
}

class UserModel {
    /**
     * Finds a user by USERNAME (case-sensitive). Returns null when absent.
     * @param {string} username
     * @returns {Promise<object|null>}
     */
    static async findByUsername(username) {
        if (isDemoMode()) {
            const { users } = await demo.accounts();
            return users.find((u) => u.USERNAME === username) ?? null;
        }
        return col().find({ USERNAME: username }).project(PROJECTION).next();
    }

    /**
     * Returns all users ordered by USERNAME (PASSWORD excluded).
     * @returns {Promise<object[]>}
     */
    static async findAll() {
        if (isDemoMode()) {
            const { users } = await demo.accounts();
            return users
                .map(({ PASSWORD, ...rest }) => rest)
                .sort((a, b) => a.USERNAME.localeCompare(b.USERNAME));
        }
        return col()
            .find({})
            .project({
                ID: 1,
                USERNAME: 1,
                FIRST_NAME: 1,
                LAST_NAME: 1,
                EMAIL: 1,
                IS_ACTIVE: 1,
                CREATED_AT: 1,
                UPDATED_AT: 1,
            })
            .sort({ USERNAME: 1 })
            .toArray();
    }

    /**
     * Returns true when a user with the given USERNAME exists.
     * @param {string} username
     * @returns {Promise<boolean>}
     */
    static async existsByUsername(username) {
        if (isDemoMode()) {
            const { users } = await demo.accounts();
            return users.some((u) => u.USERNAME === username);
        }
        return (await col().find({ USERNAME: username }).count()) > 0;
    }

    /**
     * Inserts a new user. Caller hashes PASSWORD via CryptoVault.hashPassword().
     * @param {{username:string, password:string, firstName?:string, lastName?:string, email?:string, isActive?:string}} data
     * @returns {Promise<void>}
     */
    static async insertUser(data) {
        if (isDemoMode()) {
            const { users } = await demo.accounts();
            users.push({
                ID: users.length + 1,
                USERNAME: data.username,
                PASSWORD: data.password,
                FIRST_NAME: data.firstName ?? null,
                LAST_NAME: data.lastName ?? null,
                EMAIL: data.email ?? null,
                IS_ACTIVE: data.isActive ?? "Y",
                CREATED_AT: new Date(),
                UPDATED_AT: new Date(),
            });
            return;
        }
        await col().insertOne({
            USERNAME: data.username,
            PASSWORD: data.password,
            FIRST_NAME: data.firstName ?? null,
            LAST_NAME: data.lastName ?? null,
            EMAIL: data.email ?? null,
            IS_ACTIVE: data.isActive ?? "Y",
        });
    }

    /**
     * Updates a user's PASSWORD hash. Caller hashes via CryptoVault.hashPassword().
     * @param {string} username
     * @param {string} passwordHash
     * @returns {Promise<void>}
     */
    static async updatePassword(username, passwordHash) {
        if (isDemoMode()) {
            const { users } = await demo.accounts();
            const row = users.find((u) => u.USERNAME === username);
            if (row)
                Object.assign(row, {
                    PASSWORD: passwordHash,
                    UPDATED_AT: new Date(),
                });
            return;
        }
        await col().updateOne(
            { USERNAME: username },
            { $set: { PASSWORD: passwordHash, UPDATED_AT: new Date() } },
        );
    }

    /**
     * Deletes a user by USERNAME.
     * @param {string} username
     * @returns {Promise<void>}
     */
    static async deleteUser(username) {
        if (isDemoMode()) {
            const { users } = await demo.accounts();
            const idx = users.findIndex((u) => u.USERNAME === username);
            if (idx !== -1) users.splice(idx, 1);
            return;
        }
        await col().deleteOne({ USERNAME: username });
    }
}

module.exports = UserModel;
