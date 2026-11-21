"use strict";

/**
 * @fileoverview Authentication & Authorization Middleware
 * JWT authentication with dynamic, predicate-based access control.
 *
 * No hardcoded ROLES or AREAS — each project defines its own permission
 * logic inline at the route level via requireAccess(predicate).
 */

const jwt = require("jsonwebtoken");
const {
    AppError,
    AUTH_ERRORS,
    VALIDATION_ERRORS,
} = require("../../constants/errors");
const { logger } = require("../../utils/logger");
const { authMessages } = require("../../constants/messages");
const AuthService = require("../../services/auth.service");
const { CryptoVault } = require("../../utils/encryption/CryptoVault");
const { classifyAccessClaims } = require("../../utils/auth/tokenClaims");
const AccessRevocationService = require("../../services/AccessRevocationService");

class AuthMiddleware {
    /**
     * Describe the credential a request arrived with, WITHOUT revealing it.
     *
     * ⚠ SECURITY BOUNDARY — READ BEFORE EXTENDING.
     * The access token is a bearer credential. It must never reach a log file:
     * the Logs UI renders those lines to any ADMIN, `Export Trace` writes them
     * into a downloadable workbook, and the retention export ships them in a ZIP.
     * A JWT logged once is a replayable session for as long as it is valid
     * (CWE-522 Insufficiently Protected Credentials / CWE-532 Information
     * Exposure Through Log Files). So this returns only DERIVED facts —
     * presence, cookie NAMES, and verification outcome. It never returns a
     * cookie value, a token, a fragment of one, or its length (a length leak
     * still fingerprints payload contents).
     *
     * What it DOES surface is what a trace actually needs: which credential
     * source was used, whether the signed cookie survived its HMAC check, and
     * which cookies the browser sent at all — the three things that distinguish
     * "user never logged in" from "cookie was dropped by the browser" from
     * "cookie was tampered with", all of which currently look identical.
     *
     * @param {import('express').Request} req
     * @returns {{ source: string, cookieNames: string[], signed: string }}
     * @private
     */
    static _describeCredential(req) {
        const hasHeaderToken = Boolean(
            req.headers?.["authorization"]?.split(" ")[1],
        );
        const accessName = AuthService.COOKIE_NAMES.ACCESS;

        // cookie-parser puts a signed cookie in `signedCookies` ONLY when its
        // HMAC verifies; a tampered one lands in `cookies` as `false`. That
        // difference is the single most useful auth signal in a trace and is
        // invisible from the response status alone.
        const inSigned = Boolean(req.signedCookies?.[accessName]);
        const presentUnsigned = Object.hasOwn(req.cookies ?? {}, accessName);

        let signed = "absent";
        if (inSigned) signed = "ok";
        else if (presentUnsigned) signed = "bad-signature";

        // Names only — a cookie name is not a secret, its value always is.
        const cookieNames = [
            ...new Set([
                ...Object.keys(req.cookies ?? {}),
                ...Object.keys(req.signedCookies ?? {}),
            ]),
        ].sort();

        const source = hasHeaderToken
            ? "header"
            : inSigned
              ? "cookie"
              : presentUnsigned
                ? "cookie(unverified)"
                : "none";

        return { source, cookieNames, signed };
    }

