"use strict";

/**
 * @fileoverview AuthService — standalone username/password authentication with
 * revocable, rotating sessions.
 *
 * Credentials live in two tables (or the in-memory demo store in DEMO_MODE):
 *
 *   T_ADMINS_DEV — privileged accounts (SUPER_ADMIN / ADMIN / USER) with a
 *                  tamper-evident SYSSIGNATURE. Checked first.
 *   T_USERS_DEV  — regular accounts. Always authenticate at USER level.
 *
 * Sessions: every refresh token is ONE-TIME (RefreshTokenService.rotate) and
 * belongs to a session family; reuse revokes the family. Refresh tokens carry a
 * credential epoch (`pwv`) so a token minted from an older password is refused.
 * Admin rows may hold a temporary password (adminTempPassword.js) that only
 * unlocks the change-password routes until it is replaced or expires.
 *
 * Public API (consumed by AuthControllers.js and AuthMiddleware):
 *   login, refresh, logout, getProfile, changePassword,
 *   accessCookieOptions, refreshCookieOptions, COOKIE_NAMES
 */

const jwt = require("jsonwebtoken");
const { randomUUID, timingSafeEqual } = require("crypto");
const { AppError, AUTH_ERRORS, ADMIN_ERRORS } = require("../constants/errors");
const { HTTP_STATUS } = require("../constants");
const { logger } = require("../utils/logger");
const { authMessages, adminMessages } = require("../constants/messages");
const { CryptoVault } = require("../utils/encryption/CryptoVault");
const {
    parseStoredAdminPassword,
    isTemporaryExpired,
} = require("../utils/encryption/adminTempPassword");
const AdminModel = require("../models/admin.model");
const UserModel = require("../models/user.model");
const {
    loginLockout,
} = require("../middleware/authentication/LoginLockoutMiddleware");
const { registry, CacheKeyBuilder } = require("../middleware/cache");
const {
    COOKIE_NAMES,
    TOKEN_TYPES,
    TOKEN_ISSUER,
    TOKEN_AUDIENCES,
    REFRESH_REVOKE_REASONS,
    ACCESS_TOKEN_DEFAULT_EXPIRES_IN,
} = require("../constants/authTokens");
const { hashJti, credentialEpoch, parseDuration } = require("../utils/auth/tokenClaims");
const { canonicalUserKey } = require("../utils/auth/userKey");
const { refreshTokenRegistry } = require("../utils/auth/RefreshTokenRegistry");
const RefreshTokenService = require("./RefreshTokenService");

/** Which table authenticated the session — carried as the refresh token's `rs` claim. */
const ROLE_SOURCES = Object.freeze({ ADMIN: "admin", USER: "user" });

// The authProfile CacheStore (TTL 30s), or null when unregistered (unit tests
// that load the service without app.js). Only the extracted flag object is
// cached — never the account row, which contains the password hash.
function _profileFlagsStore() {
    try {
        return registry.resolve("authProfile");
    } catch (_) {
        return null;
    }
}

class AuthService {
    // Re-export: the constant lives in constants/authTokens.js so the rate
    // limiters can read it without importing this service.
    static COOKIE_NAMES = COOKIE_NAMES;

    static ROLE_SOURCES = ROLE_SOURCES;

    // ─── Public API ───────────────────────────────────────────────────────────

    /**
     * Authenticates a username/password pair. Admins (T_ADMINS_DEV) are checked
     * before regular users (T_USERS_DEV); the table that matched decides the role.
     *
     * @param {string} userId - Login identifier (USERNAME)
     * @param {string} password
     * @returns {Promise<{ user: object, accessToken: string, refreshToken: string, refreshRecord: object }>}
     */
    static async login(userId, password) {
        const lockState = await loginLockout.checkAsync(userId);

        if (lockState.hrReset) {
            throw new AppError(AUTH_ERRORS.ACCOUNT_LOCKED_PERMANENTLY, 423, {
                type: "AccountLockedError",
            });
        }

        if (lockState.locked) {
            throw new AppError(AUTH_ERRORS.ACCOUNT_LOCKED, 429, {
                type: "AccountLockedError",
                details: [
                    { field: "retryAfter", issue: `${lockState.retryAfter}` },
                ],
            });
        }

        const admin = await AdminModel.findByUsername(userId);
        if (admin) return AuthService._loginAdmin(admin, userId, password);

        const user = await UserModel.findByUsername(userId);
        if (user) return AuthService._loginUser(user, userId, password);

        // Unknown username — same error and the same hash cost as a wrong
        // password, so neither the message nor the timing enumerates accounts.
        await AuthService._equaliseHashWork(password);
        await loginLockout.recordFailureAsync(userId);
        throw new AppError(AUTH_ERRORS.INVALID_CREDENTIALS, 401, {
            type: "AuthenticationError",
        });
    }

