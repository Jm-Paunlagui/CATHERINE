/**
 * Oracle Adapter
 * Merges: oracleEnvironment.js + oracleLoader.js + oracleConnectionPool.js
 *
 * Pools are lazy — created on first use, registered by name from database.js.
 * Adding a new DB never requires touching this file.
 *
 * Public API:
 *   withConnection(name, cb)          acquire → run → release
 *   withTransaction(name, cb)         same, wrapped in BEGIN/COMMIT/ROLLBACK
 *   withBatchConnection(name, ops[])  many ops on one shared connection
 *   closeAll()                        graceful shutdown
 *   getPoolStats()                    monitoring snapshot
 *   isPoolHealthy(name)               health probe
 *   getHealthMetrics()                full health object
 *
 * Backward-compatible shorthands (drop-in for old imports):
 *   withDbConnection(cb)      → withConnection('userAccount', cb)
 *   withDbConnectionUnit(cb)  → withConnection('unitInventory', cb)
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { getConnectionConfig, getConnectionNames } = require("../database");
const { RetryPolicy } = require("../../utils/resilience/RetryPolicy");
const { logger } = require("../../utils/logger");
const { oracleMessages } = require("../../constants/messages");
// Leaf-level metrics store (depends only on perf_hooks/v8/os) — cycle-safe to
// require here so the health poll can feed live pool saturation to the dashboard.
const { metricsStore } = require("../../middleware/metrics/MetricsStore");

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — Oracle client environment  (was: oracleEnvironment.js)
// ─────────────────────────────────────────────────────────────────────────────

function validateOracleClient() {
    const clientPath = process.env.ORACLE_INSTANT_CLIENT;
    if (!clientPath) {
        logger.warning(oracleMessages.ORACLE_INSTANT_CLIENT_NOT_SET);
        return false;
    }
    if (!fs.existsSync(clientPath)) {
        logger.warning(oracleMessages.ORACLE_CLIENT_PATH_NOT_FOUND(clientPath));
        return false;
    }

    // Oracle Instant Client ships the core internationalisation DLL under
    // different names across releases:
    //   • v23.x early builds: oraociei.dll   (no version suffix)
    //   • v23.x later builds: oraociei23.dll (versioned suffix)
    // Accept either variant so the validation passes on all 23.x installs.
    const hasCoreDll =
        fs.existsSync(path.join(clientPath, "oraociei23.dll")) ||
        fs.existsSync(path.join(clientPath, "oraociei.dll"));

    const required = ["oci.dll"];
    const missing = required.filter(
        (f) => !fs.existsSync(path.join(clientPath, f)),
    );
    if (!hasCoreDll) missing.push("oraociei23.dll or oraociei.dll");

    if (missing.length) {
        logger.warning(
            oracleMessages.ORACLE_FILES_MISSING(missing, clientPath),
        );
        return false;
    }

    logger.notice(oracleMessages.ORACLE_CLIENT_VALIDATED(clientPath));
    return true;
}

function setupOracleEnvironment() {
    const clientPath = process.env.ORACLE_INSTANT_CLIENT;
    if (!clientPath || !fs.existsSync(clientPath)) return;
    const current = process.env.PATH || "";
    if (!current.includes(clientPath)) {
        process.env.PATH = `${clientPath};${current}`;
        logger.notice(`Oracle client prepended to PATH: ${clientPath}`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — Driver loader  (was: oracleLoader.js)
// ─────────────────────────────────────────────────────────────────────────────

const isCompiled = typeof process.pkg !== "undefined";

function _loadEnvForCompiled() {
    if (!isCompiled) return;
    // .env is read from DISK only — the working directory, then the directory
    // containing the exe. Never reference it via path.join(__dirname, ...):
    // pkg's static analyser resolves that pattern and silently bakes the
    // build machine's .env (real secrets) into every distributed exe
    // (CWE-798/CWE-540 — confirmed by byte-scanning a built binary).
    const candidates = [
        path.join(process.cwd(), ".env"),
        path.join(path.dirname(process.execPath), ".env"),
    ];
    for (const filePath of candidates) {
        if (!fs.existsSync(filePath)) continue;
        try {
            const lines = fs.readFileSync(filePath, "utf8").split("\n");
            for (const line of lines) {
                const trimmed = line.trim();
                if (
                    !trimmed ||
                    trimmed.startsWith("#") ||
                    !trimmed.includes("=")
                )
                    continue;
                const eqIdx = trimmed.indexOf("=");
                const key = trimmed.slice(0, eqIdx).trim();
                const value = trimmed.slice(eqIdx + 1).trim();
                if (!process.env[key]) process.env[key] = value;
            }
            logger.notice(`Env loaded from: ${filePath}`);
            return;
        } catch (err) {
            logger.warning(
                `Could not read .env at ${filePath}: ${err.message}`,
            );
        }
    }
    logger.warning("No .env found in compiled environment.");
}

function _initOracleClient(db) {
    if (db.oracleClientVersion) return;
    const clientPath = process.env.ORACLE_INSTANT_CLIENT;
    const isValid = validateOracleClient();
    try {
        if (isValid && clientPath) {
            db.initOracleClient({ libDir: clientPath });
            logger.notice(
                "Oracle client initialised from ORACLE_INSTANT_CLIENT.",
            );
        } else {
            db.initOracleClient();
            logger.notice("Oracle client initialised from system PATH.");
        }
    } catch (err) {
        if (!err.message.includes("NJS-077"))
            logger.warning(`Oracle client init: ${err.message}`);
    }
}

let oracledb;
try {
    if (isCompiled) {
        logger.notice(
            "Compiled exe detected — bootstrapping Oracle environment.",
        );
        _loadEnvForCompiled();
        setupOracleEnvironment();
    }
    oracledb = require("oracledb");

    // Always attempt Thick mode when ORACLE_INSTANT_CLIENT is set
    // (not just for compiled executables). Thick mode supports all
    // password verifier types; Thin mode rejects some (e.g. 0x939).
    _initOracleClient(oracledb);

    const mode = oracledb.oracleClientVersion ? "Thick" : "Thin";
    logger.notice(`oracledb driver loaded (${mode} mode).`);
} catch (err) {
    logger.critical(`Failed to load oracledb: ${err.message}`);
    throw err;
}

oracledb.fetchArraySize = 1000; // Reduce internal round-trips for bulk reads (default: 100)

const OUT_FORMAT_OBJECT = oracledb.OUT_FORMAT_OBJECT;
const SYSDBA_PRIVILEGE = oracledb.SYSDBA_PRIVILEGE;

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — Pool management  (was: oracleConnectionPool.js)
// ─────────────────────────────────────────────────────────────────────────────

const POOL_DEFAULTS = {
    poolMin: 10,
    poolMax: 50,
    poolIncrement: 5,
    poolTimeout: 30,
    queueTimeout: 15000,
    poolPingInterval: 30,
    connectTimeout: 15000,
    callTimeout: 60000,
    stmtCacheSize: 50,
    homogeneous: true,
    externalAuth: false,
    events: false,
};

// ─────────────────────────────────────────────────────────────────────────────
// MONEY-SAFE FETCH (plan §3.0 rule 3b)
// ─────────────────────────────────────────────────────────────────────────────
// node-oracledb returns a NUMBER as a JavaScript double by default. A
// NUMBER(19,4) money value or a NUMBER(19,8) rate is therefore ALREADY ROUNDED
// before any application code — or the exact-decimal `utils/money.js` type — can
// see it. This handler intercepts every scaled NUMBER column at fetch time and
// asks the driver to hand it back as a STRING, which `Money.from(string)` then
// parses without loss.
//
// SELECTION IS ON `scale > 0`, DERIVED FROM THE SCHEMA — NOT A COLUMN LIST.
//   - money  → NUMBER(19,4) → scale 4 → returned as string ✓
//   - rate   → NUMBER(19,8) → scale 8 → returned as string ✓
//   - IDs, counts, STATUS_CODE → NUMBER (scale 0) → left as JS numbers ✓
// So integer keys and flags keep their ergonomic numeric type; only values that
// actually carry decimals are protected.
//
// BLAST RADIUS IS ZERO ON TODAY'S SCHEMA. CATHERINE declares no scaled NUMBER
// column yet, so this handler is inert until a copier creates a money/rate
// column — at which point it activates automatically. That is exactly why it
// ships now (a dormant guard) rather than later (a behavioural change to live
// code). See the MBA note in plan §3.7.10.
//
// It also means the legacy `convertTypes`/`rowToDoc` helpers in
// `utils/oracle-mongo-wrapper/utils.js` must NOT re-coerce these strings back to
// numbers — they are fenced off there (they would undo this protection).
function moneySafeFetchTypeHandler(metaData) {
    if (metaData.dbType === oracledb.DB_TYPE_NUMBER && metaData.scale > 0) {
        return { type: oracledb.STRING };
    }
    return undefined; // default handling for everything else
}

const EXECUTE_OPTIONS = Object.freeze({
    outFormat: OUT_FORMAT_OBJECT,
    autoCommit: true,
    fetchArraySize: 1000,
    fetchTypeHandler: moneySafeFetchTypeHandler,
});

const poolRegistry = new Map(); // name → Promise<Pool>
let isShuttingDown = false;

// ── Health monitor ────────────────────────────────────────────────────────────

class PoolHealthMonitor {
    constructor() {
        this._metrics = new Map();
        this._maxFailures = 3;
        this._checkIntervalMs = 30_000;
        this._timer = null;
    }

    _ensure(name) {
        if (!this._metrics.has(name))
            this._metrics.set(name, {
                healthy: true,
                lastCheck: null,
                consecutiveFailures: 0,
            });
    }

    async checkPool(name) {
        this._ensure(name);
        const meta = this._metrics.get(name);
        try {
            const pool = await _getOrCreatePool(name);
            const conn = await pool.getConnection();
            await conn.ping();
            await conn.close();
            // USE-method saturation: feed the live pool counters to the metrics
            // store so the observability Dependencies panel and the pool-saturation
            // alert have real data. Counters are read synchronously off the pool
            // object; wrapped so metrics never affect health-checking.
            try {
                metricsStore.recordPoolStats(name, {
                    connectionsInUse: pool.connectionsInUse,
                    connectionsOpen: pool.connectionsOpen,
                    poolMax: pool.poolMax,
                    queueLength: pool.queueLength,
                });
            } catch {
                // Non-fatal — metrics push must never break pool health checks.
            }
            // Log once when a pool recovers after failures to avoid log spam during outages
            if (
                !meta.healthy &&
                meta.consecutiveFailures >= this._maxFailures
            ) {
                logger.notice(
                    oracleMessages.POOL_RECOVERED(
                        name,
                        meta.consecutiveFailures,
                    ),
                );
            }
            meta.healthy = true;
            meta.lastCheck = new Date();
            meta.consecutiveFailures = 0;
        } catch {
            meta.consecutiveFailures++;
            meta.lastCheck = new Date();
            logger.warning(
                oracleMessages.POOL_HEALTH_CHECK_FAILED(
                    name,
                    meta.consecutiveFailures,
                ),
            );
            if (meta.consecutiveFailures >= this._maxFailures) {
                if (meta.healthy) {
                    logger.critical(
                        oracleMessages.POOL_MARKED_UNHEALTHY(
                            name,
                            this._maxFailures,
                        ),
                    );
                }
                meta.healthy = false;
            }
        }
    }

    start() {
        if (this._timer) return;
        this._timer = setInterval(() => {
            for (const name of poolRegistry.keys())
                this.checkPool(name).catch((e) =>
                    logger.warning(`Health check "${name}": ${e.message}`),
                );
        }, this._checkIntervalMs);
        if (this._timer.unref) this._timer.unref();
    }

    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    }

    isHealthy(name) {
        return this._metrics.get(name)?.healthy ?? true;
    }

    getMetrics() {
        const out = {};
        for (const [n, m] of this._metrics) out[n] = { ...m };
        return out;
    }
}

const healthMonitor = new PoolHealthMonitor();
healthMonitor.start();

// ── Pool lifecycle ────────────────────────────────────────────────────────────

function _validateConfig(config, name) {
    const missing = ["user", "password", "connectString"].filter(
        (k) => !config[k],
    );
    if (!missing.length) return;
    const isPlaceholder =
        config.user && String(config.user).includes("placeholder");
    if (process.env.NODE_ENV === "development" && isPlaceholder) {
        logger.warning(
            `Dev mode: placeholder config for "${name}". Missing: ${missing.join(", ")}`,
        );
        return;
    }
    throw new Error(
        `Missing config fields for "${name}": ${missing.join(", ")}`,
    );
}

async function _createPool(name, dbConfig, attempt = 0) {
    const MAX_RETRIES = 3;
    const delay = Math.min(1000 * 2 ** attempt, 10_000);

    _validateConfig(dbConfig, name);

    // Unique alias per attempt to avoid NJS-046 collisions
    const poolAlias = `${name}_pool_${Date.now()}_${attempt}`;
    const config = {
        ...POOL_DEFAULTS,
        ...dbConfig,
        poolAlias,
    };

    // Safe log — no credentials
    const logSafe = { ...config };
    delete logSafe.password;
    delete logSafe.user;
    logger.info(`Creating pool "${name}"…`);

    let pool;
    try {
        if (isCompiled)
            config.connectString = config.connectString
                .replace(/\s+/g, " ")
                .trim();

        pool = await oracledb.createPool(config);
        const conn = await pool.getConnection();
        await conn.ping();
        await conn.close();

        logger.notice(oracleMessages.POOL_READY(name, pool));
        return pool;
    } catch (err) {
        // Destroy the partially-created pool so the alias is freed for retries
        if (pool) {
            try {
                await pool.close(0);
            } catch (_) {
                /* ignore close errors */
            }
        }

        if (attempt < MAX_RETRIES) {
            logger.warning(
                oracleMessages.POOL_FAILED(
                    name,
                    attempt + 1,
                    MAX_RETRIES + 1,
                    err.message,
                ),
            );
            logger.warning(oracleMessages.POOL_RETRYING(name, delay));
            await _sleep(delay);
            return _createPool(name, dbConfig, attempt + 1);
        }
        throw new Error(
            oracleMessages.POOL_COULD_NOT_CREATE(
                name,
                MAX_RETRIES + 1,
                err.message,
            ),
        );
    }
}