    /**
     * Emit the `[AUTH @ …]` trace line for one authentication attempt.
     *
     * Success is INFO (a routine mid-flow checkpoint) and failure is WARNING (an
     * expected bad path), per the level decision table in Backend/CLAUDE.md —
     * a failed token check is not an application error.
     *
     * @param {import('express').Request} req
     * @param {object} outcome
     * @param {string} outcome.result - verified | expired | not-before | missing | tampered | invalid | legacy-token | wrong-type | revoked
     * @param {number} outcome.status - HTTP status this outcome maps to.
     * @param {object} [outcome.user]  - Decoded payload (success only).
     * @param {object} [outcome.err]   - jsonwebtoken error (failure only).
     * @private
     */
    static _traceAuth(req, { result, status, user, err }) {
        const { source, cookieNames, signed } =
            AuthMiddleware._describeCredential(req);

        const parts = [
            `result=${result}`,
            `status=${status}`,
            `source=${source}`,
            `signature=${signed}`,
            `cookies=${cookieNames.length > 0 ? cookieNames.join("|") : "none"}`,
        ];

        if (user) {
            // Non-secret registered/identity claims only. Deliberately NOT the
            // whole payload — a future claim could carry PII and this would leak
            // it by default. `iat`/`exp` are timestamps, not credentials, and are
            // what tell you whether a 440 was a genuine timeout or a clock skew.
            if (user.userId != null) parts.push(`user=${user.userId}`);
            if (user.role != null) parts.push(`role=${user.role}`);
            if (user.iat != null)
                parts.push(`iat=${new Date(user.iat * 1000).toISOString()}`);
            if (user.exp != null)
                parts.push(`exp=${new Date(user.exp * 1000).toISOString()}`);
        }

        if (err?.expiredAt) {
            const expiredAt = new Date(err.expiredAt);
            parts.push(`expiredAt=${expiredAt.toISOString()}`);
            parts.push(
                `expiredForSec=${Math.max(0, Math.round((Date.now() - expiredAt.getTime()) / 1000))}`,
            );
        }
        // err.message is jsonwebtoken's own fixed vocabulary ("jwt expired",
        // "invalid signature", "jwt malformed") — never user input, never the
        // token itself.
        if (err?.message) parts.push(`reason=${err.message}`);

        const message = authMessages.AUTH_TRACE(parts.join(" "));
        if (result === "verified") logger.info(message);
        else logger.warning(message);
    }
    /**
     * Middleware that authenticates JWT tokens from cookies or Authorization header.
     * Attaches decoded user payload to `req.user`.
     */
    static authenticate(req, res, next) {
        AuthMiddleware._doAuthenticate(req, res, next, false);
    }

    /**
     * Same as authenticate but returns user-friendly HTML errors instead of JSON.
     * Use this on routes that serve file downloads (export, download endpoints).
     *
     * The file-download flag is server-controlled (chosen at route definition),
     * not derived from user-supplied paths or headers (CWE-807).
     *
     * @example
     * router.get('/report/export/:id',
     *     AuthMiddleware.authenticateForDownload,
     *     ReportController.export,
     * );
     */
    static authenticateForDownload(req, res, next) {
        AuthMiddleware._doAuthenticate(req, res, next, true);
    }

    /**
     * Same as authenticate, but ALSO admits a session that must change its
     * password first (`requiresPasswordChange: true` — a temporary or legacy
     * default password). Every other entry point refuses such a session with
     * 403 PasswordChangeRequiredError, so the forced change is enforced by the server, not only the UI.
     *
     * Use ONLY on the routes a restricted session needs to finish the change:
     * POST /auth/logout, GET /auth/me, PATCH /auth/change-password and
     * POST /csrf/refresh (change-password is a CSRF-protected PATCH). The
     * choice is made at route definition — never derived from the request
     * path (CWE-807).
     */
    static authenticatePendingPasswordChange(req, res, next) {
        AuthMiddleware._doAuthenticate(req, res, next, false, true);
    }

