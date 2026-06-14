"use strict";

/**
 * @fileoverview Admin Management HTTP controller.
 *
 * Thin HTTP layer — no business logic, no direct DB calls.
 * All logic is delegated to AdminManagementService.
 */

const { HTTP_STATUS } = require("../constants");
const { sendSuccess, RESPONSE_MESSAGES } = require("../constants/responses");
const { catchAsync } = require("../utils/catchAsync");
const AdminManagementService = require("../services/AdminManagementService");

class AdminManagementController {
  /**
   * GET /api/v1/admin-management/search?q=<query>
   * Search HRIS employees to add as admins.
   */
  static search = catchAsync(async (req, res) => {
    const q = (req.query.q ?? "").trim();
    const results = await AdminManagementService.searchEmployees(q);
    res
      .status(HTTP_STATUS.OK)
      .json(sendSuccess(RESPONSE_MESSAGES.FETCHED, results));
  });

  /**
   * GET /api/v1/admin-management
   * List all current admins enriched with HRIS profile data.
   */
  static list = catchAsync(async (req, res) => {
    const admins = await AdminManagementService.listAdmins();
    res
      .status(HTTP_STATUS.OK)
      .json(sendSuccess(RESPONSE_MESSAGES.FETCHED, admins));
  });

  /**
   * POST /api/v1/admin-management
   * Body: { empId, role, retainPassword, newPassword?, flags? }
   * Create a new admin record.
   * `flags` is optional — omitting it applies the documented defaults.
   */
  static create = catchAsync(async (req, res) => {
    const { empId, role, retainPassword, newPassword, flags } = req.body;
    const result = await AdminManagementService.addAdmin({
      empId,
      role,
      retainPassword: Boolean(retainPassword),
      newPassword,
      flags: flags ?? undefined,
    });
    res
      .status(HTTP_STATUS.CREATED)
      .json(sendSuccess(RESPONSE_MESSAGES.ADMIN_CREATED, result));
  });

  /**
   * PUT /api/v1/admin-management/:empId
   * Body: { role, changePassword, newPassword? }
   * Update an existing admin's role and optionally their password.
   */
  static update = catchAsync(async (req, res) => {
    const { empId } = req.params;
    const { role, changePassword, newPassword } = req.body;
    const result = await AdminManagementService.updateAdmin({
      empId,
      role,
      changePassword: Boolean(changePassword),
      newPassword,
    });
    res
      .status(HTTP_STATUS.OK)
      .json(sendSuccess(RESPONSE_MESSAGES.ADMIN_UPDATED, result));
  });

  /**
   * PATCH /api/v1/admin-management/:empId/reset-password
   * Reset an admin's password to the system default.
   */
  static resetPassword = catchAsync(async (req, res) => {
    const { empId } = req.params;
    const result = await AdminManagementService.resetPassword(empId);
    res
      .status(HTTP_STATUS.OK)
      .json(sendSuccess(RESPONSE_MESSAGES.PASSWORD_RESET, result));
  });

  /**
   * PATCH /api/v1/admin-management/:empId/reset-signature
   * Recompute the SYSSIGNATURE for a tampered or broken admin record.
   */
  static resetSignature = catchAsync(async (req, res) => {
    const { empId } = req.params;
    const result = await AdminManagementService.resetSignature(empId);
    res
      .status(HTTP_STATUS.OK)
      .json(sendSuccess(RESPONSE_MESSAGES.SIGNATURE_RESET, result));
  });

  /**
   * DELETE /api/v1/admin-management/:empId
   * Remove an admin record (signature-verified before deletion).
   */
  static remove = catchAsync(async (req, res) => {
    const { empId } = req.params;
    const result = await AdminManagementService.deleteAdmin(empId);
    res
      .status(HTTP_STATUS.OK)
      .json(sendSuccess(RESPONSE_MESSAGES.ADMIN_DELETED, result));
  });

  /**
   * PATCH /api/v1/admin-management/:empId/permissions
   * Body: { flags: { canApproveReset?, canRejectReset?, canApproveBilling?,
   *                  canRejectBilling?, canReceiveBilling?, canExportBilling?,
   *                  isActive? } }
   * Update the per-admin permission flags and IS_ACTIVE.
   * SUPER_ADMIN only. Zero-approver guard enforced in service.
   */
  static updatePermissions = catchAsync(async (req, res) => {
    const { empId } = req.params;
    const { flags } = req.body;
    const updatedBy = req.user?.userId ?? req.user?.sub;

    const result = await AdminManagementService.updatePermissions({
      empId,
      flags: flags ?? {},
      updatedBy,
    });
    res
      .status(HTTP_STATUS.OK)
      .json(sendSuccess(RESPONSE_MESSAGES.ADMIN_PERMISSIONS_UPDATED, result));
  });
}

module.exports = AdminManagementController;
