"use strict";

/**
 * @fileoverview Hand-authored source of truth for the Architecture page
 * (Support → Architecture, SUPER_ADMIN only).
 *
 * Plain data: nodes, edges, flows, diagram LAYOUT and META.
 * `src/utils/systemMap.js` validates it and assembles the served map;
 * ArchitectureService builds it once per process. Sibling model:
 * `runtimeModel.js` (Support → Runtime). It lives under `src/` (not `scripts/`) because PKG only bundles
 * `src/**`, and the .exe must be able to serve it.
 *
 * `buildSystemMap` (src/utils/systemMap.js) is meant to reject the map when:
 *   - a flow step names two nodes with no edge between them,
 *   - a `Backend/...` path in `files` no longer exists, or
 *   - a route file declares an endpoint this model does not list (or the
 *     reverse) — so adding a route means adding it here.
 *
 * Bump MAP_VERIFIED_AT whenever the model is re-checked against the code; the
 * page shows it as "Verified <date>".
 */

const MAP_VERIFIED_AT = "2026-10-26";

const API = "Backend/";
const UI = "Frontend/";
const R = (f) => `${API}src/routes/${f}`;
const C = (f) => `${API}src/controllers/${f}`;
const S = (f) => `${API}src/services/${f}`;
const M = (f) => `${API}src/models/${f}`;
const U = (f) => `${API}src/utils/${f}`;
const MW = (f) => `${API}src/middleware/${f}`;
const F = (f) => `${UI}src/features/${f}`;
const eps = (base, list) => list.split(";").filter(Boolean).map((e) => {
    const [m, p] = e.split(" ");
    return `${m} /api/v1${base}${p === "/" ? "" : p}`;
});

const layers = [
    { id: "actor", label: "Actors", color: "#f59e0b", description: "People who drive the system." },
    { id: "frontend", label: "Frontend", color: "#38bdf8", description: "React 19 + Vite SPA, Tailwind v4, three-layer features (.api.js / .hook.js / .view.jsx)." },
    { id: "edge", label: "Express edge", color: "#a78bfa", description: "app.js 13-step middleware chain plus route-level auth, cache and the global error funnel." },
    { id: "api", label: "API modules", color: "#34d399", description: "Route → Controller → Service → Model, one node per /api/v1 mount. Project services live inside their module." },
    { id: "service", label: "Shared services", color: "#2dd4bf", description: "Cross-cutting engines and utilities used by several modules." },
    { id: "runtime", label: "Runtime & schedulers", color: "#fb923c", description: "server.js: cluster primary, HTTP workers, leader-only schedulers." },
    { id: "data", label: "Oracle data", color: "#f472b6", description: "Two pools (appDb, appDbBulk) via oracle-mongo-wrapper; table groups in the app schema." },
    { id: "external", label: "External", color: "#94a3b8", description: "SMTP relay and the local filesystem." },
];

const edgeKinds = {
    http: { label: "HTTP / REST", color: "#38bdf8" },
    sse: { label: "Server-Sent Events", color: "#e879f9" },
    call: { label: "In-process call", color: "#94a3b8" },
    sql: { label: "SQL (bind vars)", color: "#fbbf24" },
    device: { label: "Device / direct DB", color: "#facc15" },
    ipc: { label: "Cluster IPC", color: "#fb923c" },
    schedule: { label: "Scheduled trigger", color: "#f87171" },
    smtp: { label: "SMTP", color: "#f472b6" },
    fs: { label: "Filesystem", color: "#a3e635" },
};

