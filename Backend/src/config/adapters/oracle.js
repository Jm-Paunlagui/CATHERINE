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
 * Registered pool names live in `POOL_NAMES` in src/config/database.js — read
 * them from there, never from a doc comment.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const { getConnectionConfig, getConnectionNames } = require("../database");
const { logger } = require("../../utils/logger");
const { oracleMessages } = require("../../constants/messages");
const { RetryPolicy } = require("../../utils/resilience/RetryPolicy");
const { currentScope } = require("../../utils/progress/progress");
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

/**
 * Pool defaults. `connectTimeout` is in MILLISECONDS here (the app's own acquire-race timer uses it
 * as ms); it is converted by {@link toDriverConnectTimeoutSec} before createPool, because node-oracledb
 * reads it as SECONDS. Thick mode ignores it entirely: sqlnet.ora / the connect descriptor govern.
 */
const POOL_DEFAULTS = Object.freeze({
    poolMin: 10,
    poolMax: 50,
    poolIncrement: 5,
    poolTimeout: 30,
    // Safety floor (B6). node-oracledb's own default is 500, which means the
    // queue effectively never sheds and callers pile up unbounded on an
    // exhausted pool until queueTimeout fires one at a time. Any pool that does
    // not set its own queueMax in database.js inherits this bounded floor. Every
    // registry entry SHOULD still set a deliberate per-pool queueMax — the
    // per-pool value overrides this via {...POOL_DEFAULTS, ...dbConfig} in
    // _createPool. This is only the last line of defence for an unconfigured pool.
    queueMax: 40,
    queueTimeout: 15000,
    poolPingInterval: 30,
    connectTimeout: 15000,
    // NOTE: node-oracledb 6.x ignores `callTimeout` in createPool() (it is a
    // CONNECTION property only), so this value does NOT bound single calls. It
    // is kept as documentation of intent; per-call hangs are bounded by the
    // request watchdog (in-flight call progress cap, DB_CALL_PROGRESS_CAP_MS).
    callTimeout: 60000,
    stmtCacheSize: 50,
    homogeneous: true,
    externalAuth: false,
    events: false,
});

// ─────────────────────────────────────────────────────────────────────────────
// MONEY-SAFE FETCH
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
// code).
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
// Every pool name that has ever been requested. The health monitor iterates
// THIS set, not poolRegistry: a pool whose creation failed (and whose registry
// entry was evicted so it can retry) must stay monitored, otherwise it is never
// health-checked, isHealthy() stays true and ORACLE_POOL_DOWN never fires.
const _monitoredNames = new Set();
// How long a rejected pool-creation promise stays cached before the registry
// entry is evicted so the next caller (or the next monitor tick) retries.
const POOL_CREATE_COOLDOWN_MS = 5000;
let isShuttingDown = false;

// ── Health monitor ────────────────────────────────────────────────────────────

/**
 * Pings every monitored pool and drives the circuit breaker in withConnection.
 *
 * Emits `"change"` with `{ name, healthy }` whenever a pool's breaker flips, so
 * the readiness push stream (services/HealthStreamHub.js) can tell clients at once.
 * Cadence: `_checkIntervalMs` while every pool is clean; `_recoveryIntervalMs`
 * while any pool has a failure on record, so an outage is confirmed and a
 * recovery is noticed in seconds rather than in 30 s steps.
 */
class PoolHealthMonitor extends EventEmitter {
    constructor() {
        super();
        this._metrics = new Map();
        this._maxFailures = 3;
        this._checkIntervalMs = 30_000;
        this._recoveryIntervalMs = 5_000;
        // Cadence while a readiness stream is open (services/HealthStreamHub.js):
        // clients are told within seconds, without waiting for traffic.
        this._watchedIntervalMs = 5_000;
        this._watched = false;
        this._timer = null;
        this._stopped = false;
        this._inFlight = new Set();
        this._nudges = new Map();
    }

    /**
     * Sets a pool's breaker state and emits `"change"` when it flips.
     * @param {string} name
     * @param {boolean} healthy
     * @returns {void}
     */
    _setHealthy(name, healthy) {
        this._ensure(name);
        const meta = this._metrics.get(name);
        if (meta.healthy === healthy) return;
        meta.healthy = healthy;
        try {
            this.emit("change", { name, healthy });
        } catch (e) {
            logger.warning(`Pool health listener failed for "${name}": ${e.message}`);
        }
    }

