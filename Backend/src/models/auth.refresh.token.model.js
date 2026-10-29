"use strict";

/**
 * @fileoverview T_AUTH_REFRESH_TOKEN_DEV data access (DDL in
 * sql/01_schema.sql section 6 and sql/04_platform_tables.sql).
 *
 * The authoritative, cross-worker tier of refresh-token revocation. Every
 * statement is raw SQL with bind variables only (CWE-89); no user value is ever
 * interpolated. Bind names avoid Oracle reserved words (`:hash :newHash :fid
 * :userKey :nowTs :reason :cutoffTs :lim ...`). Timestamps are bound
 * application `Date`s - there is no SYSTIMESTAMP in this model, so the JWT
 * clock and the ledger clock cannot disagree.
 *
 * Only the SHA-256 hex of the jti is ever stored or passed in (CWE-312).
 *
 * `rotate` is ONE transaction: a single conditional UPDATE decides the winner
 * (`USED_AT IS NULL AND REVOKED_AT IS NULL`), so two workers racing on the same
 * token cannot both succeed. A non-"ok" outcome NEVER inserts the successor.
 *
 * Static class: it wraps a database pool and holds no per-instance state.
 *
 * In DEMO_MODE every method operates on the in-memory ledger in demoStore with
 * the same semantics (single-winner rotate, pair invariants); no Oracle
 * connection is opened.
 */

const { createDb } = require("../utils/oracle-mongo-wrapper");
const { isDemoMode } = require("../config/demoMode");
const demo = require("./demo/demoStore");

const _db = createDb("appDb");

const TABLE = "T_AUTH_REFRESH_TOKEN_DEV";

const INSERT_SQL = `INSERT INTO ${TABLE}
    (JTI_HASH, FAMILY_ID, USER_ID, ROLE_SOURCE, ISSUED_AT, EXPIRES_AT)
 VALUES (:hash, :fid, :userKey, :roleSource, :issuedTs, :expiresTs)`;

const ROTATE_SQL = `UPDATE ${TABLE}
    SET USED_AT = :nowTs, REPLACED_BY = :newHash
  WHERE JTI_HASH = :hash AND USED_AT IS NULL AND REVOKED_AT IS NULL`;

const STATE_SQL = `SELECT REVOKED_AT, USED_AT FROM ${TABLE} WHERE JTI_HASH = :hash`;

const REVOKE_FAMILY_SQL = `UPDATE ${TABLE}
    SET REVOKED_AT = :nowTs, REVOKE_REASON = :reason
  WHERE FAMILY_ID = :fid AND REVOKED_AT IS NULL`;

// RETURNING gives the families in the SAME statement that revokes them, so a
// session created between a SELECT and the UPDATE cannot be revoked here yet
// missed by the access-token revocation.
const REVOKE_USER_SQL = `UPDATE ${TABLE}
    SET REVOKED_AT = :nowTs, REVOKE_REASON = :reason
  WHERE USER_ID = :userKey AND REVOKED_AT IS NULL
  RETURNING FAMILY_ID INTO :fids`;

// Families ended within the access-token lifetime (boot reload of the
// revoked-session set). No index on REVOKED_AT: the table only holds rows up to
// a day past their refresh expiry (purgeExpired), so this is one bounded scan
// per process start.
const RECENTLY_REVOKED_SQL = `SELECT FAMILY_ID, MAX(REVOKED_AT) AS REVOKED_AT
   FROM ${TABLE}
  WHERE REVOKED_AT >= :sinceTs
  GROUP BY FAMILY_ID
  FETCH FIRST :lim ROWS ONLY`;

const PURGE_SQL = `DELETE FROM ${TABLE}
  WHERE EXPIRES_AT < :cutoffTs AND ROWNUM <= :lim`;

/**
 * @param {object} rec
 * @returns {object} bind object for INSERT_SQL
 */
function insertBinds(rec) {
    return {
        hash: rec.jtiHash,
        fid: rec.familyId,
        userKey: rec.userKey,
        roleSource: rec.roleSource,
        issuedTs: new Date(rec.issuedAtMs),
        expiresTs: new Date(rec.expiresAtMs),
    };
}