const nodes = [
    // ── Actors ───────────────────────────────────────────────────────────────
    { id: "actor.user", layer: "actor", label: "User", sub: "role USER", description: "Signs in with a standalone account (T_USERS_DEV, Argon2id) and uses the project's user-facing features." },
    { id: "actor.admin", layer: "actor", label: "Admin / Super Admin", sub: "ADMIN · SUPER_ADMIN", description: "Operates the admin features. SUPER_ADMIN alone reaches Logging & Observability, Access Control, Data Integrity, Data Management, and the Architecture and Runtime maps. Per-flag permissions live on T_ADMINS_DEV (CAN_* flags)." },

    // ── Frontend ─────────────────────────────────────────────────────────────
    { id: "fe.spa", layer: "frontend", label: "SPA shell", sub: "App.jsx · contexts", description: "React 19 app root: router tree, theme/layout/security/version contexts, ErrorBoundary that reports to /client/errors.", files: [`${UI}src/App.jsx`, `${UI}src/main.jsx`, `${UI}src/contexts/`] },
    { id: "fe.router", layer: "frontend", label: "Route guards", sub: "ProtectedRoute · AuthMiddleware", description: "Role-aware routing; public routes (/, /auth, /help, /support/changelog) vs protected; landing path chosen by role (roleRedirect.js). A signed-in user who opens the sign-in page or the start page goes back to the page they last used (kept per browser tab and per user, path only, cleared on sign-out), else to the role landing page; the 400/401/404/422/429/523 error pages send the user back to where they left off (a page that needs sign-in is never offered to a signed-out user), 429 Try again returns there once the wait is over, 440/498 still go to sign-in.", files: [`${UI}src/components/routing/ProtectedRoute.jsx`, `${UI}src/middleware/authentication/AuthMiddleware.js`, `${UI}src/components/layout/config/nav.config.jsx`] },
    { id: "fe.http", layer: "frontend", label: "HttpClient", sub: "axios · CSRF · refresh", description: "Single axios instance: withCredentials cookies, x-csrf-token on mutating requests (CsrfMiddleware), CSRF 403 → POST /csrf/refresh → replay once, 429 PoolOverloaded GET retry honouring Retry-After, 440/498 → sign-out + /login-timeout | /invalid-token takeover, PasswordChangeRequired → /auth/change-password. Error pages carry only the return path (no query values); 429 Try again waits out Retry-After and goes back to that page instead of reloading the 429 page.", files: [`${UI}src/middleware/HttpClient.js`, `${UI}src/middleware/security/CsrfMiddleware.js`, `${UI}src/config/apiBase.js`] },
    { id: "fe.sse", layer: "frontend", label: "Live stream hooks", sub: "EventSource", description: "useLiveStream opens text/event-stream connections and triggers silent refetches on change events.", files: [`${UI}src/hooks/useLiveStream.js`] },
    { id: "fe.auth", layer: "frontend", label: "Auth views", sub: "features/auth", description: "Login, Change Password (temporary / legacy default password), Logout. Sign-out clears the remembered last page; opening Login while still signed in returns to it.", files: [F("auth/")] },
    { id: "fe.sysadmin", layer: "frontend", label: "System Admin", sub: "features/systemadmin", description: "Access Control, Logging & Observability, Data Integrity, Data Management (purge/backup/restore).", files: [F("systemadmin/")] },
    { id: "fe.support", layer: "frontend", label: "Support & Dashboard", sub: "changelog · docs · system maps", description: "Version history, in-app Dev Docs viewer (ADMIN/SUPER_ADMIN), Architecture and Runtime maps (SUPER_ADMIN), Help center, dashboard, personalize.", files: [F("support/"), F("dashboard/"), F("personalize/"), `${UI}src/components/shared/systemMap/`] },

    // ── Express edge ─────────────────────────────────────────────────────────
    { id: "edge.chain", layer: "edge", label: "Middleware chain", sub: "app.js · 13 ordered steps", description: "1 Helmet · 2 Security filter · 3 Traceability (X-Request-Id, ALS) · 3a Audit log · 3b Shutdown gate · 4 Body parsers (+empty-body default, Content-Encoding br → 415, a gzip body with extra bytes after the data no longer crashes it, body-parser 2.4.0, uploads: multer field-name index max 100 → 400 ValidationError, constants/multipart.js on every upload route) · 4a Incoming log · 5 Response time · 5a Metrics · 6 Compression (compression 1.8.2) · 7 CORS · 8 Cookie parser · 9 CSRF · 10 Capture response body · 11 IP filter · 12 Rate limiter · 13 Prevent redirects → /api/v1. Order is load-bearing; do not reorder. Client IP: trust proxy from TRUST_PROXY (off or a hop count, never a subnet, proxy-addr 2.0.8).", files: [MW("security/HelmetMiddleware.js"), MW("security/ShutdownGateMiddleware.js"), MW("parsing/BodyParserMiddleware.js"), `${API}src/constants/multipart.js`, MW("performance/CompressionMiddleware.js"), MW("security/CorsMiddleware.js"), MW("parsing/CookieParserMiddleware.js"), MW("security/PreventRedirectsMiddleware.js"), `${API}src/app.js`] },
    { id: "edge.guard", layer: "edge", label: "Abuse guards", sub: "steps 2 · 3b · 11 · 12", description: "SecurityFilter (scanners, traversal, script injection), ShutdownGate (step 3b: while the server drains every request except OPTIONS and /health gets 503 ServerShuttingDown + Retry-After 5; the UI shows its restarting banner), CIDR IP filter, Sliding-Window-Counter rate limiter (no Redis; counters shared via cluster RPC; auth routes use four route-level limiters: failed sign-ins per IP and per IP+user, refreshes per session family, password changes per user), SuspiciousIpTracker.", files: [MW("security/SecurityFilterMiddleware.js"), MW("security/ShutdownGateMiddleware.js"), MW("security/IpFilterMiddleware.js"), MW("security/RateLimiterMiddleware.js"), MW("security/SlidingWindowCounter.js"), MW("security/authRateLimiters.js"), U("auth/refreshFamily.js"), `${API}src/constants/authRateLimits.js`] },
    { id: "edge.trace", layer: "edge", label: "Traceability & metrics", sub: "steps 3 · 3a · 5 · 5a", description: "Snowflake 23-char request id, AsyncLocalStorage context, audit-row persistence after res.end (setImmediate), X-Response-Time + slow-response detection, per-route metrics.", files: [MW("metrics/index.js"), U("requestContext.js"), U("routeLabel.js"), MW("traceability/TraceabilityMiddleware.js"), MW("traceability/AuditLogMiddleware.js"), MW("performance/ResponseTimeMiddleware.js"), MW("metrics/MetricsMiddleware.js"), U("snowflake.js")] },
    { id: "edge.csrf", layer: "edge", label: "CSRF", sub: "step 9 · csrf-csrf", description: "Double-submit-cookie CSRF validated on unsafe methods; tokens issued by GET /csrf/token.", files: [MW("security/CsrfMiddleware.js"), R("csrf.route.js")] },
    { id: "edge.router", layer: "edge", label: "/api/v1 router", sub: "routes/index.js", description: "Mounts the route modules. Public endpoints (health, GET csrf/token + status, auth login/refresh, changelog public, POST metrics/frontend) skip authenticate.", files: [R("index.js")] },
    { id: "edge.auth", layer: "edge", label: "AuthMiddleware", sub: "JWT cookie · RBAC", description: "authenticate (app.access-token cookie; 440 on expiry) + requireAccess / requireAdminAccess / permission-flag predicates. A verified token must carry the access claims (type/aud/iss): a refresh token is refused 401, a legacy token 440 (classifyAccessClaims, before the password-change gate). A token whose session family (fid) was ended - sign-out, password change/reset, admin re-add, refresh reuse - is refused 440 SessionRevokedError at once (AccessRevocationService: in-memory set, no DB call per request, shared across workers over IPC, reloaded at boot). LoginLockout state is checked inside AuthService.login, not as route middleware; under clustering the counters live on the primary (lockout.check/fail/clear).", files: [MW("authentication/AuthMiddleware.js"), MW("authentication/LoginLockoutMiddleware.js"), MW("authentication/LoginLockoutPolicy.js"), MW("authentication/LoginLockoutState.js"), U("auth/tokenClaims.js"), U("auth/userKey.js"), U("auth/RevokedSessionSet.js"), S("AccessRevocationService.js"), `${API}src/constants/authTokens.js`] },
    { id: "edge.cache", layer: "edge", label: "Response cache", sub: "CacheMiddleware · SingleFlight", description: "Namespaced in-memory cache-aside with CacheKeyBuilder (role/username in keys where data is caller-specific, CWE-200), SingleFlight de-duplication, invalidation on writes, synced across workers by ClusterCacheSync.", files: [MW("cache/CacheStore.js"), MW("cache/index.js"), MW("cache/CacheMiddleware.js"), MW("cache/CacheRegistry.js"), MW("cache/CacheKeyBuilder.js"), MW("cache/SingleFlight.js"), MW("cache/ClusterCacheSync.js")] },
    { id: "edge.error", layer: "edge", label: "Error funnel", sub: "AppError · catchAsync", description: "All errors funnel to ErrorHandlerMiddleware: 404 catch-all, AppError → sendError shape, ORA-/NJS- code mapping, no stack leakage.", files: [`${API}src/constants/errors/index.js`, `${API}src/constants/responses/index.js`, `${API}src/constants/index.js`, MW("errorHandling/ErrorHandlerMiddleware.js"), MW("errorHandling/OraCode.js"), U("catchAsync.js")] },

    // ── API modules ──────────────────────────────────────────────────────────
    { id: "api.platform", layer: "api", label: "Platform", sub: "/health · /csrf · /client", description: "Liveness/readiness probes (ready only when EVERY pool answers incl. appDbBulk and every circuit breaker is closed; /health/stream pushes the verdict over SSE; /ready tells the UI who is down: 503 ServiceUnavailableError = database, 503 ServerShuttingDown = restarting, no answer = server), CSRF token issue/refresh, client error + help-miss ingestion.", files: [S("ClientService.js"), S("ReadinessService.js"), S("HealthStreamHub.js"), R("health.route.js"), R("csrf.route.js"), R("client.route.js"), C("ClientController.js")], endpoints: [...eps("/health", "GET /live;GET /ready;GET /stream;GET /"), ...eps("/csrf", "GET /token;POST /refresh;GET /status"), ...eps("/client", "POST /errors;POST /help-miss")] },
    { id: "api.auth", layer: "api", label: "Auth", sub: "/auth", description: "Login against the standalone user (T_USERS_DEV) and admin (T_ADMINS_DEV) tables, JWT access/refresh cookies, cookie-only refresh with one-time rotation and reuse detection, revocable sessions (logout, password change/reset, admin re-add), change password, temp-password expiry.", files: [R("auth.route.js"), C("AuthControllers.js"), S("AuthService.js"), S("RefreshTokenService.js"), M("auth.refresh.token.model.js"), U("auth/RefreshTokenRegistry.js"), M("user.model.js"), M("admin.model.js")], endpoints: eps("/auth", "POST /login;POST /refresh;POST /logout;GET /me;PATCH /change-password") },
    { id: "api.admin", layer: "api", label: "Access Control", sub: "/admin-management", description: "Admin accounts, roles and per-flag permissions, password/signature resets, revoke, delete, IP unblock. Revoke, delete, deactivate and a role change end every session of the account first (fail closed). Router gate ADMIN or SUPER_ADMIN; role change, reset-signature, permissions, revoke, delete and unblock-ip are SUPER_ADMIN; an ADMIN may only add a USER or reset a USER's password.", files: [R("admin-management.route.js"), C("AdminManagementController.js"), S("AdminManagementService.js"), S("AdminAccessEmailService.js"), M("admin.model.js")], endpoints: eps("/admin-management", "GET /search;GET /;POST /;PUT /:username;PATCH /:username/reset-password;PATCH /:username/reset-signature;DELETE /:username;POST /:username/revoke-backup;POST /:username/revoke;POST /security/unblock-ip;PATCH /:username/permissions") },
    { id: "api.integrity", layer: "api", label: "Integrity Center", sub: "/integrity", description: "Per-table tamper sweeps (ROW_HASH), browse/export, rescan, live SSE. Tables are registered in integrity.model.js. SUPER_ADMIN only.", files: [R("integrity.route.js"), C("IntegrityController.js"), C("IntegrityStreamController.js"), S("IntegrityService.js"), M("integrity.model.js")], endpoints: eps("/integrity", "GET /tables;GET /stream;GET /:table/tamper;GET /:table/filter-options;GET /:table/browse;GET /:table/export;POST /:table/rescan") },
    { id: "api.purge", layer: "api", label: "Data Purge & Restore", sub: "/data-purge", description: "Scope preview (FK closure), mandatory signed backup, password authorise, single atomic purge, restore, backup list/verify, two-person backup deletion votes. SUPER_ADMIN only. The backup token carries a signed high-water mark (highest backed-up PK) for append-only logs (appendOnlyLog in purgeTables.js); execute re-counts and deletes only rows up to it, so log rows written after the backup are kept and are not drift. Other tables keep the exact whole-table re-count.", files: [M("backup-token.model.js"), M("backup-vote.model.js"), `${API}src/constants/purgeTables.js`, R("data-purge.route.js"), C("DataPurgeController.js"), S("DataPurgeService.js"), S("DataRestoreService.js"), M("data-purge.model.js")], endpoints: eps("/data-purge", "GET /scopes;POST /preview;POST /backup;POST /authorise;POST /execute;POST /restore/preview;POST /restore;GET /backups;POST /backups/run;GET /backups/:id/download;POST /backups/:id/verify;POST /backups/:id/delete-request;POST /backups/:id/vote;DELETE /backups/:id/delete-request") },
    { id: "api.audit", layer: "api", label: "Logs", sub: "/audit-logs", description: "Audit log search/stats/export, per-request trace export, live audit stream, system log tail + stream.", files: [R("audit-log.route.js"), C("AuditLogController.js"), S("AuditLogService.js"), S("SystemLogTailService.js"), M("audit.log.model.js")], endpoints: eps("/audit-logs", "GET /stats;GET /export/excel;GET /export/logs;GET /stream;GET /system-logs;GET /system-logs/stream;GET /;GET /:requestId/export/trace;GET /:requestId/logs;DELETE /") },
    { id: "api.metrics", layer: "api", label: "Metrics & Alerts", sub: "/metrics", description: "Route metrics summary, alerts + history, ack/unack, frontend web-vitals ingestion, notification status/test.", files: [R("metrics.route.js"), C("MetricsController.js"), S("MetricsService.js"), M("serverAlertAck.model.js"), M("serverAlertLog.model.js")], endpoints: eps("/metrics", "GET /;GET /summary;GET /alerts;POST /frontend;GET /notifications/status;POST /notifications/test;GET /alerts/history;POST /alerts/ack;DELETE /alerts/ack") },
    { id: "api.support", layer: "api", label: "Changelog & Dev Docs", sub: "/changelog · /dev-docs", description: "Version history + release train (public read, stored in the encrypted data/changelog.enc), Dev Docs viewer serving Backend/dev-docs at request time (ADMIN/SUPER_ADMIN) with freshness badges.", files: [M("changelog.model.js"), R("changelog.route.js"), R("dev-docs.route.js"), C("ChangelogController.js"), C("ReleaseController.js"), C("DevDocsController.js"), S("ChangelogService.js"), S("DevDocsService.js"), S("ReleaseService.js")], endpoints: [...eps("/changelog", "GET /public;GET /public/latest;GET /;GET /release/current;POST /;PUT /:id;DELETE /:id"), ...eps("/dev-docs", "GET /tree;GET /search;GET /doc/:section/:name")] },

    { id: "api.architecture", layer: "api", label: "System maps", sub: "/architecture", description: "Serves this map and the Runtime map (nodes, edges, flows, layout), each built once per process from its model in src/constants/. SUPER_ADMIN only; responses are private, no-store.", files: [R("architecture.route.js"), C("ArchitectureController.js"), S("ArchitectureService.js"), `${API}src/constants/architectureModel.js`, `${API}src/constants/runtimeModel.js`, U("systemMap.js")], endpoints: eps("/architecture", "GET /;GET /runtime") },

    // ── Shared services ──────────────────────────────────────────────────────
    { id: "svc.crypto", layer: "service", label: "CryptoVault", sub: "HMAC · argon2 · 3DES", description: "HMAC-SHA256 row signatures (SYSSIGNATURE, ROW_HASH) with timingSafeEqual, argon2id or bcrypt admin passwords (PASSWORD_ENCRYPTION_MODE), temporary admin passwords.", files: [U("encryption/CryptoVault.js"), U("encryption/adminTempPassword.js")] },
    { id: "svc.tamper", layer: "service", label: "Tamper detection", sub: "TamperDetectionService", description: "Per-table row verifiers used by integrity sweeps and exports' Integrity column. Projects register their signed tables here.", files: [S("TamperDetectionService.js"), S("IntegrityService.js")] },
    { id: "svc.excel", layer: "service", label: "Excel I/O", sub: "ExcelJS", description: "Shared ExcelJS helpers: .xlsx magic-byte check, normalizeCellValue (every upload parser reads cell.value through it: formula → result, rich text → text, error → null; never \"[object Object]\"), money/date cell formatters, upload-outcome builder. Each module builds its own export workbook.", files: [U("validateXlsxMagicBytes.js"), U("excelCell.js"), U("excelFormat.js"), U("uploadOutcome.js")] },
    { id: "svc.email", layer: "service", label: "Email subsystem", sub: "SharedTransporter · protection", description: "Pooled nodemailer transport (10.2.1, exact pin), retry/classify SMTP errors, recipient resolution by permission flag (CAN_RECEIVE_*), HTML templates per feature. Typed addresses pass singleAddress (one plain address, max 254 chars) before they reach nodemailer.", files: [U("emailAddress.js"), S("email/SharedTransporter.js"), S("email/EmailProtectionService.js"), S("email/RecipientResolver.js"), S("email/ServerNotificationService.js"), U("email-templates/")] },
    { id: "svc.sse", layer: "service", label: "SSE infrastructure", sub: "ScopedSsePoller", description: "ScopedSsePoller backs per-scope report streams. Integrity, audit-log and system-log run controller-level shared pollers. All register in SseConnectionRegistry (shutdown broadcast).", files: [U("sse/ScopedSsePoller.js"), U("sse/SseConnectionRegistry.js"), U("sse/ssePreflight.js")] },
    { id: "svc.wrapper", layer: "service", label: "oracle-mongo-wrapper", sub: "Mongo-style Oracle API", description: "Query builder, aggregation pipelines, joins, CTEs, transactions and pool management with absolute bind-variable safety. Every model goes through it.", files: [`${API}src/config/index.js`, U("dbTimezone.js"), U("oracle-mongo-wrapper/"), `${API}src/config/database.js`] },
    { id: "svc.backup", layer: "service", label: "Backup subsystem", sub: "store · archive · token · restore", description: "Streams tables to a signed .zip (JSONL + xlsx + manifest + HMAC), stores under db-backup/, single-use backup tokens, verify and restore.", files: [S("BackupStoreService.js"), S("BackupArchiveService.js"), S("BackupTokenService.js"), S("DataRestoreService.js"), S("BackupEmailService.js")] },
    { id: "svc.logger", layer: "service", label: "Logger", sub: "daily rotation", description: "In-house RFC 5424 8-level logger with millisecond timestamps, redaction, per-day log folders with 50 MB size roll-over, and LogRetentionService cleanup.", files: [`${API}src/constants/messages/`, U("logger.js"), U("logRedaction.js"), S("LogRetentionService.js"), S("SystemLogTailService.js")] },
    { id: "svc.schedstate", layer: "service", label: "Scheduler state", sub: "SchedulerStateService", description: "Records each scheduled job run (see schedulerJobs.js) for the scheduler-activity view; replicated to the primary over IPC.", files: [S("SchedulerStateService.js"), `${API}src/constants/schedulerJobs.js`] },

    // ── Runtime ──────────────────────────────────────────────────────────────
    { id: "rt.primary", layer: "runtime", label: "Cluster primary", sub: "ClusterSupervisor", description: "Forks workers, respawns with backoff, elects the cron leader (CRON_LEADER=true on one worker), progress-aware graceful stop.", files: [`${API}server.js`, U("cluster/ClusterSupervisor.js"), U("clusterRole.js")] },
    { id: "rt.rpc", layer: "runtime", label: "Cluster RPC hub", sub: "shared state over IPC", description: "Primary-held shared state for workers: rate-limit counters, per-user login-lockout counters (lockout.check/fail/clear), ended session families (auth.revoke -> auth.revoked broadcast, auth.sync to a late worker), security filter, scheduler state, metrics merge, cache invalidation fan-out.", files: [U("cluster/workerRpcWiring.js"), U("cluster/ClusterRpcHub.js"), U("cluster/ClusterRpcClient.js"), U("cluster/PrimaryStateServices.js"), MW("cache/ClusterCacheSync.js")] },
    { id: "rt.workers", layer: "runtime", label: "HTTP workers", sub: "server.js → app.js", description: "Each worker boots app.js on the http server; RequestWatchdog/IdleWatchdog, HttpInFlightTracker and graceful shutdown with pool cleanup.", files: [U("consoleManager.js"), `${API}server.js`, U("progress/RequestWatchdog.js"), U("shutdown/HttpInFlightTracker.js")] },
    { id: "rt.backupsched", layer: "runtime", label: "Scheduled DB backup", sub: "BackupScheduleService", description: "Separate leader-only schedule that runs a backup and emails CAN_RECEIVE_DB_BACKUP admins.", files: [S("BackupScheduleService.js")] },
    { id: "rt.runmarker", layer: "runtime", label: "Restart marker & boot emails", sub: "ServerRunMarker · StartupNotifier", description: "The cron leader keeps data/server-run.json (RUNNING at boot, 30 s heartbeat, STOPPING in gracefulShutdown, STOPPED from a synchronous exit hook). The next boot reads it before overwriting: RUNNING/STOPPING = unclean restart (one CRITICAL email), otherwise a 'Server started' notice, throttled to one per 15 min unless a shutdown, crash or forced-exit email went out since the last one. Forced exit and crash are already mailed, so they are not re-reported. Same APP_CLUSTER_RUN_ID = leader handover: silent if the old leader was STOPPING, one WARNING 'Cron-leader worker restarted unexpectedly' if it was still RUNNING. STOPPED is written as soon as the audit flush and pool close finish (noteTeardownComplete), a later crash raises the stored exit code (noteExitCodeRaised), and an unclean restart whose email failed stays as pendingUnclean (max 5) until a later boot reports it. WARNING/CRITICAL boot emails also write a SERVER_ALERT_LOG FIRED row and show in Alert History; NOTICE and the shutdown emails stay email only.", files: [U("lifecycle/ServerRunMarker.js"), U("lifecycle/StartupNotifier.js"), `${API}src/constants/serverRunMarker.js`, `${API}server.js`] },
    { id: "rt.alerts", layer: "runtime", label: "Alerting", sub: "MetricsStore · AlertNotifier", description: "Aggregates route metrics, raises server alerts (CRIT / DEPS / RED / SYS) and emails subscribed admins from the leader.", files: [MW("metrics/MetricsStore.js"), S("AlertNotifierService.js"), S("MetricsService.js")] },

    // ── Data ─────────────────────────────────────────────────────────────────
    { id: "db.app", layer: "data", label: "appDb pool", sub: "interactive · gates readiness", description: "Interactive Oracle pool; every model binds here unless it does bulk work. Skipped when DEMO_MODE=true.", files: [`${API}src/config/database.js`] },
    { id: "db.appbulk", layer: "data", label: "appDbBulk pool", sub: "exports · purge · backup", description: "Second pool on the same credentials for long-running bulk work so it cannot starve interactive queries.", files: [`${API}src/config/database.js`] },
    { id: "tbl.people", layer: "data", label: "Identity & admins", sub: "T_USERS_DEV · T_ADMINS_DEV", description: "Standalone user accounts T_USERS_DEV (Argon2id) and admin accounts T_ADMINS_DEV with ROLE, CAN_* flags and SYSSIGNATURE; the refresh-token ledger (SHA-256 of the jti, one-time use, family revocation).", files: [`${API}sql/01_schema.sql`] },
    { id: "tbl.config", layer: "data", label: "System config", sub: "key/value switches", description: "Runtime key/value switches read by SystemConfigService. Projects register their own keys." },
    { id: "tbl.audit", layer: "data", label: "Audit & alerts", sub: "T_AUDIT_LOGS_DEV · T_SERVER_ALERT_*", description: "T_AUDIT_LOGS_DEV (per-request audit rows), T_SERVER_ALERT_LOG_DEV (sent alert emails) and T_SERVER_ALERT_ACK_DEV (acknowledged alerts, hydrated at notifier start)." },
    { id: "tbl.gov", layer: "data", label: "Two-person governance", sub: "BACKUP_*", description: "T_SERVER_BACKUP_DELETE_VOTE_DEV (two-person backup deletion) and T_SERVER_BACKUP_TOKEN_CONSUMED_DEV (single-use purge backup tokens)." },

    // ── External ─────────────────────────────────────────────────────────────
    { id: "ext.smtp", layer: "external", label: "SMTP relay", sub: "corporate mail", description: "Receives all outbound mail: admin access, backups, server alerts and any project notifications." },
    { id: "ext.fs", layer: "external", label: "Filesystem", sub: "db-backup/ · dev-docs/ · data/", description: "Backup archives on disk, the Markdown dev-docs corpus read at request time, the restart marker (data/server-run.json, runtime state, never copied between machines) and the encrypted changelog (data/changelog.enc)." },
    { id: "ext.logs", layer: "external", label: "Log files", sub: "logs/YYYY/…", description: "Daily-rotated application logs tailed by the Logs page." },
];

