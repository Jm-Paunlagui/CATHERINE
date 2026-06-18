"use strict";

/**
 * @fileoverview AuthService — standalone username/password authentication.
 *
 * Project-agnostic replacement for the HRIS/Meal auth coupling. Credentials live
 * in two tables (or the in-memory demo store when DEMO_MODE=true):
 *
 *   T_ADMINS  — privileged accounts with RBAC (SUPER_ADMIN/ADMIN/USER) and a
 *               tamper-evident SYSSIGNATURE. Checked first.
 *   T_USERS   — regular accounts. Authenticate at USER level.
 *
 * Passwords are Argon2id (CryptoVault, PASSWORD_HASH_MODE=argon2). Admin rows are
 * additionally HMAC-signed so a row edited directly in the DB is refused at login.
 *
 * Public API (consumed by auth.controllers.js):
 *   login, refresh, getProfile, changePassword,
 *   accessCookieOptions, refreshCookieOptions, COOKIE_NAMES
 */

const jwt = require("jsonwebtoken");
const { AppError, AUTH_ERRORS, ADMIN_ERRORS } = require("../constants/errors");
const { HTTP_STATUS } = require("../constants");
const { logger } = require("../utils/logger");
const { authMessages } = require("../constants/messages");
const { CryptoVault } = require("../utils/encryption/CryptoVault");
const AdminModel = require("../models/admin.model");
const UserModel = require("../models/user.model");
const {
    loginLockout,
} = require("../middleware/authentication/LoginLockoutMiddleware");

class AuthService {
    // ─── Cookie name constants (single source of truth) ───────────────────────
    static COOKIE_NAMES = {
        ACCESS: "app.access-token",
        REFRESH: "app.refresh-token",
    };

    // ─── Public API ───────────────────────────────────────────────────────────

    /**
     * Authenticates a username/password pair.
     * Admins (T_ADMINS) are checked before regular users (T_USERS).
     *
     * @param {string} username
     * @param {string} password
     * @returns {Promise<{ user: object, accessToken: string, refreshToken: string }>}
     */
    static async login(username, password) {
        // ── Lockout gate ──────────────────────────────────────────────────────
        const lockState = loginLockout.check(username);
        if (lockState.hrReset) {
            throw new AppError(AUTH_ERRORS.ACCOUNT_LOCKED_PERMANENTLY, 423, {
                type: "AccountLockedError",
            });
        }
        if (lockState.locked) {
            throw new AppError(AUTH_ERRORS.ACCOUNT_LOCKED, 429, {
                type: "AccountLockedError",
                details: [{ field: "retryAfter", issue: `${lockState.retryAfter}` }],
            });
        }

        const admin = await AdminModel.findByUsername(username);
        if (admin) return AuthService._loginAdmin(admin, username, password);

        const user = await UserModel.findByUsername(username);
        if (user) return AuthService._loginUser(user, username, password);

        // Unknown username — same generic error as a wrong password (no enumeration).
        loginLockout.recordFailure(username);
        throw new AppError(AUTH_ERRORS.INVALID_CREDENTIALS, 401, {
            type: "AuthenticationError",
        });
    }

    /**
     * Issues a fresh access + refresh token pair from a valid refresh token,
     * re-reading the account so role/active changes take effect.
     *
     * @param {string} refreshToken
     * @returns {Promise<{ user: object, accessToken: string, refreshToken: string }>}
     */
    static async refresh(refreshToken) {
        let decoded;
        try {
            decoded = jwt.verify(refreshToken, process.env.JWT_SECRET);
        } catch {
            throw new AppError(AUTH_ERRORS.TOKEN_INVALID, 403, {
                type: "AuthenticationError",
                hint: "Refresh token is invalid or expired. Please log in again.",
            });
        }
        if (decoded.type !== "refresh") {
            throw new AppError(AUTH_ERRORS.TOKEN_INVALID, 403, {
                type: "AuthenticationError",
            });
        }

        const username = decoded.sub;

        const admin = await AdminModel.findByUsername(username);
        if (admin) {
            AuthService._assertActive(admin.IS_ACTIVE, username);
            const role = await AuthService._resolveRole(admin);
            logger.info(authMessages.TOKEN_REFRESHED(username));
            return AuthService._issueTokens(AuthService._adminPayload(admin, role));
        }

        const user = await UserModel.findByUsername(username);
        if (user) {
            AuthService._assertActive(user.IS_ACTIVE, username);
            logger.info(authMessages.TOKEN_REFRESHED(username));
            return AuthService._issueTokens(AuthService._userPayload(user));
        }

        throw new AppError(AUTH_ERRORS.USER_NOT_FOUND, 401, {
            type: "AuthenticationError",
        });
    }

