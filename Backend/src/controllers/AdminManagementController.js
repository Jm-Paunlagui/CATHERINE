"use strict";

/**
 * @fileoverview Admin Management HTTP controller.
 *
 * Thin HTTP layer — no business logic, no direct DB calls.
 * All logic is delegated to AdminManagementService. The `:username` route
 * parameter is the account USERNAME.
 */

const net = require("net");
const { HTTP_STATUS } = require("../constants");
const { AppError, ADMIN_ERRORS } = require("../constants/errors");
const { sendSuccess, RESPONSE_MESSAGES } = require("../constants/responses");
const { catchAsync } = require("../utils/catchAsync");
const AdminManagementService = require("../services/AdminManagementService");
const {
    defaultSecurityFilter,
} = require("../middleware/security/SecurityFilterMiddleware");

/**
 * Reads a boolean body flag. `validateRequiredFields` coerces primitives to
 * strings, so JSON `false` arrives here as "false" — and `Boolean("false")` is
 * true. Anything but an explicit true/1 reads as false.
 *
 * @param {*} value
 * @returns {boolean}
 */
const _flag = (value) =>
    value === true || value === 1 || value === "true" || value === "1";

/**
 * The signed-in admin, for the service's role policy. Role comes from the
 * verified JWT.
 *
 * @param {import('express').Request} req
 * @returns {{ username: string, role: string|undefined }}
 */
const _caller = (req) => ({
    username: String(req.user?.userId ?? req.user?.sub ?? ""),
    role: req.user?.role,
});

/**
 * Numeric id of the acting admin — what backup tokens are bound to.
 *
 * @param {import('express').Request} req
 * @returns {number|string|undefined}
 */
const _actorId = (req) => req.user?.id ?? req.user?.userId;

class AdminManagementController {
    /**
     * GET /api/v1/admin-management/search?q=<query>
     * Search user accounts to grant admin access to.
     */
    static search = catchAsync(async (req, res) => {
        const q = String(req.query.q ?? "").trim();
        const results = await AdminManagementService.searchAccounts(q);
        res.status(HTTP_STATUS.OK).json(
            sendSuccess(RESPONSE_MESSAGES.FETCHED, results),
        );
    });

    /**
     * GET /api/v1/admin-management
     * List all current admins.
     */
    static list = catchAsync(async (req, res) => {
        const admins = await AdminManagementService.listAdmins();
        res.status(HTTP_STATUS.OK).json(
            sendSuccess(RESPONSE_MESSAGES.FETCHED, admins),
        );
    });

    /**
     * POST /api/v1/admin-management
     * Body: { username, role, flags?, overrideEmail? }
     * Create a new admin; the server emails a temporary password.
     * `retainPassword` / `newPassword` are passed through RAW so the service
     * can refuse them (400) — they are no longer accepted.
     */
    static create = catchAsync(async (req, res) => {
        const { username, role, retainPassword, newPassword, flags, overrideEmail } = req.body;
        const result = await AdminManagementService.addAdmin({
            username,
            role,
            caller: _caller(req),
            overrideEmail,
            retainPassword,
            newPassword,
            flags: flags ?? undefined,
        });
        res.status(HTTP_STATUS.CREATED).json(
            sendSuccess(RESPONSE_MESSAGES.ADMIN_CREATED, result, HTTP_STATUS.CREATED),
        );
    });

    /**
     * PUT /api/v1/admin-management/:username
     * Body: { role }
     * Change an admin's role (SUPER_ADMIN only). Edit never sets a password —
     * `changePassword: true` / `newPassword` are passed through so the service
     * can refuse them (400).
     */
    static update = catchAsync(async (req, res) => {
        const { username } = req.params;
        const { role, changePassword, newPassword } = req.body;
        const result = await AdminManagementService.updateAdmin({
            username,
            role,
            caller: _caller(req),
            changePassword: _flag(changePassword),
            newPassword,
        });
        res.status(HTTP_STATUS.OK).json(
            sendSuccess(RESPONSE_MESSAGES.ADMIN_UPDATED, result),
        );
    });

    /**
     * PATCH /api/v1/admin-management/:username/reset-password
     * Body: { overrideEmail? }
     * Issue and email a new temporary password.
     */
    static resetPassword = catchAsync(async (req, res) => {
        const { username } = req.params;
        const result = await AdminManagementService.resetPassword(username, {
            overrideEmail: req.body?.overrideEmail,
            caller: _caller(req),
        });
        res.status(HTTP_STATUS.OK).json(
            sendSuccess(RESPONSE_MESSAGES.PASSWORD_RESET, result),
        );
    });

