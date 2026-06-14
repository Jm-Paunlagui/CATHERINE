"use strict";

const express = require("express");
const app = express();

// ─── Security middleware ──────────────────────────────────────────────────────
const { defaultHelmet } = require("./middleware/security/HelmetMiddleware");
const { defaultCors } = require("./middleware/security/CorsMiddleware");
const {
  defaultSecurityFilter,
} = require("./middleware/security/SecurityFilterMiddleware");
const { defaultIpFilter } = require("./middleware/security/IpFilterMiddleware");
const {
  defaultPreventRedirects,
} = require("./middleware/security/PreventRedirectsMiddleware");
const {
  defaultRateLimiter,
} = require("./middleware/security/RateLimiterMiddleware");

// ─── Traceability middleware ──────────────────────────────────────────────────
const {
  defaultTraceability,
} = require("./middleware/traceability/TraceabilityMiddleware");
const {
  defaultAuditLog,
} = require("./middleware/traceability/AuditLogMiddleware");

// ─── Performance middleware ───────────────────────────────────────────────────
const {
  defaultCompression,
} = require("./middleware/performance/CompressionMiddleware");
const {
  defaultResponseTime,
} = require("./middleware/performance/ResponseTimeMiddleware");

// ─── Metrics middleware ───────────────────────────────────────────────────────
const { defaultMetrics } = require("./middleware/metrics");

// ─── Parsing middleware ───────────────────────────────────────────────────────
const {
  defaultBodyParser,
} = require("./middleware/parsing/BodyParserMiddleware");
const {
  defaultCookieParser,
} = require("./middleware/parsing/CookieParserMiddleware");

// ─── CSRF protection ──────────────────────────────────────────────────────────
const { defaultCsrf } = require("./middleware/security/CsrfMiddleware");

// ─── Error handling ───────────────────────────────────────────────────────────
const {
  defaultErrorHandler,
} = require("./middleware/errorHandling/ErrorHandlerMiddleware");

// ─── Cache stores ─────────────────────────────────────────────────────────────
const { registry, ClusterCacheSync } = require("./middleware/cache");
registry.registerAll({
  // ── RFID ────────────────────────────────────────────────────────────────────
  // Queried on every RFID management page load. Low mutation rate (batch uploads).
  // Namespace-wiped on any write. maxKeys=200 absorbs list + archived + pagination.
  rfidMasterfile: { ttl: 300, checkPeriod: 60, maxKeys: 200 },

  // ── Admin roster ──────────────────────────────────────────────────────────────
  // Small dataset (<100 admins). Queried by admin list and billing recipient
  // selector. Mutates only on admin CRUD. maxKeys=50 is a hard ceiling.
  adminList: { ttl: 600, checkPeriod: 120, maxKeys: 50 },

  // ── Pay period ────────────────────────────────────────────────────────────────
  // Append-only mid-cycle; locked periods never change. Years list changes at
  // most once per year. maxKeys=100 covers all year-filtered variants.
  payPeriod: { ttl: 900, checkPeriod: 180, maxKeys: 100 },

  // ── Subsidy management ────────────────────────────────────────────────────────
  // Queried per year+month; 12 months x 10 years = 120 list keys max.
  // maxKeys=500 is generous headroom for years/months helpers + list variants.
  subsidy: { ttl: 600, checkPeriod: 120, maxKeys: 500 },

  // ── Billing ───────────────────────────────────────────────────────────────────
  // Report is the heaviest Oracle query in the system. Paginated with
  // entity+search filters means many key combos. 1800s staleness is acceptable
  // — billing data is tied to cutoff cycles, not real-time. download-requests
  // list shares this store; invalidated via billing:downloadRequests pattern.
  // maxKeys=1000: ~200 cutoffs x ~5 page/filter combos each.
  billing: { ttl: 1800, checkPeriod: 300, maxKeys: 1000 },

  // ── Audit log ─────────────────────────────────────────────────────────────────
  // Logs grow continuously; 120s TTL prevents serving stale security telemetry
  // while reducing Oracle pressure for admin polling. maxKeys=200 covers
  // concurrent admin sessions browsing the list, stats, and per-requestId views.
  auditLog: { ttl: 120, checkPeriod: 30, maxKeys: 200 },

  // ── Consumption history ───────────────────────────────────────────────────────
  // Per-GID list of all periods with subsidy + consumption totals. Fetches 3
  // separate Oracle queries (cutoffs, subsidies, transactions aggregate). Data
  // changes only on period close + settlement (~twice a month) or subsidy upload.
  // TTL=300s is conservative; computeSettlement actively deletes the key per GID
  // so stale data is rarely served. maxKeys=10000 covers the maximum user ceiling.
  consumptionHistory: { ttl: 300, checkPeriod: 60, maxKeys: 10000 },

  // ── Consumption summary ───────────────────────────────────────────────────────
  // Per-GID active-period summary: wallet balance, net consumption, subsidy,
  // carry-over, and settlement status. Fetches 4–6 Oracle queries in parallel
  // (active cutoff, live settlement view, consumption aggregate x2, wallet,
  // settlement row). This is the highest-cost read endpoint in the system.
  // TTL=60s (staleTime 60000ms) — short enough to reflect mid-period swipes
  // for SSE users (who get real-time updates via the SSE stream instead), but
  // long enough to absorb concurrent page loads from the same employee.
  // Invalidated by computeSettlement, seedWalletIfAbsent, and subsidy upload.
  // maxKeys=10000 covers the maximum concurrent-user ceiling.
  consumptionSummary: { ttl: 60, checkPeriod: 30, maxKeys: 10000 },

  // ── QR stubs ─────────────────────────────────────────────────────────────────
  // Per-EMP_ID list of all QR voucher stubs. Changes only when HR uploads new
  // stubs (batch UPSERT) or when a stub is used/expired. TTL=120s absorbs
  // repeated page loads without serving stale data for more than 2 minutes.
  // maxKeys=10000 covers the maximum user ceiling.
  consumptionStubs: { ttl: 120, checkPeriod: 60, maxKeys: 10000 },

  // ── Auth profile flags (/auth/me) ────────────────────────────────────────────
  // Per-EMP_ID permission-flag object (or `false` sentinel for non-admins).
  // /me fires on every page focus; the flags are UI hints only (never
  // server-side gates), so 30s staleness is harmless. Flag writes invalidate
  // surgically at the MealAdmModel write chokepoint (the only four write
  // methods for T_EMP_MGMT_ADMIN). maxKeys=10000 covers the user ceiling.
  authProfile: { ttl: 30, checkPeriod: 15, maxKeys: 10000 },
});

