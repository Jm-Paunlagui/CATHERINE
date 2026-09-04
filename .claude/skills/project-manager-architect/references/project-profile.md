# Project Profile — CATHERINE

**This is the swappable layer.** Everything else in the fleet is portable discipline; this file is the only place that knows which project the fleet is pointed at.

To move the fleet to a different project, replace this file. Do not edit the skills.

---

## 1. Authority order — read this before trusting any fact

When a fact about this codebase matters, trust sources in this order:

1. **The code**, read now.
2. **The surface's `CLAUDE.md`**, which is close to the code and updated with it.
3. **This profile**, which is a navigation map, not a specification.
4. **The skill file**, which carries discipline and should not be asserting project facts at all.

Lower sources are hints for *where to look*. They are never evidence for a defect report.

**This is not theoretical — both verified in this repo:**

- `Backend/src/constants/responses/index.js` emits **five** keys on success: `status, code, message, requestId, data`. `Backend/CLAUDE.md` documents four; it omits `requestId`. `sendError` adds `title` on top of that. The code is right and the doc is stale. Anything typed, asserted, or reviewed against the four-key shape is wrong.
- `Backend/server.js` sits at the **surface root**, not `Backend/src/server.js`. Grepping the intuitive path finds nothing and reads as a missing boot invariant that is actually present.

An agent that reports a defect on the strength of this file, without opening the code, is producing a false positive.

---

## 2. Identity

| | |
| - | - |
| **Project** | CATHERINE — Express + Oracle backend with a React web client, built from the same platform template as MEAL |
| **Repo root** | `D:\LocalWeb\CATHERINE` |
| **Surfaces** | `Backend`, `Frontend` — two surfaces, one fleet copy at the repo root |
| **Version** | `1.0.0-dev.45`, kept in lockstep across both surfaces |
| **VCS** | Git. Branch at profiling time: `feat/meal-parity-money-capability` |
| **Fleet config** | `.claude/` at the repo root, covering both surfaces |

**Relationship to MEAL.** CATHERINE is built from the same template and is being brought to parity with it — see `plans/meal-parity-and-money.md` (Phases 2-4 substantially landed as of 2026-09-03). The conventions are near-identical, which makes assuming parity tempting and dangerous: **verify against CATHERINE's own files**, never against remembered MEAL facts. The two repos have already diverged in test-tree coverage and in frontend tooling.

---

## 3. Surfaces and stacks

### `Backend`

| | |
| - | - |
| Stack | Node.js, Express **v5.2**, CommonJS, class-based OOP |
| Database | OracleDB **6.10** through the in-house `oracle-mongo-wrapper` — confirmed at `Backend/src/config/adapters/oracle.js` and used across `Backend/src/models/` |
| Entry point | `Backend/server.js` — **surface root, not `src/`** |
| App assembly | `Backend/src/app.js` — the middleware chain, numbered in comments |
| Authority doc | `Backend/CLAUDE.md` |
| Source layout | `src/{app.js, config, constants, controllers, middleware, models, routes, services, utils}` |
| Tests | Vitest + Supertest under `Backend/test/{server, unit, encryption, oracle-mongo-wrapper}`. Main server suites sit under `test/server/{unit,integration,security,performance}` — check which tree a suite belongs in before adding to it. |
| Test command | `npm test` (`vitest run`); category scripts `test:unit`, `test:integration`, `test:security`, `test:performance`, `test:coverage` |
| Build | PKG via `@yao-pkg/pkg` into `dist`, target `node18-win-x64`, then `scripts/postbuild-copy-natives.js`. Native Oracle binaries are copied post-build; a compiled artefact that cannot find them is a build-step failure, not a code defect. |
| Validation | `express-validator` is a direct dependency here |
| Security | `helmet`, `csrf-csrf`, `argon2`, `jsonwebtoken`. Suppressions live in `Backend/audit-suppressions.md`. |

### `Frontend`

| | |
| - | - |
| Stack | React **19.2**, Vite **8** (Rolldown), Tailwind CSS **v4.2**, ESM |
| Routing | `react-router` / `react-router-dom` **v7** — client-side routing, **not** a server framework |
| Authority doc | `Frontend/Claude.md` — **note the casing**. Mixed case here, unlike the backend's `CLAUDE.md`. On a case-sensitive filesystem `Frontend/CLAUDE.md` does not exist. |
| Entry point | `Frontend/src/main.jsx`, mounting `src/App.jsx` |
| Source layout | `src/{App.jsx, main.jsx, assets, components, config, constants, contexts, features, hooks, middleware, utils, views}` |
| Feature architecture | Three layers per feature: `<feature>.api.js`, `<feature>.hook.js`, `<Feature>.view.jsx` — confirmed in `src/features/auth` |
| Features | `src/features/{auth, dashboard, home, management, other, personalize, support}` |
| Component tiers | `src/components/{ui, shared, charts, feedback, forms, layout, routing}` |
| Charts | ApexCharts through `react-apexcharts` |
| Tests | Vitest + Testing Library under `Frontend/test/` — **only `unit/` and `helpers/` exist**. See section 5. |
| Test command | `npm test` (`vitest run`) |
| Security | `jose`, `js-cookie`. Suppressions live in `Frontend/audit-suppressions.md`. |