function _getOrCreatePool(name) {
    if (isShuttingDown)
        return Promise.reject(
            new Error("App is shutting down — no new connections."),
        );
    if (!poolRegistry.has(name)) {
        const config = getConnectionConfig(name); // throws if name unknown
        poolRegistry.set(name, _createPool(name, config));
    }
    return poolRegistry.get(name);
}

// ── Eager pool initialization ──────────────────────────────────────────────────

/**
 * Pre-create all registered pools at startup.
 * Logs each pool's config (sans credentials) and result.
 * Non-fatal — a pool that fails will retry lazily on first use.
 */
async function initializePools() {
    const names = getConnectionNames();
    logger.notice(
        `Initializing ${names.length} database pool(s): ${names.join(", ")}`,
    );

    const results = [];
    for (const name of names) {
        try {
            const config = getConnectionConfig(name);

            // Log config metadata (no credentials)
            const safeCfg = { ...POOL_DEFAULTS, ...config };
            delete safeCfg.password;
            delete safeCfg.user;
            logger.notice(`Creating ${name} pool with configuration:`, safeCfg);

            const pool = await _getOrCreatePool(name);
            logger.notice(
                `${name} pool created successfully with ${pool.poolMin}-${pool.poolMax} connections`,
            );
            results.push({ name, success: true });
        } catch (err) {
            // Clear registry so the pool can retry lazily on first use
            poolRegistry.delete(name);

            // Structured error with type, hint, and origin
            const isNJS116 = err.message.includes("NJS-116");
            const isNJS046 = err.message.includes("NJS-046");
            const hint = isNJS116
                ? "The DB password verifier is not supported in Thin mode. Set ORACLE_INSTANT_CLIENT in .env to enable Thick mode, or reset the DB user password with a compatible verifier."
                : isNJS046
                  ? "Pool alias collision during retry. The previous pool was not fully cleaned up."
                  : "Check DB credentials, network connectivity, and Oracle client installation.";

            logger.critical(`Failed to initialize pool "${name}"`, {
                error: err.message,
                type: err.constructor.name,
                stack: err.stack,
                hint,
                pool: name,
                environment: process.env.NODE_ENV || "development",
            });
            results.push({ name, success: false, error: err.message });
        }
    }

    const failed = results.filter((r) => !r.success);
    if (failed.length) {
        logger.warning(
            `${failed.length}/${names.length} pool(s) failed to initialize: ${failed.map((f) => f.name).join(", ")}. They will retry on first use.`,
        );
    } else {
        logger.notice(`All ${names.length} pool(s) initialized successfully.`);
    }
    return results;
}