    /**
     * Shared authentication logic.
     *
     * Security: the token is read from `req.signedCookies` (HMAC-verified by
     * cookie-parser using COOKIE_SECRET) or the Authorization header.  The sole
     * security decision is made by `jwt.verify()` — a server-controlled
     * cryptographic check — so no branch depends on raw user-controlled data
     * (CWE-807 / CodeQL js/user-controlled-bypass).
     *
     * @param {boolean} isFileDownload - Server-controlled flag; never derived from user input.
     * @param {boolean} [allowPendingPasswordChange=false] - Server-controlled;
     *   true only via authenticatePendingPasswordChange.
     * @private
     */
    static _doAuthenticate(req, res, next, isFileDownload, allowPendingPasswordChange = false) {
        // Authorization header takes precedence (standard convention).
        // signedCookies are HMAC-verified by cookie-parser (server-controlled).
        // Both sources are validated by jwt.verify below.
        const token =
            req.headers["authorization"]?.split(" ")[1] ||
            req.signedCookies?.[AuthService.COOKIE_NAMES.ACCESS] ||
            "";

        // jwt.verify handles missing (""), malformed, expired, and forged
        // tokens uniformly — the security decision is always server-controlled.
        jwt.verify(
            token,
            process.env.JWT_SECRET,
            { algorithms: ["HS256"] },
            (err, user) => {
                if (err) {
                    // TokenExpiredError   → session timed out                       → 440
                    // NotBeforeError      → token used before its nbf claim         → 403
                    // JsonWebTokenError with missing/empty token                    → 401
                    // JsonWebTokenError with invalid signature or malformed payload → 403
                    const isExpired = err.name === "TokenExpiredError";
                    const isNotBefore = err.name === "NotBeforeError";
                    const isMissingToken =
                        err.name === "JsonWebTokenError" &&
                        (token === "" ||
                            err.message?.includes("jwt must be provided") ||
                            err.message?.includes("No auth token"));
                    const isTampered =
                        err.name === "JsonWebTokenError" &&
                        !isMissingToken &&
                        (err.message?.includes("invalid signature") ||
                            err.message?.includes("jwt malformed") ||
                            err.message?.includes("Unexpected token"));

                    const isMissing = isMissingToken;

                    let statusCode;
                    if (isExpired) statusCode = 440;
                    else if (isNotBefore) statusCode = 403;
                    else if (isMissingToken) statusCode = 401;
                    else if (isTampered) statusCode = 403;
                    else statusCode = 401; // unknown JsonWebTokenError sub-type defaults to 401

                    // Trace the rejection BEFORE branching on isFileDownload —
                    // the download path returns HTML and never reaches the
                    // AppError below, so a trace emitted after the branch would
                    // silently miss every export/download auth failure.
                    AuthMiddleware._traceAuth(req, {
                        result: isExpired
                            ? "expired"
                            : isNotBefore
                              ? "not-before"
                              : isMissingToken
                                ? "missing"
                                : isTampered
                                  ? "tampered"
                                  : "invalid",
                        status: statusCode,
                        err,
                    });

                    if (isFileDownload) {
                        const title = isMissing
                            ? "Authentication Required"
                            : isExpired
                              ? "Session Expired"
                              : "Access Denied";
                        const line1 = isMissing
                            ? "You need to be logged in to download this file."
                            : isExpired
                              ? "Your session has expired."
                              : "Your authentication token is invalid or has expired.";
                        const line2 = isMissing
                            ? "Please log in and try again."
                            : "Please log in again and try downloading the file.";

                        res.setHeader(
                            "Content-Type",
                            "text/html; charset=utf-8",
                        );
                        res.setHeader("Content-Disposition", "inline");

                        logger.warning(authMessages.AUTH_DOWNLOAD_REJECTED(title, `${line1} ${line2}`));

                        return res
                            .status(statusCode)
                            .send(
                                AuthMiddleware._authHtmlError(
                                    title,
                                    line1,
                                    line2,
                                ),
                            );
                    }

                    // Non-download path
                    if (isExpired) {
                        return next(
                            new AppError(AUTH_ERRORS.TOKEN_EXPIRED, 440, {
                                type: "SessionTimeoutError",
                                hint: "Your session has expired. Please sign in again.",
                            }),
                        );
                    }

                    const errorMsg = isMissing
                        ? AUTH_ERRORS.USER_NOT_FOUND
                        : AUTH_ERRORS.FORBIDDEN_ACCESS;
                    const errorType = "AuthenticationError";
                    const hint = isMissing
                        ? "Provide a valid token."
                        : "Token invalid or expired.";

                    return next(
                        new AppError(errorMsg, statusCode, {
                            type: errorType,
                            hint,
                        }),
                    );
                }
                // Token-type gate. The signature is valid, but access and
                // refresh tokens share JWT_SECRET/HS256, so only the claims say
                // which kind this is. Runs BEFORE the password-change gate: a
                // refresh token carries no requiresPasswordChange claim and
                // would otherwise sail past it (CWE-287).
                //   legacy     -> 440: minted by a legacy build; the UI does a
                //                 clean re-login (downloads: "Session Expired").
                //   wrong-type -> 401: a refresh (or foreign) token used as an
                //                 access token (downloads: "Access Denied").
                const claimClass = classifyAccessClaims(user);
                if (claimClass !== "access") {
                    return AuthMiddleware._rejectTokenClass(
                        req,
                        res,
                        next,
                        claimClass,
                        isFileDownload,
                    );
                }

                // Ended-session gate. A valid access token whose
                // session family was ended (sign-out, password change/reset,
                // admin re-add, refresh reuse) is refused at once instead of
                // working until it expires (CWE-613). In-memory lookup, no DB.
                // 440 so the UI ends the session cleanly, like a timeout.
                if (AccessRevocationService.isRevoked(user.fid)) {
                    return AuthMiddleware._rejectRevokedSession(req, res, next, user, isFileDownload);
                }

                // Success previously logged NOTHING, so a trace for an
                // authenticated request had no evidence auth had happened at
                // all — you could not tell "token verified" from "route is
                // public" from reading the timeline.
                AuthMiddleware._traceAuth(req, {
                    result: "verified",
                    status: 200,
                    user,
                });

                // Forced password change, enforced server-side. The claim is
                // inside the HS256-signed payload, so it cannot be stripped by
                // the client; strict `=== true` so only a token this server
                // issued as restricted is restricted.
                if (user?.requiresPasswordChange === true && !allowPendingPasswordChange) {
                    logger.warning(
                        authMessages.PASSWORD_CHANGE_GATE_BLOCKED(
                            user.userId,
                            req.method,
                            String(req.originalUrl ?? "").split("?")[0],
                        ),
                    );
                    if (isFileDownload) {
                        res.setHeader("Content-Type", "text/html; charset=utf-8");
                        res.setHeader("Content-Disposition", "inline");
                        return res
                            .status(403)
                            .send(
                                AuthMiddleware._authHtmlError(
                                    "Password Change Required",
                                    "You signed in with a temporary password.",
                                    "Set a new password, then try downloading the file again.",
                                ),
                            );
                    }
                    return next(
                        new AppError(AUTH_ERRORS.PASSWORD_CHANGE_REQUIRED, 403, {
                            type: "PasswordChangeRequiredError",
                            hint: "Open Change Password and set a new password to continue.",
                        }),
                    );
                }

                req.user = user;
                next();
            },
        );
    }

