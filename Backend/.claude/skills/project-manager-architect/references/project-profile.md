# Project Profile

**This is the swappable layer.** Everything else in the fleet is portable discipline; this file is the only place that knows which project the fleet is pointed at.

To move the fleet to a different project, replace this file. Do not edit the skills.

---

## 1. Authority order — read this before trusting any fact

When a fact about this codebase matters, trust sources in this order:

1. **The code**, read now.
2. **The project's `CLAUDE.md`**, which is close to the code and updated with it.
3. **This profile**, which is a navigation map, not a specification.
4. **The skill file**, which carries discipline and should not be asserting project facts at all.

Lower sources are hints for *where to look*. They are never evidence for a defect report.

**This is not theoretical.** Two verified examples in this repo:

- The success envelope is documented in `MEAL-BE/CLAUDE.md` as four keys. `constants/responses/index.js:72` actually emits five — `requestId` is always present. The 157KB authority is stale on this point; the code is not.
- `server.js` sits at the **package root** (`MEAL-BE/server.js`), not at `src/server.js`. An agent grepping the intuitive path finds nothing and may report a missing boot invariant that is present.

An agent that reports a defect on the strength of this file, without opening the code, is producing a false positive.

---

## 2. Identity

| | |
| - | - |
| **Project** | Aumovio MEAL — canteen meal, wallet, and settlement platform |
| **Repo root** | `d:\LocalWeb\Meal` |
| **Surfaces** | `MEAL-BE` (backend API), `MEAL-FE` (web client) |
| **Fleet config** | `.claude/` at the repo root |

---

## 3. Surfaces and stacks

### `MEAL-BE` — backend

| | |
| - | - |
| Stack | Node.js, Express **v5.2**, class-based OOP |
| Database | OracleDB via the in-house `oracle-mongo-wrapper` (Mongo-style API over Oracle SQL) |
| Entry point | `MEAL-BE/server.js` — **package root, not `src/`** |
| App assembly | `MEAL-BE/src/app.js` — the middleware chain lives here |
| Authority doc | `MEAL-BE/CLAUDE.md` (~157KB, comprehensive) |
| Source layout | `src/{app.js, config, constants, controllers, middleware, models, routes, services, utils}` |
| Tests | Vitest + Supertest, under `test/server/{unit,integration,security,performance,reliability,chaos}` |
| Test command | `npm test` (`vitest run`); per-category scripts exist — `test:unit`, `test:integration`, `test:security`, `test:performance`, `test:reliability`, `test:chaos`, `test:coverage` |

### `MEAL-FE` — frontend

| | |
| - | - |
| Stack | React **19.2**, Tailwind CSS **v4.2**, Vite **8**, Aumovio Design System v3.1 |
| Entry point | `MEAL-FE/src/main.jsx` |
| Authority doc | `MEAL-FE/CLAUDE.md` (~105KB, comprehensive) |
| Source layout | `src/{App.jsx, main.jsx, components, config, constants, contexts, features, hooks, middleware, utils, views, assets}` |
| Tests | Vitest + Testing Library, category scripts mirror the backend |
| Test command | `npm test` (`vitest run`) |

### Not present in this project

No C#/.NET, no MongoDB deployment (the wrapper is Oracle), no Kubernetes manifests, no Python/Go/Rust, no ML/DL/LLM pipeline. Agents for those stacks are **inapplicable here** — see §6.

---

## 4. Where the facts live

Skills must not restate these. Read them from the authority when they matter.

| Fact | Authority |
| ---- | --------- |
| Middleware chain and ordering rationale | `MEAL-BE/src/app.js` (the code), then `MEAL-BE/CLAUDE.md` § *Middleware Stack* |
| Response envelope | `MEAL-BE/src/constants/responses/index.js` — **the code, not the doc** |
| Error shape and handling | `MEAL-BE/src/constants/errors/`, `ErrorHandlerMiddleware` |
| Log message templates | `MEAL-BE/src/constants/messages/<namespace>.messages.js` |
| Auth model and permissions | `MEAL-BE/CLAUDE.md` § *Authentication & Authorization* |
| Cache keys, stores, registration | `CacheKeyBuilder`, `CacheMiddleware`, `registry.registerAll` in `app.js` |
| Oracle adapter and pooling | `MEAL-BE/src/config/adapters/oracle.js`, `MEAL-BE/CLAUDE.md` § *OracleDB Wrapper Library* |
| Schema and migrations | `MEAL-BE/sql/schema_v6/`, `MEAL-BE/sql/migrations/` |
| New-route test checklist, coverage targets | `MEAL-BE/CLAUDE.md` § *What to Test on Every New Route*, § *Test Coverage Standards* |
| Design tokens, component map, animation system | `MEAL-FE/CLAUDE.md` §§ 1, 2, 12 |
| Feature architecture and folder structure | `MEAL-FE/CLAUDE.md` §§ 3, 9, 10 |
| Environment variables | `MEAL-BE/CLAUDE.md` § *Environment Variables*, `.env.example` |

---

## 5. Navigation shortcuts

Facts agents need to *find* things. Verify before reporting on any of them.

- Backend boot order: `server.js` requires `./src/utils/encodingPolyfill` first, then sizes the libuv thread pool, before any async I/O.
- Middleware chain is numbered in comments in `src/app.js` — read the numbers from the file rather than assuming a count.
- Cache stores are registered centrally in `app.js` and resolved by route modules at **module load**, so `registerAll` must execute before `require("./routes")`.
- Backend tests live under `test/server/`, not `test/`.

---

## 6. Fleet applicability

| Applies here | Agents |
| ------------ | ------ |
| **Yes** | React, Node.js, Oracle (+ their planners), React QA, Node.js QA, test, code-reviewer, cybersecurity, performance, anti-pattern, accountant, docs, chaos, UI/UX, PM |
| **Not currently** | Next.js, C#, MongoDB, Docker/Kubernetes, data-analytics, ML, DL, LLM, AI, Python, Go, Rust (+ their planners and QA) |

"Not currently" means **no target exists in this repo**, not that the agent is broken. If one of those stacks is introduced, move it up and fill in the surface in §3. Do not dispatch an inapplicable agent to "check anyway" — it has nothing to read and will invent findings.

---

## 7. Porting the fleet to a new project

1. Copy `.claude/` into the new repo.
2. Replace this file using `project-profile.template.md` in the same directory.
3. Fill §§ 2-6 from the new project. Where a `CLAUDE.md` exists, point at it rather than copying it.
4. Update §6 so the orchestrator does not dispatch agents with no target.
5. Leave every skill untouched. If you find yourself editing a skill to fit the project, the fact belongs in this file instead — tell the maintainer, because that is a design defect in the skill.

Portable with no changes: the AI group (ML, DL, LLM, AI), the language agents (Python, Go, Rust), performance, chaos, accountant, docker-kubernetes, and every shared reference.