    /**
     * Returns the caller's profile for GET /auth/me. The JWT already carries the
     * authoritative claims (role/userLevel), so this returns the decoded payload
     * unchanged — role-gated actions are always re-checked server-side at action time.
     *
     * @param {object} decodedUser - req.user (verified JWT payload)
     * @returns {Promise<object>}
     */
    static async getProfile(decodedUser) {
        return decodedUser;
    }

    // ─── Cookie option helpers (used by the controller) ───────────────────────

    static accessCookieOptions() {
        return {
            httpOnly: true,
            secure: process.env.USE_HTTPS === "true",
            sameSite: "strict",
            signed: true,
            maxAge: AuthService._parseDuration(process.env.JWT_EXPIRES_IN || "30m"),
        };
    }

    static refreshCookieOptions() {
        return {
            httpOnly: true,
            secure: process.env.USE_HTTPS === "true",
            sameSite: "strict",
            signed: true,
            path: "/api/v1/auth/refresh",
            maxAge: 7 * 24 * 60 * 60 * 1000, // 7 d
        };
    }

    /**
     * Converts a JWT-style duration string to milliseconds (s/m/h/d).
     * @param {string} str - e.g. '30m', '8h', '7d', '60s'
     * @returns {number}
     */
    static _parseDuration(str) {
        const match = /^(\d+)([smhd])$/.exec(String(str).trim());
        if (!match) {
            throw new Error(
                `Unrecognised duration format: "${str}". Expected e.g. "30m", "8h", "7d".`,
            );
        }
        const multipliers = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
        return parseInt(match[1], 10) * multipliers[match[2]];
    }

    // ─── Login helpers ────────────────────────────────────────────────────────

    static async _loginAdmin(admin, username, password) {
        AuthService._assertActive(admin.IS_ACTIVE, username);

        // Integrity check before any password comparison (blocks tampered rows).
        const sigValid = await CryptoVault.verifyRecord(
            AdminModel.SIGN_CONTEXT,
            AdminModel.buildSignedFields(admin),
            admin.SYSSIGNATURE,
        );
        if (!sigValid) {
            logger.warning(authMessages.SYS_SIGNATURE_TAMPERED_BLOCKED(username));
            throw new AppError(
                AUTH_ERRORS.ACCOUNT_INTEGRITY_FAILED,
                HTTP_STATUS.UNPROCESSABLE,
                { type: "DataIntegrityError" },
            );
        }

        const pwMatch = await CryptoVault.verifyPassword(password, admin.PASSWORD);
        if (!pwMatch) {
            loginLockout.recordFailure(username);
            throw new AppError(AUTH_ERRORS.INVALID_CREDENTIALS, 401, {
                type: "AuthenticationError",
            });
        }

        // Transparent rehash when Argon2 params have been strengthened since the
        // hash was created. Best-effort — never blocks login.
        await AuthService._maybeRehashAdmin(admin, password);

        const isDefaultPassword = await AuthService._checkIsDefaultPassword(admin.PASSWORD);

        logger.info(authMessages.AUTH_SUCCESS(username));
        const tokens = AuthService._issueTokens(
            AuthService._adminPayload(admin, admin.ROLE, isDefaultPassword),
        );
        loginLockout.recordSuccess(username);
        return tokens;
    }

    static async _loginUser(user, username, password) {
        AuthService._assertActive(user.IS_ACTIVE, username);

        const pwMatch = await CryptoVault.verifyPassword(password, user.PASSWORD);
        if (!pwMatch) {
            loginLockout.recordFailure(username);
            throw new AppError(AUTH_ERRORS.INVALID_CREDENTIALS, 401, {
                type: "AuthenticationError",
            });
        }

        const isDefaultPassword = await AuthService._checkIsDefaultPassword(user.PASSWORD);

        logger.info(authMessages.AUTH_SUCCESS(username));
        const tokens = AuthService._issueTokens(
            AuthService._userPayload(user, isDefaultPassword),
        );
        loginLockout.recordSuccess(username);
        return tokens;
    }

