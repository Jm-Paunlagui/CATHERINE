"use strict";

const jwt = require("jsonwebtoken");
const { AppError, AUTH_ERRORS, ADMIN_ERRORS, VALIDATION_ERRORS } = require("../constants/errors");
const { HTTP_STATUS } = require("../constants");
const { logger } = require("../utils/logger");
const { authMessages, adminMessages } = require("../constants/messages");
const {
    CryptoVault,
    SymmetricCrypto,
} = require("../utils/encryption/CryptoVault");
const HrisUaModel = require("../models/hris.ua.model");
const MealAdmModel = require("../models/meal.adm.model");
const {
    loginLockout,
} = require("../middleware/authentication/LoginLockoutMiddleware");
const { registry, CacheKeyBuilder } = require("../middleware/cache");

// ─── /auth/me profile-flags cache helper ──────────────────────────────────────
// Returns the authProfile CacheStore (TTL 30s), or null when unregistered
// (unit tests that bootstrap the service without loading app.js). Only the
// extracted permission-flag object is cached — never the raw T_EMP_MGMT_ADMIN
// row, which contains the password hash. Flags are UI hints only (never
// server-side gates), so 30s staleness is harmless; flag writes invalidate
// the key surgically at the MealAdmModel write chokepoint anyway.
function _profileFlagsStore() {
    try {
        return registry.resolve("authProfile");
    } catch (_) {
        return null;
    }
}

class AuthService {
    // ─── Cookie name constants (single source of truth) ───────────────────────
    static COOKIE_NAMES = {
        ACCESS: "meal.access-token",
        REFRESH: "meal.refresh-token",
    };

    // ─── Public API ───────────────────────────────────────────────────────────

    /**
     * Authenticates a user.
     *
     * Primary path  : U_USERS (userAccount DB) — TripleDES-encrypted password.
     * Fallback path : T_EMP_MGMT_ADMIN (Meal DB) — hashed password (bcrypt or argon2).
     *
     * @param {string} userId
     * @param {string} password  - Plaintext password supplied by the user
     * @returns {Promise<{ user: object, accessToken: string, refreshToken: string }>}
     */
    static async login(userId, password) {
        // ── Lockout gate ──────────────────────────────────────────────────────
        const lockState = loginLockout.check(userId);

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

        // ── Credential check ──────────────────────────────────────────────────
        const uaUser = await HrisUaModel.findByUserId(userId);

        if (uaUser) {
            logger.info(authMessages.AUTH_UA_PRIMARY(userId));
            return AuthService._loginViaUa(uaUser, userId, password);
        }

        // adminMessages used in the meal-only login path below

        logger.info(authMessages.AUTH_FALLBACK_MEAL(userId));
        return AuthService._loginViaMeal(userId, password);
    }

