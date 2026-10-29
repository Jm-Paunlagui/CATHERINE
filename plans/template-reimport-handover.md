# Handover: eMeal re-import → CATHERINE template

**Date:** 2026-10-28. **Branch:** `main`. **Status:** not committed. Merge done; both suites green and lint clean per the user's baseline (backend 77 files / 1254 tests, frontend 32 files / 555 tests). Docs sweep done. What is left is in [§0](#0-update--what-is-left).

## 0. Update — what is left

§6 items 1-10 are done. **Source-name sweep (2026-10-29) done:** all 13 dev-docs pages rewritten from source; both `.env.example` files audited; `plan.md` and `plans/meal-parity-and-money.md` removed; misleading `USER_NOT_FOUND` → `REFRESH_TOKEN_MISSING`; source version tags and missing-test citations stripped; `advancedChunks` warning fixed; `.claude` mirrors synced; licenses Apache-2.0; admin-management wire contract `empId`/`empRole` → `username`/`role`; backend default `PORT` 2108 everywhere; `CHANGELOG_ENCRYPTION_KEY` must be 64 hex; duplicate `/system/metrics` page removed. Baseline now backend 78 files / 1269 tests, frontend 32 / 555. Still open:

| # | Item | Owner |
| --- | --- | --- |
| 1 | **Commit** in logical slices. Nothing is committed yet. Do not push without review | orchestrator |
| 2 | Drop `refs/backup/emeal-paste` only after the user confirms (`git update-ref -d refs/backup/emeal-paste`) | user |
| 3 | Delete `Backend/.env.emeal.bak` once the rebuilt `Backend/.env` is verified | user |
| 4 | Optional index `T_ADMINS_DEV(ROLE, IS_ACTIVE)` for the last-super-admin count | Oracle |
| 5 | `PASSWORD_HASH_MODE=tripledes` not blocked in production | security |
| 6 | `T_SERVER_BACKUP_TOKEN_CONSUMED_DEV.EMP_ID` column name (needs schema migration) | Oracle |
| 7 | Log hardening found by doc review: newline escaping in `TraceabilityMiddleware` (CWE-117); `X-Client-Username` trusted (CWE-290); `POST /client/errors` has no rate limit; `logs/Main/` skipped by retention; day folders use server TZ, not `APP_TZ` | security / backend |
| 8 | Data-purge: race in `requestDeleteBackup`; `/backup`, download and verify not behind the strict limiter | backend |
| 9 | Test gaps: purge/backup/restore, integrity, alert state machine, `HealthStreamHub`, admin `/search` `/permissions` `/revoke` `/unblock-ip`; Super Admin can self-demote via `/permissions` | test / backend |

## 1. Goal

The latest eMeal (MEAL) code was pasted over CATHERINE so the template picks up eMeal's newer platform work: design system, backend runtime, architecture and security. All eMeal domain code then had to come out, so every new project starts from the same project-agnostic base.

## 2. Safety net

| Item | Where |
| --- | --- |
| Raw paste before any stripping | `refs/backup/emeal-paste` (commit `8204be2`). It is a local ref that is not on any branch and has not been pushed. |
| Template before the paste | `HEAD` (`1330b3f`) |
| Recover one file | `git show refs/backup/emeal-paste:<path>` or `git show HEAD:<path>` |
| Drop the backup when done | `git update-ref -d refs/backup/emeal-paste` |

