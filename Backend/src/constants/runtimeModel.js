"use strict";

/**
 * @fileoverview Hand-authored source of truth for the Runtime page
 * (Support → Runtime, SUPER_ADMIN only): how the server runs — boot, cluster
 * roles, schedulers, backups, watchdogs, rate limits,
 * alerting, crash handling and graceful shutdown.
 *
 * Plain data, validated by `src/utils/systemMap.js` (same builder as
 * `architectureModel.js`). The builder is meant to reject the map
 * when a `Backend/...` path here no longer exists or a flow step has
 * no edge. Bump MAP_VERIFIED_AT when re-checking against `server.js` and
 * CLAUDE.md "Resilience & Graceful Shutdown".
 */

const MAP_VERIFIED_AT = "2026-10-26";

const API = "Backend/";
const S = (f) => `${API}src/services/${f}`;
const M = (f) => `${API}src/models/${f}`;
const U = (f) => `${API}src/utils/${f}`;
const MW = (f) => `${API}src/middleware/${f}`;
const SERVER = `${API}server.js`;

const layers = [
    { id: "trigger", label: "Triggers", color: "#f59e0b", description: "What sets the server in motion: the Windows service manager, OS signals, the clock, HTTP clients and faults." },
    { id: "process", label: "Processes", color: "#38bdf8", description: "Boot, the cluster primary, HTTP workers, the cron-leader role and the primary-owned shared state." },
    { id: "schedule", label: "Schedulers & jobs", color: "#fb923c", description: "Everything that runs on a timer: scheduled backups, log retention, the alert poll. Projects add their own jobs here." },
    { id: "guard", label: "Guards & limits", color: "#a78bfa", description: "What stops one bad request, job or dependency from taking the server down." },
    { id: "lifecycle", label: "Shutdown & crash", color: "#f87171", description: "Graceful stop, the forced-exit failsafe and crash handling, in teardown order." },
    { id: "observe", label: "Observability", color: "#2dd4bf", description: "Logs, metrics, health probes and the alert emails they drive." },
    { id: "resource", label: "Resources", color: "#f472b6", description: "What the runtime holds and touches: Oracle pools, tables, the backup directory, log files, SMTP." },
];

const edgeKinds = {
    signal: { label: "Signal / exit code", color: "#f87171" },
    schedule: { label: "Scheduled trigger", color: "#fb923c" },
    call: { label: "In-process call", color: "#94a3b8" },
    ipc: { label: "Cluster IPC", color: "#c084fc" },
    http: { label: "HTTP", color: "#38bdf8" },
    sse: { label: "Server-Sent Events", color: "#e879f9" },
    log: { label: "Log event", color: "#2dd4bf" },
    sql: { label: "Oracle", color: "#fbbf24" },
    fs: { label: "Filesystem", color: "#a3e635" },
    smtp: { label: "SMTP", color: "#f472b6" },
};

