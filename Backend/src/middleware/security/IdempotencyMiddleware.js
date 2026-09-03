"use strict";

/**
 * @fileoverview `IdempotencyMiddleware` — replay protection for money-moving
 * writes. (Plan §3.5. NET-NEW — no reference-system equivalent.)
 *
 * ============================================================================
 * THE GAP THIS CLOSES
 * ============================================================================
 * A duplicated money-moving request is not recoverable after the fact: two
 * identical "credit ₱500" calls that both succeed have posted ₱1000, and there
 * is nothing in the amounts to tell you the second was a mistake. Retries,
 * double-clicks, proxy replays, and at-least-once delivery all produce this.
 *
 * The fix is a client-supplied `Idempotency-Key` on every money-moving POST /
 * PUT / PATCH. The FIRST request with a given key runs and its response is
 * stored; any REPLAY of the same key returns that stored response WITHOUT
 * re-running the handler. The same key with a DIFFERENT body is a 409 — a
 * client reusing a key for a new operation is a bug we must surface, not hide.
 *
 * ============================================================================
 * HOW THE KEY IS SCOPED (why not just the header alone)
 * ============================================================================
 * The stored identity is `key + method + route + caller + body-hash`, so:
 *   - two different callers cannot collide on the same key,
 *   - the same key on a different route is a different operation,
 *   - replaying the same key+route+caller with the SAME body → stored response,
 *   - the same key+route+caller with a DIFFERENT body → 409 (misuse).
 * The body hash is a SHA-256 of the canonical JSON body; it never stores the
 * body itself.
 *
 * ============================================================================
 * BACKING STORE + TTL
 * ============================================================================
 * A dedicated `CacheStore` (via the shared `CacheRegistry`) with its own TTL —
 * long enough to absorb a realistic retry window, short enough not to hoard
 * responses forever. Default 24h; override per instance.
 *
 * ============================================================================
 * WHERE IT MOUNTS
 * ============================================================================
 * This is a ROUTE-LEVEL middleware, not a global one — only money-moving routes
 * need it, and the template ships no such route yet. Mount it AFTER the rate
 * limiter and BEFORE the route handler on each money route:
 *
 *   router.post("/credit", idempotency.handle, creditController);
 *
 * It only engages on POST / PUT / PATCH; GET / DELETE / HEAD pass straight
 * through.
 */

const crypto = require("crypto");
const { registry } = require("../cache/CacheRegistry");
const { AppError } = require("../../constants/errors");
const { logger } = require("../../utils/logger");

/** Methods that move state and therefore require idempotency. */
const GUARDED_METHODS = new Set(["POST", "PUT", "PATCH"]);

/** Default retention for a stored outcome — 24h in seconds. */
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

/** Header the client sends. Case-insensitive per HTTP; Express lower-cases. */
const HEADER = "idempotency-key";

class IdempotencyMiddleware {
    /**
     * @param {Object} [options]
     * @param {string} [options.storeName="idempotency"] - CacheRegistry store name.
     * @param {number} [options.ttl=86400] - Stored-outcome TTL in seconds.
     * @param {boolean} [options.required=true] - When true, a guarded request
     *   MISSING the header is rejected with 400. When false, a missing header
     *   simply skips idempotency (opt-in per route).
     * @param {(req: import('express').Request) => string} [options.callerOf] -
     *   Extracts a stable caller identity. Defaults to the authenticated user id
     *   when present, else the client IP.
     */
    constructor(options = {}) {
        this._storeName = options.storeName ?? "idempotency";
        this._ttl = options.ttl ?? DEFAULT_TTL_SECONDS;
        this._required = options.required ?? true;
        this._callerOf = options.callerOf ?? IdempotencyMiddleware._defaultCaller;

        // Register the backing store once. If another instance already did,
        // reuse it rather than throwing on the duplicate-name guard.
        this._store = registry.has(this._storeName)
            ? registry.resolve(this._storeName)
            : registry.register(this._storeName, { ttl: this._ttl });

        this.handle = this.handle.bind(this);
    }

    /**
     * Default caller identity: authenticated user id, else client IP.
     * @param {import('express').Request} req
     * @returns {string}
     * @private
     */
    static _defaultCaller(req) {
        return String(req.user?.id ?? req.user?.userId ?? req.ip ?? "anonymous");
    }

