"use strict";

/**
 * @fileoverview Generic SCOPE-keyed SSE poller — a reusable registry of SSE
 * "scopes" that share ONE polling interval, so any number of live-update
 * streams can be built without each carrying its own copy of the scope
 * registry, shared-interval poller, per-scope error bulkhead, `_safeSend` /
 * `_broadcast`, and connect/disconnect lifecycle.
 *
 * WHAT THIS FILE DOES
 * --------------------
 * A registry of SSE "scopes" sharing ONE polling interval. A SCOPE is a
 * sharing unit, not a user: every connection watching the same scope key
 * shares ONE `readCursor()` call per tick. Ten admins on the same scope cost
 * exactly what one costs. A second distinct scope costs one more query per
 * tick; connection count within a scope costs nothing extra.
 *
 * BULKHEAD (Chaos & Resilience): each scope tracks its OWN consecutive error
 * count and is dropped independently at `maxPollErrors` — one scope's database
 * trouble never starves or evicts another scope's connections. Every scope's
 * `readCursor()` call is issued concurrently via `Promise.all`, so one slow
 * scope cannot delay the rest.
 *
 * CURSOR semantics:
 *   `undefined` = baseline not yet set (first poll tick pending).
 *   `null`      = no rows for this scope right now (gate closed / genuinely
 *                 empty) — NEVER counts as a change.
 *   `string`    = the composite change signature, compared each tick.
 * `readCursor` SHOULD return a COMPOSITE signature, never a bare MAX id — if a
 * ledger records a delete/void as an UPDATE to an existing row (MAX never
 * advances), a MAX-only cursor is structurally blind to it.
 *
 * CACHE PURGE ORDERING IS LOAD-BEARING: on a detected cursor change, `_pollScope`
 * calls `onChange(scope)` BEFORE broadcasting the `update` event. Emit first and
 * the client is told "changed", refetches, and is served the stale cached rows.
 *
 * HOW IT WORKS
 * ------------
 * `open(res, { key, meta })` is called by the feature controller AFTER it has
 * already authenticated the caller and validated/resolved whatever
 * scope-identifying params it needs (a bad id, for example, must still be
 * reportable as ordinary JSON — no longer possible once headers are flushed, so
 * that validation happens in the CALLER before `open()`).
 *
 * `meta` is opaque to this class beyond two uses: (1) it is passed back to
 * `readCursor(scope)` / `onChange(scope)` as `scope.meta`, and (2) it is spread
 * into the `connected` and `update` event payloads verbatim. Callers that need
 * additional per-scope state for `readCursor` which must NOT leak into the wire
 * payload keep that state in their OWN closure-captured side table, keyed by the
 * same `key`. This keeps the emitted event payload exactly under the caller's
 * control instead of this class guessing which fields are "public".
 *
 * EXAMPLE
 * -------
 *   const poller = new ScopedSsePoller({
 *     name: "live-feed",
 *     pollIntervalMs: 5000,
 *     maxPollErrors: 5,
 *     readCursor: (scope) => Model.getCursor(scope.meta.id),
 *     onChange: (scope) => registry.resolve("feed").delByPattern(`id=${scope.meta.id}:`),
 *     logger,
 *   });
 *   const close = poller.open(res, { key: "feed:5", meta: { id: 5 } });
 *   req.on("close", close);
 *
 * @param {{
 *   name: string,
 *   pollIntervalMs?: number,
 *   maxPollErrors?: number,
 *   readCursor: (scope: object) => Promise<string|null>,
 *   onChange?: (scope: object) => void,
 *   logger?: object,
 * }} opts
 */

const { sseMessages } = require("../../constants/messages");

/** Default poll cadence. */
const DEFAULT_POLL_INTERVAL_MS = 5_000;

/** Default consecutive-error bulkhead threshold. */
const DEFAULT_MAX_POLL_ERRORS = 5;

class ScopedSsePoller {
    /**
     * @param {{
     *   name: string,
     *   pollIntervalMs?: number,
     *   maxPollErrors?: number,
     *   readCursor: (scope: object) => Promise<string|null>,
     *   onChange?: (scope: object) => void,
     *   logger?: object,
     * }} opts
     */
    constructor(opts) {
        if (!opts || typeof opts.readCursor !== "function") {
            throw new TypeError(
                "ScopedSsePoller requires opts.readCursor(scope) => Promise<string|null>.",
            );
        }
        this.name = opts.name ?? "sse";
        this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
        this.maxPollErrors = opts.maxPollErrors ?? DEFAULT_MAX_POLL_ERRORS;
        this.readCursor = opts.readCursor;
        this.onChange = typeof opts.onChange === "function" ? opts.onChange : () => {};
        this.logger = opts.logger ?? null;

        /**
         * @type {Map<string, {
         *   key: string, meta: object, cursor: string|null|undefined,
         *   connections: Set<import('express').Response>,
         *   pollCount: number, pollErrors: number,
         * }>}
         */
        this._scopes = new Map();

        /** setInterval reference for the shared poller. null when idle. */
        this._pollInterval = null;

        // Bound once so `setInterval(this._tick, ...)` keeps `this`.
        this._tick = this._tick.bind(this);
    }

