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
    EMAIL: 1,
    ROLE: 1,
    IS_ACTIVE: 1,
    CAN_RECEIVE_SRV_CRIT: 1,
    CAN_RECEIVE_SRV_DEPS: 1,
    CAN_RECEIVE_SRV_RED: 1,
    CAN_RECEIVE_SRV_SYS: 1,
    SYSSIGNATURE: 1,
    CREATED_AT: 1,
    UPDATED_AT: 1,
};

/**
 * Server-notification channel key → the `CAN_RECEIVE_SRV_*` column that gates
 * it. Doubles as the allow-list for {@link AdminModel.findServerNotifyRecipients}
 * — a channel absent from this map resolves to zero recipients rather than
 * falling back to "everyone", so a typo can never fan an alert out to all admins.
 *
 * Keys MUST match the template names under `utils/email-templates/server-notification/`.
 */
const SERVER_NOTIFY_FLAG_COLUMNS = Object.freeze({
    "server-critical-notification": "CAN_RECEIVE_SRV_CRIT",
    "server-dependencies-notification": "CAN_RECEIVE_SRV_DEPS",
    "server-red-metrics-notification": "CAN_RECEIVE_SRV_RED",
    "server-system-notification": "CAN_RECEIVE_SRV_SYS",
});

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

    // ─── Server-notification recipients ───────────────────────────────────────

    /**
     * Returns the email addresses of every ACTIVE admin opted in to `channel`
     * (`IS_ACTIVE='Y'` AND the channel's `CAN_RECEIVE_SRV_*` flag = 'Y').
     *
     * This is the DB half of `recipients(channel) = env floor ∪ DB opt-ins`
     * (see RecipientResolver). Admins with a NULL/blank EMAIL are dropped —
     * an opted-in account with nowhere to deliver is not a recipient.
     *
     * Unlike the source system this was ported from, the template resolves
     * addresses HERE rather than returning ids for a second HR-directory
     * lookup: T_ADMINS_DEV owns EMAIL, so there is no second directory.
     *
     * @param {string} channel - A key of {@link SERVER_NOTIFY_FLAG_COLUMNS}
     * @returns {Promise<string[]>} De-duplicated emails ([] for an unknown channel)
     */
    static async findServerNotifyRecipients(channel) {
        const flagColumn = SERVER_NOTIFY_FLAG_COLUMNS[channel];
        if (!flagColumn) return [];

        let rows;
        if (isDemoMode()) {
            const { admins } = await demo.accounts();
            rows = admins.filter(
                (a) => a.IS_ACTIVE === "Y" && a[flagColumn] === "Y",
            );
        } else {
            rows = await col()
                .find({ IS_ACTIVE: "Y", [flagColumn]: "Y" })
                .project({ EMAIL: 1 })
                .toArray();
        }

        return [
            ...new Set(
                rows
                    .map((r) => String(r.EMAIL ?? "").trim())
                    .filter((email) => email.length > 0),
            ),
        ];
    }

    /**
     * Resolves ID → USERNAME for a batch of admin ids in a single `$in` query.
     *
     * Best-effort by contract: a lookup failure resolves an EMPTY Map rather
     * than throwing, so callers degrade to a null display name instead of
     * failing the request. Used to render "acknowledged by …" on alerts
     * without an N+1 fan-out.
     *
     * @param {Array<string|number>} ids
     * @returns {Promise<Map<number, string>>} ID → USERNAME
     */
    static async getNamesByIds(ids) {
        const numericIds = [...new Set((ids ?? []).map(Number))].filter(
            Number.isFinite,
        );
        if (numericIds.length === 0) return new Map();

        try {
            let rows;
            if (isDemoMode()) {
                const { admins } = await demo.accounts();
                rows = admins.filter((a) => numericIds.includes(Number(a.ID)));
            } else {
                rows = await col()
                    .find({ ID: { $in: numericIds } })
                    .project({ ID: 1, USERNAME: 1 })
                    .toArray();
            }
            return new Map(
                (rows ?? []).map((r) => [Number(r.ID), r.USERNAME ?? null]),
            );
        } catch {
            return new Map();
        }
    }

    // ─── Writes ───────────────────────────────────────────────────────────────

    /**
     * Inserts a new admin. Caller hashes PASSWORD and computes sysSignature.
     *
     * All four `CAN_RECEIVE_SRV_*` flags default to 'N' — server notifications
     * are opt-in only, and a newly created admin is never silently subscribed.
     *
     * @param {{username:string, password:string, role:string, sysSignature:string, isActive?:string, email?:string}} data
     * @returns {Promise<void>}
     */
    static async insertAdmin(data) {
        if (isDemoMode()) {
            const { admins } = await demo.accounts();
            admins.push({
                ID: admins.length + 1,
                USERNAME: data.username,
                PASSWORD: data.password,
                EMAIL: data.email ?? null,
                ROLE: data.role,
                IS_ACTIVE: data.isActive ?? "Y",
                CAN_RECEIVE_SRV_CRIT: "N",
                CAN_RECEIVE_SRV_DEPS: "N",
                CAN_RECEIVE_SRV_RED: "N",
                CAN_RECEIVE_SRV_SYS: "N",
                SYSSIGNATURE: data.sysSignature,
                CREATED_AT: new Date(),
                UPDATED_AT: new Date(),
            });
            return;
        }
        await col().insertOne({
            USERNAME: data.username,
            PASSWORD: data.password,
            EMAIL: data.email ?? null,
            ROLE: data.role,
            IS_ACTIVE: data.isActive ?? "Y",
            CAN_RECEIVE_SRV_CRIT: "N",
            CAN_RECEIVE_SRV_DEPS: "N",
            CAN_RECEIVE_SRV_RED: "N",
            CAN_RECEIVE_SRV_SYS: "N",
            SYSSIGNATURE: data.sysSignature,
        });
    }

    /**
     * Updates one or more `CAN_RECEIVE_SRV_*` opt-in flags for an admin.
     *
     * Keys are channel names (of {@link SERVER_NOTIFY_FLAG_COLUMNS}), NOT raw
     * column names — the mapping is the allow-list, so an unrecognised key is
     * dropped instead of reaching the update. SYSSIGNATURE is deliberately not
     * recomputed: these flags are outside the signed field set (see the note in
     * `sql/01_schema.sql`).
     *
     * Callers must invalidate `RecipientResolver` after a successful write so
     * the change takes effect on the next notification instead of after the TTL.
     *
     * @param {string} username
     * @param {Record<string, 'Y'|'N'>} channelFlags - e.g. { "server-system-notification": "Y" }
     * @returns {Promise<void>}
     */
    static async setNotifyFlags(username, channelFlags) {
        const fields = {};
        for (const [channel, value] of Object.entries(channelFlags ?? {})) {
            const column = SERVER_NOTIFY_FLAG_COLUMNS[channel];
            if (column) fields[column] = value === "Y" ? "Y" : "N";
        }
        if (Object.keys(fields).length === 0) return;
        return AdminModel._set(username, fields);
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
AdminModel.SERVER_NOTIFY_FLAG_COLUMNS = SERVER_NOTIFY_FLAG_COLUMNS;

module.exports = AdminModel;
