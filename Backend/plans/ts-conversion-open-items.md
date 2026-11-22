# Backend TypeScript conversion — open items

Branch `backend-rewrite-to-typescript` (PR #4, open, not merged). Status as of 2026-11-21.

## 1. Before merge

- [x] **CI on PRs.** The only workflow (`.github/workflows/verify-changelog-release.yml`) runs on tags, so nothing checks a PR. Add one that runs `bun run typecheck`, `bun run lint` and `bun run test`.
- [x] **CSRF body token.** Since the typing pass fixed the misspelt `getCsrfTokenFromRequest` option, a token sent in the request body is accepted. Add an integration test that posts the token in the body.
- [ ] **Windows server (owner).** Run the exe, stop it through WinSW, then test Thick mode with the Instant Client and test clustering. The TypeScript build has only been run on macOS.
- [x] PR #4 description covers the wrapper commit `2758c0d`.
- [x] **Changelog entry `1.0.0-dev.53`** for the wrapper fixes (G1–G4). CATHERINE is still at `1.0.0-dev.52`.

## 2. Follow-up PRs (after merge)

- [x] **G18:** `updateOne({})`, `replaceOne({})` and `deleteOne({})` build `… t0  AND ROWNUM = 1`, which is invalid SQL. See `oracle-wrapper-gap-inventory.md`.
- [ ] **Remaining `any`:** 20 code lines outside the Oracle wrapper (plus 21 inside it, mostly filterParser DSL operands and the `conn` boundary); was 550 `: any` / 172 `Record<string, any>`. Kept on purpose, each documented: adapter `withConnection`/`withTransaction` `conn`, `CacheStore.get`/`getOrSet`, `audit.log.file.model.ts` filter emulation, `demoStore._toComparable`, nodemailer `to` in `EmailProtectionService`, the lockout IPC reply. Still typeable: `ArchitectureService.getMap`, `AdminAccessEmailService._normaliseOverride`, `dbTimezone`, `critRelay`, `ClusterRpcClient.call`.
- [ ] **Type the connection boundary:** `withConnection`'s callback `conn` is untyped; typing it as `oracledb.Connection` makes every `result.rows` in the models `unknown[]`, so models need row types first.
- [x] **Unify the two metrics snapshot shapes:** done. `MetricsSnapshot` (MetricsStore) is built from named parts (`RouteRedSnapshot`, `OraclePoolSnapshot`, `TotalsSnapshot`, `SystemSnapshot`); `mergeMetricsSnapshots` returns `ClusterMetricsSnapshot` (= `MetricsSnapshot` + `cluster`), and the merge rebuilds memory / heap trend / failure cause to those types instead of copying wire data. `MetricsService` alert rules take `AlertInput` (`red` and `system` required, the rest guarded) and `AlertNotifierService.AlertSnapshot` is the partial cluster snapshot. Locked by `test/server/unit/middleware/metricsMerge.shape.test.js`.
- [x] **Port to TypeScript:** `scripts/` (7 files) and the root configs (`eslint.config.ts`, `vitest.config.mts`, `vitest.coverage-scoped.config.mts`; `.mts` because the package is CommonJS) are done and type-checked. `test/` stays JavaScript by decision (2026-11-22): Vitest runs the .js tests against the .ts source, and typing 113 files of loose mocks would mean casts for little gain.
- [ ] **Frontend** TypeScript conversion (not started).
- [ ] **TypeScript 7** once typescript-eslint supports it (currently pinned `~6.0`).
- [ ] **Wrapper backlog G5–G17** (`oracle-wrapper-gap-inventory.md`).

- [x] **Type the audit record:** done (`AuditRecord` in `audit.log.model.ts`).
  ~~Was:~~ one type shared by `AuditLogMiddleware._buildRecord`, `AuditLogModel.insert/insertBatch` and `demoStore.auditInsert` (each takes `any` / `Record<string, unknown>` today).
- [ ] **Restore has almost no tests:** `DataRestoreService` (archive verify, preflight allow-list, FK remap, re-sign) is covered only by the `_returnedIdentity` unit test. It handles uploaded archives, so it needs integration tests.

## Known flaky tests

- `shutdownGate.perf` and `scanner-blocking` occasionally fail under full-suite load and pass when rerun.
- `auth-bypass` "tampered payload → 403" failed once under full-suite load (2026-11-22); passed 3/3 alone and in the next full run. The test input is deterministic, so the cause is shared state or timing; not yet investigated.
- `audit-log.test.js` "X-Request-ID is present" failed once in a partial run under load (2026-11-22); passed 3/3 alone and in the full suite. Likely the same shared-state/timing cause.
- `audit-log.test.js` export + range-delete block (11 tests) failed together once in the full suite (2026-11-22); 55/55 alone and 1570/1570 on the next full run. Looks like one stalled export cascading into the following tests.
