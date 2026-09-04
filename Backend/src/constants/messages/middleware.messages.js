"use strict";

/**
 * @fileoverview Security filter, rate limit, IP filter, CSRF log messages.
 * Used ONLY in logger calls — never thrown or sent to clients.
 */

const middlewareMessages = {
  IP_BLOCKED: (ip, path) => `IP blocked by filter: ${ip} on ${path}`,
  RATE_LIMIT_EXCEEDED: (ip, path, count, max) =>
    `Rate limit exceeded for ${ip} on ${path} (${count}/${max}).`,
  CSRF_TOKEN_GENERATED: (ip) => `CSRF token generated for ${ip}.`,
  CSRF_VALIDATION_FAILED: (ip, url) =>
    `CSRF validation failed for ${ip} on ${url}.`,
  SECURITY_FILTER_BLOCKED: (ip, method, path) =>
    `Security filter blocked ${method} ${path} from ${ip}.`,
  SUSPICIOUS_IP_TRACKED: (ip, count) =>
    `Suspicious IP tracked: ${ip} (${count} offenses).`,
  SUSPICIOUS_IP_BLOCKED: (ip, blockedUntil) =>
    `IP ${ip} blocked until ${blockedUntil}.`,
  CORS_ORIGIN_BLOCKED: (origin) => `CORS: origin blocked — ${origin}`,
  CSRF_TOKEN_REFRESHED: (userId) => `CSRF token refreshed for user ${userId}.`,
  CSRF_REFRESH_NO_SESSION: (userId) =>
    `CSRF refresh attempted without an existing cookie by user ${userId}.`,
  CSRF_REFRESH_FAILED: (userId) =>
    `Failed to refresh CSRF token for user ${userId}.`,
  // H-04 / H-05 / M-02 — SecurityFilterMiddleware structured message templates
  MALICIOUS_REQUEST_BLOCKED: (ip, method, path) =>
    `Security filter: malicious request blocked — ${method} ${path} from ${ip}.`,
  HTTP_METHOD_BLOCKED: (ip, method, path) =>
    `Security filter: HTTP method blocked — ${method} ${path} from ${ip}.`,
  IP_BLOCKED_SUSPICIOUS: (ip, method, path) =>
    `Security filter: request from blocked IP — ${method} ${path} from ${ip}.`,

  // ── Cluster cron-leader election (server.js primary process) ─────────────
  // ClusterRole.isCronLeader fails CLOSED (see src/utils/clusterRole.js);
  // these are the election-lifecycle templates the primary process uses so a
  // broken election is loud, never silent.
  CRON_LEADER_ELECTED: (workerId, pid, context) =>
    `Cron leader elected: worker id=${workerId} pid=${pid} (${context}).`,
  CRON_LEADER_NONE_ELECTED: (context) =>
    `CRITICAL: cluster has ZERO cron leader workers (${context}) — scheduled jobs will not run on ANY worker until a leader is elected.`,
  CRON_LEADER_MULTIPLE_ELECTED: (context, count) =>
    `CRITICAL: cluster has ${count} cron leader workers stamped CRON_LEADER=true (${context}) — scheduled jobs are not guaranteed idempotent, so duplicate leaders risk double-processing.`,
  CRON_LEADER_REFORK_FAILED: (deadWorkerId, reason) =>
    `CRITICAL: failed to fork a replacement for worker id=${deadWorkerId}: ${reason}. If that worker was the cron leader, the cluster now has NO cron leader.`,
  CRON_WORKER_DISCONNECTED: (pid, workerId) =>
    `Worker ${pid} disconnected (id=${workerId}) — awaiting exit before replacing.`,
  CRON_WORKER_EXITED: (pid, code, signal, wasCronLeader) =>
    `Worker ${pid} died (code=${code}, signal=${signal}) — replacing…` +
    (wasCronLeader
      ? " (was cron leader — replacement inherits leadership)"
      : ""),
};

module.exports = { middlewareMessages };
