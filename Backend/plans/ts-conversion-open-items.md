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
- [ ] **Remaining `any`:** 17 code lines outside the Oracle wrapper (plus 21 inside it, mostly filterParser DSL operands); was 550 `: any` / 172 `Record<string, any>`. Kept on purpose, each documented: `CacheStore.get`/`getOrSet`, `audit.log.file.model.ts` filter emulation, `demoStore._toComparable`, nodemailer `to` in `EmailProtectionService`, the lockout IPC reply. Still typeable: `ArchitectureService.getMap`, `AdminAccessEmailService._normaliseOverride`, `dbTimezone`, `critRelay`, `ClusterRpcClient.call`.
- [x] **Type the connection boundary:** done. `DbConnection` (wrapper `db.ts`) is node-oracledb's `Connection` with `execute` / `executeMany` / `queryStream` narrowed: binds take the wrapper's `DbBinds` (the driver checks bind types at execute time), rows default to `Record<string, unknown>` and take a row type, e.g. `conn.execute<{ CNT: number }>(…)`. The adapter's `withConnection` / `withTransaction`, `Transaction.execute` and every raw-SQL model use it. `rows` / `rowsAffected` are `?? []` / `?? 0` where the driver always sets them (SELECT / DML). Verified on Oracle 19c (G1–G4, G18 proofs).
- [x] **Unify the two metrics snapshot shapes:** done. `MetricsSnapshot` (MetricsStore) is built from named parts (`RouteRedSnapshot`, `OraclePoolSnapshot`, `TotalsSnapshot`, `SystemSnapshot`); `mergeMetricsSnapshots` returns `ClusterMetricsSnapshot` (= `MetricsSnapshot` + `cluster`), and the merge rebuilds memory / heap trend / failure cause to those types instead of copying wire data. `MetricsService` alert rules take `AlertInput` (`red` and `system` required, the rest guarded) and `AlertNotifierService.AlertSnapshot` is the partial cluster snapshot. Locked by `test/server/unit/middleware/metricsMerge.shape.test.js`.
- [x] **Port to TypeScript:** `scripts/` (7 files) and the root configs (`eslint.config.ts`, `vitest.config.mts`, `vitest.coverage-scoped.config.mts`; `.mts` because the package is CommonJS) are done and type-checked. `test/` stays JavaScript by decision (2026-11-22): Vitest runs the .js tests against the .ts source, and typing 113 files of loose mocks would mean casts for little gain.
- [ ] **Frontend** TypeScript conversion (not started).
- [ ] **TypeScript 7** — ready, blocked upstream. TS 7.0.2 (stable since 2026-07-08) type-checks the whole backend with 0 errors (checked 2026-11-22 against `tsconfig.json`, planted-error sanity check passed). typescript-eslint 8.73 (latest and canary) still requires `typescript <6.1.0`, so `typescript` stays `~6.0`. Switch when typescript-eslint widens its peer range.
- [ ] **Wrapper backlog G5–G17** (`oracle-wrapper-gap-inventory.md`).

- [x] **Type the audit record:** done (`AuditRecord` in `audit.log.model.ts`).
  ~~Was:~~ one type shared by `AuditLogMiddleware._buildRecord`, `AuditLogModel.insert/insertBatch` and `demoStore.auditInsert` (each takes `any` / `Record<string, unknown>` today).
- [x] **Restore tests:** `test/server/integration/restore/` — `dataRestore.roundtrip.test.js` builds a REAL archive (zip, SHA-256 map, HMAC) and checks preview/restore: flipped byte, edited manifest, forged digest, stripped file, non-zip, a correctly re-signed archive naming an unregistered table, non-empty FULL_SCOPE target, password and confirm-phrase gates, tier-ordered inserts, failing insert = no commit / no audit. `dataRestore.fkRemapResign.test.js` mocks a two-table project registry (identity parent + signed child with an FK edge) and checks FK remap to new identities, re-sign over the NEW pk/FK, and a forged original hash restored UNSIGNED. Both files fail under mutation of the guards they cover. DB stubbed (no Oracle in CI).

## Known flaky tests

- `shutdownGate.perf` and `scanner-blocking` occasionally fail under full-suite load and pass when rerun.
- `auth-bypass` "tampered payload → 403" failed once under full-suite load (2026-11-22); passed 3/3 alone and in the next full run. The test input is deterministic, so the cause is shared state or timing; not yet investigated.
- `audit-log.test.js` "X-Request-ID is present" failed once in a partial run under load (2026-11-22); passed 3/3 alone and in the full suite. Likely the same shared-state/timing cause.
- `audit-log.test.js` export + range-delete block (11 tests) failed together once in the full suite (2026-11-22); 55/55 alone and 1570/1570 on the next full run. Looks like one stalled export cascading into the following tests.
