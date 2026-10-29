"use strict";

/**
 * @fileoverview HealthStreamHub — pushes the readiness verdict to every open
 * `GET /health/stream` connection.
 *
 * WHY
 *   The UI's ServerStatusBanner learned about an outage only from real traffic,
 *   so a user who was signed in but idle (or on the sign-in page) saw nothing
 *   until they clicked something. This hub lets the server tell the browser:
 *     - `status` {ready, cause} when the stream opens, and again the moment the
 *       verdict changes (a pool breaker flips, a health check fails or passes);
 *     - `heartbeat` every HEALTH_STREAM_HEARTBEAT_MS, so a client that stops
 *       hearing from the server knows the SERVER is gone;
 *     - `shutdown` when the server drains (SseConnectionRegistry.endAll).
 *
 * HOW
 *   One shared evaluation loop, not one per connection: while at least one
 *   client is connected, the pool health monitor runs at its fast cadence
 *   (setPoolHealthWatched) and every check result triggers a coalesced
 *   ReadinessService.evaluate(). The verdict is broadcast only when it changes.
 *   Cost is O(pools) per tick regardless of the number of clients.
 *
 *   "ready: true" uses the same rule as /ready: every pool answers AND every
 *   breaker is closed, so the banner's "Back online" never precedes a working
 *   sign-in.
 *
 * CLUSTER
 *   Pools and breakers are per worker, so each worker reports its own view.
 *   A worker whose pools are down tells its clients so; the other workers keep
 *   serving. That matches what a request routed to that worker would see.
 *
 * SECURITY (CWE-209/CWE-200)
 *   The stream is unauthenticated (like /health/ready) and carries ONLY
 *   `{ ready, cause }` with cause in {null, "database"} — never pool names,
 *   ORA/NJS codes, latencies or hosts. Concurrent connections are capped per IP
 *   and globally so the endpoint cannot be used to exhaust sockets.
 */

const db = require("../config");
const ReadinessService = require("./ReadinessService");
const SseConnectionRegistry = require("../utils/sse/SseConnectionRegistry");
const InFlightTaskRegistry = require("../utils/InFlightTaskRegistry");
const { logger } = require("../utils/logger");

/**
 * Reads a positive-integer env var, falling back to `fallbackValue`.
 * @param {string} name
 * @param {number} fallbackValue
 * @returns {number}
 */
function _envInt(name, fallbackValue) {
    const n = Number(process.env[name]);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallbackValue;
}

/** Gap between heartbeats. The UI treats ~2.5x this without a frame as "server gone". */
const HEALTH_STREAM_HEARTBEAT_MS = _envInt("HEALTH_STREAM_HEARTBEAT_MS", 15000);
/** Safety re-evaluation while clients are connected; monitor check events drive the fast path. */
const HEALTH_STREAM_EVAL_MS = _envInt("HEALTH_STREAM_EVAL_MS", 30000);
/** Browser reconnect delay sent as the SSE `retry:` field. */
const HEALTH_STREAM_RETRY_MS = 3000;
/**
 * Concurrent stream cap per client IP (tabs of one user share the IP; so do
 * users behind one NAT). A refused client falls back to polling /ready.
 */
const HEALTH_STREAM_MAX_PER_IP = _envInt("HEALTH_STREAM_MAX_PER_IP", 50);
/** Concurrent stream cap for this worker. */
const HEALTH_STREAM_MAX_TOTAL = _envInt("HEALTH_STREAM_MAX_TOTAL", 2000);

class HealthStreamHub {
    constructor() {
        /** @type {Map<import('express').Response, { ip: string, teardown: () => void }>} */
        this._clients = new Map();
        /** @type {Map<string, number>} */
        this._perIp = new Map();
        /** @type {{ ready: boolean, cause: "database"|null }|null} */
        this._last = null;
        this._heartbeat = null;
        this._evalTimer = null;
        this._unsubs = [];
        this._evaluating = false;
        this._pending = false;
    }

    /** @returns {number} open streams on this worker. */
    size() {
        return this._clients.size;
    }

    /**
     * Can this IP open another stream?
     * @param {string} ip
     * @returns {boolean}
     */
    canAccept(ip) {
        if (this._clients.size >= HEALTH_STREAM_MAX_TOTAL) return false;
        return (this._perIp.get(ip) ?? 0) < HEALTH_STREAM_MAX_PER_IP;
    }

    /**
     * Upgrades `res` to an event stream and registers it.
     * @param {import('express').Request} req
     * @param {import('express').Response} res
     * @param {string} ip
     * @returns {void}
     */
    open(req, res, ip) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();
        this._write(res, `retry: ${HEALTH_STREAM_RETRY_MS}\n\n`);

