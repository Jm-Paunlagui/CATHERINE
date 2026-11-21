

/**
 * @fileoverview Registers the worker-side RPC handlers and broadcast-topic
 * listeners on a `ClusterRpcClient`. Called once from the cluster-worker block
 * of `server.ts`. Stateless wiring, so a function.
 *
 * @author senior-nodejs-engineer
 */

import { CLUSTER_TOPICS, CLUSTER_RPC_METHODS } from "../../constants/clusterIpc";

/**
 * Heavy modules are required lazily inside the function: `server.ts` requires
 * this file in the primary too, and the primary must not load services.
 *
 * @param {object} deps
 * @param {import("./ClusterRpcClient").ClusterRpcClient} deps.client
 * @param {boolean} deps.isLeader - this worker is the cron leader
 * @returns {void}
 */
function wireWorkerRpc({ client, isLeader }: { client: import("./ClusterRpcClient").ClusterRpcClient; isLeader: boolean; }): void {

    // ── Metrics: every worker answers a gather with its mergeable snapshot ──
    const { metricsStore } = (require("../../middleware/metrics/MetricsStore") as typeof import("../../middleware/metrics/MetricsStore"));
    client.handle(CLUSTER_RPC_METHODS.METRICS_SNAPSHOT, () => metricsStore.getMergeableSnapshot());

    // ── Alert state, acks and status live on the cron leader only ───────────
    if (isLeader) {
        const AlertNotifierService = (require("../../services/AlertNotifierService") as typeof import("../../services/AlertNotifierService")).default;
        client.handle(CLUSTER_RPC_METHODS.ALERTS_ACK, ({ alertKey, ackedBy, note }) =>
            AlertNotifierService._acknowledgeLocal(alertKey, ackedBy, note),
        );
        client.handle(CLUSTER_RPC_METHODS.ALERTS_UNACK, ({ alertKey }) => AlertNotifierService._unacknowledgeLocal(alertKey));
        client.handle(CLUSTER_RPC_METHODS.ALERTS_STATUS, () => AlertNotifierService._getStatusLocal());
        client.handle(CLUSTER_RPC_METHODS.ALERTS_ACKS, () => AlertNotifierService._acksSnapshot());
    }

    // ── Recipient cache (an Access Control toggle on any worker) ────────────
    const RecipientResolver = (require("../../services/email/RecipientResolver") as typeof import("../../services/email/RecipientResolver")).default;
    client.onTopic(CLUSTER_TOPICS.RECIPIENTS_INVALIDATE, () => RecipientResolver.applyRemoteInvalidate());

    // ── Security filter (primary decides blocks, workers mirror them) ───────
    const { defaultSecurityFilter } = (require("../../middleware/security/SecurityFilterMiddleware") as typeof import("../../middleware/security/SecurityFilterMiddleware"));
    client.onTopic(CLUSTER_TOPICS.SF_BLOCK, ({ ip, blockedUntil }) => defaultSecurityFilter.applyRemoteBlock(ip, blockedUntil));
    client.onTopic(CLUSTER_TOPICS.SF_UNBLOCKED, ({ ip }) => defaultSecurityFilter.applyRemoteUnblock(ip));
    client.onTopic(CLUSTER_TOPICS.SF_SYNC, ({ blocks }) => defaultSecurityFilter.applySync(blocks));

    // ── Ended sessions (access-token revocation) ────────────────
    const AccessRevocationService = (require("../../services/AccessRevocationService") as typeof import("../../services/AccessRevocationService")).default;
    client.onTopic(CLUSTER_TOPICS.AUTH_REVOKED, ({ entries }) => AccessRevocationService.applyRemote(entries));
    client.onTopic(CLUSTER_TOPICS.AUTH_SYNC, ({ entries }) => AccessRevocationService.applyRemote(entries));

    // ── Scheduler state (leader broadcasts, everyone mirrors) ───────────────
    const SchedulerStateService = (require("../../services/SchedulerStateService") as typeof import("../../services/SchedulerStateService")).default;
    client.onTopic(CLUSTER_TOPICS.SCHED_STATE, ({ job, outcome }) => SchedulerStateService.applyRemote(job, outcome));
    client.onTopic(CLUSTER_TOPICS.SCHED_SYNC, ({ entries }) => SchedulerStateService.applySync(entries));
}

export { wireWorkerRpc };
