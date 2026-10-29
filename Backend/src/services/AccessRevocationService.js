"use strict";

/**
 * @fileoverview Access-token revocation.
 *
 * Ends access tokens together with their session, instead of letting them run
 * until they expire. Called by RefreshTokenService whenever a session family is
 * revoked (sign-out, password change/reset, admin re-add, refresh-token reuse,
 * credential-epoch mismatch); read by AuthMiddleware on every authenticated
 * request.
 *
 * Three ways an ended family reaches a process:
 *   1. locally, the moment it is revoked here (before any DB write, so a DB
 *      outage during sign-out still ends the access token on this worker);
 *   2. clustered: a NOTIFY to the primary, which broadcasts it to every other
 *      worker and replays its own copy to a worker that starts later;
 *   3. at boot: families revoked within the access-token lifetime are read back
 *      from T_AUTH_REFRESH_TOKEN_DEV (a full restart loses the in-memory copies).
 *
 * No DB call per request: `isRevoked` is a Map lookup (O(1)). Live SSE streams
 * of an ended session are closed too (SseConnectionRegistry.endFamilies).
 *
 * Security: CWE-613 (session expiration), CWE-532 (only an 8-char family prefix
 * is ever logged), CWE-400 (bounded set, bounded IPC payloads).
 *
 * Must NOT import AuthService or RefreshTokenService (both import this module).
 *
 * @author senior-nodejs-engineer
 */

const { logger } = require("../utils/logger");
const { authMessages } = require("../constants/messages");
const { ACCESS_REVOCATION_LIMITS, FAMILY_ID_RE } = require("../constants/authTokens");
const { CLUSTER_RPC_METHODS } = require("../constants/clusterIpc");
const { accessTokenTtl } = require("../utils/auth/tokenClaims");
const { revokedSessions } = require("../utils/auth/RevokedSessionSet");
const { clusterRpc } = require("../utils/cluster/ClusterRpcClient");
const AuthRefreshTokenModel = require("../models/auth.refresh.token.model");
const SseConnectionRegistry = require("../utils/sse/SseConnectionRegistry");

let warnedUnparseableTtl = false;

class AccessRevocationService {
    /**
     * How long an ended family must be remembered: the access-token lifetime
     * plus clock skew. An unparseable JWT_EXPIRES_IN falls back to the refresh
     * lifetime (logged once) - keeping an entry too long is harmless, too short
     * would let a token through.
     *
     * @returns {number} ms
     */
    static retentionMs() {
        const { ttlMs, raw } = accessTokenTtl();
        if (ttlMs === null) {
            if (!warnedUnparseableTtl) {
                warnedUnparseableTtl = true;
                logger.warning(authMessages.ACCESS_TTL_UNPARSEABLE(raw));
            }
            return ACCESS_REVOCATION_LIMITS.FALLBACK_TTL_MS + ACCESS_REVOCATION_LIMITS.CLOCK_SKEW_MS;
        }
        // Clamped so every entry stays inside what the IPC validators accept.
        return Math.min(ttlMs + ACCESS_REVOCATION_LIMITS.CLOCK_SKEW_MS, ACCESS_REVOCATION_LIMITS.MAX_TTL_MS);
    }

    /**
     * Ends the access tokens of the given families on this process and tells
     * the rest of the cluster. Never throws.
     *
     * @param {Iterable<string>} familyIds
     * @param {number} [nowMs=Date.now()]
     * @returns {number} families newly recorded on this process
     */
    static revoke(familyIds, nowMs = Date.now()) {
        const untilMs = nowMs + AccessRevocationService.retentionMs();
        const entries = [];
        for (const fid of new Set(Array.isArray(familyIds) ? familyIds : [])) {
            if (typeof fid !== "string" || !FAMILY_ID_RE.test(fid)) continue;
            entries.push({ fid, untilMs });
        }
        const added = AccessRevocationService.#applyLocal(entries);
        AccessRevocationService.#broadcast(entries);
        return added;
    }

    /**
     * @param {string|undefined} fid - the access token's `fid` claim
     * @param {number} [nowMs]
     * @returns {boolean} true when the token's session was ended
     */
    static isRevoked(fid, nowMs = Date.now()) {
        return revokedSessions.has(fid, nowMs);
    }

    /**
     * Applies entries received from the primary (broadcast or start-up sync).
     * The IPC layer has already validated their shape.
     *
     * @param {{fid: string, untilMs: number}[]} entries
     * @returns {number} families newly recorded
     */
    static applyRemote(entries) {
        return AccessRevocationService.#applyLocal(Array.isArray(entries) ? entries : []);
    }

    /**
     * Boot reload: families revoked within the retention window. Best effort -
     * a failure is logged at error level and the process keeps starting (the
     * gap is bounded by the access-token lifetime).
     *
     * @param {number} [nowMs=Date.now()]
     * @returns {Promise<number>} families loaded
     */
    static async loadRecent(nowMs = Date.now()) {
        const retention = AccessRevocationService.retentionMs();
        try {
            const rows = await AuthRefreshTokenModel.findRevokedSince(
                new Date(nowMs - retention),
                ACCESS_REVOCATION_LIMITS.BOOT_LOAD_LIMIT,
            );
            const entries = rows
                .filter((r) => FAMILY_ID_RE.test(r.familyId))
                .map((r) => ({ fid: r.familyId, untilMs: r.revokedAt.getTime() + retention }));
            const added = AccessRevocationService.#applyLocal(entries, { endStreams: false });
            logger.notice(authMessages.ACCESS_REVOCATIONS_LOADED(added));
            return added;
        } catch (err) {
            logger.error(authMessages.ACCESS_REVOCATIONS_LOAD_FAILED(err?.message ?? String(err)));
            return 0;
        }
    }

    // ── Internals ────────────────────────────────────────────────────────────

    static #applyLocal(entries, { endStreams = true } = {}) {
        let added = 0;
        for (const { fid, untilMs } of entries) {
            const r = revokedSessions.revoke(fid, untilMs);
            if (r.added) added += 1;
            if (r.dropped) logger.warning(authMessages.ACCESS_REVOCATIONS_FULL(ACCESS_REVOCATION_LIMITS.MAX_ENTRIES));
        }
        // Live streams were authenticated once, at open: end the ones of an
        // ended session too (none exist yet at boot).
        if (endStreams && entries.length > 0) SseConnectionRegistry.endFamilies(entries.map((e) => e.fid));
        return added;
    }

    static #broadcast(entries) {
        if (!clusterRpc.active || entries.length === 0) return;
        const max = ACCESS_REVOCATION_LIMITS.MAX_FIDS_PER_MESSAGE;
        for (let i = 0; i < entries.length; i += max) {
            const chunk = entries.slice(i, i + max);
            if (!clusterRpc.notify(CLUSTER_RPC_METHODS.AUTH_REVOKE, { entries: chunk })) {
                logger.error(authMessages.ACCESS_REVOCATION_BROADCAST_FAILED(chunk.length));
            }
        }
    }
}

module.exports = AccessRevocationService;