// [source, target, kind, label]
const E = [
    // actors
    ["actor.user", "fe.spa", "http", "uses browser"],
    ["actor.admin", "fe.spa", "http", "uses browser"],
    // frontend
    ["fe.spa", "fe.router", "call", "route tree"],
    ["fe.router", "fe.auth", "call", ""],
    ["fe.router", "fe.sysadmin", "call", ""],
    ["fe.router", "fe.support", "call", ""],
    ["fe.auth", "fe.http", "call", "auth.api.js"],
    ["fe.sysadmin", "fe.http", "call", "*.api.js"],
    ["fe.support", "fe.http", "call", "*.api.js"],
    ["fe.sysadmin", "fe.sse", "call", "useLiveStream"],
    ["fe.http", "edge.chain", "http", "HTTPS /api/v1 + cookies"],
    ["fe.sse", "edge.chain", "sse", "GET …/stream"],
    ["fe.spa", "fe.http", "call", "client/errors (ErrorBoundary)"],
    ["fe.spa", "edge.chain", "http", "POST /metrics/frontend (keepalive fetch)"],
    // edge
    ["edge.chain", "edge.guard", "call", "steps 2, 11, 12"],
    ["edge.chain", "edge.trace", "call", "steps 3–5a"],
    ["edge.chain", "edge.csrf", "call", "step 9"],
    ["edge.chain", "edge.router", "call", "step 13 → /api/v1"],
    ["edge.router", "edge.auth", "call", "authenticate"],
    ["edge.router", "edge.error", "call", "404 / AppError"],
    ["edge.router", "api.platform", "http", "public"],
    ["edge.router", "api.auth", "http", "public login"],
    ["edge.router", "api.support", "http", "public changelog"],
    ["edge.auth", "api.platform", "http", "authenticate (client/*, csrf/refresh)"],
    ["edge.router", "api.metrics", "http", "public web-vitals"],
    ...["api.auth", "api.admin", "api.integrity", "api.purge", "api.audit", "api.metrics", "api.support", "api.architecture"].map((t) => ["edge.auth", t, "http", "RBAC"]),
    ["edge.guard", "rt.rpc", "ipc", "shared counters"],
    ["edge.trace", "tbl.audit", "sql", "audit row after res.end"],
    ["edge.trace", "rt.alerts", "call", "route metrics"],
    ["edge.cache", "rt.rpc", "ipc", "ClusterCacheSync"],
    ["edge.error", "svc.logger", "call", "error log"],
    // api → *
    ["api.platform", "edge.csrf", "call", "issue token"],
    ["api.platform", "db.app", "sql", "readiness"],
    ["api.platform", "svc.logger", "call", "client errors"],
    ["api.platform", "db.appbulk", "sql", "probed, non-gating"],
    ["api.auth", "tbl.people", "sql", "T_USERS_DEV · T_ADMINS_DEV · refresh-token ledger"],
    ["api.auth", "svc.crypto", "call", "verify pw + signature"],
    ["api.auth", "edge.cache", "call", "authProfile · adminList invalidate"],
    ["api.admin", "tbl.people", "sql", "admins + flags"],
    ["api.admin", "svc.crypto", "call", "hash pw · SYSSIGNATURE"],
    ["api.admin", "svc.email", "call", "access emails"],
    ["api.admin", "edge.cache", "call", "adminList cache-aside + invalidate"],
    ["api.admin", "edge.guard", "call", "unblock IP cluster-wide"],
    ["api.admin", "svc.backup", "call", "entity backup + token consume"],
    ["api.integrity", "svc.tamper", "call", "verify ROW_HASH"],
    ["api.integrity", "edge.cache", "call", "sweep TTL 180s"],
    ["api.integrity", "svc.sse", "call", "live stream"],
    ["api.purge", "db.appbulk", "sql", "purge txn"],
    ["api.purge", "svc.backup", "call", "mandatory backup"],
    ["api.purge", "svc.crypto", "call", "verify admin pw"],
    ["api.purge", "tbl.gov", "sql", "token + votes"],
    ["api.purge", "tbl.audit", "sql", "purge audit row"],
    ["api.purge", "db.app", "sql", "row counts (preview + drift re-count)"],
    ["api.purge", "tbl.people", "sql", "admin re-verify + lockout ack"],
    ["api.purge", "edge.cache", "call", "flush all"],
    ["api.purge", "svc.email", "call", "ops alert"],
    ["api.audit", "tbl.audit", "sql", "search / export"],
    ["api.audit", "edge.cache", "call", "auditLog cache-aside"],
    ["api.audit", "svc.logger", "call", "system log tail"],
    ["api.audit", "svc.sse", "call", "live logs"],
    ["api.metrics", "rt.alerts", "call", "summary / alerts"],
    ["api.metrics", "tbl.audit", "sql", "alert ack"],
    ["api.metrics", "svc.email", "call", "test notification"],
    ["api.support", "ext.fs", "fs", "dev-docs/*.md · changelog.enc"],
    // services
    ["svc.tamper", "svc.crypto", "call", "verifyRecord"],
    ["svc.email", "ext.smtp", "smtp", "send"],
    ["svc.email", "tbl.people", "sql", "CAN_RECEIVE_* recipients"],
    ["svc.sse", "fe.sse", "sse", "push events"],
    ["svc.wrapper", "db.app", "sql", "pool"],
    ["svc.wrapper", "db.appbulk", "sql", "pool"],
    ["svc.backup", "db.appbulk", "sql", "READ ONLY stream"],
    ["svc.backup", "ext.fs", "fs", "write .zip"],
    ["svc.backup", "svc.crypto", "call", "manifest HMAC · restore: verify original ROW_HASH, then re-sign"],
    ["svc.backup", "tbl.gov", "sql", "consume jti + delete votes"],
    ["svc.backup", "svc.email", "call", "backup email"],
    ["svc.logger", "ext.logs", "fs", "rotate files"],
    ["svc.schedstate", "rt.rpc", "ipc", "replicate state"],
    // runtime
    ["rt.primary", "rt.workers", "ipc", "fork / respawn"],
    ["rt.primary", "rt.rpc", "call", "hosts"],
    ["rt.workers", "rt.rpc", "ipc", "RPC client"],
    ["rt.workers", "edge.chain", "call", "serves app.js"],
    ["rt.backupsched", "svc.backup", "schedule", "run backup"],
    ["rt.backupsched", "svc.email", "call", "backup email"],
    ["rt.backupsched", "svc.schedstate", "call", "record dbBackup"],
    ["rt.alerts", "svc.email", "call", "server alerts"],
    ["rt.alerts", "rt.rpc", "ipc", "metrics merge"],
    ["rt.workers", "rt.runmarker", "call", "leader: read marker, then start"],
    ["rt.runmarker", "ext.fs", "fs", "data/server-run.json"],
    ["rt.runmarker", "rt.alerts", "call", "unclean / started notices"],
    ["rt.alerts", "tbl.audit", "sql", "boot alert rows (Alert History)"],
];