    /**
     * Issues a fresh token pair from the stored refresh token, re-reading the
     * account so role, active-state and password changes take effect.
     *
     * The presented token is ONE-TIME: it is consumed in both revocation tiers
     * (RefreshTokenService.rotate); presenting it again revokes the whole
     * session family (reuse detection, no grace window).
     *
     * @param {string} refreshToken
     * @returns {Promise<{ user: object, accessToken: string, refreshToken: string, refreshRecord: object }>}
     * @throws {AppError} 403 invalid token; 401 revoked / reused / account gone
     */
    static async refresh(refreshToken) {
        let decoded;
        try {
            decoded = jwt.verify(refreshToken, process.env.JWT_SECRET, {
                algorithms: ["HS256"],
                audience: TOKEN_AUDIENCES.REFRESH,
                issuer: TOKEN_ISSUER,
            });
        } catch {
            throw new AppError(AUTH_ERRORS.TOKEN_INVALID, 403, {
                type: "AuthenticationError",
                hint: "Refresh token is invalid or expired. Please log in again.",
            });
        }

        if (
            decoded.type !== TOKEN_TYPES.REFRESH ||
            typeof decoded.jti !== "string" ||
            decoded.jti === "" ||
            typeof decoded.fid !== "string" ||
            decoded.fid === ""
        ) {
            throw new AppError(AUTH_ERRORS.TOKEN_INVALID, 403, {
                type: "AuthenticationError",
            });
        }

        const userId = decoded.sub;

        // A session is only ever refreshed from the table that authenticated
        // it: a user session can never be re-issued with an admin role it never
        // proved, and an admin whose row is gone does not degrade silently.
        if (decoded.rs === ROLE_SOURCES.ADMIN) {
            const admin = await AdminModel.findByUsername(userId);
            if (!admin) {
                throw new AppError(AUTH_ERRORS.USER_NOT_FOUND, 401, {
                    type: "AuthenticationError",
                });
            }
            AuthService._assertAdminActive(admin, userId);
            await AuthService._assertAdminSignature(admin, userId, "refresh");
            await AuthService._assertCredentialEpoch(decoded, admin.PASSWORD);

            const passwordState = await AuthService._adminPasswordState(admin, userId, "refresh");
            return AuthService._rotateInto(decoded, {
                ...AuthService._adminClaims(admin),
                credentialHash: admin.PASSWORD,
                ...passwordState,
            });
        }

        const user = await UserModel.findByUsername(userId);
        if (!user) {
            throw new AppError(AUTH_ERRORS.USER_NOT_FOUND, 401, {
                type: "AuthenticationError",
            });
        }
        AuthService._assertUserActive(user, userId);
        await AuthService._assertCredentialEpoch(decoded, user.PASSWORD);

        const isDefaultPassword = await AuthService._checkIsDefaultPassword(user.PASSWORD);
        return AuthService._rotateInto(decoded, {
            ...AuthService._userClaims(user),
            credentialHash: user.PASSWORD,
            isDefaultPassword,
            requiresPasswordChange: isDefaultPassword,
        });
    }

    /**
     * Ends the caller's session family. Best effort: when the DB is down the
     * request still succeeds (cookies are cleared by the controller) and the
     * failure is logged — the refresh cookie is path-scoped, so the access-token
     * `fid` claim is how the family is found.
     *
     * @param {object} user - verified access-token payload (req.user)
     * @returns {Promise<void>}
     */
    static async logout(user) {
        if (!user?.userId) return;
        if (user.fid) {
            await RefreshTokenService.revokeFamily(
                user.fid,
                REFRESH_REVOKE_REASONS.LOGOUT,
                { bestEffort: true, retryTransient: true },
            );
        }
        logger.info(authMessages.AUTH_LOGOUT(user.userId));
    }