    /**
     * Registers `res` under `key`, creating the scope (cursor: undefined —
     * baseline not yet set) if this is the first connection to see it. Sends
     * SSE headers + the `connected` event, and starts the shared interval if
     * it is currently idle.
     *
     * @param {import('express').Response} res
     * @param {{ key: string, meta?: object }} params
     * @returns {() => void} Call on disconnect (wire to `req.on("close")`).
     */
    open(res, { key, meta = {} }) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();

        let scope = this._scopes.get(key);
        if (!scope) {
            scope = {
                key,
                meta,
                cursor: undefined,
                connections: new Set(),
                pollCount: 0,
                pollErrors: 0,
            };
            this._scopes.set(key, scope);
            this._log("info", sseMessages.SSE_SCOPE_OPENED(this.name, key));
        }
        scope.connections.add(res);
        this._log(
            "info",
            sseMessages.SSE_SCOPE_CONNECTED(this.name, key, scope.connections.size),
        );

        this._safeSend(res, "connected", {
            timestamp: new Date().toISOString(),
            pollIntervalMs: this.pollIntervalMs,
            maxPollErrors: this.maxPollErrors,
            ...scope.meta,
        });

        this._startSharedPoller();

        return () => {
            scope.connections.delete(res);
            if (scope.connections.size === 0) {
                this._scopes.delete(key);
                this._log("info", sseMessages.SSE_SCOPE_CLOSED(this.name, key));
            }
            this._stopSharedPoller();
        };
    }

    /**
     * Writes a named SSE event and immediately flushes the compression
     * buffer. Swallows write errors — a closed socket is cleaned up by the
     * `close()` returned from {@link open}, wired to `req.on("close")`.
     * @private
     */
    _safeSend(res, eventName, payload) {
        try {
            res.write(`event: ${eventName}\n`);
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
            if (typeof res.flush === "function") res.flush();
        } catch {
            // Socket already closed — close() will remove it from the scope.
        }
    }

    /** @private */
    _broadcast(scope, eventName, payload) {
        for (const res of scope.connections) this._safeSend(res, eventName, payload);
    }

    /** @private */
    _log(level, message) {
        if (this.logger && typeof this.logger[level] === "function") {
            this.logger[level](message);
        }
    }

    /**
     * Polls ONE scope — one `readCursor()` call regardless of how many
     * connections share it. Isolated try/catch (bulkhead): this scope's
     * failure is tracked and, past `maxPollErrors`, drops only this scope.
     * @private
     * @param {string} key
     * @param {object} scope
     * @returns {Promise<void>}
     */
    async _pollScope(key, scope) {
        const ts = new Date().toISOString();
        try {
            const newCursor = await this.readCursor(scope);
            scope.pollErrors = 0;
            scope.pollCount++;

            if (scope.cursor === undefined) {
                // First tick for this scope — lock in the baseline so the
                // first real change after connect is detected, not mistaken
                // for the initial state.
                scope.cursor = newCursor;
                this._broadcast(scope, "heartbeat", {
                    timestamp: ts,
                    pollCount: scope.pollCount,
                });
                return;
            }

            // null (gate closed / no rows) never counts as a change.
            const changed = newCursor !== null && newCursor !== scope.cursor;

            if (changed) {
                scope.cursor = newCursor;

                // Purge BEFORE notifying — see file header.
                this.onChange(scope);

                this._broadcast(scope, "update", { ...scope.meta });
                this._log("info", sseMessages.SSE_UPDATE_SENT(this.name, key));
            } else {
                this._broadcast(scope, "heartbeat", {
                    timestamp: ts,
                    pollCount: scope.pollCount,
                });
            }
        } catch (err) {
            scope.pollErrors++;
            this._log(
                "error",
                sseMessages.SSE_POLL_ERROR(this.name, key, err.message ?? String(err)),
            );

            if (scope.pollErrors >= this.maxPollErrors) {
                this._log(
                    "warning",
                    sseMessages.SSE_SCOPE_MAX_ERRORS(
                        this.name,
                        key,
                        scope.connections.size,
                        this.maxPollErrors,
                    ),
                );
                this._broadcast(scope, "error", {
                    message: "Stream polling failed repeatedly. Please refresh your page.",
                    code: "POLL_FAILED",
                });
                this._scopes.delete(key);
            }
        }
    }

    /**
     * Shared poll tick — fires once per `pollIntervalMs` for ALL scopes.
     * Every scope's query runs concurrently (`Promise.all`) so one
     * slow/stuck scope cannot delay the rest.
     *
     * Time complexity per tick: O(scopes) readCursor calls, O(connections)
     * JS fan-out. Space complexity: O(scopes + connections).
     * @private
     * @returns {Promise<void>}
     */
    async _tick() {
        if (this._scopes.size === 0) return;
        await Promise.all(
            [...this._scopes.entries()].map(([key, scope]) => this._pollScope(key, scope)),
        );
    }

    /** Starts the shared poller. Idempotent — safe to call on every new connection. @private */
    _startSharedPoller() {
        if (this._pollInterval !== null) return;
        this._pollInterval = setInterval(this._tick, this.pollIntervalMs);
        this._log("notice", sseMessages.SSE_SHARED_POLL_STARTED(this.name));
    }

    /** Stops the shared poller once no scopes remain. @private */
    _stopSharedPoller() {
        if (this._scopes.size > 0 || this._pollInterval === null) return;
        clearInterval(this._pollInterval);
        this._pollInterval = null;
        this._log("notice", sseMessages.SSE_SHARED_POLL_STOPPED(this.name));
    }
}

module.exports = ScopedSsePoller;