const nodes = [
    // ── Triggers ─────────────────────────────────────────────────────────────
    { id: "trg.winsw", layer: "trigger", label: "WinSW service", sub: "start · stop · restart", description: "Runs backend.exe as a Windows service. Restarts it on a non-zero exit (onfailure restart). <stoptimeout> 1860 s must stay above the forced-exit failsafe; <preshutdown> gives a host reboot 5 min (WinSW v3 only).", files: [`${API}deploy/winsw/catherine-backend-service.xml`, `${API}deploy/winsw/README.md`] },
    { id: "trg.signal", layer: "trigger", label: "OS signals", sub: "SIGTERM · SIGINT · SIGBREAK", description: "A stop request. On Windows Ctrl+C maps to SIGINT and Ctrl+Break to SIGBREAK (SIGTERM never fires there), so all three start the same graceful shutdown. A second signal is ignored.", files: [SERVER] },
    { id: "trg.clock", layer: "trigger", label: "Clock", sub: "cron · sweeps · exact timers", description: "node-cron 06:00 (process local time = APP_TZ (default Asia/Manila), pinned at the top of server.js — node-cron has no timezone option here, PKG ships small-icu), cron-independent 15-min setInterval sweeps a cron tick can silently never fire under PKG), and exact-time timers armed by the schedulers.", files: [SERVER] },
    { id: "trg.http", layer: "trigger", label: "HTTP clients", sub: "browser · SSE · probes", description: "Every inbound request and held-open SSE stream; also the WinSW / load-balancer health probes.", files: [`${API}src/app.js`] },
    { id: "trg.fault", layer: "trigger", label: "Faults", sub: "uncaught · unhandled · EADDRINUSE", description: "An uncaught exception, an unhandled promise rejection, or a listen error such as a port already in use.", files: [SERVER] },

    // ── Processes ────────────────────────────────────────────────────────────
    { id: "proc.boot", layer: "process", label: "Boot sequence", sub: "polyfill · dotenv · bootGuard", description: "encodingPolyfill first (PKG), .env resolved beside the exe, TZ pinned, then validateSecrets (production: weak/placeholder secrets, DEMO_MODE=true, unset CORS_ORIGINS, invalid MONEY_* config → BOOT GUARD banner, exit 1). A missing HTTPS PFX is a [FATAL] line + exit 1. The port is never bound in any of these.", files: [SERVER, `${API}src/config/bootGuard.js`, U("encodingPolyfill.js")] },
    { id: "proc.primary", layer: "process", label: "Cluster primary", sub: "ClusterSupervisor", description: "ENABLE_CLUSTERING=true only. Supervises — no pools, no HTTP. Forks NUM_WORKERS, respawns with backoff 1→30 s, elects one cron leader, trips a crash-loop cap (5 exits / 60 s), stops leaderless clusters with exit 1, forwards stop signals over IPC.", files: [U("cluster/ClusterSupervisor.js"), U("clusterRole.js"), `${API}src/constants/clusterIpc.js`] },
    { id: "proc.worker", layer: "process", label: "HTTP worker", sub: "server.js → app.js", description: "Initialises the Oracle pools (then reloads the session families ended within the access-token lifetime, so a restart does not revive a signed-out token), serves app.js through the 13-step middleware chain, and installs the server-level request listeners (watchdog, in-flight tracker). In single-process mode it is the only process and always the cron leader. Request intake: Brotli bodies 415; a gzip body with extra bytes after the compressed data no longer crashes it (body-parser 2.4.0); multipart field-name index max 100 on every upload route (multer); client address from proxy-addr 2.0.8 with trust proxy from TRUST_PROXY (deployed as off or a hop count, never a subnet) and compression 1.8.2.", files: [U("consoleManager.js"), SERVER, `${API}src/app.js`, `${API}src/config/database.js`] },
    { id: "proc.leader", layer: "process", label: "Cron leader", sub: "CRON_LEADER=true", description: "The one worker that runs scheduled work: AlertNotifier (started before pool init so a pool-init failure is caught), log retention and the DB-backup scheduler. On its death the replacement inherits leadership.", files: [U("clusterRole.js"), SERVER] },
    { id: "proc.rpc", layer: "process", label: "Shared state (RPC)", sub: "ClusterRpcHub · PrimaryStateServices", description: "Primary-owned state workers query over validated IPC: rate-limit counters, login-lockout counters, ended session families (access-token revocation), security-filter strikes and blocks, scheduler state, merged metrics, recipient-cache invalidation. Single-process mode registers no IPC listener at all.", files: [U("cluster/workerRpcWiring.js"), U("cluster/ClusterRpcHub.js"), U("cluster/ClusterRpcClient.js"), U("cluster/PrimaryStateServices.js"), U("cluster/ipcSchemas.js")] },

    // ── Schedulers & jobs ────────────────────────────────────────────────────
    { id: "sch.backup", layer: "schedule", label: "DB-backup scheduler", sub: "_scheduleDbBackup", description: "Its own exact-time timers fire DB_BACKUP_EVENT_DELAY_MS (15 min) after a scheduled backup event; a 15-min sweep and boot catch-up back it up. triggerScheduledBackup is idempotent when nothing is due. Re-arms whatever the outcome.", files: [SERVER, S("BackupScheduleService.js"), S("BackupEmailService.js")] },
    { id: "sch.logret", layer: "schedule", label: "Log retention", sub: "LogRetentionService", description: "Leader only, outside the pool-init chain so a DB outage cannot suspend it. Checks every 15 min whether today was swept; deletes logs/YYYY/MM/DD day folders older than LOG_RETENTION_DAYS (90). Today and yesterday can never be deleted.", files: [S("LogRetentionService.js")] },
    { id: "sch.alertpoll", layer: "schedule", label: "Alert poll", sub: "AlertNotifierService.start", description: "A plain setInterval (never node-cron) calling MetricsService.evaluateAlerts every ALERT_POLL_INTERVAL_MS (60 s); Emails on FIRED / ESCALATED, re-notifies a still-firing alert every ALERT_EMAIL_COOLDOWN_MIN (30 min) unless acked, RESOLVED after 3 clear polls. Off unless ENABLE_SERVER_NOTIFICATIONS=true.", files: [S("AlertNotifierService.js"), S("MetricsService.js")] },

    // ── Guards & limits ──────────────────────────────────────────────────────
    { id: "grd.reqwd", layer: "guard", label: "Request watchdog", sub: "RequestWatchdog · IdleWatchdog", description: "One ProgressScope per request. Progress = a finished or in-flight DB call (up to 30 min), SMTP steps, BatchGuard items, socket bytes, explicit touch(). Idle past 120 s (10 min on LONG routes, floor 65 s) → scope aborted, 504 RequestStalledError, later DB calls refused. SSE streams exempt.", files: [U("progress/RequestWatchdog.js"), U("progress/IdleWatchdog.js"), U("progress/ProgressScope.js"), U("progress/progress.js"), `${API}src/constants/requestWatchdog.js`] },
    { id: "grd.burst", layer: "guard", label: "Stall-burst detector", sub: "WatchdogBurstDetector", description: "One cut sends no email; WATCHDOG_ALERT_BURST (3) cuts within 10 min emit ONE critical WATCHDOG_BURST_ALERT naming the top routes and last-progress sources. Per process.", files: [U("progress/WatchdogBurstDetector.js")] },
    { id: "grd.backupwd", layer: "guard", label: "Backup watchdog + lease", sub: "runGuarded · FileLease", description: "A backup idle for DB_BACKUP_IDLE_TIMEOUT_MS (10 min) is cancelled and nothing is published (no .zip, no .part). Cross-process exclusion is .backup-run.lease (atomic create, token-checked release, heartbeat only while progressing, stale holders stealable).", files: [S("BackupStoreService.js"), U("locks/FileLease.js")] },
    { id: "grd.pool", layer: "guard", label: "Pool health + breaker", sub: "PoolHealthMonitor · withConnection", description: "Periodic health checks (30 s; 5 s while any pool fails or a /health/stream client watches; a connectivity error in withConnection nudges an immediate check); 3 consecutive failures mark a pool UNHEALTHY (critical log) and open the circuit breaker, which fails fast with 503 instead of queueing on a dead pool. A full acquire queue (NJS-076) is load-shed as 429 PoolOverloadedError.", files: [`${API}src/config/adapters/oracle.js`, MW("errorHandling/NjsCode.js")] },
    { id: "grd.rate", layer: "guard", label: "Rate limiter", sub: "sliding window · step 12", description: "Sliding-window counter per IP; the 429 carries RateLimitExceeded, Retry-After (the real earliest admit time) and RateLimit-* headers. Health probes are exempt. Auth routes use four route-level limiters instead of one shared bucket: failed sign-ins per IP (ceiling) and per IP+user, refreshes per session family, password changes per user. Clustered: counted on the primary so the limit is cluster-wide (falls open to per-worker if the primary is slow); successful sign-ins are refunded via rl.refund.", files: [MW("security/RateLimiterMiddleware.js"), MW("security/SlidingWindowCounter.js"), MW("security/authRateLimiters.js")] },
    { id: "grd.secf", layer: "guard", label: "Security filter", sub: "strikes → IP block · step 2", description: "Scanner-style requests count as strikes; enough strikes block the IP (403 ForbiddenError, even on health routes) until the block expires or an admin unblocks it. Clustered: strikes on the primary, blocks mirrored to every worker.", files: [MW("security/SecurityFilterMiddleware.js"), MW("security/SuspiciousIpTracker.js")] },
    { id: "grd.batch", layer: "guard", label: "BatchGuard", sub: "bounded concurrency · retry budget", description: "Runs batch items with a RetryPolicy each; once the retryBudget constructor option is spent on failing items, remaining items go PENDING (BATCH_BUDGET_EXHAUSTED) instead of hammering a failing database.", files: [U("concurrency.js"), U("resilience/index.js"), U("resilience/BatchGuard.js"), U("resilience/RetryPolicy.js")] },
    { id: "grd.resign", layer: "guard", label: "Restore verify-then-sign", sub: "DataRestoreService._verifyThenSign", description: "Every restored row of a table with a rowHashDomain has its ORIGINAL ROW_HASH verified over its original values before it is re-signed over the new PK / FKs. Invalid or NULL → restored with ROW_HASH NULL, TAMPER_DETECTED (table + original PK), counted in tamperedRowsRestoredUnsigned; the restore does not fail. canonicalTimestampColumns are read back as the FF6 string before signing.", files: [S("DataRestoreService.js"), `${API}src/constants/purgeTables.js`] },

    // ── Shutdown & crash ─────────────────────────────────────────────────────
    { id: "lc.marker", layer: "lifecycle", label: "Restart marker", sub: "ServerRunMarker · server-run.json", description: "Cron leader only. Boot verdict first (read the previous record: FIRST_BOOT / CLEAN / UNCLEAN / UNREADABLE / HANDOVER; a forced exit or crash is recorded STOPPED with exit code 1, so it is not UNCLEAN), then start(): RUNNING + 30 s heartbeat (unref'd). gracefulShutdown writes STOPPING after armFailsafe; the failsafe records FORCED_EXIT first; a synchronous process.on('exit') hook writes STOPPED + exit code + reason on every process.exit (no logger calls inside it; registered only in start()). Writes are atomic, followed by a best-effort fsync, and never throw. noteStopUnreported() records a crash / forced-exit email that was not sent (the next started notice says so and is not throttled); a cron-leader loss whose email failed is kept as pendingLeaderLost and re-sent by a later boot.", files: [U("lifecycle/ServerRunMarker.js"), `${API}src/constants/serverRunMarker.js`, SERVER] },
    { id: "lc.shutdown", layer: "lifecycle", label: "gracefulShutdown", sub: "isShuttingDown · single entry", description: "The one stop path for signals, IPC SHUTDOWN and crashes. Sets isShuttingDown, arms the failsafe FIRST (crash: min(FORCED_EXIT_MS, 44 s)), fires an early detached audit flush, stops the alert poller and its retention sweep (the critical tap stays live) and the log retention sweep, sends the 'shutdown started' email (requested stops only; a crash already sent EMERGENCY), then hands over to the teardown sequence — which drains live SSE streams and waits for in-flight requests. Buffered criticals: phase 1 (flushForShutdown, before the drain) only SAVES their SERVER_ALERT_LOG rows (EMAIL_STATUS SKIPPED + note, save-first); they are emailed in phase 2 (drainAndStop, email only) after the pools close and before the transporter closes.", files: [SERVER, U("shutdown/TeardownSequence.js")] },
    { id: "lc.failsafe", layer: "lifecycle", label: "Forced-exit failsafe", sub: "FORCED_EXIT_MS ≤ 1 834 000", description: "30 min wait + 15 s drain + 13 s reserve + 6 s margin. SHUTDOWN_FORCED_EXIT_MS may only lower it (min 35 s). Crash schedule 10+15+13+6 = 44 s; on fire the forced-exit email and the final critical flush run in parallel. If teardown is still running when it fires: 'Forced shutdown after timeout', forced-exit email, exit 1.", files: [SERVER] },
    { id: "lc.inflight", layer: "lifecycle", label: "In-flight wait", sub: "HttpInFlightTracker", description: "New connections refused at once; a request that still reaches the app gets 503 ServerShuttingDown + Retry-After 5 (ShutdownGateMiddleware) and /health/ready answers 503 draining; open responses marked Connection: close; requests that keep making progress may finish (cap 30 min); idle ones are cut by the watchdog. Periodic SHUTDOWN_WAITING notices name the count and oldest request. Nothing in flight → exits in about a second.", files: [U("shutdown/HttpInFlightTracker.js"), U("shutdown/TeardownSequence.js"), `${API}src/middleware/security/ShutdownGateMiddleware.js`, `${API}src/constants/shutdownGate.js`] },
    { id: "lc.sse", layer: "lifecycle", label: "SSE drain", sub: "SseConnectionRegistry", description: "Before server.close(), every live stream on every SSE surface gets a terminal `event: shutdown` frame and is ended, so connected dashboards never hold the process open.", files: [U("sse/SseConnectionRegistry.js")] },
    { id: "lc.drain", layer: "lifecycle", label: "Notify drain", sub: "InFlightTaskRegistry", description: "Waits (NOTIFY_DRAIN_MS, only when something is pending) for tracked background tasks — alert-log writes / in-flight alert digests and any project-registered task — before the pools close.", files: [U("InFlightTaskRegistry.js")] },
    { id: "lc.audit", layer: "lifecycle", label: "Audit flush", sub: "AuditLogService.flushPending", description: "Single-flight batch writer. Early non-final detached flush at stop; final flush waits ≤ 2 s for a running one, then one 2 s attempt. Failed batches are requeued at the front (cap 1000).", files: [S("AuditLogService.js")] },
    { id: "lc.close", layer: "lifecycle", label: "Close & exit", sub: "pools · transporter · exit code", description: "Closes the Oracle pools, marks the restart marker STOPPED (before any further wait), then waits for the shutdown emails and the final critical-digest flush (phase 2), which run concurrently, closes the mail transporter, logs 'All resources cleaned up.', and exits: 0 for a clean stop, 1 for a crash, a forced exit or a cluster failure — which is what makes WinSW restart.", files: [SERVER, `${API}src/config/database.js`] },
    { id: "lc.crash", layer: "lifecycle", label: "Crash handler", sub: "[FATAL] · grace 10 s · exit 1", description: "uncaughtException / unhandledRejection: [FATAL] on stderr, an EMERGENCY email that bypasses the hourly ceiling, then gracefulShutdown(sig, 1) with in-flight requests given at most CRASH_REQUEST_GRACE_MS (10 s). A fresh crash arms the failsafe at the crash schedule (10 s grace + 15 s drain + 13 s reserve + 6 s margin = 44 s, or FORCED_EXIT_MS if lower); a crash during a stop pulls it in to 44 s from the moment the crash reaches gracefulShutdown (after the EMERGENCY email, ≤ 5 s).", files: [SERVER] },

    // ── Observability ────────────────────────────────────────────────────────
    { id: "obs.logger", layer: "observe", label: "Logger", sub: "RFC 5424 · redaction · queue cap", description: "Daily-rotated files with millisecond timestamps. User identifiers and emails are redacted before writing. The write queue is capped (LOG_MAX_QUEUE_LENGTH 10 000): on overflow the OLDEST entries drop and the loss is reported, never silent. Critical levels feed the alert tap.", files: [`${API}src/constants/messages/`, U("logger.js"), U("logRedaction.js")] },
    { id: "obs.metrics", layer: "observe", label: "Metrics", sub: "MetricsStore · MetricsService", description: "RED metrics per route, pool saturation, watchdog cuts. Alert rules: HIGH_ERROR_RATE (5-min window, 50-sample floor), HIGH_LATENCY (5-min window), ORACLE_POOL_DEGRADED / DOWN. Clustered: merged across workers through the primary.", files: [MW("metrics/MetricsStore.js"), MW("metrics/metricsMerge.js"), S("MetricsService.js")] },
    { id: "obs.notifier", layer: "observe", label: "Alert notifier", sub: "AlertNotifierService", description: "Owns all email dedup and throttling. Critical-log tap: events buffered for CRITICAL_DIGEST_WINDOW_MS (30 s) into one digest, CRITICAL_MAX_EMAILS_PER_HOUR (10) ceiling; EMERGENCY bypasses it. Acks silence re-notify for 24 h, cleared on escalation or recovery.", files: [S("AlertNotifierService.js"), S("email/ServerNotificationService.js")] },
    { id: "obs.relay", layer: "observe", label: "Critical relay", sub: "critRelay", description: "Clustered: a critical log on a non-leader worker is relayed to the leader's notifier, so one process owns digests and caps.", files: [U("cluster/critRelay.js")] },
    { id: "obs.sched", layer: "observe", label: "Scheduler state", sub: "SchedulerStateService", description: "Records every scheduled job run (see schedulerJobs.js) for the scheduler activity view; mirrored to every worker through the primary.", files: [S("SchedulerStateService.js"), `${API}src/constants/schedulerJobs.js`] },
    { id: "obs.health", layer: "observe", label: "Health probes", sub: "/health/live · /ready · /", description: "/live is always 200 with the pid. /ready is 503 until every pool (appDb, appDbBulk; a saturated appDbBulk still counts as up) answers AND every circuit breaker is closed (a successful probe closes the breaker), and never leaks ORA-/NJS- text. While the server drains /ready answers 503 ServerShuttingDown with data {ready:false, draining:true} at once, without probing the pools; the shutdown gate lets /health* through. /ready carries Retry-After (shared constant with the gate), and the legacy GET / answers 200 with database 'draining' and no pool call. The UI's reachability probe reads only /ready: 200 = healthy, 503 ServerShuttingDown = restarting, 503 ServiceUnavailableError / data.ready false = the database is down, no API envelope or a network error = the server is down. Every response carries X-Request-Id (23 chars) and X-Response-Time.", files: [`${API}src/routes/health.route.js`, `${API}src/services/ReadinessService.js`, `${API}src/services/HealthStreamHub.js`] },
    { id: "obs.startmail", layer: "observe", label: "Startup notifier", sub: "StartupNotifier", description: "After db.initializePools() settles (success or failure, so DB opt-in recipients resolve; tracked in InFlightTaskRegistry) the leader sends ONE boot email through notifyLifecycleNow: UNCLEAN = CRITICAL 'Server restarted without a clean shutdown' (last-alive time, downtime, never throttled; logged at error, not critical, so the tap does not double it); otherwise 'Server started' (NOTICE, WARNING after a non-zero exit or unreadable marker), skipped inside 15 min of the last one. HANDOVER sends nothing unless the previous leader was still RUNNING (a lost cron leader: one WARNING, re-sent by a later boot if that send failed). The boot email waits for the pools at most 10 s (then recipients fall back to SERVER_NOTIFY_TO), and a started notice after a crash or forced exit whose email was never sent says so instead of 'reported when it happened' and is not throttled. Sent with persist, so a WARNING/CRITICAL boot email also writes SERVER_ALERT_LOG FIRED rows (Alert History) once the send settles; NOTICE and the shutdown emails stay email-only and their footer names the server logs only. The 15-minute skip never applies once a shutdown, crash or forced-exit email has gone out since the last started notice (announcedStopSince), so every announced stop is followed by a started email.", files: [U("lifecycle/StartupNotifier.js"), `${API}src/constants/serverRunMarker.js`] },
    { id: "obs.shutdownmail", layer: "observe", label: "Shutdown notifier", sub: "ShutdownNotifier", description: "Three lifecycle emails, each bounded at 5 s: shutdown started (WARNING, states the wait rule), requests cut (CRITICAL, route templates only), forced exit (CRITICAL).", files: [U("shutdown/ShutdownNotifier.js")] },

    // ── Resources ────────────────────────────────────────────────────────────
    { id: "res.pools", layer: "resource", label: "Oracle pools", sub: "appDb · appDbBulk", description: "appDb (interactive), appDbBulk (exports, purge, restore, backup — same credentials, small on purpose). Pools are per worker.", files: [`${API}src/config/database.js`] },
    { id: "res.db", layer: "resource", label: "App tables", sub: "audit · alerts", description: "T_AUDIT_LOGS_DEV (audit flush) and T_SERVER_ALERT_LOG_DEV / T_SERVER_ALERT_ACK_DEV (alert history). Projects add their own job tables here." },
    { id: "res.backupdir", layer: "resource", label: "Backup directory", sub: ".zip · .part · .backup-run.lease", description: "DB_BACKUP_DIR: signed backup archives, in-progress .part files (swept by the next lease holder) and the cross-process lease file." },
    { id: "res.marker", layer: "resource", label: "Run marker file", sub: "data/server-run.json", description: "Beside the exe under pkg (dist\\data\\), gitignored. Runtime state: never stage it from the build machine, never delete it on the server (that skips one unclean-restart check). SERVER_RUN_MARKER_PATH (absolute, tests/sim only) redirects it." },
    { id: "res.logs", layer: "resource", label: "Log files", sub: "logs/YYYY/MM/DD/", description: "RFC 5424 level files per day." },
    { id: "res.smtp", layer: "resource", label: "SMTP relay", sub: "SharedTransporter", description: "Every alert, lifecycle and backup email.", files: [S("email/SharedTransporter.js"), S("email/EmailProtectionService.js")] },
];