    /**
     * Returns the caller's profile for GET /auth/me with admin permission flags
     * refreshed from T_ADMINS_DEV at read time, so the UI never contradicts a
     * permission change made mid-session (the server re-checks at action time
     * regardless).
     *
     * Best effort: on lookup failure the token payload is returned unchanged.
     *
     * @param {object} decodedUser - req.user (verified JWT payload)
     * @returns {Promise<object>}
     */
    static async getProfile(decodedUser) {
        try {
            // USER sessions never carry admin flags.
            if (decodedUser?.role === "USER") return decodedUser;
            // `false` is cached as the "not an admin" sentinel — getOrSet skips
            // storing null/undefined.
            const store = _profileFlagsStore();
            const loadFlags = async () => {
                const admin = await AdminModel.findByUsername(decodedUser.userId);
                return admin ? AuthService._extractPermissionFlags(admin) : false;
            };
            const flags = store
                ? await store.getOrSet(
                      CacheKeyBuilder.build("authProfile", {
                          username: decodedUser.userId,
                      }),
                      loadFlags,
                  )
                : await loadFlags();

            if (!flags) return decodedUser;
            return { ...decodedUser, permissions: flags };
        } catch (err) {
            logger.warning(
                authMessages.PROFILE_FLAG_REFRESH_FAILED(
                    decodedUser?.userId,
                    err.message,
                ),
            );
            return decodedUser;
        }
    }

    // ─── Cookie option helpers (used by the controller) ───────────────────────

    static accessCookieOptions() {
        // In production cookies are always Secure — the app may sit behind a
        // TLS-terminating proxy where USE_HTTPS=false.
        const isProduction = process.env.NODE_ENV === "production";
        const secure = process.env.USE_HTTPS === "true" || isProduction;

        return {
            httpOnly: true,
            secure,
            sameSite: "strict",
            signed: true,
            maxAge: AuthService._parseDuration(
                process.env.JWT_EXPIRES_IN || ACCESS_TOKEN_DEFAULT_EXPIRES_IN,
            ),
        };
    }

    static refreshCookieOptions() {
        const isProduction = process.env.NODE_ENV === "production";
        const secure = process.env.USE_HTTPS === "true" || isProduction;

        return {
            httpOnly: true,
            secure,
            sameSite: "strict",
            signed: true,
            path: "/api/v1/auth/refresh",
            maxAge: 7 * 24 * 60 * 60 * 1000, // 7 d
        };
    }

    /**
     * Converts a JWT-style duration string (s/m/h/d) to milliseconds.
     *
     * @param {string} str - e.g. '30m', '8h', '7d', '60s'
     * @returns {number}
     * @throws {Error} When the format is unrecognised
     */
    static _parseDuration(str) {
        return parseDuration(str);
    }

    // ─── Login helpers ────────────────────────────────────────────────────────

    static async _loginAdmin(admin, userId, password) {
        AuthService._assertAdminActive(admin, userId);
        // Integrity before any password comparison — a tampered row is refused
        // without becoming a timing oracle.
        await AuthService._assertAdminSignature(admin, userId, "login");

        // Handles argon2, bcrypt, legacy TripleDES (rehash-on-match) and the
        // temporary-password marker.
        const {
            matched,
            newHash,
            expired: tempExpired,
        } = await CryptoVault.verifyAdminPassword(password, admin.PASSWORD);
        if (tempExpired) {
            AuthService._refuseExpiredTemporary(userId, "login");
        }
        if (!matched) {
            await loginLockout.recordFailureAsync(userId);
            throw new AppError(AUTH_ERRORS.INVALID_CREDENTIALS, 401, {
                type: "AuthenticationError",
            });
        }

        let credentialHash = admin.PASSWORD;
        const upgradeHash =
            newHash ??
            (CryptoVault.adminNeedsRehash(admin.PASSWORD) &&
            !parseStoredAdminPassword(admin.PASSWORD).temporary
                ? await CryptoVault.hashAdminPassword(password)
                : null);
        if (upgradeHash && (await AuthService._persistAdminHashUpgrade(admin, upgradeHash))) {
            credentialHash = upgradeHash;
        }

        const passwordState = await AuthService._adminPasswordState(admin, userId, "login");

        logger.info(authMessages.AUTH_SUCCESS(userId));
        const tokens = AuthService._issueTokens({
            ...AuthService._adminClaims(admin),
            credentialHash,
            ...passwordState,
        });

        await AuthService._persistSession(tokens);
        await loginLockout.recordSuccessAsync(userId);
        return tokens;
    }

