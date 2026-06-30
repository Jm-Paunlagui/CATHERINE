"use strict";

/**
 * @fileoverview ClusterRole — pure decision helpers for cluster process roles.
 *
 * WHAT THIS FILE DOES
 * -------------------
 * Encapsulates the two role decisions server.js makes when clustering is on,
 * as side-effect-free functions so they can be unit-tested without forking
 * real worker processes:
 *
 *   - isCronLeader()       — should THIS process run the scheduled jobs?
 *   - cronLeaderEnv()      — the env value the primary stamps onto a forked
 *                            worker to mark it as the cron leader.
 *
 * WHY A SEPARATE MODULE
 * ---------------------
 * Exactly ONE process must run the cron jobs. In single-process mode that is
 * the process itself; in cluster mode it is the one elected leader worker. The
 * decision is small but correctness-critical (N workers all firing the same
 * scheduled job would be N redundant sweeps), and server.js cannot be
 * unit-tested directly because requiring it boots an HTTP listener. Keeping
 * the rule here makes it provable in isolation.
 *
 * HOW TO USE
 * ----------
 * In server.js, when forking workers:
 *
 *   const { ClusterRole } = require("./src/utils/clusterRole");
 *
 *   // Primary: stamp the first worker as cron leader
 *   cluster.fork({ CRON_LEADER: ClusterRole.cronLeaderEnv(true) });
 *   cluster.fork({ CRON_LEADER: ClusterRole.cronLeaderEnv(false) });
 *
 *   // Worker: check if this process should schedule cron jobs
 *   const IS_CRON_LEADER = ClusterRole.isCronLeader({
 *     isWorker: cluster.isWorker,
 *     cronLeaderEnv: process.env.CRON_LEADER,
 *   });
 *
 * All functions are pure: same inputs → same output, no I/O, no globals.
 */

/** Env value marking a forked worker as the cron leader. */
const CRON_LEADER_TRUE = "true";
/** Env value marking a forked worker as a non-leader. */
const CRON_LEADER_FALSE = "false";

class ClusterRole {
    /**
     * Decides whether the current process should schedule the cron jobs.
     *
     * Rules:
     *   - Single-process mode (not a cluster worker): always the leader.
     *   - Cluster worker: leader only when its CRON_LEADER env is not the
     *     explicit string "false". The primary stamps exactly one worker with
     *     "true" at fork; every other worker gets "false".
     *
     * The "not false" (rather than "=== true") check is deliberate: if the env
     * is somehow unset on a worker, we fail OPEN to leader rather than silently
     * skipping the scheduled jobs on every worker — a missed sweep is worse
     * than a duplicated (idempotent) one.
     *
     * @param {object}  [opts]
     * @param {boolean} [opts.isWorker]      - cluster.isWorker for this process
     * @param {string}  [opts.cronLeaderEnv] - process.env.CRON_LEADER value
     * @returns {boolean}
     */
    static isCronLeader({ isWorker = false, cronLeaderEnv } = {}) {
        if (!isWorker) return true; // single-process / primary-as-worker
        return cronLeaderEnv !== CRON_LEADER_FALSE;
    }

    /**
     * The env value the primary passes to cluster.fork({ CRON_LEADER }) so a
     * freshly forked worker knows whether it is the elected leader.
     *
     * @param {boolean} isLeader
     * @returns {"true"|"false"}
     */
    static cronLeaderEnv(isLeader) {
        return isLeader ? CRON_LEADER_TRUE : CRON_LEADER_FALSE;
    }
}

module.exports = { ClusterRole, CRON_LEADER_TRUE, CRON_LEADER_FALSE };
