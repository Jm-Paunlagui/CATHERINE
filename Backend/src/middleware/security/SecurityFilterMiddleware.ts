// @ts-nocheck -- TS migration: delete this line when the file is typed (bun run typecheck).


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
 *
 * GET/HEAD body guard (defence-in-depth for CVE-2026-123864 — the zero-length
 * TLS write from `flushHeaders()` while the request body is still streaming):
 * a GET or HEAD carrying Transfer-Encoding (any value) or Content-Length > 0 is
 * refused 400 BodyNotAllowedError with `Connection: close`. It runs last (after
 * every strike-counting check), records NO strike, ignores the method
 * whitelist, and never reads the body. Switch: `SECURITY_FILTER_REJECT_GET_BODY`
 * (only the exact value "false" disables it) or the
 * `rejectBodyOnBodylessMethods` constructor option.
 */

import type { NextFunction, Request, Response } from "express";
import { logger } from "../../utils/logger";
import { getStatusTitle } from "../../constants/responses";
import { middlewareMessages } from "../../constants/messages/middleware.messages";
import { snowflake } from "../../utils/snowflake";
import { requestContext } from "../../utils/requestContext";
import { SuspiciousIpTracker } from "./SuspiciousIpTracker";
import { clusterRpc } from "../../utils/cluster/ClusterRpcClient";
import { isIp } from "../../utils/cluster/ipcSchemas";
import { CLUSTER_RPC_METHODS, CLUSTER_RPC_TIMEOUTS } from "../../constants/clusterIpc";
import { clusterMessages } from "../../constants/messages/cluster.messages";
import { REQUEST_ERRORS } from "../../constants/errors";

/** Methods that must never carry a request body (CVE-2026-123864 guard). Module-private. */
const BODYLESS_METHODS = Object.freeze(new Set(["GET", "HEAD"]));

/** Content-Length shape accepted as numeric: digits with optional surrounding whitespace. */
const CONTENT_LENGTH_RE = /^\s*\d+\s*$/;

/**
 * Whether request headers declare a body. Pure; reads two header keys only and
 * never touches the request stream.
 *
 * Returns `true` when `transfer-encoding` is present with ANY value (including
 * an empty string), or when `content-length` is all digits (whitespace allowed)
 * and `Number(value) > 0`. `Number`, not `parseInt`, so "5abc" is not 5. A
 * missing or nullish `headers` object means no body.
 *
 * Complexity: O(1) time and space.
 *
 * @param {Record<string, string | string[] | undefined> | null | undefined} headers
 * @returns {boolean}
 */
function hasDeclaredBody(headers: Record<string, string | string[] | undefined> | null | undefined): boolean {
    if (headers == null) return false;
    if (headers["transfer-encoding"] !== undefined) return true;
    const cl = headers["content-length"];
    return typeof cl === "string" && CONTENT_LENGTH_RE.test(cl) && Number(cl) > 0;
}

class SecurityFilterMiddleware {
    declare _suspiciousIPs: any;
    declare _tracker: SuspiciousIpTracker;
    declare _rejectBodyOnBodylessMethods: any;
    declare _blockedMethods: any;
    declare _methodWhitelistedPaths: any;
    declare _injectionPatterns: any;
    declare _maliciousPatterns: any;
    constructor(options: Record<string, any> = {}) {
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
            // Secret / VCS / CMS probes. Anchored and path-only: they match a whole path SEGMENT
            // (".env", ".env.local", ".git", "wp-admin"...), never a substring, so no registered
            // route can match (a regression test enumerates every route path).
            /(^|\/)\.env(\.[\w-]+)?$/i,
            /\/wp-(admin|login\.php|content|includes)(\/|$)/i,
            /(^|\/)\.git(\/|$)/,
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

        // CVE-2026-123864 guard: refuse GET/HEAD carrying a body. Default ON;
        // only SECURITY_FILTER_REJECT_GET_BODY="false" (exact) disables it.
        this._rejectBodyOnBodylessMethods =
            options.rejectBodyOnBodylessMethods ??
            process.env.SECURITY_FILTER_REJECT_GET_BODY !== "false";

        // Strike/block bookkeeping lives in SuspiciousIpTracker. `_suspiciousIPs`
        // stays the SAME Map (tests and ops tooling read and clear it directly).
        this._tracker = new SuspiciousIpTracker({
            threshold: options.suspiciousThreshold ?? SuspiciousIpTracker.DEFAULT_THRESHOLD,
            blockMs: options.blockDurationMs ?? SuspiciousIpTracker.DEFAULT_BLOCK_MS,
        });
        this._suspiciousIPs = this._tracker.records;

        this.handle = this.handle.bind(this);
    }