    /**
     * Refuses a signature-valid token whose claims are not those of an access
     * token. See the call site in `_doAuthenticate` for the status mapping.
     *
     * @param {import('express').Request} req
     * @param {import('express').Response} res
     * @param {import('express').NextFunction} next
     * @param {"legacy"|"wrong-type"} claimClass
     * @param {boolean} isFileDownload - Server-controlled flag.
     * @private
     */
    static _rejectTokenClass(req, res, next, claimClass, isFileDownload) {
        const legacy = claimClass === "legacy";
        const statusCode = legacy ? 440 : 401;
        AuthMiddleware._traceAuth(req, {
            result: legacy ? "legacy-token" : "wrong-type",
            status: statusCode,
        });

        if (isFileDownload) {
            const title = legacy ? "Session Expired" : "Access Denied";
            const line1 = legacy
                ? "Your session has expired."
                : "Your authentication token is invalid or has expired.";
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.setHeader("Content-Disposition", "inline");
            logger.warning(authMessages.AUTH_DOWNLOAD_REJECTED(title, line1));
            return res
                .status(statusCode)
                .send(
                    AuthMiddleware._authHtmlError(
                        title,
                        line1,
                        "Please log in again and try downloading the file.",
                    ),
                );
        }

        if (legacy) {
            return next(
                new AppError(AUTH_ERRORS.TOKEN_EXPIRED, 440, {
                    type: "SessionTimeoutError",
                    hint: "Your session has expired. Please sign in again.",
                }),
            );
        }
        return next(
            new AppError(AUTH_ERRORS.TOKEN_TYPE_INVALID, 401, {
                type: "AuthenticationError",
                hint: "Present an access token.",
            }),
        );
    }

