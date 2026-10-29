"use strict";

/**
 * @fileoverview Backup token issuance + verification + single-use
 * consumption.
 *
 * WHAT THIS FILE DOES
 * --------------------
 * A backup token is the SERVER-SIDE enforcement of "you must download a
 * backup before you may purge" (CWE-602 — an FE stepper gate alone is
 * client-side-only enforcement and can be bypassed). `POST /backup` issues
 * one; `POST /execute` (and the Access Control revoke/delete flow) must
 * treat it as SINGLE-USE before any destructive action runs.
 *
 * Deliberately its own class — NOT folded into `BackupArchiveService` or
 * `DataPurgeService` — so both of those services can depend on it without
 * creating a circular require between them: `BackupArchiveService` calls
 * `issue()` when it streams a backup archive; `DataPurgeService` /
 * `AdminManagementService` call `consume()` before they act. Neither of
 * those two services needs to require the other module.
 *
 * HOW IT WORKS
 * ------------
 *   token = "<hmac-hex-signature>.<base64url(payloadJson)>"
 *   payload = { scopeHash, rowCounts, adminId, issuedAt, expiresAt, jti }
 *
 * The signature covers the ENTIRE payload JSON via
 * `CryptoVault.signData` / `verifySignature` (`DATA_SIGNING_SECRET`) —
 * reusing CryptoVault's vetted, timing-safe HMAC-SHA256 primitive rather
 * than hand-rolling one here. Neither a hex digest (`[0-9a-f]+`) nor a
 * base64url string (`[A-Za-z0-9_-]+`) can ever contain a literal `.`, so
 * splitting the token on its first `.` is unambiguous.
 *
 * `rowCounts` (table name -> row count captured at backup time) doubles as
 * the authoritative "which tables did this backup actually cover" set —
 * `DataPurgeService.executePurge` checks that the scope it is about to
 * purge is a SUBSET of `Object.keys(payload.rowCounts)`. That is what makes
 * a token un-replayable against a WIDER scope than what was actually backed
 * up without needing to separately re-derive or trust a table
 * list from anywhere else.
 *
 * `jti` is a fresh `crypto.randomUUID()` minted at `issue()` time — the
 * nonce {@link BackupTokenService.consume} persists to
 * `T_SERVER_BACKUP_TOKEN_CONSUMED_DEV` (`BackupTokenModel.consumeJti`) the
 * FIRST time (and only the first time) a token is accepted. Without
 * this, `verify()` alone is stateless: it checks the signature and expiry
 * and returns, but never marks anything used, so the SAME token can be
 * replayed any number of times inside its TTL. A destructive route (purge
 * execute, admin revoke/delete) calling `verify()` in a loop, or two
 * concurrent requests racing on one token, would both pass every gate and
 * both run.
 *
 * `verify()` stays PURE (no DB I/O, safe to call repeatedly, e.g. from a
 * pre-check endpoint) — it never marks a token used. `consume()` is what
 * every route that is about to act on a token's validity must call instead.
 *
 * EXAMPLE
 * -------
 *   const { token, expiresAt } = await BackupTokenService.issue({
 *       adminId: 10234,
 *       scopeHash: "3f9c...ab12",
 *       rowCounts: { T_AUDIT_LOGS_DEV: 128031, T_SERVER_ALERT_LOG_DEV: 4021 },
 *   });
 *   // ... later, in POST /execute ...
 *   const result = await BackupTokenService.consume(token);
 *   if (!result.valid) {
 *       // result.reason is one of: "malformed" | "tampered" | "expired" | "replayed"
 *   } else {
 *       result.payload.adminId;      // 10234
 *       result.payload.rowCounts;  // { T_AUDIT_LOGS_DEV: 128031, T_SERVER_ALERT_LOG_DEV: 4021 }
 *   }
 */

const crypto = require("crypto");
const { CryptoVault } = require("../utils/encryption/CryptoVault");
const BackupTokenModel = require("../models/backup-token.model");
const { logger } = require("../utils/logger");
const { dataBackupMessages } = require("../constants/messages");

/** Default TTL (minutes) when BACKUP_TOKEN_TTL_MINUTES is unset — mirrors .env.example. */
const DEFAULT_TTL_MINUTES = 30;

