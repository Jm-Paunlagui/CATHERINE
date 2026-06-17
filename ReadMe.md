<div align="center">

# CATHERINE

### A production-grade full-stack template — secure by default, fast under load, and beautiful out of the box.

**React 19 + Tailwind v4 (Aumovio Design System v3.1)** on the front · **Node.js + Express v5 + OracleDB** on the back
Powered by **Mira** — a MongoDB-style query wrapper that compiles to safe, bind-variable Oracle SQL.

</div>

---

## Why CATHERINE

Most templates give you a folder layout and a "hello world" route. CATHERINE ships the hard parts already solved: a 14-layer security middleware chain, cache-stampede protection, a dual-pool Oracle layer with health monitoring, in-process RED metrics, progressive login lockout, a 50+ component design system, and a personalization engine with 40 curated themes plus unlimited custom colours. Every layer is class-based, documented, and tested across six suites.

| Pillar | What you get |
| --- | --- |
| 🔒 **Secure** | 14-stage middleware chain · CSRF · CSP · Helmet · CIDR IP filter · scanner/traversal blocking · progressive login lockout · 100% bind-variable SQL |
| ⚡ **Fast** | Single-flight stampede protection · cache-aside layer · gzip · keyset pagination · per-route p50/p95/p99 metrics · response-time budgets |
| 🧱 **Architected** | Class-based OOP backend · three-layer frontend features · zero raw `oracledb`/`axios` leakage · constants firewall |
| 🗃️ **Mira** | Write MongoDB JS, get Oracle SQL — filters, aggregation, window functions, CTEs, joins, transactions, upserts, all injection-safe |
| 🎨 **Designed** | Aumovio Design System v3.1 · 50+ components · full animation system · WCAG-checked dark mode parity |
| 🎛️ **Personal** | 40 accent palettes + custom-hex generator · light/dark/transparency · layout modes · contrast-safe per-palette tokens |
| 🩺 **Observable** | Request tracing (`X-Request-Id`) · audit log · RED + system + Oracle metrics · changelog/release surface |
| 📦 **Portable** | Compiles to a single standalone Windows `.exe` via `pkg` |

---

## 🔒 Security — defense in depth, not a checkbox

Security is layered so that an attacker has to beat every stage, not one. The request middleware chain is **immutable and ordered for a reason** — scanners and path traversal are rejected at position 2, *before* the body is even parsed.

```
1  Helmet            → security headers (HSTS, nosniff, frame-deny, CSP frame-ancestors 'none')
2  SecurityFilter    → block scanners / path traversal / script injection  ← BEFORE body parse
3  Traceability      → inject X-Request-Id
4  BodyParser (JSON) → size-capped, malformed → 400, oversized → 413
6  RequestLogger     → structured incoming + completed logs
7  ResponseTime      → X-Response-Time + slow-response detection
8  Compression       → gzip
9  CORS              → network-aware (VPN / WFH / corporate / local) pattern matching
10 CookieParser      → signed cookies
11 ErrorHandler      → generic messages in prod, no stack leakage
12 IpFilter          → CIDR-aware allowlist
13 RateLimiter       → sliding-window counter (no Redis); auth routes get a stricter limiter
14 PreventRedirects  → API routes only
```

**Beyond the chain:**

- **Authentication & authorization** — JWT in HTTP-only cookies (never `localStorage`). Authorization is **data-driven** via `requireAccess(predicate)` — no hardcoded roles in the template. Forged, expired, tampered, and structurally invalid tokens are all rejected.
- **Progressive login lockout** — `LoginLockoutMiddleware` tracks failures per user, shrinks the allowed-attempt window each cycle, multiplies lockout duration in incremental mode, and after the final cycle escalates to a `423` HR-reset state. Brute-force gets exponentially more expensive.
- **CSRF** — double-submit cookie (`csrf-csrf`) on every POST/PUT/PATCH/DELETE; the frontend `HttpClient` auto-injects the token and transparently retries once on rotation.
- **SQL injection — structurally impossible.** Every Mira query routes user values through per-call bind-variable counters. Raw interpolation is forbidden; the single documented exception (`PIVOT IN`) is escape-sanitised.
- **Password hashing** — `argon2` (and `bcryptjs`) available; plaintext mode exists only as a guarded dev convenience.
- **Secret hygiene** — no secrets in code, no `.env` commits; everything is injected at runtime.

> **CWE coverage** (mapped in the security guides): CWE-79, 89, 20, 22, 200, 209, 287, 307, 312, 352, 384, 434, 502, 601, 639, 693, 798, 918, 1021, 1275, 1333.

---

## ⚡ Performance — proportional, measured, and stampede-proof

CATHERINE doesn't guess at performance — it **measures** it and defends the hot paths.

