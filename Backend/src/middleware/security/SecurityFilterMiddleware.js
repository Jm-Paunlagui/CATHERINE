"use strict";

/**
 * @fileoverview Security filter middleware.
 * Blocks vulnerability scanning patterns, path traversal,
 * script injection, SQL injection, and suspicious HTTP methods.
 * Tracks suspicious IPs in-memory with auto-block after threshold.
 *
 * Two pattern lists:
 *   _maliciousPatterns   — checked against req.path only (file extensions,
 *                          known exploit paths, scanner fingerprints)
 *   _injectionPatterns   — checked against req.originalUrl (path + query string)
 *                          to catch XSS, SQLi, traversal, and command injection
 *                          payloads regardless of where they appear in the URL
 */

const { logger } = require("../../utils/logger");
const { getStatusTitle } = require("../../constants/responses");
const {
    middlewareMessages,
} = require("../../constants/messages/middleware.messages");

class SecurityFilterMiddleware {
    constructor(options = {}) {
        // ── Path-only patterns (checked against req.path) ─────────────────────
        // Known exploit paths, scanner fingerprints, dangerous file extensions.
        this._maliciousPatterns = options.maliciousPatterns ?? [
            /\/services$/,
            /\/bea_wls_internal\//,
            /\/weblogic\//,
            /\/redfish\//,
            /\/appliance\/avtrans/,
            /\/dana-na\/auth/,
            /\/Synchronization$/,
            /\/webui\/auth/,
            /\/rest\/api\/latest\/repos/,
            /\/o\/docs\//,
            /\/bin\/login\/XWiki/,
            /\/bin\/get\/Main\/SolrSearch/,
            /\/ws$/,
            /\/Apriso\//,
            /\/userRpm\//,
            /\/adv_index\.htm/,
            /\/hp\/device\//,
            /_layouts\/15\//,
            /\/core\/auth\/login\//,
            /\/cli\/ws/,
            /\/login\/login/,
            /\.asp$/i,
            /\.aspx$/i,
            /\.jsp$/i,
            /\.cgi$/i,
            /\.pl$/i,
            /\.php$/i,
            /\.cfm$/i,
            /\.class$/i,
            /\.jar$/i,
            /\.nsf$/i,
            /\.htm$/i,
            /\/TiVoConnect/,
            /\/NFuse\//,
            /\/CCMAdmin\//,
            /\/vncviewer\.jar/,
            /\/robots\.txt/,
            /\/level\/99\//,
            /\/hb1\//,
        ];

        // ── Injection patterns (checked against req.originalUrl = path + query) ─
        // XSS, SQL injection, path traversal, command injection.
        // These MUST scan the full URL because payloads commonly appear in
        // query parameters (?id=1' OR '1'='1), not just the path.
        this._injectionPatterns = options.injectionPatterns ?? [
            // Path traversal
            /\.\.[/\\]/,
            /\/\.\.\//,
            /\\\.\\\./,

            // XSS — script injection
            /<script[\s>]/i,
            /<\/script>/i,
            /<iframe[\s>]/i,
            /javascript:/i,
            /onerror\s*=/i,
            /onload\s*=/i,
            /onmouseover\s*=/i,
            /onfocus\s*=/i,
            /onblur\s*=/i,

            // SQL injection — classic patterns
            /'\s*OR\s+.*=/i,
            /'\s*OR\s+'\d+'\s*=\s*'\d+/i,
            /UNION\s+(ALL\s+)?SELECT/i,
            /;\s*DROP\s+/i,
            /;\s*DELETE\s+FROM/i,
            /;\s*INSERT\s+INTO/i,
            /;\s*UPDATE\s+.*SET/i,
            /'\s*;\s*--/,
            /'\s*--\s*$/,
            /\/\*.*\*\//,
            /EXEC(\s+|\()/i,
            /xp_cmdshell/i,

            // Command injection
            /;\s*(ls|cat|wget|curl|bash|sh|nc|ncat)\s/i,
            /\|\s*(ls|cat|wget|curl|bash|sh|nc|ncat)\s/i,
            /`[^`]*`/,
            /\$\([^)]*\)/,

            // LDAP injection
            /[)(|*\\]\s*\(/,
        ];

        // _methodWhitelistedPaths: these paths are exempt from the blocked-method check only.
        // Malicious pattern checking always runs regardless of path (H-05).
        this._methodWhitelistedPaths = options.methodWhitelistedPaths ?? [
            /^\/$/,
            /^\/health$/,
            /^\/api-docs/,
        ];

        this._blockedMethods =
            options.blockedMethods ??
            new Set(["TRACE", "TRACK", "PROPFIND", "SEARCH"]);

        this._suspiciousIPs = new Map();
        this._suspiciousThreshold = options.suspiciousThreshold ?? 10;
        this._blockDurationMs = options.blockDurationMs ?? 60 * 60 * 1000;

        // Cleanup stale entries every hour
        this._cleanupTimer = setInterval(
            () => {
                const cutoff = Date.now() - 24 * 60 * 60 * 1000;
                for (const [ip, r] of this._suspiciousIPs) {
                    if (r.lastSeen < cutoff) this._suspiciousIPs.delete(ip);
                }
            },
            60 * 60 * 1000,
        );
        if (this._cleanupTimer.unref) this._cleanupTimer.unref();

        this.handle = this.handle.bind(this);
    }

    handle(req, res, next) {
        const ip = req.ip || req.connection?.remoteAddress || "unknown";
        const reqPath = req.path;
        const method = req.method;
        // originalUrl includes the query string (e.g. /api/v1/users?id=1' OR '1'='1)
        // so injection patterns can catch payloads in query parameters.
        // L2: Decode twice to catch double-encoded payloads (%2527 → %27 → ').
        // Attackers use double-encoding to bypass single-decode WAFs.
        let fullUrl;
        try {
            const once = decodeURIComponent(req.originalUrl || reqPath);
            fullUrl = decodeURIComponent(once);
        } catch {
            // Malformed percent-encoding — use the single-decoded or raw value
            try {
                fullUrl = decodeURIComponent(req.originalUrl || reqPath);
            } catch {
                fullUrl = req.originalUrl || reqPath;
            }
        }

        // Always check if IP is currently blocked (applies to all paths).
        const record = this._suspiciousIPs.get(ip);
        if (record && record.blockedUntil > Date.now()) {
            logger.warning(
                middlewareMessages.IP_BLOCKED_SUSPICIOUS(ip, method, reqPath),
            );
            return res.status(403).json({
                status: "error",
                code: 403,
                title: getStatusTitle(403),
                message: "Forbidden",
                error: { type: "ForbiddenError" },
            });
        }

        // Blocked method check — skip only for health/root paths (not all /api/ paths).
        const isMethodWhitelisted = this._methodWhitelistedPaths.some((p) =>
            p.test(reqPath),
        );
        if (!isMethodWhitelisted && this._blockedMethods.has(method)) {
            this._trackSuspiciousIP(ip);
            logger.warning(
                middlewareMessages.HTTP_METHOD_BLOCKED(ip, method, reqPath),
            );
            return res.status(405).json({
                status: "error",
                code: 405,
                title: getStatusTitle(405),
                message: "Method Not Allowed",
                error: { type: "MethodNotAllowed" },
            });
        }

        // Path-only pattern check — scanner fingerprints, exploit paths, file extensions.
        if (this._maliciousPatterns.some((p) => p.test(reqPath))) {
            this._trackSuspiciousIP(ip);
            logger.warning(
                middlewareMessages.MALICIOUS_REQUEST_BLOCKED(
                    ip,
                    method,
                    reqPath,
                ),
            );
            return res.status(404).json({
                status: "error",
                code: 404,
                title: getStatusTitle(404),
                message: "Not Found",
                error: { type: "NotFound" },
            });
        }

        // Injection pattern check — scans the FULL URL (path + query string).
        // Catches XSS, SQLi, traversal, and command injection payloads
        // regardless of whether they appear in the path or query parameters.
        if (this._injectionPatterns.some((p) => p.test(fullUrl))) {
            this._trackSuspiciousIP(ip);
            logger.warning(
                middlewareMessages.MALICIOUS_REQUEST_BLOCKED(
                    ip,
                    method,
                    fullUrl,
                ),
            );
            return res.status(403).json({
                status: "error",
                code: 403,
                title: getStatusTitle(403),
                message: "Forbidden",
                error: { type: "ForbiddenError" },
            });
        }

        next();
    }

    getStats() {
        const now = Date.now();
        const blocked = [];
        const suspicious = [];

        for (const [ip, r] of this._suspiciousIPs) {
            if (r.blockedUntil > now) {
                blocked.push({
                    ip,
                    count: r.count,
                    blockedUntil: new Date(r.blockedUntil).toISOString(),
                });
            } else if (r.count > 0) {
                suspicious.push({
                    ip,
                    count: r.count,
                    lastSeen: new Date(r.lastSeen).toISOString(),
                });
            }
        }

        return {
            totalTracked: this._suspiciousIPs.size,
            blocked: blocked.length,
            suspicious: suspicious.length,
            blockedIPs: blocked,
            suspiciousIPs: suspicious,
        };
    }

    _trackSuspiciousIP(ip) {
        const now = Date.now();
        const record = this._suspiciousIPs.get(ip) || {
            count: 0,
            blockedUntil: 0,
            lastSeen: now,
        };

        if (record.blockedUntil > now) return true;

        record.count++;
        record.lastSeen = now;

        if (record.count >= this._suspiciousThreshold) {
            record.blockedUntil = now + this._blockDurationMs;
            logger.warning(
                middlewareMessages.SUSPICIOUS_IP_BLOCKED(
                    ip,
                    new Date(record.blockedUntil).toISOString(),
                ),
                {
                    requestCount: record.count,
                },
            );
        }

        this._suspiciousIPs.set(ip, record);
        return record.blockedUntil > now;
    }
}

const defaultSecurityFilter = new SecurityFilterMiddleware();
module.exports = { SecurityFilterMiddleware, defaultSecurityFilter };