// [source, target, kind, label]
const E = [
    // triggers → processes
    ["trg.winsw", "proc.boot", "signal", "start / restart"],
    ["trg.winsw", "trg.signal", "signal", "service stop"],
    ["trg.signal", "lc.shutdown", "signal", "single process"],
    ["trg.signal", "proc.primary", "signal", "clustered"],
    ["trg.fault", "lc.crash", "signal", "uncaught / unhandled"],
    ["trg.http", "proc.worker", "http", "requests"],
    ["trg.clock", "sch.backup", "schedule", "timers +15 min · sweep"],
    ["trg.clock", "sch.logret", "schedule", "15-min check"],
    ["trg.clock", "sch.alertpoll", "schedule", "60 s poll"],
    // processes
    ["proc.boot", "trg.winsw", "signal", "guard refuses → exit 1"],
    ["proc.boot", "proc.worker", "call", "single-process"],
    ["proc.boot", "proc.primary", "call", "ENABLE_CLUSTERING"],
    ["proc.primary", "proc.worker", "ipc", "fork / respawn"],
    ["proc.primary", "proc.leader", "ipc", "elect leader"],
    ["proc.primary", "proc.rpc", "call", "hosts"],
    ["proc.primary", "lc.shutdown", "ipc", "SHUTDOWN to workers"],
    ["proc.primary", "trg.winsw", "signal", "exit code"],
    ["proc.worker", "proc.rpc", "ipc", "RPC client"],
    ["proc.worker", "res.pools", "sql", "init 3 pools"],
    ["proc.worker", "obs.health", "call", "serves"],
    ["proc.worker", "proc.leader", "call", "is leader?"],
    ["proc.worker", "grd.secf", "call", "step 2"],
    ["proc.worker", "grd.rate", "call", "step 12"],
    ["proc.worker", "grd.reqwd", "call", "scope per request"],
    ["proc.worker", "grd.pool", "call", "withConnection"],
    ["proc.worker", "obs.logger", "log", "app logs"],
    ["proc.worker", "grd.resign", "call", "data restore"],
    ["proc.leader", "sch.alertpoll", "call", "start (before pools)"],
    ["proc.leader", "sch.logret", "call", "start"],
    ["proc.leader", "sch.backup", "call", "schedule"],
    ["proc.leader", "lc.marker", "call", "read previous record, then start"],
    // schedulers
    ["sch.backup", "grd.backupwd", "call", "runBackup"],
    ["sch.backup", "res.smtp", "smtp", "backup email"],
    ["sch.backup", "obs.sched", "call", "record dbBackup"],
    ["sch.logret", "res.logs", "fs", "delete > 90 days"],
    ["sch.alertpoll", "obs.metrics", "call", "evaluateAlerts"],
    ["sch.alertpoll", "obs.notifier", "call", "transitions"],
    // guards
    ["grd.reqwd", "res.pools", "sql", "DB call = progress"],
    ["grd.reqwd", "trg.http", "http", "504 RequestStalled"],
    ["grd.reqwd", "grd.burst", "call", "each cut"],
    ["grd.burst", "obs.logger", "log", "WATCHDOG_BURST_ALERT"],
    ["grd.backupwd", "res.backupdir", "fs", "lease · .part · .zip"],
    ["grd.backupwd", "res.pools", "sql", "stream (appDbBulk)"],
    ["grd.backupwd", "obs.logger", "log", "BACKUP_WATCHDOG_CANCELLED"],
    ["grd.pool", "res.pools", "sql", "health check"],
    ["grd.pool", "obs.logger", "log", "UNHEALTHY"],
    ["grd.pool", "obs.metrics", "call", "pool status"],
    ["grd.pool", "trg.http", "http", "503 breaker · 429 shed"],
    ["grd.rate", "proc.rpc", "ipc", "rl.hit · rl.refund"],
    ["grd.rate", "trg.http", "http", "429 + Retry-After"],
    ["grd.secf", "proc.rpc", "ipc", "sf.strike / sf.block"],
    ["grd.secf", "trg.http", "http", "403 blocked"],
    ["grd.secf", "obs.logger", "log", "IP blocked until"],
    ["grd.batch", "res.pools", "sql", "retry per item"],
    ["grd.resign", "res.db", "sql", "verify original ROW_HASH · re-sign or NULL"],
    ["grd.resign", "obs.logger", "log", "TAMPER_DETECTED"],
    // lifecycle
    ["lc.crash", "obs.notifier", "call", "EMERGENCY"],
    ["lc.crash", "lc.shutdown", "call", "exit code 1 · grace 10 s"],
    ["lc.shutdown", "lc.failsafe", "call", "armed first"],
    ["lc.shutdown", "lc.marker", "call", "STOPPING (after the failsafe is armed)"],
    ["lc.shutdown", "sch.alertpoll", "call", "stop poll (tap stays)"],
    ["lc.shutdown", "sch.logret", "call", "stop"],
    ["lc.shutdown", "lc.audit", "call", "early flush"],
    ["lc.shutdown", "obs.shutdownmail", "call", "started"],
    ["lc.shutdown", "lc.inflight", "call", "teardown"],
    ["lc.inflight", "lc.sse", "call", "end streams"],
    ["lc.inflight", "grd.reqwd", "call", "idle limit decides"],
    ["lc.inflight", "obs.shutdownmail", "call", "requests cut"],
    ["lc.inflight", "lc.drain", "call", "then drain"],
    ["lc.sse", "trg.http", "sse", "event: shutdown"],
    ["lc.drain", "lc.audit", "call", "final flush"],
    ["lc.drain", "lc.close", "call", "close"],
    ["lc.audit", "res.db", "sql", "T_AUDIT_LOGS"],
    ["lc.close", "res.pools", "sql", "pool.close()"],
    ["lc.close", "obs.notifier", "call", "criticals: save rows before drain · email after pool close, concurrent with the lifecycle emails"],
    ["lc.failsafe", "obs.notifier", "call", "final critical flush"],
    ["lc.close", "trg.winsw", "signal", "exit 0 / 1"],
    ["lc.failsafe", "obs.shutdownmail", "call", "forced exit"],
    ["lc.failsafe", "lc.marker", "call", "FORCED_EXIT (first statement)"],
    ["lc.close", "lc.marker", "call", "STOPPED once records are saved and pools closed"],
    ["lc.crash", "lc.marker", "call", "noteExitCodeRaised(1) before the EMERGENCY email"],
    ["lc.marker", "res.marker", "fs", "RUNNING · 30 s heartbeat · STOPPING · STOPPED (data teardown, then exit hook)"],
    ["lc.marker", "obs.startmail", "call", "boot verdict"],
    ["obs.startmail", "obs.notifier", "call", "notifyLifecycleNow (after pool init)"],
    ["lc.failsafe", "trg.winsw", "signal", "exit 1"],
    // observability
    ["obs.logger", "res.logs", "fs", "write queue"],
    ["obs.logger", "obs.notifier", "log", "critical tap"],
    ["obs.logger", "obs.relay", "log", "non-leader critical"],
    ["obs.relay", "obs.notifier", "ipc", "to leader"],
    ["obs.notifier", "res.smtp", "smtp", "digest / alerts"],
    ["obs.notifier", "res.db", "sql", "SERVER_ALERT_LOG rows (Alert History)"],
    ["obs.metrics", "proc.rpc", "ipc", "cluster merge"],
    ["obs.sched", "proc.rpc", "ipc", "mirror"],
    ["obs.health", "res.pools", "sql", "ready probe"],
    ["obs.shutdownmail", "obs.notifier", "call", "notifyLifecycleNow"],
];

