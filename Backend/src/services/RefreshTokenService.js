"use strict";

/**
 * @fileoverview Refresh-token lifecycle: persist, rotate, revoke, purge.
 * Business logic only - SQL lives in
 * `auth.refresh.token.model.js`, HTTP in the controller.
 *
 * Every revocation here also ends the family's ACCESS tokens at once
 * (AccessRevocationService) - before the DB write, so a DB outage
 * cannot leave a signed-out access token working.
 *
 * Two tiers decide whether a refresh token may be used:
 *   1. the per-process `RefreshTokenRegistry` (sync VETO: reuse / revoked);
 *   2. the DB table T_AUTH_REFRESH_TOKEN_DEV (authoritative, atomic across workers).
 * The registry may accept ON ITS OWN only when the DB row is absent AND the
 * registry knows the token (`allowAbsent`). In production inserts are awaited,
 * so the DB row always exists; the rule exists for the no-DB test pools. Do not
 * tighten it.
 *
 * Must NOT import AuthService (AuthService imports this module).
 *
 * Security: CWE-613 (session expiration), CWE-294 (capture-replay), CWE-312
 * (only the jti hash is stored), CWE-532 (never log a token, jti or full
 * family id - 8-char family prefix only).
 *
 * Complexity: O(1) per call (indexed lookups); purge is bounded by BATCH_LIMIT.
 */

const { AppError, AUTH_ERRORS } = require("../constants/errors");
const { logger } = require("../utils/logger");
const { authMessages } = require("../constants/messages");
const { REFRESH_REVOKE_REASONS, REFRESH_PURGE } = require("../constants/authTokens");
const { hashJti } = require("../utils/auth/tokenClaims");
const { canonicalUserKey } = require("../utils/auth/userKey");
const { refreshTokenRegistry } = require("../utils/auth/RefreshTokenRegistry");
const AuthRefreshTokenModel = require("../models/auth.refresh.token.model");
const AccessRevocationService = require("./AccessRevocationService");
const { RetryPolicy } = require("../utils/resilience");

const fidPrefix = (fid) => String(fid ?? "").slice(0, 8);

class RefreshTokenService {
    /**
     * Writes the ledger row for a freshly issued refresh token. FAILS CLOSED:
     * a login whose refresh token cannot be recorded must not succeed.
     *
     * @param {object} record - `refreshRecord` returned by AuthService._issueTokens
     * @returns {Promise<void>}
     */
    static async persistIssued(record) {
        await AuthRefreshTokenModel.insert(record);
    }

    /**
     * Consumes the presented refresh token and records its successor.
     *
     * @param {{jti: string, familyId: string, userId: string}} presented - claims of the presented token
     * @param {object} nextRecord - `refreshRecord` of the successor pair
     * @returns {Promise<void>} resolves only when rotation succeeded
     * @throws {AppError} 401 REFRESH_TOKEN_REVOKED | REFRESH_TOKEN_REUSED
     */
    static async rotate({ jti, familyId, userId }, nextRecord) {
        const jtiHash = hashJti(jti);
        const nowMs = Date.now();

        const local = refreshTokenRegistry.consume(jtiHash, nextRecord.jtiHash, nowMs, familyId);
        if (local === "reused") {
            await RefreshTokenService.#onReuse(userId, familyId);
        }
        if (local === "revoked") {
            RefreshTokenService.#reject(userId, "revoked");
        }

        let outcome;
        try {
            ({ outcome } = await AuthRefreshTokenModel.rotate({
                oldHash: jtiHash,
                next: nextRecord,
                now: new Date(nowMs),
                allowAbsent: local === "ok",
            }));
        } catch (err) {
            // The DB never recorded the rotation: undo the local consume so the
            // client's retry with the same cookie is not read as reuse.
            if (local === "ok") refreshTokenRegistry.unconsume(jtiHash, nextRecord.jtiHash);
            throw err;
        }

        if (outcome === "ok") return;
        if (outcome === "reused") await RefreshTokenService.#onReuse(userId, familyId);
        // revoked | absent (unknown in both tiers)
        RefreshTokenService.#reject(userId, outcome);
    }