    /** Throws 403 when IS_ACTIVE is 'N' (default 'Y' when the column is absent). */
    static _assertActive(isActive, username) {
        if (String(isActive ?? "Y") === "N") {
            logger.warning(authMessages.ACCOUNT_INACTIVE_BLOCKED(username));
            throw new AppError(AUTH_ERRORS.ACCOUNT_INACTIVE, 403, {
                type: "AuthorizationError",
            });
        }
    }

    /**
     * Re-reads the role from a verified admin row, falling back to USER when the
     * signature is broken (defence in depth for the refresh path).
     * @param {object} admin
     * @returns {Promise<string>}
     */
    static async _resolveRole(admin) {
        const sigValid = await CryptoVault.verifyRecord(
            AdminModel.SIGN_CONTEXT,
            AdminModel.buildSignedFields(admin),
            admin.SYSSIGNATURE,
        );
        if (!sigValid) {
            logger.warning(
                authMessages.SYS_SIGNATURE_TAMPERED_ROLE_FALLBACK(admin.USERNAME),
            );
            return "USER";
        }
        return admin.ROLE;
    }

    /**
     * Maps an RBAC role to the numeric userLevel used by requireAccess predicates.
     * SUPER_ADMIN → 3, ADMIN → 2, everything else → 1.
     * @param {string} role
     * @returns {number}
     */
    static _roleToUserLevel(role) {
        if (role === "SUPER_ADMIN") return 3;
        if (role === "ADMIN") return 2;
        return 1;
    }

    /** Builds the JWT claim object for an admin account. */
    static _adminPayload(admin, role, isDefaultPassword = false) {
        return {
            id: Number(admin.ID) || null,
            username: admin.USERNAME,
            firstName: null,
            lastName: null,
            email: null,
            role,
            loginSource: "admin",
            isDefaultPassword,
        };
    }

    /** Builds the JWT claim object for a regular user account. */
    static _userPayload(user, isDefaultPassword = false) {
        return {
            id: Number(user.ID) || null,
            username: user.USERNAME,
            firstName: user.FIRST_NAME ?? null,
            lastName: user.LAST_NAME ?? null,
            email: user.EMAIL ?? null,
            role: "USER",
            loginSource: "user",
            isDefaultPassword,
        };
    }

    /**
     * Builds and signs the access + refresh tokens from a claim object.
     * The access token carries the full profile; the refresh token carries only
     * sub + type (minimal surface area).
     *
     * @param {object} claims - from _adminPayload / _userPayload
     * @returns {{ user: object, accessToken: string, refreshToken: string }}
     */
    static _issueTokens(claims) {
        const userPayload = {
            sub: String(claims.username),
            userId: String(claims.username),
            id: claims.id ?? null,
            username: claims.username,
            userLevel: AuthService._roleToUserLevel(claims.role),
            firstName: claims.firstName ?? null,
            lastName: claims.lastName ?? null,
            email: claims.email ?? null,
            role: claims.role,
            loginSource: claims.loginSource,
            isDefaultPassword: claims.isDefaultPassword ?? false,
            requiresPasswordChange: claims.isDefaultPassword ?? false,
        };

        const accessToken = jwt.sign(userPayload, process.env.JWT_SECRET, {
            expiresIn: process.env.JWT_EXPIRES_IN || "30m",
        });
        const refreshToken = jwt.sign(
            { sub: String(claims.username), type: "refresh" },
            process.env.JWT_SECRET,
            { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "7d" },
        );

        return { user: userPayload, accessToken, refreshToken };
    }

    // ─── Default-password check ───────────────────────────────────────────────

    /**
     * True when the stored hash was produced from ADMIN_DEFAULT_PASSWORD — i.e. the
     * account still has its system-assigned password and must change it on login.
     * Returns false when the env var is unset or verification throws.
     * @param {string|null|undefined} passwordHash
     * @returns {Promise<boolean>}
     */
    static async _checkIsDefaultPassword(passwordHash) {
        const defaultPw = process.env.ADMIN_DEFAULT_PASSWORD;
        if (!defaultPw || !passwordHash) return false;
        try {
            return await CryptoVault.verifyPassword(defaultPw, passwordHash);
        } catch {
            return false;
        }
    }