    /**
     * Refuses an access token whose session was ended. 440 (JSON) or the HTML
     * "Session Ended" page for downloads.
     *
     * @param {import('express').Request} req
     * @param {import('express').Response} res
     * @param {import('express').NextFunction} next
     * @param {object} user - verified payload (only userId and an 8-char fid prefix are logged)
     * @param {boolean} isFileDownload - Server-controlled flag.
     * @private
     */
    static _rejectRevokedSession(req, res, next, user, isFileDownload) {
        AuthMiddleware._traceAuth(req, { result: "revoked", status: 440 });
        logger.warning(
            authMessages.ACCESS_SESSION_REVOKED_REFUSED(user.userId, String(user.fid).slice(0, 8)),
        );
        if (isFileDownload) {
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.setHeader("Content-Disposition", "inline");
            return res
                .status(440)
                .send(
                    AuthMiddleware._authHtmlError(
                        "Session Ended",
                        "This session was ended (signed out or password changed).",
                        "Please log in again and try downloading the file.",
                    ),
                );
        }
        return next(
            new AppError(AUTH_ERRORS.ACCESS_SESSION_REVOKED, 440, {
                type: "SessionRevokedError",
                hint: "Your session has ended. Please sign in again.",
            }),
        );
    }

    /**
     * Promise-based token verification. Resolves ONLY for access tokens
     * (signature valid AND access claims); a refresh token, a legacy token
     * or any other kind is rejected 403.
     * @param {string} token
     * @returns {Promise<object>} decoded payload
     */
    static verifyToken(token) {
        return new Promise((resolve, reject) => {
            jwt.verify(
                token,
                process.env.JWT_SECRET,
                { algorithms: ["HS256"] },
                (err, payload) => {
                    if (
                        err ||
                        classifyAccessClaims(payload) !== "access" ||
                        AccessRevocationService.isRevoked(payload.fid)
                    )
                        return reject(
                            new AppError(AUTH_ERRORS.FORBIDDEN_ACCESS, 403),
                        );
                    resolve(payload);
                },
            );
        });
    }

    /**
     * Factory: returns middleware that checks a predicate against req.user.
     * Each project defines its own access rules inline.
     *
     * @param {(user: object) => boolean} predicate
     * @param {object} [options]
     * @param {string} [options.message] - Custom error message
     * @returns {import('express').RequestHandler}
     *
     * @example
     * // Role-based only
     * AuthMiddleware.requireAccess(user => user.userLevel >= 2)
     *
     * @example
     * // Area-based
     * AuthMiddleware.requireAccess(user => {
     *     const areas = (user.area ?? '').split(',').map(a => a.trim());
     *     return areas.includes('INV_CON');
     * })
     *
     * @example
     * // Combined
     * AuthMiddleware.requireAccess(user =>
     *     user.userLevel >= 3 && user.permissions?.includes('DELETE_USERS')
     * )
     */
    static requireAccess(predicate, options = {}) {
        return (req, res, next) => {
            if (!req.user) {
                return next(
                    new AppError(AUTH_ERRORS.USER_NOT_FOUND, 401, {
                        type: "AuthenticationError",
                    }),
                );
            }

            if (!predicate(req.user)) {
                return next(
                    new AppError(
                        options.message || AUTH_ERRORS.FORBIDDEN_ACCESS,
                        403,
                        {
                            type: "AuthorizationError",
                            hint: "You do not have the required permission for this resource.",
                        },
                    ),
                );
            }

            next();
        };
    }

