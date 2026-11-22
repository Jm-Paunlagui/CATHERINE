

import type { NextFunction, Request, Response } from "express";
import express from "express";
const app = express();

// ─── Trust proxy (H1) ─────────────────────────────────────────────────────────
// When behind a reverse proxy / load balancer, Express must trust the proxy so
// that req.ip reflects the real client IP (from X-Forwarded-For) rather than
// the proxy's IP. Without this, rate limiting, IP filtering, security filter
// blocking, and audit logging all operate on the wrong address.
//
// TRUST_PROXY values:
//   false (default) — direct connection, no proxy
//   true            — trust the first proxy hop
//   1, 2, …         — number of trusted proxy hops
//   "loopback"      — trust loopback addresses only
//   "10.0.0.0/8"    — trust a specific CIDR range
const trustProxy = process.env.TRUST_PROXY;
if (trustProxy && trustProxy !== "false") {
    // Numeric string → number, boolean string → boolean, else pass as-is
    const parsed = /^\d+$/.test(trustProxy)
        ? parseInt(trustProxy, 10)
        : trustProxy === "true"
          ? true
          : trustProxy;
    app.set("trust proxy", parsed);
}

// ─── Security middleware ──────────────────────────────────────────────────────
import { defaultHelmet } from "./middleware/security/HelmetMiddleware";
import { defaultCors } from "./middleware/security/CorsMiddleware";
import { defaultSecurityFilter } from "./middleware/security/SecurityFilterMiddleware";
import { defaultIpFilter } from "./middleware/security/IpFilterMiddleware";
import { defaultPreventRedirects } from "./middleware/security/PreventRedirectsMiddleware";
import { defaultRateLimiter } from "./middleware/security/RateLimiterMiddleware";

// ─── Traceability middleware ──────────────────────────────────────────────────
import { defaultTraceability } from "./middleware/traceability/TraceabilityMiddleware";
import { defaultAuditLog } from "./middleware/traceability/AuditLogMiddleware";
import { defaultShutdownGate } from "./middleware/security/ShutdownGateMiddleware";

// ─── Performance middleware ───────────────────────────────────────────────────
import { defaultCompression } from "./middleware/performance/CompressionMiddleware";
import { defaultResponseTime } from "./middleware/performance/ResponseTimeMiddleware";

// ─── Metrics middleware ───────────────────────────────────────────────────────
import { defaultMetrics } from "./middleware/metrics";

// ─── Parsing middleware ───────────────────────────────────────────────────────
import { defaultBodyParser } from "./middleware/parsing/BodyParserMiddleware";
import { defaultCookieParser } from "./middleware/parsing/CookieParserMiddleware";

// ─── CSRF protection ──────────────────────────────────────────────────────────
import { defaultCsrf } from "./middleware/security/CsrfMiddleware";

// ─── Error handling ───────────────────────────────────────────────────────────
import { defaultErrorHandler } from "./middleware/errorHandling/ErrorHandlerMiddleware";

// ─── Cache stores ─────────────────────────────────────────────────────────────
// Side-effect import: registers every store. ESM evaluates imports in source
// order before this module's body, so it must sit above the routes import.
import "./config/cacheStores";

// ─── Routes ───────────────────────────────────────────────────────────────────
import routes from "./routes";

// ═══════════════════════════════════════════════════════════════════════════════
// MIDDLEWARE STACK (order matters — do not reorder)
// ═══════════════════════════════════════════════════════════════════════════════

// 1. Security headers
app.use(defaultHelmet.handle.bind(defaultHelmet));

// 2. Security filter — block scanners & malicious requests EARLY
app.use(defaultSecurityFilter.handle.bind(defaultSecurityFilter));

// 3. Request ID + ALS context + the "[Request Complete]" line.
//    Deliberately ABOVE the body parsers: a malformed-JSON 400 is raised by the
//    parser itself, and that request still needs an id, an ALS context, and an
//    audit row. The "[Incoming Request]" line is split out to step 4a — see
//    TraceabilityMiddleware.logIncoming.
app.use(defaultTraceability.handle.bind(defaultTraceability)); // lgtm[js/missing-rate-limiting] Rate limiting is enforced by RateLimiterMiddleware (step 12)

// 3a. Audit log DB persistence — fires after res.end via setImmediate
app.use(defaultAuditLog.handle);

// 3b. Shutdown gate — after Traceability+AuditLog (request id + audit row on the 503), before body parsing; CORS added by ErrorHandler
app.use(defaultShutdownGate.handle);

// 4. Body parsing — must be before route handlers so req.body is available
app.use(defaultBodyParser.jsonHandler);
app.use(defaultBodyParser.urlencodedHandler);
//    Empty-body default — still step 4. Express 5 (body-parser 2) leaves
//    req.body UNDEFINED when neither parser above matched the Content-Type
//    (text/plain, a missing header) or the request had no body; every handler
//    that destructures req.body then threw a TypeError → generic 500, including
//    the unauthenticated POST /auth/login (API-REL-01). This restores the
//    Express 4 contract — req.body is always an object — so those requests reach
//    normal field validation and answer 400. It MUST sit after both parsers (it
//    only fills the gap they leave and never overwrites a parsed body) and ABOVE
//    4a, so the "[Incoming Request]" line logs the same body the handlers see.
//    Route-level multer still replaces req.body with its own object on
//    multipart requests.
app.use(defaultBodyParser.defaultBodyHandler);

// 4a. "[Incoming Request]" log line — MUST stay directly below the body parsers.
//     Above them req.body does not exist yet, which is why this line used to read
//     "[BODY @ req.body is undefined]" on every POST while the matching
//     "[Request Complete]" line showed the real body.
app.use(defaultTraceability.logIncoming);

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
//    POST /api/v1/metrics/frontend is also excluded: it is an unauthenticated,
//    pre-auth web-vitals telemetry sink delivered via fetch+keepalive (page-unload
//    path) which cannot attach the x-csrf-token header. CSRF protects
//    authenticated session-riding mutations — this endpoint has no session to
//    ride. Abuse is bounded by the route's dedicated 30 req/min rate limiter.
//    doubleCsrf only enforces on state-changing methods (POST/PUT/DELETE/PATCH);
//    GET /csrf/token and other safe methods pass through automatically.
const CSRF_EXEMPT_PATHS = ["/api/v1/csrf", "/api/v1/metrics/frontend"];
app.use((req: Request, res: Response, next: NextFunction) => {
    if (CSRF_EXEMPT_PATHS.some((p) => req.path.startsWith(p))) return next();
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

export default app;