// Flow steps: [from, to, action, detail]. `ref` = server-simulation stage(s).
const flows = [
    {
        id: "boot", name: "Boot and readiness", category: "Boot", ref: "server.js",
        summary: "From service start to a serving process — and the four ways boot refuses to start.",
        steps: [
            ["trg.winsw", "proc.boot", "Service starts backend.exe", "encodingPolyfill loads first (PKG); .env is resolved beside the exe, wherever the service started it."],
            ["proc.boot", "trg.winsw", "Boot guard refuses", "Boot guard (secrets/DEMO_MODE/CORS_ORIGINS/MONEY_*) → BOOT GUARD banner names the variable, exit 1; missing PFX → [FATAL] + exit 1. Port in use is NOT this path — it is the crash handler (see flow Crash and restart)."],
            ["proc.boot", "proc.worker", "Start the HTTP worker", "Single-process mode; with ENABLE_CLUSTERING the primary forks workers instead."],
            ["proc.worker", "obs.health", "Listening", "'Server listening on …' notice; /health/live 200 with the pid."],
            ["proc.worker", "proc.leader", "Am I the cron leader?", "Always yes in single-process mode."],
            ["proc.leader", "sch.alertpoll", "Notifier starts before pools", "So a pool-init failure's critical log is already caught."],
            ["proc.worker", "res.pools", "Initialise the pools", "appDb, appDbBulk. A failure is a critical log + alert, not a crash."],
            ["obs.health", "res.pools", "Readiness", "/health/ready 503 until every pool answers and every breaker is closed; /health/stream pushes {ready, cause}; no ORA-/NJS- text in the body."],
        ],
    },
    {
        id: "leader-schedules", name: "Leader arms the schedulers", category: "Scheduling", ref: "server.js",
        summary: "Exactly one process owns scheduled work. What it starts, and why each runs on its own timer.",
        steps: [
            ["proc.primary", "proc.leader", "Elect the cron leader", "Clustered: CRON_LEADER=true on one worker ('Cron leader elected …'). Single-process: the only process."],
            ["proc.leader", "sch.alertpoll", "Alert notifier", "'AlertNotifierService started — polling metrics every …'."],
            ["proc.leader", "sch.logret", "Log retention", "Outside the pool chain — a DB outage must not stop it."],
            ["proc.leader", "sch.backup", "DB-backup scheduler", "Skipped entirely when DB_BACKUP_ENABLED=false."],
        ],
    },
    {
        id: "scheduled-backup", name: "Scheduled backup with watchdog", category: "Backup", ref: "server.js",
        summary: "A backup that hangs is cancelled and publishes nothing; a healthy one writes exactly one archive.",
        steps: [
            ["trg.clock", "sch.backup", "Backup due", "Exact timer (backup event + 15 min), 15-min sweep, or boot catch-up. Idempotent when nothing is due."],
            ["sch.backup", "grd.backupwd", "runBackup under the watchdog", "runGuarded with DB_BACKUP_IDLE_TIMEOUT_MS (10 min, floor 65 s)."],
            ["grd.backupwd", "res.backupdir", "Take the lease", ".backup-run.lease, atomic create; stale .part files from a dead holder are swept."],
            ["grd.backupwd", "res.pools", "Stream every table", "appDbBulk, READ ONLY. Each batch is progress and keeps the lease heartbeat fresh."],
            ["grd.backupwd", "obs.logger", "Hung → cancelled", "No progress for the idle limit: BACKUP_WATCHDOG_CANCELLED (critical for a scheduled run); no .zip, no .part, lease released."],
            ["grd.backupwd", "res.backupdir", "Healthy → publish", "Rename .part to .zip — exactly one archive."],
            ["sch.backup", "res.smtp", "Backup email", "To CAN_RECEIVE_DB_BACKUP admins."],
            ["sch.backup", "obs.sched", "Record dbBackup", ""],
        ],
    },
    {
        id: "db-outage", name: "Database outage", category: "Resilience", ref: "server.js",
        summary: "Pool-init failure, health checks, the circuit breaker and load-shedding, and the alerts they raise.",
        steps: [
            ["proc.worker", "res.pools", "Pool init fails", "'Failed to initialize pool …' (critical) per pool; '3/3 pool(s) failed' warning. The server keeps running."],
            ["obs.logger", "obs.notifier", "Critical tap", "The pool-init critical lines become one alert email."],
            ["grd.pool", "res.pools", "Health checks fail", "Consecutive failures 1, 2, 3 logged as warnings."],
            ["grd.pool", "obs.logger", "Pool marked UNHEALTHY", "Critical log after 3 failures; breaker opens."],
            ["sch.alertpoll", "obs.metrics", "Poll sees pool state", "ORACLE_POOL_DEGRADED (warning) / ORACLE_POOL_DOWN (critical)."],
            ["obs.notifier", "res.smtp", "Alert emails", "On the transition only; RESOLVED after 3 clear polls."],
            ["proc.worker", "grd.pool", "Request needs a connection", ""],
            ["grd.pool", "trg.http", "Fail fast", "Breaker open → 503 in milliseconds instead of queueing; full acquire queue → 429 PoolOverloadedError (GETs retried by the frontend)."],
        ],
    },
    {
        id: "critical-storm", name: "Critical alert storm", category: "Alerting", ref: "server.js",
        summary: "A burst of critical events becomes one email; an hourly ceiling caps the rest; emergencies always get through.",
        steps: [
            ["obs.logger", "obs.notifier", "Critical events arrive", "Buffered for CRITICAL_DIGEST_WINDOW_MS (30 s)."],
            ["obs.notifier", "res.smtp", "One digest", "'N critical events in …' — the body names up to 200 events (CRITICAL_BUFFER_MAX); any beyond are counted ('not itemised')."],
            ["obs.notifier", "res.smtp", "Hourly ceiling", "Past CRITICAL_MAX_EMAILS_PER_HOUR (10) windows are counted, not sent; the next digest reports how many were suppressed."],
            ["obs.logger", "obs.relay", "Clustered: other workers", "A non-leader's critical log is relayed…"],
            ["obs.relay", "obs.notifier", "…to the leader", "One process owns the digest and the ceiling."],
            ["lc.crash", "obs.notifier", "EMERGENCY bypasses the cap", "A crash is always mailed."],
        ],
    },
    {
        id: "crash", name: "Crash and restart", category: "Shutdown & crash", ref: "server.js",
        summary: "An uncaught exception or unhandled rejection: EMERGENCY email (≤ 5 s), in-progress requests get at most 10 s, then drain/flush/close and exit 1, so the service manager restarts it.",
        steps: [
            ["trg.fault", "lc.crash", "Uncaught exception / unhandled rejection", "'[FATAL] …' on stderr."],
            ["lc.crash", "obs.notifier", "EMERGENCY email", "Bypasses the hourly ceiling."],
            ["obs.notifier", "res.smtp", "Send", ""],
            ["lc.crash", "lc.shutdown", "gracefulShutdown(sig, 1)", "A crash during a stop only shortens the wait — never extends it."],
            ["lc.shutdown", "lc.failsafe", "Failsafe armed", "Fresh crash: min(FORCED_EXIT_MS, 44 s). A crash during a running stop is pulled in to the same by shortenForCrash."],
            ["lc.shutdown", "lc.inflight", "Crash grace", "In-progress requests get at most CRASH_REQUEST_GRACE_MS (10 s)."],
            ["lc.drain", "lc.close", "Close", ""],
            ["lc.close", "trg.winsw", "Exit 1", "It used to exit 0, so WinSW never restarted a crashed service."],
            ["trg.winsw", "proc.boot", "Restart", "A recurring boot fault means a restart loop with one EMERGENCY email per restart — an accepted trade-off."],
        ],
    },
    {
        id: "graceful-stop", name: "Graceful stop", category: "Shutdown & crash", ref: "server.js",
        summary: "New requests refused at once; requests that keep making progress may finish (up to 30 min); idle ones are cut; exit 0.",
        steps: [
            ["trg.winsw", "trg.signal", "Service stop", "Or Ctrl+C / SIGTERM; a second signal is ignored (one banner)."],
            ["trg.signal", "lc.shutdown", "'SIGINT / SIGBREAK received — shutting down gracefully…' (SIGTERM off Windows)", ""],
            ["lc.shutdown", "lc.failsafe", "Arm the failsafe first", "So a throw later in teardown can never leave the process without one."],
            ["lc.shutdown", "lc.audit", "Early audit flush", "Detached, non-final — buffered rows persist before the long wait."],
            ["lc.shutdown", "obs.shutdownmail", "'Shutdown started' email", "States the wait rule."],
            ["obs.shutdownmail", "obs.notifier", "Deliver (≤ 5 s)", ""],
            ["lc.shutdown", "lc.inflight", "Refuse new connections", "Open responses marked Connection: close."],
            ["lc.inflight", "lc.sse", "End SSE streams", "Before server.close()."],
            ["lc.sse", "trg.http", "event: shutdown", "data: {\"reason\":\"server_shutdown\"}, then the stream ends."],
            ["lc.inflight", "grd.reqwd", "Wait while requests progress", "Up to 30 min; SHUTDOWN_WAITING notices name the count and the oldest request."],
            ["lc.inflight", "obs.shutdownmail", "Idle request cut", "Watchdog limit passed during the stop → 'stopped making progress' email with the route template."],
            ["lc.inflight", "lc.drain", "Drain background tasks", "Tracked tasks, pending emails. Just before, phase 1 only SAVES buffered critical alerts' rows (EMAIL_STATUS SKIPPED); they are emailed in phase 2, after the pools close."],
            ["lc.drain", "lc.audit", "Final audit flush", "≤ 2 s."],
            ["lc.drain", "lc.close", "Close pools + transporter", "'HTTP server closed.' Final critical flush (email only) between pool close and transporter close, then 'All resources cleaned up.'"],
            ["lc.close", "res.pools", "pool.close()", "Dead databases still exit within seconds."],
            ["lc.close", "trg.winsw", "Exit 0", "Nothing in flight → about a second end to end."],
        ],
    },
    {
        id: "failsafe", name: "Shutdown failsafe", category: "Shutdown & crash", ref: "server.js",
        summary: "When teardown itself hangs, the failsafe ends the process, mails it, and exits 1.",
        steps: [
            ["trg.signal", "lc.shutdown", "Stop requested", ""],
            ["lc.shutdown", "lc.failsafe", "Failsafe armed", "FORCED_EXIT_MS (default and maximum 1 834 s)."],
            ["lc.drain", "lc.close", "Teardown hangs", "e.g. a tracked task that never settles, or a pool close that never resolves."],
            ["lc.failsafe", "obs.shutdownmail", "'Shutdown hung — forced exit' email", "'Forced shutdown after timeout' logged at error."],
            ["lc.failsafe", "obs.notifier", "Final critical flush", "In parallel with the forced-exit email, email only, ≤ 5 s."],
            ["lc.failsafe", "trg.winsw", "Exit 1", "WinSW <stoptimeout> 1860 s sits above the failsafe so the email always goes first."],
        ],
    },
    {
        id: "request-watchdog", name: "Request watchdog", category: "Resilience", ref: "server.js",
        summary: "A request is cut only when it stops making progress — slow-but-busy work (a 20-min bulk import) is never timed out.",
        steps: [
            ["trg.http", "proc.worker", "Request arrives", ""],
            ["proc.worker", "grd.reqwd", "Open a progress scope", "Limit 120 s, or 10 min on LONG routes (exports, issuance, purge, uploads)."],
            ["grd.reqwd", "res.pools", "DB calls are progress", "In-flight calls count too, up to 30 min. So do socket bytes, SMTP steps and touch()."],
            ["grd.reqwd", "trg.http", "Idle past the limit → 504", "RequestStalledError; later DB calls refused; an explicit transaction rolls back. Logged at ERROR, not mailed."],
            ["grd.reqwd", "grd.burst", "Count the cut", ""],
            ["grd.burst", "obs.logger", "3 cuts in 10 min", "ONE critical WATCHDOG_BURST_ALERT with the top routes."],
            ["obs.logger", "obs.notifier", "Critical tap", ""],
            ["obs.notifier", "res.smtp", "One email", "The process keeps serving throughout."],
        ],
    },
    {
        id: "abuse-limits", name: "Rate limit and security filter", category: "Resilience", ref: "server.js",
        summary: "Scanners get blocked, floods get 429 with Retry-After, health probes stay exempt.",
        steps: [
            ["trg.http", "proc.worker", "Request", ""],
            ["proc.worker", "grd.secf", "Security filter (step 2)", "Scanner patterns, traversal, script injection count as strikes."],
            ["grd.secf", "proc.rpc", "Clustered: strike on the primary", "A new block is broadcast to every worker's mirror."],
            ["grd.secf", "obs.logger", "'IP … blocked until …'", "Warning."],
            ["grd.secf", "trg.http", "403 ForbiddenError", "Even on health routes; still carries a 23-char X-Request-Id."],
            ["proc.worker", "grd.rate", "Rate limiter (step 12)", "Sliding window per IP (auth routes: per IP+user / session family / user); health probes exempt."],
            ["grd.rate", "proc.rpc", "Clustered: cluster-wide count", "Falls open to per-worker counting if the primary is slow."],
            ["grd.rate", "trg.http", "429 RateLimitExceeded", "RateLimit-Limit / -Remaining / -Policy and Retry-After."],
        ],
    },
    {
        id: "logging", name: "Logging under pressure", category: "Alerting", ref: "server.js",
        summary: "Personal data never reaches a log file in clear text; an overflowing log queue drops the oldest entries and says so.",
        steps: [
            ["proc.worker", "obs.logger", "App writes a log line", "Including request query strings."],
            ["obs.logger", "res.logs", "Redact, queue, write", "User identifiers and emails masked; queue capped at LOG_MAX_QUEUE_LENGTH."],
            ["obs.logger", "res.logs", "Overflow is reported", "'Log write queue overflowed — N oldest entries DROPPED' written straight to the log file at CRIT once the disk catches up — it bypasses the onLevel tap, so no email; the server keeps answering."],
            ["trg.clock", "sch.logret", "Daily retention check", "Every 15 min: has today been swept?"],
            ["sch.logret", "res.logs", "Delete old day folders", "Older than LOG_RETENTION_DAYS (90); today and yesterday never."],
        ],
    },
    {
        id: "cluster-lifecycle", name: "Cluster lifecycle", category: "Cluster", ref: "server.js",
        summary: "Leader election and replacement, crash-loop and leaderless stops, and a clustered graceful stop.",
        steps: [
            ["proc.boot", "proc.primary", "ENABLE_CLUSTERING=true", "The primary supervises only — no pools, no HTTP."],
            ["proc.primary", "proc.worker", "Fork NUM_WORKERS", "Both listen."],
            ["proc.primary", "proc.leader", "Elect exactly one leader", "'Cron leader elected: worker id=1 … (initial-fork)'."],
            ["proc.primary", "proc.worker", "Leader dies → respawn", "Backoff 1, 2, 4 … 30 s; the service keeps answering on the other worker."],
            ["proc.primary", "proc.leader", "Replacement inherits leadership", "'Cron leader elected … (exit:N)'."],
            ["proc.primary", "trg.winsw", "Crash-loop / leaderless → exit 1", "5 exits in 60 s stops forking; workers left but no leader → graceful stop, exit 1 (money jobs must never silently stop)."],
            ["trg.signal", "proc.primary", "Stop the cluster", "SIGTERM / SIGINT / SIGBREAK to the primary."],
            ["proc.primary", "lc.shutdown", "IPC SHUTDOWN to every worker", "Each runs the normal graceful stop; in-flight requests still finish. A killed primary → workers see the IPC disconnect and stop themselves."],
            ["proc.primary", "trg.winsw", "Exit with the highest worker code", "Primary failsafe = worker failsafe + margin."],
        ],
    },
    {
        id: "cluster-shared-state", name: "Cluster shared state", category: "Cluster", ref: "server.js",
        summary: "State that must be cluster-wide lives on the primary; workers ask over validated IPC.",
        steps: [
            ["proc.worker", "proc.rpc", "Worker asks the primary", "Every message validated by ipcSchemas; the sender is the cluster worker object, never a payload field."],
            ["grd.rate", "proc.rpc", "Rate-limit counters", "Each limit (per IP, per IP + user, per session, per user) is counted once across all workers; sign-in lockout counters are shared the same way."],
            ["grd.secf", "proc.rpc", "Blocks and unblocks", "An unblock clears every worker."],
            ["obs.sched", "proc.rpc", "Scheduler snapshot", "Identical on every worker; a new worker is synced on listen."],
            ["obs.metrics", "proc.rpc", "Metrics merge", "Counts summed, percentiles from merged sketches; a missing worker never fakes a RESOLVED."],
        ],
    },
    {
        id: "ended-session", name: "Ended session across the cluster", category: "Cluster", ref: "server.js",
        summary: "Signing out (or a password change/reset, or Access Control revoking access) ends the access token on every worker at once, not when it expires.",
        steps: [
            ["trg.http", "proc.worker", "Sign-out", "POST /auth/logout: the session family is recorded in this worker's in-memory set BEFORE the DB write, and its live SSE streams are closed."],
            ["proc.worker", "proc.rpc", "auth.revoke", "Notify to the primary; it keeps a copy and broadcasts auth.revoked to every other worker (auth.sync to a worker that starts later). A lost notify is logged at error level."],
            ["trg.http", "proc.worker", "Old token on any worker", "440 SessionRevokedError from AuthMiddleware - an in-memory lookup, no DB call per request. A restart reloads recent revocations from T_AUTH_REFRESH_TOKEN_DEV."],
        ],
    },
    {
        id: "compressed-bodies", name: "Compressed request bodies", category: "Resilience", ref: "server.js",
        summary: "A Brotli-compressed request body is refused with 415 before body-parser hands it to zlib (Node.js CVE-2026-111497); gzip is still accepted.",
        steps: [
            ["trg.http", "proc.worker", "POST with Content-Encoding: br", "Any spelling of the header, including the pre-auth login route."],
            ["proc.worker", "trg.http", "415 Unsupported Media Type", "Refused before the body is decoded; the worker keeps serving the next request."],
            ["trg.http", "proc.worker", "POST with Content-Encoding: gzip", "Unaffected by the advisory: decoded and handled as usual."],
        ],
    },
    {
        id: "multipart-index", name: "Multipart field-name index", category: "Resilience", ref: "server.js",
        summary: "An upload whose text field name carries an array index above 100 is refused with 400 at once (multer fieldArrayIndexLimit via constants/multipart.js on every upload route).",
        steps: [
            ["trg.http", "proc.worker", "Multipart POST with field a[4294967294] and a[x]", "Signed-in upload route, valid CSRF pair."],
            ["proc.worker", "trg.http", "400 ValidationError", "multer stops at the index check (LIMIT_FIELD_ARRAY_INDEX) before any huge sparse array is built; answered in milliseconds."],
            ["trg.http", "proc.worker", "Field a[100]", "At the limit: passes the index check and goes on to the route's own checks."],
        ],
    },
    {
        id: "readiness-cause", name: "Readiness: server vs database", category: "Resilience", ref: "server.js",
        summary: "The UI tells 'the server is down' apart from 'the database is down' from GET /health/ready alone; a down database is not a down server.",
        steps: [
            ["trg.http", "proc.worker", "GET /health/ready", "The UI's reachability probe; never retried or reported by the HttpClient."],
            ["proc.worker", "obs.health", "Readiness", ""],
            ["obs.health", "res.pools", "Probe appDb", "It answers: 200 data.ready true, the banner clears."],
            ["proc.worker", "trg.http", "503 ServiceUnavailableError", "A gating pool is down: data.ready false, no ORA-/NJS- text. /health/live stays 200. The UI names the database as the cause."],
            ["trg.signal", "lc.shutdown", "Server stops", "While it drains /ready answers 503 ServerShuttingDown (restarting banner)."],
            ["lc.close", "trg.winsw", "Process exits", "The port refuses connections: no API envelope, so the UI names the server as the cause."],
        ],
    },
    {
        id: "readiness-push", name: "Readiness push stream", category: "Resilience", ref: "server.js",
        summary: "Every open page keeps GET /health/stream (SSE) open, so the banner shows a server or database outage with no user action and says Back online only when every pool answers and every breaker is closed.",
        steps: [
            ["trg.http", "proc.worker", "GET /health/stream", "Unauthenticated, no compression; retry: 3000; at most HEALTH_STREAM_MAX_PER_IP per address (429 beyond)."],
            ["proc.worker", "obs.health", "Readiness", "One shared evaluation for all streams; first frame is the current verdict."],
            ["obs.health", "res.pools", "Probe every gating pool", "Pool-health changes and breaker trips re-evaluate at once; a change is pushed as {ready, cause}, no ORA-/NJS- text."],
            ["proc.worker", "trg.http", "event: status / heartbeat", "Heartbeat every HEALTH_STREAM_HEARTBEAT_MS; the UI treats silence as the server being unreachable."],
            ["trg.signal", "lc.shutdown", "Server stops", "Streams get a terminal shutdown frame (restarting banner) and end."],
        ],
    },
    {
        id: "sign-in-lockout", name: "Sign-in lockout", category: "Resilience", ref: "server.js",
        summary: "Wrong sign-ins lock that user out after LOGIN_MAX_ATTEMPTS (default 3) failures; other users from the same address are not affected; clustered, the counters live on the primary.",
        steps: [
            ["trg.http", "proc.worker", "POST /auth/login (wrong password)", "401 each time; the failure is recorded."],
            ["proc.worker", "proc.rpc", "lockout.fail", "Clustered: counted on the primary, so failures on any worker add up."],
            ["trg.http", "proc.worker", "Next attempt", "Checked before any credential lookup."],
            ["proc.worker", "trg.http", "429 AccountLockedError", "Until the lockout window ends. A different user id is still answered 401, not 429."],
        ],
    },
    {
        id: "restart-detection", name: "Restart detection and boot emails", category: "Shutdown & crash", ref: "serverProcess.restartMarker.reliability.test.js · bootAlertHistoryLiveOracle.test.js",
        summary: "How the next boot tells a clean stop from a kill or power loss, and the emails it sends (including leader-lost and late reports), and the Alert History row a WARNING or CRITICAL one leaves.",
        steps: [
            ["proc.leader", "lc.marker", "Boot verdict: read the previous record", "BEFORE the first write. FIRST_BOOT (no file) / CLEAN (STOPPED) / UNCLEAN (RUNNING or STOPPING) / UNREADABLE / HANDOVER (same APP_CLUSTER_RUN_ID). A forced exit or crash is STOPPED with exit code 1, so it is not UNCLEAN."],
            ["lc.marker", "res.marker", "RUNNING + 30 s heartbeat", "Atomic tmp + rename (direct-write fallback on EPERM/EBUSY/EACCES); the timer is unref'd."],
            ["lc.shutdown", "lc.marker", "STOPPING", "Written after armFailsafe, never before. A kill during this state reads UNCLEAN with 'graceful shutdown had begun'."],
            ["lc.failsafe", "lc.marker", "FORCED_EXIT remembered", "First statement of the failsafe timer; its own CRITICAL email already goes out."],
            ["lc.close", "lc.marker", "STOPPED once the data is safe", "Right after the audit flush and pool close, before the shutdown-email wait, so a host reboot that cuts that wait still reads CLEAN."],
            ["lc.marker", "res.marker", "STOPPED in the exit hook", "Synchronous, on every process.exit, with the final exit code and reason (a crash or forced exit after the data teardown still wins); no logger inside it."],
            ["lc.marker", "obs.startmail", "Verdict to the notifier", "After db.initializePools() settles, success or failure."],
            ["obs.startmail", "obs.notifier", "Send via notifyLifecycleNow", "UNCLEAN: CRITICAL, never throttled. HANDOVER while the old leader was RUNNING: WARNING 'Cron-leader worker restarted unexpectedly'. Else 'Server started' NOTICE/WARNING, at most one per 15 min (never throttled after an unreported stop, nor after a stop whose shutdown, crash or forced-exit email went out). Bounded at 5 s, respects ENABLE_SERVER_NOTIFICATIONS."],
            ["obs.startmail", "lc.marker", "Clear only what was reported", "An unclean restart whose email failed stays in the record as pendingUnclean (max 5) and is sent late on a later boot ('was not emailed when it happened'); clearPendingUnclean drops only the reported keys. A disabled send counts as reported."],
            ["obs.notifier", "res.smtp", "Deliver", ""],
            ["obs.notifier", "res.db", "Alert History row", "Sent with persist, a WARNING or CRITICAL boot email writes one SERVER_ALERT_LOG FIRED row (ALERT_KEY <RULE>::process, the real EMAIL_STATUS, DISABLED when mail is off) after the real send settles, not after the 5 s bound; tracked in InFlightTaskRegistry. A failed insert stays queued and the next poll tick retries it. NOTICE and the shutdown emails stay email only."],
        ],
    },
    {
        id: "restore-verify", name: "Restore verifies before it re-signs", category: "Backup", ref: "restore.verifyBeforeResign VBR-01–08",
        summary: "A restore never launders a forged ROW_HASH: only rows whose original hash verifies are re-signed.",
        steps: [
            ["trg.http", "proc.worker", "POST /data-purge/restore", "SUPER_ADMIN; archive HMAC verified first."],
            ["proc.worker", "grd.resign", "Per signed table", "After the ordered inserts and the identity FK remap, inside the one appDbBulk restore transaction."],
            ["grd.resign", "res.db", "Verify the original, then sign the new", "Original ROW_HASH over the original PK / FK values; valid → re-signed over the new values; invalid or NULL → ROW_HASH NULL (stays flagged)."],
            ["grd.resign", "obs.logger", "TAMPER_DETECTED", "action RESTORE_ORIGINAL_HASH_INVALID, table + original PK only; the total is returned as tamperedRowsRestoredUnsigned."],
            ["proc.worker", "trg.http", "Result to the UI", "After commit: tamperedRowsRestoredUnsigned (total + perTable[]) in the response; the Restore panel shows a persistent danger alert (TamperedRestoreAlert) with per-table counts and a link to Data Integrity when it is > 0. The restore itself does not fail."],
        ],
    },
];

