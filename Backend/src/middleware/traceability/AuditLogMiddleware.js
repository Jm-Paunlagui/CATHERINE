"use strict";

const AuditLogService = require("../../services/AuditLogService");
const { resolveRouteLabel } = require("../../utils/routeLabel");
const os = require("os");

// Resolve server IP once at startup
const _serverIp = (() => {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        for (const iface of ifaces[name]) {
            if (iface.family === "IPv4" && !iface.internal)
                return iface.address;
        }
    }
    return "127.0.0.1";
})();

class AuditLogMiddleware {
    constructor(options = {}) {
        this._enabled =
            options.enabled ?? process.env.AUDIT_LOG_ENABLED !== "false";
        this._excludeHealth =
            options.excludeHealth ??
            process.env.AUDIT_LOG_EXCLUDE_HEALTH !== "false";
        this._excludedPaths =
            options.excludedPaths ??
            (process.env.AUDIT_LOG_EXCLUDE_PATHS
                ? process.env.AUDIT_LOG_EXCLUDE_PATHS.split(",").map((p) =>
                      p.trim(),
                  )
                : ["/api/v1/audit-logs"]);
        this.handle = this.handle.bind(this);
    }

    handle(req, res, next) {
        if (!this._enabled) return next();
        if (this._excludeHealth && req.path === "/health") return next();
        if (this._excludedPaths.some((p) => req.path.startsWith(p)))
            return next();

        // OPTIONS (CORS preflight) requests are browser plumbing, not business
        // traffic. They are answered before routing, so req.route is never set
        // and the endpoint resolves to "UNMATCHED" — polluting the audit log
        // with imprecise rows. RED metrics already exclude them via
        // shouldRecordRouteMetrics(); audit logs must do the same.
        if (req.method === "OPTIONS") return next();

        const startTime = Date.now();
        const originalEnd = res.end.bind(res);

        res.end = (...args) => {
            const result = originalEnd(...args);
            const duration = Date.now() - startTime;
            const record = AuditLogMiddleware._buildRecord(req, res, duration);
            setImmediate(() => AuditLogService.insertAsync(record));
            return result;
        };

        next();
    }

    static _buildRecord(req, res, duration) {
        const statusCode = res.statusCode || 200;
        const statusCategory = Math.floor(statusCode / 100) + "xx";

        // Use the same canonical route label that RED metrics use (resolveRouteLabel)
        // so the ENDPOINT column stores parameterized patterns like
        // "/api/v1/records/:gid/:cardNumber/history" instead of concrete
        // paths with raw param values. This:
        //   1. Keeps audit log endpoints consistent with the RED Metrics table
        //   2. Prevents PII/ID leakage into the audit table (CWE-200)
        //   3. Makes endpoint-based grouping and search meaningful
        // The label format is "METHOD /path" — strip the method prefix since METHOD
        // is already stored in its own column.
        const routeLabel = resolveRouteLabel(req);
        const spaceIdx = routeLabel.indexOf(" ");
        const endpoint =
            spaceIdx !== -1 ? routeLabel.slice(spaceIdx + 1) : req.path;

        // USER_ID is a NUMBER column, but JWT claims are not guaranteed numeric
        // (a `userId` claim is commonly a string). insertMany batches type each
        // column from the FIRST non-null sample — mixed number/string values in
        // one flush batch trip NJS-011 and lose the whole batch. Normalize to a
        // numeric value or null before the record ever reaches the buffer.
        const rawUserId =
            req.user?.id ?? req.user?.GID ?? req.user?.userId ?? null;
        const userId =
            rawUserId != null && /^\d+$/.test(String(rawUserId).trim())
                ? Number(String(rawUserId).trim())
                : null;

        return {
            REQUEST_ID: req.id ?? null,
            USER_ID: userId,
            USERNAME: req.user?.username ?? req.user?.firstName ?? null,
            METHOD: req.method,
            ENDPOINT: endpoint,
            PARAMS: AuditLogMiddleware._sanitizeParams(req.query),
            STATUS_CODE: statusCode,
            STATUS_CATEGORY: statusCategory,
            RESPONSE_TIME_MS: duration,
            CLIENT_IP: req.ip ?? null,
            SERVER_IP: _serverIp,
            CREATED_AT: new Date(),
        };
    }

    static _sanitizeParams(query) {
        if (!query || typeof query !== "object") return null;
        const SENSITIVE = new Set([
            "token",
            "password",
            "key",
            "secret",
            "auth",
            "apikey",
            "api_key",
            "access_token",
        ]);
        const filtered = {};
        for (const [k, v] of Object.entries(query)) {
            if (!SENSITIVE.has(k.toLowerCase())) filtered[k] = v;
        }
        if (Object.keys(filtered).length === 0) return null;
        const str = JSON.stringify(filtered);
        return str.length > 2000 ? str.slice(0, 1997) + "..." : str;
    }
}

const defaultAuditLog = new AuditLogMiddleware();
module.exports = { AuditLogMiddleware, defaultAuditLog };