class BackupTokenService {
    /**
     * Issues a new backup token bound to one admin and one resolved table
     * scope (via `rowCounts`' keys + `scopeHash`).
     *
     * @param {object} params
     * @param {number|string} params.adminId      - Admin numeric id (T_ADMINS_DEV.ID) this token is bound to.
     * @param {string}        params.scopeHash  - `DataPurgeService.resolveScope(...).scopeHash` for the backed-up scope.
     * @param {Record<string, number>} params.rowCounts - Per-table row count captured at backup time. Its KEY SET is the authoritative "what this backup actually covers" list.
     * @param {Record<string, string>} [params.highWater] - Highest backed-up PK (exact-digit string) per append-only log table; bounds execute's re-count + DELETE.
     * @param {number}        [params.ttlMinutes] - Overrides `BACKUP_TOKEN_TTL_MINUTES` / the 30-minute default.
     * @returns {Promise<{ token: string, issuedAt: number, expiresAt: number }>}
     *
     * @example
     * const { token, expiresAt } = await BackupTokenService.issue({
     *     adminId: 10234,
     *     scopeHash: "3f9c...ab12",
     *     rowCounts: { T_SERVER_ALERT_LOG_DEV: 42 },
     * });
     */
    static async issue({ adminId, scopeHash, rowCounts, highWater, ttlMinutes }) {
        const ttl = Number.isFinite(ttlMinutes)
            ? ttlMinutes
            : parseInt(process.env.BACKUP_TOKEN_TTL_MINUTES, 10) || DEFAULT_TTL_MINUTES;

        const issuedAt = Date.now();
        const expiresAt = issuedAt + ttl * 60 * 1000;
        // jti (JWT-style terminology, though this is not a JWT): a fresh
        // random nonce per issued token, minted here and nowhere else. This
        // is what `consume()` persists exactly once — see the file header
        // for why `verify()` alone cannot provide replay protection.
        const jti = crypto.randomUUID();
        const payload = {
            scopeHash,
            rowCounts,
            adminId,
            issuedAt,
            expiresAt,
            jti,
        };
        // Signed with the rest of the payload, so a client cannot raise a
        // high-water to make post-backup rows deletable.
        if (highWater && typeof highWater === "object" && Object.keys(highWater).length > 0) {
            payload.highWater = highWater;
        }
        const payloadJson = JSON.stringify(payload);

        const signature = await CryptoVault.signData(payloadJson);
        const payloadB64 = Buffer.from(payloadJson, "utf8").toString("base64url");

        return { token: `${signature}.${payloadB64}`, issuedAt, expiresAt };
    }

    /**
     * Verifies a backup token's signature and expiry, returning its decoded
     * payload. NEVER throws for a malformed/tampered/expired token — returns
     * a discriminated `{ valid, ... }` result instead, so callers can map
     * each failure mode to the correct `PURGE_ERRORS` entry without a
     * try/catch per failure case.
     *
     * @param {string} token
     * @returns {Promise<
     *   | { valid: true, payload: { scopeHash: string, rowCounts: Record<string, number>, adminId: number|string, issuedAt: number, expiresAt: number } }
     *   | { valid: false, reason: "malformed"|"tampered"|"expired" }
     * >}
     *
     * @example
     * const result = await BackupTokenService.verify(req.body.backupToken);
     * if (!result.valid) throw new AppError(PURGE_ERRORS.BACKUP_TOKEN_INVALID, HTTP_STATUS.UNAUTHORIZED);
     */
    static async verify(token) {
        if (typeof token !== "string" || token.length === 0 || !token.includes(".")) {
            return { valid: false, reason: "malformed" };
        }

        const dotIndex = token.indexOf(".");
        const signature = token.slice(0, dotIndex);
        const payloadB64 = token.slice(dotIndex + 1);

        let payloadJson;
        try {
            payloadJson = Buffer.from(payloadB64, "base64url").toString("utf8");
        } catch {
            return { valid: false, reason: "malformed" };
        }

        // An empty payload half ("<sig>.") would make verifySignature throw —
        // verify() must never throw (428, not 500).
        if (!payloadJson) return { valid: false, reason: "malformed" };

        const signatureOk = await CryptoVault.verifySignature(payloadJson, signature);
        if (!signatureOk) return { valid: false, reason: "tampered" };

        let payload;
        try {
            payload = JSON.parse(payloadJson);
        } catch {
            return { valid: false, reason: "malformed" };
        }

        if (
            typeof payload !== "object" ||
            payload === null ||
            typeof payload.expiresAt !== "number" ||
            typeof payload.scopeHash !== "string" ||
            typeof payload.rowCounts !== "object" ||
            payload.rowCounts === null
        ) {
            return { valid: false, reason: "malformed" };
        }

        if (Date.now() > payload.expiresAt) {
            return { valid: false, reason: "expired" };
        }

        return { valid: true, payload };
    }

