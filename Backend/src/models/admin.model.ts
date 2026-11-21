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

const {
    createDb,
    OracleCollection,
    Transaction,
} = require("../utils/oracle-mongo-wrapper");
const { isDemoMode } = require("../config/demoMode");
const { AppError, ADMIN_ERRORS } = require("../constants/errors");
const { HTTP_STATUS } = require("../constants");
const { adminMessages } = require("../constants/messages");
const { logger } = require("../utils/logger");
const demo = require("./demo/demoStore");

/** Physical table. */
const TABLE = "T_ADMINS_DEV";

/** search(): default / maximum rows returned, and the longest needle accepted. */
const SEARCH_DEFAULT_LIMIT = 20;
const SEARCH_MAX_LIMIT = 50;
const SEARCH_MAX_QUERY_LENGTH = 100;

/**
 * Case-insensitive substring search on USERNAME / EMAIL (admins carry no name
 * columns). The needle is bound (`:q`) and its LIKE wildcards are escaped by
 * the caller, so `%` and `_` typed by a user match literally. FETCH FIRST is
 * bound too (`:lim`). The same bind name may appear twice in Oracle SQL.
 */
const SEARCH_SQL = `SELECT ID, USERNAME, EMAIL, ROLE, IS_ACTIVE
   FROM ${TABLE}
  WHERE UPPER(USERNAME) LIKE :q ESCAPE '\\'
     OR UPPER(EMAIL)    LIKE :q ESCAPE '\\'
  ORDER BY USERNAME
  FETCH FIRST :lim ROWS ONLY`;

/**
 * Escapes the LIKE metacharacters `\`, `%` and `_` with a backslash so they
 * match literally under `ESCAPE '\'`.
 * @param {string} s
 * @returns {string}
 */