    static async _loginUser(user, userId, password) {
        AuthService._assertUserActive(user, userId);

        const matched = await CryptoVault.verifyPassword(password, user.PASSWORD);
        if (!matched) {
            await loginLockout.recordFailureAsync(userId);
            throw new AppError(AUTH_ERRORS.INVALID_CREDENTIALS, 401, {
                type: "AuthenticationError",
            });
        }

        const isDefaultPassword = await AuthService._checkIsDefaultPassword(user.PASSWORD);

        logger.info(authMessages.AUTH_SUCCESS(userId));
        const tokens = AuthService._issueTokens({
            ...AuthService._userClaims(user),
            credentialHash: user.PASSWORD,
            isDefaultPassword,
            requiresPasswordChange: isDefaultPassword,
        });

        await AuthService._persistSession(tokens);
        await loginLockout.recordSuccessAsync(userId);
        return tokens;
    }

    /**
     * Runs one admin-password verification against a throwaway hash so an
     * unknown username costs the same as a known one with a wrong password
     * (CWE-208). Never throws and never affects the outcome.
     *
     * @param {string} password
     * @returns {Promise<void>}
     * @private
     */
    static async _equaliseHashWork(password) {
        try {
            AuthService._dummyAdminHash ??= CryptoVault.hashAdminPassword(
                `dummy-${Date.now()}-${Math.random()}`,
            );
            await CryptoVault.verifyAdminPassword(
                password,
                await AuthService._dummyAdminHash,
            );
        } catch {
            // Timing padding only — a failure here must not change the 401.
        }
    }

    // ─── Account gates ────────────────────────────────────────────────────────

    /** Throws 403 when the admin row is deactivated (IS_ACTIVE='N'). */
    static _assertAdminActive(admin, userId) {
        if (String(admin.IS_ACTIVE ?? "Y") === "N") {
            logger.warning(adminMessages.ADMIN_INACTIVE_LOGIN_BLOCKED(userId));
            throw new AppError(ADMIN_ERRORS.ACCOUNT_INACTIVE, 403, {
                type: "AuthorizationError",
            });
        }
    }

    /** Throws 403 when the user row is deactivated (IS_ACTIVE='N'). */
    static _assertUserActive(user, userId) {
        if (String(user.IS_ACTIVE ?? "Y") === "N") {
            logger.warning(authMessages.ACCOUNT_INACTIVE_BLOCKED(userId));
            throw new AppError(AUTH_ERRORS.ACCOUNT_INACTIVE, 403, {
                type: "AuthorizationError",
            });
        }
    }

    /**
     * Verifies the admin row's SYSSIGNATURE. A broken signature means the row
     * was edited outside the application: login and change-password answer 422,
     * refresh answers 403 (the session ends).
     *
     * @param {object} admin
     * @param {string} userId
     * @param {'login'|'refresh'|'change-password'} stage
     * @returns {Promise<void>}
     * @private
     */
    static async _assertAdminSignature(admin, userId, stage) {
        const sigValid = await CryptoVault.verifyRecord(
            AdminModel.SIGN_CONTEXT,
            AdminModel.buildSignedFields(admin),
            admin.SYSSIGNATURE,
        );
        if (sigValid) return;

        logger.warning(authMessages.SYS_SIGNATURE_TAMPERED_BLOCKED(userId));
        if (stage === "refresh") {
            throw new AppError(AUTH_ERRORS.FORBIDDEN_ACCESS, 403, {
                type: "AuthorizationError",
            });
        }
        throw new AppError(
            AUTH_ERRORS.ACCOUNT_INTEGRITY_FAILED,
            HTTP_STATUS.UNPROCESSABLE,
            { type: "DataIntegrityError" },
        );
    }

    // ─── Forced password change (temporary / default) ─────────────────────────

    /** Token fields for a session that owes no password change. */
    static _NO_PASSWORD_CHANGE = Object.freeze({
        isDefaultPassword: false,
        isTemporaryPassword: false,
        temporaryPasswordExpiresAt: null,
        requiresPasswordChange: false,
    });

