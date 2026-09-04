# CATHERINE Template Hardening — Plan

**Created:** 2026-09-04. **Owner:** orchestrator. **Status:** in progress.

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
| `Drawer.jsx:80` | looks up `#app-scroll`; real id is `#app-main-scroll`. Lookup always returns null — dead scroll-lock |
| `PASSWORD_HASH_MODE=tripledes` | reversible encryption, not hashing, and **not** blocked in production the way `plain` is |
| DocShell rail offset | fixed for top mode; `railTop` override still available per page |
| Fleet profile | cites `plans/meal-parity-and-money.md` — file does not exist |