    /**
     * Records a successful bypass-breaker readiness probe. A real `SELECT 1`
     * through the pool is the same evidence a monitor ping gives, so the
     * breaker closes now instead of on the next monitor tick: "ready" must
     * never be reported while withConnection would still fail fast (NJS-503).
     * @param {string} name
     * @returns {void}
     */
    recordProbeSuccess(name) {
        this._ensure(name);
        const meta = this._metrics.get(name);
        if (!meta.healthy) {
            logger.notice(
                oracleMessages.POOL_RECOVERED(name, meta.consecutiveFailures),
            );
        }
        meta.consecutiveFailures = 0;
        meta.lastCheck = new Date();
        this._setHealthy(name, true);
    }

    /** Emits `"check"` `{ name, ok }` after every check; a listener fault never reaches the monitor. */
    _emitCheck(name, ok) {
        try {
            this.emit("check", { name, ok });
        } catch (e) {
            logger.warning(`Pool health listener failed for "${name}": ${e.message}`);
        }
    }

    /** @returns {boolean} true while any monitored pool has a failure on record. */
    _anyFailing() {
        for (const m of this._metrics.values()) {
            if (!m.healthy || m.consecutiveFailures > 0) return true;
        }
        return false;
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
            let conn;
            try {
                conn = await pool.getConnection();
                await conn.ping();
            } finally {
                // Release on every path: a ping that rejects (half-dead network)
                // must not leave the connection checked out, one leak per tick.
                if (conn) {
                    await conn.close().catch((e) =>
                        logger.warning(
                            oracleMessages.CLOSE_FAILED(name, e.message),
                        ),
                    );
                }
            }
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
                    healthy: true,
                    consecutiveFailures: 0,
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
            meta.lastCheck = new Date();
            meta.consecutiveFailures = 0;
            this._setHealthy(name, true);
            this._emitCheck(name, true);
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
                    // O5: ORACLE_POOL_DOWN rule delivers the email; tap must not double-notify
                    logger.critical(
                        oracleMessages.POOL_MARKED_UNHEALTHY(
                            name,
                            this._maxFailures,
                        ),
                        { _noNotify: true },
                    );
                }
                this._setHealthy(name, false);
            }
            this._emitCheck(name, false);
            // The next tick was scheduled before this result arrived; switch
            // to the fast cadence now rather than one slow interval later.
            if (this._timer && !this._stopped && this._gap > this._recoveryIntervalMs) {
                clearTimeout(this._timer);
                this._schedule();
            }
            // O5: feed the failure signal into the metrics store on the catch path
            // too. Without this, ORACLE_POOL_DOWN/DEGRADED can never fire — health
            // state is otherwise only recorded on the success path. Live pool
            // counters are unavailable here (the pool may be down), so zero them
            // and carry only the health/failure signal. Wrapped so metrics never
            // affect health-checking.
            try {
                metricsStore.recordPoolStats(name, {
                    connectionsInUse: 0,
                    connectionsOpen: 0,
                    poolMax: 0,
                    queueLength: 0,
                    healthy: meta.healthy,
                    consecutiveFailures: meta.consecutiveFailures,
                });
            } catch (err) {
                // Non-fatal — metrics push must never break pool health checks.
                // Warning (not critical) and _noNotify: the pool outage's own
                // ORACLE_POOL_DOWN alert already pages ops via the warning above;
                // a metrics-store hiccup during that outage must not itself email.
                logger.warning(
                    oracleMessages.POOL_STATS_RECORD_FAILED(
                        name,
                        err.message,
                    ),
                    { _noNotify: true },
                );
            }
        }
    }

    start() {
        if (this._timer) return;
        this._stopped = false;
        this._schedule();
    }

    /**
     * Self-rescheduling tick: the next gap depends on whether anything is
     * failing or a readiness stream is watching. The tick does not wait for
     * the checks; a pool whose previous check is still running is skipped, so
     * a hung acquire never stacks checks or stalls the other pools.
     */
    _schedule() {
        let gap = this._checkIntervalMs;
        if (this._anyFailing()) gap = this._recoveryIntervalMs;
        else if (this._watched) gap = this._watchedIntervalMs;
        this._gap = gap;
        this._timer = setTimeout(() => {
            for (const name of _monitoredNames) this._runCheck(name);
            if (!this._stopped) this._schedule();
        }, gap);
        if (this._timer.unref) this._timer.unref();
    }

    /** Runs one check unless one is already in flight for `name`. */
    _runCheck(name) {
        if (this._inFlight.has(name)) return;
        this._inFlight.add(name);
        this.checkPool(name)
            .catch((e) => logger.warning(`Health check "${name}": ${e.message}`))
            .finally(() => this._inFlight.delete(name));
    }

    /**
     * Checks `name` soon, outside the regular cadence. Called when a real
     * query hits a connection-class failure, so an outage is confirmed in
     * seconds instead of waiting for the next tick. Debounced per pool.
     * @param {string} name
     * @returns {void}
     */
    nudge(name) {
        if (this._stopped || this._nudges.has(name)) return;
        const t = setTimeout(() => {
            this._nudges.delete(name);
            this._runCheck(name);
        }, 250);
        if (t.unref) t.unref();
        this._nudges.set(name, t);
    }

    stop() {
        this._stopped = true;
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }
        for (const t of this._nudges.values()) clearTimeout(t);
        this._nudges.clear();
    }

    /**
     * While a readiness stream has subscribers, healthy pools are checked
     * every `_watchedIntervalMs` instead of every `_checkIntervalMs`.
     * @param {boolean} watched
     * @returns {void}
     */
    setWatched(watched) {
        const next = Boolean(watched);
        if (this._watched === next) return;
        this._watched = next;
        if (this._timer && !this._stopped) {
            clearTimeout(this._timer);
            this._schedule();
        }
    }

    /** @returns {boolean} true when every monitored pool's breaker is closed. */
    allHealthy() {
        for (const m of this._metrics.values()) if (!m.healthy) return false;
        return true;
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

/**
 * Driver errors that mean "the database cannot be reached" (listener down,
 * connection lost, acquire timed out) rather than a bad statement. Only these
 * nudge the health monitor; an ORA-00942 says nothing about connectivity.
 */
const CONNECTIVITY_ERROR_RE =
    /ORA-(12541|12514|12170|12537|12547|12560|03113|03114|03135|12528|01033|01034|01089)|NJS-(500|501|503|510|521)|DPI-1080|Timed out getting connection/;

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

/**
 * Converts the app's millisecond connect timeout to the whole seconds node-oracledb expects
 * (Thin: sessionAtts `connectTimeout * 1000`). Rounds up, floor 1 s. Non-finite or <= 0 falls
 * back to the POOL_DEFAULTS value. Pure.
 * @param {number} ms - Timeout in milliseconds.
 * @returns {number} Whole seconds, >= 1.
 */
function toDriverConnectTimeoutSec(ms) {
    const n = Number(ms);
    const safeMs = Number.isFinite(n) && n > 0 ? n : POOL_DEFAULTS.connectTimeout;
    return Math.max(1, Math.ceil(safeMs / 1000));
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
    // App config is ms; the driver wants seconds (the acquire race elsewhere stays ms).
    config.connectTimeout = toDriverConnectTimeoutSec(config.connectTimeout);

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

        // A stopping process does not keep retrying: closeAll() would wait
        // its per-pool guard on a creation nobody needs any more.
        if (attempt < MAX_RETRIES && !isShuttingDown) {
            logger.warning(
                oracleMessages.POOL_FAILED(
                    name,
                    attempt + 1,
                    MAX_RETRIES + 1,
                    err.message,
                ),
            );
            logger.warning(oracleMessages.POOL_RETRYING(name, delay));
            await _sleep(_jitter(delay));
            if (isShuttingDown) {
                throw new Error("App is shutting down — no new connections.");
            }
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
        _monitoredNames.add(name);
        const p = _createPool(name, config);
        poolRegistry.set(name, p);
        // A rejected creation must not be cached forever: evict it after a
        // short cool-down so the next caller / monitor tick retries creation.
        p.catch(() => {
            const t = setTimeout(() => {
                if (poolRegistry.get(name) === p) {
                    poolRegistry.delete(name);
                    logger.info(
                        oracleMessages.POOL_CREATE_FAILED_EVICTED(
                            name,
                            POOL_CREATE_COOLDOWN_MS,
                        ),
                    );
                }
            }, POOL_CREATE_COOLDOWN_MS);
            t.unref?.();
        });
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
 * milliseconds — measured 23–488 ms per failure. One immediate retry on a fresh
 * connection turns those into a served request instead of a 500.
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

    // B9 — honour the PER-POOL connectTimeout on the acquire-race timer.
    // `pool.connectTimeout` is not a property node-oracledb exposes on the live
    // pool object, so the timer must read the value back from the registry.
    // Fall back to the POOL_DEFAULTS floor when a pool declares none.
    const cfg = getConnectionConfig(connectionName);
    const connectTimeoutMs = cfg.connectTimeout ?? POOL_DEFAULTS.connectTimeout;

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
                        connectTimeoutMs,
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
            await _sleep(_jitter(ACQUIRE_BASE_DELAY_MS * 2 ** (attempt - 1)));
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    throw lastErr;
}

// ── Progress instrumentation (request watchdog, B-D9) ─────────────────────────
// A pooled connection is instrumented ONCE (Symbol flag — never stacked), and
// each withConnection acquisition binds/unbinds the caller's ProgressScope on
// it. execute / executeMany / commit: refuse to run on an aborted scope (so a
// cut request can never write or commit afterwards), and touch the scope when
// the call returns. Outside a watched context the scope is undefined and the
// wrappers are pass-throughs.
const kInstrumented = Symbol.for("app.progress.instrumented");
const kScope = Symbol.for("app.progress.scope");
const kInflight = Symbol.for("app.progress.inflight");

/**
 * Wrap `execute` / `executeMany` / `commit` on one connection (idempotent).
 * @param {object} conn - node-oracledb Connection.
 * @returns {object} the same connection.
 */
function _instrumentConnection(conn) {
    if (!conn || conn[kInstrumented] || !Object.isExtensible(conn)) return conn;
    for (const method of ["execute", "executeMany", "commit"]) {
        const original = conn[method];
        if (typeof original !== "function") continue;
        conn[method] = function instrumented(...args) {
            // Callback-style call: leave untouched (the codebase is promise-only).
            if (typeof args[args.length - 1] === "function") {
                return original.apply(this, args);
            }
            const scope = conn[kScope];
            if (!scope) return original.apply(this, args);
            return (async () => {
                scope.throwIfAborted();
                conn[kInflight] = (conn[kInflight] || 0) + 1;
                // In-flight call counts as progress for the watchdog (capped).
                const releaseBusy = scope.markBusy();
                try {
                    return await original.apply(this, args);
                } catch (e) {
                    // The watchdog's conn.break() surfaces as ORA-01013: the
                    // cut is the real cause, and it is operational (no critical).
                    if (scope.aborted) throw scope.abortError;
                    throw e;
                } finally {
                    releaseBusy();
                    conn[kInflight] = Math.max(0, (conn[kInflight] || 1) - 1);
                    scope.touch("db");
                }
            })();
        };
    }
    conn[kInstrumented] = true;
    return conn;
}

/**
 * Bind `scope` to `conn` for one acquisition; abort interrupts an in-flight
 * call with `conn.break()`. Returns the release function.
 * @param {object} conn
 * @param {import("../../utils/progress/ProgressScope").ProgressScope|undefined} scope
 * @returns {() => void}
 */
function _bindScope(conn, scope) {
    if (!scope || !Object.isExtensible(conn)) return () => {};
    conn[kScope] = scope;
    const off = scope.onAbort(() => {
        if (conn[kInflight] > 0 && typeof conn.break === "function") {
            Promise.resolve(conn.break()).catch(() => {});
        }
    });
    return () => {
        off();
        conn[kScope] = undefined;
    };
}

/**
 * Acquire a connection → run callback → release.
 * @param {string}   connectionName  Key from database.js registry
 * @param {Function} callback        async (conn) => result
 * @param {object}   [opts]          Optional flags.
 * @param {boolean}  [opts.bypassBreaker=false]  When true, skip the circuit-breaker
 *   health gate and attempt the acquire regardless of pool health. Reserved for
 *   the readiness probe, whose entire job is to report pool health directly.
 */
async function withConnection(connectionName, callback, opts = {}) {
    if (typeof callback !== "function")
        throw new TypeError("withConnection: callback must be a function.");

    // Circuit breaker: once the health monitor has marked a pool unhealthy
    // (repeated ping failures), fail fast instead of piling more acquires onto
    // a dead pool. The NJS-503 token in the message routes this to a 503
    // DatabaseUnavailableError via ErrorHandlerMiddleware's NJS classifier.
    if (!opts.bypassBreaker && !healthMonitor.isHealthy(connectionName)) {
        throw new Error(oracleMessages.POOL_CIRCUIT_OPEN(connectionName));
    }

    // A request the watchdog already cut must not start new DB work. Thrown
    // BEFORE the try/catch below: an operational error, so no critical log.
    const scope = currentScope();
    scope?.throwIfAborted();

    const pool = await _getOrCreatePool(connectionName);
    const start = Date.now();
    let conn;
    let unbindScope = () => {};

    try {
        conn = await _acquireConnection(connectionName, pool);
        // Only wrap when a watched scope exists: outside one (supertest, cron,
        // scripts) the connection is left exactly as the driver returned it.
        if (scope) _instrumentConnection(conn);
        unbindScope = _bindScope(conn, scope);
        scope?.touch("db-acquire");
        scope?.throwIfAborted();

        const result = await callback(conn);
        const elapsed = Date.now() - start;
        if (elapsed > 5_000)
            logger.warning(oracleMessages.SLOW_OP(connectionName, elapsed));
        return result;
    } catch (err) {
        // A deliberate AppError from the callback (e.g. a 409 thrown inside
        // withTransaction) is already classified; wrapping it would downgrade
        // it to a generic 500. Only driver/ORA/NJS failures are wrapped below.
        if (err.isOperational) throw err;

        // A driver error raised because the watchdog cut the request (e.g.
        // ORA-01013 from conn.break()) is the cut, not an infrastructure fault.
        if (scope?.aborted) throw scope.abortError;

        // A connection-class failure on real traffic: check the pool now so
        // the breaker (and the readiness stream) learn of an outage in seconds.
        // A readiness probe (bypassBreaker) is itself a check: no nudge.
        if (!opts.bypassBreaker && CONNECTIVITY_ERROR_RE.test(err?.message || "")) {
            healthMonitor.nudge(connectionName);
        }

        // A readiness probe (bypassBreaker) is unauthenticated: its failures
        // stay off the critical-email tap so callers cannot spend the hourly
        // budget. Outage alerting is delivered by the ORACLE_POOL_DOWN rule.
        logger.critical(
            oracleMessages.OP_FAILED(
                connectionName,
                Date.now() - start,
                err.message,
            ),
            opts.bypassBreaker ? { _noNotify: true } : {},
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
        unbindScope();
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
    _monitoredNames.clear();
    logger.notice(oracleMessages.ALL_POOLS_CLOSED);
}

// Signal / exception handlers are in server.js — not duplicated here.

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — Internal utilities
// ─────────────────────────────────────────────────────────────────────────────

function _sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
/**
 * Full jitter: returns a random value in the half-open interval [0, delayMs).
 * Callers MUST pass the already-capped delay (e.g. `Math.min(base, cap)`) so
 * the cap is preserved — jittering WITHIN the cap keeps the ceiling intact.
 * Never wrap this in a Math.min against the cap; that would reintroduce
 * thundering-herd synchronisation at the ceiling.
 * @param {number} delayMs - The already-capped upper bound for the sleep.
 * @returns {number} A random delay in [0, delayMs).
 */
function _jitter(delayMs) {
    return Math.random() * delayMs;
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
    toDriverConnectTimeoutSec,
    POOL_DEFAULTS,
    withConnection,
    withTransaction,
    withBatchConnection,

    // Pool management
    initializePools,
    closeAll,
    getPoolStats,
    isPoolHealthy: (name) => healthMonitor.isHealthy(name),
    getHealthMetrics: () => healthMonitor.getMetrics(),

    /**
     * TEST-ONLY seam: force a pool's health flag so the circuit-breaker path in
     * withConnection can be exercised deterministically without waiting for real
     * ping failures. Inert in every non-test environment — throws if invoked
     * outside NODE_ENV==="test" so it can never be relied on in production.
     * @param {string} name - Connection/pool name.
     * @param {boolean} healthy - Desired health flag.
     */
    __setPoolHealthForTest: (name, healthy) => {
        if (process.env.NODE_ENV !== "test") {
            throw new Error(
                "__setPoolHealthForTest is a test-only seam and must not be called outside NODE_ENV=test.",
            );
        }
        healthMonitor._setHealthy(name, Boolean(healthy));
    },

    /** Pool breaker state changes: `onPoolHealthChange(fn)` -> unsubscribe. fn gets `{ name, healthy }`. */
    onPoolHealthChange: (fn) => {
        healthMonitor.on("change", fn);
        return () => healthMonitor.off("change", fn);
    },
    /** True when every monitored pool's breaker is closed. */
    allPoolsHealthy: () => healthMonitor.allHealthy(),
    /** Closes `name`'s breaker after a successful bypass-breaker readiness probe. */
    recordProbeSuccess: (name) => healthMonitor.recordProbeSuccess(name),
    /** Checks `name` soon, outside the regular cadence (debounced). */
    nudgePoolHealth: (name) => healthMonitor.nudge(name),
    /** Every health check result: `onPoolHealthCheck(fn)` -> unsubscribe. fn gets `{ name, ok }`. */
    onPoolHealthCheck: (fn) => {
        healthMonitor.on("check", fn);
        return () => healthMonitor.off("check", fn);
    },
    /** Faster health checks while a readiness stream is open. */
    setPoolHealthWatched: (watched) => healthMonitor.setWatched(watched),

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
