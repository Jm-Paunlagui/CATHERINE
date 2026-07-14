"use strict";

/**
 * @fileoverview Canonical route-label builder shared by all observability middleware.
 *
 * WHAT THIS FILE DOES
 *   Produces the single, canonical "<METHOD> <mounted-route-pattern>" label used as
 *   the aggregation key for per-route metrics (MetricsMiddleware → MetricsStore,
 *   ResponseTimeMiddleware → per-route timing map). Having ONE implementation
 *   guarantees every observability surface groups requests under identical keys.
 *
 * HOW IT WORKS
 *   - In Express, `req.route.path` is only the path segment registered on the
 *     sub-router (e.g. "/save") — it EXCLUDES the mount prefix. The full templated
 *     path is `req.baseUrl + req.route.path` (e.g. "/api/v1/pay-period" + "/save").
 *     Using `req.route.path` alone collapses every router's "/save" into one
 *     "POST /save" row — the bug this module fixes.
 *   - `req.route` / `req.baseUrl` are only populated AFTER the router has matched,
 *     so callers MUST invoke buildRouteLabel() inside a res "finish" handler —
 *     never at request start.
 *   - Express param tokens (":gid", ":cardNumber") are preserved so labels stay
 *     parameterized — raw param values (PII, IDs) never enter metric labels
 *     (CWE-200 information exposure + label-cardinality protection).
 *   - Requests that never matched a route (404s, requests rejected by pre-routing
 *     middleware) have no `req.route`; they are aggregated under the fixed
 *     UNMATCHED_ROUTE_LABEL instead of their raw URL, preventing unbounded label
 *     cardinality and PII leakage from attacker-controlled paths.
 *   - OPTIONS (CORS preflight) requests are excluded from route metrics entirely
 *     via shouldRecordRouteMetrics(): they are browser plumbing, not business
 *     traffic, and they are answered before routing (so they would all fall into
 *     the unmatched bucket and skew error/latency rates).
 *
 * EXAMPLE
 *   const { buildRouteLabel, shouldRecordRouteMetrics } = require("../utils/routeLabel");
 *
 *   res.on("finish", () => {
 *     if (!shouldRecordRouteMetrics(req)) return;          // skip CORS preflights
 *     const route = buildRouteLabel(req);                  // "POST /api/v1/pay-period/save"
 *     metricsStore.recordRequest(route, req.method, res.statusCode, durationMs);
 *   });
 */

/**
 * @constant {string} Fixed label segment for requests that never matched a route
 * (404s, requests short-circuited by pre-routing middleware). Recording raw URLs
 * here would let any client mint unbounded metric keys (memory exhaustion,
 * CWE-400) and leak concrete identifiers into dashboards (CWE-200).
 */
const UNMATCHED_ROUTE_LABEL = "UNMATCHED";

/**
 * @constant {string[]} Path prefixes excluded from per-route metrics aggregation.
 *
 * These are the observability dashboard's OWN polling traffic, not business
 * traffic — recording them is an observer-effect distortion:
 *   - /api/v1/audit-logs        : the Logging & Observability page polls the list
 *                                 + stats on every SSE tick and 30s refresh.
 *   - /api/v1/audit-logs/stream : a long-lived SSE connection — its res "finish"
 *                                 fires only on close, so its "duration" is the
 *                                 whole session and would poison p95/p99/apdex.
 *   - /api/v1/metrics           : the System/RED/Health tabs poll these every 30s.
 *
 * Mirrors AuditLogMiddleware, which already excludes /api/v1/audit-logs from the
 * audit table. Override with METRICS_EXCLUDE_PATHS (comma-separated) in .env.
 * Parsed once at module load.
 */
const METRICS_EXCLUDED_PREFIXES = (
  process.env.METRICS_EXCLUDE_PATHS
    ? process.env.METRICS_EXCLUDE_PATHS.split(",").map((p) => p.trim())
    : ["/api/v1/audit-logs", "/api/v1/metrics"]
).filter(Boolean);

/**
 * Extract the pathname (no query string) from a request, robust to the call site:
 * at middleware entry req.path is set; at res "finish" Express may have restored
 * req.url, so originalUrl is the reliable source.
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
function getRequestPath(req) {
  const raw = req.originalUrl || req.url || req.path || "";
  const qIdx = raw.indexOf("?");
  return qIdx === -1 ? raw : raw.slice(0, qIdx);
}

/**
 * Whether a path falls under an excluded prefix (exact match or sub-path), so
 * "/api/v1/audit-logs" excludes "/api/v1/audit-logs/stream" but NOT a sibling
 * like "/api/v1/audit-logs-export".
 *
 * @param {string} path
 * @returns {boolean}
 */
