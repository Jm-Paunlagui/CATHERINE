"use strict";

/**
 * @fileoverview Express middleware that records per-request RED metrics into MetricsStore.
 *
 * WHAT THIS FILE DOES
 *   Taps into each Express response's "finish" event to capture route, method,
 *   status code, and duration, then calls metricsStore.recordRequest() with that data.
 *
 * HOW IT WORKS
 *   - On handle(), records process.hrtime.bigint() as the request start time.
 *   - Hooks res.on("finish") to compute elapsed time once the response is flushed.
 *   - Route key is built via utils/routeLabel.buildRouteLabel() INSIDE the finish
 *     handler — req.baseUrl + req.route.path are only populated after the router
 *     has matched, never at request start. This yields the full mounted pattern
 *     ("POST /api/v1/pay-period/save") with param tokens preserved
 *     ("/:gid/:cardNumber/history"), so distinct routers never collapse into one
 *     key and raw param values never leak into labels.
 *   - OPTIONS (CORS preflight) requests are not recorded at all — they are
 *     answered before routing and would pollute labels with raw concrete paths.
 *   - Unmatched requests (404s) aggregate under the fixed "UNMATCHED" label to
 *     prevent label-cardinality explosion from attacker-controlled URLs.
 *   - Does NOT duplicate ResponseTimeMiddleware's X-Response-Time header work.
 *   - Follows the standard MEAL middleware pattern: class + bound handle() + named export.
 *
 * EXAMPLE
 *   const { defaultMetrics } = require('./MetricsMiddleware');
 *   app.use(defaultMetrics.handle.bind(defaultMetrics)); // position 5a in app.js
 */

const { metricsStore: defaultStore } = require("./MetricsStore");
const {
  captureRouteLabel,
  resolveRouteLabel,
  shouldRecordRouteMetrics,
} = require("../../utils/routeLabel");

class MetricsMiddleware {
  /**
   * @param {import('./MetricsStore').MetricsStore} [store] - Metrics store instance.
   *   Defaults to the module-level singleton so all middleware share one store.
   */
  constructor(store = defaultStore) {
    this._store = store;
    this.handle = this.handle.bind(this);
  }

  /**
   * Express middleware. Hooks res "finish" to record the completed request.
   *
   * @param {import('express').Request}  req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  handle(req, res, next) {
    // CORS preflights are browser plumbing, not business traffic — skip entirely
    // (they are answered before routing, so they could only ever record raw,
    // unparameterized paths — a cardinality + information-exposure hazard).
    if (!shouldRecordRouteMetrics(req)) return next();

    const startNs = process.hrtime.bigint();

    // Capture the route label SYNCHRONOUSLY while the matched handler is still on
    // the stack — at that moment req.baseUrl + req.route + req.params are all
    // intact. By the time the async "finish" event fires, Express has restored
    // req.baseUrl to "" (and req.params to {}) as it unwinds the router stack, so
    // a finish-time read collapses every router's "/" to "GET /" and every
    // "/verify" to "POST /verify". res.end fires for success AND error responses.
    const originalEnd = res.end;
    res.end = function patchedEnd(...args) {
      captureRouteLabel(req);
      return originalEnd.apply(this, args);
    };

    res.on("finish", () => {
      try {
        const durationMs = Number(
          (process.hrtime.bigint() - startNs) / BigInt(1_000_000),
        );

        // Prefer the label captured during the handler; fall back to a fresh
        // build (with originalUrl reconstruction) if capture never ran.
        const route = resolveRouteLabel(req);

        this._store.recordRequest(route, req.method, res.statusCode, durationMs);
      } catch {
        // Non-fatal — metrics collection must never crash the request pipeline
      }
    });

    next();
  }
}

// ─── Singleton export ─────────────────────────────────────────────────────────

const defaultMetrics = new MetricsMiddleware();

module.exports = { MetricsMiddleware, defaultMetrics };
