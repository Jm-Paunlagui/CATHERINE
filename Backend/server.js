// Apply encoding polyfills for compiled environment (must be first)
require("./src/utils/encodingPolyfill");

// ─── libuv thread pool sizing (must run before any async I/O) ────────────────
// node-oracledb (Thick mode) executes EVERY database call on a libuv worker
// thread. The default pool of 4 threads serialises concurrent Oracle work:
// only 4 queries actually execute at once and the rest queue — under a burst of
// N concurrent requests this inflates P95 by roughly N/4 × query-time
// regardless of how large the connection pool is. So the thread pool must cover
// the SUM of every connection pool's poolMax, plus headroom for non-DB worker
// use (fs / crypto / dns).
//
// DERIVATION — re-derive this if any poolMax in src/config/database.js changes:
//     SUM(poolMax)  = appDb 20 + appDbBulk 6 = 26
//     + headroom    = 22  (fs / crypto / dns worker-thread work)
//     ────────────────────────────────────────────────────────
//     UV_THREADPOOL_SIZE = 48
//
// This is a STATIC literal on purpose: it must be set before the thread pool is
// created (first async I/O), so it cannot be computed from the pool registry at
// runtime and cannot live in .env. If you change a poolMax, recompute the sum
// above and update this literal by hand. Override with a real OS environment
// variable when needed. See .env.example for documentation.
if (!process.env.UV_THREADPOOL_SIZE) {
    process.env.UV_THREADPOOL_SIZE = "48";
}

// NOTE: "use strict" cannot precede the polyfill require above, so each module
// declares its own strict mode via the "use strict" directive at the top.

// In compiled (pkg) builds resolve .env NEXT TO THE EXE, not the working
// directory — a service/scheduled-task can start the exe with cwd anywhere
// (e.g. System32), and bootGuard reads process.env immediately below.
const path = require("path");
const dotenv = require("dotenv");
dotenv.config({
    path: process.pkg
        ? path.join(path.dirname(process.execPath), ".env")
        : ".env",
});

// ─── Process timezone (must run before ANYTHING constructs a Date) ───────────
// node-oracledb converts DATE / TIMESTAMP columns to JS Dates using the
// PROCESS timezone, and converts them back the same way on write. The schema
// stores LOCAL wall-clock in the deployment's zone, so a process running in
// any other zone reads and writes every timestamp shifted: API dates are off
// by the offset, exact-time scheduler timers (`ev.at.getTime() - Date.now()`)
// fire hours out, and every `new Date()` write lands shifted.
//
// Pinning it here rather than relying on the launch environment means the app
// is correct however it is started — a service, a scheduled task, a bare
// `node server.js`, or a PKG exe on a machine whose clock is set to anything.
// Set APP_TZ to the zone the database's wall-clock values are written in.
//
// Order matters twice over. dotenv runs FIRST so an APP_TZ written in the
// repo/cwd `.env` is honoured (a real OS environment APP_TZ still wins —
// dotenv never overrides). TZ is then assigned before the first Date is
// constructed: neither the polyfill nor dotenv builds one, and Node (>= 13)
// honours a runtime assignment to process.env.TZ, so it takes effect for
// every Date created afterwards.
process.env.TZ = process.env.APP_TZ || "Asia/Manila";

// ─── Boot guard — fail-fast on placeholder secrets / unsafe config ────────────
// Must run after dotenv.config() (above) but before any app/db requires so the process
// exits before opening pools or listening on a port. Also runs validateMoneyConfig.
const { validateSecrets } = require("./src/config/bootGuard");
validateSecrets();

const cluster = require("cluster");
const os = require("os");
const http = require("http");
const fs = require("fs");

const { logger } = require("./src/utils/logger");
const { consoleManager } = require("./src/utils/consoleManager");
const { ClusterRole } = require("./src/utils/clusterRole");
const { serverMessages, clusterMessages } = require("./src/constants/messages");
const { CLUSTER_IPC, BOOT_FATAL_ERROR_CODES } = require("./src/constants/clusterIpc");
const { clusterRpc } = require("./src/utils/cluster/ClusterRpcClient");
const { wireWorkerRpc } = require("./src/utils/cluster/workerRpcWiring");

// ─── Configuration ────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "2108", 10);
const HOST = process.env.HOST || "0.0.0.0";
const USE_HTTPS = process.env.USE_HTTPS === "true";
const ENABLE_CLUSTERING = process.env.ENABLE_CLUSTERING === "true";
const NUM_WORKERS = parseInt(
    process.env.NUM_WORKERS || String(Math.max(1, os.cpus().length)),
    10,
);

// ─── Shutdown timing — the numbers that must move together (D4) ──────────
// Top level (above the cluster branch) so the cluster primary's failsafe is
// derived from the SAME numbers as the worker's. Read as text by
// the invariants below — keep them literals.
//
// SHUTDOWN_REQUEST_WAIT_CAP_MS: absolute cap on how long a
//   stop waits for requests already in progress: 30 min. It is a CEILING, not
//   a wait — a request that stops making progress is cut much earlier by the
//   RequestWatchdog (idle limit per route, src/constants/requestWatchdog.js),
//   and a stop with nothing in flight still exits in about a second.
// FORCED_EXIT_MS: hard failsafe in gracefulShutdown. Default AND maximum:
//   cap + notify drain clamp + reserve + margin (1_800_000 + 15_000 + 13_000
//   + 6_000). Env SHUTDOWN_FORCED_EXIT_MS may only LOWER it, down to
//   FORCED_EXIT_MS_MIN; a lowered value shrinks the request grace with it.
// POST_DRAIN_RESERVE_MS: what everything after the notify drain costs —
//   AuditLogService.flushPending({final}) (≤2 s) + db.closeAll() (~10 s
//   typical; its own 30 s per-pool guard is the backstop) +
//   closeTransporter() + logger.flush() (3 s).
// SHUTDOWN_SAFETY_MARGIN_MS: server.close() callback latency (≤0.5 s) +
//   the shutdown alert emails awaited before the transporter closes
//   (each bounded at 5 s by AlertNotifierService.notifyLifecycleNow).
// NOTIFY_DRAIN_MS: how long the server.close() callback waits for
//   InFlightTaskRegistry-tracked detached work (e.g. a notification batch)
//   BEFORE the Oracle pools and SMTP transporter close. Env-tunable, and
//   clamped so the drain can only ever be LOWERED from the default.
// CLUSTER_SHUTDOWN_MARGIN_MS: the cluster primary's own failsafe is
//   FORCED_EXIT_MS + this, so a worker's failsafe always fires first.
// deploy/winsw/catherine-backend-service.xml <stoptimeout>: must exceed
//   FORCED_EXIT_MS + CLUSTER_SHUTDOWN_MARGIN_MS + the forced-exit email
//   (≤5.5 s) with margin, or Windows force-kills the service mid-drain.
//   Currently 1860 sec.
//
// ⚠ THE INVARIANTS (held by these literals and TeardownSequence.computeShutdownBudget):
//
//   1. FORCED_EXIT_MS_DEFAULT − POST_DRAIN_RESERVE_MS − SHUTDOWN_SAFETY_MARGIN_MS
//        − NOTIFY_DRAIN_MS_CLAMP_MAX === SHUTDOWN_REQUEST_WAIT_CAP_MS
//   2. FORCED_EXIT_MS_MIN − POST_DRAIN_RESERVE_MS − SHUTDOWN_SAFETY_MARGIN_MS
//        >= NOTIFY_DRAIN_MS_CLAMP_MAX
//   3. <stoptimeout> (ms) > FORCED_EXIT_MS_DEFAULT + CLUSTER_SHUTDOWN_MARGIN_MS + 5_500
//
//   The request grace and the drain both end by T0 + phase budget
//   (FORCED_EXIT_MS − reserve − margin); the reserve and margin then fit
//   before the failsafe on every path. An earlier revision shipped a 20 s
//   drain clamp against a 30 s failsafe (20 + 13 > 30): a legal setting
//   that force-killed teardown.
//
// CRASH SCHEDULE: CRASH_REQUEST_GRACE_MS + NOTIFY_DRAIN_MS_CLAMP_MAX +
//   POST_DRAIN_RESERVE_MS + SHUTDOWN_SAFETY_MARGIN_MS = 10 + 15 + 13 + 6 = 44 s.
//   The failsafe is armed at min(FORCED_EXIT_MS, 44 s) on the FIRST crash call
//   (a fresh crash) and pulled in to the same by shortenForCrash when a crash
//   lands during a stop. Shutdown critical-digest flush: phase 1 (criticals
//   only; their rows need the pools) runs before the drain; the lifecycle emails
//   (bounded at 5 s from when they were sent, at the signal) are awaited after
//   db.closeAll() and the STOPPED marker; phase 2
//   runs after db.closeAll() and is bounded by
//   failsafeFireAt - SHUTDOWN_FINAL_LOG_FLUSH_MS; when the failsafe fires the
//   forced-exit email and the final flush run in parallel (<= 5.5 s).
const SHUTDOWN_REQUEST_WAIT_CAP_MS = 1_800_000;
const NOTIFY_DRAIN_MS_CLAMP_MAX = 15_000;
const POST_DRAIN_RESERVE_MS = 13_000;
const SHUTDOWN_SAFETY_MARGIN_MS = 6_000;
const FORCED_EXIT_MS_DEFAULT = 1_834_000;
const FORCED_EXIT_MS_MIN = 35_000;
const CLUSTER_SHUTDOWN_MARGIN_MS = 10_000;

