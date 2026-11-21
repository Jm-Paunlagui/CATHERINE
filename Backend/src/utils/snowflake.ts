"use strict";

/**
 * @fileoverview Zero-dependency Snowflake ID generator for request tracing.
 *
 * WHAT THIS FILE DOES
 *   Generates time-sortable, unique, human-readable Snowflake IDs in a
 *   segmented format: `{timestamp}-{machineId}-{sequence}`.
 *   Used by TraceabilityMiddleware to produce Request IDs that are:
 *     - Chronologically sortable (timestamp is the leading segment)
 *     - Visually deconstructable (segments separated by hyphens)
 *     - Collision-free across distributed instances (machine ID isolation)
 *     - PKG-compatible (pure JS — no WASM, no native addons, no ESM-only deps)
 *
 * HOW IT WORKS
 *   Three zero-padded decimal segments joined by hyphens:
 *
 *   ┌───────────────────────┬──────────┬──────────────┐
 *   │  13 digits: timestamp │ 4 digits │  4 digits    │
 *   │  (ms since epoch)     │ machine  │  sequence    │
 *   │  → ~317 years         │ (0-1023) │  (0-4095)    │
 *   └───────────────────────┴──────────┴──────────────┘
 *
 *   Format: "0078812966528-0448-0000"  (23 chars, fixed width)
 *
 *   - Custom epoch: 2024-01-01T00:00:00.000Z — keeps timestamps compact.
 *   - Machine ID: derived from SNOWFLAKE_MACHINE_ID env var, or hashed from
 *     the first non-internal IPv4 address, or falls back to (PID % 1024).
 *   - Sequence: counter (0–4095) that resets each millisecond. If exhausted
 *     within a single ms (>4096 IDs/ms), the generator spin-waits until the
 *     next millisecond — safe because 4096 IDs/ms = 4 million IDs/s, far
 *     beyond any realistic Express request rate.
 *   - Fixed width: all segments are zero-padded, so IDs sort lexicographically
 *     and fit comfortably in VARCHAR2(64).
 *
 * EXAMPLE
 *   const { snowflake } = require("../utils/snowflake");
 *
 *   const id = snowflake.nextId();        // "0078812966528-0448-0000"
 *   const info = snowflake.deconstruct(id);
 *   // { timestamp: 1719753600123, machineId: 448, sequence: 0, date: Date(...) }
 *
 * PKG COMPATIBILITY
 *   Pure JavaScript. No native addons, no WASM, no ESM-only imports.
 *   Uses only Node.js built-ins (os). Safe for `pkg` compilation
 *   with no additional `assets` entries required.
 *
 * @module utils/snowflake
 */

const crypto = require("crypto");
const os = require("os");

// ─── Constants ──────────────────────────────────────────────────────────────────

/**
 * Custom epoch: 2024-01-01T00:00:00.000Z.
 * All timestamps are stored as (Date.now() - EPOCH), keeping IDs compact.
 * 13 digits of ms provide ~317 years of headroom (until ~2341).
 *
 * @constant {number}
 */
const EPOCH = new Date("2024-01-01T00:00:00.000Z").getTime();

/** Maximum machine ID value (10-bit equivalent: 0–1023). */
const MAX_MACHINE_ID = 1023;

/** Maximum sequence value per millisecond (12-bit equivalent: 0–4095). */
const MAX_SEQUENCE = 4095;

/** Upper bound (exclusive) for the random nonce mixed into the tail segment. */
const NONCE_RANGE = 10000; // 0000–9999

/** Padding widths for each segment — ensures fixed-width, lexicographic sorting. */
const TIMESTAMP_PAD = 13; // ms since epoch, up to 9999999999999 (~317 years)
const MACHINE_PAD = 4; // 0000–1023
const TAIL_PAD = 4; // 0000–9999

/** Regex for parsing a segmented Snowflake ID. */
const SNOWFLAKE_RE = /^(\d{13})-(\d{4})-(\d{4})$/;

// ─── Machine ID resolution ─────────────────────────────────────────────────────

/**
 * Resolve the machine ID (0–1023) from environment or network.
 *
 * Priority:
 *   1. SNOWFLAKE_MACHINE_ID env var (explicit, for orchestrated deployments)
 *   2. FNV-1a hash of the first non-internal IPv4 address (stable per host)
 *   3. process.pid % 1024 (last resort — unique per process on a single host)
 *
 * O(I) time where I = number of network interfaces (tiny, constant).
 *
 * @returns {number} Machine ID in [0, 1023].
 */
function _resolveMachineId() {
    // 1. Explicit env var
    const envId = process.env.SNOWFLAKE_MACHINE_ID;
    if (envId !== undefined && envId !== "") {
        const parsed = parseInt(envId, 10);
        if (!Number.isNaN(parsed) && parsed >= 0 && parsed <= MAX_MACHINE_ID) {
            return parsed;
        }
    }

    // 2. Hash the first non-internal IPv4 address
    try {
        const ifaces = os.networkInterfaces();
        for (const name of Object.keys(ifaces)) {
            for (const iface of ifaces[name]) {
                if (iface.family === "IPv4" && !iface.internal) {
                    // FNV-1a 32-bit hash → mod 1024
                    let hash = 0x811c9dc5;
                    for (let i = 0; i < iface.address.length; i++) {
                        hash ^= iface.address.charCodeAt(i);
                        hash = (hash * 0x01000193) >>> 0;
                    }
                    return hash % 1024;
                }
            }
        }
    } catch {
        // Network interfaces unavailable (sandboxed env) — fall through
    }

    // 3. PID fallback
    return process.pid % 1024;
}