// Flow steps: [from, to, action, detail]
const flows = [
    {
        id: "request-lifecycle", name: "Anatomy of an API request", category: "Platform",
        summary: "How any authenticated call travels from a feature view through the 13-step chain, RBAC, cache and Oracle, and how errors and audit rows are produced.",
        steps: [
            ["actor.admin", "fe.spa", "Open a feature page", "e.g. System Admin → Logs."],
            ["fe.spa", "fe.router", "Route guard", "ProtectedRoute checks session + role before rendering."],
            ["fe.http", "edge.chain", "HTTPS request", "GET /api/v1/audit-logs with the access-token cookie (x-csrf-token is attached only to POST/PUT/PATCH/DELETE)."],
            ["edge.chain", "edge.guard", "Abuse guards", "Security filter (step 2) early; IP filter (11) and sliding-window rate limit (12) late."],
            ["edge.chain", "edge.trace", "Trace + measure", "X-Request-Id + ALS (3), audit hook (3a), response time (5), metrics (5a)."],
            ["edge.chain", "edge.csrf", "CSRF check", "Double-submit cookie validated for unsafe methods (step 9)."],
            ["edge.chain", "edge.router", "Mount /api/v1", "Prevent-redirects (13), then routes/index.js."],
            ["edge.router", "edge.auth", "Authenticate", "JWT cookie verified; expired → 440, which the client treats as session end (/login-timeout)."],
            ["svc.wrapper", "db.app", "Acquire a pooled connection", "Interactive appDb pool; exports and purges use appDbBulk instead. A full queue is shed as 429, a dead pool fails fast as 503."],
            ["edge.router", "edge.error", "Error path", "Any thrown AppError / ORA- code is mapped to the sendError shape."],
            ["edge.trace", "tbl.audit", "Persist audit row", "Written after res.end via setImmediate, so latency is unaffected."],
        ],
    },
    {
        id: "login-session", name: "Login & session refresh", category: "Auth",
        summary: "Credential check against the standalone user/admin tables, signature verification, JWT cookies; sessions are extended through the Extend Session prompt (a 440 ends the session).",
        steps: [
            ["actor.user", "fe.spa", "Open /auth", "Public route."],
            ["fe.spa", "fe.router", "Public route", "No guard on /auth."],
            ["fe.router", "fe.auth", "LoginView", "useAuth().login({ username, password })."],
            ["fe.auth", "fe.http", "authApi.login", "HttpClient fetches a CSRF token first if none is cached."],
            ["fe.http", "edge.chain", "POST /auth/login", "withCredentials + x-csrf-token."],
            ["edge.chain", "edge.router", "Through the chain", "Rate limit + CSRF apply to login too."],
            ["edge.router", "api.auth", "Public login route", "AuthService lockout gate: 429 while locked; 423 once max cycles are hit, until an administrator clears it."],
            ["api.auth", "tbl.people", "Look up the account", "T_USERS_DEV or T_ADMINS_DEV: IS_ACTIVE, SYSSIGNATURE check, ROLE."],
            ["api.auth", "svc.crypto", "Verify password", "Argon2id (users) / verifyAdminPassword (admins) after the IS_ACTIVE + SYSSIGNATURE gates."],
            ["api.auth", "edge.router", "Issue tokens", "200 + Set-Cookie app.access-token / app.refresh-token; temp password ⇒ requiresPasswordChange."],
            ["fe.auth", "fe.router", "Land by role", "getLandingPath(role) navigates to the role's home."],
            ["fe.http", "edge.chain", "Session expiry", "Before expiry useSessionWarning offers Extend Session → POST /auth/refresh. A 440 ends the session (sign-out + CSRF clear → /login-timeout); nothing is replayed. Only a CSRF 403 is retried once."],
        ],
    },
    {
        id: "integrity-scan", name: "Integrity tamper sweep (live)", category: "System Admin",
        summary: "SUPER_ADMIN sweeps a table's ROW_HASH signatures in keyset batches; results are cached and pushed live.",
        steps: [
            ["actor.admin", "fe.spa", "Open Data Integrity", "SUPER_ADMIN."],
            ["fe.spa", "fe.router", "Guard", ""],
            ["fe.router", "fe.sysadmin", "IntegrityCenter", ""],
            ["fe.sysadmin", "fe.http", "GET /integrity/tables, /:table/tamper", ""],
            ["fe.http", "edge.chain", "HTTPS", ""],
            ["edge.chain", "edge.router", "Route", ""],
            ["edge.router", "edge.auth", "Authenticate", ""],
            ["edge.auth", "api.integrity", "Tamper feed", ""],
            ["api.integrity", "edge.cache", "Cache check", "TTL 180 s."],
            ["api.integrity", "svc.tamper", "Verify each row", ""],
            ["svc.tamper", "svc.crypto", "HMAC + timingSafeEqual", ""],
            ["fe.sysadmin", "fe.sse", "Open /integrity/stream", ""],
            ["api.integrity", "svc.sse", "Register", ""],
            ["svc.sse", "fe.sse", "Live updates", ""],
        ],
    },
    {
        id: "data-purge", name: "Data purge with mandatory backup", category: "System Admin",
        summary: "Five-step stepper: scope, signed backup, password, phrase, then one atomic purge with drift check, audit and cache flush.",
        steps: [
            ["actor.admin", "fe.spa", "Open Data Management", "SUPER_ADMIN."],
            ["fe.spa", "fe.router", "Guard", ""],
            ["fe.router", "fe.sysadmin", "DataPurge stepper", ""],
            ["fe.sysadmin", "fe.http", "POST /data-purge/preview", ""],
            ["fe.http", "edge.chain", "HTTPS", ""],
            ["edge.chain", "edge.router", "Route", ""],
            ["edge.router", "edge.auth", "Authenticate", ""],
            ["edge.auth", "api.purge", "Resolve scope", "FK closure + confirm phrase."],
            ["api.purge", "db.app", "Count rows", "Interactive appDb pool."],
            ["api.purge", "svc.backup", "POST /backup", "Mandatory before purge."],
            ["svc.backup", "db.appbulk", "Stream tables", "READ ONLY transaction."],
            ["svc.backup", "svc.crypto", "Sign manifest", ".zip = JSONL + xlsx + manifest + HMAC."],
            ["svc.backup", "ext.fs", "Disk copy", "db-backup/."],
            ["svc.backup", "svc.crypto", "Issue token", "Stateless HMAC-signed X-Backup-Token (CryptoVault.signData); no DB row until /execute consumes its jti. Carries the per-table row counts and the high-water PK for append-only log tables."],
            ["api.purge", "svc.crypto", "POST /authorise", "verifyAdminPassword."],
            ["api.purge", "tbl.gov", "POST /execute", "Consume token; lockout window, phrase, acknowledgement checks."],
            ["api.purge", "db.appbulk", "Atomic purge", "Drift re-count (tolerance 0, appDb pool) passed; append-only logs counted only up to the backup high-water. ONE appDbBulk transaction; those logs are deleted only up to the high-water."],
            ["api.purge", "tbl.audit", "Audit row", "Outside the purge transaction."],
            ["api.purge", "edge.cache", "Flush caches", "Every namespace."],
            ["api.purge", "svc.email", "Ops alert", ""],
            ["svc.email", "ext.smtp", "Send", ""],
        ],
    },
    {
        id: "scheduled-backup", name: "Scheduled DB backup", category: "Runtime",
        summary: "Leader-only backup schedule writing a signed archive and emailing subscribers.",
        steps: [
            ["rt.primary", "rt.workers", "Elect leader", ""],
            ["rt.backupsched", "svc.backup", "Run backup", ""],
            ["svc.backup", "db.appbulk", "Stream tables", ""],
            ["svc.backup", "svc.crypto", "Sign", ""],
            ["svc.backup", "ext.fs", "Store archive", ""],
            ["rt.backupsched", "svc.email", "Backup email", "CAN_RECEIVE_DB_BACKUP admins."],
            ["svc.email", "ext.smtp", "Send", ""],
            ["rt.backupsched", "svc.schedstate", "Record dbBackup", ""],
        ],
    },
    {
        id: "observability", name: "Metrics, alerts & logs", category: "System Admin",
        summary: "Per-route metrics roll up to the primary, alerts email subscribers, and admins read metrics, alert history and live logs.",
        steps: [
            ["edge.chain", "edge.trace", "Measure request", "Response time + route-label metrics."],
            ["edge.trace", "rt.alerts", "Feed MetricsStore", ""],
            ["rt.alerts", "rt.rpc", "Merge across workers", ""],
            ["rt.alerts", "svc.email", "Raise alert", "CRIT / DEPS / RED / SYS subscription flags."],
            ["svc.email", "ext.smtp", "Send", ""],
            ["actor.admin", "fe.spa", "Open Logging & Observability", ""],
            ["fe.spa", "fe.router", "Guard", ""],
            ["fe.router", "fe.sysadmin", "LogsManagement / Metrics", ""],
            ["fe.sysadmin", "fe.http", "GET /metrics/summary, /alerts", ""],
            ["fe.http", "edge.chain", "HTTPS", ""],
            ["edge.chain", "edge.router", "Route", ""],
            ["edge.router", "edge.auth", "Authenticate", ""],
            ["edge.auth", "api.metrics", "Metrics", ""],
            ["api.metrics", "rt.alerts", "Read store", ""],
            ["api.metrics", "tbl.audit", "Ack alert", "T_SERVER_ALERT_ACK_DEV."],
            ["edge.auth", "api.audit", "Logs", "Audit search + system log tail."],
            ["api.audit", "svc.logger", "Tail files", ""],
            ["svc.logger", "ext.logs", "Daily-rotated logs", ""],
        ],
    },
    {
        id: "architecture-page", name: "Open the Architecture page", category: "Support",
        summary: "How this map reaches the browser: built in memory by the API, served behind a SUPER_ADMIN-only route, never bundled into the frontend.",
        steps: [
            ["actor.admin", "fe.spa", "Open Support → Architecture", "Nav item exists only in the SUPER_ADMIN block."],
            ["fe.spa", "fe.router", "Guard", "ProtectedRoute SUPER_ADMIN — a convenience, not the control."],
            ["fe.router", "fe.support", "ArchitectureView", "Lazy-loaded route."],
            ["fe.support", "fe.http", "GET /architecture", "architecture.api.js."],
            ["fe.http", "edge.chain", "HTTPS", ""],
            ["edge.chain", "edge.router", "Route", ""],
            ["edge.router", "edge.auth", "Authenticate", ""],
            ["edge.auth", "api.architecture", "requireSuperAdmin → map", "The real gate: every other role gets 403 with no map content. The map is built once per process from architectureModel.js and held in memory."],
        ],
    },
    {
        id: "provision-admin", name: "Provision an admin account", category: "System Admin",
        summary: "A Super Admin (or an Admin, for USER accounts) creates an admin with a temporary password and per-flag permissions; the row is signed.",
        steps: [
            ["actor.admin", "fe.spa", "Open Access Control", "ADMIN or SUPER_ADMIN; an ADMIN may create USER accounts only."],
            ["fe.spa", "fe.router", "Guard", ""],
            ["fe.router", "fe.sysadmin", "AdminManagementView", ""],
            ["fe.sysadmin", "fe.http", "POST /admin-management", "Role + CAN_* flags."],
            ["fe.http", "edge.chain", "HTTPS", ""],
            ["edge.chain", "edge.router", "Route", ""],
            ["edge.router", "edge.auth", "Authenticate", ""],
            ["edge.auth", "api.admin", "Create", ""],
            ["api.admin", "svc.crypto", "Temporary password + SYSSIGNATURE", "bcrypt/argon2 hash wrapped with a 72 h expiry; HMAC SYSSIGNATURE over the admin's fields incl. flags."],
            ["api.admin", "tbl.people", "INSERT T_ADMINS_DEV", ""],
            ["api.admin", "svc.email", "Access email", "Temporary password to the new admin; first login forces a change."],
            ["svc.email", "ext.smtp", "Send", ""],
        ],
    },
    {
        id: "data-restore", name: "Restore from a signed archive", category: "System Admin",
        summary: "A Super Admin restores a verified backup in one appDbBulk transaction; every signed row's original ROW_HASH is verified before it is re-signed.",
        steps: [
            ["actor.admin", "fe.spa", "Open Data Management → Restore", "SUPER_ADMIN."],
            ["fe.spa", "fe.router", "Guard", ""],
            ["fe.router", "fe.sysadmin", "Restore stepper", ""],
            ["fe.sysadmin", "fe.http", "POST /data-purge/restore", "Archive upload + password + confirm phrase."],
            ["fe.http", "edge.chain", "HTTPS", ""],
            ["edge.chain", "edge.router", "Route", ""],
            ["edge.router", "edge.auth", "Authenticate", ""],
            ["edge.auth", "api.purge", "Restore", "Archive HMAC verified before any write."],
            ["api.purge", "svc.backup", "DataRestoreService.restore", "Ordered inserts, identity FK remap of every IDENTITY parent in the archive."],
            ["svc.backup", "db.appbulk", "One restore transaction", ""],
            ["svc.backup", "svc.crypto", "Verify, then re-sign", "Original ROW_HASH verified over the ORIGINAL values; valid → re-signed over the new PK / FKs; invalid or NULL → restored with ROW_HASH NULL, TAMPER_DETECTED, counted in tamperedRowsRestoredUnsigned."],
            ["fe.http", "fe.sysadmin", "Show result", "RestorePanel renders the report; tamperedRowsRestoredUnsigned > 0 ⇒ TamperedRestoreAlert: persistent danger alert with the total, per-table counts and a link to /system-admin/data-integrity."],
        ],
    },
    {
        id: "health-probes", name: "Health probes", category: "Platform",
        summary: "Liveness never touches the database; readiness checks the pools that gate traffic.",
        steps: [
            ["edge.router", "api.platform", "GET /health/live", "Public, rate-limit exempt; 200 with the pid while the process runs."],
            ["edge.router", "api.platform", "GET /health/ready", "503 until every pool answers and every breaker is closed."],
            ["api.platform", "db.app", "appDb pool", "Gates readiness."],
            ["svc.wrapper", "db.app", "Pool health", "The adapter's health monitor and breaker sit underneath every query."],
        ],
    },
    {
        id: "support-docs", name: "Version history and Dev Docs", category: "Support",
        summary: "Release notes are public; the developer docs are served from disk to admins only.",
        steps: [
            ["actor.admin", "fe.spa", "Open Support", ""],
            ["fe.spa", "fe.router", "Guard", "Version History is public; Dev Docs is ADMIN / SUPER_ADMIN."],
            ["fe.router", "fe.support", "Changelog / DevDocs view", ""],
            ["fe.support", "fe.http", "GET /changelog/public, /dev-docs/tree", ""],
            ["fe.http", "edge.chain", "HTTPS", ""],
            ["edge.chain", "edge.router", "Route", ""],
            ["edge.router", "api.support", "Public changelog", "No session needed."],
            ["api.support", "ext.fs", "Read data/changelog.enc", "Changelog and release state live in an AES-256-GCM encrypted JSON file, not a table."],
            ["edge.auth", "api.support", "Dev Docs (admins)", "requireAdminAccess on every /dev-docs route."],
            ["api.support", "ext.fs", "Read dev-docs/*.md", "Served at request time; never bundled into the frontend."],
        ],
    },
    {
        id: "restart-detection", name: "Restart detection & boot emails", category: "System Admin",
        summary: "How the server notices it was killed or lost power, what it emails on every start, and the Alert History row a WARNING or CRITICAL boot email leaves.",
        steps: [
            ["rt.workers", "rt.runmarker", "Leader reads the marker", "Read BEFORE the first write: UNCLEAN (RUNNING/STOPPING), CLEAN, FIRST_BOOT, UNREADABLE or HANDOVER."],
            ["rt.runmarker", "ext.fs", "Write RUNNING, heartbeat 30 s", "Atomic tmp + rename; a synchronous exit hook writes STOPPED (exit code, reason) on every process.exit."],
            ["rt.runmarker", "rt.alerts", "Notices after pool init", "UNCLEAN: one CRITICAL 'restarted without a clean shutdown'. Otherwise 'Server started' (NOTICE/WARNING, at most one per 15 min, but always sent when the previous stop emailed since the last started notice). Forced exit and crash are not re-reported."],
            ["rt.alerts", "svc.email", "Lifecycle email", "notifyLifecycleNow, bounded at 5 s, gated by ENABLE_SERVER_NOTIFICATIONS."],
            ["svc.email", "ext.smtp", "Send", ""],
            ["rt.alerts", "tbl.audit", "Alert History row", "A WARNING or CRITICAL boot email writes one T_SERVER_ALERT_LOG_DEV FIRED row (ALERT_KEY <RULE>::process, the real EMAIL_STATUS, DISABLED when mail is off) after the send settles. NOTICE is never written."],
        ],
    },
];