// Floor for the in-flight request grace and the earliest forced socket
// close (lets the SSE `shutdown` frame flush) — the original fixed grace.
const MIN_REQUEST_GRACE_MS = 500;
// After a crash the process is in an undefined state: requests in
// progress get at most this long, so WinSW restarts the service quickly
// instead of after the full grace. A crash that lands DURING a long stop
// shortens the wait to this too (gracefulShutdown below).
const CRASH_REQUEST_GRACE_MS = 10_000;
// logger.flush() default (3 s) + exit latency: the final notifier flush must
// end at least this long before the failsafe fires, or the log tail is lost.
const SHUTDOWN_FINAL_LOG_FLUSH_MS = 3_500;

// ─── Env-clamped shutdown numbers (shared by the primary and the workers) ────
// Computed ABOVE the cluster branch so the primary's failsafe
// (FORCED_EXIT_MS + CLUSTER_SHUTDOWN_MARGIN_MS) honours a lowered
// SHUTDOWN_FORCED_EXIT_MS exactly like a worker does.
const rawForcedExitMs = process.env.SHUTDOWN_FORCED_EXIT_MS;
let FORCED_EXIT_MS =
    rawForcedExitMs === undefined || rawForcedExitMs === ""
        ? FORCED_EXIT_MS_DEFAULT
        : Number(rawForcedExitMs);
if (
    !Number.isFinite(FORCED_EXIT_MS) ||
    FORCED_EXIT_MS < FORCED_EXIT_MS_MIN ||
    FORCED_EXIT_MS > FORCED_EXIT_MS_DEFAULT
) {
    const clamped = Number.isFinite(FORCED_EXIT_MS)
        ? Math.min(Math.max(FORCED_EXIT_MS, FORCED_EXIT_MS_MIN), FORCED_EXIT_MS_DEFAULT)
        : FORCED_EXIT_MS_DEFAULT;
    logger.warning(
        serverMessages.FORCED_EXIT_MS_CLAMPED(rawForcedExitMs, clamped, FORCED_EXIT_MS_MIN, FORCED_EXIT_MS_DEFAULT),
    );
    FORCED_EXIT_MS = clamped;
}
const NOTIFY_DRAIN_MS_DEFAULT = 15_000;
const rawNotifyDrainMs = process.env.NOTIFY_DRAIN_MS;
let NOTIFY_DRAIN_MS =
    rawNotifyDrainMs === undefined
        ? NOTIFY_DRAIN_MS_DEFAULT
        : Number(rawNotifyDrainMs);
if (
    !Number.isFinite(NOTIFY_DRAIN_MS) ||
    NOTIFY_DRAIN_MS < 0 ||
    NOTIFY_DRAIN_MS > NOTIFY_DRAIN_MS_CLAMP_MAX
) {
    const clamped = Number.isFinite(NOTIFY_DRAIN_MS)
        ? Math.min(Math.max(NOTIFY_DRAIN_MS, 0), NOTIFY_DRAIN_MS_CLAMP_MAX)
        : NOTIFY_DRAIN_MS_DEFAULT;
    logger.warning(
        serverMessages.NOTIFY_DRAIN_MS_CLAMPED(rawNotifyDrainMs, NOTIFY_DRAIN_MS_CLAMP_MAX, clamped),
    );
    NOTIFY_DRAIN_MS = clamped;
}

// ─── Clustering ───────────────────────────────────────────────────────────────

// cluster.isPrimary (Node >= 16) with isMaster fallback for older runtimes.
const IS_PRIMARY = cluster.isPrimary ?? cluster.isMaster;

