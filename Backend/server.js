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

const dotenv = require("dotenv");
dotenv.config({ path: ".env" });

// ─── Boot guard — fail-fast on placeholder secrets / unsafe config ────────────
// Must run after dotenv.config() but before any app/db requires so the process
// exits before opening pools or listening on a port.
const { validateSecrets } = require("./src/config/bootGuard");
validateSecrets();

const cluster = require("cluster");
const os = require("os");
const http = require("http");
const fs = require("fs");
const path = require("path");

const { logger } = require("./src/utils/logger");
const { consoleManager } = require("./src/utils/consoleManager");
const { ClusterRole } = require("./src/utils/clusterRole");

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
    // the database. The jobs should be idempotent, so a duplicate run is
    // wasteful rather than corrupting, but at N workers the waste is substantial.
    // The primary passes CRON_LEADER via the fork environment and re-elects a
    // replacement when the leader dies.
    let cronLeaderId = null;

    const forkWorker = (isCronLeader) => {
        const worker = cluster.fork({
            CRON_LEADER: ClusterRole.cronLeaderEnv(isCronLeader),
        });
        if (isCronLeader) cronLeaderId = worker.id;
        return worker;
    };

    forkWorker(true); // worker 1 carries the cron schedule
    for (let i = 1; i < NUM_WORKERS; i++) forkWorker(false);

    // ── Cross-worker cache invalidation relay ───────────────────────────────
    // A write handled on one worker must invalidate the in-memory caches of
    // every sibling, or they keep serving stale data until TTL expiry.
    const {
        ClusterCacheSync,
    } = require("./src/middleware/cache/ClusterCacheSync");
    ClusterCacheSync.initPrimary();

    cluster.on("exit", (worker, code, signal) => {
        const wasCronLeader = worker.id === cronLeaderId;
        logger.warning(
            `Worker ${worker.process.pid} died (code=${code}, signal=${signal}) — replacing…` +
                (wasCronLeader
                    ? " (was cron leader — replacement takes over)"
                    : ""),
        );
        forkWorker(wasCronLeader);
    });
} else {
    // ── Worker / single-process boot ──────────────────────────────────────

    // Initialise console manager (process title, ASCII art, daily clearing)
    consoleManager.initialize();

    const app = require("./src/app");
    const db = require("./src/config");

    // ─── Server creation ──────────────────────────────────────────────────

    let server;

    if (USE_HTTPS) {
        const https = require("https");
        const certDir = path.join(__dirname, "certs");

        let httpsOptions;

        // Support PFX (PKCS#12) or PEM key+cert
        const pfxPath = path.join(certDir, "server.pfx");
        if (fs.existsSync(pfxPath)) {
            httpsOptions = {
                pfx: fs.readFileSync(pfxPath),
                passphrase: process.env.PFX_PASSPHRASE || "",
            };
            logger.notice("HTTPS: using PFX certificate.");
        } else {
            httpsOptions = {
                key: fs.readFileSync(path.join(certDir, "key.key")),
                cert: fs.readFileSync(path.join(certDir, "cert.crt")),
            };
            logger.notice("HTTPS: using PEM key + cert.");
        }

        server = https.createServer(httpsOptions, app);
    } else {
        server = http.createServer(app);
    }

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

        // Stop accepting new connections
        server.close(async () => {
            logger.notice("HTTP server closed.");

            try {
                // Flush buffered audit records BEFORE closing the pools — batched
                // audit persistence holds up to FLUSH_INTERVAL_MS of records in memory.
                const AuditLogService = require("./src/services/AuditLogService");
                await AuditLogService.flushPending();

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

    process.on("unhandledRejection", (reason) => {
        logger.error("Unhandled rejection", { error: reason });
        gracefulShutdown("unhandledRejection");
    });

    process.on("uncaughtException", (err) => {
        logger.error("Uncaught exception", {
            error: err.message,
            stack: err.stack,
        });
        gracefulShutdown("uncaughtException");
    });
}