function isMetricsExcludedPath(path) {
  return METRICS_EXCLUDED_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

/** @constant {RegExp} Express path param token, e.g. ":gid" or optional ":id?". */
const PARAM_TOKEN_RE = /:([A-Za-z0-9_]+)\??/g;

/** @constant {string} Property on req where the captured label is memoised. */
const CAPTURED_LABEL_KEY = "_routeLabel";

/**
 * Fill an Express route template with its concrete param values so the result
 * can be compared against the concrete request path.
 *
 * @param {string} routePath - Leaf template, e.g. "/:gid/:cardNumber/history".
 * @param {object} [params]   - req.params (decoded values).
 * @returns {string} e.g. "/A1/9988/history". Unknown params keep their token.
 */
function fillRouteTemplate(routePath, params) {
  if (!params) return routePath;
  return routePath.replace(PARAM_TOKEN_RE, (token, name) =>
    params[name] != null ? String(params[name]) : token,
  );
}

/**
 * Recover the router mount prefix (req.baseUrl) from req.originalUrl when Express
 * has already restored req.baseUrl to "" — which happens by the time the async
 * res "finish" event fires (and on the error-handling path, before the app-level
 * error handler runs). Without this, every router's "/" collapses to "GET /" and
 * every "/verify" across routers collapses to "POST /verify".
 *
 * Strategy: the leaf route matched the tail of the path. Fill the leaf template
 * with its params to get the concrete tail, then everything before it is baseUrl.
 *
 * @param {import('express').Request} req
 * @param {string} routePath - Leaf route template.
 * @returns {string} Reconstructed baseUrl, or "" if it cannot be determined.
 */
function reconstructBaseUrl(req, routePath) {
  const rawPath = (req.originalUrl || req.url || "").split("?")[0];
  if (!rawPath) return "";

  let urlPath = rawPath;
  try {
    urlPath = decodeURIComponent(rawPath);
  } catch {
    /* malformed % sequence — fall back to the raw path */
  }

  // Leaf "/" means the router root matched: the entire path IS the mount prefix.
  if (routePath === "/") return urlPath.replace(/\/+$/, "");

  let concreteLeaf = fillRouteTemplate(routePath, req.params);
  try {
    concreteLeaf = decodeURIComponent(concreteLeaf);
  } catch {
    /* keep as-is */
  }

  if (concreteLeaf && urlPath.endsWith(concreteLeaf)) {
    return urlPath.slice(0, urlPath.length - concreteLeaf.length);
  }
  return "";
}

/**
 * Build the canonical aggregation label for a request.
 *
 * Best read while the matched handler is still executing (req.baseUrl, req.route,
 * and req.params all intact) — see captureRouteLabel(). If called later (e.g. in a
 * res "finish" handler) when Express has restored req.baseUrl to "", the mount
 * prefix is reconstructed from req.originalUrl so the label stays endpoint-precise.
 *
 * Normalization rules:
 *   - Matched route   → "<METHOD> <baseUrl + req.route.path>"
 *   - Root route "/"  → "<METHOD> <baseUrl>" (no trailing slash)
 *   - No match        → "<METHOD> UNMATCHED" (never the raw URL)
 *
 * O(L) time in the path length (template fill + endsWith), O(1) extra space.
 *
 * @param {import('express').Request} req - The request.
 * @returns {string} Canonical label, e.g. "GET /api/v1/records/:gid/:cardNumber/history".
 * @example
 * buildRouteLabel(req); // → "POST /api/v1/pay-period/verify"
 */
function buildRouteLabel(req) {
  const matched = req.route?.path;

  if (matched === undefined || matched === null) {
    return `${req.method} ${UNMATCHED_ROUTE_LABEL}`;
  }

  // Express allows registering one handler for an array of paths; the matched
  // pattern set is small and static, so the first entry is a stable key.
  const routePath = Array.isArray(matched) ? matched[0] : matched;

  // Prefer the live baseUrl; only reconstruct when Express has already cleared it.
  let baseUrl = req.baseUrl || "";
  if (!baseUrl) baseUrl = reconstructBaseUrl(req, routePath);

  // "/" on a mounted router would produce "/api/v1/pay-period/" — strip it so
  // the label matches the mount path exactly. Keep "/" when mounted at app root.
  const fullPath = `${baseUrl}${routePath === "/" ? "" : routePath}`;

  return `${req.method} ${fullPath || "/"}`;
}

/**
 * Memoise the route label onto the request the FIRST time it is called, while the
 * matched handler is still on the stack (req.baseUrl + req.route + req.params all
 * intact). Call this from a res.end / res.writeHead override — NOT from "finish".
 * Idempotent: later calls (and the error-handler's res.end) are no-ops once set.
 *
 * @param {import('express').Request} req
 * @returns {void}
 */
function captureRouteLabel(req) {
  if (req[CAPTURED_LABEL_KEY] === undefined && req.route) {
    req[CAPTURED_LABEL_KEY] = buildRouteLabel(req);
  }
}

/**
 * Return the captured label if captureRouteLabel() ran during the handler;
 * otherwise build one now (with originalUrl reconstruction for the error path).
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
function resolveRouteLabel(req) {
  return req[CAPTURED_LABEL_KEY] ?? buildRouteLabel(req);
}

/**
 * Whether a request should be recorded in per-route metrics at all.
 *
 * Excluded:
 *   - OPTIONS (CORS preflights): answered before routing, no business signal,
 *     would pollute dashboards with unparameterized concrete paths.
 *   - Observability self-traffic (METRICS_EXCLUDED_PREFIXES): the dashboard's own
 *     polling of /api/v1/audit-logs and /api/v1/metrics, plus the long-lived SSE
 *     stream whose session-length duration would wreck latency percentiles.
 *
 * O(P) time in the number of excluded prefixes (tiny, constant), O(1) space.
 *
 * @param {import('express').Request} req - The request under consideration.
 * @returns {boolean} true when the request should be recorded.
 * @example
 * shouldRecordRouteMetrics({ method: "OPTIONS" }); // → false
 */
function shouldRecordRouteMetrics(req) {
  if (req.method === "OPTIONS") return false;
  if (isMetricsExcludedPath(getRequestPath(req))) return false;
  return true;
}

module.exports = {
  buildRouteLabel,
  captureRouteLabel,
  resolveRouteLabel,
  shouldRecordRouteMetrics,
  UNMATCHED_ROUTE_LABEL,
};