    /**
     * Terminate a request from inside this middleware, carrying a request id.
     *
     * WHY THIS EXISTS (F7). This middleware is mounted ABOVE
     * `TraceabilityMiddleware` on purpose — it must see a scanner's payload
     * before the body parsers do — but that middleware is what mints `req.id`,
     * sets `X-Request-ID`, and opens the AsyncLocalStorage store every
     * `logger.*` call reads `[requestId]` from. So every branch that answered
     * from HERE shipped with NO request id in the header, NO `requestId` in the
     * body, and a log line with an empty `[requestId]` — meaning the one class
     * of request you most need to correlate (blocked scanners, injection
     * attempts, a locked-out workstation) was the one class that could not be
     * correlated.
     *
     * Reordering is NOT the fix and must not be attempted: SecurityFilter sits
     * above body parsing deliberately, and moving it changes what a scanner
     * reaches before parse. Instead this mints an id of the SAME shape from the
     * SAME generator Traceability uses, so ids are indistinguishable downstream,
     * and runs both the log and the response INSIDE `requestContext.run()` so
     * the warning line carries it too.
     *
     * @param {import('express').Request} req
     * @param {import('express').Response} res
     * @param {number} status - HTTP status for this refusal.
     * @param {string} message - Client-facing message.
     * @param {string} type - `error.type` for the envelope.
     * @param {() => void} logRefusal - Emits this branch's own log line.
     * @returns {import('express').Response}
     * @private
     */
    _refuse(req: import('express').Request, res: import('express').Response, status: number, message: string, type: string, logRefusal: () => void): import('express').Response {
        if (!req.id) req.id = snowflake.nextId();
        try {
            res.setHeader("X-Request-ID", req.id);
        } catch {
            // Headers already sent — nothing to attach to; keep refusing.
        }

        return requestContext.run({ requestId: req.id }, () => {
            logRefusal();
            return res.status(status).json({
                status: "error",
                code: status,
                title: getStatusTitle(status),
                message,
                error: { type },
                requestId: req.id,
            });
        });
    }

    /**
     * Clear a suspicious-IP block and its offence counter.
     *
     * The in-memory block has no natural operator escape hatch: before this
     * existed, an IP that tripped the threshold could only be freed by
     * restarting the service. Exposed to SUPER_ADMIN via
     * `POST /api/v1/admin-management/security/unblock-ip`.
     *
     * This clears THIS process only. Under clustering use `unblockClusterWide`,
     * which asks the primary (owner of the strikes) to clear and broadcast.
     *
     * @param {string} ip - The address to clear.
     * @param {string} [actor="system"] - Who requested it, for the audit line.
     * @returns {boolean} `true` if a record existed and was removed.
     */
    unblock(ip: string, actor: string = "system"): boolean {
        const existed = this._tracker.unblock(ip);
        if (existed) {
            logger.notice(middlewareMessages.SUSPICIOUS_IP_UNBLOCKED(ip, actor));
        }
        return existed;
    }

    /**
     * Clears a block on every worker. Single-process: same as `unblock`. Cluster:
     * the primary clears the strike record and broadcasts the unblock; if the
     * primary cannot be reached the block is cleared on this worker only and
     * `CLUSTER_SF_UNBLOCK_DEGRADED` is logged.
     *
     * @param {string} ip
     * @param {string} [actor="system"]
     * @returns {Promise<boolean>} a record existed and was removed
     */
    async unblockClusterWide(ip: string, actor: string = "system"): Promise<boolean> {
        if (!clusterRpc.active || !isIp(ip)) return this.unblock(ip, actor);
        try {
            const result = await clusterRpc.call(
                "primary",
                CLUSTER_RPC_METHODS.SF_UNBLOCK,
                { ip, actor: String(actor).slice(0, 200) },
                { timeoutMs: CLUSTER_RPC_TIMEOUTS.SF_UNBLOCK_MS },
            );
            this._tracker.unblock(ip);
            return result.cleared === true;
        } catch (err) {
            logger.warning(clusterMessages.CLUSTER_SF_UNBLOCK_DEGRADED(ip, err?.code ?? err?.message));
            return this.unblock(ip, actor);
        }
    }

    /**
     * Mirrors a block the primary decided (cluster broadcast).
     *
     * @param {string} ip
     * @param {number} blockedUntil - epoch ms
     */
    applyRemoteBlock(ip: string, blockedUntil: number) {
        this._tracker.applyBlock(ip, blockedUntil);
    }

    /** @param {string} ip - mirrors an unblock the primary broadcast */
    applyRemoteUnblock(ip: string) {
        this._tracker.unblock(ip);
    }

    /**
     * Applies the primary's full block list to a worker that just started.
     *
     * @param {{ip: string, blockedUntil: number}[]} blocks
     */
    applySync(blocks: { ip: string; blockedUntil: number; }[]) {
        for (const b of blocks ?? []) this._tracker.applyBlock(b.ip, b.blockedUntil);
    }