Helper scripts are in `%TEMP%\catherine-merge\`. That is a temp folder, so copy the scripts out if you need them later.

| Script | Purpose |
| --- | --- |
| `RULES.md` | The merge and resolution rules every agent followed. **Read this first.** |
| `merge3.js` | Per-file 3-way merge. Base = the file at the commit that added it, ours = `HEAD`, theirs = the paste. |
| `purge.js` | The regex list of domain files that were deleted |
| `check-refs.js <dir> [--words]` | Lists unresolved relative imports, and with `--words` the lines containing domain words |

## 3. What was done

1. **Domain files deleted:** 608 untracked eMeal files.
   - Backend controllers, services, routes, models, constants and messages for billing, consumption, kiosk, menu, pay period, QR, reset requests, RFID, row resign, sales, subsidy, wallet integrity, transaction archive and settlements, plus the domain utils and email templates.
   - Frontend features `canteen`, `finance`, `masterdata`, `qrstubs`, `transactions`, `systemadmin/kioskconfig` and `systemadmin/walletintegrity`, plus the domain shared components.
   - Non-src folders: `Backend/scripts` (untracked files only), `datamigrationplan`, the domain folders under `dev-docs`, `Backend/docs/*`, `Frontend/plan` and `docs/_archive`.
2. **3-way merge** of the 219 modified tracked files. 27 merged cleanly, 7 kept the template version, and all 93 conflicted files were resolved by hand.
3. **Template-owned files restored** because the paste had overwritten them:
   - the Help Center (`features/support/help/**`, `HelpAssistant`)
   - `money.js` in the backend and frontend
   - both `vitest.config.js` files and both `audit-suppressions.md` files
   - both `CLAUDE.md` files
   - the changelog data (`changelog-dump.json`, `changelog.enc`, `seed-changelog.js`)
4. **Kept from the template:**
   - the money capability (`validateMoneyConfig`, `moneySafeFetchTypeHandler`, `MONEY_*`)
   - `DEMO_MODE`
   - standalone identity: `T_ADMINS_DEV` and `T_USERS_DEV`, with no HRIS
   - string roles
   - package identity
   - luminance-based theme colours and the renamed palettes
   - the Navbar active-link and focus fix (`a8cff47`)
   - the DocShell rail offset
   - HTTPS with no PEM fallback
   - the `VITE_API_BASE_URL` build guard
5. **Kept from eMeal:**
   - the cluster supervisor, RPC hub and primary state services
   - graceful shutdown with in-flight tracking
   - the request watchdog and readiness gating
   - the SSE registry and health stream
   - one-time refresh tokens with reuse detection and access-token revocation
   - login lockout and suspicious-IP tracking
   - the shutdown-gate middleware
   - CryptoVault, log redaction, BatchGuard and RetryPolicy
   - the alert notifier, backup schedule and log retention
   - integrity/tamper detection (the generic mechanism)
   - data purge and restore (generic)
   - the server status banner
   - the Architecture, Runtime and Dev Docs pages
   - design-system and accessibility fixes

## 4. Key decisions (revisit if they are wrong)

| Area | Decision |
| --- | --- |
| DB pools | eMeal's `Meal`, `MealBulk` and `userAccount` pools are now `appDb` and `appDbBulk`. The default in `createDb()` is `appDb`. |
| Auth stack | The live stack is `AuthControllers.js` + `AuthService.js`, rewritten against `AdminModel` and `UserModel`: admins are tried first, then users. `auth.service.js` is now only a re-export. The old `auth.controllers.js` was deleted. |
| Token claims | `sub`/`userId`/`username`, `id`, `role`, `userLevel`, `roleSource` (`admin` or `user`), `permissions`, plus `type`/`aud`/`iss` for eMeal's middleware checks. There is no GID. |
| Roles | `SUPER_ADMIN`, `ADMIN`, `USER`. An ADMIN can only create USER accounts and reset USER passwords. |
| Admin flags | `canReceiveSrvCrit`, `canReceiveSrvDeps`, `canReceiveSrvRed`, `canReceiveSrvSys`, `isActive` |
| Renames | `meal.*` cookies, issuer and storage keys are now `app.*`. The IPC prefix is now `app:`, and `MEAL_CLUSTER_RUN_ID` is now `APP_CLUSTER_RUN_ID`. |
| Removed features | Admin takeover, row re-sign voting, integrity cutoff and employee filters, and restore cutoff coverage |
| Scheduler | `schedulerJobs` is now `["dbBackup"]` only. `BackupScheduleService` has an event-source hook (`registerEventSource`), and the template registers no sources. |
| Purge registry | Example entries only: the template's log tables and `T_ADMINS_DEV`, on `appDbBulk` |
| Integrity registry | Empty, with an example comment |
| Frontend layout | Admin pages live in `features/systemadmin/**`. The old `features/management/**` was deleted. |
| Routes | `/home`, `/about/*`, `/system/{admin-management,logging-and-observability,metrics,data-integrity,data-purge}`, `/support/dev-docs` (ADMIN and SUPER_ADMIN), `/support/{architecture,runtime}` (SUPER_ADMIN) |
| Changelog | `GET /changelog` requires sign-in, as in eMeal. The public endpoints are `/changelog/public` and `/changelog/public/latest`. |
| Frontend deps | `jspdf` was dropped. `qrcode` stays because `qrGeometry.js` uses it. |

## 5. Current state (first check, 2026-10-28 — superseded)

> **Superseded.** Later the same day the user reported both suites green and lint clean: backend **77 files / 1254 tests**, frontend **32 files / 555 tests**, `npm install` and the frontend build done. `resetTypes.js` and its test are gone. The table below is the first post-merge check, kept for history.

| Check | Result |
| --- | --- |
| Conflict markers | None left |
| Unresolved imports (`check-refs.js`) | 15 in Backend/src and 19 in Frontend/src. The agents traced the ones they checked to code samples in comments and the reference pages; review the rest. |
| Domain-word lines | 27 in Backend/src and 12 in Frontend/src. Some are legitimate, such as "reclaim" for memory, and some are in the Help Center or Money docs. |
| Backend `npx vitest run` | **17 files and 197 tests failing**; 990 tests pass. Baseline before the paste: 76 files and 1187 tests, all green. |
| Backend demo boot | Starts and shuts down cleanly with `DEMO_MODE=true` |
| Frontend lint | 0 errors (according to the agent) |
| Frontend vitest | 554/554 (according to the agent) |
| Frontend build | **Blocked.** `npm install` has not been run, so `react-markdown`, `remark-gfm`, `rehype-highlight` and `mermaid` are missing. |

Failing backend test files:

- **Integration:**
  - `admin-management`, `audit-log`, `client-errors`, `csrf`
  - auth: `login`, `refresh`, `logout`, `change-password`
  - metrics: `metrics.test.js` and `metrics/{metrics,metrics-notifications}`
- **Security:** `auth-bypass`, `rate-limit`
- **Unit:** `auditLogStorage`, `emailProtection`, `httpStatusCatalog`, `resetTypes`

Known causes:

- `RateLimiterMiddleware` no longer exports `authRateLimiter`; it moved to `security/authRateLimiters.js`, but the tests still call `authRateLimiter.flushAll()`.
- The tests assume the old token claims; the middleware now requires `type`, `aud` and `iss`.
- `OraCode` maps ORA-1017 to 503, which `httpStatusCatalog` does not expect.
- `resetTypes.js` is a wallet taxonomy. Delete it together with `test/unit/constants/resetTypes.test.js`.
- `test/server/helpers/db.js:19` requires `../../src/config`, which does not resolve.
- `dataPurgeModel.pool.test.js` probably still expects the `"Meal"` pool.

## 6. Remaining work (in order)

> Status 2026-10-28: items 1-10 ✅ done; item 11 open. See §0 for the open list.

1. ✅ **Dependencies:** run `npm install` in both `Backend/` and `Frontend/` to regenerate the lockfiles; both are currently the eMeal lockfiles. Then run the frontend build:
   `$env:VITE_API_BASE_URL="https://example.invalid:3000/api/v1/"; npm run build`.
2. ✅ **Backend tests:** get the suite back to green using the causes in §5. Update the tests where the new behaviour is intended, such as the token claims and the rate-limiter location. Otherwise fix `src`.
3. ✅ **SQL schema** (done: `01_schema.sql` has all 9 `T_*_DEV` tables, `04_platform_tables.sql` adds them to an existing DB, and the refresh-token model has a demo branch): `sql/01_schema.sql` had none of the tables the eMeal platform code uses:
   - `T_AUTH_REFRESH_TOKEN`: `USER_ID` stores the username, so it must be a text column.
   - `SERVER_BACKUP_TOKEN_CONSUMED` and `SERVER_BACKUP_DELETE_VOTE`
   - `T_SYSTEM_CONFIG`
   - the alert-ack and audit actor columns, which now hold the numeric `req.user.id`

   Add DDL for them and extend the `DEMO_MODE` demo store where needed. `auth.refresh.token.model` has no demo-mode branch, so sign-in in demo mode may try to reach Oracle.
4. ✅ **`AdminModel` gaps** (done: `findById`, `search`, `countActiveByRole`, `withLastSuperAdminGuard`, `setEmail` exist in `admin.model.js`):
   - Add `findById`.
   - Add `withLastSuperAdminGuard`. It needs a row lock; today two concurrent revokes can race.
   - Add `setEmail` and `search(q, limit)`.
   - Fix `countActiveByRole(null)`, which builds `<> NULL`; the service currently passes `" "` as a workaround.
5. ✅ **Environment and deploy** (done: `.env` rebuilt, old copy at `Backend/.env.emeal.bak`; `.env.example` clean; `<stoptimeout>1860 sec`; only `catherine-backend*` deploy files remain):
   - `Backend/.env` is still the eMeal file: `APP_NAME=MEAL`, MEAL/UA DB variables and domain secrets. Rebuild it from `.env.example` with `APP_DB_*` and `DEMO_MODE`. Do not commit it.
   - Fix the garbled characters (`â€”`) in `Backend/.env.example` near `APP_TZ`.
   - In `deploy/winsw/catherine-backend-service.xml`, raise `<stoptimeout>` to about `1860 sec`. The shutdown failsafe can run for about 1844 s.
   - Delete the leftover `meal-backend-service.xml` and `deploy/systemd/meal-backend.service`, or rename them generically.
6. ✅ **Branding leftovers** (done: CIDs → `app-logo-*`, "Employee ID" → username, `emeal-mark.png` and the 2.x dumps deleted):
   - Email templates use the `cid:meal-logo-*` IDs, "Employee ID" and `{{robotNote}}`. Rename them together with `ServerNotificationService`, `AdminAccessEmailService` and `BackupEmailService`.
   - Delete `Backend/src/assets/emeal-mark.png` if nothing uses it.
   - Delete the leftover dumps `Backend/scripts/changelog-dump-2.1.1.json` and `changelog-dump-2.2.0.json`.
7. ✅ **Roles cleanup:** settle on SUPER_ADMIN, ADMIN and USER across the frontend. The old roles APPROVER, VIEWER, VENDOR and ROBOT are still in `ProfileModal.jsx`, `Navbar.jsx`, `SidebarHeader.jsx`, `nav.config.jsx`, the HelpAssistant hidden-roles list, the role tiers in `help.data.jsx` and `test/helpers/auth.js`.
8. ✅ **DocShell** (done: `RAIL_TOP` = `lg:top-6`): with eMeal's fixed-height shell, the 88px rail offset in top-bar mode leaves an extra gap.
9. ✅ **Vocabulary sweep** (code; source-app comments listed in §0 #7-8 remain): go through the remaining word hits (`check-refs.js ... --words`), the wrapper internals (`OracleCollection.js` and `oracleAdvanced.js` have wallet and sales examples), and `routes/integrity.route.js`.
10. ✅ **Docs** (done in the 2026-10-28 docs sweep except the 13 `dev-docs` pages and the `.claude` mirror copies — §0 #4, #10):
    - Update `Backend/CLAUDE.md` and `Frontend/Claude.md` (both are the template versions, now behind the code): middleware chain, pools, auth claims, routes, systemadmin layout.
    - Scrub `Backend/README.md`, `Frontend/README.md`, the platform `dev-docs/**` and `.claude/**` of eMeal wording.
    - Update `plans/template-hardening.md`.
11. ⬜ **Commit** in logical slices: purge, merge, auth rewrite, frontend, tests and docs. Do not push without review.

## 7. Final middleware chain (`Backend/src/app.js`)

1. Helmet
2. SecurityFilter
3. Traceability
   - 3a. AuditLog
   - 3b. ShutdownGate
4. Body parsers: JSON, urlencoded, `defaultBodyHandler`
   - 4a. `logIncoming`
5. ResponseTime
   - 5a. Metrics
6. Compression
7. CORS
8. CookieParser
9. CSRF (exempt: `/api/v1/csrf`, `/api/v1/metrics/frontend`)
10. `captureResponseBody`
11. IpFilter
12. RateLimiter
13. PreventRedirects

After the chain come the routes, the 404 handler and the error handler. The request watchdog is attached to the server's request event, not through `app.use`. Health paths are exempt from RateLimiter and ShutdownGate (each declares its own `HEALTH_PATH_RE`) and from the request watchdog (`EXEMPT_RULES`, see `health.route.js:106-110`).

## 8. Standing rules

- Authority order: code, then the surface `CLAUDE.md`, then the fleet profile, then skill files.
- No domain vocabulary in template files. The full list is in `RULES.md` §3.
- AppError message strings must not contain a top-level comma or an unbalanced bracket; `httpStatusCatalog.test.js` parses them.
- Use the logger, never `console`. Follow the three constants buckets (errors, responses, messages) and the three-layer frontend features.
- Never point tests at a real backend: MSW with `onUnhandledRequest: "error"`.
