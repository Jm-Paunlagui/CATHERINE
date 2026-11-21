"use strict";

/**
 * @fileoverview Pure helpers for the critical-log relay: a non-leader worker's
 * crit/alert/emerg log record is serialised here, sent to the primary, forwarded
 * to the cron-leader worker and fed to `AlertNotifierService.ingestRelayedCritical`
 * so the same digest + hourly cap apply as for a leader-local critical log.
 *
 * `buildRelayMessage` / `sanitizeMeta` are pure; `subscribeCriticalRelay` only registers
 * a logger subscription and keeps no state of its own — hence functions, not a class.
 *
 * Security: CWE-209/CWE-532 — the record is the logger's own (already redacted)
 * record; it is size-capped (CWE-770) and reduced to JSON-safe primitives so a
 * circular / huge meta cannot break IPC serialisation.
 *
 * @author senior-nodejs-engineer
 */

const { CLUSTER_IPC } = require("../../constants/clusterIpc");

/** Max characters kept of a relayed message. */
const RELAY_MESSAGE_MAX = 4000;
/** Max serialised size of relayed meta; larger meta is dropped to a marker. */
const RELAY_META_MAX = 4000;

/**
 * JSON-safe clone of `meta`: Errors become `{ name, message, stack }`,
 * circular refs / BigInt / functions are dropped. O(size of meta).
 *
 * @param {*} meta
 * @returns {object}
 */
function sanitizeMeta(meta) {
    if (!meta || typeof meta !== "object") return {};
    const seen = new WeakSet();
    try {
        const json = JSON.stringify(meta, (_k, v) => {
            if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack };
            if (typeof v === "bigint") return String(v);
            if (typeof v === "function") return undefined;
            if (v && typeof v === "object") {
                if (seen.has(v)) return undefined;
                seen.add(v);
            }
            return v;
        });
        if (json === undefined) return {};
        if (json.length > RELAY_META_MAX) return { truncated: true };
        return JSON.parse(json);
    } catch {
        return {};
    }
}

/**
 * Builds the IPC message for a logger record.
 *
 * @param {{level: string, message: *, meta?: object, requestId?: string|null, timestamp?: string}} record
 * @param {number} pid - Originating worker pid.
 * @returns {{cmd: string, record: {level: string, message: string, meta: object, requestId: string|null, timestamp: string, pid: number}}}
 */
function buildRelayMessage(record, pid) {
    return {
        cmd: CLUSTER_IPC.CRIT_RELAY,
        record: {
            level: String(record?.level ?? "CRITICAL"),
            message: String(record?.message ?? "").slice(0, RELAY_MESSAGE_MAX),
            meta: sanitizeMeta(record?.meta),
            requestId: record?.requestId ?? null,
            timestamp: record?.timestamp ?? new Date().toISOString(),
            pid,
        },
    };
}

/**
 * Subscribes a non-leader worker's critical logs to the relay.
 *
 * @param {{onLevel: (max: number, fn: Function) => Function}} logger
 * @param {{send?: Function, connected?: boolean, pid: number}} proc - `process`-like
 * @returns {Function} unsubscribe
 */
function subscribeCriticalRelay(logger, proc) {
    return logger.onLevel(2, (record) => {
        // `_noNotify` records never reach onLevel subscribers (logger skips
        // them); checked again here so a direct caller keeps the loop guard.
        if (record?.meta?._noNotify) return;
        if (typeof proc.send !== "function" || proc.connected === false) return;
        try {
            proc.send(buildRelayMessage(record, proc.pid));
        } catch {
            // IPC closed mid-shutdown — the log line itself is already written.
        }
    });
}

module.exports = { buildRelayMessage, subscribeCriticalRelay, sanitizeMeta, RELAY_MESSAGE_MAX, RELAY_META_MAX };
