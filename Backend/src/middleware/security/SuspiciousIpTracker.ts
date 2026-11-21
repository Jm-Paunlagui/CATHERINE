"use strict";

/**
 * @fileoverview Suspicious-IP strike/block bookkeeping, extracted unchanged
 * from `SecurityFilterMiddleware`. In single-process mode it is the source of
 * truth; in a cluster the primary owns the strikes and every worker holds a
 * mirror of the blocks (`applyBlock`) so the per-request check stays local.
 *
 * Complexity: O(1) per strike / check; the cleanup sweep is O(tracked IPs) once
 * an hour on an unref'd timer.
 *
 * @author senior-nodejs-engineer
 */

const { logger } = require("../../utils/logger");
const { middlewareMessages } = require("../../constants/messages/middleware.messages");

const DEFAULT_THRESHOLD = 10;
const DEFAULT_BLOCK_MS = 60 * 60 * 1000;
const CLEANUP_EVERY_MS = 60 * 60 * 1000;
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * @class SuspiciousIpTracker
 * @description Holds the per-IP record map and the hourly cleanup timer.
 */
class SuspiciousIpTracker {
    static DEFAULT_THRESHOLD = DEFAULT_THRESHOLD;
    static DEFAULT_BLOCK_MS = DEFAULT_BLOCK_MS;

    /**
     * @param {object} [opts]
     * @param {number} [opts.threshold=10]
     * @param {number} [opts.blockMs=3600000]
     * @param {Map<string, {count: number, blockedUntil: number, lastSeen: number}>} [opts.records]
     */
    constructor({ threshold = DEFAULT_THRESHOLD, blockMs = DEFAULT_BLOCK_MS, records = new Map() } = {}) {
        this.records = records;
        this._threshold = threshold;
        this._blockMs = blockMs;
        this._cleanupTimer = setInterval(() => {
            const cutoff = Date.now() - STALE_AFTER_MS;
            for (const [ip, r] of this.records) {
                if (r.lastSeen < cutoff) this.records.delete(ip);
            }
        }, CLEANUP_EVERY_MS);
        if (this._cleanupTimer.unref) this._cleanupTimer.unref();
    }

    /**
     * @param {string} ip
     * @param {number} [now=Date.now()]
     * @returns {boolean} the IP is inside an active block
     */
    isBlocked(ip, now = Date.now()) {
        const record = this.records.get(ip);
        return Boolean(record && record.blockedUntil > now);
    }

    /**
     * Records one suspicious request. A lapsed block resets the counter (see the
     * ratchet note in SecurityFilterMiddleware history); an active block is a no-op.
     *
     * @param {string} ip
     * @param {number} [now=Date.now()]
     * @returns {{blocked: boolean, blockedUntil: number, justBlocked: boolean}}
     */
    strike(ip, now = Date.now()) {
        const record = this.records.get(ip) || { count: 0, blockedUntil: 0, lastSeen: now };

        if (record.blockedUntil > now) {
            return { blocked: true, blockedUntil: record.blockedUntil, justBlocked: false };
        }

        // A LAPSED block resets the counter. Without this the counter is a
        // one-way ratchet: once an IP reaches the threshold its count stays at or
        // above it forever, so the FIRST suspicious request after each block
        // expires immediately arms another full block - permanently, with a
        // service restart as the only remedy. There is no reverse proxy in front
        // of this API, so `req.ip` is a real workstation and the realistic victim
        // is a legitimate user behind a misconfigured tool. Serving the block is
        // unchanged; this only restores the SECOND offence budget after the
        // penalty has been served.
        if (record.blockedUntil !== 0) {
            record.count = 0;
            record.blockedUntil = 0;
            logger.notice(middlewareMessages.SUSPICIOUS_IP_BLOCK_EXPIRED(ip));
        }

        record.count++;
        record.lastSeen = now;

        let justBlocked = false;
        if (record.count >= this._threshold) {
            record.blockedUntil = now + this._blockMs;
            justBlocked = true;
            logger.warning(
                middlewareMessages.SUSPICIOUS_IP_BLOCKED(ip, new Date(record.blockedUntil).toISOString()),
                { requestCount: record.count },
            );
        }

        this.records.set(ip, record);
        return { blocked: record.blockedUntil > now, blockedUntil: record.blockedUntil, justBlocked };
    }

    /**
     * Clears a block and its counter.
     *
     * @param {string} ip
     * @returns {boolean} a record existed
     */
    unblock(ip) {
        return this.records.delete(ip);
    }

    /**
     * Mirrors a block decided elsewhere (the primary) without logging a new alert.
     *
     * @param {string} ip
     * @param {number} blockedUntil
     * @param {number} [now=Date.now()]
     */
    applyBlock(ip, blockedUntil, now = Date.now()) {
        this.records.set(ip, { count: this._threshold, blockedUntil, lastSeen: now });
    }

    /**
     * @param {number} [now=Date.now()]
     * @param {number} [limit=Infinity]
     * @returns {{ip: string, blockedUntil: number}[]} active blocks
     */
    blocksSnapshot(now = Date.now(), limit = Infinity) {
        const out = [];
        if (limit <= 0) return out;
        for (const [ip, r] of this.records) {
            if (r.blockedUntil > now) {
                out.push({ ip, blockedUntil: r.blockedUntil });
                if (out.length >= limit) break;
            }
        }
        return out;
    }

    /**
     * Same shape `SecurityFilterMiddleware.getStats()` has always returned.
     *
     * @param {number} [now=Date.now()]
     * @returns {object}
     */
    stats(now = Date.now()) {
        const blocked = [];
        const suspicious = [];
        for (const [ip, r] of this.records) {
            if (r.blockedUntil > now) {
                blocked.push({ ip, count: r.count, blockedUntil: new Date(r.blockedUntil).toISOString() });
            } else if (r.count > 0) {
                suspicious.push({ ip, count: r.count, lastSeen: new Date(r.lastSeen).toISOString() });
            }
        }
        return {
            totalTracked: this.records.size,
            blocked: blocked.length,
            suspicious: suspicious.length,
            blockedIPs: blocked,
            suspiciousIPs: suspicious,
        };
    }

    /** Stops the cleanup timer (tests). */
    dispose() {
        clearInterval(this._cleanupTimer);
    }
}

module.exports = { SuspiciousIpTracker };
