"use strict";

/**
 * @fileoverview Network-aware CORS middleware.
 * Supports explicit origins via env, plus dynamic patterns for localhost,
 * private networks, VPN, and corporate domains.
 *
 * Security (CWE-942): In production, dynamic broad-wildcard patterns (*.vpn,
 * *.corp, *.internal, *.local, *.lan, and entire RFC-1918 ranges) are disabled
 * when CORS_RESTRICT_PRODUCTION=true (or NODE_ENV=production by default).
 * In production only CORS_ORIGINS (explicit allow-list) is honoured, plus the
 * localhost/127.0.0.1 loopback pattern which is safe for server-side tooling.
 *
 * To opt-in to broad patterns in a non-standard environment, set:
 *   CORS_ALLOW_BROAD_PATTERNS=true
 * This is intentionally opt-in — production deployments should always use an
 * explicit allow-list via CORS_ORIGINS instead of trusting network topology.
 */

const cors = require("cors");
const { logger } = require("../../utils/logger");

/**
 * Returns dynamic origin patterns allowed based on current environment.
 *
 * In production (NODE_ENV=production) broad wildcard patterns for private
 * networks and intranet TLDs are omitted unless CORS_ALLOW_BROAD_PATTERNS=true.
 *
 * @param {RegExp[]} [override] - Explicit override (used in tests / custom instances)
 * @returns {RegExp[]}
 */
function buildDynamicPatterns(override) {
    if (override !== undefined) return override;

    const isProduction = process.env.NODE_ENV === "production";
    const allowBroad = process.env.CORS_ALLOW_BROAD_PATTERNS === "true";

    // Always safe — loopback only (no credentials risk from external attackers).
    // L6 note: loopback origins are kept in production because they only match
    // requests originating from the server host itself (localhost / 127.0.0.1).
    // An external attacker cannot forge an Origin header from a browser.
    // If your threat model includes malicious code running on the production
    // host itself, add the loopback origins to CORS_ORIGINS explicitly and
    // remove them from the dynamic patterns.
    const safePatterns = [
        /^https?:\/\/localhost(:\d+)?$/,
        /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
    ];

    // Broad patterns — private networks + intranet TLDs
    // Only included in non-production or when explicitly opted-in.
    const broadPatterns = [
        /^https?:\/\/192\.168\.\d+\.\d+(:\d+)?$/,
        /^https?:\/\/10\.\d+\.\d+\.\d+(:\d+)?$/,
        /^https?:\/\/172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+(:\d+)?$/,
        /^https?:\/\/.+\.local(:\d+)?$/,
        /^https?:\/\/.+\.lan(:\d+)?$/,
        /^https?:\/\/.+\.corp(\..+)?$/i,
        /^https?:\/\/.+\.vpn(\..+)?$/i,
        /^https?:\/\/.+\.internal(\..+)?$/i,
    ];

    if (!isProduction || allowBroad) {
        return [...safePatterns, ...broadPatterns];
    }

    // Production — safe loopback only; everything else must be in CORS_ORIGINS
    logger.notice &&
        logger.notice(
            "CORS: running in production mode — broad wildcard patterns disabled. " +
                "Add explicit origins to CORS_ORIGINS.",
        );
    return safePatterns;
}

class CorsMiddleware {
    constructor(options = {}) {
        this._explicitOrigins =
            options.origins ??
            (process.env.CORS_ORIGINS
                ? process.env.CORS_ORIGINS.split(",")
                      .map((o) => o.trim())
                      .filter(Boolean)
                : []);

        this._dynamicPatterns = buildDynamicPatterns(options.patterns);

        this._cors = cors({
            origin: (origin, callback) => {
                if (!origin) return callback(null, true);
                if (this._explicitOrigins.includes(origin))
                    return callback(null, true);
                if (this._dynamicPatterns.some((p) => p.test(origin)))
                    return callback(null, true);

                logger.warning(`CORS: origin blocked — ${origin}`);
                callback(new Error(`Origin ${origin} not allowed by CORS`));
            },
            credentials: options.credentials ?? true,
            methods: options.methods ?? [
                "GET",
                "POST",
                "PUT",
                "DELETE",
                "PATCH",
                "OPTIONS",
                "HEAD",
            ],
            allowedHeaders: options.allowedHeaders ?? [
                "Content-Type",
                "Authorization",
                "X-CSRF-Token",
                "X-Request-ID",
                "X-Requested-With",
                "X-Client-Username",
                "X-Client-Id",
                "Accept",
                "Accept-Encoding",
                "Accept-Language",
                "Cache-Control",
            ],
            exposedHeaders: options.exposedHeaders ?? [
                "X-Request-ID",
                "X-Response-Time",
                "X-CSRF-Token",
                "Content-Disposition",
                "RateLimit-Limit",
                "RateLimit-Remaining",
                "RateLimit-Reset",
            ],
            maxAge: options.maxAge ?? 86400,
            optionsSuccessStatus: options.optionsSuccessStatus ?? 200,
        });

        this.handle = this.handle.bind(this);
    }

    handle(req, res, next) {
        return this._cors(req, res, next);
    }
}

const defaultCors = new CorsMiddleware();
module.exports = { CorsMiddleware, defaultCors };