    /**
     * PATCH /api/v1/admin-management/:username/reset-signature
     * Recompute the SYSSIGNATURE for a tampered or broken admin record.
     */
    static resetSignature = catchAsync(async (req, res) => {
        const { username } = req.params;
        const result = await AdminManagementService.resetSignature(username, {
            caller: _caller(req),
        });
        res.status(HTTP_STATUS.OK).json(
            sendSuccess(RESPONSE_MESSAGES.SIGNATURE_RESET, result),
        );
    });

    /**
     * POST /api/v1/admin-management/security/unblock-ip
     * SUPER_ADMIN only. Clears a SecurityFilter suspicious-IP block on every
     * worker (SecurityFilterMiddleware.unblockClusterWide) — before this route
     * a restart was the only way to free an address.
     */
    static unblockIp = catchAsync(async (req, res) => {
        const ip = String(req.body.ip ?? "").trim();
        // Literal IPv4/IPv6 only — anything else could never match a tracked
        // address and would only pollute the audit line (CWE-20).
        if (net.isIP(ip) === 0) {
            throw new AppError(ADMIN_ERRORS.INVALID_IP, HTTP_STATUS.BAD_REQUEST, {
                type: "ValidationError",
                details: [{ field: "ip", issue: "Must be a literal IPv4 or IPv6 address." }],
            });
        }
        const actor = _caller(req).username || "unknown";

        const cleared = await defaultSecurityFilter.unblockClusterWide(ip, actor);
        res.status(HTTP_STATUS.OK).json(
            sendSuccess(RESPONSE_MESSAGES.UPDATED, { ip, cleared }),
        );
    });

    /**
     * DELETE /api/v1/admin-management/:username
     * Body: { backupToken }
     * Permanently removes an admin. Requires a revoke-backup token
     * (POST /:username/revoke-backup) bound to this admin and the caller.
     */
    static remove = catchAsync(async (req, res) => {
        const { username } = req.params;
        const { backupToken } = req.body;
        const caller = _caller(req);
        const result = await AdminManagementService.deleteAdmin({
            username,
            backupToken,
            callerUsername: caller.username,
            callerId: _actorId(req),
        });
        res.status(HTTP_STATUS.OK).json(
            sendSuccess(RESPONSE_MESSAGES.ADMIN_DELETED, result),
        );
    });

    /**
     * POST /api/v1/admin-management/:username/revoke-backup
     * Streams an ENTITY-kind backup `.zip` scoped to one admin and returns the
     * backup token as a response header — the same X-Backup-Token /
     * X-Backup-Token-Expires-At contract the Data Purge `/backup` endpoint uses.
     *
     * ⚠ The archive contains a password hash and an integrity HMAC — treat the
     * downloaded file as credential material.
     */
    static revokeBackup = catchAsync(async (req, res) => {
        const { username } = req.params;

        const result = await AdminManagementService.buildRevokeBackup({
            username,
            actorId: _actorId(req),
            requestId: req.id ?? null,
        });

        res.status(HTTP_STATUS.OK)
            .set({
                "Content-Type": "application/zip",
                "Content-Disposition": `attachment; filename="${result.filename}"`,
                "X-Backup-Token": result.token,
                "X-Backup-Token-Expires-At": String(result.expiresAt),
            })
            .send(result.zipBuffer);
    });

    /**
     * POST /api/v1/admin-management/:username/revoke
     * Body: { backupToken }
     * Deactivates an admin — IS_ACTIVE='N' (re-signed) and every notification
     * flag 'N'. The default, non-destructive way access is removed.
     */
    static revoke = catchAsync(async (req, res) => {
        const { username } = req.params;
        const { backupToken } = req.body;
        const caller = _caller(req);

        const result = await AdminManagementService.revokeAccess({
            username,
            callerUsername: caller.username,
            callerId: _actorId(req),
            backupToken,
        });
        res.status(HTTP_STATUS.OK).json(
            sendSuccess(RESPONSE_MESSAGES.ADMIN_REVOKED, result),
        );
    });

    /**
     * PATCH /api/v1/admin-management/:username/permissions
     * Body: { flags: { canReceiveSrvCrit?, canReceiveSrvDeps?, canReceiveSrvRed?,
     *                  canReceiveSrvSys?, isActive? } }
     * SUPER_ADMIN only.
     */
    static updatePermissions = catchAsync(async (req, res) => {
        const { username } = req.params;
        const { flags } = req.body;

        const result = await AdminManagementService.updatePermissions({
            username,
            flags: flags ?? {},
        });
        res.status(HTTP_STATUS.OK).json(
            sendSuccess(RESPONSE_MESSAGES.ADMIN_PERMISSIONS_UPDATED, result),
        );
    });
}

module.exports = AdminManagementController;
