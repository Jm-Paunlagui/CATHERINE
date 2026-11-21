"use strict";

/**
 * @fileoverview ClusterRole — pure decision helpers for cluster process roles.
 *
 * WHAT THIS FILE DOES
 * -------------------
 * Encapsulates the cron-leader election decisions server.js makes when
 * clustering is on, as side-effect-free functions so they can be
 * unit-tested without forking real worker processes:
 *
 *   - isCronLeader()    — should THIS process run the scheduled jobs?
 *   - cronLeaderEnv()   — the env value the primary stamps onto a forked
 *                         worker to mark it as the cron leader.
 *   - electionHealth()  — given the CRON_LEADER env currently stamped on
 *                         every LIVE worker, classifies whether the cluster
 *                         has exactly one leader (healthy) or zero / more
 *                         than one (critical). Pure — server.js decides what
 *                         to DO with the verdict (logger.crit).
 *
 * WHY A SEPARATE MODULE
 * ---------------------
 * Exactly ONE process must run the cron jobs. In single-process mode that is
 * the process itself; in cluster mode it is the one elected leader worker.
 * server.js cannot be unit-tested directly because requiring it boots an
 * HTTP listener, opens DB pools, and (with ENABLE_CLUSTERING=true) forks
 * real OS processes — so the decision logic lives here instead, provable in
 * isolation. All functions are pure: same inputs → same output, no I/O, no
 * globals. Election MECHANICS (the fork loop, the worker-exit handler,
 * calling logger.crit) stay in server.js; only the DECISIONS live here.
 *
 * FAIL CLOSED
 * -----------
 * isCronLeader() used to fail OPEN: a worker whose CRON_LEADER env was
 * missing/unset was treated as leader, on the theory that "a missed sweep is
 * worse than a duplicated (idempotent) one." That theory only holds when the
 * scheduled jobs are genuinely idempotent. Any job that MUTATES state
 * unconditionally on each tick (moves rows, deducts balances, sends a
 * notification, writes a file) is NOT safe to run N times — so N workers all
 * "failing open to leader" because no env was stamped would perform that
 * mutation N times, not once. A missed cron tick is recoverable (the boot
 * catch-up sweep + the cron-independent interval sweep in server.js retry
 * it); a duplicated state-mutating tick is not.
 *
 * isCronLeader() therefore fails CLOSED: a cluster worker is leader ONLY
 * when explicitly stamped CRON_LEADER === "true". Any other value —
 * "false", undefined, "", a typo — means NOT leader.
 *
 * Fail-closed alone would trade a duplication risk for a silent-starvation
 * risk (if the primary ever fails to stamp a leader, NO worker runs the
 * scheduled jobs, silently). That risk is closed on the server.js side, not
 * here: the primary verifies — via electionHealth() below — that exactly
 * one live worker is stamped leader at every fork and every worker exit,
 * and logs CRITICAL the instant that invariant breaks, and re-elects a
 * replacement leader the moment the leader worker dies. A zero-leader (or
 * multiple-leader) cluster is loud, not silent.
 *
 * ENABLE_CLUSTERING is 'false' by default (.env.example) — today this is
 * latent-risk hardening: isCronLeader({ isWorker: false, ... }) always
 * returns true regardless of this change (single-process mode has no
 * election to lose), so the default single-process deployment path is
 * provably unaffected. This only changes observable behavior once
 * ENABLE_CLUSTERING=true.
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
 */

/** Env value marking a forked worker as the cron leader. */
const CRON_LEADER_TRUE = "true";
/** Env value marking a forked worker as a non-leader. */
const CRON_LEADER_FALSE = "false";

class ClusterRole {
    /**
     * Decides whether the current process should schedule the cron jobs.
     *
     * Rules (fail CLOSED — see file header):
     *   - Single-process mode (not a cluster worker): always the leader —
     *     there is no election to lose in this mode.
     *   - Cluster worker: leader ONLY when its CRON_LEADER env is the exact
     *     string "true". The primary stamps exactly one live worker "true"
     *     at fork (and re-stamps a replacement the instant that worker
     *     dies — see server.js) and every other worker "false". A missing,
     *     empty, or malformed env is NOT leader.
     *
     * @param {object}  [opts]
     * @param {boolean} [opts.isWorker]      - cluster.isWorker for this process
     * @param {string}  [opts.cronLeaderEnv] - process.env.CRON_LEADER value
     * @returns {boolean}
     */
    static isCronLeader({ isWorker = false, cronLeaderEnv } = {}) {
        if (!isWorker) return true; // single-process / primary-as-worker
        return cronLeaderEnv === CRON_LEADER_TRUE;
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

    /**
     * Classifies cluster cron-leader election health from the CRON_LEADER
     * env value currently stamped on every LIVE worker. Pure: takes a
     * snapshot array, returns a verdict — never reads `cluster`, never logs.
     *
     * server.js calls this after the initial fork loop and after every
     * worker-exit re-election, and maps a "critical" severity onto
     * `logger.crit(...)`. This is what turns "the primary never stamped a
     * leader" or "two workers both ended up stamped leader" from a silent
     * bug into a loud one — the exact failure mode fail-closed elsewhere in
     * this module would otherwise reintroduce.
     *
     * @param {Array<string|undefined>} envs - CRON_LEADER value of every
     *   currently-live worker (one entry per worker; order irrelevant).
     * @returns {{leaderCount: number, healthy: boolean, severity: "ok"|"critical"}}
     *
     * @example
     *   ClusterRole.electionHealth(["true", "false", "false"]);
     *   // => { leaderCount: 1, healthy: true, severity: "ok" }
     *
     *   ClusterRole.electionHealth(["false", "false"]);
     *   // => { leaderCount: 0, healthy: false, severity: "critical" }
     *
     *   ClusterRole.electionHealth(["true", "true", "false"]);
     *   // => { leaderCount: 2, healthy: false, severity: "critical" }
     */
    static electionHealth(envs = []) {
        const leaderCount = envs.filter(
            (env) => env === CRON_LEADER_TRUE,
        ).length;
        return {
            leaderCount,
            healthy: leaderCount === 1,
            severity: leaderCount === 1 ? "ok" : "critical",
        };
    }
}

module.exports = { ClusterRole, CRON_LEADER_TRUE, CRON_LEADER_FALSE };