// Cross-worker cache invalidation (ENABLE_CLUSTERING=true): apply sibling
// workers' invalidations to this worker's stores so no worker serves stale
// data after a write. No-op in single-process mode. Must run AFTER
// registerAll so every relayed store name resolves.
ClusterCacheSync.initWorker(registry);

// ─── Routes ───────────────────────────────────────────────────────────────────
const routes = require("./routes");

// ═══════════════════════════════════════════════════════════════════════════════
// MIDDLEWARE STACK (order matters — do not reorder)
// ═══════════════════════════════════════════════════════════════════════════════

// 1. Security headers
app.use(defaultHelmet.handle.bind(defaultHelmet));

// 2. Security filter — block scanners & malicious requests EARLY
app.use(defaultSecurityFilter.handle.bind(defaultSecurityFilter));

// 3. Request ID + request/response logging
app.use(defaultTraceability.handle.bind(defaultTraceability)); // lgtm[js/missing-rate-limiting] Rate limiting is enforced by RateLimiterMiddleware (step 12)

// 3a. Audit log DB persistence — fires after res.end via setImmediate
app.use(defaultAuditLog.handle);

// 4. Body parsing — must be before route handlers so req.body is available
app.use(defaultBodyParser.jsonHandler);
app.use(defaultBodyParser.urlencodedHandler);

// 5. Response-time tracking (X-Response-Time header + per-route metrics)
app.use(defaultResponseTime.handle.bind(defaultResponseTime));

// 5a. Metrics collection — must run after ResponseTimeMiddleware so both
//     measure from the same request-start origin. MetricsMiddleware maintains
//     its own per-route ring buffers for p50/p95/p99 percentile calculation,
//     which ResponseTimeMiddleware does not provide.
app.use(defaultMetrics.handle.bind(defaultMetrics));

// 6. Compression
app.use(defaultCompression.handle.bind(defaultCompression));

// 7. CORS
app.use(defaultCors.handle.bind(defaultCors));

// 8. Cookie parsing
app.use(defaultCookieParser.handle.bind(defaultCookieParser)); // lgtm[js/missing-csrf-middleware] CSRF is enforced at step 9 below

// 9. CSRF protection — must come after cookie-parser so the secret cookie is readable.
//    The CSRF token endpoints (/api/v1/csrf/*) are excluded to avoid a catch-22 where
//    a valid token is required to obtain or refresh a token.
//    doubleCsrf only enforces on state-changing methods (POST/PUT/DELETE/PATCH);
//    GET /csrf/token and other safe methods pass through automatically.
app.use((req, res, next) => {
  if (req.path.startsWith("/api/v1/csrf")) return next();
  defaultCsrf.handle.bind(defaultCsrf)(req, res, next);
});

// 10. Capture response body for downstream logging
app.use(defaultErrorHandler.captureResponseBody.bind(defaultErrorHandler));

// 11. IP filtering (enabled via ENABLE_IP_FILTER env var)
app.use(defaultIpFilter.handle.bind(defaultIpFilter));

// 12. Rate limiting — custom Sliding Window Counter backed by NodeCache.
//     CodeQL may not recognise this as a rate limiter because it is not an
//     npm package with a known call signature; the protection is real.
// lgtm[js/missing-rate-limiting]
app.use(defaultRateLimiter.handle.bind(defaultRateLimiter));

// 13. Prevent redirects on API routes
app.use("/api", defaultPreventRedirects.handle.bind(defaultPreventRedirects));

// Disable Express default headers
app.disable("x-powered-by");

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

app.use("/api/v1", routes);

// ═══════════════════════════════════════════════════════════════════════════════
// ERROR HANDLING (must be LAST)
// ═══════════════════════════════════════════════════════════════════════════════

// 404 catch-all
app.use(defaultErrorHandler.notFoundHandler.bind(defaultErrorHandler));

// Global error handler
app.use(defaultErrorHandler.handle.bind(defaultErrorHandler));

module.exports = app;