// ─── DEMO_MODE in-memory ledger ──────────────────────────────────────────────

/**
 * Builds an in-memory ledger row mirroring the T_AUTH_REFRESH_TOKEN_DEV columns.
 * @param {object} rec
 * @returns {object}
 */
function demoRow(rec) {
    return {
        JTI_HASH: rec.jtiHash,
        FAMILY_ID: rec.familyId,
        USER_ID: rec.userKey,
        ROLE_SOURCE: rec.roleSource,
        ISSUED_AT: new Date(rec.issuedAtMs),
        EXPIRES_AT: new Date(rec.expiresAtMs),
        USED_AT: null,
        REPLACED_BY: null,
        REVOKED_AT: null,
        REVOKE_REASON: null,
    };
}

/**
 * Demo insert honouring UQ_TARTD_JTI_HASH (a duplicate hash is rejected).
 * @param {object} rec
 */
function demoInsert(rec) {
    const rows = demo.refreshTokens();
    if (rows.some((r) => r.JTI_HASH === rec.jtiHash)) {
        throw new Error("ORA-00001: unique constraint (UQ_TARTD_JTI_HASH) violated");
    }
    rows.push(demoRow(rec));
}

class AuthRefreshTokenModel {
    /**
     * Inserts one ledger row.
     *
     * @param {{jtiHash: string, familyId: string, userKey: string, roleSource: "user"|"admin", issuedAtMs: number, expiresAtMs: number}} rec
     * @returns {Promise<void>}
     */
    static async insert(rec) {
        if (isDemoMode()) {
            demoInsert(rec);
            return;
        }
        await _db.withTransaction((conn) => conn.execute(INSERT_SQL, insertBinds(rec)));
    }

    /**
     * Atomically consumes `oldHash` and records its successor.
     *
     * @param {object} p
     * @param {string} p.oldHash - SHA-256 hex of the presented token's jti
     * @param {object} p.next - successor record (same shape as `insert`)
     * @param {Date} p.now
     * @param {boolean} p.allowAbsent - accept a token with NO row (only when the
     *   per-process registry vouches for it; see RefreshTokenService)
     * @returns {Promise<{outcome: "ok"|"reused"|"revoked"|"absent"}>}
     */
    static async rotate({ oldHash, next, now, allowAbsent }) {
        if (isDemoMode()) {
            // Synchronous body: no await between check and mutation, so two
            // concurrent rotations of the same token cannot both win.
            const row = demo.refreshTokens().find((r) => r.JTI_HASH === oldHash);
            if (row && row.USED_AT === null && row.REVOKED_AT === null) {
                row.USED_AT = now;
                row.REPLACED_BY = next.jtiHash;
                demoInsert(next);
                return { outcome: "ok" };
            }
            if (!row) {
                if (!allowAbsent) return { outcome: "absent" };
                demoInsert(next);
                return { outcome: "ok" };
            }
            if (row.REVOKED_AT) return { outcome: "revoked" };
            return { outcome: "reused" };
        }
        return _db.withTransaction(async (conn) => {
            const upd = await conn.execute(ROTATE_SQL, {
                nowTs: now,
                newHash: next.jtiHash,
                hash: oldHash,
            });
            if ((upd.rowsAffected ?? 0) === 1) {
                await conn.execute(INSERT_SQL, insertBinds(next));
                return { outcome: "ok" };
            }

            const sel = await conn.execute(
                STATE_SQL,
                { hash: oldHash },
                { outFormat: _db.oracledb.OUT_FORMAT_OBJECT },
            );
            const row = sel.rows?.[0];
            if (!row) {
                if (!allowAbsent) return { outcome: "absent" };
                await conn.execute(INSERT_SQL, insertBinds(next));
                return { outcome: "ok" };
            }
            if (row.REVOKED_AT) return { outcome: "revoked" };
            return { outcome: "reused" };
        });
    }