- **Single-flight coalescing** (`SingleFlight`) — when N concurrent callers hit the same cold cache key, they share *one* in-flight promise instead of firing N identical Oracle queries. This is the primary defence against cache-stampede P95 blowups (the same pattern Go's `singleflight` uses).
- **Cache-aside layer** — `CacheStore` (NodeCache) + `CacheRegistry` + a deterministic `CacheKeyBuilder` (params sorted alphabetically, auto-hashed past 200 chars). Only 2xx JSON is cached; invalidation runs in `setImmediate` so it never blocks the response. Cluster mode stays coherent via `ClusterCacheSync`.
- **In-process RED metrics** (`MetricsStore`, `GET /api/v1/metrics`) — per-route ring buffers give true **p50/p95/p99**, plus event-loop lag (`setImmediate` probe), GC stats (`perf_hooks`), memory/CPU/handles, frontend vitals, and per-pool Oracle query stats. **Zero external dependency.**
- **Response budgets, enforced by tests** — health route p50 < 50 ms, p95 < 200 ms; 50 concurrent requests → zero 500s, every one with a unique `X-Request-Id`.
- **gzip compression**, **keyset pagination** over offset for deep pages, and **N+1 detection** as a review gate.

---

## 🗃️ Mira — the `oracle-mongo-wrapper`

> Write MongoDB-style JavaScript. Get Oracle SQL. Never write raw SQL again. — _Apache 2.0 © 2026 John Moises Paunlagui_

Mira is the centrepiece. It gives the developer ergonomics of MongoDB on top of an enterprise Oracle database, while every generated statement is parameterised and injection-safe.

```js
const { createDb, OracleCollection } = require("./utils/oracle-mongo-wrapper");
const db = createDb("userAccount");
const users = new OracleCollection("T_OPITS_USERS", db);

// FIND — lazy cursor, nothing executes until a terminal method
await users.find({ status: "active", age: { $gt: 18 } })
           .sort({ name: 1 }).skip(10).limit(10).toArray();

// AGGREGATE — group, having, sort, all in one pipeline
await sales.aggregate([
  { $group: { _id: "$region", total: { $sum: "$amount" } } },
  { $having: { total: { $gt: 10000 } } },
  { $sort: { total: -1 } },
]);

// WINDOW FUNCTION — rank within partition
await employees.aggregate([
  { $addFields: { rank: { $window: { fn: "RANK", partitionBy: "deptId", orderBy: { salary: -1 } } } } },
]);

// UPSERT — MERGE in one call
await employees.merge({ id: 10, name: "Ana", salary: 60000 },
  { localField: "id", foreignField: "id" },
  { whenMatched: { $set: { salary: 60000 } }, whenNotMatched: "insert" });
```

**What it covers:**

| Capability | Operators / API |
| --- | --- |
| **Filtering** | `$eq $ne $gt $gte $lt $lte $in $nin $between $notBetween $exists $regex $like $and $or $nor $not` |
| **Updates** | `$set $unset $inc $mul $min $max $currentDate` |
| **Aggregation** | `$sum $avg $min $max $count $first $last $concat $toUpper $toLower $substr $cond $ifNull $dateToString`, `$group / $having / $project / $addFields` |
| **Joins** | `$lookup` → `LEFT/INNER` JOIN (with `select:` to dodge `ORA-00918`) |
| **Analytics** | `buildWindowExpr` → `OVER()`; `RANK`, `ROW_NUMBER`, running totals |
| **CTEs** | `withCTE`, `withRecursiveCTE` (auto column-alias resolution to avoid `ORA-01789`) |
| **Set ops** | `SetResultBuilder` → `UNION / INTERSECT / MINUS` |
| **Hierarchies** | `buildConnectBy`, `buildPivot`, `buildUnpivot` |
| **Transactions** | `new Transaction(db).withTransaction(...)` with named savepoints |
| **Schema / DCL** | `OracleSchema` (CREATE/ALTER/DROP), `OracleDCL` (GRANT/REVOKE) |
| **Performance** | `createPerformance().explainPlan()`, stats gathering |

**Safety & resilience built in:**

- **100% bind variables** via per-call counters — concurrent requests never collide on bind names.
- **Lazy cursors** — `.find()` builds; SQL fires only on `.toArray()/.next()/.count()/.forEach()/.explain()`.
- **Dual-pool architecture** — isolate workloads (auth vs. reporting) so one starving pool can't take down the other. Adding a pool = one `.env` entry + one `database.js` key. Nothing else changes.
- **`PoolHealthMonitor`** — 30 s interval, 3-strike unhealthy marking, exponential backoff on init (`min(1000·2ⁿ, 10000) ms`).

---

## 🩺 Resilience & Observability

- **Request traceability** — every request gets a unique `X-Request-Id`, threaded through structured logs (machine identifier + microsecond timestamps, daily-rotated `logs/YYYY/MM/DD/level.log`, **never truncated**).
- **RFC 5424 logging** — 8 severity levels (`emerg`…`debug`); `console.*` is banned in production code.
- **Audit log** — `AuditLogMiddleware` + `/api/v1/audit-log` for an immutable trail of significant actions.
- **Graceful shutdown** — pool cleanup on signal; unhandled rejections and uncaught exceptions are funneled, not fatal.
- **Reliability-tested** — malformed JSON → 400, oversized body → 413, single bad request never crashes the process.
- **Changelog / release surface** — built-in changelog and release services to ship version notes to the UI.

---

## 🎨 Frontend — Aumovio Design System v3.1

A 50+ component library (React 19 + Tailwind v4), not a CSS framework you fight with.

- **Components for everything** — `Table`, `Modal`, `Drawer`, `Tabs`, `Stepper`, `Datepicker`, `Timeline`, `ColorPicker`, charts (ApexCharts: line/bar/area/donut/radial/heatmap/scatter), typed form inputs, toasts, and more — each with loading/empty/error states baked in.
- **Three-layer feature architecture** — `*.api.js` (HTTP only) · `*.hook.js` (state/logic) · `*.view.jsx` (pure render). Views never touch the network; APIs never touch React. Clean, testable, predictable.
- **Three-tier component sharing** — feature-local → feature-shared → cross-feature, promoted only on the rule of three. The canonical shared `ExcelUploadStepper` runs the same Upload → Verify → Complete wizard across every import feature.
- **A real animation system** — tokenised easings, durations, enter/exit, hover, ambient, and attention animations — no hand-rolled `transition: all 300ms` anywhere.
- **Hardened by default** — `ErrorBoundary` around every view, request deduplication via `useRequest`, `href` sanitisation, and JWT kept out of JS-readable storage.

---

## 🎛️ Personalization — make it theirs

Every user can retheme the entire app live, and it stays accessible:

- **40 curated accent palettes** — _Aumovio Orange, Aumovio Purple, Skydive, The Divine, Bloodlust, Muted, Fade Away…_
- **Custom colour generator** — pick any hex; `generateCustomColors()` derives a full 5-family, 11-shade scale via deterministic HSL rotation. Same hex → same palette, every time.
- **Light / dark / transparency modes** and **layout options**, persisted per user.
- **Contrast-safe by construction** — `applyPaletteVars()` recomputes accent foreground/icon tokens per palette so text and icons always meet **WCAG** contrast — even for near-black or near-white anchors that would otherwise vanish in dark mode. Switching themes touches **zero** components; it's all CSS-variable injection.

---

## ✅ Quality — six test suites

Tests are first-class deliverables, not an afterthought.

| Suite | Proves |
| --- | --- |
| **Unit** | Each middleware class in isolation (mocked `req/res/next`, config via constructor) |
| **Integration** | Full stack via Supertest — response shape, headers, status contracts |
| **Security** | Adversarial — SQLi, traversal, XSS, forged/expired JWT, CSRF replay, flood, bad CORS, scanner paths |
| **Performance** | p50/p95 budgets, 50-concurrent correctness, unique request IDs |
| **Reliability** | Malformed JSON, oversized body, single-bad-request survival |
| **Chaos** | Kill a pool mid-test, assert auth still serves |

Coverage targets: middleware 90% branch · services 85% branch · utils 95% line · constants 100% export.

---

## 🧰 Tech Stack

**Backend** — Node.js · Express 5 · OracleDB 6 (Thick mode) · `node-cache` · `csrf-csrf` · Helmet 8 · `jsonwebtoken` · `argon2`/`bcryptjs` · `nanoid` · ExcelJS · PDFKit · Nodemailer · Mocha/Chai/Sinon/Supertest · packaged with `pkg` → standalone `.exe`

**Frontend** — React 19 · Vite 8 · Tailwind CSS v4 · React Compiler · React Router 7 · ApexCharts · FontAwesome 7 · `react-dropzone` · `jose` · ExcelJS

---

## 🚀 Getting Started

```bash
# Backend
cd Backend
npm install
cp .env.example .env        # fill in Oracle creds + JWT/CSRF secrets
npm start                   # or: npm run build  → dist/*.exe

# Frontend
cd Frontend
npm install
npm run dev
```

Full architecture rules, the complete component map, the animation system, and the Mira operator reference live in **`Backend/CLAUDE.md`**, **`Frontend/Claude.md`**, and **`Backend/src/utils/oracle-mongo-wrapper/README.md`**.

---

<div align="center">

**CATHERINE** — secure, fast, observable, and beautiful, from the first commit.

_TailwindCSS Design System v3.1 · Express v5 class-based OOP · Mira `oracle-mongo-wrapper` (Apache 2.0 © 2026 John Moises Paunlagui)_

</div>