function escapeLike(s) {
    return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Clamps a requested search limit to 1..SEARCH_MAX_LIMIT (default when absent
 * or not a finite number).
 * @param {*} limit
 * @returns {number}
 */
function clampLimit(limit) {
    const n = Math.trunc(Number(limit));
    if (!Number.isFinite(n) || n < 1) return SEARCH_DEFAULT_LIMIT;
    return Math.min(n, SEARCH_MAX_LIMIT);
}

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

let _db = null;
let _col = null;
/** Lazily resolves the appDb interface (never called in DEMO_MODE). */
function db() {
    if (!_db) _db = createDb("appDb");
    return _db;
}
/** Lazily resolves the T_ADMINS_DEV collection (never called in DEMO_MODE). */
function col() {
    if (!_col) _col = new OracleCollection(TABLE, db());
    return _col;
}

/**
 * The collection a write should use: the transaction-bound one when a guard
 * session is passed (so the write joins the transaction holding the row locks
 * instead of blocking on them from a second connection), else the pool one.
 * @param {object|null|undefined} session - Transaction session or null
 * @returns {OracleCollection}
 */
function writeCol(session) {
    return session ? session.collection(TABLE) : col();
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
     * Finds an admin by numeric ID (the JWT `id` claim), including PASSWORD +
     * SYSSIGNATURE. Null when absent or when `id` is not a finite number.
     * @param {number|string} id
     * @returns {Promise<object|null>}
     */
    static async findById(id) {
        const numericId = Number(id);
        if (id === null || id === undefined || id === "" || !Number.isFinite(numericId)) {
            return null;
        }
        if (isDemoMode()) {
            const { admins } = await demo.accounts();
            return admins.find((a) => Number(a.ID) === numericId) ?? null;
        }
        return col().find({ ID: numericId }).project(PROJECTION).next();
    }

    /**
     * Batch lookup by USERNAME in one `$in` query (bound list). Returns the
     * contact projection only — no PASSWORD / SYSSIGNATURE. Absent names are
     * simply missing from the result. At most SEARCH_MAX_LIMIT names are used.
     * @param {string[]} usernames
     * @returns {Promise<Array<{ID:number, USERNAME:string, EMAIL:string|null, ROLE:string, IS_ACTIVE:string}>>}
     */
    static async findByUsernames(usernames) {
        const names = [
            ...new Set((usernames ?? []).filter((u) => typeof u === "string" && u)),
        ].slice(0, SEARCH_MAX_LIMIT);
        if (names.length === 0) return [];
        if (isDemoMode()) {
            const { admins } = await demo.accounts();
            return admins
                .filter((a) => names.includes(a.USERNAME))
                .map((a) => ({
                    ID: a.ID,
                    USERNAME: a.USERNAME,
                    EMAIL: a.EMAIL ?? null,
                    ROLE: a.ROLE,
                    IS_ACTIVE: a.IS_ACTIVE,
                }));
        }
        return col()
            .find({ USERNAME: { $in: names } })
            .project({ ID: 1, USERNAME: 1, EMAIL: 1, ROLE: 1, IS_ACTIVE: 1 })
            .toArray();
    }

    /**
     * Case-insensitive substring search on USERNAME and EMAIL (T_ADMINS_DEV has
     * no name columns; names live in T_USERS_DEV). `q` is trimmed and capped at
     * 100 characters; `%`, `_` and `\` match literally. `limit` is clamped to
     * 1..50 (default 20). PASSWORD and SYSSIGNATURE are NOT returned.
     *
     * @param {string} q
     * @param {number} [limit=20]
     * @returns {Promise<Array<{ID:number, USERNAME:string, EMAIL:string|null, ROLE:string, IS_ACTIVE:string}>>}
     */
    static async search(q, limit = SEARCH_DEFAULT_LIMIT) {
        const needle = String(q ?? "").trim().slice(0, SEARCH_MAX_QUERY_LENGTH);
        if (!needle) return [];
        const lim = clampLimit(limit);

        if (isDemoMode()) {
            const lower = needle.toLowerCase();
            const { admins } = await demo.accounts();
            return admins
                .filter((a) =>
                    [a.USERNAME, a.EMAIL].some((v) =>
                        String(v ?? "").toLowerCase().includes(lower),
                    ),
                )
                .sort((a, b) => a.USERNAME.localeCompare(b.USERNAME))
                .slice(0, lim)
                .map((a) => ({
                    ID: a.ID,
                    USERNAME: a.USERNAME,
                    EMAIL: a.EMAIL ?? null,
                    ROLE: a.ROLE,
                    IS_ACTIVE: a.IS_ACTIVE,
                }));
        }

        const d = db();
        const res = await d.withConnection((conn) =>
            conn.execute(
                SEARCH_SQL,
                { q: `%${escapeLike(needle.toUpperCase())}%`, lim },
                { outFormat: d.oracledb.OUT_FORMAT_OBJECT },
            ),
        );
        return res?.rows ?? [];
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
     * Counts ACTIVE admins with the given role, optionally excluding one
     * username. A null/undefined exclusion omits the predicate entirely — a
     * bound `USERNAME <> NULL` would match nothing and always return 0.
     * @param {string} role
     * @param {string|null} [excludeUsername]
     * @returns {Promise<number>}
     */
    static async countActiveByRole(role, excludeUsername = null) {
        const hasExclusion = excludeUsername !== null && excludeUsername !== undefined;
        if (isDemoMode()) {
            const { admins } = await demo.accounts();
            return admins.filter(
                (a) =>
                    a.ROLE === role &&
                    a.IS_ACTIVE === "Y" &&
                    (!hasExclusion || a.USERNAME !== excludeUsername),
            ).length;
        }
        const filter = { ROLE: role, IS_ACTIVE: "Y" };
        if (hasExclusion) filter.USERNAME = { $ne: excludeUsername };
        return col().find(filter).count();
    }

    // ─── Last-SUPER_ADMIN guard ───────────────────────────────────────────────

    /**
     * Runs `fn` inside ONE transaction that first locks every ACTIVE
     * SUPER_ADMIN row (`SELECT ... FOR UPDATE`), refusing with 409 when
     * removing `excludeId` would leave zero. Two concurrent demotions of the
     * last two SUPER_ADMINs serialise on the locks, so the second one sees the
     * first one's committed change and is refused (no check-then-act race).
     *
     * `fn(session)` runs in the SAME transaction: writes to T_ADMINS_DEV inside
     * it MUST pass `session` to the model write method, otherwise they would
     * block on the very locks this transaction holds. Commit on return,
     * rollback on throw. A target that is not itself an active SUPER_ADMIN
     * cannot reduce the count and is never refused.
     *
     * In DEMO_MODE the same check runs against the in-memory store and `fn`
     * receives `null`.
     *
     * @template T
     * @param {number|string} excludeId - T_ADMINS_DEV.ID being demoted/deactivated/revoked/deleted
     * @param {(session: object|null) => Promise<T>} fn
     * @returns {Promise<T>}
     * @throws {AppError} 409 LAST_ACTIVE_SUPER_ADMIN
     */
    static async withLastSuperAdminGuard(excludeId, fn) {
        const targetId = Number(excludeId);

        const assertNotLast = (rows) => {
            const ids = rows.map((r) => Number(r.ID));
            if (ids.includes(targetId) && ids.every((id) => id === targetId)) {
                logger.warning(adminMessages.ADMIN_LAST_SUPER_ADMIN_BLOCKED(excludeId));
                throw new AppError(ADMIN_ERRORS.LAST_ACTIVE_SUPER_ADMIN, HTTP_STATUS.CONFLICT, {
                    type: "BusinessRuleError",
                });
            }
        };

        if (isDemoMode()) {
            const { admins } = await demo.accounts();
            assertNotLast(
                admins.filter((a) => a.ROLE === "SUPER_ADMIN" && a.IS_ACTIVE === "Y"),
            );
            return fn(null);
        }

        return new Transaction(db()).withTransaction(async (session) => {
            // No .limit(): FETCH FIRST cannot be combined with FOR UPDATE.
            const rows = await session
                .collection(TABLE)
                .find({ ROLE: "SUPER_ADMIN", IS_ACTIVE: "Y" })
                .project({ ID: 1 })
                .forUpdate(true)
                .toArray();
            assertNotLast(rows ?? []);
            return fn(session);
        });
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
     * @param {object|null} [session] - guard session (see withLastSuperAdminGuard)
     * @returns {Promise<void>}
     */
    static async setNotifyFlags(username, channelFlags, session = null) {
        const fields = {};
        for (const [channel, value] of Object.entries(channelFlags ?? {})) {
            const column = SERVER_NOTIFY_FLAG_COLUMNS[channel];
            if (column) fields[column] = value === "Y" ? "Y" : "N";
        }
        if (Object.keys(fields).length === 0) return;
        return AdminModel._set(username, fields, session);
    }

    /**
     * Persists an admin's EMAIL (e.g. the operator-typed override address a
     * temporary password was sent to). EMAIL is outside the signed field set,
     * so SYSSIGNATURE is unchanged. A blank value stores NULL.
     * @param {string} username
     * @param {string|null} email
     * @returns {Promise<void>}
     */
    static async setEmail(username, email) {
        const value = typeof email === "string" && email.trim() ? email.trim() : null;
        return AdminModel._set(username, { EMAIL: value });
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
     * @param {object|null} [session] - guard session (see withLastSuperAdminGuard)
     * @returns {Promise<void>}
     */
    static async updateRole(username, role, sysSignature, session = null) {
        return AdminModel._set(
            username,
            { ROLE: role, SYSSIGNATURE: sysSignature },
            session,
        );
    }

    /**
     * Updates IS_ACTIVE + SYSSIGNATURE. Caller re-signs with the new flag.
     * @param {string} username
     * @param {string} isActive  - 'Y' | 'N'
     * @param {string} sysSignature
     * @param {object|null} [session] - guard session (see withLastSuperAdminGuard)
     * @returns {Promise<void>}
     */
    static async setActive(username, isActive, sysSignature, session = null) {
        return AdminModel._set(
            username,
            { IS_ACTIVE: isActive, SYSSIGNATURE: sysSignature },
            session,
        );
    }

    /**
     * Deletes an admin by USERNAME.
     * @param {string} username
     * @param {object|null} [session] - guard session (see withLastSuperAdminGuard)
     * @returns {Promise<void>}
     */
    static async deleteAdmin(username, session = null) {
        if (isDemoMode()) {
            const { admins } = await demo.accounts();
            const idx = admins.findIndex((a) => a.USERNAME === username);
            if (idx !== -1) admins.splice(idx, 1);
            return;
        }
        await writeCol(session).deleteOne({ USERNAME: username });
    }

    /**
     * Internal $set helper shared by the update methods. Always stamps UPDATED_AT.
     * @param {string} username
     * @param {object} fields
     * @param {object|null} [session] - guard session; null uses the pool
     * @private
     */
    static async _set(username, fields, session = null) {
        if (isDemoMode()) {
            const { admins } = await demo.accounts();
            const row = admins.find((a) => a.USERNAME === username);
            if (row) Object.assign(row, fields, { UPDATED_AT: new Date() });
            return;
        }
        await writeCol(session).updateOne(
            { USERNAME: username },
            { $set: { ...fields, UPDATED_AT: new Date() } },
        );
    }
}

AdminModel.SIGN_CONTEXT = SIGN_CONTEXT;
AdminModel.buildSignedFields = buildSignedFields;
AdminModel.SERVER_NOTIFY_FLAG_COLUMNS = SERVER_NOTIFY_FLAG_COLUMNS;
AdminModel.SEARCH_MAX_LIMIT = SEARCH_MAX_LIMIT;

module.exports = AdminModel;