/** Diagram placement. Every node must appear exactly once (the builder checks). */
const LAYOUT = {
    columns: [
        { layer: "trigger", nodes: ["trg.winsw", "trg.signal", "trg.clock", "trg.http", "trg.fault"] },
        { layer: "process", nodes: ["proc.boot", "proc.primary", "proc.worker", "proc.leader", "proc.rpc"] },
        { layer: "schedule", nodes: ["sch.alertpoll", "sch.logret", "sch.backup"] },
        { layer: "guard", nodes: ["grd.secf", "grd.rate", "grd.reqwd", "grd.burst", "grd.pool", "grd.batch", "grd.backupwd", "grd.resign"] },
        { layer: "lifecycle", nodes: ["lc.crash", "lc.shutdown", "lc.failsafe", "lc.inflight", "lc.sse", "lc.drain", "lc.audit", "lc.close", "lc.marker"] },
        { layer: "observe", nodes: ["obs.health", "obs.logger", "obs.relay", "obs.notifier", "obs.shutdownmail", "obs.startmail", "obs.metrics", "obs.sched"] },
        { layer: "resource", nodes: ["res.pools", "res.db", "res.backupdir", "res.marker", "res.logs", "res.smtp"] },
    ],
    band: { layer: "process", nodes: [] },
};

/** Map-level facts served as `meta` (the builder adds `mapVerifiedAt`). */
const META = {
    title: "Runtime",
    system: "CATHERINE — backend runtime: scheduling, backup, resilience, shutdown",
    repos: ["Backend"],
    conventions: {
        nodeId: "<layer-prefix>.<name>: trg, proc, sch, grd, lc, obs, res",
        edgeId: "<source>-><target>; direction = initiator → callee",
        flowStep: "edge names the edge used; reverse=true means the step travels the edge backwards",
        ref: "flow.ref names the code site or test that exercises the flow",
        files: "paths are relative to the workspace root that contains Backend/",
    },
    caveats: [
        "Timings are code defaults; production may override them through .env (read the target's .env, not this map).",
        "Clustered behaviour (primary, shared state) applies only with ENABLE_CLUSTERING=true.",
    ],
};

module.exports = { MAP_VERIFIED_AT, META, LAYOUT, layers, edgeKinds, nodes, E, flows };
