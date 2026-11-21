"use strict";

/**
 * @fileoverview In-memory set of ended session families.
 *
 * An access token is a bearer credential that is not stored anywhere, so ending
 * a session (sign-out, password change/reset, admin re-add, refresh-token reuse)
 * used to cut off only its RENEWAL: the access token itself kept working until
 * it expired. Every access token carries its session family id (`fid`); this
 * set remembers each ended family until every access token of that family has
 * expired, and `AuthMiddleware` refuses a token whose family is in it.
 *
 * Holds state, so a class. No logger, no DB, no IPC (those live in
 * `AccessRevocationService`). Keyed by `fid`; the value is the time after which
 * the entry is no longer needed (`untilMs`). Re-revoking keeps the LATER time.
 *
 * Memory is bounded (CWE-400): at `maxEntries`, expired entries are swept first
 * (at most once a second); if the set is still full the soonest-expiring entry
 * is dropped and `revoke` reports it, so the caller can log it.
 *
 * Complexity: has/revoke O(1) amortised; sweep O(n) at most once per second;
 * dropping the soonest-expiring entry O(n), only when full of live entries.
 *
 * @author senior-nodejs-engineer
 */

const { ACCESS_REVOCATION_LIMITS } = require("../../constants/authTokens");

const SWEEP_MIN_GAP_MS = 1000;

class RevokedSessionSet {
    /** @type {Map<string, number>} fid -> untilMs */
    #entries = new Map();
    #maxEntries;
    #now;
    #lastSweep = -Infinity;

    /**
     * @param {object} [options]
     * @param {number} [options.maxEntries=ACCESS_REVOCATION_LIMITS.MAX_ENTRIES]
     * @param {() => number} [options.now=Date.now]
     */
    constructor({ maxEntries = ACCESS_REVOCATION_LIMITS.MAX_ENTRIES, now = Date.now } = {}) {
        this.#maxEntries = maxEntries;
        this.#now = now;
    }

    /** @returns {number} tracked families (expired ones included until swept) */
    get size() {
        return this.#entries.size;
    }

    /**
     * Records an ended family.
     *
     * @param {string} fid
     * @param {number} untilMs - epoch ms after which the entry may be forgotten
     * @returns {{added: boolean, dropped: boolean}} `dropped` = a live entry was
     *   evicted to make room (the set was full of live entries)
     */
    revoke(fid, untilMs) {
        if (typeof fid !== "string" || fid === "" || !Number.isFinite(untilMs)) {
            return { added: false, dropped: false };
        }
        const existing = this.#entries.get(fid);
        if (existing !== undefined) {
            if (untilMs > existing) this.#entries.set(fid, untilMs);
            return { added: false, dropped: false };
        }
        let dropped = false;
        if (this.#entries.size >= this.#maxEntries) dropped = this.#makeRoom();
        this.#entries.set(fid, untilMs);
        return { added: true, dropped };
    }

    /**
     * @param {string} fid
     * @param {number} [nowMs]
     * @returns {boolean} true while the family is ended and its entry is live
     */
    has(fid, nowMs = this.#now()) {
        if (typeof fid !== "string") return false;
        const until = this.#entries.get(fid);
        if (until === undefined) return false;
        if (until <= nowMs) {
            this.#entries.delete(fid);
            return false;
        }
        return true;
    }

    /**
     * Live entries, soonest-expiring LAST so a truncated snapshot keeps the
     * longest-lived ones (used to sync a worker that just started).
     *
     * @param {number} [nowMs]
     * @param {number} [limit=Infinity]
     * @returns {{fid: string, untilMs: number}[]}
     */
    snapshot(nowMs = this.#now(), limit = Infinity) {
        const out = [];
        for (const [fid, untilMs] of this.#entries) {
            if (untilMs > nowMs) out.push({ fid, untilMs });
        }
        out.sort((a, b) => b.untilMs - a.untilMs);
        return out.length > limit ? out.slice(0, limit) : out;
    }

    /** Test/diagnostics: drop everything. */
    clear() {
        this.#entries.clear();
        this.#lastSweep = -Infinity;
    }

    // ── Internals ────────────────────────────────────────────────────────────

    /** @returns {boolean} true when a LIVE entry had to be dropped */
    #makeRoom() {
        const now = this.#now();
        if (now - this.#lastSweep >= SWEEP_MIN_GAP_MS) {
            this.#lastSweep = now;
            for (const [fid, until] of this.#entries) {
                if (until <= now) this.#entries.delete(fid);
            }
        }
        if (this.#entries.size < this.#maxEntries) return false;
        let soonestFid = null;
        let soonest = Infinity;
        for (const [fid, until] of this.#entries) {
            if (until < soonest) {
                soonest = until;
                soonestFid = fid;
            }
        }
        if (soonestFid === null) return false;
        this.#entries.delete(soonestFid);
        return soonest > now;
    }
}

/** Process-wide instance used by AccessRevocationService and AuthMiddleware. */
const revokedSessions = new RevokedSessionSet();

module.exports = { RevokedSessionSet, revokedSessions };
