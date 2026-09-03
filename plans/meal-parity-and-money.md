# Plan: CATHERINE ↔ MEAL Parity + Money Capability

**Status:** in progress — Phase 0 complete, Phases 2–4 substantially landed (verified 2026-09-03)
**Authored:** 2026-09-03
**Sources compared:** `D:\LocalWeb\Meal\MEAL-FE`, `D:\LocalWeb\Meal\MEAL-BE`
**Target:** `D:\LocalWeb\CATHERINE\Frontend`, `D:\LocalWeb\CATHERINE\Backend`

---

## TL;DR

CATHERINE is the boilerplate MEAL was built from. MEAL then ran nine months of
production traffic and hardened roughly thirty shared infrastructure files that
CATHERINE never received. This plan backports the **generic** half of that
hardening, then adds a first-class **money capability** to the template —
exact multi-currency arithmetic that **never rounds**, tamper-evident ledger
rows, an idempotent transaction surface, and live streaming — without importing
MEAL's canteen domain.

**The template gains money *capability*, not a money *feature*.** No Wallet, no
Transactions view, no Finance nav group, no money tables in `01_schema.sql` —
just the primitives, a reference doc page, and the tests that prove they work
(Phase 4).

The currency model is settled (§3.0): base-currency amounts at rest with **no
currency column**, conversion at fetch, view and export, storage scale fixed at
4, display scale 2 to 4 from an ISO 4217 registry.

It also closes out the uncommitted paste currently in the working tree, which
still has loose ends (Phase 0).

---

## 1. Where the two repos actually stand

Measured by file hash over both trees (`node_modules`, `.git`, `dist`,
`coverage`, `logs` excluded).

| | Common files | Content drifted | CATHERINE-only | MEAL-only |
|---|---|---|---|---|
| Frontend | 235 | 55 | 70 | 534 |
| Backend | 223 | 115 | 32 | 857 |

Re-measured 2026-09-03 with the same file-hash method. The earlier figures in
this document's history (222/46/68/547 frontend, 211/104/18/869 backend)
reflected the pre-implementation tree, before Phase 0 and the Phase 2–4 backport
work landed in the working copy. Both the common-file count and the drifted
count rose because files that used to be CATHERINE-only or untouched common
files now exist on both sides and differ in content — expected while a backport
is in flight rather than finished and committed. Most MEAL-only files are still
canteen domain (billing, subsidy, RFID, QR stubs, menu, kiosk) and its test
suites; those stay in MEAL. The interesting number is now the **170 drifted
common files** — shared infrastructure that exists in both repos and is
further along in MEAL, or in CATHERINE's case, mid-backport.

### 1.1 Where CATHERINE is already ahead

Do not regress these while backporting:

- **File-based audit log fallback** — `models/audit.log.file.model.js` plus
  `AUDIT_LOG_STORAGE=db|file|auto` routing. MEAL has no equivalent.
  `audit.log.model.js` is 312 lines here against 168 in MEAL.
- **Demo mode** — `config/demoMode.js` and `models/demo/demoStore.js`. Lets the
  template run with no Oracle at all.
- **Metrics** — `MetricsController.js` (223 vs 180), `serverAlertLog.model.js`
  (348 vs 252), plus `metrics-notifications.test.js`. The Metrics view and its
  eight tab components are CATHERINE-only.
- **Dependency versions** — `exceljs ^4.4.0` (MEAL: `^3.4.0`),
  `archiver ^8.0.0` (MEAL: `^6.0.2`), newer `axios`, `vite ^8.0.4`. Backport
  code, not `package.json` pins.
- **Template documentation features** — `Home`, `GettingStarted`,
  `DatabaseConnection`, `MiraOrm`, `CORSSetup`, the `DocsPage` shell, and the
  security demo panel. These are the template's actual product.
- **`utils/nanoidLoader.js`**, **`sql/01_schema.sql`**, **`scripts/seed-template.js`**.

### 1.2 Where MEAL is ahead

| Area | Evidence |
|---|---|
| Test coverage | Backend 402 test files in MEAL against CATHERINE's 77 on disk, 76 run (`test/encryption/cryptosuite.test.js` is excluded by `vitest.config.js` by design) / 1,187 tests, all passing. Frontend 180 in MEAL against CATHERINE's 1 test file / 30 tests, all passing — Phase 5.1's harness is now stood up, closing what used to be a **zero**. |
| Request lifecycle | `AuthMiddleware` +140, `TraceabilityMiddleware` +87, `AuditLogMiddleware` +237, `CacheMiddleware` +83 |
| Boot safety | `bootGuard` +39, `clusterRole` +61, `server.js` +749, `database.js` fail-closed target selection |
| Build safety | `vite.config.js` +177, `public/Web.config` +54, `eslint.config.js` +48 |
| Client resilience | `useRequest` +154, `HttpClient` +73, `storage` +82, `main.jsx` +69, `useSessionWarning` +58, `CsrfMiddleware` +53 |
| Status contract | Backend `constants/index.js` HTTP_STATUS expansion plus frontend `constants/httpStatus.js` (335 lines; CATHERINE has none) |
| Money discipline | `settlementFormula.js`, `excelFormat.js`, `excessFundReclaim.js`, `integrity/subsidySignedFields.js` |
| Excel pipeline | `utils/uploadOutcome.js` (445 lines) — the ledger invariant behind the stepper CATHERINE already has |
| Streaming | `utils/sse/ScopedSsePoller.js`, frontend `hooks/useLiveStream.js` |
| Ops docs | `audit-suppressions.md`, `deploy/DEPLOYMENT_RUNBOOK.md`, `deploy/DEPLOYMENT_CHECKLIST.md` |

---

## Phase 0 — Finish the working-tree paste

The uncommitted diff is 79 files, +2618 / −1043. Nothing else in this plan
should start until it is green.

### 0.1 Error-page colour palette — RESOLVED 2026-09-03

`views/errors/ClientErrorResponses.jsx` was pasted from MEAL and references the
`--err-*` custom-property palette 408 times. `assets/styles/index.css` initially
defined none of them, so every error illustration would have rendered with
unset colours.

The assets were re-pasted during planning. `index.css` is now **byte-identical
to MEAL** at 2380 lines with all 74 `--err-*` definitions present across the
light `:root` block and the dark override. No action remains beyond a visual
pass over the seven error routes in both themes.

### 0.2 Navigation points at routes that do not exist — RESOLVED 2026-09-03

`nav.config.jsx` no longer carries MEAL's verbatim IA. It now declares 12
unique `href` values, and every one of them resolves to a route mounted in
`App.jsx` — confirmed by cross-checking each `href` against `App.jsx`'s
`<Route>` list. **Zero dead links.** The rewrite followed the recommended
action below rather than the ComingSoon alternative: the canteen, finance,
master-data, kiosk, QR-stub and transactions groups were dropped entirely
rather than papered over, and the surviving items match the template's own
information architecture.

The structure actually landed:

```
PUBLIC        Home /home
              Getting Started /about/getting-started
              Sign In /auth

AUTH_FLAT     Dashboard /dashboard

Reference     Database Connection /about/database-connection
              Mira ORM /about/mira-orm
              Money and Currency /about/money             (Phase 4 — see 4.4)
              CORS Setup /about/cors-setup
              Version History /about/changelog

System        Admin Management /system/admin-management
              Logging and Observability /system/logging-and-observability
              Metrics /system/metrics                    (see 0.3)
```

This is close to, but not identical to, the plan's original recommendation —
notably `/about/help` did not survive as a distinct nav entry. The structural
point stands regardless: role-keyed `NAV_GROUPS`, per-item `color` / `icon` /
`description`, and the `canSeeVersion` disclosure policy were all kept from
MEAL, only the destinations changed. No further action needed here; the
remaining work that used to live under this heading (the metrics route, the
leftover MEAL vocabulary) is tracked under 0.3 below.

### 0.3 Orphaned and domain-coupled pasted code — RESOLVED 2026-09-03

- `features/management/metrics/Metrics.view.jsx` and its eight tab components
  now have a route: `App.jsx` mounts `<Route path="system/metrics"
  element={<MetricsView />} />`, and `/system/metrics` appears in
  `nav.config.jsx` (0.2). **Resolved.**
- **The generalise / delete / defer pass is DONE.** MEAL-vocabulary files under
  `Frontend/src` went from **24 to 3**, verified by the same grep this section
  was written against (`meal|subsidy|rfid|kiosk`, case-insensitive).

**Deleted — 31 files, permanently.** Every one was orphaned: nothing under
`features/` or `App.jsx` imported any of them, and the only real `import`
statements among them pointed at each other.

| Target | Files | Lines | Why |
|---|---|---|---|
| `components/shared/salesShared/` | 24 | ~2,400 | MEAL sales/billing domain. `salesShared.api.js` calls `sales-config/periods` and `billing/admin-list`, neither of which CATHERINE's backend serves. |
| `components/shared/EmailFailureModal/` | 6 | ~1,200 | 1,013 of its 1,203 lines are visual reproductions of MEAL's billing and QR-stub emails. It also imported `utils/qrStubPdf`, **which does not exist in this repo** — the component was already broken, not merely unused. |
| `features/auth/signInSubtitles.js` | 1 | 1,397 | Rotating sign-in copy, entirely eMeal-themed (menu board, Food Grade, QR stubs, subsidies, carry-over). Unreferenced by `Login.view.jsx`. |

These files were **untracked at `HEAD`** (`git ls-tree -r HEAD` returned zero
entries for `salesShared/` and `signInSubtitles.js`, two of six for
`EmailFailureModal/`). The "delete — git remembers" rationale this plan used
elsewhere therefore did **not** apply: the removal is irreversible and was
carried out on an explicit instruction after that was pointed out.

