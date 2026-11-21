"use strict";

/**
 * @fileoverview Backup token replay-protection ledger.
 *
 * WHAT THIS FILE DOES
 * --------------------
 * Owns all DB access for `T_SERVER_BACKUP_TOKEN_CONSUMED_DEV` — the persisted
 * record of which backup-token `jti` (nonce) values have already been spent.
 * `BackupTokenService.consume()` is the ONLY caller: it verifies a token's
 * HMAC signature and expiry (pure, in-memory), then calls
 * {@link BackupTokenModel.consumeJti} to atomically claim the token's `jti`
 * before treating the token as usable.
 *
 * This table is deliberately NOT in `purgeTables.js` (same reasoning as
 * `T_SERVER_BACKUP_DELETE_VOTE_DEV` — see `backup-vote.model.js`): replay
 * protection must not evaporate the instant an operator purges the
 * database, since a purge is exactly the kind of destructive action this
 * table exists to make single-use.
 *
 * HOW IT WORKS
 * ------------
 * `JTI` is the table's PRIMARY KEY. `consumeJti` does a plain `insertOne` —
 * the FIRST caller to insert a given `jti` wins; every subsequent attempt to
 * insert the SAME `jti` (a genuine replay, or two concurrent requests
 * racing on the same token) raises `ORA-00001` on the primary-key
 * constraint, which this method catches and reports as
 * `{ consumed: false, reason: "already-consumed" }` — the SAME
 * insert-then-catch-ORA-00001 idiom `BackupVoteModel.castVote` already uses
 * for its own "claim exactly once"
 * writes. The uniqueness guarantee is enforced by Oracle itself, not by
 * application-level locking, so it holds even under `NUM_WORKERS`
 * clustering (multiple Node processes, no shared memory) and even across a
 * process restart.
 *
 * EXAMPLE
 * -------
 *   const BackupTokenModel = require("./backup-token.model");
 *   const { consumed } = await BackupTokenModel.consumeJti({
 *       jti: "3f9c2e10-...",
 *       adminId: 10234,
 *       expiresAt: new Date(Date.now() + 30 * 60 * 1000),
 *   });
 *   if (!consumed) {
 *       // this token's jti was already spent — reject as a replay
 *   }
 */

const {
    createDb,
    OracleCollection,
} = require("../utils/oracle-mongo-wrapper");
const { isDemoMode } = require("../config/demoMode");
const demo = require("./demo/demoStore");

/** Table name (template `_DEV` convention; DDL in sql/01_schema.sql section 7). */
const TABLE = "T_SERVER_BACKUP_TOKEN_CONSUMED_DEV";

// Explicit "appDb" pool — see data-purge.model.js's identical warning.
// A bare createDb() falls back to the wrapper's default pool; a forgotten
// argument here would silently bind this table's writes to the wrong database.
const _db = createDb("appDb");
const _tokens = new OracleCollection(TABLE, _db);

class BackupTokenModel {
    /**
     * Atomically claims one backup-token `jti`. The PRIMARY KEY on `JTI`
     * (PK_SBTC_JTI, sql/01_schema.sql) is what makes this exactly-once: only the first
     * concurrent caller's `insertOne` succeeds, every other caller — whether
     * a genuine replay minutes later or a true race a few milliseconds
     * apart — gets `ORA-00001` and a `{ consumed: false }` result.
     *
     * @param {object} params
     * @param {string} params.jti - The token payload's unique nonce.
     * @param {number|string} params.adminId - Admin numeric id (T_ADMINS_DEV.ID) the token was bound to (audit/debug column only — not part of the uniqueness check). Stored in the legacy-named `EMP_ID` column; renaming the column needs a schema migration (sql/04_platform_tables.sql), so it is kept as-is.
     * @param {Date} params.expiresAt - The token's own expiry — stored so a future retention sweep can prune long-expired rows (no scheduler is built here; see BackupTokenService's file header).
     * @returns {Promise<{ consumed: true } | { consumed: false, reason: "already-consumed" }>}
     *
     * @example
     * const { consumed } = await BackupTokenModel.consumeJti({
     *     jti: "3f9c2e10-...", adminId: 10234, expiresAt: new Date(),
     * });
     */
    static async consumeJti({ jti, adminId, expiresAt }) {
        if (isDemoMode()) {
            // Same exactly-once semantics as the PK: has-then-set with no
            // await in between, so a concurrent replay cannot also win.
            const consumed = demo.backupTokensConsumed();
            const key = String(jti);
            if (consumed.has(key)) {
                return { consumed: false, reason: "already-consumed" };
            }
            consumed.set(key, {
                JTI: key,
                EMP_ID: Number(adminId),
                EXPIRES_AT: expiresAt,
                CONSUMED_AT: new Date(),
            });
            return { consumed: true };
        }
        try {
            // `returning: ["JTI"]` is NOT for the returned value (JTI is
            // caller-supplied, never generated) — it exists ONLY to stop
            // OracleCollection.insertOne's default "no ID column? try
            // RETURNING ID anyway" fallback, which raises ORA-00904 on a
            // table whose PK isn't literally named ID.
            await _tokens.insertOne(
                {
                    JTI: jti,
                    EMP_ID: Number(adminId),
                    EXPIRES_AT: expiresAt,
                },
                { returning: ["JTI"] },
            );
            return { consumed: true };
        } catch (err) {
            if (/ORA-00001/.test(err?.message)) {
                return { consumed: false, reason: "already-consumed" };
            }
            throw err;
        }
    }
}

module.exports = BackupTokenModel;
