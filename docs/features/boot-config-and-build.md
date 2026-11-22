# Boot Sequence, Configuration & the Bun Build — Technical Documentation

> **Scope:** how the CATHERINE template starts — from the first `require` in `server.ts`, through env loading and the fail-fast boot guard, clustering and cron-leader election, server creation and graceful shutdown — and how it is compiled to a single Windows executable with `bun build --compile`, including the templates and native binaries staged beside it.
> **Source:** `Backend/server.ts` (the surface-root entry point — **not** `src/`), `Backend/src/config/` (`index.js`, `bootGuard.js`, `database.js`, `demoMode.js`, `adapters/oracle.js`), `Backend/src/utils/runtimePaths.ts`, and `Backend/scripts/build.js`.
> **Generated:** 2026-09-04; build and runtime sections revised 2026-11-21 for the move from Node + pkg to Bun. **Authority:** the code. Where `Backend/CLAUDE.md` disagrees with the code, the code wins and the disagreement is recorded in [§9.1](#91-known-documentation-drift).
> **Rendering:** the ```mermaid fences below render in GitHub, GitLab, Obsidian and VS Code preview. A plain Markdown→PDF path (Chrome "print to PDF") prints them as code — pre-render with `bunx @mermaid-js/mermaid-cli` if you need a PDF.

---

## 1. Overview

`Backend/server.ts` is the process entry point (`package.json` `"main": "server.ts"`, `"bin"` → `./server.ts`, `scripts/build.js` compiles from `server.ts`). It runs on Bun (`bun server.ts`). It is deliberately at the surface root, not under `src/`. (Until 2026-11 a pkg-only `encodingPolyfill` was required first; Bun ships full ICU, so it was removed.)

`server.ts` is an ES module, and ES modules evaluate every import before the importing file's body. So the boot-order steps below do not live in `server.ts`'s body: they are two side-effect modules imported first, in this order — `src/config/bootEnv.ts` (thread pool, `.env`, `TZ`) and `src/config/bootSecrets.ts` (boot guard). Imports evaluate in source order, so both finish before any other module is evaluated.

The first ordering-critical step (`bootEnv.ts`): before any async I/O can create the libuv thread pool, it sizes that pool: if `UV_THREADPOOL_SIZE` is unset it is set to `"48"`. This is because `node-oracledb` in Thick mode runs **every** database call on a libuv worker thread, and the default pool of four threads would serialise concurrent Oracle work no matter how large the connection pool is. The value must be set before the first async I/O creates the pool, which is why it lives in code and not `.env` — a real OS environment variable can override it.

Only then does `bootEnv.ts` load `.env` — from **next to the executable** in the compiled exe (`IS_COMPILED ? appPath(".env") : ".env"`, from `src/utils/runtimePaths.ts`), because a service or scheduled task can launch the exe with its working directory anywhere (e.g. `System32`). Immediately after, `bootSecrets.ts` runs the **boot guard** (`validateSecrets()`), which fails the process closed in production if any secret is missing, too short, or still a template placeholder.

From there the process either forks a cluster of workers (with a single elected cron leader) or boots a single worker directly: it initialises the console manager, requires the Express `app` and the config adapter, runs a native-module preflight for `argon2`, creates an HTTP or HTTPS server, listens, eagerly initialises the Oracle pools (lazily-retried on failure), and installs graceful-shutdown and fatal-error handlers.

The whole thing is shipped as one `.exe` via `bun build --compile --target=bun-windows-x64` into `dist/` (`scripts/build.js`), which then stages beside the exe the email templates, the dev-docs freshness snapshot and the native `.node` addons (`oracledb`, `argon2`) the exe reads from disk at runtime.

---

## 2. Flow & Architecture

### 2.1 Boot sequence

```mermaid
flowchart TD
    start(["bun server.ts / catherine-backend.exe"]) --> uv["bootEnv.ts: if !UV_THREADPOOL_SIZE → set '48'<br/>(before first async I/O)"]
    uv --> env["dotenv.config()<br/>path = compiled ? next-to-exe/.env : ./.env"]
    env --> guard["bootSecrets.ts: validateSecrets() — boot guard"]
    guard -->|"prod + violation"| exit1["stderr banner + logger.crit → process.exit(1)"]
    guard -->|"dev + violation"| warn["logger.warning (startup continues)"]
    guard -->|"clean"| clusterQ{"ENABLE_CLUSTERING<br/>&& isPrimary?"}
    warn --> clusterQ

    clusterQ -->|"yes"| primary["PRIMARY: fork NUM_WORKERS workers<br/>1 stamped CRON_LEADER=true<br/>ClusterCacheSync.initPrimary()<br/>verify 'exactly one leader'"]
    primary --> respawn["on worker exit → refork<br/>(inherit leadership if leader died)"]

    clusterQ -->|"no"| worker["WORKER / single process"]
    primary -.->|"each fork boots"| worker

    worker --> console["consoleManager.initialize()"]
    console --> reqapp["require('./src/app')<br/>require('./src/config')"]
    reqapp --> preflight["native preflight: require('argon2')<br/>(alert-not-exit on failure)"]
    preflight --> httpsQ{"USE_HTTPS?"}
    httpsQ -->|"yes"| pfx["resolve certs/ under APP_ROOT (exe dir or Backend)<br/>read PFX_FILENAME → https.createServer"]
    httpsQ -->|"no"| http["http.createServer(app)"]
    pfx --> timeout["server.requestTimeout = SERVER_REQUEST_TIMEOUT_MS || 330000"]
    http --> timeout
    timeout --> listen["server.listen(PORT, HOST)"]
    listen --> leaderQ{"IS_CRON_LEADER?"}
    leaderQ -->|"yes"| notifier["AlertNotifierService.start()<br/>(before pool init — catch pool-fail crit)"]
    leaderQ -->|"no"| skip["notice: notifications on leader only"]
    notifier --> pools["db.initializePools()<br/>.catch → crit + lazy retry"]
    skip --> pools
    pools --> ready(["serving"])
```

### 2.2 Graceful shutdown & fatal paths

```mermaid
sequenceDiagram
    autonumber
    participant OS as "OS signal / runtime"
    participant P as "process handlers"
    participant N as "AlertNotifierService"
    participant S as "http(s) server"
    participant A as "AuditLogService"
    participant T as "SharedTransporter"
    participant D as "db (pools)"

    OS->>P: SIGTERM / SIGINT
    P->>P: gracefulShutdown(signal), guard isShuttingDown
    P->>N: stop() (poller + crit tap)
    P->>S: server.close(...)
    S-->>P: no new connections
    P->>A: flushPending() (buffered audit rows first)
    P->>T: closeTransporter() (release pooled SMTP sockets)
    P->>D: shutdown() / closeAll()
    P->>P: process.exit(0)
    Note over P: setTimeout(10s).unref() → forced exit(1) if hung

    OS->>P: unhandledRejection / uncaughtException
    P->>P: stderr.write('[FATAL] …') SYNC first
    P->>N: notifyCriticalNow(EMERGENCY) (own timeout)
    P->>P: gracefulShutdown(reason)
```

---

## 3. `server.ts` — the entry point

### 3.1 The prelude (order is mandatory)

```js
if (!process.env.UV_THREADPOOL_SIZE) {
    process.env.UV_THREADPOOL_SIZE = "48";          // before any async I/O
}
```

- **libuv thread pool sizing.** `node-oracledb` (Thick mode) executes every DB call on a libuv worker thread; the default four threads serialise concurrent Oracle work (with `poolMax=20`, only four queries run at once). Sizing to `48` covers the sum of pool maxima plus headroom for `fs`/`crypto`/`dns`. It must be set before the pool is created (first async I/O) — hence it is code, not `.env` — and can be overridden by a real OS env var.

### 3.2 Env loading — next to the exe in compiled builds

```js
const { IS_COMPILED, APP_ROOT, appPath } = require("./src/utils/runtimePaths");
dotenv.config({
    path: IS_COMPILED ? appPath(".env") : ".env",
});
```

In the compiled exe the working directory is unreliable (a service/scheduled task can start the exe from anywhere), so `.env` is resolved next to the executable. In a source run (`bun server.ts`) it is the current directory's `.env`. This must happen before the boot guard, which reads `process.env` immediately.

### 3.3 The boot guard call site

```js
const { validateSecrets } = require("./src/config/bootGuard");
validateSecrets();
```

Runs **after** `dotenv.config()` but **before** any `app`/`db` require, so the process exits before opening pools or binding a port if configuration is unsafe. Detail in [§5](#5-bootguardjs--fail-fast-configuration).

### 3.4 Runtime configuration read from env

```js
const PORT = parseInt(process.env.PORT || "2108", 10);
const HOST = process.env.HOST || "0.0.0.0";
const USE_HTTPS = process.env.USE_HTTPS === "true";
const ENABLE_CLUSTERING = process.env.ENABLE_CLUSTERING === "true";
const NUM_WORKERS = parseInt(process.env.NUM_WORKERS || String(Math.max(1, os.cpus().length)), 10);
```

| Var | Default | Meaning |
| --- | ------- | ------- |
| `PORT` | `2108` | listen port |
| `HOST` | `0.0.0.0` | bind address (`0.0.0.0` = accessible on the LAN) |
| `USE_HTTPS` | `false` | HTTPS via PFX when `"true"` |
| `ENABLE_CLUSTERING` | `false` | fork a worker cluster when `"true"` |
| `NUM_WORKERS` | CPU count (min 1) | workers to fork when clustering |
| `TRUST_PROXY` | `false` | read in `app.js`; makes `req.ip` honour `X-Forwarded-For` |
| `SERVER_REQUEST_TIMEOUT_MS` | `330000` | per-request timeout ceiling (see [§3.7](#37-server-creation-http-vs-https)) |
| `PFX_FILENAME` | `server.pfx` | PFX file in `certs/` when `USE_HTTPS` |
| `PFX_PASSPHRASE` | `""` | PFX passphrase |
| `USE_HTTPS` cert dir | `APP_ROOT/certs`: next-to-exe (compiled) / next-to-`server.ts` | resolved at runtime, never at compile time |
| `CRON_LEADER` | (set by primary) | stamps exactly one worker as cron leader |
| `ENABLE_SERVER_NOTIFICATIONS` | (see service) | gates `AlertNotifierService` |

### 3.5 Clustering & cron-leader election

When `ENABLE_CLUSTERING="true"` and the process is the primary (`cluster.isPrimary ?? cluster.isMaster`), the primary forks `NUM_WORKERS` workers. **Exactly one** worker is stamped `CRON_LEADER="true"` at fork so that scheduled jobs run once, not once per worker.

The election **fails closed**: a worker is leader only when explicitly stamped, because a stray duplicate leader (jobs running N times) is worse than a stray zero-leader gap — but a zero-leader gap is also unacceptable (jobs would silently never run). The primary therefore *verifies* the invariant rather than assuming it:

- `_workerLeaderEnv` (a `Map` of `worker.id → "true"|"false"`) tracks every live worker's `CRON_LEADER` value.
- `ClusterRole.electionHealth([...values])` (pure) classifies the invariant after every fork/exit; a `critical` verdict (zero **or** more than one leader) is `logger.crit`-logged **and** sent out-of-band via `_notifyLeaderInvariantBreach` → `AlertNotifierService.notifyCriticalNow`, because a `logger.crit` raised in the primary would otherwise land only in the log file (the notifier's critical tap runs on the leader worker, not the primary).
- On worker `exit`, the slot is reforked; if the dead worker was the leader, its replacement inherits leadership. If the refork itself throws, that is `logger.crit`-logged (the cluster genuinely has zero leaders until the next retry).
- `ClusterCacheSync.initPrimary()` sets up the cross-worker cache-invalidation relay so a write on one worker invalidates every sibling's in-memory cache.

`_notifyLeaderInvariantBreach` uses `notifyCriticalNow` (not `start()`) on purpose — `start()` would also spin up the metrics poller and duplicate every digest — and swallows its rejection so a failed notification never crashes or blocks the primary.

### 3.6 Worker / single-process boot

The `else` branch runs for each forked worker and for a non-clustered process:

1. `consoleManager.initialize()` — process title, ASCII art, daily console clearing.
2. `require("./src/app")` (the Express app) and `require("./src/config")` (the DB adapter).
3. **Native-module preflight:** `require("argon2")` at boot. `argon2` loads its prebuilt `.node` via `node-gyp-build`, which the compiled exe resolves from disk beside itself — a missing/mislocated `prebuilds\win32-x64` next to the exe would otherwise only surface at the first password verify. This is **alert-not-exit**: it `logger.alert`s and continues, because the rest of the API still works — only argon2-hashed credential paths would fail.

### 3.7 Server creation — HTTP vs HTTPS

When `USE_HTTPS="true"`, the cert directory is resolved **at runtime** — `path.join(APP_ROOT, "certs")`: next to the compiled exe, next to `server.ts` otherwise — never a path fixed at compile time. The PFX filename comes from `PFX_FILENAME` (default `server.pfx`). If the PFX is missing, the process writes a `[FATAL]` line to **stderr synchronously** (so it is visible even if the logger's async queue has not flushed — a common compiled-build failure mode), `logger.crit`s, and `process.exit(1)`s. Otherwise `https.createServer` is used; when `USE_HTTPS` is false, `http.createServer`.

`server.requestTimeout` is set from `SERVER_REQUEST_TIMEOUT_MS` (a valid positive integer) or defaults to `330_000` ms. The comment notes that long-running guarded write paths (retry/batch DB retries plus awaited email dispatch) can legitimately exceed Node's default 300 s, and that any reverse proxy in front must independently set at least as large a read/proxy timeout.

### 3.8 Listen, notifier, and eager pool init

On `listen`, the process logs server info and (for `HOST=0.0.0.0`) LAN-access hints, then:

- Computes `IS_CRON_LEADER` via `ClusterRole.isCronLeader({ isWorker, cronLeaderEnv: process.env.CRON_LEADER })` (single-process mode has no `CRON_LEADER` env and always schedules).
- Starts `AlertNotifierService.start()` **only on the cron leader**, and **before** `db.initializePools()` — deliberately, so the critical-log tap is already subscribed when a pool-init failure (which is crit-logged) fires; starting it after a successful init would race and miss that exact event.
- Calls `db.initializePools()` if present; on failure it `logger.crit`s with a hint and relies on lazy retry on first request rather than crashing. The project-specific cron-job registration point is a documented placeholder inside the `.then()`.

### 3.9 Graceful shutdown & fatal handlers

`gracefulShutdown(signal)` is idempotent (`isShuttingDown` guard). It stops `AlertNotifierService`, calls `server.close(...)`, then inside the close callback flushes buffered audit rows (`AuditLogService.flushPending()`) **before** closing pools, closes the shared SMTP transporter (`SharedTransporter.closeTransporter()` — pooled sockets keep the event loop alive), closes the DB (`db.shutdown()` or `db.closeAll()`), and `process.exit(0)`. A `setTimeout(…, 10_000).unref()` forces `exit(1)` if shutdown hangs.

`SIGTERM` and `SIGINT` route to `gracefulShutdown`. `unhandledRejection` and `uncaughtException` each **write to stderr synchronously first** (the logger's write queue is async and a following shutdown would lose queued lines — the exact way compiled exes died silently), then best-effort `notifyCriticalNow` (with its own internal timeout), then `gracefulShutdown`.

---

## 4. `src/config/` — the configuration surface

### 4.1 `index.js` — the adapter factory

All app code imports the DB layer from here (`const db = require('./config')`). `createAdapter(engine)` resolves the engine in order **argument → `DB_TYPE` env → `"oracle"`** and `_loadAdapter` switches on it (only `oracle` is wired; the switch throws for anything else with guidance to add an adapter under `src/config/adapters/`). The module exports the default adapter's surface spread together with `createAdapter` and everything from `./database`.

### 4.2 `database.js` — the connection registry

Holds the `connections` registry. The template ships **one** connection, `appDb`, built from `APP_DB_USERNAME`, `APP_DB_PASSWORD`, a TNS connect string (`buildTNSConnectString(DB_HOST, DB_PORT, DB_APP_SERVICE_NAME)`), and `poolMin`/`poolMax` (defaults 5/20). Adding a connection is one entry here plus its env vars — no other file changes. `POOL_NAMES` is the frozen single source of truth for pool-name strings. The file explicitly forbids config modules from calling `dotenv` themselves (env is loaded once by `server.ts`; re-loading would re-inject values a test deliberately unset).

### 4.3 `demoMode.js` — zero-database mode

`isDemoMode()` returns `String(process.env.DEMO_MODE).toLowerCase() === "true"`. When `DEMO_MODE=true`, authentication, audit logs, admin management and changelog are served from in-memory fixtures and **no Oracle pool is opened**. It is read as a function (not a cached const) so it reflects `process.env` after dotenv and can be toggled at runtime by tests.

### 4.4 `adapters/oracle.js` — the Oracle adapter

Merges the former `oracleEnvironment`, `oracleLoader` and `oracleConnectionPool` files. Highlights relevant to boot:

- **Client validation & PATH setup.** `validateOracleClient()` checks `ORACLE_INSTANT_CLIENT` exists and contains `oci.dll` plus the core i18n DLL under either name (`oraociei23.dll` or `oraociei.dll`, which differ across 23.x builds). `setupOracleEnvironment()` prepends the client path to `PATH`.
- **Compiled-env `.env` loader.** In the compiled exe (`IS_COMPILED`) `_loadEnvForCompiled()` reads `.env` from disk only — cwd then next-to-exe — and never via `path.join(__dirname, …)`: under pkg that pattern **baked the build machine's real secrets into every distributed exe** (CWE-798/CWE-540, confirmed by byte-scanning a build). A byte scan of the Bun-built exe (2026-11-21) found no `.env` value.
- **Thick binary location.** When compiled, `initOracleClient` gets `binaryDir: appPath("node_modules", "oracledb", "build", "Release")`, because oracledb's own search path is relative to its baked `__dirname`.
- **Thick vs Thin.** `_initOracleClient` attempts Thick mode whenever `ORACLE_INSTANT_CLIENT` is set (not only for compiled exes) because Thick mode supports all password verifier types; Thin rejects some. The loaded mode is logged.
- **Pool defaults.** `POOL_DEFAULTS` (poolMin 10, poolMax 50, increment 5, timeouts, `stmtCacheSize` 50, homogeneous). `fetchArraySize = 1000` to reduce round-trips on bulk reads.
- **Money-safe fetch.** A `NUMBER`-as-string fetch handler is defined (so exact decimals never round-trip through IEEE-754). Its wiring status is covered in the `oracle-mongo-wrapper.md` doc; it is out of scope here.

---

## 5. `bootGuard.js` — fail-fast configuration

`validateSecrets()` is the guard called from `server.ts`. It builds a `violations[]` list and enforces:

- **Secret rules** (`SECRET_RULES`): `JWT_SECRET`, `CSRF_SECRET`, `COOKIE_SECRET`, `ARGON2_PEPPER`, `DATA_SIGNING_SECRET`, `CHANGELOG_ENCRYPTION_KEY` — each must be present, ≥ 32 chars (128-bit entropy floor), and not a known template placeholder. Comparison is done through `normalise()` (strips whitespace/`_`/`-`, lowercases) so trivial reformatting cannot bypass the placeholder check. `KNOWN_PLACEHOLDERS` lists the shipped `.env.example` values.
- **`DEMO_MODE` in production:** `DEMO_MODE=true` with `NODE_ENV=production` is a violation.
- **`CORS_ORIGINS` in production:** with `NODE_ENV=production`, CORS restricts to the explicit `CORS_ORIGINS` allow-list plus loopback, so an unset list would silently block every browser request from the deployed frontend. Unless `CORS_ALLOW_BROAD_PATTERNS=true` is set, an empty `CORS_ORIGINS` is a violation — fail loudly at boot rather than ship a silently dead deployment.
- **Money base-currency guard** (`validateMoneyConfig`): if `MONEY_BASE_CURRENCY` is set it must be a registered ISO 4217 code. The change-refusal guard is *armed* only once `MONEY_LEDGER_TABLES` is non-empty; when armed, an in-place base change (`previous != base`) is refused unless `MONEY_BASE_CURRENCY_MIGRATION=true` — a functional-currency change must be a new prospective epoch, not an edit that restates history. This guard is fatal in every environment when armed.

**Failure behaviour:** in production, any violation prints an unmissable stderr banner (drawn directly, since the logger may not be initialised), `logger.crit`s, and `process.exit(1)` — the server refuses to start. In development, violations are `logger.warning`-logged and startup continues for local convenience.

---

## 6. The Bun build

`package.json`:

```json
"build": "bun scripts/build.js",
"build:host": "bun scripts/build.js --target=host"
```

`scripts/build.js` runs, in order:

1. `scripts/build-devdocs-freshness.js` → `src/generated/devDocsFreshness.json` (fails without git history).
2. `bun build --compile --sourcemap=inline server.ts --outfile dist/catherine-backend.exe --target=bun-windows-x64`. Bun cross-compiles, so a macOS or Linux build box produces the Windows exe. The exe embeds the Bun runtime; the server needs nothing installed. `build:host` targets the build machine instead, for a local smoke test.
3. Stages `src/utils/email-templates/` and `src/generated/` into `dist/src/…`.
4. Stages the native addons for the target platform: oracledb's `oracledb-<ver>-<platform>-<arch>.node` into `dist/node_modules/oracledb/build/Release/`, and argon2's `prebuilds/<platform>-<arch>/*.node` into `dist/prebuilds/<platform>-<arch>/` (node-gyp-build checks `<exe dir>/prebuilds` after its baked package path).

Any step that stages nothing fails the build (exit 1).

**Why files are staged rather than embedded.** `bun build --compile` bakes the build machine's absolute `__dirname` into the bundle (e.g. `C:\build\CATHERINE\Backend\src\services`). Every runtime read therefore goes through `src/utils/runtimePaths.ts`: `IS_COMPILED` (Bun reports its entry as `/$bunfs/…` or `B:\~BUN\…`), `APP_ROOT` (exe folder when compiled, Backend folder otherwise) and `appPath(...)`. Logs, `data/`, `dev-docs/`, `certs/`, the backup folder and `.env` resolve the same way.

**Source map.** Without `--sourcemap=inline`, every stack frame and log call-site reads `root/catherine-backend:<line>`. With it they read `src/…:<line>`. The map carries the source text — the same exposure as the old pkg build's `--public --no-bytecode`.

**Engine differences found in the migration.** JavaScriptCore formats `toLocaleString("en-US", { dateStyle, timeStyle })` as "Nov 3, 2026 at 2:32 PM" where V8 writes "Nov 3, 2026, 2:32 PM"; email stamps now use `src/utils/formatUtcStamp.ts` (built from `formatToParts`). Clustering shares the listen port through SO_REUSEPORT — verified on macOS, load-balanced on Linux, not verified on Windows.

---

## 7. Boot-relevant environment variables

Grounded in the code read for this document. See `.env.example` for the full catalogue and safe defaults.

| Var | Read in | Effect |
| --- | ------- | ------ |
| `UV_THREADPOOL_SIZE` | `server.ts` | libuv worker threads; defaults to `48` if unset (OS env var overrides) |
| `PORT` / `HOST` | `server.ts` | listen port / bind address (defaults `2108` / `0.0.0.0`) |
| `USE_HTTPS`, `PFX_FILENAME`, `PFX_PASSPHRASE` | `server.ts` | HTTPS via PFX from `certs/` |
| `SERVER_REQUEST_TIMEOUT_MS` | `server.ts` | request-timeout ceiling (default `330000`) |
| `ENABLE_CLUSTERING`, `NUM_WORKERS`, `CRON_LEADER` | `server.ts` | clustering + cron-leader election |
| `ENABLE_SERVER_NOTIFICATIONS` | `AlertNotifierService` (started in `server.ts`) | server email notifications |
| `NODE_ENV` | `bootGuard.js`, `server.ts` | prod ⇒ boot guard fails closed |
| `JWT_SECRET`, `CSRF_SECRET`, `COOKIE_SECRET`, `ARGON2_PEPPER`, `DATA_SIGNING_SECRET`, `CHANGELOG_ENCRYPTION_KEY` | `bootGuard.js` | must be ≥ 32 chars, non-placeholder |
| `CORS_ORIGINS`, `CORS_ALLOW_BROAD_PATTERNS` | `bootGuard.js` (also `CorsMiddleware`) | prod CORS allow-list guard |
| `DEMO_MODE` | `demoMode.js`, `bootGuard.js` | in-memory fixtures, no Oracle; forbidden in prod |
| `DB_TYPE` | `config/index.js` | adapter selection (default `oracle`) |
| `APP_DB_USERNAME`, `APP_DB_PASSWORD`, `DB_HOST`, `DB_PORT`, `DB_APP_SERVICE_NAME`, `APP_POOL_MIN`, `APP_POOL_MAX` | `database.js` | the `appDb` connection |
| `ORACLE_INSTANT_CLIENT` | `adapters/oracle.js` | Thick-mode client dir; prepended to `PATH` |
| `MONEY_BASE_CURRENCY`, `MONEY_LEDGER_TABLES`, `MONEY_BASE_CURRENCY_PREVIOUS`, `MONEY_BASE_CURRENCY_MIGRATION` | `bootGuard.js` | money base-currency guard |
| `TRUST_PROXY` | `app.js` (not `server.ts`) | `req.ip` from `X-Forwarded-For` |

---

## 8. Security

- **Fail closed at the door.** The boot guard runs before any pool opens or any port binds. In production a placeholder secret, a too-short secret, `DEMO_MODE=true`, an unset `CORS_ORIGINS`, or an unsafe money-currency change refuses startup with an unmissable stderr banner — a misconfigured deployment never reaches a serving state.
- **Secrets stay out of the binary.** The compiled `.env` loader reads from disk next to the exe and deliberately avoids `path.join(__dirname, ".env")` because a compile step can otherwise bake the build machine's real `.env` into every distributed exe (CWE-798 hard-coded credentials / CWE-540 information exposure) — confirmed by byte-scanning a pkg build; a scan of the Bun build found none.
- **Working-directory independence.** Resolving `.env` and `certs/` relative to `APP_ROOT` (the exe folder, not cwd) means a service started from `System32` still loads its real config and certificate rather than silently falling back to defaults.
- **Loud fatal paths.** Fatal handlers write to stderr synchronously before the async logger, so a boot failure or unhandled rejection can never exit silently (the historical compiled-exe failure mode). Cron-leader invariant breaches are both crit-logged and pushed out-of-band precisely because "zero leaders" is the state where nobody is watching the log.
- **Native-module honesty.** The `argon2` preflight surfaces a missing prebuilt addon at boot (alert), rather than letting the first credential verify fail in production with no obvious cause.
- **Single graceful teardown.** Shutdown flushes audit rows before closing pools and releases pooled SMTP sockets, so no security telemetry is lost and the process does not hang holding open sockets.

---

## 9. Appendix

### 9.1 Known documentation drift

Recorded per the authority rule: **the code wins**; each item is a place where `Backend/CLAUDE.md` does not match the boot/config/build source as read on 2026-09-04.

- **DB connection names.** `Backend/CLAUDE.md` (Database — OracleDB Adapter Rules) describes a "dual-pool pattern" with connections named `userAccount` and `unitInventory`. `src/config/database.ts` ships exactly **one** connection, `appDb`; `userAccount`/`unitInventory` do not exist in the template registry. **The code is authoritative: one pool, `appDb`.** The `oracle.js` adapter's own docstring also lists backward-compatible shorthands `withDbConnection → withConnection('userAccount')` and `withDbConnectionUnit → withConnection('unitInventory')` (`adapters/oracle.js` header) — those shorthands reference connection names the shipped `database.js` does not register, so they would throw "Unknown connection" if called against the bare template.

- **Boot guard scope vs CLAUDE.md summaries.** The boot guard enforces more than secrets (it also guards `DEMO_MODE`, `CORS_ORIGINS` and the money base-currency in production). Where any CLAUDE.md summary describes the guard as secrets-only, the code is broader — read `bootGuard.js`'s `validateSecrets`/`validateMoneyConfig` for the full set.

### 9.2 Things noted but not asserted

- The internal behaviour of `AlertNotifierService`, `AuditLogService`, `SharedTransporter`, `consoleManager` and `clusterRole` was read only as far as `server.ts`/config reference them; their full contracts are out of scope for this document and should be read from their own files before changing them.
- `db.initializePools`, `db.shutdown`/`db.closeAll` are called via `typeof … === "function"` guards in `server.ts`; this document describes the call sites and the adapter registry, not the pool-lifecycle internals of `adapters/oracle.js` beyond the boot-relevant sections in [§4.4](#44-adaptersoraclejs--the-oracle-adapter).
- The `.env.example` file was referenced by the code but not read in full for this pass; the env table in [§7](#7-boot-relevant-environment-variables) lists only variables observed directly in the source files named in the scope.
