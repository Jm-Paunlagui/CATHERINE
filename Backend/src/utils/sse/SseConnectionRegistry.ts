"use strict";

/**
 * @fileoverview Process-level registry of every live SSE `res` across ALL SSE
 * surfaces (Integrity, Audit, System-log tail, health stream, and every
 * `ScopedSsePoller`-backed stream). Its ONE job is to give `gracefulShutdown` a single,
 * mechanism-agnostic control point: on shutdown it can broadcast a final
 * `event: shutdown` frame to every open stream and end the sockets, so a
 * normal business-hours restart with SSE clients connected reaches
 * `process.exit(0)` instead of hanging until the forced-exit failsafe fires and a
 * clean stop reads as a hang (defect B1).
 *
 * DELIBERATELY DEPENDENCY-STARVED: it imports ONLY the logger and its own
 * message template — no models, services, db, or controllers. Every SSE
 * surface requires it, so pulling anything heavier in here would invite a
 * require cycle. It stores raw Express `res` objects and knows nothing about
 * scopes, cursors, or pollers; each surface unregisters its own `res` on the
 * normal `req.on("close")` / disconnect path, so the set never leaks.
 *
 * @author senior-nodejs-engineer
 */

const { logger } = require("../logger");
const { sseMessages } = require("../../constants/messages");

class SseConnectionRegistry {
    /**
     * Live streams, each mapped to the surface's own teardown callback (or
     * `null` where the surface has none).
     *
     * @type {Map<import('express').Response, (() => void)|null>}
     */
    #connections = new Map();

    /**
     * Register a live SSE response.
     *
     * @param {import('express').Response} res - The flushed SSE response.
     * @param {(() => void)|null} [onShutdown=null] - The surface's own
     *   per-connection teardown, invoked by {@link endAll} after the socket is
     *   ended. Supply this when ending the socket alone does NOT release the
     *   surface's own resources — `ScopedSsePoller`, for instance, keeps the
     *   `res` in its scope map and keeps its shared `setInterval` running
     *   until its disconnect closure runs, so without this the poller goes on
     *   ticking and querying against a closing Oracle pool until
     *   `process.exit`.
     * @returns {() => void} An idempotent unregister function the caller MUST
     *   invoke on disconnect (wire it into `req.on("close")` / the poller's
     *   disconnect closure).
     */
    register(res, onShutdown = null) {
        this.#connections.set(res, onShutdown);
        return () => this.unregister(res);
    }

    /**
     * Remove a response from the registry. Safe to call more than once.
     *
     * @param {import('express').Response} res - The response to drop.
     * @returns {void}
     */
    unregister(res) {
        this.#connections.delete(res);
    }

    /**
     * @returns {number} The number of currently registered live streams.
     */
    size() {
        return this.#connections.size;
    }

    /**
     * Ends every registered stream whose request was authenticated with one of
     * the given session families (`req.user.fid`), so a session that was signed
     * out (or whose password changed) stops receiving live data at once.
     * Sends a terminal `session-ended` event first; the browser's
     * EventSource then reconnects once, is refused 440, and stops (it never
     * retries after a non-200). SYNCHRONOUS and NEVER throws.
     *
     * @param {Iterable<string>} familyIds
     * @returns {number} streams ended
     */
    endFamilies(familyIds) {
        const fids = new Set(familyIds);
        if (fids.size === 0 || this.#connections.size === 0) return 0;
        const hits = [...this.#connections.entries()].filter(([res]) => fids.has(res?.req?.user?.fid));
        for (const [res, onShutdown] of hits) {
            this.#connections.delete(res);
            SseConnectionRegistry.#endOne(res, onShutdown, "session-ended", "session_ended");
        }
        if (hits.length > 0) logger.notice(sseMessages.SSE_SESSION_ENDED(hits.length));
        return hits.length;
    }

    /** Writes one terminal event, ends the socket, then runs the surface's teardown. Never throws. */
    static #endOne(res, onShutdown, event, reason) {
        try {
            res.write(`event: ${event}\n`);
            res.write(`data: ${JSON.stringify({ reason })}\n\n`);
            if (typeof res.flush === "function") res.flush();
            res.end();
        } catch {
            // Socket already dead / mid-teardown - nothing to do.
        }
        try {
            if (typeof onShutdown === "function") onShutdown();
        } catch {
            // A teardown failure must never escape.
        }
    }

    /**
     * Best-effort broadcast of a terminal `shutdown` event to every registered
     * stream, then end each socket and clear the registry. SYNCHRONOUS and
     * NEVER throws — a single wedged socket must not stop the shutdown of the
     * rest, so every write/end is individually guarded. Called once by
     * `gracefulShutdown` BEFORE `server.close(...)`.
     *
     * @param {string} [reason="server_shutdown"] - Reason string echoed to
     *   clients in the event payload so the UI can distinguish a planned
     *   restart from an unexpected drop.
     * @returns {void}
     */
    endAll(reason = "server_shutdown") {
        const count = this.#connections.size;

        // Snapshot and clear BEFORE running any teardown: a surface's own
        // cleanup calls back into `unregister()`, which would otherwise mutate
        // the map mid-iteration.
        const entries = [...this.#connections.entries()];
        this.#connections.clear();

        for (const [res, onShutdown] of entries) {
            try {
                res.write("event: shutdown\n");
                res.write(`data: ${JSON.stringify({ reason })}\n\n`);
                if (typeof res.flush === "function") res.flush();
                res.end();
            } catch {
                // Socket already dead / mid-teardown — nothing to do, keep going.
            }

            // Then release the surface's own per-connection state. Ending the
            // socket is NOT sufficient for every surface: a `ScopedSsePoller`
            // stream stays in its scope map, and the poller's shared interval
            // keeps firing DB reads against a closing pool, until this runs.
            // Individually guarded for the same reason the write is — one
            // wedged surface must not stop the rest of the shutdown.
            try {
                if (typeof onShutdown === "function") onShutdown();
            } catch {
                // Never let a teardown failure escape: this is called from
                // gracefulShutdown and must remain non-throwing.
            }
        }

        logger.notice(sseMessages.SSE_SHUTDOWN_BROADCAST(count));
    }
}

module.exports = new SseConnectionRegistry();
