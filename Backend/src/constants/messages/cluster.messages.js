"use strict";

/**
 * @fileoverview Log message templates for the cluster primary
 * (`src/utils/cluster/ClusterSupervisor.js`) and the worker IPC handlers in
 * server.js. Used ONLY in logger.* calls.
 *
 * ⚠ `messages/index.js` spreads every namespace into ONE flat object — every
 * key here MUST carry the `CLUSTER_` prefix.
 */

const clusterMessages = {
    CLUSTER_PRIMARY_FORKING: (pid, numWorkers) =>
        `Primary process ${pid} — forking ${numWorkers} workers…`,

    /** Rate limiter + security-filter IP blocks are per worker. */
    CLUSTER_PER_WORKER_LIMITS: (numWorkers) =>
        `CLUSTER_PER_WORKER_LIMITS — rate limits and IP blocks are kept per worker; with round-robin the effective per-IP limit is up to limit x ${numWorkers} workers.`,

    CLUSTER_SHARED_STATE_READY: (numWorkers) =>
        `CLUSTER_SHARED_STATE_READY - rate limits, IP blocks, login lockout, scheduler state, metrics and alert acks are shared across ${numWorkers} workers via the primary.`,

    CLUSTER_RPC_REJECTED: (fromWorkerId, reason) =>
        `CLUSTER_RPC_REJECTED - dropped an invalid IPC message from worker ${fromWorkerId} (${reason}).`,

    CLUSTER_RL_FALLBACK: (label, reason) =>
        `CLUSTER_RL_FALLBACK - rate limiter "${label}" could not reach the primary (${reason}); counting locally (per-worker limit) until it recovers.`,

    CLUSTER_LOCKOUT_FALLBACK: (reason) =>
        `CLUSTER_LOCKOUT_FALLBACK - login lockout could not reach the primary (${reason}); using this worker's local lockout (per-worker threshold) until it recovers.`,

    CLUSTER_SF_UNBLOCK_DEGRADED: (ip, reason) =>
        `CLUSTER_SF_UNBLOCK_DEGRADED - unblock of ${ip} could not reach the primary (${reason}); cleared on this worker only.`,

    CLUSTER_METRICS_PARTIAL: (responded, expected, missing) =>
        `CLUSTER_METRICS_PARTIAL - metrics merged from ${responded}/${expected} workers (missing: ${missing.join(",") || "none"}).`,

    CLUSTER_RPC_HANDLER_FAILED: (method, err) =>
        `CLUSTER_RPC_HANDLER_FAILED - handler for ${method} failed: ${err}.`,

    CLUSTER_RESPAWN_SCHEDULED: (workerId, delayMs, wasLeader) =>
        `CLUSTER_RESPAWN_SCHEDULED — worker ${workerId} exited${wasLeader ? " (it was the cron leader)" : ""}; replacement forks in ${delayMs}ms.`,

    CLUSTER_CRASH_LOOP_TRIPPED: (exits, windowMs) =>
        `CLUSTER_CRASH_LOOP_TRIPPED — ${exits} worker exits within ${windowMs}ms; no more workers will be forked. The primary exits 1 once no worker is left so the service supervisor restarts it.`,

    CLUSTER_LEADERLESS_STOP: (liveCount) =>
        `CLUSTER_LEADERLESS_STOP — crash loop tripped and no cron leader is alive; stopping ${liveCount} remaining worker(s) gracefully, then exiting 1 so the service restarts the cluster (scheduled money jobs cannot run leaderless).`,

    CLUSTER_BOOT_FATAL: (workerId, code) =>
        `CLUSTER_BOOT_FATAL — worker ${workerId} cannot start (${code}); stopping the cluster without respawning.`,

    CLUSTER_SIGNAL_RECEIVED: (signal, liveCount) =>
        `${signal} received by the primary — stopping ${liveCount} worker(s) gracefully…`,

    CLUSTER_SHUTDOWN_COMPLETE: (exitCode) =>
        `CLUSTER_SHUTDOWN_COMPLETE — all workers exited; primary exiting with code ${exitCode}.`,

    CLUSTER_FORCED_KILL: (ms, liveCount) =>
        `CLUSTER_FORCED_KILL — ${liveCount} worker(s) still running ${ms}ms after the stop began; sending SIGKILL and exiting 1.`,

    CLUSTER_NO_WORKERS_LEFT: (exitCode) =>
        `CLUSTER_NO_WORKERS_LEFT — no live worker and respawning is disabled; primary exiting with code ${exitCode}.`,

    CLUSTER_CRIT_RELAY_DROPPED: (fromWorkerId, reason) =>
        `CLUSTER_CRIT_RELAY_DROPPED — critical log from worker ${fromWorkerId} could not be relayed to the cron leader (${reason}).`,

    CLUSTER_BOOT_FATAL_IGNORED: (workerId, code) =>
        `CLUSTER_BOOT_FATAL_IGNORED — worker ${workerId} reported ${code} after it was already listening; treated as a runtime fault, the cluster keeps running.`,

    CLUSTER_RELAY_INGEST_FAILED: (err) =>
        `CLUSTER_RELAY_INGEST_FAILED — relayed critical log could not be ingested: ${err}.`,

    CLUSTER_WORKER_BOOT_FATAL_SENT: (code) =>
        `CLUSTER_WORKER_BOOT_FATAL_SENT — reported ${code} to the primary.`,

    CLUSTER_PRIMARY_DISCONNECT: () =>
        "CLUSTER_PRIMARY_DISCONNECT — IPC channel to the primary closed; shutting down this worker gracefully.",
};

module.exports = { clusterMessages };