    /**
     * Canonical SHA-256 of the request body. Key order is normalised so that
     * `{a:1,b:2}` and `{b:2,a:1}` hash identically — a reordered-but-equal body
     * is the same operation, not a conflict.
     * @param {*} body
     * @returns {string}
     * @private
     */
    static _bodyHash(body) {
        const canonical = IdempotencyMiddleware._canonicalise(body);
        return crypto.createHash("sha256").update(canonical).digest("hex");
    }

    /**
     * Stable JSON stringification with sorted keys at every level.
     * @param {*} value
     * @returns {string}
     * @private
     */
    static _canonicalise(value) {
        if (value === null || typeof value !== "object") {
            return JSON.stringify(value ?? null);
        }
        if (Array.isArray(value)) {
            return `[${value.map((v) => IdempotencyMiddleware._canonicalise(v)).join(",")}]`;
        }
        const keys = Object.keys(value).sort();
        const parts = keys.map(
            (k) => `${JSON.stringify(k)}:${IdempotencyMiddleware._canonicalise(value[k])}`,
        );
        return `{${parts.join(",")}}`;
    }

    /**
     * Builds the composite storage key from the request identity.
     * @param {import('express').Request} req
     * @param {string} idemKey
     * @returns {string}
     * @private
     */
    _storageKey(req, idemKey) {
        const caller = this._callerOf(req);
        const route = req.baseUrl + (req.route?.path ?? req.path);
        return `${idemKey}\u0000${req.method}\u0000${route}\u0000${caller}`;
    }

    /**
     * Express middleware.
     * @param {import('express').Request} req
     * @param {import('express').Response} res
     * @param {import('express').NextFunction} next
     */
    handle(req, res, next) {
        if (!GUARDED_METHODS.has(req.method)) return next();

        const idemKey = req.get(HEADER);
        if (!idemKey) {
            if (!this._required) return next();
            return next(
                new AppError(
                    "This request requires an Idempotency-Key header.",
                    400,
                    {
                        type: "ValidationError",
                        hint: "Send a unique Idempotency-Key header (e.g. a UUID) on money-moving writes so retries do not double-post.",
                    },
                ),
            );
        }

        const bodyHash = IdempotencyMiddleware._bodyHash(req.body);
        const storageKey = this._storageKey(req, idemKey);
        const existing = this._store.get(storageKey);

        if (existing) {
            // Same key seen before. If the body differs, the client reused a key
            // for a different operation — a bug we must not silently satisfy.
            if (existing.bodyHash !== bodyHash) {
                logger.warning("[Idempotency] key reused with a different body", {
                    idemKey,
                    route: req.originalUrl,
                });
                return next(
                    new AppError(
                        "This Idempotency-Key was already used for a different request body.",
                        409,
                        {
                            type: "ConflictError",
                            hint: "Use a fresh Idempotency-Key for a new operation; reuse a key only to retry the identical request.",
                        },
                    ),
                );
            }

            // Genuine replay — return the stored outcome verbatim.
            res.setHeader("Idempotent-Replay", "true");
            res.status(existing.status);
            for (const [h, v] of Object.entries(existing.headers || {})) {
                res.setHeader(h, v);
            }
            return res.json(existing.body);
        }

        // First time for this key. Capture the response so a later replay can be
        // served from the store. Wrap res.json to record status + body once.
        const store = this._store;
        const ttl = this._ttl;
        const originalJson = res.json.bind(res);
        res.json = (body) => {
            // Only persist successful outcomes (2xx). A failure is not a settled
            // outcome — the client should be free to retry it with the same key.
            if (res.statusCode >= 200 && res.statusCode < 300) {
                try {
                    store.set(
                        storageKey,
                        { status: res.statusCode, body, bodyHash, headers: {} },
                        ttl,
                    );
                } catch (err) {
                    logger.warning("[Idempotency] failed to store outcome", {
                        message: err.message,
                    });
                }
            }
            return originalJson(body);
        };

        return next();
    }
}

module.exports = {
    IdempotencyMiddleware,
    GUARDED_METHODS,
    DEFAULT_TTL_SECONDS,
    HEADER,
};
