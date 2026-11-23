# Backend test coverage gap report

Generated 2026-11-22 on branch `backend-test-coverage-report` (based on `backend-tests-to-ts`, PR #7).
Command: `cd Backend && bun run test:coverage` (`bun --bun vitest run --coverage`, v8 provider).
Standard: 6-category matrix (unit, integration, performance, chaos, security, reliability), tested against the
architecture and runtime models (`src/constants/architectureModel.ts`, `src/constants/runtimeModel.ts`, validated by
`src/utils/systemMap.ts`), gated by `coverage.thresholds` in `vitest.config.mts`.

> **Update 2026-11-23:** `vitest.requireToImport.mts` (new) fixes most of the under-count below. After it: statements 36.87%,
> branches 34.07%, functions 43.56%, lines 38.03% (all still FAIL). Ten test files opt out via `NATIVE_REQUIRE_ONLY` (src has ~65 lazy
> native `require()` calls, so a Vite-loaded test and src would hold different module instances). The tables below show the
> original measurement.
>
> **Update 2026-11-23 (tests added):** new tests cover gaps 1 (auth/session revocation), 3 (data-purge auth, backup token), 4 (ipcSchemas, cluster RPC chaos,
> critRelay) and 5 (request watchdog). Chaos files moved to `test/server/chaos/`. Now: 2015 tests, statements 44.48%, branches 42.19%, functions 50.82%,
> lines 45.54% (gate still FAIL). Gap 2 (shutdown teardown) tests are written but held back: they import `src/utils/shutdown/HttpInFlightTracker.ts`,
> which fails `tsc -p tsconfig.test.json` (untyped `list = []`, `idleMs = null` at lines ~142-150) and needs a 2-line type annotation in src.

> **Update 2026-11-23 (branch push):** 4054 tests in 214 files across all six categories. Statements 82.08% (PASS), lines 82.74% (PASS),
> branches 81.69% (FAIL, gate 85), functions 79.98% (FAIL, gate 85). Remaining low files are mostly those whose spies cannot take effect because
> src lazy-`require()`s them, plus `server.ts`-adjacent shutdown code (tests held pending a src type annotation).

## 1. Coverage vs gate

Run result: 103 test files, 1613 tests, **all passed**. Coverage gate: **FAILED on all four metrics**
(exit code 1). No threshold was changed.

| Metric     | Measured | Threshold | Result |
| ---------- | -------- | --------- | ------ |
| Statements | 23.74% (3298/13892) | 80% | FAIL |
| Branches   | 21.23% (1957/9217)  | 85% | FAIL |
| Functions  | 29.58% (844/2853)   | 85% | FAIL |
| Lines      | 23.69% (2966/12516) | 80% | FAIL |

`test/server/performance/shutdownGate.perf.test.ts` (known flaky under load) passed in this run.

Coverage scope (`vitest.config.mts`): `include: src/**/*.ts`; excludes `src/config/**` and
`src/utils/oracle-mongo-wrapper/**`. `server.ts` (shutdown, crash, failsafe, scheduler wiring) is outside `src/`, so it is not measured at all.

### The numbers under-count (measurement problem, partly verified)

Many files with passing direct tests report 0%. Example, verified: `test/unit/signedFields.test.ts` (10 tests, all pass)
vs `src/utils/integrity/signedFields.ts` = 0% under **both** `--coverage.provider=v8` and `istanbul`. Other examples:
`utils/clusterRole.ts` (15 tests), `utils/concurrency.ts`, `utils/formatUtcStamp.ts`, `services/FxRateService.ts`,
`utils/validateXlsxMagicBytes.ts` (16 tests). These tests load source with `require("../../src/...")`, which Bun resolves
natively, so the module bypasses Vite's transform. Likely cause (not proven): such files are never instrumented.
Running under plain Node does not work as a workaround: `require()` of a `.ts` path fails with "Cannot find module".
Consequences: the true coverage is higher than 23.7%, the gate cannot be judged until measurement is fixed, and a per-file 0% is
evidence of "no tests" only when no test references the file (section 3 uses grep evidence, not only percentages).

### Lowest-covered files (lcov, statements; 75 of the 201 files in the text table have 0 covered lines)

Treat with the caveat above. 0% files with the most lines, and no test file referencing them directly unless noted:

| File | Lines | Cov | Direct test? |
| --- | --- | --- | --- |
| `src/services/BackupStoreService.ts` | 411 | 0% | none |
| `src/utils/cluster/ClusterRpcHub.ts` | 194 | 0% | none |
| `src/utils/cluster/ClusterSupervisor.ts` | 189 | 0% | none |
| `src/services/LogRetentionService.ts` | 133 | 0% | none |
| `src/utils/shutdown/TeardownSequence.ts` | 112 | 0% | none |
| `src/services/BackupScheduleService.ts` | 90 | 0% | none |
| `src/utils/cluster/PrimaryStateServices.ts` | 83 | 0% | none |
| `src/utils/progress/RequestWatchdog.ts` | 82 | 0% | none |
| `src/services/AdminAccessEmailService.ts` | 78 | 0% | none |
| `src/services/BackupEmailService.ts` | 75 | 0% | none |
| `src/utils/shutdown/HttpInFlightTracker.ts` | 51 | 0% | none |
| `src/utils/systemMap.ts` | 49 | 0% | none |

Near-zero with real code and stubbed or absent tests: `models/integrity.model.ts` 1.2%, `controllers/DataPurgeController.ts` 1.7%,
`services/AuditLogService.ts` 2.8% (431 lines), `services/AdminManagementService.ts` 3.8%, `services/IntegrityService.ts` 4.5%,
`services/AuthService.ts` 5.9%, `utils/cluster/ipcSchemas.ts` 7.3%. Not necessarily untested (measurement gap, see above):
`utils/resilience/BatchGuard.ts` 3.1% (has `test/server/unit/utils/batchGuard.test.ts`, 20 tests) and `utils/cluster/ClusterRpcClient.ts` 6.8%
(loaded by `alertNotifier.branchSweep.test.ts`). Directory roll-ups: `routes` 8.4%, `controllers` 15.3%, `services` 19.5%,
`models` 20.8%, `utils/cluster` 2.0%, `utils/auth` 2.6%, `utils/sse` 9.0%.

## 2. Tests per category

Classification: `test/server/<folder>/` gives the category; `test/unit/**` is unit; any `*.chaos.test.ts` is chaos
(overrides the folder). `test/oracle-mongo-wrapper/` and `test/encryption/` are excluded (`vitest.config.mts`).
Test counts are from the Vitest JSON report (`it` cases that ran).

| Category    | Files | Tests | Where |
| ----------- | ----- | ----- | ----- |
| unit        | 62    | 1000  | `test/server/unit/**` (minus chaos files), `test/unit/**` |
| integration | 20    | 390   | `test/server/integration/**` |
| security    | 9     | 92    | `test/server/security/` |
| chaos       | 3     | 90    | `test/server/unit/middleware/cache/cache{Store,Middleware,Registry}.chaos.test.ts` |
| reliability | 4     | 21    | `test/server/reliability/` |
| performance | 5     | 20    | `test/server/performance/` |
| **Total**   | 103   | 1613  | |

Observations: only the cache layer has chaos tests. Reliability (4 files) and performance (5 files) are thin relative to the
runtime model, which describes about 40 shutdown, crash, watchdog and cluster behaviours.

## 3. Architecture and runtime coverage

Method: every `files` / `sub` / `description` reference in the two models resolves to an existing `src/` file (171 paths).
Test files were mapped by grepping `require`/import paths, `vi.spyOn`/`vi.mock`, and URLs hit through `src/app`.
U=unit I=integration P=performance S=security R=reliability C=chaos. "via app" = the file only runs because a supertest
request passes through `src/app.ts`. "stubbed" = service replaced with `vi.spyOn(...).mockResolvedValue`, so real logic is not run.
Frontend nodes (`fe.*`), actors, tables and resource nodes without a named src file are not tracked.

Important facts that limit the matrix:
- In the HTTP integration suites the service layer is stubbed (`AuthService`, `AdminManagementService`, `AuditLogService`,
  `MetricsService`, `ClientService`). `test/server/setup.ts` also stubs `AuditLogService.insertAsync` globally. Those suites cover
  route, middleware and controller only.
- `test/server/reliability/graceful-shutdown.test.ts` spawns a hand-written stub HTTP server. It does not exercise
  `server.ts`, `TeardownSequence` or `HttpInFlightTracker`.

### 3a. architectureModel.ts nodes

| Node | Src files (Backend/src) | Covered | Missing (applicable) |
| --- | --- | --- | --- |
| edge.chain | app.ts, middleware/security/{Helmet,Cors,ShutdownGate}, parsing/* | U, I/S/P/R via app | S: `Content-Encoding: br` 415, gzip trailing garbage, multipart index bound |
| edge.guard | SecurityFilter, IpFilter, RateLimiter, SlidingWindowCounter, authRateLimiters | U, S, I, P | U: SlidingWindowCounter, SuspiciousIpTracker; R: cluster mirroring |
| edge.trace | metrics/MetricsMiddleware, ResponseTimeMiddleware, AuditLogMiddleware | U, P, I via app | R: audit row after `res.end`, insert failure |
| edge.csrf | CsrfMiddleware, routes/csrf.route | U, I, S | none clearly |
| edge.auth | AuthMiddleware, LoginLockout*, utils/auth/*, AccessRevocationService | S, U (lockout), I | S: revoked family to 440, legacy token, refresh-as-access |
| edge.cache | middleware/cache/* | U, C, I | S: caller-specific cache keys (CWE-200); U: SingleFlight |
| edge.error | ErrorHandlerMiddleware, constants/errors | U, S, I | S: no stack in body when `NODE_ENV=production` |
| api.platform | ClientService, ReadinessService, HealthStreamHub, health/client routes | I, P; S incidental (`securityFilter.bodylessMethods` hits `/health/stream`, body guard only) | I/S: `/health/stream` own behaviour (per-IP 429, heartbeat); `POST /client/help-miss` |
| api.auth | auth.route, AuthService, RefreshTokenService, RefreshTokenRegistry | I (stubbed AuthService), S, P, R | U/S on real AuthService and refresh rotation/reuse |
| api.admin | AdminManagementService, AdminAccessEmailService | I, S (service stubbed) | U/S on real service (role rules, last SUPER_ADMIN, fail-closed revoke) |
| api.integrity | integrity.route, IntegrityController, IntegrityService | **none** | U, I, S, P, R |
| api.purge | data-purge.route, DataPurgeController/Service, DataRestoreService | I (restore suites, service level), U | S: SUPER_ADMIN gate on 14 endpoints, token replay/forgery; I over HTTP |
| api.audit | AuditLogService, SystemLogTailService | I (stubbed), U (models) | U: flushPending, requeue cap; I/S: `/system-logs` and streams |
| api.metrics | MetricsService, MetricsController | U, I, P, S, R | C optional |
| api.support | changelog/dev-docs routes, controllers, services | **none** | I; S: dev-docs path traversal, role gate |
| api.architecture | architecture.route, ArchitectureService, systemMap.ts | **none** | U: `buildSystemMap` rejections; S: non-SUPER_ADMIN 403 |
| svc.crypto | CryptoVault, adminTempPassword | U, I | U: adminTempPassword expiry; S: tampered SYSSIGNATURE at login |
| svc.tamper | TamperDetectionService, IntegrityService | U, I | I/S: IntegrityService sweep |
| svc.excel | validateXlsxMagicBytes, excelCell, excelFormat, uploadOutcome | U (magic bytes) | U: excelCell, uploadOutcome; S: polyglot/zip-bomb upload |
| svc.email | emailAddress, SharedTransporter, EmailProtectionService, RecipientResolver | U, I, P, S, R | S/U: `emailAddress.singleAddress` CRLF injection, 254 cap |
| svc.sse | ScopedSsePoller, SseConnectionRegistry, ssePreflight | U (poller only) | R: shutdown frame; S: ssePreflight auth |
| svc.wrapper | config/*, dbTimezone, oracle-mongo-wrapper | U, P, R | C optional (config and wrapper excluded from coverage) |
| svc.backup | BackupStoreService, BackupArchiveService, BackupTokenService, BackupEmailService | I, U (archive, restore) | S: BackupTokenService; R/C: BackupStoreService idle cancel; U: BackupEmailService |
| svc.logger | logger, logRedaction, LogRetentionService | U (logger) | S: logRedaction; R: queue cap; U: LogRetentionService |
| svc.schedstate | SchedulerStateService, constants/schedulerJobs | **none** | U, R |
| rt.primary | ClusterSupervisor, clusterRole | U (clusterRole) | R/C: respawn backoff, crash-loop cap |
| rt.rpc | ClusterRpcHub/Client, PrimaryStateServices, ipcSchemas, workerRpcWiring | U/I (ClusterCacheSync only) | S: ipcSchemas; U/R/C: hub, client, state services |
| rt.workers | consoleManager, RequestWatchdog, HttpInFlightTracker | **none** | R |
| rt.backupsched | BackupScheduleService | **none** | U, R |
| rt.runmarker | ServerRunMarker, StartupNotifier | U, I (partial) | R: boot-verdict matrix; C: EPERM fallback |
| rt.alerts | MetricsStore, AlertNotifierService | U, I, P, S, R | C optional |
| db.app / db.appbulk | config/database | U, P, R | C: breaker open 503, NJS-076 to 429 |
| tbl.config | SystemConfigService | **none** | U |

### 3b. architectureModel.ts flows

| Flow | Covered | Missing |
| --- | --- | --- |
| request-lifecycle | I, S, P, R via app | R: audit row persisted; C: pool fast-fail |
| login-session | I (stubbed), S, P | U/S real AuthService |
| integrity-scan | U (TamperDetection only) | I, S, P, R |
| data-purge | I (indirect) | I, S over HTTP; R |
| scheduled-backup | **none** | U, R, C |
| observability | U, I, P, S, R | I/S: log tail, streams |
| architecture-page | **none** | U, S |
| provision-admin | I, S (stubbed) | U/S real service; R email failure |
| data-restore | I, U (strongest) | S: `POST /data-purge/restore` gate |
| health-probes | I, P | C: breaker |
| support-docs | **none** | I, S |
| restart-detection | U, I (partial) | R |

### 3c. runtimeModel.ts nodes

| Node | Src files | Covered | Missing |
| --- | --- | --- | --- |
| trg.winsw | deploy/winsw/*.xml | **none** | U: `stoptimeout` vs forced-exit bound |
| trg.signal, trg.clock, trg.fault | server.ts | **none** | R |
| trg.http | app.ts | I, S, P, R via app | none |
| proc.boot | config/bootGuard, runtimePaths | U | R: weak secret/missing PFX exits 1, no port bound |
| proc.primary | ClusterSupervisor, clusterRole | U (clusterRole) | R, C |
| proc.worker | consoleManager, app.ts, database | I/S/P/R via app, P, R | R: pool-init failure, process keeps serving |
| proc.leader | clusterRole, server.ts | U | R |
| proc.rpc | cluster/* | effectively none | U, S, R, C |
| sch.backup | BackupScheduleService, BackupEmailService | **none** | U, R |
| sch.logret | LogRetentionService | **none** | U, R |
| sch.alertpoll | AlertNotifierService | U, I, P, S, R | C |
| grd.reqwd | RequestWatchdog, IdleWatchdog, ProgressScope | U (ProgressScope incidental) | **R**: idle 504, progressing not cut, SSE exempt |
| grd.burst | WatchdogBurstDetector | **none** | U, R |
| grd.backupwd | BackupStoreService, FileLease | U (FileLease) | R, C: cancelled backup leaves no `.zip`/`.part` |
| grd.pool | NjsCode, config/adapters/oracle | U, R (release/rollback), P, I | **C/R**: PoolHealthMonitor 3 strikes, breaker 503, NJS-076 429 |
| grd.rate | RateLimiter, SlidingWindowCounter | U, S, I | R/C: cluster count falls open |
| grd.secf | SecurityFilter, SuspiciousIpTracker | U, S, I | U: tracker; R: block mirrored |
| grd.batch | concurrency, BatchGuard, RetryPolicy | U | C: retry budget exhausted under failing DB |
| grd.resign | DataRestoreService | I, U | S (property is security, lives in integration/) |
| lc.marker | ServerRunMarker | U, I (partial) | R, C |
| lc.shutdown | server.ts, TeardownSequence | **none** | R |
| lc.failsafe, lc.close, lc.crash | server.ts | **none** | R |
| lc.inflight | HttpInFlightTracker, ShutdownGateMiddleware | P (shutdownGate.perf) | R, I |
| lc.sse | SseConnectionRegistry | **none** | R |
| lc.drain | InFlightTaskRegistry | P (incidental) | U, R |
| lc.audit | AuditLogService.flushPending | **none** | U, R |
| obs.logger | logger, logRedaction | U | S, R |
| obs.metrics | MetricsStore, metricsMerge | U, I, P, S | R: missing worker never fakes RESOLVED (unverified) |
| obs.notifier | AlertNotifierService, ServerNotificationService | U, I, P, S, R | C: SMTP down, alert-log queue cap |
| obs.relay | cluster/critRelay | **none** | U, R |
| obs.sched | SchedulerStateService | **none** | U |
| obs.health | health.route, ReadinessService, HealthStreamHub | I, P (S incidental) | I/S/P: `/health/stream` |
| obs.startmail | StartupNotifier | U, I | R: 15-min throttle, HANDOVER |
| obs.shutdownmail | ShutdownNotifier | R (email part only) | U: three emails bounded at 5 s |
| res.pools, res.smtp | database, SharedTransporter | U, P, R / U, I, P, S, R | C (pools) |

### 3d. runtimeModel.ts flows

| Flow | Covered | Missing |
| --- | --- | --- |
| boot | U (bootGuard) | R |
| leader-schedules, cluster-lifecycle | U (clusterRole) | R, C |
| scheduled-backup | U (FileLease only) | R, C |
| db-outage | U, I, P, S, R | C: breaker and 429 shed |
| critical-storm | U (branchSweep; digest/ceiling unverified) | R |
| crash, failsafe, request-watchdog | **none** | R |
| graceful-stop | P, R (email part only) | R: teardown order, SSE drain, in-flight wait |
| abuse-limits | U, S, I | R (cluster) |
| logging | U | S: redaction; R: queue overflow, retention |
| cluster-shared-state | U, I (cache sync) | S: ipcSchemas; R |
| ended-session | **none** | S, R |
| compressed-bodies, multipart-index | **none** | S |
| readiness-cause | I, P | none clearly |
| readiness-push | S incidental (body guard on `/health/stream` only) | I, S, P |
| sign-in-lockout | U, I (AuthService stubbed) | I real AuthService; R cluster counters |
| restart-detection | U, I (partial) | R |
| restore-verify | I, U | none clearly |

Zero effective tests: `api.integrity`, `api.support`, `api.architecture`, `svc.schedstate`, `rt.workers`, `rt.backupsched`,
`tbl.config`, `trg.*` (except `trg.http`), `sch.backup`, `sch.logret`, `grd.burst`, `lc.shutdown|failsafe|close|crash|sse|audit`,
`obs.relay`, `obs.sched`; flows `scheduled-backup`, `architecture-page`, `support-docs`, `crash`, `failsafe`, `request-watchdog`,
`ended-session`, `compressed-bodies`, `multipart-index`; `readiness-push` only incidentally.

## 4. Structural issues

1. **No chaos folder.** The 3 chaos files live under `test/server/unit/middleware/cache/`. `eslint.config.ts` (BLOCK 8,
   line ~146) targets `test/server/chaos/**/*.ts`, which matches no file, so that block applies to nothing. It has no lint effect today: BLOCK 4 (`test/**/*.ts`) does not turn off `no-console`
   and none of the three cache chaos files calls `console.`.
2. **`test:chaos` script** is `bun --bun vitest run chaos` (filename filter), while `CLAUDE.md` (script listing near lines 1326/1347) says it runs
   `test/server/chaos`; the same file (Test Directory Structure) already says that folder does not exist.
3. **Stale `flow.ref` entries in `runtimeModel.ts`:** `serverProcess.restartMarker.reliability.test.js`,
   `bootAlertHistoryLiveOracle.test.js` and `restore.verifyBeforeResign VBR-01–08` match no file under `test/`.
4. **Measurement gap:** tests that `require()` TypeScript source report 0% (section 1); `server.ts` is outside `include`.
5. **Stubbed service layer:** integration suites stub the services they claim to test (section 3). `graceful-shutdown.test.ts` tests a stub fixture.
6. **Category mismatch:** `fkRemapResign` (forged hash restored unsigned) is a security property that lives under `integration/`.
7. `test:unit` script runs only `test/server/unit test/unit`, so chaos files (inside `unit/`) also run in it.

## 5. Prioritised gaps (top 10)

0. Prerequisite: make coverage trustworthy. Convert `require()` in tests to `import` (or otherwise get instrumentation), and add
   `server.ts` to `coverage.include`. Then re-measure before judging the gate.
1. **Real AuthService, RefreshTokenService, session revocation (security + unit).**
   `test/server/security/sessionRevocation.security.test.ts` (logout then old token 440, refresh-as-access 401, reuse revokes family);
   `test/server/unit/services/authService.test.ts` using `helpers/fakeOracle.ts` (IS_ACTIVE gate, SYSSIGNATURE tamper, lockout, temp-password expiry).
2. **Shutdown teardown (reliability).** `test/server/reliability/teardownSequence.reliability.test.ts` against a real `http.Server`: in-flight request
   finishes, new requests 503 with Retry-After, SSE gets shutdown frame, tasks awaited before pool close. Replace the stub fixture in `graceful-shutdown.test.ts`.
3. **Data purge endpoints (security + integration).** `test/server/security/data-purge-auth.security.test.ts` (14 endpoints 403 for non-SUPER_ADMIN,
   forged/expired/replayed backup token, second voter) and `test/server/integration/data-purge/data-purge.test.ts`.
4. **Cluster RPC and IPC (security + chaos).** `test/server/security/ipcSchemas.security.test.ts`;
   `test/server/chaos/clusterRpc.chaos.test.ts` (creates the chaos folder) (primary silent, rate limiter falls open, lost `auth.revoke`).
5. **Request watchdog (reliability).** `test/server/reliability/requestWatchdog.reliability.test.ts` with fake timers: idle 504, progressing not cut,
   SSE exempt, burst alert once.
6. **Backup watchdog, lease, scheduler (reliability + chaos).** `test/server/reliability/backupWatchdog.reliability.test.ts` (stalled backup cancelled, no
   `.zip`/`.part`, lease released); `test/server/unit/services/backupSchedule.test.ts` (idempotent trigger).
7. **Request-body hardening (security).** `test/server/security/requestBodyEncoding.security.test.ts`: `br` and `gzip, br` 415, gzip trailing garbage,
   multipart `a[4294967294]` 400.
8. **Integrity Center (integration + security).** `test/server/integration/integrity/integrity.test.ts`; `test/server/security/integrity-auth.security.test.ts`
   (ADMIN 403, injected `:table` rejected).
9. **AdminManagementService real logic (unit + security).** `test/server/unit/services/adminManagementService.test.ts`: ADMIN cannot manage ADMIN, last
   SUPER_ADMIN 409, revoke fails closed, no temp password in logs.
10. **System map, Dev Docs, log privacy (unit + security).** `test/server/unit/utils/systemMap.test.ts` (rejects edge-less step, missing path, route drift);
    `test/server/security/devDocs-architecture.security.test.ts` (role gate, traversal); `test/server/security/logRedaction.security.test.ts`.

Further: LogRetentionService "never deletes today or yesterday" unit test; `emailAddress.singleAddress` CRLF security test; PoolHealthMonitor/NJS-076 chaos test;
`/health/stream` integration; ServerRunMarker verdict matrix; critRelay and SchedulerStateService units; create `test/server/chaos/` and move the cache chaos files.

## 6. Unverified

- Root cause of the 0% on directly tested files (verified for `signedFields.ts`; mechanism is a hypothesis).
- Whether `alertNotifier.branchSweep` covers the digest and hourly ceiling; whether `metricsMerge.shape` covers "missing worker never fakes RESOLVED";
  whether `login.test.ts` asserts lockout against real state (AuthService.login is spied).