        let closed = false;
        const teardown = () => {
            if (closed) return;
            closed = true;
            unregister();
            this._remove(res);
        };
        const unregister = SseConnectionRegistry.register(res, teardown);
        this._clients.set(res, { ip, teardown });
        this._perIp.set(ip, (this._perIp.get(ip) ?? 0) + 1);
        req.on("close", teardown);

        // Tell this client the last known verdict at once; a fresh evaluation
        // follows and corrects it if the world changed.
        if (this._last) this._send(res, "status", this._last);
        if (this._clients.size === 1) this._start();
        this._requestEvaluate();
    }

    /** @param {import('express').Response} res */
    _remove(res) {
        const meta = this._clients.get(res);
        if (!meta) return;
        this._clients.delete(res);
        const n = (this._perIp.get(meta.ip) ?? 1) - 1;
        if (n <= 0) this._perIp.delete(meta.ip);
        else this._perIp.set(meta.ip, n);
        if (this._clients.size === 0) this._stop();
    }

    _start() {
        db.setPoolHealthWatched?.(true);
        if (db.onPoolHealthCheck) {
            // Only a check that contradicts the last verdict is worth a fresh
            // evaluation: a failure while "ready", or a success while "not ready".
            this._unsubs.push(
                db.onPoolHealthCheck(({ ok }) => {
                    if (!this._last || this._last.ready !== ok) this._requestEvaluate();
                }),
            );
        }
        if (db.onPoolHealthChange) {
            this._unsubs.push(db.onPoolHealthChange(() => this._requestEvaluate()));
        }
        this._heartbeat = setInterval(() => this._broadcast("heartbeat", { t: Date.now() }), HEALTH_STREAM_HEARTBEAT_MS);
        this._heartbeat.unref?.();
        this._evalTimer = setInterval(() => this._requestEvaluate(), HEALTH_STREAM_EVAL_MS);
        this._evalTimer.unref?.();
    }

    _stop() {
        db.setPoolHealthWatched?.(false);
        for (const u of this._unsubs.splice(0)) {
            try {
                u();
            } catch {
                // listener already gone
            }
        }
        clearInterval(this._heartbeat);
        clearInterval(this._evalTimer);
        this._heartbeat = this._evalTimer = null;
        // Nobody was watching, so the last verdict may be stale by the next open.
        this._last = null;
    }

    /** Coalesces evaluation requests: at most one running, at most one queued. */
    _requestEvaluate() {
        if (this._clients.size === 0) return;
        // Draining: pools are about to close, and a "database down" push would
        // mislabel a restart. The registry's `shutdown` event tells the truth.
        if (InFlightTaskRegistry.isShuttingDown()) return;
        if (this._evaluating) {
            this._pending = true;
            return;
        }
        this._evaluating = true;
        ReadinessService.evaluate()
            .then(({ ready }) => this._publish({ ready, cause: ready ? null : "database" }))
            .catch((err) => logger.warning(`Health stream evaluation failed: ${err.message}`))
            .finally(() => {
                this._evaluating = false;
                if (this._pending) {
                    this._pending = false;
                    this._requestEvaluate();
                }
            });
    }

    /**
     * Broadcasts `status` when the verdict differs from the last one sent.
     * @param {{ ready: boolean, cause: "database"|null }} verdict
     */
    _publish(verdict) {
        const changed = !this._last || this._last.ready !== verdict.ready || this._last.cause !== verdict.cause;
        this._last = verdict;
        if (changed) this._broadcast("status", verdict);
    }

    /** @param {string} event @param {object} data */
    _broadcast(event, data) {
        for (const res of [...this._clients.keys()]) this._send(res, event, data);
    }

    /** @param {import('express').Response} res @param {string} event @param {object} data */
    _send(res, event, data) {
        this._write(res, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    /** Writes and flushes; a dead socket is torn down, never thrown. */
    _write(res, chunk) {
        try {
            res.write(chunk);
            if (typeof res.flush === "function") res.flush();
        } catch {
            this._clients.get(res)?.teardown();
        }
    }

    /** Test-only: drops every client and stops the loop. */
    _resetForTests() {
        for (const meta of [...this._clients.values()]) meta.teardown();
        this._clients.clear();
        this._perIp.clear();
        this._last = null;
        this._stop();
    }
}

module.exports = new HealthStreamHub();
module.exports.HealthStreamHub = HealthStreamHub;
module.exports.HEALTH_STREAM_HEARTBEAT_MS = HEALTH_STREAM_HEARTBEAT_MS;
module.exports.HEALTH_STREAM_RETRY_MS = HEALTH_STREAM_RETRY_MS;
module.exports.HEALTH_STREAM_MAX_PER_IP = HEALTH_STREAM_MAX_PER_IP;