**React Compiler is enabled.** `Frontend/vite.config.js:195` applies `reactCompilerPreset()` through `@rolldown/plugin-babel`. Memoisation is largely automatic — do **not** reflexively add `useMemo` or `useCallback`, and do not report their absence as a performance defect. Reach for manual memoisation only with a profile showing it is needed. This is a real divergence from ordinary React advice and from MEAL.

### Not present in this repo

No Next.js or App Router, no C#/.NET, no MongoDB deployment (the wrapper is Oracle), no Kubernetes manifests, no Python, Go, or Rust, no ML/DL/LLM pipeline.

---

## 4. Where the facts live

Skills must not restate these. Read them from the authority when they matter.

| Fact | Authority |
| ---- | --------- |
| Middleware chain and ordering rationale | `Backend/src/app.js` — numbered comments, the code |
| Response envelope | `Backend/src/constants/responses/index.js` — **the code, not the doc** |
| Error shape and handling | `Backend/src/constants/errors/`, the error-handler middleware |
| Log message templates | `Backend/src/constants/messages/` |
| Backend conventions overall | `Backend/CLAUDE.md`; summarised in `memory/catherine-backend-conventions.md` |
| Oracle adapter, pooling, Thick mode | `Backend/src/config/adapters/oracle.js` |
| Schema and migrations | `Backend/sql/` |
| Frontend conventions, design tokens, component tiers | `Frontend/Claude.md`; summarised in `memory/catherine-frontend-conventions.md` |
| Stack versions across both surfaces | `memory/catherine-stack-versions.md` |
| Monorepo layout | `memory/catherine-template-overview.md` |
| Dependency suppressions | `Backend/audit-suppressions.md`, `Frontend/audit-suppressions.md` |
| Parity and money roadmap | `plans/meal-parity-and-money.md` |

The `memory/` directory has its own index at `memory/MEMORY.md`. Those files are **summaries of the two CLAUDE.md files**, so they sit *below* them in authority — useful for orientation, never for adjudicating a defect.

---

## 5. Navigation shortcuts

Facts agents need in order to *find* things. Verify before reporting on any of them.

- Backend boot order: `server.js` requires `./src/utils/encodingPolyfill` first, then sizes the libuv thread pool, before any async I/O.
- The middleware chain in `Backend/src/app.js` is numbered in comments — 13 numbered steps plus `3a`, `4a`, `5a` at profiling time. **Read the numbers from the file**; do not assume a count.
- **Frontend test scripts point at directories that do not exist.** `Frontend/package.json` defines `test:integration`, `test:security`, `test:performance`, `test:reliability`, and `test:chaos`, but `Frontend/test/` contains only `unit/` and `helpers/`. Five of the six category scripts match no files. Treat this as a known coverage gap, not a broken script — and when adding a category, create the directory the existing script already expects rather than inventing a new path.
- The root `ReadMe.md` is not a technical authority. The two CLAUDE.md files are.

---

## 6. Fleet applicability

| Applies here | Agents |
| ------------ | ------ |
| **Yes** | `senior-nodejs-engineer` (+ planner), `senior-oracle-engineer` (+ planner), `senior-nodejs-qa-engineer`, `senior-react-engineer` (+ planner), `senior-react-qa-engineer`, `senior-uiux-designer`, `senior-test-engineer`, `code-reviewer-cwe-cve`, `senior-cybersecurity-engineer`, `senior-performance-engineer`, `senior-anti-pattern-auditor`, `senior-code-documentation-engineer`, `senior-chaos-resilience-engineer`, `project-manager-architect` |
| **Conditionally** | `senior-accountant-mba` — there is **no money code in `Backend/src/services/` yet**. The money capability is inbound work under `plans/meal-parity-and-money.md`. Route it for design review, and for billing, wallet, or settlement code as it lands. Do not dispatch it to audit money logic that does not exist. |
| **Not here** | Next.js and its QA agent, C# and its QA agent, MongoDB, Docker/Kubernetes, data-analytics, ML, DL, LLM, AI, Python, Go, Rust (+ their planners) |

"Not here" means **no target exists in this repo**, not that the agent is broken. Do not dispatch an inapplicable agent to "check anyway" — it has nothing to read and will invent findings.

**Watch the Next.js agents.** They keyword-match on React, server rendering, and routing. This frontend is Vite + React Router 7 with no App Router. Route React work to `senior-react-engineer`.

---

## 7. Porting the fleet to a new project

1. Copy `.claude/` into the new repo.
2. Replace this file using `project-profile.template.md` in the same directory.
3. Fill sections 2-6 from the new project. Where a `CLAUDE.md` exists, point at it rather than copying it.
4. Update section 6 so the orchestrator does not dispatch agents with no target.
5. Leave every skill untouched. If you find yourself editing a skill to fit the project, the fact belongs in this file instead — that is a design defect in the skill.

Portable with no changes: the AI group (ML, DL, LLM, AI), the language agents (Python, Go, Rust), performance, chaos, accountant, docker-kubernetes, and every shared reference.