if (ENABLE_CLUSTERING && IS_PRIMARY) {
    // Primary lifecycle (fork + cron-leader election, respawn with backoff and
    // a crash-loop cap, boot-fatal handling, graceful stop of all workers with a
    // bounded failsafe, critical-log relay) lives in ClusterSupervisor. The
    // cron-leader election rationale is in src/utils/clusterRole.js's header.
    // Its failsafe is FORCED_EXIT_MS (clamped above, so a lowered
    // SHUTDOWN_FORCED_EXIT_MS applies) + CLUSTER_SHUTDOWN_MARGIN_MS.
    const { ClusterSupervisor } = require("./src/utils/cluster/ClusterSupervisor");

    // The primary never starts AlertNotifierService (that would duplicate every
    // digest), so a breach / crash-loop / forced-kill is emailed with the
    // one-shot notifyCriticalNow (bounded internally). Lazy require + swallowed
    // failure: a notification problem must never crash or block the primary.
    const notifyCritical = (message) => {
        const AlertNotifierService = require("./src/services/AlertNotifierService");
        return AlertNotifierService.notifyCriticalNow({ level: "CRITICAL", message });
    };

    // Shared-state RPC (rate limiter, security filter, scheduler, metrics,
    // alert ack, recipients). The hub asks the supervisor for
    // live workers / the leader lazily, so it can be built before it.
    const { ClusterRpcHub } = require("./src/utils/cluster/ClusterRpcHub");
    const { PrimaryStateServices } = require("./src/utils/cluster/PrimaryStateServices");
    let supervisor = null;
    const rpcHub = new ClusterRpcHub({
        cluster,
        logger,
        getLiveWorkers: () => supervisor?.getLiveWorkers() ?? [],
        getLeader: () => supervisor?.getLeader() ?? null,
    });
    new PrimaryStateServices({ logger }).attach(rpcHub);

    supervisor = new ClusterSupervisor({
        cluster,
        numWorkers: NUM_WORKERS,
        forcedExitMs: FORCED_EXIT_MS,
        marginMs: CLUSTER_SHUTDOWN_MARGIN_MS,
        logger,
        notifyCritical,
        clusterRole: ClusterRole,
        rpcHub,
    });
    supervisor.start();

    // ── Cross-worker cache invalidation relay ───────────────────────────────
    // A write handled on one worker must invalidate the in-memory caches of
    // every sibling, or they keep serving stale data until TTL expiry.
    const {
        ClusterCacheSync,
    } = require("./src/middleware/cache/ClusterCacheSync");
    ClusterCacheSync.initPrimary();
} else {
    // ── Worker / single-process boot ──────────────────────────────────────

    // Initialise console manager (process title, ASCII art, daily clearing)
    consoleManager.initialize();

    // Env-based, so it is known before listen (unlike the pool-dependent state).
    // True in single-process mode; in a cluster only the worker the primary
    // stamped CRON_LEADER="true". Drives which worker announces the shutdown
    // (ShutdownNotifier `announce`) and which one receives relayed critical logs.
    const IS_CRON_LEADER_AT_BOOT = ClusterRole.isCronLeader({
        isWorker: cluster.isWorker,
        cronLeaderEnv: process.env.CRON_LEADER,
    });

    /** Set once `server.listen` succeeded; boot-fatal reports stop after it. */
    let serverListening = false;

    // ── Restart detection ─────────────────────────────────────────
    // The cron leader keeps data/server-run.json (RUNNING -> STOPPING ->
    // STOPPED, heartbeat every 30 s) so the NEXT boot can tell a clean stop
    // from a kill / power loss and email it (StartupNotifier). Lazy requires
    // on purpose: keeps the import block above untouched. The record is read in
    // the listen callback BEFORE start() overwrites it. See
    // src/utils/lifecycle/ServerRunMarker.js.
    const appVersion = (() => {
        try {
            return require("./package.json").version;
        } catch {
            /* c8 ignore next -- package.json is always bundled */
            return "unknown";
        }
    })();
    let serverRunMarker = null;
    if (IS_CRON_LEADER_AT_BOOT) {
        const ServerRunMarker = require("./src/utils/lifecycle/ServerRunMarker");
        const { SERVER_RUN_MARKER } = require("./src/constants/serverRunMarker");
        const resolvedMarker = ServerRunMarker.resolveMarkerPath();
        if (resolvedMarker.ignoredOverride) {
            logger.warning(
                resolvedMarker.ignoredReason === "production"
                    ? serverMessages.RUN_MARKER_PATH_OVERRIDE_REFUSED(resolvedMarker.ignoredOverride)
                    : serverMessages.RUN_MARKER_PATH_OVERRIDE_IGNORED(resolvedMarker.ignoredOverride),
            );
        }
        serverRunMarker = new ServerRunMarker({
            filePath: resolvedMarker.path,
            // One id per cluster primary run; a lone process gets its own, so
            // only a respawned leader of the SAME cluster run reads HANDOVER.
            runId: process.env[SERVER_RUN_MARKER.CLUSTER_RUN_ID_ENV] || require("crypto").randomUUID(),
            version: appVersion,
            logger,
        });
    }
    /** @type {null | { verdict: string, previous: object|null, lastNoticeAt: number|null, bootedAtMs: number }} */
    let bootInfo = null;
    let bootAnnounced = false;
    /** @type {NodeJS.Timeout|null} Sends the boot email anyway when the pools are slow. */
    let bootAnnounceTimer = null;

    /**
     * Sends the boot email once (leader only), after the pools settle so the
     * recipient resolver can use the DB opt-ins. Fire-and-forget; tracked so a
     * shutdown drains it. Never throws.
     */
    function announceBoot() {
        if (bootAnnounced || !serverRunMarker || !bootInfo) return;
        bootAnnounced = true;
        if (bootAnnounceTimer) clearTimeout(bootAnnounceTimer);
        bootAnnounceTimer = null;
        try {
            const StartupNotifier = require("./src/utils/lifecycle/StartupNotifier");
            const notifier = new StartupNotifier({
                alertNotifier: require("./src/services/AlertNotifierService"),
                logger,
            });
            const sending = notifier
                .announce({
                    verdict: bootInfo.verdict,
                    previous: bootInfo.previous,
                    current: { pid: process.pid, version: appVersion, bootedAtMs: bootInfo.bootedAtMs },
                    lastStartNoticeAt: bootInfo.lastNoticeAt,
                    nowMs: Date.now(),
                })
                .then((res) => {
                    if (res && res.sent && res.event === "started") serverRunMarker.recordStartNotice(Date.now());
                    // Clear only the unclean restarts that were emailed.
                    if (res && res.uncleanReported) serverRunMarker.clearPendingUnclean();
                    else if (res && Array.isArray(res.reportedKeys) && res.reportedKeys.length) serverRunMarker.clearPendingUnclean(res.reportedKeys);
                    // Same for cron-leader losses re-sent late.
                    if (res && Array.isArray(res.reportedLeaderLostKeys) && res.reportedLeaderLostKeys.length) {
                        serverRunMarker.clearPendingLeaderLost(res.reportedLeaderLostKeys);
                    }
                })
                .catch(() => {});
            require("./src/utils/InFlightTaskRegistry").track("startup-notifier", sending);
        } catch (err) {
            logger.warning(serverMessages.STARTUP_NOTIFY_FAILED("announce", err?.message ?? String(err)), {
                _noNotify: true,
            });
        }
    }

    /**
     * Tells the cluster primary this worker cannot start (PFX missing, port
     * taken / denied) so it stops the cluster instead of respawning into the
     * same failure. No-op outside a cluster worker: `done` runs at once.
     * `done` also runs after the IPC write flushes, or after 500 ms at most —
     * a wedged channel must never block the exit.
     *
     * @param {string} code - e.g. "PFX_MISSING", "EADDRINUSE", "EACCES"
     * @param {() => void} done
     */
    function reportBootFatal(code, done) {
        // Boot-only: once this worker is listening, an EACCES/EADDRINUSE is a
        // runtime fault of one worker, not a reason to stop the cluster.
        if (serverListening) {
            done();
            return;
        }
        if (!cluster.isWorker || !process.connected || typeof process.send !== "function") {
            done();
            return;
        }
        let called = false;
        const finish = () => {
            if (called) return;
            called = true;
            done();
        };
        try {
            logger.notice(clusterMessages.CLUSTER_WORKER_BOOT_FATAL_SENT(code));
            process.send({ cmd: CLUSTER_IPC.BOOT_FATAL, code }, finish);
        } catch {
            finish();
            return;
        }
        setTimeout(finish, 500).unref();
    }

    const app = require("./src/app");
    const db = require("./src/config");
    const { isDemoMode } = require("./src/config/demoMode");

    // ── Native-module preflight (pkg builds) ──────────────────────────────
    // argon2 loads its prebuilt .node via node-gyp-build, which resolves
    // OUTSIDE the pkg snapshot — a missing/mislocated
    // node_modules\argon2\prebuilds\win32-x64 copy next to the exe would
    // otherwise only surface at the FIRST admin password verify. Surface it
    // at boot instead. Alert-not-exit: the rest of the API still works; only
    // argon2-hashed credential paths would fail.
    try {
        require("argon2");
        logger.info("Native-module preflight: argon2 loaded successfully.");
    } catch (err) {
        logger.alert(
            "Native-module preflight FAILED: argon2 could not be loaded — " +
                "argon2-hashed admin credential verification WILL fail. " +
                "Ensure node_modules\\argon2\\prebuilds\\win32-x64 sits next " +
                `to the executable (postbuild-copy-natives). ${err.message}`,
        );
    }

    // ─── Server creation ──────────────────────────────────────────────────

    let server;

    if (USE_HTTPS) {
        const https = require("https");
        // Resolve cert directory at runtime — NOT at pkg snapshot time.
        // For compiled (pkg) builds, certs/ sits next to the executable.
        // For normal Node, certs/ sits next to server.js.
        const certDir = path.resolve(
            process.pkg ? path.dirname(process.execPath) : __dirname,
            "certs",
        );

        // PFX (PKCS#12) certificate — filename from env to avoid pkg
        // snapshotting a hardcoded path that may not exist at compile time.
        const pfxFile = process.env.PFX_FILENAME || "server.pfx";
        const pfxPath = path.join(certDir, pfxFile);

        if (!fs.existsSync(pfxPath)) {
            const msg =
                `HTTPS enabled but PFX certificate not found: ${pfxPath}\n` +
                `  Set PFX_FILENAME in .env to match the file in certs/`;
            process.stderr.write(`\n[FATAL] ${msg}\n\n`);
            logger.critical(msg);
            // In a cluster the primary must learn this is fatal, or it would
            // respawn the worker into the same failure (fork storm).
            reportBootFatal("PFX_MISSING", () => process.exit(1));
            return;
        }

        const httpsOptions = {
            pfx: fs.readFileSync(pfxPath),
            passphrase: process.env.PFX_PASSPHRASE || "",
        };
        logger.notice("HTTPS: using PFX certificate.", { path: pfxPath });

        server = https.createServer(httpsOptions, app);
    } else {
        server = http.createServer(app);
    }

    // requestTimeout bounds only how long the server waits to RECEIVE a whole
    // request (headers + body). Node drops the request from its active-parser
    // list once the message is complete, so it NEVER cuts a slow handler —
    // a handler may run past it. Defaults to 330 s (above Node's 300 s) so a
    // slow client upload of a large Excel payload is not cut by the server
    // itself; SERVER_REQUEST_TIMEOUT_MS overrides it. Behind a reverse proxy
    // (nginx, IIS ARR) its read/proxy timeout must independently be at least
    // as large. How long a handler may RUN without progress is the
    // RequestWatchdog's job (below), not this setting.
    const requestTimeoutMs = parseInt(process.env.SERVER_REQUEST_TIMEOUT_MS, 10);
    server.requestTimeout =
        Number.isInteger(requestTimeoutMs) && requestTimeoutMs > 0
            ? requestTimeoutMs
            : 330_000;

    // Progress watchdog: cuts a request that stops making progress (504
    // RequestStalledError). Attached FIRST — `prependListener` — so every
    // request has its progress scope before the Express app or any other
    // request listener runs. The shared IdleWatchdog sweeps all scopes (and
    // the BackupStore's guarded runs), so it starts once here. A server-level
    // listener — the 13-step middleware chain is untouched.
    const { RequestWatchdog } = require("./src/utils/progress/RequestWatchdog");
    const { defaultIdleWatchdog } = require("./src/utils/progress/IdleWatchdog");
    const { resolveIdleLimits } = require("./src/constants/requestWatchdog");
    defaultIdleWatchdog.start();
    new RequestWatchdog({ idleWatchdog: defaultIdleWatchdog }).attach(server);

    // Counts the requests still being answered, so a graceful shutdown can
    // let them finish (src/utils/shutdown/HttpInFlightTracker.js). A
    // server-level listener (after the Express app) — the middleware chain
    // is untouched.
    const HttpInFlightTracker = require("./src/utils/shutdown/HttpInFlightTracker");
    const httpInFlight = new HttpInFlightTracker().attach(server);

    // Failsafe delay for a crash, computed ONCE at boot (not lazily inside
    // gracefulShutdown: armFailsafe must not be preceded by anything that can throw).
    const { computeCrashFailsafeMs, finalNotifyBudgetMs } = require("./src/utils/shutdown/TeardownSequence");
    const CRASH_FAILSAFE_MS = computeCrashFailsafeMs({
        crashGraceMs: CRASH_REQUEST_GRACE_MS,
        notifyDrainClampMs: NOTIFY_DRAIN_MS_CLAMP_MAX,
        postDrainReserveMs: POST_DRAIN_RESERVE_MS,
        safetyMarginMs: SHUTDOWN_SAFETY_MARGIN_MS,
    });

    // ─── Start ────────────────────────────────────────────────────────────

    server.listen(PORT, HOST, () => {
        serverListening = true;
        const protocol = USE_HTTPS ? "https" : "http";

        // Server info metadata
        const serverInfo = {
            protocol,
            host: HOST,
            port: PORT,
            pid: process.pid,
            environment: process.env.NODE_ENV || "development",
            clustering: ENABLE_CLUSTERING ? "enabled" : "disabled",
        };

        logger.notice(
            `Server listening on ${protocol}://${HOST}:${PORT}`,
            serverInfo,
        );

        // Network access information
        if (HOST === "0.0.0.0") {
            logger.notice(
                "Server is accessible from other devices on your local network",
                {
                    localUrl: `${protocol}://localhost:${PORT}`,
                    healthCheck: `${protocol}://localhost:${PORT}/api/v1/health`,
                    networkInfo:
                        "Use your computer's IP address to access from other devices",
                },
            );
        } else {
            logger.notice(`Server bound to specific host: ${HOST}`, {
                url: `${protocol}://${HOST}:${PORT}`,
                healthCheck: `${protocol}://${HOST}:${PORT}/api/v1/health`,
            });
        }

        // ── Eager pool initialization ─────────────────────────────────────
        // Cron leadership: with clustering enabled only the elected leader
        // worker (CRON_LEADER=true, assigned by the primary at fork) schedules
        // the scheduled jobs. In single-process mode there is no CRON_LEADER
        // env and the process always schedules.
        const IS_CRON_LEADER = ClusterRole.isCronLeader({
            isWorker: cluster.isWorker,
            cronLeaderEnv: process.env.CRON_LEADER,
        });

        // ── Server Email Notifications (AlertNotifierService) ───────────────
        // Started BEFORE db.initializePools() — deliberately, not "after" —
        // so the critical-log tap is already subscribed when a pool-init
        // failure (crit-logged in the .catch() below) fires. Pool init
        // failure is one of the documented critical-channel triggers;
        // starting the notifier only after a successful init would race that exact
        // event and silently miss it. No-ops (one notice) when
        // ENABLE_SERVER_NOTIFICATIONS is not 'true'. The cron-leader gate
        // keeps exactly one worker notifying in a clustered deployment.
        if (IS_CRON_LEADER) {
            const AlertNotifierService = require("./src/services/AlertNotifierService");
            AlertNotifierService.start();

            // ── Restart detection ───────────────────────────────────
            // READ the previous process's record FIRST: start() overwrites it.
            if (serverRunMarker) {
                const { SERVER_RUN_MARKER } = require("./src/constants/serverRunMarker");
                const { VERDICTS } = SERVER_RUN_MARKER;
                const bootedAtMs = Date.now();
                const { verdict, previous, cause } = serverRunMarker.readPrevious();
                const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : "unknown");
                if (verdict === VERDICTS.FIRST_BOOT && cause) {
                    logger.notice(serverMessages.RUN_MARKER_FOREIGN_HOST(serverRunMarker.filePath));
                } else if (verdict === VERDICTS.FIRST_BOOT) {
                    logger.info(serverMessages.RUN_MARKER_FIRST_BOOT(serverRunMarker.filePath));
                } else if (verdict === VERDICTS.CLEAN) {
                    logger.info(
                        serverMessages.RUN_MARKER_PREVIOUS_CLEAN(
                            previous.pid,
                            previous.exitCode,
                            previous.stopReason,
                            iso(previous.stoppedAt),
                        ),
                    );
                } else if (verdict === VERDICTS.UNCLEAN) {
                    // error, not critical: the explicit email is the alert; a
                    // critical would send a second one through the critical tap.
                    logger.error(
                        serverMessages.RUN_MARKER_UNCLEAN(
                            previous.pid,
                            previous.state,
                            iso(previous.lastHeartbeatAt),
                            Number.isFinite(previous.lastHeartbeatAt)
                                ? Math.round((bootedAtMs - previous.lastHeartbeatAt) / 1000)
                                : "unknown",
                        ),
                    );
                } else if (verdict === VERDICTS.HANDOVER) {
                    logger.notice(serverMessages.RUN_MARKER_HANDOVER(previous.pid));
                } else {
                    logger.warning(serverMessages.RUN_MARKER_UNREADABLE(serverRunMarker.filePath, cause));
                }
                bootInfo = { verdict, previous, lastNoticeAt: serverRunMarker.lastStartNoticeAt(), bootedAtMs };
                serverRunMarker.start();
                // The boot email waits for the pools so DB opt-in recipients resolve, but
                // never longer than BOOT_ANNOUNCE_MAX_WAIT_MS (a hung pool must not hold it back).
                bootAnnounceTimer = setTimeout(() => {
                    if (bootAnnounced) return;
                    logger.warning(serverMessages.BOOT_ANNOUNCE_POOLS_PENDING(SERVER_RUN_MARKER.BOOT_ANNOUNCE_MAX_WAIT_MS), {
                        _noNotify: true,
                    });
                    announceBoot();
                }, SERVER_RUN_MARKER.BOOT_ANNOUNCE_MAX_WAIT_MS);
                bootAnnounceTimer.unref();
            }
        } else {
            logger.notice(
                "[AlertNotifierService] Not the cron leader — server email notifications run on the leader worker only.",
            );
        }

        // ── Log File Retention (LogRetentionService) ─────────────────────────
        // Deliberately OUTSIDE the db.initializePools() chain below — a DB
        // outage must not suspend the log retention sweep, which only ever
        // touches the filesystem. Cron-leader gate mirrors AlertNotifierService
        // — exactly one worker sweeps in a clustered deployment. No else
        // branch: a non-leader worker simply never arms the sweep, silently,
        // same as AlertNotifierService's notice-only branch would be noise
        // duplicated per worker.
        if (IS_CRON_LEADER) {
            require("./src/services/LogRetentionService").start();
        }

        if (isDemoMode()) {
            // No Oracle in demo mode: no pools, no session reload, no DB backups.
            logger.notice(serverMessages.DEMO_MODE_POOLS_SKIPPED);
            announceBoot();
        } else if (typeof db.initializePools === "function") {
            db.initializePools()
                .then(() => {
                    // Boot email: pools are up, so DB opt-in recipients resolve.
                    announceBoot();

                    // ── Ended sessions ─────────────────────────────────
                    // EVERY process, not only the leader: each keeps its own
                    // in-memory set of ended session families, and a full restart
                    // loses it. Reload the families ended within the access-token
                    // lifetime so a token signed out before this start stays
                    // refused. Best effort, never throws (logs at error level).
                    // A respawned cluster worker also gets the primary's copy on
                    // `listening` (AUTH_SYNC).
                    require("./src/services/AccessRevocationService").loadRecent();

                    // Project-specific scheduled jobs are armed here too, leader only.
                    if (IS_CRON_LEADER) {
                        _scheduleDbBackup();
                    } else {
                        logger.notice(
                            "[Scheduler] Not the cron leader — scheduled jobs run on the leader worker only.",
                        );
                    }
                })
                .catch((err) => {
                    // Still announce the boot: recipients fall back to SERVER_NOTIFY_TO.
                    announceBoot();
                    logger.critical("Pool initialization failed", {
                        error: err.message,
                        stack: err.stack,
                        type: err.constructor.name,
                        hint: "Pools will retry lazily on first request. Check DB credentials and network connectivity.",
                    });
                    // Still arm the schedule — each run retries the pools.
                    if (IS_CRON_LEADER) {
                        _scheduleDbBackup();
                    }
                });
        }
    });

    // ─── Scheduled DB Backup scheduler ────────────────────────────────────────

    /**
     * Schedules the Scheduled DB Backup feature: boot catch-up, exact-time
     * timers and an interval-sweep fallback. Events come from the source a
     * project registers with `BackupScheduleService.registerEventSource()`;
     * with none registered the timers stay idle.
     *
     * 1. Boot catch-up sweep: if `DB_BACKUP_CATCHUP_ON_BOOT !== 'false'`,
     *    runs `_runBackup('boot-catchup')` once via `setImmediate` after
     *    server start — catches a backup missed while the server was down.
     * 2. Exact-time timers, armed from `BackupScheduleService.getUpcomingEvents()`:
     *    each fires `DB_BACKUP_EVENT_DELAY_MS` (default 15 min) AFTER its
     *    event, so the backup never races work the project runs at that
     *    same instant (a snapshot taken mid-job captures a half-finished state).
     * 3. A cron-independent 15-minute interval sweep — plain `setInterval`,
     *    `.unref()`'d (node-cron has silently missed ticks under PKG). It
     *    calls `_runBackup('interval-sweep')` on EVERY tick — safe because
     *    `BackupScheduleService.triggerScheduledBackup` is cheap and fully
     *    idempotent when nothing is due (mutex + filename-derived "already
     *    backed up" check, no DB write).
     *
     * All three paths funnel through the SAME `_runBackup(label)`, which
     * never throws out of itself — every failure is caught, logged, and
     * recorded to `SchedulerStateService` under the `dbBackup` key, then the
     * timers are re-armed regardless of outcome so a failed run never
     * strands the horizon.
     *
     * Skips entirely when `DB_BACKUP_ENABLED === 'false'` — no timers armed,
     * no interval sweep started, no boot catch-up scheduled.
     */
    function _scheduleDbBackup() {
        if (process.env.DB_BACKUP_ENABLED === "false") {
            logger.notice(
                "[DbBackup] DB_BACKUP_ENABLED=false — scheduled DB backup disabled.",
            );
            return;
        }

        const CATCHUP_ON_BOOT =
            process.env.DB_BACKUP_CATCHUP_ON_BOOT !== "false"; // default true
        const EVENT_DELAY_MS =
            parseInt(process.env.DB_BACKUP_EVENT_DELAY_MS, 10) || 900_000; // default 15 min
        // How far ahead timers are armed; the interval sweep re-arms long before it runs out.
        const BACKUP_TIMER_HORIZON_MS = 26 * 60 * 60 * 1000;

        let _backupTimers = [];
        // Only the latest arm installs timers, and old ones are cleared after
        // the event list is fetched (two overlapping arms would duplicate them).
        let _backupArmGeneration = 0;

        async function _armBackupTimers() {
            const gen = ++_backupArmGeneration;
            try {
                const BackupScheduleService = require("./src/services/BackupScheduleService");
                const events = await BackupScheduleService.getUpcomingEvents(BACKUP_TIMER_HORIZON_MS);
                if (gen !== _backupArmGeneration) return; // a newer arm owns the timers
                for (const t of _backupTimers) clearTimeout(t);
                _backupTimers = [];
                for (const ev of events) {
                    const delay = ev.at.getTime() - Date.now() + EVENT_DELAY_MS;
                    if (delay <= 0 || delay > 0x7fffffff) continue;
                    _backupTimers.push(
                        setTimeout(
                            () =>
                                _runBackup(`event:${ev.event}:${ev.eventId}`),
                            delay,
                        ),
                    );
                    logger.notice(
                        `[DbBackup] Exact-time backup timer armed: ${ev.event} (event ${ev.eventId}) fires ${EVENT_DELAY_MS}ms after ${ev.at.toISOString()}.`,
                    );
                }
            } catch (err) {
                logger.warning(
                    `[DbBackup] Failed to arm exact-time backup timers: ${err.message ?? String(err)} — the interval sweep remains the fallback.`,
                );
            }
        }

        // Lazy import to avoid loading the service layer before pools are ready.
        async function _runBackup(label) {
            if (require("./src/utils/InFlightTaskRegistry").isShuttingDown()) return;
            try {
                const BackupScheduleService = require("./src/services/BackupScheduleService");
                const SchedulerStateService = require("./src/services/SchedulerStateService");

                const result =
                    await BackupScheduleService.triggerScheduledBackup(label);
                const status = result.skipped
                    ? "skipped"
                    : result.failed.length > 0
                      ? "error"
                      : "success";
                SchedulerStateService.record("dbBackup", {
                    label,
                    status,
                    detail: result.skipped
                        ? `Scheduled DB backup skipped for label=${label} (${result.skipped}).`
                        : `Scheduled DB backup: ${result.ran.length} ran, ${result.failed.length} failed, ${result.pruned.length} pruned for label=${label}.`,
                });
            } catch (err) {
                logger.error(
                    `[DbBackup][${label}] Error: ${err.message ?? String(err)}`,
                );
                // Lazy import is guarded — if it fails at module load, catch reports it.
                try {
                    const SchedulerStateService = require("./src/services/SchedulerStateService");
                    SchedulerStateService.record("dbBackup", {
                        label,
                        status: "error",
                        detail: err.message ?? String(err),
                    });
                } catch (_) {
                    /* non-fatal — do not mask original error */
                }
            } finally {
                // Re-arm regardless of outcome — a failed run must never
                // strand the exact-time horizon.
                await _armBackupTimers();
            }
        }

        // Boot catch-up sweep
        if (CATCHUP_ON_BOOT) {
            setImmediate(() => _runBackup("boot-catchup"));
        }

        // Arm exact-time timers immediately — covers the case where boot
        // catch-up is disabled or finds nothing due (early return).
        setImmediate(() => _armBackupTimers());

        // ── Cron-independent interval sweep (PKG resilience) ───────────────
        // Plain setInterval, no Intl/timezone machinery (node-cron's timezone
        // option has silently missed ticks under PKG's small-icu). Not gated:
        // a run with nothing due is cheap, and a missed exact-time timer is
        // caught within 15 minutes.
        const BACKUP_SWEEP_CHECK_MS = 15 * 60 * 1000;
        const backupSweepTimer = setInterval(() => {
            _runBackup("interval-sweep");
        }, BACKUP_SWEEP_CHECK_MS);
        // Never keep the process alive just for the sweep.
        if (typeof backupSweepTimer.unref === "function")
            backupSweepTimer.unref();

        logger.notice(
            `[DbBackup] Scheduled DB backup armed — ${EVENT_DELAY_MS}ms post-event delay, ${BACKUP_SWEEP_CHECK_MS / 60000}-minute interval sweep fallback. Boot catch-up: ${CATCHUP_ON_BOOT}.`,
        );
    }

    // ─── Graceful shutdown ────────────────────────────────────────────────

    let isShuttingDown = false;


    // Highest exit code any shutdown trigger asked for. A crash (exit 1) that
    // arrives while a signal-driven shutdown is already running still turns
    // the final exit non-zero, so the WinSW supervisor restarts the service.
    let shutdownExitCode = 0;
    // A crash during a stop raises the exit code
    // AT ONCE (the crash handlers set this before their awaited EMERGENCY email),
    // and that email is tracked so the teardown waits for it before the mail
    // transport closes. shutdownExitCode itself is still raised by the
    // gracefulShutdown re-entry, which keeps shortenForCrash working.
    let crashExitCode = 0;
    const pendingCrashEmails = new Set();
    /** Runs the crash handler's EMERGENCY email, tracked for the teardown. Never throws. */
    const trackCrashEmail = (send) => {
        // A send that did not go out (or threw) is recorded in the marker, inside the tracked
        // promise so the teardown waits for it before the process exits.
        const { isReportedSend } = require("./src/utils/lifecycle/StartupNotifier");
        const p = Promise.resolve()
            .then(send)
            .then(
                (res) => {
                    if (serverRunMarker && !isReportedSend(res)) serverRunMarker.noteStopUnreported();
                },
                () => serverRunMarker?.noteStopUnreported(),
            )
            .catch(() => {});
        pendingCrashEmails.add(p);
        p.finally(() => pendingCrashEmails.delete(p));
        return p;
    };

    // Shared across gracefulShutdown calls so a crash that arrives DURING a
    // long stop (f) can pull the wait and the failsafe in.
    let phaseDeadline = 0;
    let teardownHandle = null;
    let failsafeTimer = null;
    let failsafeFireAt = 0;
    let shutdownT0 = 0;

    const ShutdownNotifier = require("./src/utils/shutdown/ShutdownNotifier");
    // Cluster: `started` comes from the cron leader only (one email, not one per
    // worker); `forcedExit` from any process whose OWN failsafe fires (one
    // per hung worker); `requestsCut` from whichever worker cut.
    const shutdownNotifier = new ShutdownNotifier({
        alertNotifier: require("./src/services/AlertNotifierService"),
        logger,
        announce: IS_CRON_LEADER_AT_BOOT,
    });

    /**
     * @param {string} signal - What triggered the stop (signal name or crash kind)
     * @param {number} [exitCode=0] - 0 for a requested stop, 1 for a crash
     */
    async function gracefulShutdown(signal, exitCode = 0, { unreported = false, reason } = {}) {
        const previousExitCode = shutdownExitCode;
        shutdownExitCode = Math.max(shutdownExitCode, exitCode);
        if (isShuttingDown) {
            // (f) A crash during a long, progress-aware stop: the process is
            // in an undefined state, so the remaining wait shrinks to the
            // crash grace and the failsafe is re-armed accordingly. Once.
            if (exitCode > 0 && previousExitCode === 0) shortenForCrash(signal);
            // Any other path that raises the code after the stop was marked clean.
            // unreported / reason ride along: a primary that vanished during a
            // clean stop is recorded as PRIMARY_DISCONNECT, not as a crash "reported when it happened".
            if (shutdownExitCode > previousExitCode) serverRunMarker?.noteExitCodeRaised(shutdownExitCode, { unreported, reason });
            return;
        }
        isShuttingDown = true;
        // Force exit after FORCED_EXIT_MS if graceful shutdown hangs. Armed
        // FIRST, before anything that could throw synchronously: a later throw
        // rejects this async function (-> unhandledRejection -> re-entry sees
        // isShuttingDown) and would otherwise leave no failsafe at all. The
        // grace and the drain end by phaseDeadline; the reserve + margin
        // (POST_DRAIN_RESERVE_MS + SHUTDOWN_SAFETY_MARGIN_MS) cover teardown —
        // see the timing block at the top. The forced-exit email is bounded at 5 s.
        shutdownT0 = Date.now();
        // A fresh crash (exitCode > 0 on the FIRST call) gets the crash schedule,
        // not the full forced-exit budget; same helper as shortenForCrash.
        const firstArmMs = exitCode > 0 ? Math.min(FORCED_EXIT_MS, CRASH_FAILSAFE_MS) : FORCED_EXIT_MS;
        armFailsafe(firstArmMs);
        if (exitCode > 0) logger.warning(serverMessages.SHUTDOWN_CRASH_FAILSAFE(signal, firstArmMs));
        // Restart marker -> STOPPING. After armFailsafe, never before:
        // the failsafe must be the first thing that can run. Never throws.
        serverRunMarker?.noteStopping(signal, exitCode, { unreported, reason });
        // Early, NON-final audit flush, detached and never awaited: the request
        // wait below can last up to 30 min and a host reboot can kill the
        // process mid-wait, so buffered audit rows are persisted now instead of
        // only at postCloseTeardown (whose final flush stays). `flushPending`
        // never rejects; the catch is belt-and-braces. Detached so it is not
        // refused by any aborted request scope.
        try {
            const AuditLogService = require("./src/services/AuditLogService");
            const { runDetached } = require("./src/utils/progress/progress");
            Promise.resolve(runDetached(() => AuditLogService.flushPending())).catch((err) => {
                logger.warning(serverMessages.SHUTDOWN_EARLY_AUDIT_FLUSH_FAILED(err?.message ?? String(err)));
            });
        } catch (err) {
            logger.warning(serverMessages.SHUTDOWN_EARLY_AUDIT_FLUSH_FAILED(err?.message ?? String(err)));
        }
        // As early as possible — every millisecond earlier here is one more
        // loop iteration inside a tracked background task that breaks cleanly
        // via the cooperative flag instead of being drained or abandoned
        // later (D4).
        try {
            require("./src/utils/InFlightTaskRegistry").beginShutdown();
        } catch (err) {
            logger.warning("InFlightTaskRegistry beginShutdown failed during shutdown", {
                error: err.message,
            });
        }

        logger.notice(`${signal} received — shutting down gracefully…`);

        // Stop the poller + retention sweep; the critical tap stays live until
        // the final flush in postCloseTeardown, so criticals logged during the
        // wait still reach the digest. Synchronous.
        try {
            const AlertNotifierService = require("./src/services/AlertNotifierService");
            AlertNotifierService.beginShutdown();
        } catch (err) {
            logger.warning(serverMessages.SHUTDOWN_NOTIFIER_STEP_FAILED("beginShutdown", err.message));
        }

        try {
            require("./src/services/LogRetentionService").stop();
        } catch (err) {
            logger.warning("LogRetentionService stop failed during shutdown", {
                error: err.message,
            });
        }

        // Drain live SSE streams BEFORE server.close(). An SSE socket is an
        // open, long-lived keep-alive connection with an in-flight response —
        // Node never sees it as "idle", so server.close() waits on it forever
        // and a routine business-hours restart only ever exits via the
        // exit(1) failsafe (defect B1). So: (1) broadcast a terminal `shutdown`
        // event to every registered stream and end them; (2) closeIdleConnections()
        // to drop truly idle keep-alive sockets now; (3) after a short grace,
        // closeAllConnections() to force anything that ignored the shutdown
        // frame. Both socket calls are guarded by typeof for older runtimes.
        // Moved verbatim into src/utils/shutdown/TeardownSequence.js so the
        // ordering can be asserted against the REAL implementation rather than
        // against a synthetic fixture. Same statements, same order, same
        // guards — see that module's header.
        const SseConnectionRegistry = require("./src/utils/sse/SseConnectionRegistry");
        const InFlightTaskRegistry = require("./src/utils/InFlightTaskRegistry");
        const {
            preCloseTeardown,
            postCloseTeardown,
            computeShutdownBudget,
            remainingDrainMs,
        } = require("./src/utils/shutdown/TeardownSequence");

        // Split the forced-exit budget: requests already in progress may
        // finish for up to requestGraceMs; the notify drain (reserved only
        // when there is tracked work to drain) and the grace both end by
        // phaseDeadline, leaving the reserve + margin before the failsafe.
        const t0 = shutdownT0;
        const pendingTasks = InFlightTaskRegistry.size();
        const budget = computeShutdownBudget({
            forcedExitMs: FORCED_EXIT_MS,
            postDrainReserveMs: POST_DRAIN_RESERVE_MS,
            safetyMarginMs: SHUTDOWN_SAFETY_MARGIN_MS,
            notifyDrainMs: NOTIFY_DRAIN_MS,
            pendingTasks,
            minGraceMs: MIN_REQUEST_GRACE_MS,
            maxGraceMs: SHUTDOWN_REQUEST_WAIT_CAP_MS,
        });
        phaseDeadline = t0 + budget.phaseBudgetMs;
        // A fresh crash must not wait out the full phase either.
        if (exitCode > 0) phaseDeadline = Math.min(phaseDeadline, t0 + CRASH_REQUEST_GRACE_MS + NOTIFY_DRAIN_MS);
        const requestGraceMs =
            exitCode === 0
                ? budget.requestGraceMs
                : Math.min(budget.requestGraceMs, CRASH_REQUEST_GRACE_MS);
        logger.notice(
            serverMessages.SHUTDOWN_BUDGET(budget.phaseBudgetMs, requestGraceMs, pendingTasks),
        );

        // A crash already sent its own EMERGENCY email; a requested stop
        // announces itself here.
        if (exitCode === 0) {
            shutdownNotifier.started({
                signal,
                inFlight: httpInFlight.activeCount(),
                graceMs: requestGraceMs,
                pendingTasks,
                idleLimits: resolveIdleLimits(process.env),
            });
        }

        // End SSE streams (an SSE socket is never idle, so server.close()
        // would wait on it forever — defect B1), drop idle keep-alive sockets,
        // let requests in progress finish within the grace, and force-close
        // only what is still running after it (src/utils/shutdown/TeardownSequence.js).
        teardownHandle = preCloseTeardown({
            sseRegistry: SseConnectionRegistry,
            server,
            forceCloseAfterMs: requestGraceMs,
            minGraceMs: MIN_REQUEST_GRACE_MS,
            logger,
            reason: "server_shutdown",
            httpInFlight,
            onRequestsCut: (summary, graceMs, total, opts) =>
                shutdownNotifier.requestsCut(summary, graceMs, total, opts),
        });

        // Stop accepting new connections
        server.close(async () => {
            logger.notice("HTTP server closed.");

            // Bound-drain InFlightTaskRegistry-tracked detached work (today:
            // tracked detached work (e.g. notification batches) BEFORE the Oracle pools and
            // SMTP transporter close (D4 — fixes the ordering hazard where a
            // detached promise could still be racing that teardown
            // unobserved). Deliberately INSIDE the server.close() callback,
            // not before it: the socket must stop accepting new connections
            // first. Never past phaseDeadline, so a long request grace cannot
            // push the drain into the reserve. Silent + free when nothing is
            // tracked — see InFlightTaskRegistry.drain()'s own JSDoc.
            await postCloseTeardown({
                inFlight: InFlightTaskRegistry,
                auditLog: require("./src/services/AuditLogService"),
                db,
                sharedTransporter: require("./src/services/email/SharedTransporter"),
                logger,
                // Evaluated after phase 1 (up to 5 s), never past phaseDeadline.
                notifyDrainMs: () =>
                    remainingDrainMs({
                        phaseDeadline,
                        now: Date.now(),
                        notifyDrainMs: NOTIFY_DRAIN_MS,
                    }),
                // The buffered-critical flush runs before the drain (its rows need
                // the pools); the shutdown emails (bounded at 5 s, inside
                // SHUTDOWN_SAFETY_MARGIN_MS) are awaited only after the audit flush
                // and the pool close, then the final flush.
                // The shutdown emails, plus any crash EMERGENCY email still on its
                // way (a crash during the stop), before the transporter closes.
                lifecycleSettled: async () => {
                    await shutdownNotifier.settled();
                    while (pendingCrashEmails.size) await Promise.allSettled([...pendingCrashEmails]);
                },
                // Records saved and pools closed: mark the stop clean now, so a host
                // reboot that cuts the remaining email wait (up to 5 s) is not
                // reported as "restarted without a clean shutdown".
                onDataTeardownComplete: () => serverRunMarker?.noteTeardownComplete(Math.max(shutdownExitCode, crashExitCode)),
                alertNotifier: require("./src/services/AlertNotifierService"),
                finalNotifyMs: () =>
                    finalNotifyBudgetMs({
                        failsafeFireAt,
                        now: Date.now(),
                        reserveMs: SHUTDOWN_FINAL_LOG_FLUSH_MS,
                    }),
            });

            // A crash during the stop wins even if its gracefulShutdown re-entry has
            // not run yet (it awaits the EMERGENCY email first).
            const finalExitCode = Math.max(shutdownExitCode, crashExitCode);
            logger.notice(serverMessages.SHUTDOWN_EXITING(signal, finalExitCode));

            // Drain the logger's async write queue before exiting. logger.*
            // returns before its fs.appendFile lands, so exiting on the next
            // tick can silently drop the shutdown banner that
            // deploy/winsw/README.md tells operators to check for when
            // verifying a graceful service stop. Bounded internally, so a
            // wedged disk cannot block the stop.
            await logger.flush();

            // A crash DURING that flush already wrote
            // exit 1 / CRASH into the marker; exit with it too, never the 0 computed
            // above, and give its tracked EMERGENCY email (each bounded at 5 s; the
            // failsafe stays armed) the same wait the teardown gives it.
            // The wait is capped by the time left before the failsafe: running
            // into it would add a "Shutdown hung" email and
            // record FORCED_EXIT instead of CRASH. 1 s stays for the flush + exit.
            if (Math.max(shutdownExitCode, crashExitCode) > finalExitCode) {
                const waitMs = Math.max(0, failsafeFireAt - Date.now() - 1_000);
                let capTimer;
                const cap = new Promise((resolve) => {
                    capTimer = setTimeout(resolve, waitMs);
                    capTimer.unref?.();
                });
                const crashEmails = (async () => {
                    while (pendingCrashEmails.size) await Promise.allSettled([...pendingCrashEmails]);
                })();
                await Promise.race([crashEmails, cap]);
                clearTimeout(capTimer);
                await logger.flush(500);
            }
            process.exit(Math.max(shutdownExitCode, crashExitCode));
        });
    }

    /**
     * Final, bounded critical-digest flush (never persists, never throws).
     * Single-flight in the service, so it is safe if postCloseTeardown already ran it.
     * Bounded by the service's own 5 s limit. Known, accepted: when phase 2 was
     * skipped (no time left) and closeTransporter() already ran, this send makes
     * SharedTransporter.getTransporter() build a fresh pooled transporter; it is
     * bounded by the same 5 s race and the process exits right after. SharedTransporter
     * keeps no "closed" flag (null = never created or closed), so it cannot be skipped cheaply.
     * @returns {Promise<void>}
     */
    function drainAlertNotifierForExit() {
        try {
            return Promise.resolve(
                require("./src/services/AlertNotifierService").drainAndStop({ persist: false }),
            ).catch(() => {});
        } catch {
            return Promise.resolve();
        }
    }

    /**
     * (Re)arms the hard exit(1) failsafe to fire `ms` after shutdown began.
     * Keeps a single timer: a re-arm replaces it.
     * @param {number} ms
     */
    function armFailsafe(ms) {
        if (failsafeTimer) clearTimeout(failsafeTimer);
        failsafeFireAt = shutdownT0 + ms;
        failsafeTimer = setTimeout(() => {
            // Marker: remember FORCED_EXIT (already emailed below) so the next
            // boot does not raise a second CRITICAL. Sync, never throws.
            serverRunMarker?.noteForcedExit(ms);
            logger.error(serverMessages.SHUTDOWN_FORCED_EXIT(ms));
            // The forced-exit email and the final critical flush leave in
            // parallel (each <= 5 s), so the pair costs <= 5.5 s with the log flush.
            Promise.allSettled([
                // A forced-exit email that did not go out (or timed out) is recorded so the next
                // "Server started" notice says so. The require sits inside the promise so a
                // throw can only reject this entry, never skip process.exit below.
                Promise.resolve(shutdownNotifier.forcedExit(ms)).then((res) => {
                    const { isReportedSend } = require("./src/utils/lifecycle/StartupNotifier");
                    if (serverRunMarker && !isReportedSend(res)) serverRunMarker.noteStopUnreported();
                }),
                drainAlertNotifierForExit(),
            ])
                // Best-effort flush so the forced-shutdown reason itself
                // reaches the log file; short budget — already over time.
                .finally(() => logger.flush(500))
                .finally(() => process.exit(1));
        }, Math.max(0, failsafeFireAt - Date.now()));
        failsafeTimer.unref();
    }

    /**
     * (f) A crash arrived while a graceful stop was already waiting on
     * requests: cut the wait to CRASH_REQUEST_GRACE_MS, pull the drain
     * deadline in and move the failsafe to
     * CRASH_FAILSAFE_MS (grace + drain clamp + reserve + margin, computed by
     * computeCrashFailsafeMs) from now (never later than the existing one). Exit code stays 1 via shutdownExitCode.
     * @param {string} signal
     */
    function shortenForCrash(signal) {
        try {
            const now = Date.now();
            teardownHandle?.shortenTo(CRASH_REQUEST_GRACE_MS);
            phaseDeadline = Math.min(phaseDeadline, now + CRASH_REQUEST_GRACE_MS + NOTIFY_DRAIN_MS);
            const crashFireAt = now + CRASH_FAILSAFE_MS;
            if (failsafeTimer && crashFireAt < failsafeFireAt) armFailsafe(crashFireAt - shutdownT0);
            logger.warning(serverMessages.SHUTDOWN_GRACE_SHORTENED_CRASH(signal, CRASH_REQUEST_GRACE_MS));
        } catch (err) {
            logger.warning(serverMessages.SHUTDOWN_SHORTEN_FAILED(err.message));
        }
    }

    // The idle watchdog fires its hook on EVERY termination; only a cut made
    // while the process is stopping belongs in the shutdown "requests cut"
    // email, so the shutdown state is checked here.
    RequestWatchdog.setShutdownHook((entry) => {
        if (isShuttingDown) teardownHandle?.recordIdleCut(entry);
    });

    // ── Cluster worker IPC (cluster workers only) ──────────────────────────
    if (cluster.isWorker) {
        // Primary asks for a graceful stop (its SIGTERM/SIGINT/SIGBREAK, or a
        // boot-fatal sibling). gracefulShutdown is idempotent, so a Windows
        // console Ctrl+C that ALSO reaches this worker is harmless.
        // The same channel carries relayed critical logs to the cron leader.
        // Shared-state RPC endpoint (its own listener; cluster workers only).
        clusterRpc.init({ isLeader: IS_CRON_LEADER_AT_BOOT });
        wireWorkerRpc({ client: clusterRpc, isLeader: IS_CRON_LEADER_AT_BOOT });

        process.on("message", (m) => {
            if (!m || typeof m !== "object") return;
            if (m.cmd === CLUSTER_IPC.SHUTDOWN) {
                gracefulShutdown(m.signal ?? "SIGTERM");
            } else if (m.cmd === CLUSTER_IPC.CRIT_RELAY && IS_CRON_LEADER_AT_BOOT) {
                try {
                    require("./src/services/AlertNotifierService").ingestRelayedCritical(m.record);
                } catch (err) {
                    logger.warning(clusterMessages.CLUSTER_RELAY_INGEST_FAILED(err.message), {
                        _noNotify: true,
                    });
                }
            }
        });

        // Primary died. Node's own cluster `disconnect` listener (registered
        // before ours) calls process.exit(0) UNLESS worker.exitedAfterDisconnect
        // is true — a silent exit with no pool close and no audit flush. Setting
        // the flag (Node internals, lib/internal/cluster/child.js; verified on
        // Node 24, pinned by sim 19q-4) hands the decision to us: stop
        // gracefully, exit code 1 so the supervisor treats it as abnormal.
        cluster.worker.exitedAfterDisconnect = true;
        process.on("disconnect", () => {
            logger.warning(clusterMessages.CLUSTER_PRIMARY_DISCONNECT());
            // unreported: no email goes out for this stop, so the next boot must not claim one did.
            gracefulShutdown("PRIMARY_DISCONNECT", 1, { unreported: true, reason: require("./src/constants/serverRunMarker").SERVER_RUN_MARKER.STOP_REASONS.PRIMARY_DISCONNECT });
        });

        // Non-leader workers: their critical logs would never be emailed (the
        // AlertNotifierService tap runs on the leader only). Relay them via the
        // primary to the leader, which feeds the same digest + hourly cap.
        if (!IS_CRON_LEADER_AT_BOOT) {
            require("./src/utils/cluster/critRelay").subscribeCriticalRelay(logger, process);
        }
    }

    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
    process.on("SIGINT", () => gracefulShutdown("SIGINT"));
    // Windows service stop: WinSW/Windows deliver console control events,
    // not POSIX signals — Node maps Ctrl+C → SIGINT and Ctrl+Break →
    // SIGBREAK (SIGTERM never fires on Windows). Handling SIGBREAK too means
    // a service stop that arrives as Ctrl+Break still runs the graceful path
    // (pool close + audit flush) inside WinSW's 1860 sec stoptimeout window
    // (deploy/winsw/catherine-backend-service.xml).
    process.on("SIGBREAK", () => gracefulShutdown("SIGBREAK"));

    // Fatal-path rule: write to stderr SYNCHRONOUSLY before the logger — the
    // logger's write queue is async and a shutdown that follows immediately
    // loses every queued line, turning a fatal boot error (e.g. EADDRINUSE)
    // into a silent exit in compiled exes.
    process.on("unhandledRejection", async (reason) => {
        const detail =
            reason instanceof Error
                ? (reason.stack ?? reason.message)
                : String(reason);
        process.stderr.write(`\n[FATAL] Unhandled rejection: ${detail}\n`);
        // Before the awaited email: the crash must reach the exit code and the marker
        // now, not after up to 5 s.
        crashExitCode = 1;
        serverRunMarker?.noteExitCodeRaised(1);
        logger.error("Unhandled rejection", { error: reason });

        // Best-effort critical notification, awaited with its own internal
        // timeout (see AlertNotifierService.notifyCriticalNow) so a hung SMTP
        // send can never delay process exit beyond that ceiling.
        try {
            const AlertNotifierService = require("./src/services/AlertNotifierService");
            await trackCrashEmail(() =>
                AlertNotifierService.notifyCriticalNow({
                    level: "EMERGENCY",
                    message: `Unhandled rejection: ${detail}`,
                }),
            );
        } catch (_) {
            // Never let a notification failure block the real fatal path.
        }

        gracefulShutdown("unhandledRejection", 1);
    });

    process.on("uncaughtException", async (err) => {
        process.stderr.write(
            `\n[FATAL] Uncaught exception: ${err.stack ?? err.message}\n`,
        );
        // Before the awaited email.
        crashExitCode = 1;
        serverRunMarker?.noteExitCodeRaised(1);
        // Port taken / denied: every respawn would fail the same way. Tell the
        // primary FIRST (before the awaited email below) so it stops forking.
        if (cluster.isWorker && BOOT_FATAL_ERROR_CODES.includes(err?.code)) {
            reportBootFatal(err.code, () => {});
        }
        logger.error("Uncaught exception", {
            error: err.message,
            stack: err.stack,
        });

        try {
            const AlertNotifierService = require("./src/services/AlertNotifierService");
            await trackCrashEmail(() =>
                AlertNotifierService.notifyCriticalNow({
                    level: "EMERGENCY",
                    message: `Uncaught exception: ${err.stack ?? err.message}`,
                }),
            );
        } catch (_) {
            // Never let a notification failure block the real fatal path.
        }

        gracefulShutdown("uncaughtException", 1);
    });
}