    /**
     * Throws the "temporary password expired" refusal. Reached only AFTER the
     * password was proved, so the distinct message leaks nothing to a guesser.
     * Deliberately NOT a lockout failure — what the person needs is a reissue.
     *
     * @param {string} userId
     * @param {'login'|'refresh'|'change-password'} stage
     * @throws {AppError} 401 TemporaryPasswordExpiredError
     * @private
     */
    static _refuseExpiredTemporary(userId, stage) {
        logger.warning(authMessages.TEMP_PASSWORD_EXPIRED(userId, stage));
        throw new AppError(AUTH_ERRORS.TEMP_PASSWORD_EXPIRED, HTTP_STATUS.UNAUTHORIZED, {
            type: "TemporaryPasswordExpiredError",
            hint: "An administrator can issue a new temporary password with Reset Password.",
        });
    }

    /**
     * Password-change claims for an admin session, derived from the STORED row
     * so login and refresh can never disagree:
     *   - temporary password marker → restricted; expired → refused
     *   - ADMIN_DEFAULT_PASSWORD still stored → restricted
     *
     * @param {object} admin - signature-verified T_ADMINS_DEV row
     * @param {string} userId
     * @param {'login'|'refresh'} stage
     * @returns {Promise<{ isDefaultPassword: boolean, isTemporaryPassword: boolean, temporaryPasswordExpiresAt: string|null, requiresPasswordChange: boolean }>}
     * @throws {AppError} 401 when a temporary password has expired
     * @private
     */
    static async _adminPasswordState(admin, userId, stage) {
        const parsed = parseStoredAdminPassword(admin.PASSWORD);
        if (parsed.temporary) {
            if (isTemporaryExpired(parsed)) {
                AuthService._refuseExpiredTemporary(userId, stage);
            }
            if (stage === "login") logger.info(authMessages.TEMP_PASSWORD_LOGIN(userId));
            return {
                isDefaultPassword: false,
                isTemporaryPassword: true,
                temporaryPasswordExpiresAt: new Date(parsed.expiresAt).toISOString(),
                requiresPasswordChange: true,
            };
        }
        const isDefaultPassword = await AuthService._checkIsDefaultPassword(admin.PASSWORD);
        return {
            ...AuthService._NO_PASSWORD_CHANGE,
            isDefaultPassword,
            requiresPasswordChange: isDefaultPassword,
        };
    }

    /**
     * True when the stored hash was produced from ADMIN_DEFAULT_PASSWORD — the
     * account still has its system-assigned password and must change it.
     * False when the variable is unset or verification throws.
     *
     * @param {string|null|undefined} passwordHash
     * @returns {Promise<boolean>}
     * @private
     */
    static async _checkIsDefaultPassword(passwordHash) {
        const defaultPw = process.env.ADMIN_DEFAULT_PASSWORD;
        if (!defaultPw || !passwordHash) return false;
        try {
            const { matched } = await CryptoVault.verifyAdminPassword(
                defaultPw,
                passwordHash,
            );
            return matched;
        } catch {
            return false;
        }
    }

    /**
     * Persists an upgraded admin password hash (TripleDES migration or stronger
     * Argon2 parameters) and re-signs the row. Failures are logged, never thrown.
     *
     * @param {object} admin
     * @param {string} newHash
     * @returns {Promise<boolean>} true when the new hash is now the stored one
     * @private
     */
    static async _persistAdminHashUpgrade(admin, newHash) {
        try {
            const sysSignature = await CryptoVault.signRecord(
                AdminModel.SIGN_CONTEXT,
                AdminModel.buildSignedFields({ ...admin, PASSWORD: newHash }),
            );
            await AdminModel.updateCredentials(admin.USERNAME, newHash, sysSignature);
            logger.info(authMessages.HASH_UPGRADED(admin.USERNAME));
            return true;
        } catch (err) {
            logger.warning(
                `Admin hash upgrade failed for ${admin.USERNAME}: ${err?.message}`,
            );
            return false;
        }
    }

    // ─── Claims ───────────────────────────────────────────────────────────────

    /**
     * Maps a role to the numeric userLevel used by requireAccess predicates.
     * SUPER_ADMIN → 3, ADMIN → 2, everything else → 1.
     *
     * @param {string} role
     * @returns {number}
     */
    static _roleToUserLevel(role) {
        if (role === "SUPER_ADMIN") return 3;
        if (role === "ADMIN") return 2;
        return 1;
    }

