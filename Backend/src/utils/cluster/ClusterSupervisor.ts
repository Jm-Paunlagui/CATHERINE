"use strict";

/**
 * @fileoverview Cluster primary lifecycle: fork, cron-leader election, respawn
 * with backoff and a crash-loop cap, boot-fatal handling, graceful stop of all
 * workers on SIGTERM/SIGINT/SIGBREAK with a bounded failsafe, and relay of
 * critical logs from non-leader workers to the cron leader.
 *
 * Election code (forkWorker / verifyLeaderInvariant / notifyLeaderInvariantBreach)
 * moved here verbatim from server.js; the pure verdict is still
 * `ClusterRole.electionHealth`.
 *
 * Stop sequence: stop respawning -> IPC SHUTDOWN to every live worker -> wait ->
 * exit with the highest worker exit code. Failsafe at forcedExitMs + marginMs:
 * SIGKILL what is left, bounded critical email, exit 1. The margin means a
 * worker's own failsafe (forcedExitMs) always fires first.
 *
 * Security: CWE-400 (fork storm bounded by backoff + crash-loop cap),
 * CWE-754 (every send/kill guarded), CWE-770 (relay is leader-only, capped by
 * the notifier's digest + hourly ceiling).
 *
 * Complexity: O(workers) per event; the crash window holds at most
 * CRASH_LOOP_MAX timestamps.
 *
 * @author senior-nodejs-engineer
 */

const crypto = require("crypto");
const { CLUSTER_IPC } = require("../../constants/clusterIpc");
const { SERVER_RUN_MARKER } = require("../../constants/serverRunMarker");
const { middlewareMessages } = require("../../constants/messages/middleware.messages");
const { clusterMessages } = require("../../constants/messages/cluster.messages");

class ClusterSupervisor {
    /** Exits within CRASH_LOOP_WINDOW_MS that trip the crash-loop cap. */
    static CRASH_LOOP_MAX = 5;
    static CRASH_LOOP_WINDOW_MS = 60_000;
    static BACKOFF_BASE_MS = 1000;
    static BACKOFF_MAX_MS = 30_000;
    /** Bound on the best-effort critical email sent from the failsafe. */
    static NOTIFY_BOUND_MS = 5000;
    static LOGGER_FLUSH_MS = 2000;
    static SIGNALS = Object.freeze(["SIGTERM", "SIGINT", "SIGBREAK"]);

    /** @type {Map<number, object>} live workers by id */
    #live = new Map();
    /** @type {Map<number, string>} worker.id -> "true" | "false" (CRON_LEADER env) */
    #workerLeaderEnv = new Map();
    /** @type {Map<ReturnType<typeof setTimeout>, boolean>} pending respawn timer -> wasLeader */
    #pendingRespawns = new Map();
    /** @type {Set<number>} workers that emitted `listening` (past boot) */
    #listening = new Set();
    #cronLeaderId = null;
    #stopping = false;
    #fatal = false;
    #maxExitCode = 0;
    #minExitCode = 0;
    /** @type {number[]} timestamps of recent worker exits */
    #exitTimes = [];
    #failsafeTimer = null;
    #started = false;
    #finished = false;

    /**
     * @param {object} deps
     * @param {import("cluster").Cluster} deps.cluster
     * @param {number} deps.numWorkers
     * @param {number} deps.forcedExitMs - Worker failsafe (already clamped).
     * @param {number} deps.marginMs - Added on top for the primary's own failsafe.
     * @param {object} deps.logger
     * @param {(message: string) => Promise<any>} deps.notifyCritical - Best-effort email; never relied on to resolve.
     * @param {{electionHealth: Function, cronLeaderEnv: Function}} deps.clusterRole
     * @param {NodeJS.EventEmitter & {exit: Function, pid?: number}} [deps.processRef=process]
     * @param {() => number} [deps.now=Date.now]
     * @param {import("./ClusterRpcHub").ClusterRpcHub} [deps.rpcHub] - Shared-state RPC router; absent = per-worker state notice only.
     * @param {string} [deps.runId] - Identity of THIS primary run, stamped on every fork as
     *   APP_CLUSTER_RUN_ID. A respawned cron leader reads the dead leader's restart marker
     *   with the same id and treats it as a handover, not an unclean restart.
     */
    constructor({
        cluster,
        numWorkers,
        forcedExitMs,
        marginMs,
        logger,
        notifyCritical,
        clusterRole,
        processRef = process,
        now = Date.now,
        rpcHub = null,
        runId = crypto.randomUUID(),
    }) {
        this._cluster = cluster;
        this._numWorkers = numWorkers;
        this._forcedExitMs = forcedExitMs;
        this._marginMs = marginMs;
        this._logger = logger;
        this._notifyCritical = notifyCritical;
        this._clusterRole = clusterRole;
        this._process = processRef;
        this._now = now;
        this._rpcHub = rpcHub;
        this._runId = runId;
    }

