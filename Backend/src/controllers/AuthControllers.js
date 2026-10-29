"use strict";

const { HTTP_STATUS, AppError, AUTH_ERRORS } = require("../constants");
const { sendSuccess, RESPONSE_MESSAGES } = require("../constants/responses");
const { catchAsync } = require("../utils/catchAsync");
const AuthService = require("../services/AuthService");

class AuthController {
    /**
     * POST /api/v1/auth/login
     * Body: { userId, password }
     */
    static login = catchAsync(async (req, res) => {
        const { userId, password } = req.body;

        const { user, accessToken, refreshToken } = await AuthService.login(
            userId,
            password,
        );

        res.cookie(
            AuthService.COOKIE_NAMES.ACCESS,
            accessToken,
            AuthService.accessCookieOptions(),
        );
        res.cookie(
            AuthService.COOKIE_NAMES.REFRESH,
            refreshToken,
            AuthService.refreshCookieOptions(),
        );

        res.status(HTTP_STATUS.OK).json(
            sendSuccess(RESPONSE_MESSAGES.LOGIN_SUCCESS, { user }),
        );
    });

    /**
     * POST /api/v1/auth/refresh
     * Reads the refresh token ONLY from the signed, httpOnly, path-scoped cookie.
     * An Authorization-header fallback would be a replay vector: a captured
     * refresh token could be presented by any script or proxy.
     * A missing, unsigned or tampered cookie is a 401 REFRESH_TOKEN_MISSING —
     * not USER_NOT_FOUND, which would misreport the cause to clients and logs.
     */
    static refresh = catchAsync(async (req, res) => {
        const refreshToken =
            req.signedCookies?.[AuthService.COOKIE_NAMES.REFRESH];

        if (!refreshToken) {
            throw new AppError(
                AUTH_ERRORS.REFRESH_TOKEN_MISSING,
                HTTP_STATUS.UNAUTHORIZED,
                {
                    type: "AuthenticationError",
                    hint: "No refresh token provided.",
                },
            );
        }

        const {
            user,
            accessToken,
            refreshToken: newRefresh,
        } = await AuthService.refresh(refreshToken);

        res.cookie(
            AuthService.COOKIE_NAMES.ACCESS,
            accessToken,
            AuthService.accessCookieOptions(),
        );
        res.cookie(
            AuthService.COOKIE_NAMES.REFRESH,
            newRefresh,
            AuthService.refreshCookieOptions(),
        );

        res.status(HTTP_STATUS.OK).json(
            sendSuccess(RESPONSE_MESSAGES.TOKEN_REFRESHED, { user }),
        );
    });

    /**
     * POST /api/v1/auth/logout
     * Requires: AuthMiddleware.authenticate
     */
    static logout = catchAsync(async (req, res) => {
        // Revokes the session family (best effort) and logs AUTH_LOGOUT.
        await AuthService.logout(req.user);

        res.clearCookie(AuthService.COOKIE_NAMES.ACCESS, { path: "/" });
        res.clearCookie(AuthService.COOKIE_NAMES.REFRESH, {
            path: "/api/v1/auth/refresh",
        });

        res.status(HTTP_STATUS.OK).json(
            sendSuccess(RESPONSE_MESSAGES.LOGOUT_SUCCESS),
        );
    });

    /**
     * GET /api/v1/auth/me
     * Returns the caller's profile: the decoded JWT payload with permission
     * flags refreshed from T_ADMINS_DEV at read time (JWT flag claims go
     * stale the moment a SUPER_ADMIN edits permissions mid-session).
     * Requires: AuthMiddleware.authenticate
     */
    static me = catchAsync(async (req, res) => {
        const profile = await AuthService.getProfile(req.user);
        res.status(HTTP_STATUS.OK).json(
            sendSuccess(RESPONSE_MESSAGES.FETCHED, profile),
        );
    });

    /**
     * PATCH /api/v1/auth/change-password
     * Body: { currentPassword, newPassword }
     * Requires: AuthMiddleware.authenticate
     *
     * Verifies the current password, sets a new password, and issues fresh
     * JWT tokens with requiresPasswordChange=false. New tokens are written
     * into HTTP-only cookies so the browser session is updated transparently.
     */
    static changePassword = catchAsync(async (req, res) => {
        const { currentPassword, newPassword } = req.body;
        const userId = req.user?.userId;

        const { user, accessToken, refreshToken } =
            await AuthService.changePassword(
                userId,
                currentPassword,
                newPassword,
            );

        res.cookie(
            AuthService.COOKIE_NAMES.ACCESS,
            accessToken,
            AuthService.accessCookieOptions(),
        );
        res.cookie(
            AuthService.COOKIE_NAMES.REFRESH,
            refreshToken,
            AuthService.refreshCookieOptions(),
        );

        res.status(HTTP_STATUS.OK).json(
            sendSuccess(RESPONSE_MESSAGES.PASSWORD_CHANGED, { user }),
        );
    });
}

module.exports = AuthController;
