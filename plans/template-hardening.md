# CATHERINE Template Hardening — Plan

**Created:** 2026-09-04. **Owner:** orchestrator. **Status:** in progress — see §0 for the 2026-10-28 state after the eMeal re-sync.

---

## 0. Status 2026-10-28 (after the re-sync from the source app)

Sections 2-3 below are the 2026-09-04 snapshot and are kept for history. This section supersedes them.

### Done

| Item | Evidence / note |
| --- | --- |
| `npm install` + build, both surfaces | reported by the user; not re-run in the docs session (no terminal) |
| Backend suite | **77 files / 1254 tests** green (user baseline). 78 test files exist on disk; the extra is most likely the cryptosuite file, which vitest excludes |
| Frontend suite | **32 files / 555 tests** green (user baseline); `integration/`, `security/`, `performance/`, `chaos/`, `reliability/` dirs exist |
| Lint | clean on both surfaces (user baseline). Backend fixes: duplicate `AUTH_TRACE` key, useless catch in `nanoidLoader`, test lint |
| SQL schema gap | `01_schema.sql` creates all 9 `T_*_DEV` tables; `03_*` and `04_platform_tables.sql` are the additive upgrade path |
| AdminModel gap | `admin.model.js` matches the schema (EMAIL, `CAN_RECEIVE_SRV_*`, last-super-admin guard) |
| Env + deploy cleanup | `Backend/.env` rebuilt from `.env.example`. The old copy is at `Backend/.env.emeal.bak` (ignored by `.env.*`) — **delete it once the new `.env` is verified** |
| Branding | email CIDs → `app-logo-*`; "Employee ID" → username; `emeal-mark.png` and `changelog-dump-2.x` deleted |
| Roles | `SUPER_ADMIN` / `ADMIN` / `USER` everywhere (backend `VALID_ROLES`, frontend hook, `App.jsx` `ROLES`) |
| DocShell rail | `RAIL_TOP` = `lg:top-6` (`DocShell.jsx:56`) |
| Vocabulary sweep (code) | done by the re-import |
| Help Center (Phase 3) | ported: `HelpAssistant` mounted globally, `features/support/help`, route `about/help` |
| Docs 13 of 13 | all 13 `docs/features/*.md` exist |
| `Drawer.jsx` scroll-lock | now looks up `#app-main-scroll` (`Drawer.jsx:81`) — open item closed |
| Docs sweep (2026-10-28) | `Backend/CLAUDE.md`, `Frontend/Claude.md`, root `ReadMe.md`, `GETTING_STARTED.md`, both surface READMEs, `Backend/sql/README.md`, `Backend/dev-docs/README.md`, `docs/features/admin-management-and-rbac.md` (route table, temp passwords, guards), path and wording fixes in 5 other feature docs, root `.claude` skills/agents/profile |

### Remaining

| Item | Owner |
| --- | --- |
| Rewrite the 13 `Backend/dev-docs/` pages (System Admin ×5, Support ×5, Others ×3). They are served by the docs viewer and still use source-app wording | docs |
| `Backend/.claude/` and `Frontend/.claude/` mirror copies still use MEAL wording; their `project-profile.md` copies are still the MEAL profile. Re-sync from root `.claude/` (`/fleet-init`) | docs / orchestrator |
| `PASSWORD_HASH_MODE=tripledes` is still allowed in production (only `plain` is blocked, `CryptoVault.js:284`) | security |
| `Frontend/Claude.md` casing (on disk `CLAUDE.md` vs tracked `Claude.md`) | orchestrator |
| `Backend/package.json` says `ISC`; `LICENSE` files are Apache-2.0 | orchestrator |
| Source comments still name the source app (see `plans/template-reimport-handover.md` §6) | backend |
| Frontend build prints an `advancedChunks` deprecation warning | React |
| `Frontend/.env.example` ships `VITE_API_BASE_URL` on `:3000`; backend default is `2108` | React (documented in READMEs as a manual step) |
| No feature mounts `ExcelUploadStepper`; no frontend devdocs format/mermaid tests | decide: keep as shared capability or drop from docs |

Goal: make the template safe to copy — documented, tested, drift-free — then add the
Help Center. Work survives session limits; this file is the tracker.

---

## 1. Pacing rule (learned the hard way)

Three session-limit hits in one session. Cause: **Opus ran executor-shaped work.**

Docs 1-2 established the house format. Docs 3-13 are execution against a fixed
format — no architectural decision left. Same for porting zero-domain-coupling
tests. That is Sonnet work by the fleet's own two-model rule: expensive reasoning
once, cheap execution after.