    /**
     * Middleware factory — validates required fields in req.body or req.query.
     *
     * @param {string[]} requiredFields
     * @param {object}   [options]
     * @param {boolean}  [options.stringOnly=true]  When true (default), objects and
     *   arrays are rejected with a type error and all surviving values are coerced
     *   to strings. When false, object/array values are passed through unchanged
     *   (useful for structured payloads like permission-flags objects where the
     *   service layer validates the shape). Primitive values are still coerced to
     *   strings even when stringOnly is false.
     */
    static validateRequiredFields(requiredFields, options = {}) {
        const stringOnly = options.stringOnly !== false;

        return (req, res, next) => {
            const source = req.method === "GET" ? req.query : req.body;
            const missing = [];
            const typeErrors = [];

            for (const f of requiredFields) {
                const val = source[f];

                if (val === undefined || val === null || val === "") {
                    missing.push({ field: f, issue: "Required" });
                    continue;
                }

                // H3: reject objects/arrays — prevents operator injection
                if (stringOnly && typeof val === "object") {
                    typeErrors.push({
                        field: f,
                        issue: "Must be a string or number, not an object or array",
                    });
                    continue;
                }

                // Coerce primitives to strings; preserve objects when stringOnly is off
                source[f] = typeof val === "object" ? val : String(val);
            }

            const allErrors = [...missing, ...typeErrors];
            if (allErrors.length > 0) {
                return next(
                    new AppError(
                        missing.length > 0
                            ? VALIDATION_ERRORS.MISSING_FIELDS
                            : VALIDATION_ERRORS.INVALID_INPUT,
                        400,
                        {
                            type: "ValidationError",
                            details: allErrors,
                        },
                    ),
                );
            }

            next();
        };
    }

    /**
     * Middleware factory — bounds password fields in req.body before they reach
     * CryptoVault, whose hash/verify methods throw RangeError (over-length) or
     * TypeError (non-string). Unchecked, those surfaced as 500s, and on login
     * the 500-vs-401 split told a caller which ids are admins (CWE-204).
     *
     * Absent/empty fields are skipped — whether a field is required is
     * `validateRequiredFields`' job. Run this after it.
     *
     * @param {object}   fields
     * @param {string[]} [fields.verify=[]] - passwords checked against a stored hash
     * @param {string[]} [fields.hash=[]]   - new passwords about to be hashed
     */
    static validatePasswordFields({ verify = [], hash = [] } = {}) {
        const checks = [
            ...verify.map((field) => [field, false]),
            ...hash.map((field) => [field, true]),
        ];

        return (req, res, next) => {
            const body = req.body ?? {};
            const errors = [];

            for (const [field, forHash] of checks) {
                const value = body[field];
                if (value === undefined || value === null || value === "") continue;

                if (typeof value !== "string") {
                    errors.push({ field, issue: "Must be a string." });
                    continue;
                }
                const max = CryptoVault.maxPasswordBytes({ forHash });
                if (Buffer.byteLength(value, "utf8") > max) {
                    errors.push({ field, issue: `Too long: at most ${max} bytes.` });
                }
            }

            if (errors.length > 0) {
                return next(
                    new AppError(VALIDATION_ERRORS.INVALID_INPUT, 400, {
                        type: "ValidationError",
                        details: errors,
                    }),
                );
            }
            next();
        };
    }

    static _escapeHtml(str) {
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    static _authHtmlError(title, line1, line2) {
        const t = AuthMiddleware._escapeHtml(title);
        const l1 = AuthMiddleware._escapeHtml(line1);
        const l2 = AuthMiddleware._escapeHtml(line2);
        return `<!DOCTYPE html>
<html><head><title>${t}</title>
<style>body{font-family:Arial,sans-serif;margin:40px}.error-container{max-width:600px;margin:0 auto}
.error-title{color:#d32f2f;margin-bottom:20px}.error-message{background:#f5f5f5;padding:15px;border-radius:4px}
.login-button{background:#1976d2;color:white;padding:10px 20px;text-decoration:none;border-radius:4px;display:inline-block;margin-top:15px}</style>
</head><body><div class="error-container"><h1 class="error-title">${t}</h1>
<div class="error-message"><p>${l1}</p><p>${l2}</p></div>
<a href="/auth" class="login-button">Go to Login</a>
<a href="javascript:history.back()" class="login-button">Go Back</a>
</div></body></html>`;
    }
}

module.exports = AuthMiddleware;
