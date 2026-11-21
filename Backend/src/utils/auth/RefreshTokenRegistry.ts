"use strict";

/**
 * @fileoverview Per-process refresh-token registry.
 *
 * Fast, synchronous VETO tier in front of the authoritative DB table
 * (T_AUTH_REFRESH_TOKEN_DEV). It remembers which refresh tokens THIS process issued
 * or saw, which were already rotated, and which families were revoked, so that:
 *   - a replayed (already rotated) token is refused without a DB round trip;
 *   - a token revoked here is refused even if the DB row is absent (fake pool in
 *     tests) or the DB is momentarily unreachable.
 * It never accepts on its own what the DB would refuse: AuthService/RefreshTokenService
 * only let the registry stand alone when the DB row is absent AND the registry
 * knows the token.
 *
 * Holds state, so a class. No logger, no DB. Memory is bounded (CWE-400):
 * at `maxEntries` expired entries are swept first (at most once a second), then
 * the oldest entry is dropped.
 *
 * Complexity: register/consume/revokeFamily O(1) amortised; revokeUser
 * O(families of the user); sweep O(n) at most once per SWEEP_MIN_GAP_MS.
 *
 * @author senior-nodejs-engineer
 */

const { REFRESH_REGISTRY_LIMITS } = require("../../constants/authTokens");

const SWEEP_MIN_GAP_MS = 1000;
const DEFAULT_MARKER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

class RefreshTokenRegistry {
    /** @type {Map<string, {familyId: string, userKey: string, expiresAtMs: number, used: boolean, replacedBy: string|null}>} */
    #entries = new Map();
    /** @type {Map<string, {revoked: boolean, expiresAtMs: number, jtis: Set<string>, userKey: string|null}>} */
    #families = new Map();
    /** @type {Map<string, Set<string>>} */
    #users = new Map();
    #maxEntries;
    #now;
    #lastSweep = -Infinity;

    /**
     * @param {object} [options]
     * @param {number} [options.maxEntries=REFRESH_REGISTRY_LIMITS.MAX_ENTRIES]
     * @param {() => number} [options.now=Date.now]
     */
    constructor({ maxEntries = REFRESH_REGISTRY_LIMITS.MAX_ENTRIES, now = Date.now } = {}) {
        this.#maxEntries = maxEntries;
        this.#now = now;
    }

    /** @returns {number} number of tracked refresh tokens */
    get size() {
        return this.#entries.size;
    }

    /**
     * Records a freshly issued refresh token.
     *
     * @param {object} rec
     * @param {string} rec.jtiHash
     * @param {string} rec.familyId
     * @param {string} rec.userKey
     * @param {number} rec.expiresAtMs
     */
    register({ jtiHash, familyId, userKey, expiresAtMs }) {
        if (this.#entries.has(jtiHash)) return;
        if (this.#entries.size >= this.#maxEntries) this.#makeRoom();

        this.#entries.set(jtiHash, {
            familyId,
            userKey,
            expiresAtMs,
            used: false,
            replacedBy: null,
        });

        let fam = this.#families.get(familyId);
        if (!fam) {
            fam = { revoked: false, expiresAtMs, jtis: new Set(), userKey };
            this.#families.set(familyId, fam);
        }
        fam.jtis.add(jtiHash);
        fam.userKey ??= userKey;
        if (expiresAtMs > fam.expiresAtMs) fam.expiresAtMs = expiresAtMs;

        let fids = this.#users.get(userKey);
        if (!fids) {
            fids = new Set();
            this.#users.set(userKey, fids);
        }
        fids.add(familyId);
    }