    /**
     * Verifies a backup token EXACTLY like {@link BackupTokenService.verify},
     * then atomically claims its `jti` before reporting success — the
     * single-use gate every destructive route (purge execute, admin
     * revoke/delete) must call instead of `verify()`.
     *
     * **Design decision: burn on the first SUCCESSFUL
     * verify, not on eventual success of the caller's whole operation.**
     * The instant this method has confirmed the token's signature and
     * expiry are valid, it consumes the `jti` — even if the CALLER goes on
     * to reject the request for an unrelated reason (wrong admin, scope
     * mismatch, a stale row-count drift check, or the destructive action
     * itself failing). A second attempt with the SAME token, for ANY
     * reason, is a replay and must fail. This is deliberately conservative:
     * if the caller's operation does not go through, the token is still
     * spent and the operator must download a fresh backup and get a new
     * token. Replay protection beats retry convenience for an operation
     * that is either irreversible (purge) or security-sensitive (admin
     * revoke/delete) — see the call sites in `DataPurgeService.executePurge`
     * and `AdminManagementService._verifyRevokeBackupToken` for the same
     * note anchored to the exact line it applies to.
     *
     * Consumption is atomic at the DATABASE level
     * (`BackupTokenModel.consumeJti` — a primary-key `INSERT`, ORA-00001 on
     * a duplicate `jti`), so two concurrent `consume()` calls for the SAME
     * token — a double-click, a client retry, or a deliberate replay attempt
     * fired in parallel — can never both win, even across `NUM_WORKERS`
     * clustered processes that share no memory.
     *
     * @param {string} token
     * @returns {Promise<
     *   | { valid: true, payload: { scopeHash: string, rowCounts: Record<string, number>, adminId: number|string, issuedAt: number, expiresAt: number, jti: string } }
     *   | { valid: false, reason: "malformed"|"tampered"|"expired"|"replayed" }
     * >}
     *
     * @example
     * const result = await BackupTokenService.consume(req.body.backupToken);
     * if (!result.valid) throw new AppError(PURGE_ERRORS.BACKUP_TOKEN_INVALID, HTTP_STATUS.UNAUTHORIZED);
     */
    static async consume(token) {
        const result = await BackupTokenService.verify(token);
        if (!result.valid) return result;

        const { payload } = result;
        if (typeof payload.jti !== "string" || payload.jti.length === 0) {
            // A structurally valid, correctly-signed token with no jti can
            // only be one minted before this feature existed (or a forged
            // payload that happens to satisfy verify()'s looser shape check
            // — impossible in practice, since jti is inside the signed
            // payload and verify() already rejected a tampered signature
            // above). Treat it the same as any other malformed token rather
            // than silently granting unlimited replay.
            return { valid: false, reason: "malformed" };
        }

        const { consumed } = await BackupTokenModel.consumeJti({
            jti: payload.jti,
            adminId: payload.adminId,
            expiresAt: new Date(payload.expiresAt),
        });
        if (!consumed) {
            logger.warning(dataBackupMessages.TOKEN_REPLAY_BLOCKED(payload.adminId, payload.jti));
            return { valid: false, reason: "replayed" };
        }

        logger.info(dataBackupMessages.TOKEN_CONSUMED(payload.adminId, payload.jti));
        return { valid: true, payload };
    }
}

module.exports = BackupTokenService;