    handle(req: Request, res: Response, next: NextFunction) {
        const ip = req.ip || req.connection?.remoteAddress || "unknown";
        const reqPath = req.path;
        const method = req.method;
        // originalUrl includes the query string (e.g. /api/v1/users?id=1' OR '1'='1)
        // so injection patterns can catch payloads in query parameters.
        // L2: Decode twice to catch double-encoded payloads (%2527 → %27 → ').
        let fullUrl;
        try {
            const once = decodeURIComponent(req.originalUrl || reqPath);
            fullUrl = decodeURIComponent(once);
        } catch {
            try {
                fullUrl = decodeURIComponent(req.originalUrl || reqPath);
            } catch {
                fullUrl = req.originalUrl || reqPath;
            }
        }

        // Always check if IP is currently blocked (applies to all paths).
        if (this._tracker.isBlocked(ip)) {
            return this._refuse(
                req,
                res,
                403,
                "Forbidden",
                "ForbiddenError",
                () =>
                    logger.warning(
                        middlewareMessages.IP_BLOCKED_SUSPICIOUS(
                            ip,
                            method,
                            reqPath,
                        ),
                    ),
            );
        }

        // Blocked method check — skip only for health/root paths (not all /api/ paths).
        const isMethodWhitelisted = this._methodWhitelistedPaths.some((p: any) =>
            p.test(reqPath),
        );
        if (!isMethodWhitelisted && this._blockedMethods.has(method)) {
            this._trackSuspiciousIP(ip);
            return this._refuse(
                req,
                res,
                405,
                "Method Not Allowed",
                "MethodNotAllowed",
                () =>
                    logger.warning(
                        middlewareMessages.HTTP_METHOD_BLOCKED(
                            ip,
                            method,
                            reqPath,
                        ),
                    ),
            );
        }

        // Path-only pattern check — scanner fingerprints, exploit paths, file extensions.
        if (this._maliciousPatterns.some((p: any) => p.test(reqPath))) {
            this._trackSuspiciousIP(ip);
            return this._refuse(req, res, 404, "Not Found", "NotFound", () =>
                logger.warning(
                    middlewareMessages.MALICIOUS_REQUEST_BLOCKED(
                        ip,
                        method,
                        reqPath,
                    ),
                ),
            );
        }

        // Injection pattern check — scans the FULL URL (path + query string).
        // Catches XSS, SQLi, traversal, and command injection payloads
        // regardless of whether they appear in the path or query parameters.
        if (this._injectionPatterns.some((p: any) => p.test(fullUrl))) {
            this._trackSuspiciousIP(ip);
            return this._refuse(
                req,
                res,
                403,
                "Forbidden",
                "ForbiddenError",
                () =>
                    logger.warning(
                        middlewareMessages.MALICIOUS_REQUEST_BLOCKED(
                            ip,
                            method,
                            fullUrl,
                        ),
                    ),
            );
        }

        // CVE-2026-123864 guard — GET/HEAD must not carry a body. Removes the
        // "request body still streaming when a handler flushes headers" half of
        // the Node HTTPS trigger before any SSE handler can run.
        // LAST on purpose: every refusal above keeps its status and strike, so a
        // scanner cannot dodge strike counting by adding a body.
        // NO strike on purpose: the likely cause is a misbehaving client/proxy;
        // behind a shared proxy IP, strikes would lock out the whole site.
        // Method whitelist ignored: it only exempts the blocked-method check.
        if (
            this._rejectBodyOnBodylessMethods &&
            BODYLESS_METHODS.has(method) &&
            hasDeclaredBody(req.headers)
        ) {
            try {
                // Free the socket instead of waiting for the rest of the body.
                res.setHeader("Connection", "close");
            } catch {
                // Headers already sent / mock without setHeader — keep refusing.
            }
            return this._refuse(
                req,
                res,
                400,
                REQUEST_ERRORS.BODY_NOT_ALLOWED,
                "BodyNotAllowedError",
                () =>
                    logger.warning(
                        middlewareMessages.GET_BODY_REFUSED(ip, method, reqPath),
                    ),
            );
        }

        next();
    }

    getStats() {
        return this._tracker.stats();
    }

    /**
     * Counts a strike. Cluster: the primary owns the strike counters, so the
     * strike is sent as a notify and this worker's tracker is only a block
     * mirror (the block arrives by broadcast). An address the IPC schema cannot
     * carry, or a failed send, falls back to a local strike.
     *
     * @param {string} ip
     * @returns {boolean} the IP is blocked as far as this worker knows
     */
    _trackSuspiciousIP(ip: string): boolean {
        if (clusterRpc.active && isIp(ip) && clusterRpc.notify(CLUSTER_RPC_METHODS.SF_STRIKE, { ip })) {
            return this._tracker.isBlocked(ip);
        }
        return this._tracker.strike(ip).blocked;
    }
}

const defaultSecurityFilter = new SecurityFilterMiddleware();
export { SecurityFilterMiddleware, defaultSecurityFilter };