    /**
     * Revokes every not-yet-revoked row of a family.
     *
     * @param {string} familyId
     * @param {string} reason - REFRESH_REVOKE_REASONS value
     * @param {Date} now
     * @returns {Promise<number>} rows revoked
     */
    static async revokeFamily(familyId, reason, now) {
        if (isDemoMode()) {
            let n = 0;
            for (const r of demo.refreshTokens()) {
                if (r.FAMILY_ID === familyId && r.REVOKED_AT === null) {
                    r.REVOKED_AT = now;
                    r.REVOKE_REASON = reason;
                    n++;
                }
            }
            return n;
        }
        const res = await _db.withTransaction((conn) =>
            conn.execute(REVOKE_FAMILY_SQL, { nowTs: now, reason, fid: familyId }),
        );
        return res?.rowsAffected ?? 0;
    }

    /**
     * Revokes every not-yet-revoked row of a user (all of their sessions).
     *
     * @param {string} userKey - canonicalUserKey()
     * @param {string} reason - REFRESH_REVOKE_REASONS value
     * @param {Date} now
     * @returns {Promise<string[]>} distinct session family ids just revoked
     */
    static async revokeUser(userKey, reason, now) {
        if (isDemoMode()) {
            const fids = new Set();
            for (const r of demo.refreshTokens()) {
                if (r.USER_ID === userKey && r.REVOKED_AT === null) {
                    r.REVOKED_AT = now;
                    r.REVOKE_REASON = reason;
                    fids.add(r.FAMILY_ID);
                }
            }
            return [...fids];
        }
        const { oracledb } = _db;
        const res = await _db.withTransaction((conn) =>
            conn.execute(REVOKE_USER_SQL, {
                nowTs: now,
                reason,
                userKey,
                fids: { dir: oracledb.BIND_OUT, type: oracledb.STRING, maxSize: 36 },
            }),
        );
        const fids = res?.outBinds?.fids;
        return Array.isArray(fids) ? [...new Set(fids.filter((f) => typeof f === "string"))] : [];
    }

    /**
     * Session families revoked at or after `since` (boot reload).
     *
     * @param {Date} since
     * @param {number} limit
     * @returns {Promise<{familyId: string, revokedAt: Date}[]>}
     */
    static async findRevokedSince(since, limit) {
        if (isDemoMode()) {
            const latest = new Map();
            for (const r of demo.refreshTokens()) {
                if (!(r.REVOKED_AT instanceof Date) || r.REVOKED_AT < since) continue;
                const prev = latest.get(r.FAMILY_ID);
                if (!prev || r.REVOKED_AT > prev) latest.set(r.FAMILY_ID, r.REVOKED_AT);
            }
            return [...latest]
                .slice(0, Math.max(0, Number(limit) || 0))
                .map(([familyId, revokedAt]) => ({ familyId, revokedAt }));
        }
        const res = await _db.withConnection((conn) =>
            conn.execute(
                RECENTLY_REVOKED_SQL,
                { sinceTs: since, lim: limit },
                { outFormat: _db.oracledb.OUT_FORMAT_OBJECT },
            ),
        );
        return (res?.rows ?? [])
            .filter((r) => typeof r.FAMILY_ID === "string" && r.REVOKED_AT instanceof Date)
            .map((r) => ({ familyId: r.FAMILY_ID, revokedAt: r.REVOKED_AT }));
    }

    /**
     * Deletes up to `limit` rows that expired before `cutoff`.
     *
     * @param {Date} cutoff
     * @param {number} limit
     * @returns {Promise<number>} rows deleted
     */
    static async purgeExpired(cutoff, limit) {
        if (isDemoMode()) {
            const rows = demo.refreshTokens();
            const max = Math.max(0, Number(limit) || 0);
            let n = 0;
            for (let i = rows.length - 1; i >= 0 && n < max; i--) {
                if (rows[i].EXPIRES_AT < cutoff) {
                    rows.splice(i, 1);
                    n++;
                }
            }
            return n;
        }
        const res = await _db.withTransaction((conn) =>
            conn.execute(PURGE_SQL, { cutoffTs: cutoff, lim: limit }),
        );
        return res?.rowsAffected ?? 0;
    }
}

module.exports = AuthRefreshTokenModel;