Post-deletion: `npx vite build` **succeeds** (20.11s), `npx eslint .` reports
0 errors, and the frontend suite passes 30/30 — confirming nothing depended on
them.

**Generalised — kept the mechanism, removed the domain.**

- `verifyStatus.js` was the only *live data contract* leaking MEAL vocabulary,
  not a comment: `CONFLICT_SUBTYPE_LABELS` shipped `NotInRFID`,
  `DuplicateESign`, `NoCutoff` and `BeforeReset` as status keys. Replaced with a
  generic starter set (`NotInMaster`, `OutOfPeriod`, plus the generic
  duplicate/invalid family); the two QR- and wallet-specific keys were dropped.
  The file header now states that this is a starter vocabulary a copier redefines
  to match their own backend classifier. `VerifyStatusBadge`'s JSDoc and its
  `props.status` union were updated to match.
- User-visible MEAL branding, four sites: `Changelog.view.jsx` ("What's changed
  in the eMeal Monitoring System" → "in this release"),
  `AdminManagement.view.jsx` ("duplicate-name check in RFID uploads" → "on bulk
  uploads"), `QRCode.jsx` (`emealMark` → `appMark`), and `useDocumentTitle.js`
  (example `"Dashboard — MEAL"` → `"— App"`, which also aligns it with the two
  other examples in the same block).
- 23 JSDoc lines across `ExcelUploadStepper/*` (4 files), `ExportButtons.jsx`,
  `VerifyStatusSummary.jsx` and `uploadOutcome.js`: every "Pay Period, RFID,
  Subsidy, QR Issuance" example list became feature-neutral, and
  `uploadOutcome.js`'s header now points at `Backend/src/utils/uploadOutcome.js`
  rather than `MEAL-BE/`.

**Kept deliberately — the remaining 3.** These cite MEAL as the *source of a
recorded lesson*, which is accurate provenance worth keeping:
`useRequest.js:112` (why a bare `invalidateCache()` must not fan out — it turned
1203 passing tests into 40 failures), `Money.view.jsx:199` (the four-copy
projection drift behind §3.4), and `main.jsx:41`, where "kiosk" is ordinary
English describing a machine that never reloads, not the canteen domain.

**Still orphaned, not in scope of this pass:**
`components/shared/downloadRequest/` (2 files) has no importer either, but
carries no MEAL vocabulary and was left in place. `ConsumptionStreamProvider.jsx`
named in the original pass no longer exists.

### 0.4 Standing lint errors — RESOLVED 2026-09-03

The three pre-existing errors carried from the last commit — `paramsSnippet`
unused in `AuditLogTable`, two unused setters in `DeleteLoggingTab` — are
fixed. `npm run lint` now reports **0 errors, 2 warnings** (both
`react-hooks/exhaustive-deps`, at `AdminManagement.view.jsx:284` and
`useDocumentTitle.js:44` — see Verification, 2026-09-03). Neither warning is a
regression from this backport; both are pre-existing and out of scope here.

**Exit criteria:** `npm run lint` clean — **met** (0 errors). `npm run build`
succeeds — **met** (`npx vite build`, 20.11s, after the 0.3 deletions). Every
nav item resolves to a mounted route — **met** (0.2). All seven error pages
render correctly in light and dark — not re-verified visually in this pass;
0.1's byte-identical CSS makes
this likely but it remains an unconfirmed manual check.

---

## Phase 2 — Backport shared infrastructure

Generic hardening only. Each item below is a real failure MEAL hit in
production, which is why it is worth taking rather than re-deriving.

### 2.1 Frontend

**Landed (verified 2026-09-03):** all five new files below exist in the tree —
`src/constants/httpStatus.js` (329 lines), `src/utils/pagination.js` (105
lines), `src/contexts/theme/useTheme.js` (26 lines), `src/hooks/useLiveStream.js`
(106 lines), `src/hooks/useExportAccess.js` (52 lines) — plus
`eslint-rules/jsx-uses-vars.js` (158 lines). The design rationale below is
still the reference for why each one is shaped the way it is; existence was
confirmed by file presence and line count only, not by re-reading every rule
inside them against MEAL's originals.

| File | Δ | What to take |
|---|---|---|
| `src/hooks/useRequest.js` | +154 | A `SUBSCRIBERS` map so a keyed `invalidateCache(key)` notifies **mounted** consumers, not only future ones, plus the `latestCallRef` key-currency token guard. **Preserve MEAL's rule:** a bare `invalidateCache()` deliberately does *not* fan out — notifying there turned 1203 passing tests into 40 failures from cross-test cache bleed. |
| `src/middleware/HttpClient.js` | +73 | A 30s default Axios timeout, since Axios ships with none; the `CSRF_ERROR_CODES` allow-list so only the four CSRF 403s retry while business-rule 403s pass through untouched; `TRACEABILITY_EXEMPT`; and the extracted navigation seam that makes the takeover destination assertable in tests. |
| `src/middleware/security/CsrfMiddleware.js` | +53 | `AbortSignal.timeout` on all three CSRF endpoints. Without it, a backend that accepts the TCP connection but never replies strands `CsrfGate` on `<LoadingScreen/>` permanently — the promise neither resolves nor rejects, so the retry loop never fires either. Keep the reasoning for `AbortSignal.timeout` over `AbortController`: it self-cleans, and Vitest fake timers do not replace it. |
| `src/hooks/useSessionWarning.js` | +58 | The `expiredRef` latch (CWE-362 — StrictMode double-invoke and throttled background ticks fired signout twice, freezing the modal); an absolute wall-clock deadline instead of tick counting, because background tabs coalesce `setInterval` and tick math stalls before reaching zero; cross-tab `storage` event sync; and the hard-navigation fallback mirroring the HttpClient 440 path. |
| `src/hooks/useDebounce.js` | +15 | The `maxWaitTimer` must not be cleared on every keystroke. The per-value cleanup was restarting it in lockstep with the trailing timer, and since `maxWait > delay` by convention the trailing timer always fired first — making the max-wait flush permanently inert. |
| `src/utils/storage.js` | +82 | The SSR-safe `safe()` wrapper, the `session` namespace, and `stashErrorPagePayload` / `consumeErrorPagePayload` / `resetErrorPagePayloadCache` — the handoff the pasted `ClientErrorResponses` expects. **Rename** the key `meal.errorPage.payload` to `app.errorPage.payload`. |
| `src/main.jsx` | +69 | `vite:preloadError` stale-chunk recovery with a 60s cooldown. Every route is `lazy()`, and a redeploy rehashes every chunk, so a tab left open overnight requests a filename that 404s — and the only ErrorBoundary that could catch it lives inside the chunk that failed to load. The timestamp guard makes it self-limiting so it cannot reload-loop. **Rename** `meal:chunk-reload-at`. |
| `vite.config.js` | +177 | Production build guards: fail the build when `VITE_API_BASE_URL` is unset, because the runtime falls back to `http://localhost:3000` in *every deployed browser*; and when it is plain `http://`, because the HTTPS SPA blocks it as mixed content. `VITE_ALLOW_INSECURE_API=true` is the documented escape hatch. Also `cspWebConfigPlugin`, which substitutes the API origin into `dist/Web.config`'s CSP `connect-src` and fails the build if the placeholder survives. This closes the gap flagged in the last commit message. |
| `public/Web.config` | +54 | The CSP placeholder and the `/assets/` rewrite exclusion the chunk-recovery handler depends on. |
| `eslint.config.js` + `eslint-rules/jsx-uses-vars.js` | +48 | A local `jsx-uses-vars` reimplementation, because core `no-unused-vars` does not treat `<Icon/>` as a use of a renamed destructured param; `ignoreRestSiblings` for the omit idiom; and separate global blocks for build tooling (Node) and tests (jsdom inside Node). |
| `src/utils/formatters.js` | +28 | `formatCompactNumber` for badge and pill counts. |

**New files:**

- `src/constants/httpStatus.js` (335 lines) — the takeover-versus-inline decision
  for every status the API can return. Pairs with §2.2's backend expansion. The
  load-bearing rule: 401, 403, 409, 422 and 423 are **not** takeovers. The
  backend uses them for business-rule failures, and hard-navigating on one
  destroys an in-progress form over what is semantically a validation message.
- `src/utils/pagination.js` — `DEFAULT_PAGE_SIZE`, `buildPageSizeOptions`,
  `usePagination`. One rows-per-page vocabulary for every table.
- `src/contexts/theme/useTheme.js` — context object and hook split out of
  `ThemeContext.jsx` for `react-refresh/only-export-components`.
- `src/hooks/useLiveStream.js` — SSE connection lifecycle. Prerequisite for
  Phase 4.
- `src/hooks/useExportAccess.js` — role gate for export buttons. A UX gate only;
  the server still re-checks.

### 2.2 Backend

**Landed (verified 2026-09-03):** all four new files below exist —
`src/utils/uploadOutcome.js` (436 lines), `src/utils/excelFormat.js` (293
lines, also load-bearing for §3.3), `src/utils/textNormalize.js` (202 lines),
`src/utils/sse/ScopedSsePoller.js` (311 lines). As with 2.1, the design
rationale is unchanged and still applies; confirmation here is existence and
line count, not a line-by-line diff against MEAL's version of each file.

| File | Δ | What to take |
|---|---|---|
| `src/constants/index.js` + `src/constants/responses/index.js` | +29 / +278 | The HTTP_STATUS expansion: 408, 410, 413, 423, 428, 440, 498, 504, 507, 523, with titles. Take **only** the status entries — the other 277 added error keys and the response messages are MEAL domain. Add the three-way contract test (backend status ↔ backend title ↔ frontend mirror). |
| `src/middleware/authentication/AuthMiddleware.js` | +140 | `_describeCredential()` and the `[AUTH @ …]` trace line. It emits credential **source**, cookie **names**, and signed-cookie verification outcome, and never a token, a fragment of one, or its length (CWE-522 / CWE-532 — a JWT logged once is a replayable session for as long as it is valid, and the Logs UI renders those lines to any ADMIN). This is what separates "never logged in" from "browser dropped the cookie" from "cookie was tampered with", which are otherwise indistinguishable from the response status. |
| `src/middleware/traceability/TraceabilityMiddleware.js` | +87 | Split `logIncoming` out of `handle`. `handle` has to stay above the body parsers because it mints `req.id` and opens the AsyncLocalStorage context that a malformed-JSON 400 still needs — but that means `req.body` does not exist yet, so the incoming line printed `[BODY @ req.body is undefined]` on every POST while the completion line showed the real body. |
| `src/middleware/traceability/AuditLogMiddleware.js` | +237 | Two-tier sensitive-parameter redaction. Tier 1 matches as a substring against the normalised key (`password`, `secret`, `token`, `apikey`); Tier 2 matches whole tokens only (`auth`, `session`, `pin`, `otp`, `mfa`, `salt`) because substring matching blinds the audit log on `author`, `possession`, `pinned`, `footprint`. `hash` is dropped entirely — in a template with row-hash integrity, a bare `rowHash` is audit **evidence**, not a secret, and redacting it deletes exactly what an auditor investigating tampering needs. |
| `src/middleware/cache/CacheMiddleware.js` | +83 | `options.shouldCache(req, body)` to skip caching in-flight or preview payloads; `invalidateOnFinish()` for non-JSON responses, since a streamed `.xlsx` never hits the `res.json` override and so silently skipped invalidation; and the array-of-patterns fix in `invalidate()`, where an array previously produced the comma-joined pattern `"a,b"` that matches no key. |
| `src/config/bootGuard.js` | +39 | The production `CORS_ORIGINS` guard. Unset, the server boots clean, passes its own health checks and serves curl fine, while every browser request from the deployed frontend is blocked with an opaque CORS error and no server-side signal. `CORS_ALLOW_BROAD_PATTERNS=true` satisfies the guard as the documented opt-in. |
| `src/utils/clusterRole.js` | +61 | Fail-**closed** cron leader election (`=== "true"`, not `!== "false"`), plus `electionHealth(envs)` returning `{leaderCount, healthy, severity}`. The template must ship the safe default: money-moving scheduled jobs are not reliably idempotent, so N workers all failing open to leader move money N times. Fail-closed alone only trades duplication for silent starvation — what actually closes it is `electionHealth` plus `logger.crit` plus re-election on worker exit. |
| `server.js` | +749 | Take the generic parts: the `TZ` pin before anything constructs a `Date`, libuv thread-pool sizing, the cron-leader election and re-election loop, and `electionHealth` reporting. Leave MEAL's job bodies behind. |
| `src/services/email/SharedTransporter.js` | +214 | Transport hardening. Keep CATHERINE's neutral `noreply@app.internal` default. |
| `src/config/adapters/oracle.js` | +121 | PKG-safe `.env` path resolution. Never a bare relative `.env` — that resolves against `process.cwd()`, which is only the exe's directory because the WinSW service config happens to set it. |
| `src/config/database.js` | +72 | Adopt the **pattern**, not MEAL's pools: select the credential set by environment variable with a fail-closed `throw` on an unrecognised value, never by editing source. MEAL shipped for months with production silently bound to the TEST schema because the choice was a commented-out block — and all 7,087 backend tests passed, because the suites *wanted* the test database. Document this in `sql/README.md`. |

**New files:**

- `src/utils/uploadOutcome.js` (445 lines) — the row-outcome ledger enforcing
  `inserted + updated + skipped + failed + pending === total`, with a non-zero
  remainder reported as `balanced: false` and logged at CRIT. CATHERINE already
  ships the frontend `ExcelUploadStepper` and its client mirror
  `ExcelUploadStepper/uploadOutcome.js`; this is the missing server half.
- `src/utils/excelFormat.js` (224 lines) — `toExcelDate` and `moneyFmt()`. Also
  Phase 3; see §3.3.
- `src/utils/textNormalize.js` (223 lines) — typographic folding before hashing
  or persisting. **Verify CATHERINE's target charset first** (open question 1).
  MEAL's rationale is `WE8ISO8859P15`, where Oracle silently substitutes an
  inverted question mark for em-dashes, curly quotes and the peso sign rather
  than raising ORA-12899. On `AL32UTF8` this is unnecessary, so ship it
  configurable rather than always-on.
- `src/utils/sse/ScopedSsePoller.js` (318 lines) — a generic scope-keyed SSE
  registry: one shared polling interval, a per-scope error bulkhead, and
  `Promise.all` fan-out so a slow scope cannot delay the rest. Keep the
  load-bearing ordering note — purge the cache **before** broadcasting `update`,
  or the client refetches and is served the stale rows it was just told changed.
- Dependency: `node-cron ^4.2.1`.

---

## Phase 3 — Money core

This is the "CATHERINE should be capable of handling money" requirement. Extract
MEAL's money **discipline** without its formulas. `settlementFormula.js`,
`excessFundReclaim.js` and `subsidySignedFields.js` are canteen business rules
and stay in MEAL. What generalises is how they are written.

### 3.0 Currency model — DECIDED 2026-09-03

Multi-currency, with **no currency column on any money table**. Raw amounts go
in; conversion happens on fetch, view and export. Display scale ranges from 2 to
4 decimal places.

CATHERINE has **zero money columns today**, so this is a clean-slate design with
no migration burden. Four rules make the currency-less column sound.

**Rule 1 — every money column holds the base currency, always.**

An amount with no currency attached is only unambiguous if the currency is a
system constant rather than a per-row fact. So:

- `MONEY_BASE_CURRENCY` (ISO 4217) is an environment variable, validated at boot
  by `bootGuard` against the currency registry. In the template this is the
  whole mechanism — no table required.
- A copier who wants it durable also stamps it into a config row once, so the
  value survives an env edit. Either way it is a *system* fact, never a column on
  a transaction row. Their rule holds: no currency column on a money table.
- **Invariant:** a non-base amount must never reach a money column raw.
  Conversion happens at the *write* boundary, before persist. A single
  foreign-denominated value written unconverted corrupts the ledger permanently
  and undetectably, because nothing records that the row is different.
- `bootGuard` must **refuse a base-currency change** when ledger rows already
  exist, unless an explicit migration flag is set. Otherwise flipping one env var
  silently reinterprets every historical row. In the template this guard ships
  armed but inert — it activates once a copier names their money table in
  `MONEY_LEDGER_TABLES`, which is also what makes it testable here (§5.2).

**Rule 2 — storage scale 4 is an input constraint, not a rounding rule.**

`NUMBER(19,4)` for every money column. Fifteen integer digits, four decimals.
Presentation scale (2 to 4) comes from the currency registry at render time.

Because **nothing is ever rounded** (rule 3), scale 4 is enforced at the door:
an input carrying more than four decimal places is **rejected with a 400**, never
silently rounded to fit. Rounding-on-write is the failure this rule exists to
prevent — it accepts a value the caller supplied and stores a different one,
with no record that the substitution happened.

Storage scale is deliberately *not* per-currency. A per-column scale reintroduces
exactly the ambiguity the currency-less design is avoiding — two money columns
could not be summed or compared without knowing which scale each carried.

**Rule 3 — exact decimal arithmetic. Nothing is rounded. (Decided 2026-09-03)**

`Number` is out, and so is MEAL's `r2` — `roundTo` on every operation *is*
rounding, so both options from the previous draft are eliminated by this
decision rather than chosen between.

`money.js` exports a `Money` value type over a `BigInt` coefficient with an
explicit scale. Addition, subtraction and multiplication are **exact and never
round**: the result scale grows as the mathematics requires (`scale(a) + scale(b)`
for a product) and the full value is retained.

Two operations cannot be exact, and both are made explicit rather than hidden:

- **Division.** `100 ÷ 3` has no finite decimal representation, in this or any
  system. `divide()` therefore *requires* an explicit working precision at the
  call site and returns `{ quotient, remainder }`. There is no default precision
  and no silent truncation — the residue is handed back so the caller must
  account for it.
- **Allocation.** Splitting ₱100 three ways cannot give three equal exact parts.
  `allocate(weights)` distributes by largest remainder so the parts sum to the
  original **exactly** (`33.3333 + 33.3333 + 33.3334 = 100.0000`). This is exact
  partition, not rounding: no value is created or destroyed.

**Wire format is a string, never a JSON number.** `"1500.0000"`. A JSON number is
an IEEE-754 double, so serialising money as one rounds it at the transport layer
regardless of how exact the arithmetic was.

**Rule 3a — the driver must stop rounding first. (Revised 2026-09-03)**

This is where "no rounding" is actually won or lost. There is **one** enforcement
point, in the driver, plus one piece of dead code that would undo it.

1. **node-oracledb returns every `NUMBER` as a JavaScript double.**
   `src/config/adapters/oracle.js` sets `outFormat: OUT_FORMAT_OBJECT` and
   `fetchArraySize`, but no `fetchAsString` and no `fetchTypeHandler`. So an
   exact `NUMBER(19,4)` is rounded to a double *inside the driver*, before any
   application code sees it. This is the only live rounding step on the read
   path.

2. **`convertTypes` is dead code, not an active second step.** An earlier draft
   of this plan claimed the ORM re-rounds after the driver. That was wrong.
   `src/utils/oracle-mongo-wrapper/utils.js` `convertTypes()` / `rowToDoc()`
   coerce numeric strings back to `Number` —

   ```js
   const n = Number(val);
   out[key] = isFinite(n) ? n : val;
   ```

   — and its own JSDoc example is `SALARY: "50000.50"` → `50000.5`, a money
   field. But it is **exported and called nowhere**: not inside the wrapper, not
   anywhere in `src/`. The live path is `conn.execute(...)` returning
   `result.rows` untouched (`core/OracleCollection.js:199`). So `fetchTypeHandler`
   alone is sufficient today, and the ORM needs no opt-out flag.

   It remains a trap — a lava-flow export that silently re-rounds money the day
   someone adopts it. Treat it as part of this rule, not a separate change: see
   §3.0 rule 3b.

**Rule 3b — how the driver is configured. (Open question 1, resolved.)**

A **`fetchTypeHandler` in `src/config/adapters/oracle.js`**, not a global
`oracledb.fetchAsString` and not an ORM flag.

```js
// src/config/adapters/oracle.js — inside EXECUTE_OPTIONS
fetchTypeHandler(metaData) {
    // Oracle reports scale on NUMBER columns. A scaled NUMBER is money or a
    // rate; fetch it as a string so the driver's double conversion never runs.
    // Scale 0 (IDs, counts, STATUS_CODE) stays a JS number — those are exact
    // integers well inside MAX_SAFE_INTEGER and every existing caller expects
    // a number.
    if (metaData.dbType === oracledb.DB_TYPE_NUMBER && metaData.scale > 0) {
        return { type: oracledb.STRING };
    }
}
```

Why this shape, over the two alternatives:

- **Not `oracledb.fetchAsString = [DB_TYPE_NUMBER]`** — that is process-global and
  unconditional. Every `NUMBER` in the codebase becomes a string, including
  `STATUS_CODE`, row counts, and every ID. That silently breaks arithmetic and
  strict comparisons across `MetricsService`, `AuditLogService`, and the metrics
  dashboards, none of which are money. Blast radius: the whole app, for a money
  feature the template does not ship.
- **Not an ORM `raw` flag or column allow-list** — an allow-list of money column
  names is a magic-string registry that must be updated by every copier for every
  new money column, and silently rounds when they forget (Spec 13: stringly-typed
  configuration). It also puts money knowledge inside `oracle-mongo-wrapper`,
  which is a general-purpose Apache-2.0 library with no business of knowing what
  money is. And, per rule 3a, the ORM is not on the rounding path at all — a flag
  there would guard nothing.

Selecting on **`scale > 0`** is the key move: it derives the decision from the
schema rather than from a maintained list. Declare a column `NUMBER(19,4)` and it
is protected automatically. This is also why §3.7.3's two column classes matter —
both posted amounts (`19,4`) and rates (`19,8`) have scale > 0 and are caught;
`NUMBER(3)` status codes and `NUMBER` ids have scale 0 and are not.

Blast radius is real but bounded: any existing code doing arithmetic on a
*scaled* `NUMBER` now receives a string. Grep for scaled columns before landing —
in CATHERINE's current schema there are **none** (every `NUMBER` in
`sql/01_schema.sql` is `NUMBER(3)` or unscaled), so the change is inert on the
template today and only takes effect once a copier declares a money column. That
is exactly the property that makes it worth doing now rather than later.

**Also delete or fence `convertTypes` / `rowToDoc`.** They are unreferenced
exports whose only effect, if adopted, is to undo this rule. Preferred: delete
them (git remembers — Spec 13, lava flow). If they must stay for API
compatibility, add a header stating they must never be applied to a scaled
`NUMBER`, and cover it with the regression test in §5.2.

*Verification note:* `node_modules` is not installed in this checkout, so the
`fetchTypeHandler` signature above was written from the node-oracledb 6.x API
(introduced in 6.0; `package.json` pins `^6.10.0`) and not executed. Confirm
against the installed driver when Phase 3 starts.

**Rule 4 — convert with the rate as of the row's own timestamp.**

The rate table is keyed by currency and effective date. It holds *rates*, not
per-row currency, so their rule still holds.

Conversion on fetch, view and export uses the rate as of the row's `CREATED_AT`,
**not** today's rate. Converting a settled 2024 transaction at today's rate means
a historical statement reports a different value every time it is opened — which
is wrong on an accrual basis, where a settled transaction's reported value is
fixed at its transaction date.

A live-rate conversion is still fine as a *display convenience* — but it must be
labelled indicative, and must never appear on an exported financial document.

**Converted values are never persisted.** This is what makes rules 2 and 3
consistent with each other. `amount × rate` is an exact multiplication, and its
result carries `scale(amount) + scale(rate)` decimal places — twelve, if a
4-decimal amount meets an 8-decimal rate. That product could not be written to a
`NUMBER(19,4)` column without rounding, so it never is. It is computed at read
time, held exactly in memory, and formatted for display at the target currency's
scale. Formatting a presentation string is not rounding the data: the exact value
is still there behind it.

**Currency registry — codes, never symbols.**

**Landed (verified 2026-09-03):** `Backend/src/constants/currencies.js` (121
lines) and its frontend mirror `Frontend/src/constants/currencies.js` (89
lines) both exist.

`Backend/src/constants/currencies.js`: ISO 4217 code, display scale, symbol, and
locale per entry. Only the three-letter code is ever persisted.

This also disposes of open question 1 for currency specifically: `₱` has no code
point in `WE8ISO8859P15` and would corrupt silently, while `PHP` is pure ASCII
and safe on any charset. Symbols render client-side from the registry.

### 3.1 `Backend/src/utils/money.js` — NEW

**Landed (verified 2026-09-03):** `Backend/src/utils/money.js` exists at 556
lines, with `test/unit/money.test.js` (330 lines) covering it. The design
rationale below is the reference for what each method must do; this pass
confirmed the file and its test exist, not that every rule below is
implemented exactly as written.

An exact decimal value type: a `BigInt` coefficient plus an explicit scale. No
operation rounds.

- `Money.from(value)` — accepts a **string** (the canonical form) or an Oracle
  `NUMBER` already fetched as a string. Rejects a JavaScript `Number` outright:
  by the time a money value is a double it has already been rounded, and
  accepting one would silently launder that loss. Also rejects NaN, Infinity, and
  more than four decimal places (rule 2). MEAL's `safeNum` clamps a non-finite
  input to `0`, which is right for a *display* projection and wrong for a *ledger*
  write — it turns a bug into a plausible-looking amount. A ledger write throws.
- `add`, `sub`, `mul` — **exact**, result scale grows as the mathematics
  requires. `negate`, `abs`, `compare`, `isZero` — exact.
- `divide(divisor, { precision })` — `precision` is **required**, no default.
  Returns `{ quotient, remainder }` so the residue is never silently discarded.
- `allocate(weights)` — exact partition by largest remainder. The parts always
  sum to the original with nothing created or destroyed.
- `assertBalanced(parts, total, label)` — throws `AppError` when a split does not
  sum to its whole. Mirrors the `CHK_SETTLE_DED_SPLIT` constraint pattern, and
  becomes a genuine invariant rather than a rounding-order convention now that
  no step rounds.
- `toStorage()` — the fixed-scale-4 string written to Oracle and used in row
  hashing (§3.4). Throws rather than truncates if the value carries more than
  four decimals, which is how a conversion product is stopped from reaching a
  money column (rule 4).
- `format(currencyCode, locale)` — presentation only, at the registry's display
  scale. This is the one place a value is shortened for a human, and it never
  feeds arithmetic or storage.

### 3.2 Schema and column contract

- Every money column is `NUMBER(19,4)`. Never bare `NUMBER`, never `FLOAT`, never
  a raw scaled integer column.
- No `CURRENCY` column on money tables. Base currency lives in config (§3.0).
- Add the rule to `Backend/CLAUDE.md` and `Backend/sql/README.md`.
- `CHECK` constraints for non-negative balances and for split invariants wherever
  a total decomposes into parts.
- Bind money as its fixed-scale **string** through `parseUpdate`, so the value
  never round-trips through a JavaScript double on the way to a `NUMBER(19,4)`
  column.

### 3.3 Excel and export

**Landed (verified 2026-09-03):** `Backend/src/utils/excelFormat.js` exists at
293 lines (see also §2.2's Landed line — this is the same file, listed there as
a new backend infrastructure file and here for its money-specific role).

`excelFormat.js` from §2.2 is money-critical on both counts.

**`moneyFmt(currencyCode)`** gives one number format per currency, derived from
the registry's symbol and display scale, with negatives in red so a credit is
never read as a debit at a glance. Before it, MEAL had `SalesDownloadService`
and `QrManagementService` each carrying a private `"#,##0.00"` while
`BillingService` used `'"₱"#,##0.00'` — same figures, three files, two answers.

Two multi-currency additions on top of MEAL's version:

- The format is built from the registry, not hardcoded, so a workbook rendered
  in a 3- or 4-decimal currency does not silently truncate to 2.
- Every exported workbook carries the currency and the **conversion basis** in a
  header row: base currency, target currency, and whether rates were taken as of
  each row's own date (§3.0 rule 4) or a single live rate. An exported figure
  with no stated basis is not auditable.

**`toExcelDate`** fixes a silent timezone defect. ExcelJS converts a JS `Date`
to an Excel serial with a pure **UTC** epoch calculation, while node-oracledb
builds `DATE` values from the stored wall clock interpreted in the **process
local zone**. The two conventions disagree by exactly the UTC offset, so a row
stored `08/17 06:01 AM` was written into the workbook as `08/16 10:01 PM` — and
because ExcelJS defaults an unstyled date cell to `mm-dd-yy`, the reader saw
only the wrong date, with the time that would have made the shift obvious
stripped out. The helper pre-shifts by the value's own `getTimezoneOffset()`,
which keeps it DST-correct and zone-agnostic rather than depending on the
process happening to run at UTC+8.

### 3.4 Ledger integrity

CATHERINE already ships `CryptoVault.js` (1639 lines) and
`cryptoVaultRowHash.test.js`. What is missing is the projection layer.

**Landed (verified 2026-09-03):** `Backend/src/utils/integrity/signedFields.js`
exists at 149 lines, with `test/unit/signedFields.test.js` (98 lines) covering
it.

`Backend/src/utils/integrity/signedFields.js` — NEW, generalised from
`subsidySignedFields.js`. A factory taking a domain key and a field list,
returning **one** projection function used by both signer and verifier.

The lesson worth encoding: MEAL's projection drifted into four copies, two using
`parseFloat`-with-NaN-to-zero and two using raw `Number()`. Those disagree on
`undefined` and on `"12abc"`, so a legitimately corrected row could never verify
and showed as **TAMPERED** in the Integrity Center forever. An HMAC only
verifies when signer and verifier build byte-identical field objects, so there
must be exactly one builder.

**Money fields must be canonicalised before they enter the payload.**
`CryptoVault.buildPayload` builds each part as `` `${k}=${fields[k]}` `` — raw
JavaScript interpolation. For a money value that means:

```
1500          -> "1500"
1500.00       -> "1500"        (JS drops trailing zeros on a Number)
"1500.5000"   -> "1500.5000"
1500.5        -> "1500.5"
```

Four spellings of two amounts, four different payloads, four different digests.
Oracle returns a `NUMBER(19,4)` to node-oracledb as a JavaScript number, so a row
signed at write time from a string and verified at read time from a number can
never match — the same class of failure as MEAL's four-copy drift, arriving
through a different door.

`signedFields.js` therefore owns a money canonicaliser: every money field passes
through `Money.toStorage()` (fixed scale 4, explicit trailing zeros) before it
reaches `buildPayload`. Signer and verifier share that one function.

### 3.5 Idempotency — NEW, no MEAL equivalent

**Landed (verified 2026-09-03):**
`Backend/src/middleware/security/IdempotencyMiddleware.js` exists at 239
lines, with `test/unit/IdempotencyMiddleware.test.js` (191 lines) covering it.

This is not a backport. MEAL does not have it, and it is precisely the gap its
own `clusterRole.js` header describes: a duplicated money-moving tick is not
recoverable.

`Backend/src/middleware/security/IdempotencyMiddleware.js`:

- The client sends `Idempotency-Key` on every money-moving POST, PUT or PATCH.
- Key plus route plus caller plus request-body hash maps to a stored outcome,
  with a TTL.
- A replay with the same key returns the stored response. The same key with a
  different body is a 409.
- Backed by the existing cache registry, as a dedicated store with its own TTL.

Mount it **after** `RateLimiterMiddleware` (position 13) and before the route
handler. The 14-step chain is otherwise untouched.

### 3.6 Transaction discipline

`oracle-mongo-wrapper/Transaction.js` is already identical in both repos. What
is missing is the codified usage rule. Add to `Backend/CLAUDE.md`:

- Every multi-row money mutation runs inside
  `new Transaction(db).withTransaction(async (session) => { ... })`.
- Named savepoints for partial rollback in batch credit paths.
- Every write goes through `parseUpdate` bind variables, with no interpolation.
  The one documented exception remains `PIVOT IN (...)`.

### 3.7 Accounting rules (Senior Accountant, 2026-09-03)

The preceding sections settle how money is *represented*. These settle how it is
allowed to *behave*. They are booking rules, not engineering preferences, and
each one has an audit consequence if broken.

**3.7.1 — Posted versus derived. This decides the residue policy.**

The previous draft asked one question ("what happens to a division remainder")
that is really two, with opposite answers:

| Operation | Output is | Residue rule |
|---|---|---|
| `allocate(weights)` | **posted** — money owed to a party | Largest remainder. Parts must sum to the total **exactly**. |
| `divide(d, { precision })` | **derived** — a unit cost, rate, or display figure | Remainder returned as evidence. Nothing is posted, so nothing is owed. |

For a posted amount the total is authoritative and must be preserved: double-entry
has no bucket for an unallocated fraction. Split ₱100 three ways, pay out
`33.3333 × 3 = 99.9999`, and the books are ₱0.0001 out. That is the accounting
identity failing, not a formatting nit.

Two consequences worth stating plainly:

- **Refusing the operation is not an option** for allocation. "Cannot split ₱100
  three ways" is not an acceptable answer to a business that must split ₱100
  three ways. `allocate()` always succeeds and always balances.
- **A rounding-difference account is the wrong instrument here.** It is real —
  IAS 21 / ASC 830 cumulative translation adjustment — but it belongs to
  translation on consolidation, not to apportionment. Absorbing allocation
  residue into an equity account hides an allocation decision where no reviewer
  will look for it.

**3.7.2 — `allocate()` needs a deterministic tie-break. Blocking.**

Largest-remainder is under-specified when two parties tie on remainder: whichever
the input array happens to order first receives the extra centavo. Re-run the
same allocation and the answer can differ.

That is a reproducibility failure, not a rounding one. An auditor re-running a
period report must obtain byte-identical figures. **Tie-break on a stable
business key (ID ascending) — never on array position, object key order, or
insertion order.** Assert it in the property tests (§5.2): shuffling the input
must not change any party's allocated amount.

**3.7.3 — Two column classes, not one.**

Scale 4 with rejection above it (§3.0 rule 2) is correct for a **posted amount**:
a settlement of ₱0.00001 cannot be paid, and 4 places accommodate 3-decimal
currencies (KWD, BHD, OMR) with one to spare.

It is wrong as a blanket rule. A unit price or rate legitimately carries more
precision — `₱0.000125 × 1,000,000 units` is an ordinary figure.
`T_FX_RATE_DEV.RATE NUMBER(19,8)` already reflects this; the principle was never
stated. So:

| Class | Type | Rule |
|---|---|---|
| Posted amount | `NUMBER(19,4)` | Input above 4 decimals rejected with 400 |
| Rate / unit price | `NUMBER(19,8)` | Higher scale permitted; never itself a posting |

`Money.toStorage()` enforces the first. A rate is a different value type and must
not be passed through it.

**3.7.4 — Ledgers are append-only. Corrections are reversing entries.**

A posted row is never `UPDATE`d. A mistake is corrected by posting an equal and
opposite entry plus the correct one, leaving both visible.

This has a direct bearing on §3.4. MEAL's `subsidySignedFields` story is about
*correcting a row in place and re-signing it* — which is why signer/verifier
drift was able to make legitimate rows read TAMPERED. Row hashing detects
tampering after the fact; append-only removes the opportunity. The template
should demonstrate the reversing-entry pattern in `/about/money` and state that
row hashes are defence in depth, not the primary control.

**3.7.5 — Single-entry is a documented limitation, not an omission.**

The demo ledger (§4.3) records `DIRECTION` + `AMOUNT`, which is single-entry. It
yields a correct balance but cannot produce a trial balance or detect a missing
counter-posting. That is an acceptable scope for a template; it is not acceptable
to leave it unstated, because a copier will assume otherwise. Say so in the doc
page, and note what double-entry would add (paired postings summing to zero,
enforced by a `CHECK` or a transaction-level assertion).

**3.7.6 — Period close and cut-off.**

Accrual accounting needs a period concept and a lock: once a period closes, no
posting may land inside it. The template has no period model and does not need
one, but the doc page must name the rule, because retro-posting into a closed
period is the single most common money-system defect and it is invisible until
someone reconciles.

**3.7.7 — Retention.**

Money records carry statutory retention independent of any application need.
Philippine BIR (RR 17-2013) requires books of account retained ten years. SOX
requires seven. CATHERINE's audit-log infrastructure and its file-based fallback
already provide the mechanism; §6 should state the obligation so a copier sets
retention deliberately rather than inheriting a default.

**3.7.8 — Segregation of duties on money routes.**

Any route that moves money should support maker/checker: the party who initiates
a posting is not the party who approves it. `AuthMiddleware.requireAccess(predicate)`
is the mechanism, and MEAL's billing approve/reject flow is the worked example.
Document the pattern; the template ships no such route itself.

**3.7.9 — Rate sourcing. (Open question 2, resolved.)**

**Landed (verified 2026-09-03):** `Backend/src/services/FxRateService.js`
exists at 244 lines, with `test/unit/FxRateService.test.js` (197 lines)
covering it.

**Ship the table shape, the service, and a documented adapter interface. Do not
ship a provider integration.**

Manual admin entry is the template's default and only shipped path. A scheduled
pull from an external rate provider is documented in `/about/money` as an adapter
a copier implements, and nothing more.

The engineering case is a YAGNI ruling (Spec 13). A provider integration drags in
an outbound dependency and therefore a per-call timeout, a bounded retry budget
with jitter, a circuit breaker surfaced in `/health/deps`, an SSRF host
allow-list (CWE-918), API-key secret management, and provider rate-limit
handling — all to populate a table the template itself never reads. `RetryPolicy`
and `BatchGuard` are already in the tree, so a copier who needs it has the parts.

The accounting case is stronger. A rate used for reporting conversion must be
**auditable**: who set it, when, from what source, effective over what window. A
manually entered rate with an audit row satisfies that. A silent API pull does
not, unless it records the same facts — which is why the rate row carries them
either way:

| Column | Purpose |
|---|---|
| `CURRENCY_CODE` | ISO 4217, the non-base side |
| `RATE` | `NUMBER(19,8)` — a rate, never a posting (§3.7.3) |
| `EFFECTIVE_FROM` / `EFFECTIVE_TO` | The window this rate governs |
| `SOURCE` | `MANUAL` or a provider identifier |
| `RETRIEVED_AT` | When the value was obtained, distinct from when it takes effect |
| `SET_BY` | The admin or system principal responsible |

**Rate rows are append-only, exactly like ledger rows (§3.7.4).** A rate is never
`UPDATE`d; a correction closes the current window and opens a new one. This is
not stylistic — rule 4 requires that converting a historical row reproduces the
same figure forever, and an in-place rate edit silently rewrites every report
that ever used it.

**3.7.10 — Base-currency change. (Open question 3, resolved.)**

**None of the three options in the previous draft. History is not restated, and
it is not translated on read forever.**

Under IAS 21, a change in functional currency is applied **prospectively**. You
translate at the rate on the date of change, and that becomes the carrying basis
going forward. Prior periods are not rewritten — restating them would misstate
every closed period and every filed report derived from it.

So the base currency is not a single value; it is a **time-keyed epoch**, the
same shape as the rate table:

- A base-currency epoch record carries `CURRENCY_CODE` and `EFFECTIVE_FROM`.
- A money row is interpreted using the base in force at its own `CREATED_AT`.
- A change appends a new epoch. It never edits or reinterprets an existing one.
- Historical rows keep their original meaning permanently.

This preserves the §3.0 rule 1 invariant unchanged — the currency is still a
system fact, never a column on a transaction row — and it composes with rule 4,
which already resolves rates by the row's own timestamp. Same mechanism, one more
dimension.

It also improves the `bootGuard`. "Refuse any change once ledger rows exist" was
too blunt: it blocks a legitimate business event. The guard becomes:

> Refuse an **in-place** change to the current epoch's currency once rows exist
> under it. A change must be expressed as a new epoch with a future or current
> `EFFECTIVE_FROM`, never by editing `MONEY_BASE_CURRENCY` in place.

The template ships the guard and the epoch table as commented reference DDL. It
ships **no migration script**, because under prospective treatment there is
nothing to migrate — that is the point of the ruling.

**MBA note on cost.** Exact arithmetic is close to free here — `BigInt` is native,
no dependency, and the money path is not hot. There is no tradeoff to weigh. The
one decision that *does* carry cost is rule 3b's `fetchTypeHandler`: it changes
driver behaviour for every caller in the codebase, money or not. Selecting on
`scale > 0` holds the blast radius at zero on today's schema — CATHERINE declares
no scaled `NUMBER` column — so the change is inert until a copier creates a money
column, and only then does it take effect. That is precisely why it is cheap now
and expensive later: land it after a money domain exists and it becomes a
behavioural change to live code instead of a dormant guard.

---

## Phase 4 — Money capability, not a money feature

**Scope decided 2026-09-03:** the template does **not** ship a Wallet or
Transactions feature, and gains no Finance nav group. What it gains is the
*capability* — the primitives, the middleware, the streaming plumbing, and the
documentation a copier needs to build their own money domain correctly on day
one.

This matches how CATHERINE already works. Its `features/other/*` entries
(`GettingStarted`, `DatabaseConnection`, `MiraOrm`, `CORSSetup`) are
DocsPage-based reference views, not products; `demoStore.js` runs the entire app
with zero database through the *same* service and auth code paths; and the Home
security panel demonstrates real middleware against real requests. Money should
arrive the same way.

### 4.1 Shipped primitives — no routes, no nav, no schema

**Landed (verified 2026-09-03):** every file in the list below exists, with the
line counts confirmed by direct measurement:

```
Backend
  src/utils/money.js                     556 lines
  src/constants/currencies.js            121 lines
  src/utils/integrity/signedFields.js    149 lines
  src/middleware/security/IdempotencyMiddleware.js   239 lines
  src/utils/excelFormat.js               293 lines
  src/utils/sse/ScopedSsePoller.js       311 lines
  src/services/FxRateService.js          244 lines

Frontend
  src/constants/currencies.js            89 lines
  src/components/shared/money.js         125 lines
  src/hooks/useLiveStream.js             106 lines
```

None of these were checked for a mounted route or schema table as part of this
pass beyond confirming `/about/money` and `/system/metrics` are the only
money-adjacent routes registered (§4.2, §4.4) — the "no routes, no nav, no
schema" claim below was not independently re-audited file-by-file for this
verification.

Everything from Phase 3, landed as library code with no mounted surface:

```
Backend
  src/utils/money.js                     Money value type (BigInt minor units, scale 4)
  src/constants/currencies.js            ISO 4217 registry: code, scale, symbol, locale
  src/utils/integrity/signedFields.js    canonical projection, money-aware
  src/middleware/security/IdempotencyMiddleware.js
  src/utils/excelFormat.js               toExcelDate + moneyFmt(currencyCode)
  src/utils/sse/ScopedSsePoller.js       generic scope-keyed SSE registry
  src/services/FxRateService.js          rate as of a date; live-rate path

Frontend
  src/constants/currencies.js            registry mirror
  src/components/shared/money.js         formatMoney(value, code, opts)
  src/hooks/useLiveStream.js             SSE connection lifecycle
```

No `T_WALLET_DEV`. No `T_WALLET_TXN_DEV`. Nothing added to
`sql/01_schema.sql`. `T_FX_RATE_DEV` and the base-currency config row are the
only money tables the template would ever own, and even those ship as
**commented reference DDL in `sql/README.md`**, not as live schema — a copier
who never handles money should not inherit two empty tables.

`FxRateService` therefore reads from a table named by configuration
(`MONEY_FX_TABLE`) and is **inert until a copier creates it**. Under
`DEMO_MODE=true` it resolves against the in-memory rate fixture instead, exactly
as the auth and audit models already do, so the whole conversion path is
exercisable with no schema at all.

### 4.2 Reference documentation — `features/other/money/Money.view.jsx`

**Landed (verified 2026-09-03):** `Frontend/src/features/other/money/Money.view.jsx`
exists at 316 lines, and `App.jsx` mounts it at `<Route path="about/money"
element={<MoneyView />} />` — matching §4.4's navigation entry. The seven
sections listed below were not individually checked against the file's actual
content in this pass.

A DocsPage view at `/about/money`, sitting alongside `MiraOrm.view.jsx` and
`DatabaseConnection.view.jsx` and built from the same `DocShell` / `Callout` /
`CodeBlock` / `DefRow` / `WhereToGoNext` components already in
`components/shared/DocsPage/`.

Sections, each with runnable snippets:

1. **Why not `Number`** — the two failure modes worked through with real values:
   `Math.round(-0.5) === -0`, and `n * 10⁴` crossing `MAX_SAFE_INTEGER` above
   `9.0e11` at scale 4.
2. **The currency model** — base currency at rest, no currency column,
   conversion at the read boundary, storage scale 4, display scale 2 to 4.
   States the invariant a copier must not break: a non-base amount never reaches
   a money column raw.
3. **Defining a money table** — `NUMBER(19,4)`, `CHECK` constraints, binding the
   fixed-scale string through `parseUpdate`.
4. **Signing a money row** — why `buildPayload` needs canonicalised money, with
   the four-spellings example.
5. **Making a money route idempotent** — `Idempotency-Key`, where the middleware
   mounts in the chain, what a replay returns.
6. **Streaming a balance** — `ScopedSsePoller` on the server, `useLiveStream` on
   the client, and the load-bearing ordering rule (purge cache *before*
   broadcasting `update`).
7. **Exporting money** — `moneyFmt`, `toExcelDate`, and the mandatory conversion-
   basis header.

### 4.3 Proving it works — demo mode plus a live-Oracle round-trip

**Landed (verified 2026-09-03):** both layers exist. `src/models/demo/demoStore.js`
carries a money-ledger fixture (`_ledger`, `ledger()`, `ledgerInsert()`,
append-only reversal, explicitly commented as single-entry per §3.7.5, with
`AMOUNT` stored as a `Money.toStorage()` fixed-scale string). Separately,
`test/oracle-mongo-wrapper/test.js` contains a section (numbered 32, "Money —
Live Precision Round-Trip") that creates a scratch `TEST_MONEY_RT` table with
an `AMOUNT NUMBER(19,4)` column, writes boundary values, and reads them back
through a money-safe `fetchTypeHandler`, exactly as this section specifies.
Neither was executed as part of this verification pass — existence and content
were confirmed by reading the source, not by running the live-Oracle suite.

Capability with no feature still has to be *verified*, or it is a claim rather
than a capability. Two layers, because neither alone is sufficient.

**Demo-mode money ledger.** Extend `models/demo/demoStore.js` with an in-memory
ledger fixture, exactly as it already backs accounts, audit logs and changelog.
This exercises the full path — `Money` arithmetic, `signedFields` hashing,
`IdempotencyMiddleware`, `ScopedSsePoller` streaming, `formatMoney` rendering —
with zero Oracle and zero production surface. It is reachable only when
`DEMO_MODE=true`, so it adds nothing to a real deployment.

This is also what satisfies the **SSE-for-money** decision: the stream is real
and exercised end to end, it just streams a demo fixture instead of a product
table.

**Live-Oracle precision round-trip.** Demo mode structurally cannot prove the
one thing most likely to break: that a `NUMBER(19,4)` value survives the trip
through node-oracledb intact. The driver returns an Oracle `NUMBER` as a
JavaScript double, so a row signed from a fixed-scale string and verified after
a read can silently stop matching — the §3.4 canonicalisation failure, arriving
from the database side rather than the application side.

`test/oracle-mongo-wrapper/test.js` already runs against a real database. Add a
money section there: create a scratch `NUMBER(19,4)` table, write boundary
values (maximum magnitude, four-decimal fractions, negatives, zero), read them
back, and assert `Money.from(readBack).toStorage()` equals what was written, and
that the row hash still verifies. Drop the table afterwards.

### 4.4 Navigation

**Landed (verified 2026-09-03):** `nav.config.jsx` carries exactly one
money-related entry, `/about/money`, in the Reference group — matching this
section's intent precisely. No Finance group exists in the current nav
(confirmed by the full 12-href list checked under §0.2).

One entry: **Money and Currency** at `/about/money`, in the Reference group
alongside the other template documentation views. No Finance group.

## Phase 5 — Test infrastructure

### 5.1 Frontend: zero to a suite

`package.json` has no `test` script at all. Add the nine MEAL scripts (`test`,
`test:watch`, `test:coverage`, `test:unit`, `test:integration`, `test:security`,
`test:performance`, `test:reliability`, `test:chaos`) and the matching directory
layout. `vitest.config.js`, `jsdom`, `msw` and `@testing-library/*` are already
installed, and the msw handler scaffolding exists.

Cover the Phase 2 backports first, since each one encodes a bug that already bit
once:

1. `useRequest` — keyed invalidation reaches mounted consumers; a bare
   `invalidateCache()` does **not** fan out; the key-currency guard drops a
   superseded response.
2. `useSessionWarning` — expiry fires exactly once under StrictMode; the
   countdown survives a throttled tab; cross-tab `storage` sync works.
3. `CsrfMiddleware` — a hung endpoint aborts rather than stranding the gate.
4. `HttpClient` — a CSRF 403 retries, a business-rule 403 does not.
5. `httpStatus` — takeover versus inline for every mapped code.
6. Money — `formatMoney` never renders a `NaN` amount in any currency; display
   scale honours the registry, so 2-, 3- and 4-decimal currencies each render at
   their own scale; `useLiveStream` reconnects and tears down cleanly; the
   stepper outcome ledger balances.

### 5.2 Backend: 66 to parity on new surface

Phase 4 adds no production money routes, so the mandatory new-route checklist
has no new subject here — it stays the standing rule for whoever builds a money
domain on top of the template, and belongs in the `/about/money` doc page (§4.2)
rather than in this suite.

What *does* need covering is the library surface, which is where a template's
money correctness actually lives. Unit and property tests, plus the demo-mode
ledger (§4.3) as the integration harness and the live-Oracle round-trip (§4.3)
as the precision harness:

- **Property tests on `money.js`** — round-trip
  `Money.from(x).toStorage() === x` for every fixed-scale string; `add`/`sub`
  associativity and commutativity; `mul` result scale equals the sum of operand
  scales with no digits lost; `allocate` sums exactly to the whole across random
  weight vectors; `divide` refuses to run without an explicit precision, and
  `quotient × divisor + remainder === dividend` exactly.
- **Nothing rounds** — the negative case, asserted directly. A value with five
  decimal places is **rejected**, not rounded to four. `Money.from` refuses a
  JavaScript `Number`. `toStorage()` throws on a conversion product rather than
  truncating it into a `NUMBER(19,4)`. Magnitudes far above
  `Number.MAX_SAFE_INTEGER` survive a full write/read/verify cycle intact — the
  range where MEAL's `r2` silently fails.
- **Driver does not round (rules 3a / 3b)** — with the `fetchTypeHandler`
  installed, a `NUMBER(19,4)` arrives as an exact string, while a `NUMBER(3)`
  status code and an unscaled `NUMBER` id still arrive as JavaScript numbers.
  Both halves matter: the first is the money guarantee, the second is the
  regression guard proving the handler did not stringify the whole application.
  If `convertTypes` / `rowToDoc` are kept rather than deleted, add a test
  asserting they are still unreferenced on the read path.
- **Oracle precision round-trip (live DB)** — the §4.3 scratch-table test:
  boundary values written to a real `NUMBER(19,4)` column read back byte-equal
  through `Money.toStorage()`, and their row hashes still verify. The one
  assertion demo mode structurally cannot make.
- **Currency** — `FxRateService` resolves the rate as of a given date, so a
  historical figure is unchanged when a newer rate is inserted; a 3- and a
  4-decimal currency each render at their own display scale; a response cached
  for one display currency is never served for another (CWE-200 — the cache key
  carries the currency dimension).
- **Base-currency invariant** — `bootGuard` refuses a base change while ledger
  rows exist, and accepts it behind the explicit migration flag.
- **Idempotency** — a replayed key returns the stored response and does not
  double-post; the same key with a different body returns 409; concurrent
  identical requests produce exactly one write. Driven against the demo ledger.
- **Integrity** — a signed row verifies; a mutated column fails; a row signed
  from a fixed-scale string verifies identically to one signed after an Oracle
  read returned a JavaScript number. That last one is the four-copy drift that
  made legitimate rows read TAMPERED in MEAL, reproduced from the database side.
- **SSE** — `ScopedSsePoller` shares one poll across N connections on a scope;
  one scope's failure does not evict another's connections; the cache purge
  fires before the `update` broadcast, so a client that refetches on the event
  never receives the stale rows.
- **Chaos** — kill the pool mid-transaction and assert no partial write; force a
  duplicate cron leader and assert the idempotency layer absorbs the second tick.

---

## Phase 6 — Documentation and ops

- `Backend/CLAUDE.md` (+482 in MEAL) — the money column contract, `money.js`
  rules, idempotency, the integrity projection, and updated constants and cache
  tables.
- `Frontend/Claude.md` (+402) — the `httpStatus` contract, the pagination
  vocabulary, `useLiveStream`, and the money feature as the worked three-layer
  example.
- `Backend/.env.example` — 371 lines today against MEAL's 747. Add `TZ`,
  `CORS_ALLOW_BROAD_PATTERNS`, `ENABLE_CLUSTERING` and `CRON_LEADER` notes,
  `EMAIL_RETRY_*`, the SSE poll interval, the idempotency TTL, and the money
  block: `MONEY_BASE_CURRENCY`, `MONEY_STORAGE_SCALE=4`,
  `MONEY_ALLOW_BASE_CHANGE`, `MONEY_FX_TABLE`, `MONEY_LEDGER_TABLES`, and FX
  rate-source settings. All ship commented out with safe defaults — the template
  has no money domain, so none of them are required to boot.
  Also fix the stale comment on the existing `DB_TIMEZONE_OFFSET_MINUTES=480` —
  it cites `TamperDetectionService`, a MEAL service CATHERINE does not have. The
  variable itself is still load-bearing for row-hash verification and stays.
- `Frontend/.env.example` — `VITE_ALLOW_INSECURE_API`, with the guard explained.
- `audit-suppressions.md` in both repos. MEAL has them, CATHERINE has neither.
  Each entry carries CVE ID, CVSS, EPSS, KEV status, reachability analysis and a
  re-evaluation date.
- `deploy/DEPLOYMENT_RUNBOOK.md` and `deploy/DEPLOYMENT_CHECKLIST.md` — port
  MEAL's and strip the domain steps.
- Changelog entries per phase, conventional-commit style.

---

## Sequencing

```
Phase 0  ─────────────►  BLOCKING. Nothing starts until the tree is green.
   │
   ├─► Phase 2.1 FE infra ──┐
   ├─► Phase 2.2 BE infra ──┤
   │                        ├─► Phase 3 money core ──► Phase 4 capability
   └─► Phase 5.1 FE harness ┘                              │
                                                           ▼
                            Phase 5.2 money tests ──► Phase 6 docs
```

Phases 2.1 and 2.2 are independent and can run in parallel. Phase 5.1, the
frontend test harness, should land early — it is the only thing that makes the
Phase 2.1 backports verified rather than assumed.

---

## Explicitly out of scope

- MEAL's canteen domain: billing, subsidy, RFID, QR stubs, menu, kiosk,
  consumption, sales, pay periods, data purge, wallet reset requests.
- MEAL's 869 backend and 547 frontend domain files, and their test suites.
- MEAL's `package.json` dependency pins. CATHERINE is ahead on several.
- `settlementFormula.js` and `excessFundReclaim.js` themselves. Their discipline
  is generalised in Phase 3; their arithmetic is business rules.

---

## Decisions taken 2026-09-03

1. **Oracle charset — resolved by design, not by answer.** CATHERINE asserts no
   charset anywhere, and the answer is a property of whichever database a copier
   points it at, so the template cannot hardcode one. Instead: probe it at boot
   (`SELECT value FROM nls_database_parameters WHERE parameter =
   'NLS_CHARACTERSET'`), log it, and enable `textNormalize` folding automatically
   when the result is single-byte. Currency is already out of the blast radius
   by §3.0 — codes are ASCII, symbols render client-side.
2. **Currency scope — multi-currency, no currency column.** Specified in full at
   §3.0. Raw base-currency amounts at rest, conversion at fetch/view/export,
   storage scale fixed at 4, display scale 2 to 4 from the registry.
3. **Navigation IA — rewrite.** `nav.config.jsx` is rebuilt around the template's
   own routes per §0.2. No ComingSoon placeholder nav.
4. **SSE — include it, for money.** `ScopedSsePoller` and `useLiveStream` ship as
   plumbing, and the demo-mode ledger (§4.3) streams a live balance through them
   end to end. A template that claims money capability should demonstrate the
   live-update path, not leave it as an exercise. Because the stream is bound to
   the demo fixture, no production surface is added.
5. **No money feature.** The template ships capability, not a product — see
   Phase 4. This removes the Finance nav group, `T_WALLET_DEV`,
   `T_WALLET_TXN_DEV`, and the wallet feature folders from earlier drafts.
6. **No rounding.** Settled at §3.0 rule 3. This closed the previous draft's one
   blocking question by eliminating both of its options: `Number` + `roundTo`
   rounds on every operation, and even fixed-scale BigInt rounds anything beyond
   its scale. What ships is exact decimal arithmetic, over-precision input
   **rejected** rather than rounded, conversion products never persisted, and the
   two unavoidable cases (division, allocation) made explicit at the call site.
   It also promotes rule 3a from a detail to a precondition: without a driver
   fix, node-oracledb rounds the value to a double before `money.js` ever runs.
   Rule 3b settles how (`fetchTypeHandler` on `scale > 0`).

## Verification — 2026-09-03

This section records what was actually checked against the working tree on
2026-09-03, as distinct from the design intent documented in Phases 0–6 above.
Git `HEAD` is still `4985bf6` at the time of this check — **everything
described as landed in this document is uncommitted in the working tree.**
Nothing has been merged or pushed; a hard reset or a bad `git checkout .` would
discard all of it.

**Test suites.**

| Suite | Files | Tests | Result |
|---|---|---|---|
| Backend (vitest) | 76 run / 77 on disk | 1,187 | All pass, 78s runtime |
| Frontend (vitest) | 1 | 30 | All pass |

The one-file gap between the runner's count (76) and the raw `find` count (77)
is **resolved and expected**: `test/encryption/cryptosuite.test.js` is named
explicitly in `vitest.config.js`'s `exclude` list, alongside
`test/oracle-mongo-wrapper/**`. It exists on disk and is deliberately not run by
the default suite. No file is silently failing to be collected.

The backend total rose from 1,180 to 1,187 during this verification pass: seven
tests were added covering the `Money.allocate` weight-validation fix recorded
below.

**Lint.** `npm run lint` on the frontend: **0 errors, 2 warnings**, both
`react-hooks/exhaustive-deps` — `AdminManagement.view.jsx:284` and
`useDocumentTitle.js:44`. Neither is new; both predate this backport and are
out of scope for it. The three lint errors this document previously tracked as
outstanding (`paramsSnippet` in `AuditLogTable`, two unused setters in
`DeleteLoggingTab`) are fixed (§0.4).

**Styles.** `Frontend/src/assets/styles/index.css` is byte-identical to
MEAL's copy: 2,380 lines, all 74 `--err-*` custom properties present (§0.1).

**Navigation.** `nav.config.jsx` declares 12 unique `href` values (down from
MEAL's 22). Every one resolves to a route mounted in `App.jsx` — zero dead
links, confirmed by direct cross-reference rather than by running the app.
`/system/metrics` and `/about/money` are both routed.

**Oracle driver / rounding rule (§3.0 rules 3a–3b).** The `fetchTypeHandler`
ruling is implemented in `Backend/src/config/adapters/oracle.js` as
`moneySafeFetchTypeHandler`, selecting on `metaData.dbType ===
oracledb.DB_TYPE_NUMBER && metaData.scale > 0` — matching this plan's §3.0
rule 3b exactly, including the scale-derived-from-schema reasoning. `Backend/sql/01_schema.sql`
contains no scaled `NUMBER` columns, so the change remains inert on the
template today, as rule 3b anticipated. `convertTypes` / `rowToDoc` were
**kept rather than deleted**, fenced with a warning header, and guarded by
`test/unit/convertTypesFence.test.js` (53 lines) — the "delete or fence"
option this plan left open at §3.0 rule 3a was resolved in favour of fencing.

**Defects found and fixed during verification.**

1. **`Money.allocate` truncated fractional weights to zero.**
   `Backend/src/utils/money.js` coerced each weight with
   `BigInt(Math.trunc(Number(x)))`, so any weight below 1 became `0`. A ratio
   written the most natural way — `allocate([0.5, 0.25, 0.25])`, a percentage
   split — collapsed to `[0, 0, 0]` and surfaced as
   `"weights sum to zero — nothing to allocate against"`. The caller's actual
   mistake never appeared in the message.

   It failed **closed**, so no money was ever mis-allocated. Fixed by refusing a
   fractional weight outright rather than truncating it, with a message naming
   the offending index and the whole-unit form (`50 / 25 / 25`). This is the
   same reject-don't-round rule `Money.from` already applies to a JavaScript
   number and `toStorage` applies to a fifth decimal place (§3.0 rules 2–3).
   Seven regression tests added to `test/unit/money.test.js`, covering
   fractional, `NaN`, `Infinity`, string, `null`, negative, `BigInt`, and
   all-zero weight vectors. The coverage gap that let it through: every prior
   `allocate` test used integer weights (`[1,1,1]`, `[2,1]`).

2. **The HTTP-status scanner mis-parsed any `AppError` message containing a
   comma.** `splitTopLevelArgs` in
   `test/unit/constants/httpStatusCatalog.test.js` tracked bracket depth but not
   quote state, so a comma inside a string or template literal was treated as an
   argument separator. Argument 2 then resolved to the message tail instead of
   the status code, and the call site was misreported as runtime-dynamic —
   breaking the repo-wide `SCAN.dynamic.length <= 1` invariant.

   Latent since the file was written; it surfaced only because the `allocate`
   fix above introduced the first `AppError` message in the codebase with a
   comma in it. Fixed by making the splitter quote-aware (single, double, and
   template literals, with backslash escapes and `${…}` nesting). **The
   invariant itself is unchanged and no assertion was relaxed** — only the
   parser feeding it was corrected. Verified against four cases including
   quotes nested inside a template expression.

**Artifact inventory.** Every path this verification pass was asked to check
exists:

| Path | Lines |
|---|---|
| `Backend/src/utils/money.js` | 556 |
| `Backend/src/constants/currencies.js` | 121 |
| `Backend/src/utils/integrity/signedFields.js` | 149 |
| `Backend/src/middleware/security/IdempotencyMiddleware.js` | 239 |
| `Backend/src/services/FxRateService.js` | 244 |
| `Backend/src/utils/excelFormat.js` | 293 |
| `Backend/src/utils/sse/ScopedSsePoller.js` | 311 |
| `Backend/src/utils/uploadOutcome.js` | 436 |
| `Backend/src/utils/textNormalize.js` | 202 |
| `Frontend/src/constants/currencies.js` | 89 |
| `Frontend/src/constants/httpStatus.js` | 329 |
| `Frontend/src/hooks/useLiveStream.js` | 106 |
| `Frontend/src/hooks/useExportAccess.js` | 52 |
| `Frontend/src/utils/pagination.js` | 105 |
| `Frontend/src/contexts/theme/useTheme.js` | 26 |
| `Frontend/src/features/other/money/Money.view.jsx` | 316 |
| `Frontend/eslint-rules/jsx-uses-vars.js` | 158 |
| `Backend/audit-suppressions.md` | 54 |
| `Frontend/audit-suppressions.md` | 65 |
| `Frontend/src/components/shared/money.js` (not on the original check list; found while cross-referencing §4.1) | 125 |

New backend unit test files, all untracked (`??`) in `git status --short
test/` except `test/oracle-mongo-wrapper/test.js`, which is a modification
(`M`) to a pre-existing file:

- `test/unit/money.test.js` (330 lines)
- `test/unit/FxRateService.test.js` (197 lines)
- `test/unit/IdempotencyMiddleware.test.js` (191 lines)
- `test/unit/ScopedSsePoller.test.js` (204 lines)
- `test/unit/signedFields.test.js` (98 lines)
- `test/unit/moneyFetchTypeHandler.test.js` (81 lines)
- `test/unit/bootGuardMoney.test.js` (116 lines)
- `test/unit/constants/currencies.test.js` (59 lines)
- `test/unit/constants/httpStatusCatalog.test.js`
- `test/unit/convertTypesFence.test.js` (53 lines)
- `test/server/unit/utils/clusterRole.test.js`
- `test/oracle-mongo-wrapper/test.js` (modified — adds the §4.3 live-Oracle
  money round-trip section)

**MEAL vocabulary remaining.** `grep -rliE 'meal|subsidy|rfid|kiosk'
Frontend/src --include=*.jsx --include=*.js` now returns **24** files (down
from the 31 the plan originally tracked at §0.3), a different set than
before. Not yet triaged generalise/delete/defer — see §0.3.

**Working tree.** `git status --short` reports **190** changed/added/untracked
paths in total across the repo — substantially more than the 79-file figure
Phase 0 originally quoted for "the uncommitted paste," reflecting that Phase
2–4 work has since layered on top of the Phase 0 diff, all still uncommitted
at `4985bf6`.

**What this pass did not verify.** Section 3.6 (transaction discipline as a
documented `CLAUDE.md` rule), the specific CHECK constraints in §3.2, the
seven-section content of `Money.view.jsx` beyond its existence and route, the
`salesShared` / `downloadRequest` / `ConsumptionStreamProvider.jsx` disposition
from §0.3, and whether `npm run build` succeeds, were all out of scope for
this re-measurement and are reported here as unverified rather than assumed
passing.

---

## Open questions

**None outstanding.** All three were resolved 2026-09-03:

| Was | Resolved at | Ruling |
|---|---|---|
| `convertTypes` opt-out shape | §3.0 rule 3b | `fetchTypeHandler` on `scale > 0` in `oracle.js`; delete the dead ORM exports |
| Rate sourcing | §3.7.9 | Manual entry shipped; provider is a documented adapter, not code |
| Base-currency change | §3.7.10 | Prospective epochs per IAS 21; no restatement, no migration script |

Two items carry a verification step into Phase 3 rather than a decision:

1. Confirm the `fetchTypeHandler` signature against the installed node-oracledb
   once `node_modules` is present (§3.0 rule 3b). The API is 6.0+; `package.json`
   pins `^6.10.0`.
2. Grep for arithmetic on scaled `NUMBER` columns before landing rule 3b.
   CATHERINE's current `sql/01_schema.sql` has none, so the change should be
   inert on the template — verify that holds.