    /**
     * Admin permission flags for UI hints (never a server-side gate — services
     * re-read the row at action time).
     *
     * @param {object|null} admin - T_ADMINS_DEV row
     * @returns {object}
     * @private
     */
    static _extractPermissionFlags(admin) {
        if (!admin) return {};
        return {
            canReceiveSrvCrit: String(admin.CAN_RECEIVE_SRV_CRIT ?? "N"),
            canReceiveSrvDeps: String(admin.CAN_RECEIVE_SRV_DEPS ?? "N"),
            canReceiveSrvRed: String(admin.CAN_RECEIVE_SRV_RED ?? "N"),
            canReceiveSrvSys: String(admin.CAN_RECEIVE_SRV_SYS ?? "N"),
            isActive: String(admin.IS_ACTIVE ?? "Y"),
        };
    }

    /** `_issueTokens` identity params for a (signature-verified) admin row. */
    static _adminClaims(admin) {
        return {
            id: Number(admin.ID) || null,
            userId: admin.USERNAME,
            firstName: null,
            lastName: null,
            email: admin.EMAIL ?? null,
            role: admin.ROLE,
            roleSource: ROLE_SOURCES.ADMIN,
            permissionFlags: AuthService._extractPermissionFlags(admin),
        };
    }

    /** `_issueTokens` identity params for a regular user row. */
    static _userClaims(user) {
        return {
            id: Number(user.ID) || null,
            userId: user.USERNAME,
            firstName: user.FIRST_NAME ?? null,
            lastName: user.LAST_NAME ?? null,
            email: user.EMAIL ?? null,
            role: "USER",
            roleSource: ROLE_SOURCES.USER,
            permissionFlags: {},
        };
    }

    // ─── Session ledger ───────────────────────────────────────────────────────

    /**
     * Issues the successor pair for a refresh and consumes the presented token.
     * The successor continues the SAME session family (`fid`); when rotation
     * fails RefreshTokenService throws 401 and the minted pair is discarded.
     *
     * @param {object} decoded - verified refresh-token payload (sub, jti, fid)
     * @param {object} params - `_issueTokens` params (no familyId)
     * @returns {Promise<{ user: object, accessToken: string, refreshToken: string, refreshRecord: object }>}
     * @private
     */
    static async _rotateInto(decoded, params) {
        const tokens = AuthService._issueTokens({ ...params, familyId: decoded.fid });
        await RefreshTokenService.rotate(
            { jti: decoded.jti, familyId: decoded.fid, userId: decoded.sub },
            tokens.refreshRecord,
        );
        // Logged only after a successful rotation (CWE-778).
        logger.info(authMessages.TOKEN_REFRESHED(decoded.sub));
        return tokens;
    }

    /**
     * Credential-epoch gate (CWE-367 / CWE-613). The refresh token's `pwv` must
     * equal the epoch of the CURRENT stored password hash; otherwise the token
     * was minted from a password that has since changed. The family is revoked
     * best-effort and the refresh refused. Never logs pwv.
     *
     * @param {object} decoded - verified refresh payload
     * @param {string|null|undefined} storedHash - freshly read password hash
     * @returns {Promise<void>}
     * @throws {AppError} 401 REFRESH_TOKEN_REVOKED
     * @private
     */
    static async _assertCredentialEpoch(decoded, storedHash) {
        const expected = credentialEpoch(storedHash);
        const presented = typeof decoded.pwv === "string" ? decoded.pwv : "";
        if (expected !== null) {
            const a = Buffer.from(presented, "utf8");
            const b = Buffer.from(expected, "utf8");
            if (a.length === b.length && timingSafeEqual(a, b)) return;
        }
        await RefreshTokenService.revokeFamily(
            decoded.fid,
            REFRESH_REVOKE_REASONS.PASSWORD_CHANGE,
            { bestEffort: true },
        );
        logger.warning(authMessages.REFRESH_TOKEN_REJECTED(decoded.sub, "credential-epoch"));
        throw new AppError(AUTH_ERRORS.REFRESH_TOKEN_REVOKED, 401, {
            type: "AuthenticationError",
        });
    }

    /**
     * Records a newly issued session (login / change-password) and
     * opportunistically purges long-expired rows. Persist FAILS CLOSED; purge is
     * best effort.
     *
     * @param {{refreshRecord: object}} tokens
     * @returns {Promise<void>}
     * @private
     */
    static async _persistSession(tokens) {
        await RefreshTokenService.persistIssued(tokens.refreshRecord);
        await RefreshTokenService.purgeExpired();
    }

