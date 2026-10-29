"use strict";

/**
 * @fileoverview IPC command names exchanged between the cluster primary and
 * its workers (`process.send` / `worker.send`). Distinct from the cache-sync
 * channel (`ClusterCacheSync` tags its messages with `ch`, not `cmd`).
 *
 * Payloads:
 *  - SHUTDOWN   primary → worker : `{ cmd, signal }`
 *  - BOOT_FATAL worker → primary : `{ cmd, code }`  (PFX missing, EADDRINUSE, EACCES)
 *  - CRIT_RELAY worker → primary → leader worker : `{ cmd, record }`
 *               (record built by `src/utils/cluster/critRelay.js`)
 *  - RPC_REQUEST W→P `{ cmd, id, target, method, args }`; RPC_RESPONSE P→W
 *    `{ cmd, id, ok, result?, error? }`; RPC_CALL P→W `{ cmd, callId, method, args }`;
 *    RPC_RETURN W→P `{ cmd, callId, ok, result?, error? }`; NOTIFY W→P
 *    `{ cmd, method, args }` (no reply); BROADCAST P→W `{ cmd, topic, payload }`.
 *    Shared-state RPC (rate limiter, security filter, scheduler, metrics,
 *    alert ack, login lockout, session revocation, recipients) - see `ClusterRpcHub`.
 *
 * @author senior-nodejs-engineer
 */

const CLUSTER_IPC = Object.freeze({
    SHUTDOWN: "app:shutdown",
    BOOT_FATAL: "app:boot-fatal",
    CRIT_RELAY: "app:crit-relay",
    RPC_REQUEST: "app:rpc-req",
    RPC_RESPONSE: "app:rpc-res",
    RPC_CALL: "app:rpc-call",
    RPC_RETURN: "app:rpc-ret",
    NOTIFY: "app:notify",
    BROADCAST: "app:bcast",
});

/** Where the primary routes an RPC request. */
const CLUSTER_RPC_TARGETS = Object.freeze({
    PRIMARY: "primary",
    LEADER: "leader",
    ALL: "all",
});

/** Allow-listed RPC / notify method names (the hub only dispatches these). */
const CLUSTER_RPC_METHODS = Object.freeze({
    RL_HIT: "rl.hit",
    RL_CLEAR: "rl.clear",
    /** Notify: gives back a FAILURES-mode hit counted on the primary. */
    RL_REFUND: "rl.refund",
    SF_STRIKE: "sf.strike",
    SF_UNBLOCK: "sf.unblock",
    SCHED_RECORD: "sched.record",
    RECIPIENTS_INVALIDATE: "recipients.invalidate",
    METRICS_SNAPSHOT: "metrics.snapshot",
    ALERTS_ACK: "alerts.ack",
    ALERTS_UNACK: "alerts.unack",
    ALERTS_STATUS: "alerts.status",
    ALERTS_ACKS: "alerts.acks",
    /** Cluster-wide per-user login lockout; counted on the primary. */
    LOCKOUT_CHECK: "lockout.check",
    LOCKOUT_FAIL: "lockout.fail",
    LOCKOUT_CLEAR: "lockout.clear",
    /** Notify: session families ended on a worker (access-token revocation). */
    AUTH_REVOKE: "auth.revoke",
});

/** Allow-listed broadcast topics (primary → workers). */
const CLUSTER_TOPICS = Object.freeze({
    SF_BLOCK: "sf.block",
    SF_UNBLOCKED: "sf.unblocked",
    SF_SYNC: "sf.sync",
    SCHED_STATE: "sched.state",
    SCHED_SYNC: "sched.sync",
    RECIPIENTS_INVALIDATE: "recipients.invalidate",
    /** Ended session families, fanned out to every other worker. */
    AUTH_REVOKED: "auth.revoked",
    /** Live ended families, sent to a worker that just started listening. */
    AUTH_SYNC: "auth.sync",
});

/** RPC error codes carried in `error.code`. */
const CLUSTER_RPC_ERROR_CODES = Object.freeze({
    TIMEOUT: "TIMEOUT",
    NO_LEADER: "NO_LEADER",
    REJECTED: "REJECTED",
    HANDLER_ERROR: "HANDLER_ERROR",
    OVERLOAD: "OVERLOAD",
});

/** Per-call timeouts (ms). Constants, not env. */
const CLUSTER_RPC_TIMEOUTS = Object.freeze({
    DEFAULT_MS: 1000,
    RL_HIT_MS: 100,
    /** Login lockout calls sit on the login path; a slow primary falls back to the local lockout. */
    LOCKOUT_MS: 250,
    SF_UNBLOCK_MS: 1000,
    /** Primary-side wait for every worker's metrics snapshot. */
    GATHER_MS: 750,
    /** Asking worker gives up on the gather. */
    METRICS_CLIENT_MS: 1500,
    /** Concurrent metrics callers on one worker share one gather this long. */
    METRICS_SHARE_MS: 1000,
    /** Leader-forwarded alert ack/status calls. */
    LEADER_FORWARD_MS: 5000,
});

/** Bounds (CWE-400) and validation limits. */
const CLUSTER_RPC_LIMITS = Object.freeze({
    MAX_PENDING_PER_CLIENT: 2000,
    MAX_GATHERS: 50,
    MAX_LEADER_CALLS: 200,
    MAX_ID_LENGTH: 64,
    MAX_ERROR_MESSAGE: 500,
    MAX_RL_COUNTERS: 64,
    MAX_RL_KEYS_PER_COUNTER: 200_000,
    RL_LABEL_RE: /^[A-Za-z0-9:_-]{1,64}$/,
    RL_KEY_MAX: 300,
    /** Canonical user key length for lockout.* (a USERNAME is far shorter; bounded for CWE-400). */
    LOCKOUT_KEY_MAX: 128,
    /** Tracked users on the primary before new keys fall back to the worker. */
    MAX_LOCKOUT_KEYS: 100_000,
    RL_MAX_MIN: 1,
    RL_MAX_MAX: 1_000_000,
    RL_WINDOW_MIN_MS: 1000,
    RL_WINDOW_MAX_MS: 86_400_000,
    IP_MAX: 64,
    SF_BLOCK_MAX_AHEAD_MS: 24 * 60 * 60_000,
    SF_SYNC_MAX_ENTRIES: 10_000,
    SCHED_STRING_MAX: 64,
    SCHED_DETAIL_MAX: 2000,
    ACTOR_MAX: 200,
    ALERT_KEY_MAX: 300,
    NOTE_MAX: 2000,
    /** A metrics part larger than this (JSON bytes) counts as missing. */
    MAX_METRICS_PART_BYTES: 2 * 1024 * 1024,
    /** Rejected-message log throttle. */
    REJECT_LOG_GAP_MS: 60_000,
});

/** Error codes that make a worker boot failure fatal for the whole cluster. */
const BOOT_FATAL_ERROR_CODES = Object.freeze(["EADDRINUSE", "EACCES"]);

module.exports = {
    CLUSTER_IPC,
    BOOT_FATAL_ERROR_CODES,
    CLUSTER_RPC_TARGETS,
    CLUSTER_RPC_METHODS,
    CLUSTER_TOPICS,
    CLUSTER_RPC_ERROR_CODES,
    CLUSTER_RPC_TIMEOUTS,
    CLUSTER_RPC_LIMITS,
};
