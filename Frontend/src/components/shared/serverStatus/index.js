/**
 * index.js — Barrel for `src/components/shared/serverStatus/` (tier 3: the
 * banner is app-wide; HttpClient/SSE owners feed it via utils/serverStatus).
 */

export { serverStatusApi } from "./serverStatus.api";
export { useServerStatus, SERVER_STATUS_MESSAGES, SERVER_BANNER_EXIT_MS, checkNow, getProbeMeta, subscribeProbeMeta } from "./useServerStatus";
export { useServiceRecovery, serviceRecoveryNavigation } from "./useServiceRecovery";
export { useReadinessWatch, reportReadiness, READINESS_WATCH_MS } from "./useReadinessWatch";
export { useServerStatusStream, applyStatusFrame, HEARTBEAT_STALE_MS, STREAM_RETRY_AFTER_REFUSAL_MS } from "./useServerStatusStream";
export { ServerStatusWatch } from "./ServerStatusWatch";
export { ServerStatusBanner, default } from "./ServerStatusBanner";
