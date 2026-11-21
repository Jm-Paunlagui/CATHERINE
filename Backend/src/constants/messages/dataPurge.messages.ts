"use strict";

/**
 * @fileoverview Data Purge & Restore log message templates.
 * Used ONLY in logger calls — never thrown or sent to clients.
 */

const dataPurgeMessages = {
    // ── Scope resolution / preview ────────────────────────────────────────────
    /** @param {string[]} groups @param {string[]} tables @param {string[]} autoIncludedGroups */
    SCOPE_RESOLVED: (groups, tables, autoIncludedGroups) =>
        `Purge scope resolved — groups: [${groups.join(", ")}], auto-included: ` +
        `[${autoIncludedGroups.join(", ")}], ${tables.length} table(s).`,
    /** @param {number} tableCount @param {number} totalRows */
    PREVIEW_GENERATED: (tableCount, totalRows) =>
        `Purge preview generated — ${tableCount} table(s), ${totalRows} total row(s).`,

    // ── Backup ─────────────────────────────────────────────────────────────
    /** @param {number|string} adminId @param {string} scopeHash @param {number} tableCount */
    BACKUP_STARTED: (adminId, scopeHash, tableCount) =>
        `Backup archive build started — ADMIN_ID: ${adminId}, scopeHash: ${scopeHash}, ${tableCount} table(s).`,
    /** @param {number|string} adminId @param {string} scopeHash @param {number} totalRows @param {number} ms */
    BACKUP_COMPLETE: (adminId, scopeHash, totalRows, ms) =>
        `Backup archive build complete — ADMIN_ID: ${adminId}, scopeHash: ${scopeHash}, ${totalRows} row(s), ${ms}ms.`,
    /** @param {number|string} adminId @param {string} scopeHash @param {string} expiresAt */
    BACKUP_TOKEN_ISSUED: (adminId, scopeHash, expiresAt) =>
        `Backup token issued — ADMIN_ID: ${adminId}, scopeHash: ${scopeHash}, expires: ${expiresAt}.`,

    // ── Execute (purge) ────────────────────────────────────────────────────
    /** @param {number|string} adminId @param {string} scopeHash */
    EXECUTE_STARTED: (adminId, scopeHash) =>
        `Purge execution started — ADMIN_ID: ${adminId}, scopeHash: ${scopeHash}.`,
    /** @param {number|string} adminId @param {string} reason */
    EXECUTE_TOKEN_REJECTED: (adminId, reason) =>
        `Purge execution rejected — ADMIN_ID: ${adminId}, backup token invalid: ${reason}.`,
    /** @param {number|string} adminId */
    EXECUTE_PASSWORD_REJECTED: (adminId) =>
        `Purge execution rejected — ADMIN_ID: ${adminId}, admin password did not verify.`,
    /** @param {number|string} adminId */
    EXECUTE_CONFIRM_MISMATCH: (adminId) =>
        `Purge execution rejected — ADMIN_ID: ${adminId}, confirm phrase did not match.`,
    /** @param {string} table @param {number} tokenCount @param {number} liveCount */
    EXECUTE_COUNT_MISMATCH: (table, tokenCount, liveCount) =>
        `Purge execution rejected — "${table}" row count changed since backup: token had ${tokenCount}, live is ${liveCount}.`,
    /** @param {number|string} adminId */
    EXECUTE_LOCKOUT_ACK: (adminId) =>
        `Purge scope includes the Access Control admin table — ADMIN_ID: ${adminId} acknowledged the full-lockout warning.`,
    /** @param {string} table @param {number} rowCount */
    EXECUTE_TABLE_STEP: (table, rowCount) =>
        `Purge deleted table "${table}" — ${rowCount} row(s).`,
    /** @param {number|string} adminId @param {string} scopeHash @param {number} totalDeleted @param {number} ms */
    EXECUTE_COMMIT: (adminId, scopeHash, totalDeleted, ms) =>
        `Purge committed - ADMIN_ID: ${adminId}, scopeHash: ${scopeHash}, ${totalDeleted} row(s) deleted total, ${ms}ms.`,
    /** @param {Error|string} err */
    POST_COMMIT_AUDIT_FAILED: (err) =>
        `Purge post-commit audit write failed (purge itself already committed successfully): ${err?.message ?? err}.`,
    /** @param {Error|string} err */
    POST_COMMIT_EMAIL_FAILED: (err) =>
        `Purge post-commit ops alert email failed (purge itself already committed successfully): ${err?.message ?? err}.`,
    CACHE_FLUSHED: () => "All cache stores flushed after purge commit.",

    // ── Restore ───────────────────────────────────────────────────
    /** @param {string} reason */
    RESTORE_SIGNATURE_REJECTED: (reason) =>
        `Restore archive rejected — signature verification failed: ${reason}.`,
    /** @param {string[]} tables */
    RESTORE_MALICIOUS_MANIFEST: (tables) =>
        `Restore archive rejected — manifest names table(s) outside the allow-list or on the protected deny-list: [${tables.join(", ")}].`,
    /** @param {string} table @param {number} extraRows @param {number|string} adminId */
    RESTORE_TARGET_CHANGED_UNDER_LOCK: (table, extraRows, adminId) =>
        `Restore aborted and rolled back — "${table}" gained ${extraRows} row(s) between the pre-flight emptiness check and the locked insert (ADMIN_ID: ${adminId}). Nothing was committed.`,
    /** @param {string} reason */
    RESTORE_PREFLIGHT_REJECTED: (reason) =>
        `Restore pre-flight rejected: ${reason}.`,
    /** @param {number} tableCount @param {number} totalRows */
    RESTORE_PREVIEW_GENERATED: (tableCount, totalRows) =>
        `Restore pre-flight report generated — ${tableCount} table(s), ${totalRows} row(s).`,
    /** @param {number|string} adminId @param {string} scopeHash */
    RESTORE_STARTED: (adminId, scopeHash) =>
        `Restore execution started — ADMIN_ID: ${adminId}, archive scopeHash: ${scopeHash}.`,
    /** @param {number|string} adminId */
    RESTORE_PASSWORD_REJECTED: (adminId) =>
        `Restore execution rejected — ADMIN_ID: ${adminId}, admin password did not verify.`,
    /** @param {number|string} adminId */
    RESTORE_CONFIRM_MISMATCH: (adminId) =>
        `Restore execution rejected — ADMIN_ID: ${adminId}, confirm phrase did not match.`,
    /** @param {string} table @param {number} insertedCount @param {number} hashesResigned */
    RESTORE_TABLE_STEP: (table, insertedCount, hashesResigned) =>
        `Restore inserted table "${table}" — ${insertedCount} row(s), ${hashesResigned} ROW_HASH re-signed.`,
    /** @param {number|string} adminId @param {string} scopeHash @param {number} totalInserted @param {number} ms */
    RESTORE_COMMIT: (adminId, scopeHash, totalInserted, ms) =>
        `Restore committed — ADMIN_ID: ${adminId}, archive scopeHash: ${scopeHash}, ${totalInserted} row(s) inserted total, ${ms}ms.`,
    /** @param {Error|string} err */
    RESTORE_POST_COMMIT_AUDIT_FAILED: (err) =>
        `Restore post-commit audit write failed (restore itself already committed successfully): ${err?.message ?? err}.`,

    // ── Read-consistent multi-table streaming ──
    /** @param {string[]} tables @param {string} oracleMessage */
    STREAM_ALL_TABLES_SNAPSHOT_TOO_OLD: (tables, oracleMessage) =>
        `DataPurgeModel.streamAllTables() read-only transaction hit ORA-01555 snapshot too old across ${tables.length} table(s) [${tables.join(", ")}] — caller must fall back to the per-table streamTable() path and mark the backup manifest readConsistent:false. Oracle: ${oracleMessage}`,
};

module.exports = { dataPurgeMessages };