    /**
     * Builds and signs both JWTs. The access token carries the profile plus
     * `type:"access"`, `aud`, `iss` and the family id `fid`; the refresh token
     * carries sub + type + rs + fid (+ the `pwv` credential epoch), a unique
     * `jti`, `aud` and `iss`.
     *
     * Stays SYNCHRONOUS: the per-process registry is registered here; the DB
     * row is written by the async callers via `RefreshTokenService.persistIssued`.
     *
     * @param {object} params
     * @param {number|null} params.id          - numeric account id (audit USER_ID, alert ACKED_BY)
     * @param {string} params.userId           - USERNAME
     * @param {string|null} params.firstName
     * @param {string|null} params.lastName
     * @param {string|null} params.email
     * @param {string} params.role
     * @param {'admin'|'user'} params.roleSource - table that authenticated the session
     * @param {string} [params.credentialHash] - stored hash the session was authenticated against
     * @param {boolean} [params.isDefaultPassword=false]
     * @param {boolean} [params.isTemporaryPassword=false]
     * @param {string|null} [params.temporaryPasswordExpiresAt=null]
     * @param {boolean} [params.requiresPasswordChange=false] - AuthMiddleware
     *   refuses every route but the password-change ones while this is true
     * @param {object} [params.permissionFlags={}] - UI hints only
     * @param {string} [params.familyId] - session family to continue (refresh)
     * @returns {{ user: object, accessToken: string, refreshToken: string, refreshRecord: object }}
     */
    static _issueTokens({
        id = null,
        userId,
        firstName = null,
        lastName = null,
        email = null,
        role,
        roleSource,
        credentialHash,
        isDefaultPassword = false,
        isTemporaryPassword = false,
        temporaryPasswordExpiresAt = null,
        requiresPasswordChange = false,
        permissionFlags = {},
        familyId,
    }) {
        const pwv = credentialEpoch(credentialHash);
        const userPayload = {
            sub: String(userId),
            userId: String(userId),
            id,
            username: String(userId),
            userLevel: AuthService._roleToUserLevel(role),
            firstName,
            lastName,
            email,
            role,
            loginSource: roleSource,
            roleSource,
            isDefaultPassword,
            isTemporaryPassword,
            temporaryPasswordExpiresAt,
            requiresPasswordChange,
            permissions: permissionFlags,
        };

        const fid = familyId ?? randomUUID();
        const jti = randomUUID();

        // The returned `user` stays free of type/aud/iss/fid: it is the login
        // response body, not a credential.
        const accessToken = jwt.sign(
            {
                ...userPayload,
                type: TOKEN_TYPES.ACCESS,
                fid,
            },
            process.env.JWT_SECRET,
            {
                algorithm: "HS256",
                expiresIn: process.env.JWT_EXPIRES_IN || ACCESS_TOKEN_DEFAULT_EXPIRES_IN,
                audience: TOKEN_AUDIENCES.ACCESS,
                issuer: TOKEN_ISSUER,
            },
        );

        const refreshToken = jwt.sign(
            {
                sub: String(userId),
                type: TOKEN_TYPES.REFRESH,
                rs: roleSource,
                fid,
                ...(pwv ? { pwv } : {}),
            },
            process.env.JWT_SECRET,
            {
                algorithm: "HS256",
                expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "7d",
                jwtid: jti,
                audience: TOKEN_AUDIENCES.REFRESH,
                issuer: TOKEN_ISSUER,
            },
        );

        const decoded = jwt.decode(refreshToken);
        const refreshRecord = {
            jtiHash: hashJti(jti),
            familyId: fid,
            userId: String(userId),
            userKey: canonicalUserKey(userId),
            roleSource,
            issuedAtMs: decoded.iat * 1000,
            expiresAtMs: decoded.exp * 1000,
        };
        refreshTokenRegistry.register({
            jtiHash: refreshRecord.jtiHash,
            familyId: fid,
            userKey: refreshRecord.userKey,
            expiresAtMs: refreshRecord.expiresAtMs,
        });

        return { user: userPayload, accessToken, refreshToken, refreshRecord };
    }

    // ─── Change password ──────────────────────────────────────────────────────