| Rule | Why |
| --- | --- |
| Max **2** agents in flight | 3 parallel Opus agents hit the limit mid-write |
| Docs 3-13 → **Sonnet** | Format is fixed; no decision to make |
| Zero-domain test ports → **Sonnet** | Mechanical adaptation |
| Help Center port → **Opus planner**, then Sonnet | Real architectural decision |
| Batch = **2-3 files**, never more | Partial writes survive; big batches lose more |

Agents write files before they die. A killed agent is not lost work — check disk
before re-dispatching, and re-dispatch only the gap.

---

## 2. Status

### Done and verified

| Item | Evidence |
| --- | --- |
| HTTP status alignment MEAL↔CATHERINE | code-only diff identical, 105 lines each |
| Test harness helpers | `renderWithProviders`, `contract.js`, msw api + auth/changelog handlers |
| Error/HTTP contract tests | mutation-tested: mutate a title → suite fails; revert → passes |
| `Backend/CLAUDE.md` drift | envelope 5-key, real middleware chain incl. CSRF step 9, real auth routes, `zod` absent |
| `Frontend/Claude.md` drift | roles are STRINGS not numbers |
| `ProtectedRoute` docblock | same role fix |
| Suite | **11 files / 383 tests**, green; eslint clean |

### Docs — 5 of 13

Done: `authentication`, `error-handling`, `oracle-mongo-wrapper`,
`logging-and-audit`, `metrics-and-observability`.

### Tests — categories

Done: `unit/` (money, httpStatus, apiErrorMapping, clientErrorResponses,
httpClientStatusHandling, 5 components), `reliability/error-boundary`.

---

## 3. Remaining work

### Phase 2a — close the gaps (Sonnet, 2 agents)

| Unit | Files | Notes |
| --- | --- | --- |
| Docs gap | `money.md`, `caching.md`, `changelog-and-releases.md` | prompts already written; reuse verbatim |
| Test gap | `reliability/csrf-retry.test.jsx`, `reliability/session-expiry.test.jsx` | port from MEAL; session-expiry covers 440/498 takeover |

### Phase 2b — remaining docs (Sonnet, batches of 2-3)

| Doc | Subject |
| --- | --- |
| 9 | Admin management + RBAC provisioning |
| 10 | Personalize (palettes, theme, contrast tokens) |
| 11 | Dashboard + Home landing |
| 12 | Middleware chain & request lifecycle |
| 13 | Boot, config, env guards, PKG build |

### Phase 2c — remaining test categories (Sonnet, one category per batch)

`integration/`, `security/`, `performance/`, `chaos/` — all four scripted in
`Frontend/package.json` but the directories do not exist. Create the directory the
existing script already expects; do not invent a new path.

Backend suite is already healthy (76 files / 1187 tests) — no backend test work
planned.

### Phase 3 — Help Center port (Opus planner → Sonnet executor)

Port `HelpAssistant` + Help Center **shell** from MEAL-FE. ~2,500 lines / 11 files.

**Content does not come across.** MEAL's `help.data.jsx` is 5,543 lines with 708
domain-word hits. Seed CATHERINE's corpus from the existing `/about/*` reference
pages instead.

MEAL's help tests port too, minus `helpExcessFundAccuracy` (domain).

Planner-first because: spans 11 files, adds a route and a global shell element, and
the article-data shape is a contract both the search and the launcher depend on.

---

## 4. Standing constraints

- Authority order: **code** > surface `CLAUDE.md` > fleet profile > skill file.
- Verify before asserting. A killed agent's claim is not evidence; run the suite.
- Never point a test at a real backend — MSW with `onUnhandledRequest: "error"`.
- No MEAL domain vocabulary in template files: billing, QR, roster, subsidy,
  canteen, kiosk, sales, emeal, consumption, RFID, payperiod, reclaim.
- Agents do not modify `src/` when writing tests, and do not modify anything when
  writing docs. Report bugs; fix none.

---

## 5. Open items not yet scheduled

| Item | Decision needed |
| --- | --- |
| `Frontend/Claude.md` casing | tracked as `Claude.md`, on disk `CLAUDE.md`. Harmless on Windows (`core.ignorecase=true`); breaks on Linux CI. Rename to match backend? |
| ~~`Drawer.jsx:80`~~ | **Closed 2026-10-28** — now looks up `#app-main-scroll` (`Drawer.jsx:81`) |
| `PASSWORD_HASH_MODE=tripledes` | reversible encryption, not hashing, and **not** blocked in production the way `plain` is |
| DocShell rail offset | fixed: `RAIL_TOP` = `lg:top-6`; `railTop` override still available per page |
| ~~Fleet profile cites a missing plan~~ | **Corrected 2026-10-28** — `plans/meal-parity-and-money.md` does exist. It is a source-app plan; the root profile parity row now points at the template plans instead |
