"use strict";

/**
 * @fileoverview Counts the HTTP requests a server is still answering, so a
 * graceful shutdown can let them finish instead of resetting their sockets.
 *
 * Attached as a SERVER-level `request` listener (after the Express app, which
 * is the first listener), so the 13-step middleware chain in `src/app.js` is
 * untouched. Server-Sent-Event responses are tracked but never counted as
 * "in flight": a stream has no natural end and is closed by
 * `SseConnectionRegistry.endAll()` at the start of shutdown instead.
 *
 * Once shutdown begins, every still-open response gets `Connection: close`
 * (when its headers are not yet sent), so a keep-alive socket is not reused
 * for a NEW request during the grace window — only work already in progress
 * is allowed to finish.
 *
 * @author senior-nodejs-engineer
 */

/**
 * Masks numeric path segments (record ids, numeric usernames) when no route
 * template is known, e.g. a request cut before Express matched a route.
 * @param {string} p
 * @returns {string}
 */
const maskIds = (p) => p.replace(/\/\d{2,}(?=\/|$)/g, "/:n");

class HttpInFlightTracker {
    /** @type {Set<import('http').ServerResponse>} */
    #active = new Set();
    /** @type {WeakMap<import('http').ServerResponse, {req: import('http').IncomingMessage, method: string, path: string, startedAt: number}>} */
    #meta = new WeakMap();
    #shuttingDown = false;
    /** @type {null | (() => void)} */
    #onSettle = null;
    /** @type {(req: import('http').IncomingMessage) => ({idleMs: (now?: number) => number}|undefined)} */
    #scopeOf;

    /**
     * @param {object} [options]
     * @param {(req: import('http').IncomingMessage) => ({idleMs: (now?: number) => number}|undefined)} [options.scopeOf]
     *   Resolves a request's progress scope; default `RequestWatchdog.scopeOf` (lazy-required).
     */
    constructor({ scopeOf } = {}) {
        this.#scopeOf =
            scopeOf ??
            ((req) => {
                try {
                    return require("../progress/RequestWatchdog").RequestWatchdog.scopeOf(req);
                } catch {
                    return undefined;
                }
            });
    }

    /**
     * Starts tracking every request `server` receives.
     *
     * @param {import('http').Server} server
     * @returns {HttpInFlightTracker} this, for `new HttpInFlightTracker().attach(server)`
     */
    attach(server) {
        server.on("request", (req, res) => this._track(req, res));
        return this;
    }

    /**
     * @param {import('http').IncomingMessage} req
     * @param {import('http').ServerResponse} res
     * @returns {void}
     */
    _track(req, res) {
        this.#active.add(res);
        this.#meta.set(res, {
            req,
            method: req.method || "GET",
            // Path only — the query string can carry identifiers.
            path: String(req.url || "/").split("?")[0],
            startedAt: Date.now(),
        });
        if (this.#shuttingDown) this.#markClose(res);

        let settled = false;
        const settle = () => {
            if (settled) return;
            settled = true;
            this.#active.delete(res);
            if (this.#onSettle) {
                try {
                    this.#onSettle();
                } catch {
                    /* a settle hook must never break response teardown */
                }
            }
        };
        res.once("finish", settle);
        res.once("close", settle);
    }

    /**
     * Enters shutdown mode: marks every open response `Connection: close` and
     * calls `onSettle` each time a tracked response finishes or closes.
     * Idempotent.
     *
     * @param {() => void} [onSettle]
     * @returns {void}
     */
    beginShutdown(onSettle) {
        this.#shuttingDown = true;
        if (onSettle) this.#onSettle = onSettle;
        for (const res of this.#active) this.#markClose(res);
    }

    /**
     * Number of non-SSE responses still being written. O(n) — only called
     * during shutdown.
     *
     * @returns {number}
     */
    activeCount() {
        let n = 0;
        for (const res of this.#active) if (!HttpInFlightTracker.#isSse(res)) n += 1;
        return n;
    }

    /**
     * The non-SSE requests still running, oldest first, for the shutdown log
     * and alert email. The path is the matched route TEMPLATE
     * (`/api/v1/users/:id`), never the raw URL, so no identifier
     * reaches an email; before routing, numeric segments are masked.
     *
     * @param {number} [limit=20]
     * @returns {Array<{method: string, path: string, ageMs: number, idleMs: number|null}>}
     *   `idleMs` = time since the request last made progress (null when no watchdog scope).
     */
    activeSummary(limit = 20) {
        const now = Date.now();
        const list = [];
        for (const res of this.#active) {
            if (HttpInFlightTracker.#isSse(res)) continue;
            const m = this.#meta.get(res);
            if (!m) continue;
            const template = m.req.route?.path;
            const path = typeof template === "string" ? `${m.req.baseUrl ?? ""}${template}` : maskIds(m.path);
            let idleMs = null;
            try {
                const scope = this.#scopeOf(m.req);
                if (scope) idleMs = scope.idleMs(now);
            } catch {
                idleMs = null;
            }
            list.push({ method: m.method, path, ageMs: now - m.startedAt, idleMs });
        }
        list.sort((a, b) => b.ageMs - a.ageMs);
        return list.slice(0, limit);
    }

    /** @param {import('http').ServerResponse} res */
    #markClose(res) {
        if (res.headersSent) return;
        try {
            res.setHeader("Connection", "close");
        } catch {
            /* headers raced to sent — nothing to do */
        }
    }

    /** @param {import('http').ServerResponse} res */
    static #isSse(res) {
        const type = res.getHeader?.("content-type");
        return typeof type === "string" && type.startsWith("text/event-stream");
    }
}

module.exports = HttpInFlightTracker;