    /**
     * Atomically (synchronously) marks a token as rotated.
     *
     * The family-revoked marker is checked FIRST, including for a token this
     * process has not registered (`familyId` is the verified `fid` claim): a
     * revocation recorded here for a family whose entries were never seen (or
     * were evicted) still vetoes the token.
     *
     * @param {string} jtiHash
     * @param {string|null} replacedByHash - hash of the successor token
     * @param {number} [nowMs]
     * @param {string} [familyId] - verified `fid` claim of the presented token
     * @returns {"ok"|"reused"|"revoked"|"unknown"}
     *   `reused` also marks the whole family revoked.
     */
    consume(jtiHash, replacedByHash, nowMs = this.#now(), familyId = undefined) {
        const entry = this.#entries.get(jtiHash);
        const fid = entry?.familyId ?? familyId;
        if (fid !== undefined && this.#families.get(fid)?.revoked) return "revoked";
        if (!entry) return "unknown";

        if (entry.used) {
            this.revokeFamily(entry.familyId, nowMs, Math.max(entry.expiresAtMs - nowMs, 0) || DEFAULT_MARKER_TTL_MS);
            return "reused";
        }
        entry.used = true;
        entry.replacedBy = replacedByHash ?? null;
        return "ok";
    }

    /**
     * Undoes a local `consume` whose DB rotation then failed (transient DB
     * error), so a retry of the same cookie is not mistaken for token reuse.
     * Resets `used`/`replacedBy` ONLY when `replacedBy` still equals the
     * successor this caller recorded, so it can never un-consume a token that a
     * concurrent request legitimately rotated.
     *
     * @param {string} jtiHash
     * @param {string|null} replacedByHash - the value passed to `consume`
     * @returns {boolean} true when the consume was undone
     */
    unconsume(jtiHash, replacedByHash) {
        const entry = this.#entries.get(jtiHash);
        if (!entry || !entry.used || entry.replacedBy !== (replacedByHash ?? null)) return false;
        entry.used = false;
        entry.replacedBy = null;
        return true;
    }

    /**
     * Revokes a family. Records a marker even for a family this process has not
     * seen, so a token of that family arriving later is still vetoed.
     *
     * @param {string} familyId
     * @param {number} [nowMs]
     * @param {number} [ttlMs] - how long to remember the revocation
     */
    revokeFamily(familyId, nowMs = this.#now(), ttlMs = DEFAULT_MARKER_TTL_MS) {
        let fam = this.#families.get(familyId);
        if (!fam) {
            fam = { revoked: true, expiresAtMs: nowMs + ttlMs, jtis: new Set(), userKey: null };
            this.#families.set(familyId, fam);
            return;
        }
        fam.revoked = true;
        fam.expiresAtMs = Math.max(fam.expiresAtMs, nowMs + ttlMs);
    }

    /**
     * Revokes every family currently known for a user.
     *
     * @param {string} userKey - canonicalUserKey()
     * @param {number} [nowMs]
     * @param {number} [ttlMs]
     * @returns {number} families revoked
     */
    revokeUser(userKey, nowMs = this.#now(), ttlMs = DEFAULT_MARKER_TTL_MS) {
        const fids = this.#users.get(userKey);
        if (!fids) return 0;
        for (const fid of fids) this.revokeFamily(fid, nowMs, ttlMs);
        return fids.size;
    }

    /**
     * Session families this process knows for a user (live or revoked).
     *
     * @param {string} userKey - canonicalUserKey()
     * @returns {string[]}
     */
    familiesOfUser(userKey) {
        return [...(this.#users.get(userKey) ?? [])];
    }

    /** Test/diagnostics: drop everything. */
    clear() {
        this.#entries.clear();
        this.#families.clear();
        this.#users.clear();
        this.#lastSweep = -Infinity;
    }

    // ── Internals ────────────────────────────────────────────────────────────

    #makeRoom() {
        const now = this.#now();
        if (now - this.#lastSweep >= SWEEP_MIN_GAP_MS) {
            this.#lastSweep = now;
            for (const [hash, e] of this.#entries) {
                if (e.expiresAtMs <= now) this.#dropEntry(hash, e);
            }
            for (const [fid, fam] of this.#families) {
                if (fam.jtis.size === 0 && fam.expiresAtMs <= now) this.#dropFamily(fid, fam);
            }
        }
        if (this.#entries.size >= this.#maxEntries) {
            const oldest = this.#entries.entries().next();
            if (!oldest.done) this.#dropEntry(oldest.value[0], oldest.value[1]);
        }
    }

    #dropEntry(hash, entry) {
        this.#entries.delete(hash);
        const fam = this.#families.get(entry.familyId);
        if (!fam) return;
        fam.jtis.delete(hash);
        // A revoked family keeps its marker until it expires; a live family with
        // no tokens left has nothing to remember.
        if (fam.jtis.size === 0 && !fam.revoked) this.#dropFamily(entry.familyId, fam);
    }

    #dropFamily(fid, fam) {
        this.#families.delete(fid);
        if (fam.userKey === null) return;
        const fids = this.#users.get(fam.userKey);
        if (!fids) return;
        fids.delete(fid);
        if (fids.size === 0) this.#users.delete(fam.userKey);
    }
}

const refreshTokenRegistry = new RefreshTokenRegistry();

module.exports = { RefreshTokenRegistry, refreshTokenRegistry };