    /**
     * Re-hashes an admin password with current Argon2 params on login when the
     * stored hash used weaker params. Best-effort — failures are logged, not thrown.
     * @param {object} admin
     * @param {string} plainPassword
     * @returns {Promise<void>}
     * @private
     */
    static async _maybeRehashAdmin(admin, plainPassword) {
        try {
            if (!CryptoVault.needsRehash || !CryptoVault.needsRehash(admin.PASSWORD)) return;
            const newHash = await CryptoVault.hashPassword(plainPassword);
            const sig = await CryptoVault.signRecord(
                AdminModel.SIGN_CONTEXT,
                AdminModel.buildSignedFields({ ...admin, PASSWORD: newHash }),
            );
            await AdminModel.updateCredentials(admin.USERNAME, newHash, sig);
            admin.PASSWORD = newHash; // keep in-memory row consistent
            logger.info(authMessages.HASH_UPGRADED(admin.USERNAME));
        } catch (err) {
            logger.warning(
                `Password rehash skipped for ${admin.USERNAME}: ${err?.message}`,
            );
        }
    }

    // ─── Change password ──────────────────────────────────────────────────────

    /**
     * Changes the caller's password (admin or user) while authenticated.
     * Verifies the current password, rejects the system default as the new value,
     * hashes + persists the new password (re-signing admin rows), and issues fresh
     * tokens with requiresPasswordChange=false.
     *
     * @param {string} username
     * @param {string} currentPassword
     * @param {string} newPassword
     * @returns {Promise<{ user: object, accessToken: string, refreshToken: string }>}
     */
    static async changePassword(username, currentPassword, newPassword) {
        const admin = await AdminModel.findByUsername(username);
        const account = admin || (await UserModel.findByUsername(username));
        if (!account) {
            throw new AppError(AUTH_ERRORS.USER_NOT_FOUND, HTTP_STATUS.NOT_FOUND, {
                type: "NotFoundError",
            });
        }

        // Admin rows: verify integrity before touching credentials.
        if (admin) {
            const sigValid = await CryptoVault.verifyRecord(
                AdminModel.SIGN_CONTEXT,
                AdminModel.buildSignedFields(admin),
                admin.SYSSIGNATURE,
            );
            if (!sigValid) {
                logger.warning(authMessages.SYS_SIGNATURE_TAMPERED_BLOCKED(username));
                throw new AppError(
                    AUTH_ERRORS.ACCOUNT_INTEGRITY_FAILED,
                    HTTP_STATUS.UNPROCESSABLE,
                    { type: "DataIntegrityError" },
                );
            }
        }

        const pwMatch = await CryptoVault.verifyPassword(currentPassword, account.PASSWORD);
        if (!pwMatch) {
            throw new AppError(AUTH_ERRORS.INVALID_CREDENTIALS, HTTP_STATUS.UNAUTHORIZED, {
                type: "AuthenticationError",
                hint: "The current password you entered is incorrect.",
            });
        }

        const defaultPw = process.env.ADMIN_DEFAULT_PASSWORD;
        if (defaultPw && newPassword === defaultPw) {
            logger.warning(authMessages.DEFAULT_PASSWORD_REJECTED(username));
            throw new AppError(
                ADMIN_ERRORS.DEFAULT_PASSWORD_FORBIDDEN,
                HTTP_STATUS.BAD_REQUEST,
                {
                    type: "ValidationError",
                    details: [
                        {
                            field: "newPassword",
                            issue: "Choose a password different from the system default.",
                        },
                    ],
                },
            );
        }

        const newHash = await CryptoVault.hashPassword(newPassword);

        if (admin) {
            const sig = await CryptoVault.signRecord(
                AdminModel.SIGN_CONTEXT,
                AdminModel.buildSignedFields({ ...admin, PASSWORD: newHash }),
            );
            await AdminModel.updateCredentials(username, newHash, sig);
        } else {
            await UserModel.updatePassword(username, newHash);
        }
        logger.info(authMessages.PASSWORD_CHANGED(username));

        const claims = admin
            ? AuthService._adminPayload({ ...admin, PASSWORD: newHash }, admin.ROLE, false)
            : AuthService._userPayload({ ...account, PASSWORD: newHash }, false);
        return AuthService._issueTokens(claims);
    }
}

module.exports = AuthService;