    /**
     * Revokes one session family in both tiers.
     *
     * @param {string} familyId
     * @param {string} reason - REFRESH_REVOKE_REASONS value
     * @param {{bestEffort?: boolean, retryTransient?: boolean}} [opts] -
     *   `bestEffort`: a DB failure is logged, not thrown (logout, reuse handling).
     *   `retryTransient`: ONE retry (RetryPolicy, 2 attempts) for a transient DB
     *   error before giving up (logout).
     * @returns {Promise<void>}
     */
    static async revokeFamily(
        familyId,
        reason,
        { bestEffort = false, retryTransient = false } = {},
    ) {
        if (!familyId) return;
        AccessRevocationService.revoke([familyId]);
        refreshTokenRegistry.revokeFamily(familyId, Date.now());
        try {
            const revoke = () => AuthRefreshTokenModel.revokeFamily(familyId, reason, new Date());
            if (retryTransient) {
                await new RetryPolicy({
                    maxAttempts: 2,
                    baseDelayMs: 50,
                    maxDelayMs: 200,
                    classifier: RetryPolicy.classifyDbError,
                    label: "refresh-family-revoke",
                }).execute(revoke);
            } else {
                await revoke();
            }
            logger.info(authMessages.REFRESH_FAMILY_REVOKED(fidPrefix(familyId), reason));
        } catch (err) {
            if (!bestEffort) throw err;
            logger.error(authMessages.REFRESH_REVOKE_PERSIST_FAILED("family", err?.message ?? String(err)));
        }
    }

    /**
     * Revokes every session of a user in both tiers. FAILS CLOSED: if the DB
     * revoke fails the error propagates, so the caller (password change/reset,
     * admin re-add) aborts BEFORE it changes the credential.
     *
     * @param {string|number} userId
     * @param {string} reason - REFRESH_REVOKE_REASONS value (stored)
     * @param {{cause?: string}} [opts] - SESSION_END_CAUSES value for the log
     *   line when the stored reason is less specific (Access Control)
     * @returns {Promise<void>}
     */
    static async revokeAllForUser(userId, reason, { cause } = {}) {
        const userKey = canonicalUserKey(userId);
        // Families this process knows end at once; the DB then names every
        // family of the user (other workers, earlier boots) in the same UPDATE
        // that revokes them.
        AccessRevocationService.revoke(refreshTokenRegistry.familiesOfUser(userKey));
        refreshTokenRegistry.revokeUser(userKey, Date.now());
        const familyIds = await AuthRefreshTokenModel.revokeUser(userKey, reason, new Date());
        AccessRevocationService.revoke(familyIds);
        logger.info(authMessages.REFRESH_USER_SESSIONS_REVOKED(userId, cause ?? reason));
    }

    /**
     * Deletes a bounded batch of long-expired rows. Best effort: never throws.
     *
     * @returns {Promise<number>} rows deleted (0 on failure)
     */
    static async purgeExpired() {
        try {
            const cutoff = new Date(Date.now() - REFRESH_PURGE.GRACE_MS);
            return await AuthRefreshTokenModel.purgeExpired(cutoff, REFRESH_PURGE.BATCH_LIMIT);
        } catch (err) {
            logger.warning(authMessages.REFRESH_PURGE_FAILED(err?.message ?? String(err)));
            return 0;
        }
    }

    // ── Internals ────────────────────────────────────────────────────────────

    /** Reuse: end the whole family in both tiers, then refuse. Never returns. */
    static async #onReuse(userId, familyId) {
        await RefreshTokenService.revokeFamily(familyId, REFRESH_REVOKE_REASONS.REUSE, {
            bestEffort: true,
        });
        logger.warning(
            authMessages.REFRESH_TOKEN_REUSE_DETECTED(userId, fidPrefix(familyId)),
        );
        throw new AppError(AUTH_ERRORS.REFRESH_TOKEN_REUSED, 401, {
            type: "AuthenticationError",
        });
    }

    /** Revoked / unknown: refuse. Never returns. */
    static #reject(userId, outcome) {
        logger.warning(authMessages.REFRESH_TOKEN_REJECTED(userId, outcome));
        throw new AppError(AUTH_ERRORS.REFRESH_TOKEN_REVOKED, 401, {
            type: "AuthenticationError",
        });
    }
}

module.exports = RefreshTokenService;
