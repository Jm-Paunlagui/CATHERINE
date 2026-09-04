// Apply encoding polyfills for compiled environment (must be first)
require("./src/utils/encodingPolyfill");

// ─── libuv thread pool sizing (must run before any async I/O) ────────────────
// node-oracledb (Thick mode) executes EVERY database call on a libuv worker
// thread. The default pool of 4 threads serialises concurrent Oracle work:
// with poolMax=20 connections, only 4 queries actually execute at once and the
// rest queue — under a burst of N concurrent requests this inflates P95 by
// roughly N/4 × query-time regardless of how large the connection pool is.
// Size the thread pool to cover the sum of all pool maxima plus headroom for
// fs/crypto/dns work. Must be set before the thread pool is created (first
// async I/O), which is why this cannot live in .env — override it with a real
// OS environment variable when needed. See .env.example for documentation.
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

// ─── Boot guard — fail-fast on placeholder secrets / unsafe config ────────────
// Must run after dotenv.config() but before any app/db requires so the process
// exits before opening pools or listening on a port.
const { validateSecrets } = require("./src/config/bootGuard");
validateSecrets();

const cluster = require("cluster");
const os = require("os");
const http = require("http");
const fs = require("fs");

const { logger } = require("./src/utils/logger");
const { consoleManager } = require("./src/utils/consoleManager");
const { ClusterRole } = require("./src/utils/clusterRole");
const { middlewareMessages } = require("./src/constants/messages");

// ─── Configuration ────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "2106", 10);
const HOST = process.env.HOST || "0.0.0.0";
const USE_HTTPS = process.env.USE_HTTPS === "true";
const ENABLE_CLUSTERING = process.env.ENABLE_CLUSTERING === "true";
const NUM_WORKERS = parseInt(
    process.env.NUM_WORKERS || String(Math.max(1, os.cpus().length)),
    10,
);

// ─── Clustering ───────────────────────────────────────────────────────────────

// cluster.isPrimary (Node >= 16) with isMaster fallback for older runtimes.
const IS_PRIMARY = cluster.isPrimary ?? cluster.isMaster;

