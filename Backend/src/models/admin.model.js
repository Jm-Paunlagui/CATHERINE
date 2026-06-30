"use strict";

/**
 * @fileoverview AdminModel — standalone privileged accounts (T_ADMINS_DEV) with RBAC.
 *
 * Standalone privileged accounts with RBAC and tamper-evident signatures.
 * RBAC role ∈ { SUPER_ADMIN, ADMIN, USER }. Each row carries a tamper-evident
 * SYSSIGNATURE (HMAC-SHA256 over the signed fields). The caller (auth.service /
 * AdminManagementService) computes the signature via CryptoVault.signRecord and
 * passes it in — the model only persists.
 *
 * In DEMO_MODE every method reads/writes the in-memory demo store; no Oracle
 * connection is opened.
 */

const { createDb, OracleCollection } = require("../utils/oracle-mongo-wrapper");
const { isDemoMode } = require("../config/demoMode");
const demo = require("./demo/demoStore");

/** Signature context — namespaces the HMAC so it can't be replayed cross-table. */
const SIGN_CONTEXT = "T_ADMINS_DEV";

/**
 * Canonical signed-field set for a T_ADMINS_DEV row. EVERY signRecord/verifyRecord
 * call must pass exactly these fields; changing the set is a breaking change that
 * requires re-signing all rows.
 * @param {object} row
 * @returns {object}
 */
function buildSignedFields(row) {
    return {
        USERNAME: row.USERNAME,
        PASSWORD: row.PASSWORD,
        ROLE: row.ROLE,
        IS_ACTIVE: row.IS_ACTIVE ?? "Y",
    };
}

const PROJECTION = {
    ID: 1,
    USERNAME: 1,
    PASSWORD: 1,
    ROLE: 1,
    IS_ACTIVE: 1,
    SYSSIGNATURE: 1,
    CREATED_AT: 1,
    UPDATED_AT: 1,
};

let _col = null;
/** Lazily resolves the T_ADMINS_DEV collection (never called in DEMO_MODE). */
function col() {
    if (!_col) _col = new OracleCollection("T_ADMINS_DEV", createDb("appDb"));
    return _col;
}

class AdminModel {
    // ─── Reads ────────────────────────────────────────────────────────────────

    /**
     * Finds an admin by USERNAME, including PASSWORD + SYSSIGNATURE. Null if absent.
     * @param {string} username
     * @returns {Promise<object|null>}
     */
    static async findByUsername(username) {
        if (isDemoMode()) {
            const { admins } = await demo.accounts();
            return admins.find((a) => a.USERNAME === username) ?? null;
        }
        return col().find({ USERNAME: username }).project(PROJECTION).next();
    }

    /**
     * Returns all admins ordered by USERNAME.
     * Includes PASSWORD + SYSSIGNATURE so callers can verify integrity.
     * @returns {Promise<Array<object>>}
     */
    static async findAll() {
        if (isDemoMode()) {
            const { admins } = await demo.accounts();
            return [...admins].sort((a, b) =>
                a.USERNAME.localeCompare(b.USERNAME),
            );
        }
        return col()
            .find({})
            .project(PROJECTION)
            .sort({ USERNAME: 1 })
            .toArray();
    }

    /**
     * Returns true when an admin with the given USERNAME exists.
     * @param {string} username
     * @returns {Promise<boolean>}
     */
    static async existsByUsername(username) {
        if (isDemoMode()) {
            const { admins } = await demo.accounts();
            return admins.some((a) => a.USERNAME === username);
        }
        return (await col().find({ USERNAME: username }).count()) > 0;
    }

    /**
     * Counts ACTIVE admins with the given role, excluding one username.
     * Used by the last-super-admin guard before role/active changes or deletes.
     * @param {string} role
     * @param {string} excludeUsername
     * @returns {Promise<number>}
     */
    static async countActiveByRole(role, excludeUsername) {
        if (isDemoMode()) {
            const { admins } = await demo.accounts();
            return admins.filter(
                (a) =>
                    a.ROLE === role &&
                    a.IS_ACTIVE === "Y" &&
                    a.USERNAME !== excludeUsername,
            ).length;
        }
        return col()
            .find({
                ROLE: role,
                IS_ACTIVE: "Y",
                USERNAME: { $ne: excludeUsername },
            })
            .count();
    }

    // ─── Writes ───────────────────────────────────────────────────────────────

    /**
     * Inserts a new admin. Caller hashes PASSWORD and computes sysSignature.
     * @param {{username:string, password:string, role:string, sysSignature:string, isActive?:string}} data
     * @returns {Promise<void>}
     */
    static async insertAdmin(data) {
        if (isDemoMode()) {
            const { admins } = await demo.accounts();
            admins.push({
                ID: admins.length + 1,
                USERNAME: data.username,
                PASSWORD: data.password,
                ROLE: data.role,
                IS_ACTIVE: data.isActive ?? "Y",
                SYSSIGNATURE: data.sysSignature,
                CREATED_AT: new Date(),
                UPDATED_AT: new Date(),
            });
            return;
        }
        await col().insertOne({
            USERNAME: data.username,
            PASSWORD: data.password,
            ROLE: data.role,
            IS_ACTIVE: data.isActive ?? "Y",
            SYSSIGNATURE: data.sysSignature,
        });
    }

    /**
     * Updates PASSWORD + SYSSIGNATURE (password change / reset). Caller re-signs.
     * @param {string} username
     * @param {string} passwordHash
     * @param {string} sysSignature
     * @returns {Promise<void>}
     */
    static async updateCredentials(username, passwordHash, sysSignature) {
        return AdminModel._set(username, {
            PASSWORD: passwordHash,
            SYSSIGNATURE: sysSignature,
        });
    }

    /**
     * Updates ROLE + SYSSIGNATURE. Caller re-signs with the new role.
     * @param {string} username
     * @param {string} role
     * @param {string} sysSignature
     * @returns {Promise<void>}
     */
    static async updateRole(username, role, sysSignature) {
        return AdminModel._set(username, {
            ROLE: role,
            SYSSIGNATURE: sysSignature,
        });
    }

    /**
     * Updates IS_ACTIVE + SYSSIGNATURE. Caller re-signs with the new flag.
     * @param {string} username
     * @param {string} isActive  - 'Y' | 'N'
     * @param {string} sysSignature
     * @returns {Promise<void>}
     */
    static async setActive(username, isActive, sysSignature) {
        return AdminModel._set(username, {
            IS_ACTIVE: isActive,
            SYSSIGNATURE: sysSignature,
        });
    }

    /**
     * Deletes an admin by USERNAME.
     * @param {string} username
     * @returns {Promise<void>}
     */
    static async deleteAdmin(username) {
        if (isDemoMode()) {
            const { admins } = await demo.accounts();
            const idx = admins.findIndex((a) => a.USERNAME === username);
            if (idx !== -1) admins.splice(idx, 1);
            return;
        }
        await col().deleteOne({ USERNAME: username });
    }

    /**
     * Internal $set helper shared by the update methods. Always stamps UPDATED_AT.
     * @private
     */
    static async _set(username, fields) {
        if (isDemoMode()) {
            const { admins } = await demo.accounts();
            const row = admins.find((a) => a.USERNAME === username);
            if (row) Object.assign(row, fields, { UPDATED_AT: new Date() });
            return;
        }
        await col().updateOne(
            { USERNAME: username },
            { $set: { ...fields, UPDATED_AT: new Date() } },
        );
    }
}

AdminModel.SIGN_CONTEXT = SIGN_CONTEXT;
AdminModel.buildSignedFields = buildSignedFields;

module.exports = AdminModel;
