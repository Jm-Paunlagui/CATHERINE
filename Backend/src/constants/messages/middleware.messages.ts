

/**
 * @fileoverview Security filter, rate limit, IP filter, CSRF log messages.
 * Used ONLY in logger calls — never thrown or sent to clients.
 */

const middlewareMessages = {
  IP_BLOCKED: (ip: any, path: any) => `IP blocked by filter: ${ip} on ${path}`,
  RATE_LIMIT_EXCEEDED: (ip: any, path: any, count: any, max: any) =>
    `Rate limit exceeded for ${ip} on ${path} (${count}/${max}).`,
  RATE_LIMIT_STORE_FULL: (label: any) =>
    `[${label}] Rate limit store is full - failing open (requests are admitted uncounted until entries expire).`,
  CSRF_TOKEN_GENERATED: (ip: any) => `CSRF token generated for ${ip}.`,
  CSRF_TOKEN_GENERATE_FAILED: (ip: any) =>
    `Failed to generate CSRF token for ${ip}.`,
  CSRF_VALIDATION_FAILED: (ip: any, url: any) =>
    `CSRF validation failed for ${ip} on ${url}.`,
  CSRF_VALIDATION_PASSED: (ip: any, url: any) =>
    `CSRF validation passed for ${ip} on ${url}.`,
  CSRF_STATUS_FAILED: (ip: any) => `Failed to retrieve CSRF status for ${ip}.`,
  SECURITY_FILTER_BLOCKED: (ip: any, method: any, path: any) =>
    `Security filter blocked ${method} ${path} from ${ip}.`,
  SUSPICIOUS_IP_TRACKED: (ip: any, count: any) =>
    `Suspicious IP tracked: ${ip} (${count} offenses).`,
  SUSPICIOUS_IP_BLOCKED: (ip: any, blockedUntil: any) =>
    `IP ${ip} blocked until ${blockedUntil}.`,
  SUSPICIOUS_IP_BLOCK_EXPIRED: (ip: any) =>
    `Suspicious-IP block expired for ${ip} — offence counter reset to 0.`,
  SUSPICIOUS_IP_UNBLOCKED: (ip: any, actor: any) =>
    `Suspicious-IP block manually cleared for ${ip} by ${actor}.`,
  CORS_ORIGIN_BLOCKED: (origin: any) => `CORS: origin blocked — ${origin}`,
  CSRF_TOKEN_REFRESHED: (userId: any) => `CSRF token refreshed for user ${userId}.`,
  CSRF_REFRESH_NO_SESSION: (userId: any) =>
    `CSRF refresh attempted without an existing cookie by user ${userId}.`,
  CSRF_REFRESH_FAILED: (userId: any) =>
    `Failed to refresh CSRF token for user ${userId}.`,
  // H-04 / H-05 / M-02 — SecurityFilterMiddleware structured message templates
  MALICIOUS_REQUEST_BLOCKED: (ip: any, method: any, path: any) =>
    `Security filter: malicious request blocked — ${method} ${path} from ${ip}.`,
  HTTP_METHOD_BLOCKED: (ip: any, method: any, path: any) =>
    `Security filter: HTTP method blocked — ${method} ${path} from ${ip}.`,
  IP_BLOCKED_SUSPICIOUS: (ip: any, method: any, path: any) =>
    `Security filter: request from blocked IP — ${method} ${path} from ${ip}.`,
  // CVE-2026-123864 guard — method, path (no query) and ip only; never header or body values.
  GET_BODY_REFUSED: (ip: any, method: any, path: any) =>
    `Security filter: ${method} with a request body refused — ${path} from ${ip}.`,

  // ── Cluster cron-leader election (server.ts primary process) ─────────────
  // ClusterRole.isCronLeader fails CLOSED (see src/utils/clusterRole.ts);
  // these are the election-lifecycle templates the primary process uses so a
  // broken election is loud, never silent.
  CRON_LEADER_ELECTED: (workerId: any, pid: any, context: any) =>
    `Cron leader elected: worker id=${workerId} pid=${pid} (${context}).`,
  CRON_LEADER_NONE_ELECTED: (context: any) =>
    `CRITICAL: cluster has ZERO cron leader workers (${context}) — scheduled jobs will not run on ANY worker until a leader is elected.`,
  CRON_LEADER_MULTIPLE_ELECTED: (context: any, count: any) =>
    `CRITICAL: cluster has ${count} cron leader workers stamped CRON_LEADER=true (${context}) — scheduled jobs are not guaranteed idempotent, so duplicate leaders risk double-processing.`,
  CRON_LEADER_REFORK_FAILED: (deadWorkerId: any, reason: any) =>
    `CRITICAL: failed to fork a replacement for worker id=${deadWorkerId}: ${reason}. If that worker was the cron leader, the cluster now has NO cron leader.`,
  CRON_WORKER_DISCONNECTED: (pid: any, workerId: any) =>
    `Worker ${pid} disconnected (id=${workerId}) — awaiting exit before replacing.`,
  CRON_WORKER_EXITED: (pid: any, code: any, signal: any, wasCronLeader: any) =>
    `Worker ${pid} died (code=${code}, signal=${signal}) — replacing…` +
    (wasCronLeader
      ? " (was cron leader — replacement inherits leadership)"
      : ""),
};

export { middlewareMessages };