if (ENABLE_CLUSTERING && IS_PRIMARY) {
    logger.notice(
        `Primary process ${process.pid} — forking ${NUM_WORKERS} workers…`,
    );

    // ── Cron leader election ────────────────────────────────────────────────
    // Exactly ONE worker runs the scheduled jobs. Without this, every worker
    // would fire the same cron job concurrently — N redundant sweeps against
    // the database.
    //
    // ClusterRole.isCronLeader FAILS CLOSED (see src/utils/clusterRole.js's
    // file header for the full rationale): a worker is leader ONLY when
    // explicitly stamped CRON_LEADER="true". Any job that mutates state
    // unconditionally per tick is not safe to run N times, so a stray
    // duplicate leader is worse than a stray zero-leader gap — but a
    // zero-leader gap is also unacceptable (scheduled jobs would silently
    // never run). Fail-closed alone only trades one silent failure for
    // another; this election is what makes it safe:
    //
    //   - Exactly one live worker is stamped CRON_LEADER="true" at fork.
    //   - `_workerLeaderEnv` tracks the CRON_LEADER value of every LIVE
    //     worker so the "exactly one leader" invariant can be VERIFIED after
    //     every fork/exit, not merely assumed from the code shape.
    //   - The instant the leader worker dies, its replacement inherits
    //     leadership (see the "exit" handler below) — the cluster is never
    //     left leaderless while it can still fork a replacement.
    //   - ClusterRole.electionHealth() (pure) classifies the invariant on
    //     every check; a "critical" verdict (zero OR more than one leader)
    //     is logged via logger.crit so the failure is loud, never silent.
    const _workerLeaderEnv = new Map(); // worker.id -> "true" | "false"
    let cronLeaderId = null;

    const forkWorker = (isCronLeader) => {
        const env = ClusterRole.cronLeaderEnv(isCronLeader);
        const worker = cluster.fork({ CRON_LEADER: env });
        _workerLeaderEnv.set(worker.id, env);
        if (isCronLeader) cronLeaderId = worker.id;
        return worker;
    };

    /**
     * Notifies (out-of-band) of a cron-leader invariant breach immediately.
     *
     * WHY THIS EXISTS — `logger.crit` alone is NOT enough here.
     * `AlertNotifierService.start()` (which subscribes the critical-log tap
     * that turns crit records into notifications) is only called in the
     * WORKER / single-process branch, and only on the cron leader. The
     * primary process never starts it. So a `logger.crit` raised HERE, in the
     * primary, lands in the log file and nowhere else — and "zero cron
     * leaders" is precisely the condition where nobody is watching log files,
     * because the scheduled jobs have silently stopped running.
     *
     * That would defeat the point of failing closed: ClusterRole.isCronLeader
     * now refuses to guess, which trades "duplicate jobs" for "no jobs", and
     * the whole safety of that trade rests on the failure being LOUD.
     *
     * `notifyCriticalNow` is used rather than `start()` on purpose: `start()`
     * also spins up the metrics poller, and running that in the primary as
     * well as the leader worker would duplicate every digest notification.
     * This sends one message and touches nothing else.
     *
     * Fire-and-forget with a swallowed rejection — a failed notification must
     * never crash the primary or block forking. The crit log is already
     * written by the time this runs.
     *
     * @param {string} message
     */
    const _notifyLeaderInvariantBreach = (message) => {
        try {
            const AlertNotifierService = require("./src/services/AlertNotifierService");
            Promise.resolve(
                AlertNotifierService.notifyCriticalNow({
                    level: "CRITICAL",
                    message,
                }),
            ).catch(() => {});
        } catch (_) {
            // Notification subsystem unavailable — the crit log still stands.
        }
    };

    // Verifies the "exactly one cron leader" invariant against the CURRENT
    // set of live workers. The classification itself is pure
    // (ClusterRole.electionHealth) — this wrapper only decides what to DO
    // with the verdict (log / notify).
    const _verifyLeaderInvariant = (context) => {
        const { leaderCount, severity } = ClusterRole.electionHealth([
            ..._workerLeaderEnv.values(),
        ]);
        if (severity !== "critical") {
            const leaderPid = cluster.workers[cronLeaderId]?.process?.pid;
            logger.notice(
                middlewareMessages.CRON_LEADER_ELECTED(
                    cronLeaderId,
                    leaderPid,
                    context,
                ),
            );
        } else if (leaderCount === 0) {
            logger.crit(middlewareMessages.CRON_LEADER_NONE_ELECTED(context));
            _notifyLeaderInvariantBreach(
                middlewareMessages.CRON_LEADER_NONE_ELECTED(context),
            );
        } else {
            logger.crit(
                middlewareMessages.CRON_LEADER_MULTIPLE_ELECTED(
                    context,
                    leaderCount,
                ),
            );
            _notifyLeaderInvariantBreach(
                middlewareMessages.CRON_LEADER_MULTIPLE_ELECTED(
                    context,
                    leaderCount,
                ),
            );
        }
        return leaderCount;
    };

    forkWorker(true); // worker 1 carries the cron schedule
    for (let i = 1; i < NUM_WORKERS; i++) forkWorker(false);
    _verifyLeaderInvariant("initial-fork");

    // ── Cross-worker cache invalidation relay ───────────────────────────────
    // A write handled on one worker must invalidate the in-memory caches of
    // every sibling, or they keep serving stale data until TTL expiry.
    const {
        ClusterCacheSync,
    } = require("./src/middleware/cache/ClusterCacheSync");
    ClusterCacheSync.initPrimary();

    // Fires when a worker's IPC channel disconnects — normally just BEFORE
    // its "exit" event. Logged only for visibility into an unresponsive
    // worker; the actual respawn always happens on "exit" below, so a normal
    // disconnect-then-exit sequence never double-forks a replacement.
    cluster.on("disconnect", (worker) => {
        logger.warning(
            middlewareMessages.CRON_WORKER_DISCONNECTED(
                worker.process.pid,
                worker.id,
            ),
        );
    });

    cluster.on("exit", (worker, code, signal) => {
        const wasCronLeader = worker.id === cronLeaderId;
        _workerLeaderEnv.delete(worker.id);
        if (wasCronLeader) cronLeaderId = null;

        logger.warning(
            middlewareMessages.CRON_WORKER_EXITED(
                worker.process.pid,
                code,
                signal,
                wasCronLeader,
            ),
        );

        try {
            forkWorker(wasCronLeader);
        } catch (err) {
            // The dead worker's slot could not be replaced at all. If it was
            // the cron leader, the cluster now genuinely has zero leaders
            // until the next exit/retry — never let that fail silently.
            logger.crit(
                middlewareMessages.CRON_LEADER_REFORK_FAILED(
                    worker.id,
                    err.message,
                ),
            );
        }
        _verifyLeaderInvariant(`exit:${worker.id}`);
    });
} else {
    // ── Worker / single-process boot ──────────────────────────────────────

    // Initialise console manager (process title, ASCII art, daily clearing)
    consoleManager.initialize();

    const app = require("./src/app");
    const db = require("./src/config");

    // ── Native-module preflight (pkg builds) ──────────────────────────────
    // argon2 loads its prebuilt .node via node-gyp-build, which resolves
    // OUTSIDE the pkg snapshot — a missing/mislocated
    // node_modules\argon2\prebuilds\win32-x64 copy next to the exe would
    // otherwise only surface at the FIRST password verify. Surface it at boot
    // instead. Alert-not-exit: the rest of the API still works; only
    // argon2-hashed credential paths would fail.
    try {
        require("argon2");
        logger.info("Native-module preflight: argon2 loaded successfully.");
    } catch (err) {
        logger.alert(
            "Native-module preflight FAILED: argon2 could not be loaded — " +
                "argon2-hashed credential verification WILL fail. " +
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
            // Write to stderr directly so the message is visible even if the
            // logger transport hasn't flushed yet (common in compiled builds).
            process.stderr.write(`\n[FATAL] ${msg}\n\n`);
            logger.crit(msg);
            process.exit(1);
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

    // Long-running guarded write paths (RetryPolicy/BatchGuard DB retries +
    // awaited EmailProtectionService dispatch) can legitimately exceed Node's
    // default 300s request timeout. Env-driven so consuming apps tune it
    // centrally; if this backend sits behind a reverse proxy (nginx, IIS ARR,
    // etc.), its read/proxy timeout must independently be at least as large.
    const requestTimeoutMs = parseInt(process.env.SERVER_REQUEST_TIMEOUT_MS, 10);
    server.requestTimeout =
        Number.isInteger(requestTimeoutMs) && requestTimeoutMs > 0
            ? requestTimeoutMs
            : 330_000;

    // ─── Start ────────────────────────────────────────────────────────────

    server.listen(PORT, HOST, () => {
        const protocol = USE_HTTPS ? "https" : "http";

        // Server info metadata (like OPTISv2)
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
        // the cron jobs. In single-process mode there is no CRON_LEADER env
        // and the process always schedules.
        const IS_CRON_LEADER = ClusterRole.isCronLeader({
            isWorker: cluster.isWorker,
            cronLeaderEnv: process.env.CRON_LEADER,
        });

        // ── Server email notifications (AlertNotifierService) ──────────────
        // Started BEFORE db.initializePools() — deliberately, not after — so
        // the critical-log tap is already subscribed when a pool-init failure
        // (crit-logged in the .catch() below) fires. Pool init failure is one
        // of the critical-channel triggers; starting the notifier only after a
        // successful init would race that exact event and silently miss it.
        // No-ops (one notice) when ENABLE_SERVER_NOTIFICATIONS is not 'true'.
        // The cron-leader gate keeps exactly one worker notifying in a
        // clustered deployment.
        if (IS_CRON_LEADER) {
            const AlertNotifierService = require("./src/services/AlertNotifierService");
            AlertNotifierService.start();
        } else {
            logger.notice(
                "[AlertNotifierService] Not the cron leader — server email notifications run on the leader worker only.",
            );
        }

        if (typeof db.initializePools === "function") {
            db.initializePools()
                .then(() => {
                    // ── Project-specific scheduled jobs ─────────────────────────────
                    // Add your cron-scheduled jobs here. Only the cron leader runs them.
                    //
                    // Example:
                    //   if (IS_CRON_LEADER) {
                    //     const cron = require("node-cron");
                    //     cron.schedule("0 6 * * *", () => { /* daily job */ }, {
                    //       scheduled: true,
                    //       timezone: "Asia/Manila",
                    //     });
                    //     logger.notice("[Scheduler] Cron jobs scheduled on leader worker.");
                    //   } else {
                    //     logger.notice("[Scheduler] Not the cron leader — scheduled jobs run on the leader worker only.");
                    //   }
                })
                .catch((err) => {
                    logger.crit("Pool initialization failed", {
                        error: err.message,
                        stack: err.stack,
                        type: err.constructor.name,
                        hint: "Pools will retry lazily on first request. Check DB credentials and network connectivity.",
                    });
                });
        }
    });

    // ─── Graceful shutdown ────────────────────────────────────────────────

    let isShuttingDown = false;

    async function gracefulShutdown(signal) {
        if (isShuttingDown) return;
        isShuttingDown = true;

        logger.notice(`${signal} received — shutting down gracefully…`);

        // Stop the alert poller + unsubscribe the critical logger tap.
        // Synchronous — nothing to await here (in-flight sends carry their own
        // SharedTransporter timeout, independent of this shutdown path).
        try {
            const AlertNotifierService = require("./src/services/AlertNotifierService");
            AlertNotifierService.stop();
        } catch (err) {
            logger.warning("AlertNotifierService stop failed during shutdown", {
                error: err.message,
            });
        }

        // Stop accepting new connections
        server.close(async () => {
            logger.notice("HTTP server closed.");

            try {
                // Flush buffered audit records BEFORE closing the pools — batched
                // audit persistence holds up to FLUSH_INTERVAL_MS of records in memory.
                const AuditLogService = require("./src/services/AuditLogService");
                await AuditLogService.flushPending();

                // Close the shared SMTP transporter — the pooled singleton
                // (EMAIL_POOL default true) holds sockets open that keep the
                // Node event loop alive, so without this the process hangs
                // until the forced-exit timer fires below.
                try {
                    const SharedTransporter = require("./src/services/email/SharedTransporter");
                    SharedTransporter.closeTransporter();
                } catch (err) {
                    logger.warning(
                        "SharedTransporter close failed during shutdown",
                        { error: err.message },
                    );
                }

                if (typeof db.shutdown === "function") {
                    await db.shutdown();
                } else if (typeof db.closeAll === "function") {
                    await db.closeAll();
                }
                logger.notice("All resources cleaned up.");
            } catch (err) {
                logger.error("Error during shutdown cleanup", {
                    error: err.message,
                });
            }

            process.exit(0);
        });

        // Force exit after 10 s if graceful shutdown hangs
        setTimeout(() => {
            logger.error("Forced shutdown after timeout.");
            process.exit(1);
        }, 10_000).unref();
    }

    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
    process.on("SIGINT", () => gracefulShutdown("SIGINT"));

    // Fatal-path rule: write to stderr SYNCHRONOUSLY before the logger — the
    // logger's write queue is async and a shutdown that follows immediately
    // loses every queued line, turning a fatal boot error into a silent exit
    // (exactly how compiled exes died with no output).
    process.on("unhandledRejection", async (reason) => {
        const detail =
            reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
        process.stderr.write(`\n[FATAL] Unhandled rejection: ${detail}\n`);
        logger.error("Unhandled rejection", { error: reason });

        // Best-effort critical notification, awaited with its own internal
        // timeout (see AlertNotifierService.notifyCriticalNow) so a hung SMTP
        // send can never delay process exit beyond that ceiling.
        try {
            const AlertNotifierService = require("./src/services/AlertNotifierService");
            await AlertNotifierService.notifyCriticalNow({
                level: "EMERGENCY",
                message: `Unhandled rejection: ${detail}`,
            });
        } catch {
            // Never let a notification failure block the real fatal path.
        }

        gracefulShutdown("unhandledRejection");
    });

    process.on("uncaughtException", async (err) => {
        process.stderr.write(
            `\n[FATAL] Uncaught exception: ${err.stack ?? err.message}\n`,
        );
        logger.error("Uncaught exception", {
            error: err.message,
            stack: err.stack,
        });

        try {
            const AlertNotifierService = require("./src/services/AlertNotifierService");
            await AlertNotifierService.notifyCriticalNow({
                level: "EMERGENCY",
                message: `Uncaught exception: ${err.stack ?? err.message}`,
            });
        } catch {
            // Never let a notification failure block the real fatal path.
        }

        gracefulShutdown("uncaughtException");
    });
}