/** Diagram placement. Every node must appear exactly once (the builder checks). */
const LAYOUT = {
    columns: [
        { layer: "actor", nodes: ["actor.user", "actor.admin"] },
        { layer: "frontend", nodes: ["fe.spa", "fe.router", "fe.http", "fe.sse", "fe.auth", "fe.sysadmin", "fe.support"] },
        { layer: "edge", nodes: ["edge.chain", "edge.guard", "edge.trace", "edge.csrf", "edge.router", "edge.auth", "edge.cache", "edge.error"] },
        { layer: "api", nodes: ["api.platform", "api.auth", "api.admin", "api.integrity", "api.purge", "api.audit", "api.metrics", "api.support", "api.architecture"] },
        { layer: "service", nodes: ["svc.crypto", "svc.tamper", "svc.excel", "svc.email", "svc.sse", "svc.wrapper", "svc.backup", "svc.logger", "svc.schedstate"] },
        { layer: "data", nodes: ["db.app", "db.appbulk", "tbl.people", "tbl.config", "tbl.audit", "tbl.gov"] },
        { layer: "external", nodes: ["ext.smtp", "ext.fs", "ext.logs"] },
    ],
    band: {
        layer: "runtime",
        nodes: [
            { id: "rt.primary", col: 2 },
            { id: "rt.workers", col: 3 },
            { id: "rt.rpc", col: 4 },
            { id: "rt.alerts", col: 5 },
            { id: "rt.backupsched", col: 6 },
            { id: "rt.runmarker", col: 7 },
        ],
    },
};

