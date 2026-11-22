

import { logger } from "../utils/logger";
import { serverMessages } from "../constants/messages";

import { KNOWN_JOBS } from "../constants/schedulerJobs";
import { clusterRpc } from "../utils/cluster/ClusterRpcClient";
import { CLUSTER_RPC_METHODS } from "../constants/clusterIpc";

/**
 * @class SchedulerStateService
 * @description In-memory store for the last-run outcome of each scheduled job.
 *
 * CLUSTER MODE:
 *   Only the cron-leader worker runs the scheduled jobs. `record()` sets the
 *   local state and sends a `sched.record` notify to the primary, which keeps
 *   the latest copy per job and broadcasts it to the other workers (a new worker
 *   gets the whole snapshot when it starts listening). Reads stay local and
 *   synchronous, so every worker answers with the same snapshot, and the state
 *   survives a leader respawn. Single-process mode never touches IPC.
 *
 * Usage:
 *   SchedulerStateService.record("dbBackup", { label, status, detail, at })
 *   SchedulerStateService.snapshot() → { dbBackup, ...every KNOWN_JOBS key }
 */
/** A job's last-run outcome as reported by the scheduler or relayed from the leader. */
interface SchedulerOutcome {
    label: string;
    status: string;
    detail: string | null;
    at: string | Date;
}

/** The stored snapshot for one job. */
interface SchedulerJobState {
    job: string;
    label: string | undefined;
    status: string | undefined;
    detail: string | null;
    at: Date;
}

class SchedulerStateService {
    /**
     * Internal map keyed by job name. Initialised with null per known job so
     * snapshot() always returns a complete shape even before any job runs.
     * @type {Map<string, object|null>}
     */
    static #state: Map<string, SchedulerJobState | null> = new Map(KNOWN_JOBS.map((j: string) => [j, null]));

    /**
     * Records the last-run outcome for a scheduled job.
     * Overwrites any prior snapshot for that job — only the most recent run is kept.
     * Unknown job keys are silently warned and ignored (never throws).
     *
     * @param {string} job - One of KNOWN_JOBS (constants/schedulerJobs.js)
     * @param {object}  outcome
     * @param {string}  outcome.label     - Run label, e.g. 'cron' or 'boot-catchup'
     * @param {string}  outcome.status    - 'success' | 'skipped' | 'error'
     * @param {string}  [outcome.detail]  - Human-readable one-line summary
     * @param {Date}    [outcome.at]      - When the job fired (defaults to now)
     * @returns {void}
     *
     * @example
     * SchedulerStateService.record("dbBackup", {
     *   label: "interval-sweep",
     *   status: "success",
     *   detail: "Scheduled DB backup: 1 ran, 0 failed, 0 pruned.",
     * });
     */
    static record(
        job: string,
        { label, status, detail = null, at = new Date() }: { label?: string; status?: string; detail?: string | null; at?: Date; } = {},
    ): void {
        if (!KNOWN_JOBS.includes(job)) {
            logger.warning(serverMessages.SCHEDULER_UNKNOWN_JOB(job));
            return;
        }
        SchedulerStateService.#state.set(job, {
            job,
            label,
            status,
            detail,
            at,
        });
        logger.info(serverMessages.SCHEDULER_ACTIVITY_RECORDED(job, status));
        if (clusterRpc.active) {
            // JSON IPC: the Date travels as an ISO string and is revived on receipt.
            const atMs = at instanceof Date ? at.getTime() : new Date(at).getTime();
            clusterRpc.notify(CLUSTER_RPC_METHODS.SCHED_RECORD, {
                job,
                outcome: {
                    label: String(label ?? "").slice(0, 64),
                    status: String(status ?? "").slice(0, 64),
                    detail: detail == null ? null : String(detail).slice(0, 2000),
                    at: Number.isFinite(atMs) ? new Date(atMs).toISOString() : new Date().toISOString(),
                },
            });
        }
    }

    /**
     * Applies an outcome the leader broadcast through the primary (cluster
     * only). Local state only: never re-sent, never logged as a new run.
     *
     * @param {string} job
     * @param {{label: string, status: string, detail: string|null, at: string|Date}} outcome
     * @returns {boolean} applied
     */
    static applyRemote(job: string, outcome: SchedulerOutcome): boolean {
        if (!KNOWN_JOBS.includes(job) || !outcome) return false;
        SchedulerStateService.#state.set(job, {
            job,
            label: outcome.label,
            status: outcome.status,
            detail: outcome.detail ?? null,
            at: new Date(outcome.at),
        });
        return true;
    }

    /**
     * Applies the primary's full snapshot to a worker that just started. A local
     * entry that is newer than the snapshot's is kept.
     *
     * @param {Array<{job: string, outcome: object}>} entries
     * @returns {number} entries applied
     */
    static applySync(entries: Array<{ job: string; outcome: SchedulerOutcome; }>): number {
        let applied = 0;
        for (const { job, outcome } of entries ?? []) {
            const local = SchedulerStateService.#state.get(job);
            if (local && local.at instanceof Date && local.at.getTime() > new Date(outcome.at).getTime()) continue;
            if (SchedulerStateService.applyRemote(job, outcome)) applied++;
        }
        return applied;
    }

    /**
     * Returns a point-in-time snapshot of the last-run outcome for all tracked jobs.
     * Jobs that have never run in this process return null.
     *
     * @returns {Record<string, { job: string, label: string, status: string, detail: string|null, at: Date }|null>}
     *   one entry per KNOWN_JOBS key
     */
    static snapshot(): Record<string, SchedulerJobState | null> {
        return Object.fromEntries(SchedulerStateService.#state.entries());
    }
}

export type { SchedulerOutcome };
export default SchedulerStateService;