// ── Connection helpers ────────────────────────────────────────────────────────

/** Acquire attempts before a transient connect failure is surfaced to the caller. */
const ACQUIRE_MAX_ATTEMPTS = 3;
/** Base backoff between acquire attempts; doubles per attempt (150ms, 300ms). */
const ACQUIRE_BASE_DELAY_MS = 150;

/**
 * Gets a connection from `pool`, retrying transient CONNECT-time failures.
 *
 * Scope is deliberately the acquire ONLY — never the caller's callback.
 * `withTransaction` routes through `withConnection`, so re-running a callback
 * could replay a partially-applied write; a failed `getConnection()` has by
 * definition executed nothing.
 *
 * This exists because ORA-12516 / ORA-12537 arrive in bursts from the listener
 * (no ready handler, or the server process dies mid-handshake) and clear within
 * milliseconds. One immediate retry on a fresh connection turns those into a
 * served request instead of a 500.
 *
 * The orphan guard matters as much as the retry: `Promise.race` does not cancel
 * the losing promise, so a `getConnection()` that resolves AFTER the timeout
 * fired hands back a connection nobody holds a reference to. It is checked out
 * of the pool and never closed — and `poolTimeout` only reaps IDLE connections,
 * so it is leaked for the process's lifetime. Under exactly the conditions that
 * cause the timeout, that leak compounds until the pool is exhausted.
 *
 * @param {string} connectionName Key from database.js registry (for logs)
 * @param {object} pool           oracledb pool
 * @returns {Promise<object>} An open connection the caller must close.
 */