    /** @returns {boolean} a stop is in progress */
    get stopping() {
        return this.#stopping;
    }

    /** @returns {boolean} respawning is permanently disabled */
    get fatal() {
        return this.#fatal;
    }

    /** @returns {number} live worker count */
    get liveCount() {
        return this.#live.size;
    }

    /** @returns {object[]} live worker objects (snapshot array) */
    getLiveWorkers() {
        return [...this.#live.values()];
    }

    /** @returns {object|null} the live cron-leader worker, or null */
    getLeader() {
        return this.#live.get(this.#cronLeaderId) ?? null;
    }

    /**
     * Forks the workers, wires cluster events and process signals.
     * Idempotent.
     */
    start() {
        if (this.#started) return;
        this.#started = true;
        const log = this._logger;
        log.notice(clusterMessages.CLUSTER_PRIMARY_FORKING(this._process.pid, this._numWorkers));
        log.notice(
            this._rpcHub
                ? clusterMessages.CLUSTER_SHARED_STATE_READY(this._numWorkers)
                : clusterMessages.CLUSTER_PER_WORKER_LIMITS(this._numWorkers),
        );

        this._cluster.on("disconnect", (worker) => this._onDisconnect(worker));
        this._cluster.on("exit", (worker, code, signal) => this._onExit(worker, code, signal));
        this._cluster.on("listening", (worker) => {
            this.#listening.add(worker.id);
            this._rpcHub?.onWorkerListening(worker);
        });
        this._cluster.on("message", (worker, msg) => this._onMessage(worker, msg));
        for (const sig of ClusterSupervisor.SIGNALS) {
            this._process.on(sig, () => this.shutdown(sig));
        }

        this._forkWorker(true); // worker 1 carries the cron schedule
        for (let i = 1; i < this._numWorkers; i++) this._forkWorker(false);
        this._verifyLeaderInvariant("initial-fork");
    }

    /**
     * Graceful stop of the whole cluster (idempotent).
     *
     * @param {string} signal
     * @param {{minExitCode?: number}} [opts] - `minExitCode` 1 for fatal-driven stops.
     */
    shutdown(signal, { minExitCode = 0 } = {}) {
        this.#minExitCode = Math.max(this.#minExitCode, minExitCode);
        if (this.#stopping) return;
        this.#stopping = true;
        this._clearPendingRespawns();

        this._logger.notice(clusterMessages.CLUSTER_SIGNAL_RECEIVED(signal, this.#live.size));
        for (const worker of this.#live.values()) {
            this._send(worker, { cmd: CLUSTER_IPC.SHUTDOWN, signal });
        }
        if (this.#live.size === 0) {
            this._finish();
            return;
        }
        this._armFailsafe();
    }

    // ── Election (moved verbatim from server.js) ────────────────────────────

    _forkWorker(isCronLeader) {
        const env = this._clusterRole.cronLeaderEnv(isCronLeader);
        const worker = this._cluster.fork({ CRON_LEADER: env, [SERVER_RUN_MARKER.CLUSTER_RUN_ID_ENV]: this._runId });
        this.#live.set(worker.id, worker);
        this.#workerLeaderEnv.set(worker.id, env);
        if (isCronLeader) this.#cronLeaderId = worker.id;
        return worker;
    }

    /**
     * Emails a cron-leader invariant breach immediately. `logger.critical` alone is
     * not enough: the primary never starts AlertNotifierService, and "zero cron
     * leaders" is exactly when nobody is reading log files. Fire-and-forget with
     * a swallowed rejection — a failed notification must never crash the primary
     * or block forking.
     *
     * @param {string} message
     */
    _notifyLeaderInvariantBreach(message) {
        try {
            Promise.resolve(this._notifyCritical(message)).catch(() => {});
        } catch (_) {
            // Notification subsystem unavailable — the critical log still stands.
        }
    }

    /**
     * Verifies "exactly one cron leader" against the CURRENT live workers.
     * Skipped while a stop is in progress, after a fatal, and while a respawn
     * is pending — the leader slot is legitimately empty then and a critical
     * email would be a false alarm.
     *
     * @param {string} context
     * @returns {number|null} leader count, null when skipped
     */
    _verifyLeaderInvariant(context) {
        if (this.#stopping || this.#fatal || this.#pendingRespawns.size > 0) return null;
        const log = this._logger;
        const { leaderCount, severity } = this._clusterRole.electionHealth([...this.#workerLeaderEnv.values()]);
        if (severity !== "critical") {
            const leaderPid = this.#live.get(this.#cronLeaderId)?.process?.pid;
            log.notice(middlewareMessages.CRON_LEADER_ELECTED(this.#cronLeaderId, leaderPid, context));
        } else if (leaderCount === 0) {
            log.critical(middlewareMessages.CRON_LEADER_NONE_ELECTED(context));
            this._notifyLeaderInvariantBreach(middlewareMessages.CRON_LEADER_NONE_ELECTED(context));
        } else {
            log.critical(middlewareMessages.CRON_LEADER_MULTIPLE_ELECTED(context, leaderCount));
            this._notifyLeaderInvariantBreach(middlewareMessages.CRON_LEADER_MULTIPLE_ELECTED(context, leaderCount));
        }
        return leaderCount;
    }

    // ── Cluster events ──────────────────────────────────────────────────────

    /** Visibility only; the respawn always happens on "exit". */
    _onDisconnect(worker) {
        this._logger.warning(middlewareMessages.CRON_WORKER_DISCONNECTED(worker.process?.pid, worker.id));
    }

    _onExit(worker, code, signal) {
        const wasCronLeader = worker.id === this.#cronLeaderId;
        this.#live.delete(worker.id);
        this.#workerLeaderEnv.delete(worker.id);
        this.#listening.delete(worker.id);
        if (wasCronLeader) this.#cronLeaderId = null;
        // Fail pending RPCs aimed at it and run exit hooks.
        this._rpcHub?.onWorkerExit(worker);

        this._logger.warning(middlewareMessages.CRON_WORKER_EXITED(worker.process?.pid, code, signal, wasCronLeader));

        if (this.#stopping || this.#fatal) {
            // A worker killed by a signal (or with no code) counts as 1.
            this.#maxExitCode = Math.max(this.#maxExitCode, signal || typeof code !== "number" ? 1 : code);
            if (this.#live.size === 0) {
                if (this.#stopping) {
                    this._finish();
                } else {
                    this._finishNoWorkers();
                }
            } else if (this.#fatal && !this.#stopping && wasCronLeader) {
                // Crash loop tripped earlier with the leader still alive; now the
                // leader is gone and no fork will replace it. Siblings would serve
                // with zero cron leader (scheduled jobs silently stop).
                const leaderless = clusterMessages.CLUSTER_LEADERLESS_STOP(this.#live.size);
                this._logger.critical(leaderless);
                this._notifyLeaderInvariantBreach(leaderless);
                this.shutdown("LEADER_LOST", { minExitCode: 1 });
            }
            return;
        }

        const now = this._now();
        this.#exitTimes = this.#exitTimes.filter((t) => now - t < ClusterSupervisor.CRASH_LOOP_WINDOW_MS);
        this.#exitTimes.push(now);
        const recent = this.#exitTimes.length;

        if (recent >= ClusterSupervisor.CRASH_LOOP_MAX) {
            this._tripCrashLoop(recent);
            return;
        }

        const delayMs = Math.min(
            ClusterSupervisor.BACKOFF_BASE_MS * 2 ** (recent - 1),
            ClusterSupervisor.BACKOFF_MAX_MS,
        );
        this._logger.warning(clusterMessages.CLUSTER_RESPAWN_SCHEDULED(worker.id, delayMs, wasCronLeader));
        const timer = setTimeout(() => {
            this.#pendingRespawns.delete(timer);
            if (this.#stopping || this.#fatal) return;
            try {
                this._forkWorker(wasCronLeader);
            } catch (err) {
                // The slot could not be replaced at all. If it was the cron
                // leader the cluster has zero leaders until the next retry.
                this._logger.critical(middlewareMessages.CRON_LEADER_REFORK_FAILED(worker.id, err.message));
            }
            this._verifyLeaderInvariant(`exit:${worker.id}`);
        }, delayMs);
        this.#pendingRespawns.set(timer, wasCronLeader);
    }

    _tripCrashLoop(exits) {
        this.#fatal = true;
        this._clearPendingRespawns();
        const message = clusterMessages.CLUSTER_CRASH_LOOP_TRIPPED(exits, ClusterSupervisor.CRASH_LOOP_WINDOW_MS);
        this._logger.critical(message);
        this._notifyLeaderInvariantBreach(message);
        if (this.#live.size === 0) {
            this._finishNoWorkers();
        } else if (!this.#live.has(this.#cronLeaderId)) {
            // No cron leader left and none will be forked: scheduled jobs
            // would silently stop. Stop the siblings gracefully and
            // exit 1 so the service supervisor restarts the whole cluster.
            this._logger.critical(clusterMessages.CLUSTER_LEADERLESS_STOP(this.#live.size));
            this.shutdown("CRASH_LOOP", { minExitCode: 1 });
        }
        // else: a leader is still alive - keep serving, no forks.
    }

    /**
     * @param {object} worker
     * @param {*} msg
     */
    _onMessage(worker, msg) {
        if (!msg || typeof msg !== "object") return;
        if (this._rpcHub?.handleMessage(worker, msg)) return;
        if (msg.cmd === CLUSTER_IPC.BOOT_FATAL) {
            this._onBootFatal(worker, msg.code);
        } else if (msg.cmd === CLUSTER_IPC.CRIT_RELAY) {
            this._relayCritical(worker, msg);
        }
    }

    /** A worker cannot start (PFX missing, port taken): stop everything, no fork storm. Ignored once the worker has emitted `listening`. */
    _onBootFatal(worker, code) {
        if (this.#fatal) return;
        if (this.#listening.has(worker.id)) {
            // Already serving: not a boot failure (a runtime EACCES in one worker).
            this._logger.warning(clusterMessages.CLUSTER_BOOT_FATAL_IGNORED(worker.id, String(code ?? "unknown")));
            return;
        }
        this.#fatal = true;
        this._clearPendingRespawns();
        const message = clusterMessages.CLUSTER_BOOT_FATAL(worker.id, String(code ?? "unknown"));
        this._logger.critical(message);
        this._notifyLeaderInvariantBreach(message);
        this.shutdown("BOOT_FATAL", { minExitCode: 1 });
    }

    /** Forwards a non-leader worker's critical log to the current cron leader. */
    _relayCritical(fromWorker, msg) {
        if (this.#stopping) return;
        const leader = this.#live.get(this.#cronLeaderId);
        if (!leader || leader.id === fromWorker.id) {
            this._logger.warning(
                clusterMessages.CLUSTER_CRIT_RELAY_DROPPED(fromWorker.id, leader ? "sender is the leader" : "no leader"),
            );
            return;
        }
        if (!this._send(leader, { cmd: CLUSTER_IPC.CRIT_RELAY, record: msg.record })) {
            this._logger.warning(clusterMessages.CLUSTER_CRIT_RELAY_DROPPED(fromWorker.id, "leader unreachable"));
        }
    }

    // ── Stop plumbing ───────────────────────────────────────────────────────

    _clearPendingRespawns() {
        for (const timer of this.#pendingRespawns.keys()) clearTimeout(timer);
        this.#pendingRespawns.clear();
    }

    /** @returns {boolean} whether the send was attempted without throwing */
    _send(worker, message) {
        try {
            worker.send(message);
            return true;
        } catch {
            // Worker already gone — its exit event follows.
            return false;
        }
    }

    _armFailsafe() {
        const ms = this._forcedExitMs + this._marginMs;
        this.#failsafeTimer = setTimeout(() => this._forceExit(ms), ms);
        // Not unref'd: the primary must stay alive until the failsafe or the
        // last worker exit.
    }

    /** Failsafe: SIGKILL what is left, bounded critical email, exit 1. */
    async _forceExit(ms) {
        if (this.#finished) return;
        this.#finished = true;
        const log = this._logger;
        const message = clusterMessages.CLUSTER_FORCED_KILL(ms, this.#live.size);
        log.error(message);
        for (const worker of this.#live.values()) {
            try {
                worker.process?.kill("SIGKILL");
            } catch {
                // already dead
            }
        }
        let bound;
        try {
            await Promise.race([
                Promise.resolve(this._notifyCritical(message)).catch(() => {}),
                new Promise((resolve) => {
                    bound = setTimeout(resolve, ClusterSupervisor.NOTIFY_BOUND_MS);
                }),
            ]);
        } catch {
            // never block the exit
        }
        clearTimeout(bound);
        this._exit(1);
    }

    /** All workers gone during a stop: exit with the highest code. */
    _finish() {
        if (this.#finished) return;
        this.#finished = true;
        if (this.#failsafeTimer) clearTimeout(this.#failsafeTimer);
        const code = Math.max(this.#maxExitCode, this.#minExitCode);
        this._logger.notice(clusterMessages.CLUSTER_SHUTDOWN_COMPLETE(code));
        this._exit(code);
    }

    /** Respawning disabled (crash loop / boot fatal) and nothing live: exit 1. */
    _finishNoWorkers() {
        if (this.#finished) return;
        this.#finished = true;
        if (this.#failsafeTimer) clearTimeout(this.#failsafeTimer);
        this._logger.critical(clusterMessages.CLUSTER_NO_WORKERS_LEFT(1));
        this._exit(1);
    }

    _exit(code) {
        Promise.resolve(this._logger.flush?.(ClusterSupervisor.LOGGER_FLUSH_MS))
            .catch(() => {})
            .finally(() => this._process.exit(code));
    }
}

module.exports = { ClusterSupervisor };