    /**
     * Issues a fresh access + refresh token pair using the stored refresh token.
     * Re-fetches user data so the new token reflects any role changes.
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

        const userId = decoded.sub;
        const uaUser = await HrisUaModel.findByUserId(userId);

        if (uaUser) {
            const [empAdmin, GID] = await Promise.all([
                MealAdmModel.findByEmpId(userId),
                MealAdmModel.findGidByEmpId(userId),
            ]);

            // IS_ACTIVE gate on refresh — deactivated admins cannot refresh
            // tokens on the UA path either (mirrors the meal fallback below).
            if (empAdmin && String(empAdmin.IS_ACTIVE ?? "Y") === "N") {
                throw new AppError(ADMIN_ERRORS.ACCOUNT_INACTIVE, 403, {
                    type: "AuthorizationError",
                });
            }

            const role = await AuthService._resolveRole(empAdmin);
            logger.info(authMessages.TOKEN_REFRESHED(userId));
            return AuthService._issueTokens({
                userId,
                GID,
                firstName: uaUser.FIRSTNAME,
                lastName: uaUser.LASTNAME,
                segmentCode: uaUser.SEGMENT_CODE,
                segmentDesc: uaUser.SEGMENT_DESC,
                email: uaUser.EMAILADDRESS ?? null,
                role,
                loginSource: "ua",
                // Without this, a refreshed token silently drops the flags and
                // the UI falls back to its permissive 'Y' defaults.
                permissionFlags: AuthService._extractPermissionFlags(empAdmin),
            });
        }

        // Fallback: meal-only account
        const [empAdmin, GID] = await Promise.all([
            MealAdmModel.findByEmpId(userId),
            MealAdmModel.findGidByEmpId(userId),
        ]);
        if (!empAdmin) {
            throw new AppError(AUTH_ERRORS.USER_NOT_FOUND, 401, {
                type: "AuthenticationError",
            });
        }

        // IS_ACTIVE gate on refresh — deactivated admins cannot refresh tokens
        if (String(empAdmin.IS_ACTIVE ?? "Y") === "N") {
            throw new AppError(ADMIN_ERRORS.ACCOUNT_INACTIVE, 403, {
                type: "AuthorizationError",
            });
        }

        const sigValid = await CryptoVault.verifyRecord(
            "T_EMP_MGMT_ADMIN",
            MealAdmModel.buildSignedFields(empAdmin),
            empAdmin.SYSSIGNATURE,
        );
        if (!sigValid) {
            logger.warning(authMessages.SYS_SIGNATURE_TAMPERED_BLOCKED(userId));
            throw new AppError(AUTH_ERRORS.FORBIDDEN_ACCESS, 403, {
                type: "AuthorizationError",
            });
        }

        logger.info(authMessages.TOKEN_REFRESHED(userId));
        return AuthService._issueTokens({
            userId:     empAdmin.EMP_ID,
            GID,
            firstName:  null,
            lastName:   null,
            segmentCode: null,
            segmentDesc: null,
            email:      null,
            role:       empAdmin.EMP_ROLE,
            loginSource: "meal",
            permissionFlags: AuthService._extractPermissionFlags(empAdmin),
        });
    }

    /**
     * Returns the caller's profile for GET /auth/me with permission flags
     * refreshed from T_EMP_MGMT_ADMIN at read time.
     *
     * JWT claims are frozen at login. If a SUPER_ADMIN changes an admin's
     * flags mid-session, the token keeps the stale values until re-login —
     * but the server-side gates re-read the DB on every action. Serving the
     * raw token payload here makes the UI contradict the server: buttons
     * render enabled and then 403, and "no permission" notices never show.
     * Refreshing the flags on /auth/me keeps the UI honest within one page
     * load of any permission change.
     *
     * Best-effort: on lookup failure the token payload is returned unchanged —
     * /auth/me must never break an otherwise valid session. Users with no
     * admin row (plain HRIS users) are returned unchanged too.
     *
     * @param {object} decodedUser - req.user (verified JWT payload)
     * @returns {Promise<object>} profile with up-to-date `permissions`
     */
    static async getProfile(decodedUser) {
        try {
            // Cached + coalesced: GET /me is hit on every page focus, and under
            // a burst of concurrent loads the identical T_EMP_MGMT_ADMIN lookup
            // would otherwise run once per request. `false` is cached as the
            // negative sentinel ("not an admin") because getOrSet skips storing
            // null/undefined — without it, regular employees (the majority,
            // who have no admin row) would never benefit from the cache.
            const store = _profileFlagsStore();
            const loadFlags = async () => {
                const empAdmin = await MealAdmModel.findByEmpId(
                    decodedUser.userId,
                );
                return empAdmin
                    ? AuthService._extractPermissionFlags(empAdmin)
                    : false;
            };
            const flags = store
                ? await store.getOrSet(
                      CacheKeyBuilder.build("authProfile", {
                          empId: decodedUser.userId,
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
        return {
            httpOnly: true,
            secure: process.env.USE_HTTPS === "true",
            sameSite: "strict",
            signed: true,
            maxAge: AuthService._parseDuration(
                process.env.JWT_EXPIRES_IN || "30m",
            ),
        };
    }

    /**
     * Converts a JWT-style duration string to milliseconds.
     * Supports s (seconds), m (minutes), h (hours), d (days).
     *
     * @param {string} str - e.g. '30m', '8h', '7d', '60s'
     * @returns {number} Duration in milliseconds
     * @throws {Error} When the format is unrecognised
     *
     * @example
     * AuthService._parseDuration('30m')  // 1_800_000
     * AuthService._parseDuration('8h')   // 28_800_000
     * AuthService._parseDuration('7d')   // 604_800_000
     */
    static _parseDuration(str) {
        const match = /^(\d+)([smhd])$/.exec(String(str).trim());
        if (!match) {
            throw new Error(
                `Unrecognised duration format: "${str}". Expected e.g. "30m", "8h", "7d".`,
            );
        }
        const value = parseInt(match[1], 10);
        const unit = match[2];
        const multipliers = {
            s: 1_000,
            m: 60_000,
            h: 3_600_000,
            d: 86_400_000,
        };
        return value * multipliers[unit];
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

    // ─── Private helpers ──────────────────────────────────────────────────────

    static async _loginViaUa(uaUser, userId, password) {
        const decrypted = SymmetricCrypto.SecurityCryptHelper.decryptText(
            uaUser.PASSWORD,
        );

        const hrisMatch = decrypted && decrypted === password;

        // If HRIS password didn't match, check if the user is an admin and
        // try the admin password from T_EMP_MGMT_ADMIN before rejecting.
        // This covers the scenario where a new admin was provisioned with
        // ADMIN_DEFAULT_PASSWORD and has not yet changed it — their HRIS
        // password and admin password are different credentials.
        const empAdmin = await MealAdmModel.findByEmpId(userId);

        if (!hrisMatch) {
            if (!empAdmin) {
                loginLockout.recordFailure(userId);
                throw new AppError(AUTH_ERRORS.INVALID_CREDENTIALS, 401, {
                    type: "AuthenticationError",
                });
            }

            // IS_ACTIVE gate — inactive admins cannot log in (migration v3.0)
            if (String(empAdmin.IS_ACTIVE ?? "Y") === "N") {
                logger.warning(
                    adminMessages.ADMIN_INACTIVE_LOGIN_BLOCKED(userId),
                );
                throw new AppError(ADMIN_ERRORS.ACCOUNT_INACTIVE, 403, {
                    type: "AuthorizationError",
                });
            }

            // Verify admin record integrity before attempting password check
            const sigValid = await CryptoVault.verifyRecord(
                "T_EMP_MGMT_ADMIN",
                MealAdmModel.buildSignedFields(empAdmin),
                empAdmin.SYSSIGNATURE,
            );
            if (!sigValid) {
                logger.warning(
                    authMessages.SYS_SIGNATURE_TAMPERED_BLOCKED(userId),
                );
                throw new AppError(
                    AUTH_ERRORS.ACCOUNT_INTEGRITY_FAILED,
                    HTTP_STATUS.UNPROCESSABLE,
                    { type: "DataIntegrityError" },
                );
            }

            // verifyAdminPassword handles bcrypt, argon2, and legacy TripleDES
            // with transparent rehash-on-match migration.
            const { matched: adminPwMatch, newHash } =
                await CryptoVault.verifyAdminPassword(
                    password,
                    empAdmin.EMP_PW,
                );
            if (!adminPwMatch) {
                loginLockout.recordFailure(userId);
                throw new AppError(AUTH_ERRORS.INVALID_CREDENTIALS, 401, {
                    type: "AuthenticationError",
                });
            }

            // Transparent migration: persist upgraded hash when TripleDES was stored
            if (newHash) {
                await AuthService._persistAdminHashUpgrade(
                    empAdmin,
                    newHash,
                );
            }

            logger.info(authMessages.AUTH_ADMIN_PASSWORD(userId));
        }

        const role = await AuthService._resolveRole(empAdmin);

        const isDefaultPassword = empAdmin
            ? await AuthService._checkIsDefaultPassword(empAdmin.EMP_PW)
            : false;
        const requiresPasswordChange = isDefaultPassword;

        // Resolve permanent GID — null for accounts not yet in T_EMP_MASTER_LIST
        const GID = await MealAdmModel.findGidByEmpId(userId);

        logger.info(authMessages.AUTH_SUCCESS(userId));

        const tokens = AuthService._issueTokens({
            userId,
            GID,
            firstName: uaUser.FIRSTNAME,
            lastName: uaUser.LASTNAME,
            segmentCode: uaUser.SEGMENT_CODE,
            segmentDesc: uaUser.SEGMENT_DESC,
            email: uaUser.EMAILADDRESS ?? null,
            role,
            loginSource: "ua",
            isDefaultPassword,
            requiresPasswordChange,
            permissionFlags: AuthService._extractPermissionFlags(empAdmin),
        });

        loginLockout.recordSuccess(userId);
        return tokens;
    }

    static async _loginViaMeal(userId, password) {
        const empAdmin = await MealAdmModel.findByEmpId(userId);

        if (!empAdmin) {
            // Intentionally vague — don't reveal which DB was checked
            loginLockout.recordFailure(userId);
            throw new AppError(AUTH_ERRORS.INVALID_CREDENTIALS, 401, {
                type: "AuthenticationError",
            });
        }

        // IS_ACTIVE gate — inactive admins cannot log in (migration v3.0).
        // Default 'Y' when the column is absent (pre-migration rows read as null).
        if (String(empAdmin.IS_ACTIVE ?? "Y") === "N") {
            logger.warning(adminMessages.ADMIN_INACTIVE_LOGIN_BLOCKED(userId));
            throw new AppError(ADMIN_ERRORS.ACCOUNT_INACTIVE, 403, {
                type: "AuthorizationError",
            });
        }

        // Integrity check: reject records with broken signatures before
        // attempting password comparison (prevents timing oracle on tampered rows)
        const sigValid = await CryptoVault.verifyRecord(
            "T_EMP_MGMT_ADMIN",
            MealAdmModel.buildSignedFields(empAdmin),
            empAdmin.SYSSIGNATURE,
        );
        if (!sigValid) {
            logger.warning(authMessages.SYS_SIGNATURE_TAMPERED_BLOCKED(userId));
            throw new AppError(
                AUTH_ERRORS.ACCOUNT_INTEGRITY_FAILED,
                HTTP_STATUS.UNPROCESSABLE,
                { type: "DataIntegrityError" },
            );
        }

        // verifyAdminPassword handles bcrypt, argon2, and legacy TripleDES
        // with transparent rehash-on-match migration.
        const { matched: pwMatch, newHash } =
            await CryptoVault.verifyAdminPassword(
                password,
                empAdmin.EMP_PW,
            );
        if (!pwMatch) {
            loginLockout.recordFailure(userId);
            throw new AppError(AUTH_ERRORS.INVALID_CREDENTIALS, 401, {
                type: "AuthenticationError",
            });
        }

        // Transparent migration: persist upgraded hash when TripleDES was stored
        if (newHash) {
            await AuthService._persistAdminHashUpgrade(empAdmin, newHash);
        }

        const isDefaultPassword = await AuthService._checkIsDefaultPassword(
            empAdmin.EMP_PW,
        );
        const requiresPasswordChange = isDefaultPassword;

        // Resolve permanent GID — null for admin-only accounts not in T_EMP_MASTER_LIST
        const GID = await MealAdmModel.findGidByEmpId(empAdmin.EMP_ID);

        logger.info(authMessages.AUTH_SUCCESS(userId));

        const tokens = AuthService._issueTokens({
            userId: empAdmin.EMP_ID,
            GID,
            firstName: null,
            lastName: null,
            segmentCode: null,
            segmentDesc: null,
            email: null,
            role: empAdmin.EMP_ROLE,
            loginSource: "meal",
            isDefaultPassword,
            requiresPasswordChange,
            permissionFlags: AuthService._extractPermissionFlags(empAdmin),
        });

        loginLockout.recordSuccess(userId);
        return tokens;
    }

    /**
     * Resolves the role from a T_EMP_MGMT_ADMIN record.
     * Falls back to "USER" if the record is missing or its signature is broken.
     * @param {object|null} empAdmin
     * @returns {Promise<string>}
     */
    static async _resolveRole(empAdmin) {
        if (!empAdmin) return "USER";

        const sigValid = await CryptoVault.verifyRecord(
            "T_EMP_MGMT_ADMIN",
            MealAdmModel.buildSignedFields(empAdmin),
            empAdmin.SYSSIGNATURE,
        );

        if (!sigValid) {
            logger.warning(
                authMessages.SYS_SIGNATURE_TAMPERED_ROLE_FALLBACK(
                    empAdmin.EMP_ID,
                ),
            );
            return "USER";
        }

        return empAdmin.EMP_ROLE;
    }

    /**
     * Maps a role string to a numeric userLevel used by requireAccess predicates.
     *
     * SUPER_ADMIN → 3  (full admin)
     * ADMIN       → 2  (admin)
     * All others  → 1  (USER, APPROVER, ROBOT, etc.)
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
     * Extracts the permission flag object from a T_EMP_MGMT_ADMIN row.
     * All flags default to 'Y' for backward compatibility with pre-migration rows
     * (null values), except CAN_RECEIVE_BILLING which defaults to 'N' (opt-in).
     *
     * @param {object|null} empAdmin - T_EMP_MGMT_ADMIN row, or null
     * @returns {object}
     * @private
     */
    static _extractPermissionFlags(empAdmin) {
        if (!empAdmin) {
            // Non-admin HRIS users have no admin row — return all flags as Y
            // (they are USER-level; the flags are only meaningful for admins)
            return {
                canApproveReset:   "Y",
                canRejectReset:    "Y",
                canApproveBilling: "Y",
                canRejectBilling:  "Y",
                canReceiveBilling: "N",
                canExportBilling:  "Y",
                isActive:          "Y",
            };
        }
        return {
            canApproveReset:   String(empAdmin.CAN_APPROVE_RESET   ?? "Y"),
            canRejectReset:    String(empAdmin.CAN_REJECT_RESET     ?? "Y"),
            canApproveBilling: String(empAdmin.CAN_APPROVE_BILLING  ?? "Y"),
            canRejectBilling:  String(empAdmin.CAN_REJECT_BILLING   ?? "Y"),
            canReceiveBilling: String(empAdmin.CAN_RECEIVE_BILLING  ?? "N"),
            canExportBilling:  String(empAdmin.CAN_EXPORT_BILLING   ?? "Y"),
            isActive:          String(empAdmin.IS_ACTIVE             ?? "Y"),
        };
    }

    /**
     * Builds and signs both JWT tokens.
     * The access token carries the full user profile including GID, userLevel,
     * isDefaultPassword, requiresPasswordChange, and permission flags.
     * The refresh token carries only sub + type (minimal surface area).
     *
     * SECURITY NOTE: Permission flags in the JWT are for UI purposes ONLY
     * (hiding buttons). The authoritative check is always re-read from the DB
     * at action time by the relevant service. Stale JWT flags can never bypass
     * the DB-level gate.
     *
     * @param {object} params
     * @param {string} params.userId
     * @param {number|null} params.GID          - Permanent employee GID from T_EMP_MASTER_LIST
     * @param {string|null} params.firstName
     * @param {string|null} params.lastName
     * @param {string|null} params.segmentCode
     * @param {string|null} params.segmentDesc
     * @param {string|null} params.email
     * @param {string} params.role
     * @param {string} params.loginSource
     * @param {boolean} [params.isDefaultPassword=false]
     * @param {boolean} [params.requiresPasswordChange=false]
     * @param {object} [params.permissionFlags={}]  - Permission flags from T_EMP_MGMT_ADMIN
     * @returns {{ user: object, accessToken: string, refreshToken: string }}
     */
    static _issueTokens({
        userId,
        GID = null,
        firstName,
        lastName,
        segmentCode,
        segmentDesc,
        email,
        role,
        loginSource,
        isDefaultPassword = false,
        requiresPasswordChange = false,
        permissionFlags = {},
    }) {
        const userPayload = {
            sub: String(userId),
            userId: String(userId),
            GID: GID ?? null,
            userLevel: AuthService._roleToUserLevel(role),
            firstName,
            lastName,
            segmentCode,
            segmentDesc,
            email,
            role,
            loginSource,
            isDefaultPassword,
            requiresPasswordChange,
            // Permission flags — for UI hints only, never for server-side gates
            permissions: permissionFlags,
        };

        const accessToken = jwt.sign(userPayload, process.env.JWT_SECRET, {
            expiresIn: process.env.JWT_EXPIRES_IN || "8h",
        });

        const refreshToken = jwt.sign(
            { sub: String(userId), type: "refresh" },
            process.env.JWT_SECRET,
            { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "7d" },
        );

        return { user: userPayload, accessToken, refreshToken };
    }

    // ─── Default password check ───────────────────────────────────────────────

    /**
     * Returns true when the stored EMP_PW hash was produced from the
     * ADMIN_DEFAULT_PASSWORD env var, indicating the user has not changed
     * their password from the initial system-assigned value.
     *
     * Returns false when ADMIN_DEFAULT_PASSWORD is not configured or when
     * empPwHash is falsy — callers treat missing config as "no forced change".
     *
     * @param {string|null|undefined} empPwHash
     * @returns {Promise<boolean>}
     * @private
     */
    static async _checkIsDefaultPassword(empPwHash) {
        const defaultPw = process.env.ADMIN_DEFAULT_PASSWORD;
        if (!defaultPw || !empPwHash) return false;
        try {
            // Use verifyAdminPassword to handle all stored formats including
            // legacy TripleDES (no rehash needed here — this is read-only)
            const { matched } = await CryptoVault.verifyAdminPassword(
                defaultPw,
                empPwHash,
            );
            return matched;
        } catch {
            // Verification failure (bad hash format, etc.) is non-fatal here
            return false;
        }
    }

    /**
     * Persists an upgraded admin password hash after a transparent
     * TripleDES → strong-mode migration on successful login.
     * Updates both EMP_PW and SYSSIGNATURE in T_EMP_MGMT_ADMIN.
     * Failures are logged as warnings — never propagated to the caller.
     *
     * @param {object} empAdmin - The T_EMP_MGMT_ADMIN row
     * @param {string} newHash  - New strong (argon2|bcrypt) hash
     * @returns {Promise<void>}
     * @private
     */
    static async _persistAdminHashUpgrade(empAdmin, newHash) {
        try {
            // Sign over the full permission-flag payload (migration v3.0).
            // Only EMP_PW changes; all other row values are preserved as-is.
            const sysSignature = await CryptoVault.signRecord(
                "T_EMP_MGMT_ADMIN",
                MealAdmModel.buildSignedFields({ ...empAdmin, EMP_PW: newHash }),
            );
            await MealAdmModel.updateAdmin(
                empAdmin.EMP_ID,
                newHash,
                empAdmin.EMP_ROLE,
                sysSignature,
            );
            logger.info(
                authMessages.ADMIN_HASH_UPGRADED
                    ? authMessages.ADMIN_HASH_UPGRADED(empAdmin.EMP_ID)
                    : `Admin password hash upgraded for ${empAdmin.EMP_ID}`,
            );
        } catch (err) {
            logger.warning(
                `Admin hash upgrade failed for ${empAdmin.EMP_ID}: ${err?.message}`,
            );
        }
    }

    // ─── Change password ──────────────────────────────────────────────────────

    /**
     * Changes an admin's password while the user is already authenticated.
     * Verifies the current password, rejects the default password as a new
     * value, hashes the new password, re-signs the record, and issues fresh
     * JWT tokens with requiresPasswordChange=false.
     *
     * @param {string} userId
     * @param {string} currentPassword - Plain-text current password
     * @param {string} newPassword     - Plain-text new password
     * @returns {Promise<{ user: object, accessToken: string, refreshToken: string }>}
     * @throws {AppError} 404 not found; 422 signature invalid; 401 wrong current password; 400 default password forbidden
     */
    static async changePassword(userId, currentPassword, newPassword) {
        const empAdmin = await MealAdmModel.findByEmpId(userId);
        if (!empAdmin) {
            throw new AppError(
                AUTH_ERRORS.USER_NOT_FOUND,
                HTTP_STATUS.NOT_FOUND,
                {
                    type: "NotFoundError",
                },
            );
        }

        // Integrity check before touching credentials
        const sigValid = await CryptoVault.verifyRecord(
            "T_EMP_MGMT_ADMIN",
            MealAdmModel.buildSignedFields(empAdmin),
            empAdmin.SYSSIGNATURE,
        );
        if (!sigValid) {
            logger.warning(authMessages.SYS_SIGNATURE_TAMPERED_BLOCKED(userId));
            throw new AppError(
                AUTH_ERRORS.ACCOUNT_INTEGRITY_FAILED,
                HTTP_STATUS.UNPROCESSABLE,
                { type: "DataIntegrityError" },
            );
        }

        // Verify current password using the admin-specific verifier
        // (handles bcrypt, argon2, and legacy TripleDES with rehash migration)
        const { matched: pwMatch, newHash: migratedHash } =
            await CryptoVault.verifyAdminPassword(
                currentPassword,
                empAdmin.EMP_PW,
            );
        if (!pwMatch) {
            throw new AppError(
                AUTH_ERRORS.INVALID_CREDENTIALS,
                HTTP_STATUS.UNAUTHORIZED,
                {
                    type: "AuthenticationError",
                    hint: "The current password you entered is incorrect.",
                },
            );
        }

        // Reject default password as new value (plain compare + hash verify)
        const defaultPw = process.env.ADMIN_DEFAULT_PASSWORD;
        if (defaultPw) {
            if (newPassword === defaultPw) {
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
        }

        // Note: the dead `isDefaultHash` computation that previously appeared here
        // was removed (L-02) — the plain compare above already covers this check.
        // migratedHash is intentionally discarded here — the user is setting a new
        // password immediately, which will always produce a strong hash below.
        void migratedHash;

        const newPwHash = await CryptoVault.hashAdminPassword(newPassword);
        // Sign over the full permission-flag payload (migration v3.0).
        // EMP_PW is the *new* hash; all other flag values are read from the
        // existing row (they are not changing during a password change).
        const sysSignature = await CryptoVault.signRecord(
            "T_EMP_MGMT_ADMIN",
            MealAdmModel.buildSignedFields({ ...empAdmin, EMP_PW: newPwHash }),
        );

        await MealAdmModel.updateAdmin(
            empAdmin.EMP_ID,
            newPwHash,
            empAdmin.EMP_ROLE,
            sysSignature,
        );
        logger.info(authMessages.PASSWORD_CHANGED(userId));

        // Fetch HRIS profile + GID in parallel (GID may be null for meal-only admins)
        const [uaUser, GID] = await Promise.all([
            HrisUaModel.findByUserId(userId),
            MealAdmModel.findGidByEmpId(userId),
        ]);

        // Re-read admin row to pick up any flag changes since login
        const freshAdmin = await MealAdmModel.findByEmpId(userId);

        return AuthService._issueTokens({
            userId: empAdmin.EMP_ID,
            GID,
            firstName: uaUser?.FIRSTNAME ?? null,
            lastName: uaUser?.LASTNAME ?? null,
            segmentCode: uaUser?.SEGMENT_CODE ?? null,
            segmentDesc: uaUser?.SEGMENT_DESC ?? null,
            email: uaUser?.EMAILADDRESS ?? null,
            role: empAdmin.EMP_ROLE,
            loginSource: uaUser ? "ua" : "meal",
            isDefaultPassword: false,
            requiresPasswordChange: false,
            permissionFlags: AuthService._extractPermissionFlags(freshAdmin),
        });
    }
}

module.exports = AuthService;