async function _acquireConnection(connectionName, pool) {
    let lastErr;

    for (let attempt = 1; attempt <= ACQUIRE_MAX_ATTEMPTS; attempt++) {
        const pending = pool.getConnection();
        let timer = null;

        try {
            return await Promise.race([
                pending,
                new Promise((_, reject) => {
                    timer = setTimeout(
                        () =>
                            reject(
                                new Error(
                                    `Timed out getting connection from "${connectionName}"`,
                                ),
                            ),
                        POOL_DEFAULTS.connectTimeout,
                    );
                }),
            ]);
        } catch (err) {
            // Orphan guard — see the note above. Both handlers are attached so
            // a later rejection cannot become an unhandled rejection either.
            pending.then(
                async (conn) => {
                    try {
                        await conn.close();
                        logger.warning(
                            oracleMessages.ACQUIRE_ORPHAN_CLOSED(connectionName),
                        );
                    } catch (e) {
                        logger.warning(
                            oracleMessages.CLOSE_FAILED(connectionName, e.message),
                        );
                    }
                },
                () => {},
            );

            lastErr = err;

            const isLastAttempt = attempt >= ACQUIRE_MAX_ATTEMPTS;
            if (isLastAttempt || !RetryPolicy.isTransientDbError(err)) throw err;

            logger.warning(
                oracleMessages.ACQUIRE_RETRY(
                    connectionName,
                    attempt,
                    ACQUIRE_MAX_ATTEMPTS,
                    err.message,
                ),
            );
            await _sleep(ACQUIRE_BASE_DELAY_MS * 2 ** (attempt - 1));
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    throw lastErr;
}

/**
 * Acquire a connection → run callback → release.
 * @param {string}   connectionName  Key from database.js registry
 * @param {Function} callback        async (conn) => result
 */
async function withConnection(connectionName, callback) {
    if (typeof callback !== "function")
        throw new TypeError("withConnection: callback must be a function.");

    if (!healthMonitor.isHealthy(connectionName))
        logger.warning(
            `Pool "${connectionName}" is unhealthy — attempting anyway.`,
        );

    const pool = await _getOrCreatePool(connectionName);
    const start = Date.now();
    let conn;

    try {
        conn = await _acquireConnection(connectionName, pool);

        const result = await callback(conn);
        const elapsed = Date.now() - start;
        if (elapsed > 5_000)
            logger.warning(oracleMessages.SLOW_OP(connectionName, elapsed));
        return result;
    } catch (err) {
        // An AppError raised deliberately by the callback's own business
        // logic (e.g. a service throwing a 409 inside a withTransaction
        // callback) is NOT an infrastructure failure — it is already fully
        // classified (statusCode/type/details) and ErrorHandlerMiddleware's
        // `if (err.isOperational)` branch (priority 1 in its classifier)
        // exists specifically to short-circuit straight to that shape.
        //
        // Wrapping it in a generic `new Error(DB_OP_FAILED(...))` — as this
        // catch block did for every error, no exception — DISCARDS
        // `isOperational`/`statusCode`/`type`/`details`: the wrapper Error
        // carries none of them (only `originalError`, which nothing upstream
        // unwraps — ErrorHandlerMiddleware classifies the OUTER error object
        // it receives). `_classify` then falls through the AppError branch,
        // finds no ORA-/NJS- code in the message, and returns the generic
        // 500 fallback — turning a deliberate 409 rejection into an opaque
        // server error. This is a general adapter defect: ANY AppError
        // thrown inside a withConnection/withTransaction callback anywhere in
        // the app was silently downgraded to 500 the same way.
        //
        // Genuine infrastructure errors (Oracle driver / ORA-XXXXX / NJS-XXX
        // / pool-acquire timeouts) never carry `isOperational` and are
        // unaffected — they still get wrapped + logged critical exactly as
        // before.
        if (err.isOperational) throw err;

        logger.critical(
            oracleMessages.OP_FAILED(
                connectionName,
                Date.now() - start,
                err.message,
            ),
        );
        throw Object.assign(
            new Error(oracleMessages.DB_OP_FAILED(connectionName, err.message)),
            {
                originalError: err,
                connectionName,
                durationMs: Date.now() - start,
            },
        );
    } finally {
        if (conn) {
            try {
                await conn.close();
            } catch (e) {
                logger.warning(
                    oracleMessages.CLOSE_FAILED(connectionName, e.message),
                );
            }
        }
    }
}

/**
 * Same as withConnection but wrapped in BEGIN / COMMIT / ROLLBACK.
 * @param {string}   connectionName
 * @param {Function} callback  async (conn) => result
 */
async function withTransaction(connectionName, callback) {
    return withConnection(connectionName, async (conn) => {
        try {
            const result = await callback(conn);
            await conn.commit();
            return result;
        } catch (err) {
            try {
                await conn.rollback();
            } catch (e) {
                logger.warning(
                    oracleMessages.ROLLBACK_FAILED(connectionName, e.message),
                );
            }
            throw err;
        }
    });
}

/**
 * Run an array of operations on one shared connection.
 * @param {string}     connectionName
 * @param {Function[]} operations  array of async (conn) => result
 * @returns {Promise<Array<{ success, result?, error?, index }>>}
 */
async function withBatchConnection(connectionName, operations) {
    if (!Array.isArray(operations) || !operations.length)
        throw new TypeError(
            "withBatchConnection: operations must be a non-empty array.",
        );

    return withConnection(connectionName, async (conn) => {
        const FATAL = new Set(["ORA-00028", "ORA-00031"]);
        const results = [];
        for (let i = 0; i < operations.length; i++) {
            if (typeof operations[i] !== "function") {
                results.push({
                    success: false,
                    error: `Op ${i} is not a function.`,
                    index: i,
                });
                continue;
            }
            try {
                results.push({
                    success: true,
                    result: await operations[i](conn),
                    index: i,
                });
            } catch (err) {
                logger.warning(oracleMessages.BATCH_OP_FAILED(i, err.message));
                results.push({ success: false, error: err.message, index: i });
                if (err.code && FATAL.has(err.code)) throw err;
            }
        }
        return results;
    });
}

// ── Stats & monitoring ────────────────────────────────────────────────────────

async function getPoolStats() {
    const stats = {
        timestamp: new Date().toISOString(),
        healthMetrics: healthMonitor.getMetrics(),
        pools: {},
    };
    for (const [name, poolPromise] of poolRegistry) {
        try {
            const pool = await poolPromise;
            const open = pool.connectionsOpen,
                inUse = pool.connectionsInUse;
            const utilPct = open > 0 ? Math.round((inUse / open) * 100) : 0;
            const capPct =
                pool.poolMax > 0 ? Math.round((open / pool.poolMax) * 100) : 0;
            stats.pools[name] = {
                poolMin: pool.poolMin,
                poolMax: pool.poolMax,
                connectionsOpen: open,
                connectionsInUse: inUse,
                connectionsAvailable: Math.max(0, open - inUse),
                queueLength: pool.queueLength,
                utilizationPct: `${utilPct}%`,
                capacityPct: `${capPct}%`,
                isHighUtilization: utilPct > 80,
                isNearCapacity: capPct > 90,
                recommendation:
                    utilPct > 80
                        ? "Increase poolMax"
                        : utilPct < 20
                          ? "Pool oversized"
                          : "Optimal",
            };
        } catch (err) {
            stats.pools[name] = { error: err.message };
        }
    }
    return stats;
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

async function closeAll() {
    if (isShuttingDown) {
        logger.warning(oracleMessages.SHUTDOWN_ALREADY);
        return;
    }
    isShuttingDown = true;
    healthMonitor.stop();
    logger.notice(oracleMessages.CLOSING_ALL_POOLS);
    const closures = [];
    for (const [name, poolPromise] of poolRegistry) {
        closures.push(
            Promise.race([
                poolPromise.then((p) => p.close(10)),
                _timeout(30_000, `Shutdown timeout for "${name}"`),
            ])
                .then(() => logger.notice(oracleMessages.POOL_CLOSED(name)))
                .catch((e) =>
                    logger.warning(
                        oracleMessages.POOL_CLOSE_ERROR(name, e.message),
                    ),
                ),
        );
    }
    await Promise.allSettled(closures);
    poolRegistry.clear();
    logger.notice(oracleMessages.ALL_POOLS_CLOSED);
}

// Signal / exception handlers are in server.js — not duplicated here.

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — Internal utilities
// ─────────────────────────────────────────────────────────────────────────────

function _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
function _timeout(ms, msg) {
    return new Promise((_, reject) =>
        setTimeout(() => reject(new Error(msg)), ms),
    );
}

// Logging helpers are defined at top to avoid TDZ when module initializes

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
    // Core
    withConnection,
    withTransaction,
    withBatchConnection,

    // Pool management
    initializePools,
    closeAll,
    getPoolStats,
    isPoolHealthy: (name) => healthMonitor.isHealthy(name),
    getHealthMetrics: () => healthMonitor.getMetrics(),

    // Environment helpers
    validateOracleClient,
    setupOracleEnvironment,

    // Raw driver & constants
    oracledb,
    OUT_FORMAT_OBJECT,
    SYSDBA_PRIVILEGE,
    EXECUTE_OPTIONS,

    // Exported for unit testing — the money-safe read fence (scale > 0 → STRING).
    moneySafeFetchTypeHandler,
};