    /**
     * Changes the caller's password (admin or user) while authenticated.
     * Verifies the current password, refuses the system default and a reused
     * temporary password, ends every older session, persists the new hash
     * (re-signing admin rows) and issues fresh tokens.
     *
     * @param {string} userId
     * @param {string} currentPassword
     * @param {string} newPassword
     * @returns {Promise<{ user: object, accessToken: string, refreshToken: string, refreshRecord: object }>}
     * @throws {AppError} 404 not found; 403 inactive; 422 signature invalid;
     *   401 wrong current password / expired temporary; 400 default or reused password
     */
    static async changePassword(userId, currentPassword, newPassword) {
        const admin = await AdminModel.findByUsername(userId);
        const user = admin ? null : await UserModel.findByUsername(userId);
        if (!admin && !user) {
            throw new AppError(AUTH_ERRORS.USER_NOT_FOUND, HTTP_STATUS.NOT_FOUND, {
                type: "NotFoundError",
            });
        }

        // A revoked account still holding an unexpired access token must not
        // rotate the password and mint a fresh token (CWE-613).
        let currentIsTemporary = false;
        if (admin) {
            AuthService._assertAdminActive(admin, userId);
            await AuthService._assertAdminSignature(admin, userId, "change-password");

            const {
                matched,
                temporary,
                expired: tempExpired,
            } = await CryptoVault.verifyAdminPassword(currentPassword, admin.PASSWORD);
            // A restricted token can outlive the temporary window; the stored
            // expiry, not the token, decides.
            if (tempExpired) {
                AuthService._refuseExpiredTemporary(userId, "change-password");
            }
            if (!matched) AuthService._refuseWrongCurrentPassword();
            currentIsTemporary = temporary === true;
        } else {
            AuthService._assertUserActive(user, userId);
            const matched = await CryptoVault.verifyPassword(currentPassword, user.PASSWORD);
            if (!matched) AuthService._refuseWrongCurrentPassword();
        }

        const defaultPw = process.env.ADMIN_DEFAULT_PASSWORD;
        if (defaultPw && newPassword === defaultPw) {
            logger.warning(authMessages.DEFAULT_PASSWORD_REJECTED(userId));
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

        // Re-using the emailed temporary password would leave the credential
        // sitting in a mailbox indefinitely.
        if (currentIsTemporary && newPassword === currentPassword) {
            throw new AppError(
                AUTH_ERRORS.NEW_PASSWORD_SAME_AS_TEMPORARY,
                HTTP_STATUS.BAD_REQUEST,
                {
                    type: "ValidationError",
                    details: [
                        {
                            field: "newPassword",
                            issue: "Must differ from the temporary password.",
                        },
                    ],
                },
            );
        }

        // Every older session dies with the old password (CWE-613). Fail
        // closed: if the revoke cannot be recorded the password is NOT changed.
        await RefreshTokenService.revokeAllForUser(
            userId,
            REFRESH_REVOKE_REASONS.PASSWORD_CHANGE,
        );

        let claims;
        let newHash;
        if (admin) {
            newHash = await CryptoVault.hashAdminPassword(newPassword);
            const sysSignature = await CryptoVault.signRecord(
                AdminModel.SIGN_CONTEXT,
                AdminModel.buildSignedFields({ ...admin, PASSWORD: newHash }),
            );
            await AdminModel.updateCredentials(admin.USERNAME, newHash, sysSignature);
            // Re-read to pick up flag changes made since login.
            const fresh = (await AdminModel.findByUsername(userId)) ?? admin;
            claims = AuthService._adminClaims(fresh);
        } else {
            newHash = await CryptoVault.hashPassword(newPassword);
            await UserModel.updatePassword(user.USERNAME, newHash);
            claims = AuthService._userClaims(user);
        }
        logger.info(authMessages.PASSWORD_CHANGED(userId));
        if (currentIsTemporary) logger.info(authMessages.TEMP_PASSWORD_REPLACED(userId));

        const tokens = AuthService._issueTokens({
            ...claims,
            credentialHash: newHash,
            ...AuthService._NO_PASSWORD_CHANGE,
        });
        await AuthService._persistSession(tokens);
        return tokens;
    }

    /** @throws {AppError} 401 — the current password did not verify. */
    static _refuseWrongCurrentPassword() {
        throw new AppError(
            AUTH_ERRORS.INVALID_CREDENTIALS,
            HTTP_STATUS.UNAUTHORIZED,
            {
                type: "AuthenticationError",
                hint: "The current password you entered is incorrect.",
            },
        );
    }
}

module.exports = AuthService;