/** Map-level facts served as `meta` (the builder adds `mapVerifiedAt`). */
const META = {
    title: "Architecture",
    system: "CATHERINE — project-agnostic Express + React template",
    repos: ["Backend", "Frontend"],
    stack: {
        backend: "Node.js, Express 5 (class-based OOP), node-cron, cluster, OracleDB via oracle-mongo-wrapper, ExcelJS, nodemailer, argon2, PKG (.exe, embedded Node 24)",
        frontend: "React 19, Vite, Tailwind CSS v4, axios, Headless UI",
        database: "Oracle — pools appDb (interactive) and appDbBulk (bulk)",
    },
    apiBase: "/api/v1",
    conventions: {
        nodeId: "<layer-prefix>.<name>: actor, fe, edge, api, svc, rt, db/tbl, ext",
        edgeId: "<source>-><target>; direction = initiator → callee (data may flow back on the same edge)",
        flowStep: "edge names the edge used; reverse=true means the step travels the edge backwards (a response or callback)",
        files: "paths are relative to the workspace root that contains Backend/ and Frontend/",
    },
    caveats: [
        "Project modules are folded into their API module node; only cross-cutting services are separate nodes.",
        "Table groups bundle related tables; see each node's subtitle/description for the members.",
    ],
};

module.exports = { MAP_VERIFIED_AT, META, LAYOUT, layers, edgeKinds, nodes, E, flows };

