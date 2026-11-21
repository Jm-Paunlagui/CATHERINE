

/**
 * @fileoverview Log message templates for the cluster primary
 * (`src/utils/cluster/ClusterSupervisor.ts`) and the worker IPC handlers in
 * server.ts. Used ONLY in logger.* calls.
 *
 * ⚠ `messages/index.js` spreads every namespace into ONE flat object — every
 * key here MUST carry the `CLUSTER_` prefix.
 */

const clusterMessages = {
    CLUSTER_PRIMARY_FORKING: (pid: any, numWorkers: any) =>
        `Primary process ${pid} — forking ${numWorkers} workers…`,

    /** Rate limiter + security-filter IP blocks are per worker. */
    CLUSTER_PER_WORKER_LIMITS: (numWorkers: any) =>
        `CLUSTER_PER_WORKER_LIMITS — rate limits and IP blocks are kept per worker; with round-robin the effective per-IP limit is up to limit x ${numWorkers} workers.`,

    CLUSTER_SHARED_STATE_READY: (numWorkers: any) =>
        `CLUSTER_SHARED_STATE_READY - rate limits, IP blocks, login lockout, scheduler state, metrics and alert acks are shared across ${numWorkers} workers via the primary.`,

    CLUSTER_RPC_REJECTED: (fromWorkerId: any, reason: any) =>
        `CLUSTER_RPC_REJECTED - dropped an invalid IPC message from worker ${fromWorkerId} (${reason}).`,

    CLUSTER_RL_FALLBACK: (label: any, reason: any) =>
        `CLUSTER_RL_FALLBACK - rate limiter "${label}" could not reach the primary (${reason}); counting locally (per-worker limit) until it recovers.`,

    CLUSTER_LOCKOUT_FALLBACK: (reason: any) =>
        `CLUSTER_LOCKOUT_FALLBACK - login lockout could not reach the primary (${reason}); using this worker's local lockout (per-worker threshold) until it recovers.`,

    CLUSTER_SF_UNBLOCK_DEGRADED: (ip: any, reason: any) =>
        `CLUSTER_SF_UNBLOCK_DEGRADED - unblock of ${ip} could not reach the primary (${reason}); cleared on this worker only.`,

    CLUSTER_METRICS_PARTIAL: (responded: any, expected: any, missing: any) =>
        `CLUSTER_METRICS_PARTIAL - metrics merged from ${responded}/${expected} workers (missing: ${missing.join(",") || "none"}).`,

    CLUSTER_RPC_HANDLER_FAILED: (method: any, err: any) =>
        `CLUSTER_RPC_HANDLER_FAILED - handler for ${method} failed: ${err}.`,

    CLUSTER_RESPAWN_SCHEDULED: (workerId: any, delayMs: any, wasLeader: any) =>
        `CLUSTER_RESPAWN_SCHEDULED — worker ${workerId} exited${wasLeader ? " (it was the cron leader)" : ""}; replacement forks in ${delayMs}ms.`,

    CLUSTER_CRASH_LOOP_TRIPPED: (exits: any, windowMs: any) =>
        `CLUSTER_CRASH_LOOP_TRIPPED — ${exits} worker exits within ${windowMs}ms; no more workers will be forked. The primary exits 1 once no worker is left so the service supervisor restarts it.`,

    CLUSTER_LEADERLESS_STOP: (liveCount: any) =>
        `CLUSTER_LEADERLESS_STOP — crash loop tripped and no cron leader is alive; stopping ${liveCount} remaining worker(s) gracefully, then exiting 1 so the service restarts the cluster (scheduled money jobs cannot run leaderless).`,

    CLUSTER_BOOT_FATAL: (workerId: any, code: any) =>
        `CLUSTER_BOOT_FATAL — worker ${workerId} cannot start (${code}); stopping the cluster without respawning.`,

    CLUSTER_SIGNAL_RECEIVED: (signal: any, liveCount: any) =>
        `${signal} received by the primary — stopping ${liveCount} worker(s) gracefully…`,

    CLUSTER_SHUTDOWN_COMPLETE: (exitCode: any) =>
        `CLUSTER_SHUTDOWN_COMPLETE — all workers exited; primary exiting with code ${exitCode}.`,

    CLUSTER_FORCED_KILL: (ms: any, liveCount: any) =>
        `CLUSTER_FORCED_KILL — ${liveCount} worker(s) still running ${ms}ms after the stop began; sending SIGKILL and exiting 1.`,

    CLUSTER_NO_WORKERS_LEFT: (exitCode: any) =>
        `CLUSTER_NO_WORKERS_LEFT — no live worker and respawning is disabled; primary exiting with code ${exitCode}.`,

    CLUSTER_CRIT_RELAY_DROPPED: (fromWorkerId: any, reason: any) =>
        `CLUSTER_CRIT_RELAY_DROPPED — critical log from worker ${fromWorkerId} could not be relayed to the cron leader (${reason}).`,

    CLUSTER_BOOT_FATAL_IGNORED: (workerId: any, code: any) =>
        `CLUSTER_BOOT_FATAL_IGNORED — worker ${workerId} reported ${code} after it was already listening; treated as a runtime fault, the cluster keeps running.`,

    CLUSTER_RELAY_INGEST_FAILED: (err: any) =>
        `CLUSTER_RELAY_INGEST_FAILED — relayed critical log could not be ingested: ${err}.`,

    CLUSTER_WORKER_BOOT_FATAL_SENT: (code: any) =>
        `CLUSTER_WORKER_BOOT_FATAL_SENT — reported ${code} to the primary.`,

    CLUSTER_PRIMARY_DISCONNECT: () =>
        "CLUSTER_PRIMARY_DISCONNECT — IPC channel to the primary closed; shutting down this worker gracefully.",
};

export { clusterMessages };