// ─── Snowflake class ────────────────────────────────────────────────────────────

class Snowflake {
    /**
     * Create a Snowflake ID generator.
     *
     * @param {object}  [options]
     * @param {number}  [options.epoch]     - Custom epoch as ms timestamp. Defaults to 2024-01-01.
     * @param {number}  [options.machineId] - Explicit machine ID (0–1023). Auto-resolved if omitted.
     */
    constructor(options = {}) {
        this._epoch = options.epoch ?? EPOCH;
        this._machineId =
            options.machineId !== undefined
                ? Math.max(0, Math.min(MAX_MACHINE_ID, options.machineId | 0))
                : _resolveMachineId();

        /** @type {number} Last timestamp (ms since epoch) used for ID generation. */
        this._lastTimestamp = -1;

        /** @type {number} Per-millisecond sequence counter (0–4095). */
        this._sequence = 0;

        /** @type {number} Random base mixed into the tail segment. Refreshed each ms. */
        this._nonce = crypto.randomInt(NONCE_RANGE);

        // Pre-compute the padded machine ID segment (immutable per instance).
        /** @type {string} */
        this._machineSegment = String(this._machineId).padStart(
            MACHINE_PAD,
            "0",
        );
    }

    /**
     * Generate the next Snowflake ID in segmented format.
     *
     * Format: `{timestamp 13}-{machineId 4}-{tail 4}`
     * Example: `"0078812966528-0448-7293"`
     *
     * The tail segment combines the internal sequence counter with a
     * crypto-random nonce so every ID looks visually distinct — even when
     * requests are seconds apart and the sequence would otherwise always
     * be 0000. Within the same millisecond the sequence still increments
     * monotonically (collision-free), but the random base makes the
     * displayed value unpredictable.
     *
     * Thread-safety note: Node.js is single-threaded for JS execution, so no
     * mutex is needed. Worker threads would need their own Snowflake instance
     * with a distinct machineId.
     *
     * O(1) time, O(1) space. Amortised — spin-wait on sequence exhaustion is
     * bounded to < 1ms and occurs only at > 4096 IDs/ms (4M IDs/s).
     *
     * @returns {string} Segmented Snowflake ID (fixed 23 chars).
     * @example
     * snowflake.nextId(); // "0078812966528-0448-7293"
     */
    nextId() {
        let now = Date.now() - this._epoch;

        if (now === this._lastTimestamp) {
            // Same millisecond — increment sequence
            this._sequence = (this._sequence + 1) & MAX_SEQUENCE;
            if (this._sequence === 0) {
                // Sequence exhausted (>4096 IDs in 1ms) — spin-wait for next ms.
                // This is safe: 4096 IDs/ms = ~4M IDs/s, far beyond any Express
                // server's capacity. The spin is bounded to < 1ms.
                while (now <= this._lastTimestamp) {
                    now = Date.now() - this._epoch;
                }
            }
        } else {
            // New millisecond — reset sequence and pick a fresh random base
            this._sequence = 0;
            this._nonce = crypto.randomInt(NONCE_RANGE);
        }

        this._lastTimestamp = now;

        const ts = String(now).padStart(TIMESTAMP_PAD, "0");
        // Mix sequence + nonce so the tail is both unique (sequence) and
        // visually distinct (nonce). Wraps at 10000 to stay 4 digits.
        const tail = String(
            (this._sequence + this._nonce) % NONCE_RANGE,
        ).padStart(TAIL_PAD, "0");

        return `${ts}-${this._machineSegment}-${tail}`;
    }

    /**
     * Deconstruct a segmented Snowflake ID into its constituent parts.
     *
     * Useful for forensic analysis in the Trace modal — extract the exact
     * generation timestamp, originating machine, and the tail nonce.
     *
     * O(1) time, O(1) space.
     *
     * @param {string} id - The segmented Snowflake ID (e.g. "0078812966528-0448-7293").
     * @returns {{ timestamp: number, machineId: number, tail: number, date: Date }}
     * @throws {Error} When the ID does not match the expected format.
     * @example
     * snowflake.deconstruct("0078812966528-0448-7293");
     * // { timestamp: 1719753600123, machineId: 448, tail: 7293, date: Date(...) }
     */
    deconstruct(id) {
        const match = SNOWFLAKE_RE.exec(id);
        if (!match) {
            throw new Error(`Invalid Snowflake ID format: "${id}"`);
        }
        const epochMs = parseInt(match[1], 10);
        const machineId = parseInt(match[2], 10);
        const tail = parseInt(match[3], 10);
        const timestamp = epochMs + this._epoch;
        return {
            timestamp,
            machineId,
            tail,
            date: new Date(timestamp),
        };
    }

    /**
     * The machine ID this instance is using.
     *
     * @returns {number}
     */
    get machineId() {
        return this._machineId;
    }

    /**
     * The epoch this instance is using (as epoch-ms number).
     *
     * @returns {number}
     */
    get epoch() {
        return this._epoch;
    }
}

// ─── Singleton export ───────────────────────────────────────────────────────────

/**
 * Module-level singleton. All middleware share one generator so the sequence
 * counter is globally monotonic within a single process.
 *
 * @type {Snowflake}
 */
const snowflake = new Snowflake();

module.exports = { Snowflake, snowflake };
