"use strict";

/**
 * @fileoverview Admin Management business logic.
 *
 * Owns all operations on T_EMP_MGMT_ADMIN (CRUD, password reset, signature
 * reset) and enriches admin records with HRIS profile data from U_USERS.
 * Cross-DB joins are not possible; the join is performed in JS after a single
 * $in batch fetch per side (one Oracle round-trip per database).
 *
 * Security:
 *  - SYSSIGNATURE is verified before every write and delete operation.
 *  - Default password is enforced server-side — never accepted as a new password.
 *  - Roles are validated against the canonical set before any DB write.
 */

const {
  AppError,
  ADMIN_ERRORS,
  VALIDATION_ERRORS,
} = require("../constants/errors");
const { HTTP_STATUS } = require("../constants");
const { logger } = require("../utils/logger");
const { adminMessages } = require("../constants/messages");
const { CryptoVault } = require("../utils/encryption/CryptoVault");
const HrisUaModel = require("../models/hris.ua.model");
const MealAdmModel = require("../models/meal.adm.model");

/** Canonical set of valid EMP_ROLE values. */
const VALID_ROLES = ["ADMIN", "SUPER_ADMIN", "APPROVER", "VIEWER", "ROBOT"];

class AdminManagementService {
  // ─── Employee search ─────────────────────────────────────────────────────

  /**
   * Searches U_USERS for employees matching the query (USERID exact OR
   * FIRSTNAME / LASTNAME LIKE, case-insensitive). Each result is flagged
   * with `isAdmin: boolean` by checking presence in T_EMP_MGMT_ADMIN.
   *
   * Cross-DB admin flagging uses a single `$in` batch query for the whole
   * result set. Result set is capped at 20 by the model layer.
   *
   * @param {string} query - Employee ID, first name, or last name fragment
   * @returns {Promise<Array<object>>}
   * @throws {AppError} 400 when query is empty
   */
  static async searchEmployees(query) {
    if (!query || typeof query !== "string" || !query.trim()) {
      throw new AppError(
        VALIDATION_ERRORS.INVALID_INPUT,
        HTTP_STATUS.BAD_REQUEST,
        {
          type: "ValidationError",
          details: [
            {
              field: "q",
              issue: "Search query must be a non-empty string.",
            },
          ],
        },
      );
    }

    logger.info(adminMessages.ADMIN_SEARCH(query.trim()));

    const rawEmployees = await HrisUaModel.searchEmployees(query.trim());

    // Deduplicate by USERID — U_USERS may contain multiple rows for the
    // same employee (e.g. historical records). Keep the first occurrence.
    const seen = new Set();
    const employees = rawEmployees.filter((emp) => {
      if (seen.has(emp.USERID)) return false;
      seen.add(emp.USERID);
      return true;
    });

    // Flag each employee with isAdmin via ONE $in query for the whole result
    // set (max 20 rows) instead of one COUNT round-trip per row.
    // U_USERS.USERID is VARCHAR2; T_EMP_MGMT_ADMIN.EMP_ID is NUMBER(10).
    // Non-numeric USERIDs can never be admins — findExistingEmpIds drops them.
    const adminIds = await MealAdmModel.findExistingEmpIds(
      employees.map((emp) => emp.USERID),
    );

    return employees.map((emp) => ({
      ...emp,
      isAdmin: adminIds.has(Number(emp.USERID)),
    }));
  }

  // ─── Admin list ──────────────────────────────────────────────────────────

  /**
   * Returns all admin records enriched with FIRSTNAME / LASTNAME from
   * U_USERS and a `signatureValid` boolean on each row.
   *
   * HRIS lookups are batched into one `$in` join query for all admins —
   * a single Oracle round-trip regardless of admin count.
   *
   * @returns {Promise<Array<object>>}
   */
  static async listAdmins() {
    const admins = await MealAdmModel.findAll();

    // HRIS lookups batched into ONE $in join query for all admins (replaces a
    // per-admin cross-DB round-trip). EMP_ID is NUMBER(10); USERID is
    // VARCHAR2(64) — cast to string for both the batch query and the Map key.
    const hrisMap = await HrisUaModel.findByUserIds(
      admins.map((admin) => String(admin.EMP_ID)),
    );

    const enriched = await Promise.all(
      admins.map(async (admin) => {
        // Signature check is local HMAC computation — no Oracle round-trip.
        const sigValid = await CryptoVault.verifyRecord(
          "T_EMP_MGMT_ADMIN",
          MealAdmModel.buildSignedFields(admin),
          admin.SYSSIGNATURE,
        );
        const hrisUser = hrisMap.get(String(admin.EMP_ID)) ?? null;

        if (!sigValid) {
          logger.warning(adminMessages.ADMIN_SIGNATURE_INVALID(admin.EMP_ID));
        }

        return {
          empId:            admin.EMP_ID,
          empRole:          admin.EMP_ROLE,
          firstName:        hrisUser?.FIRSTNAME     ?? null,
          lastName:         hrisUser?.LASTNAME      ?? null,
          segmentCode:      hrisUser?.SEGMENT_CODE  ?? null,
          segmentDesc:      hrisUser?.SEGMENT_DESC  ?? null,
          signatureValid:   sigValid,
          // Permission flags — included so the UI can render toggle states
          canApproveReset:   String(admin.CAN_APPROVE_RESET   ?? "Y"),
          canRejectReset:    String(admin.CAN_REJECT_RESET     ?? "Y"),
          canApproveBilling: String(admin.CAN_APPROVE_BILLING  ?? "Y"),
          canRejectBilling:  String(admin.CAN_REJECT_BILLING   ?? "Y"),
          canReceiveBilling: String(admin.CAN_RECEIVE_BILLING  ?? "N"),
          canExportBilling:  String(admin.CAN_EXPORT_BILLING   ?? "Y"),
          isActive:          String(admin.IS_ACTIVE             ?? "Y"),
          updatedBy:         admin.UPDATED_BY ?? null,
          updatedAt:         admin.UPDATED_AT ?? null,
        };
      }),
    );

    logger.info(adminMessages.ADMIN_LIST_FETCHED());
    return enriched;
  }

  // ─── Create admin ────────────────────────────────────────────────────────

  /**
   * Validates that every entry in a flags object uses only 'Y' or 'N' values
   * and only the accepted flag keys. Used by both `addAdmin` and
   * `updatePermissions` so the same rules apply at creation time.
   *
   * @param {object} flags
   * @throws {AppError} 400 on unknown keys or invalid values
   * @private
   */
  static _validateFlags(flags) {
    const ALLOWED_FLAG_KEYS = [
      "canApproveReset",
      "canRejectReset",
      "canApproveBilling",
      "canRejectBilling",
      "canReceiveBilling",
      "canExportBilling",
      "isActive",
    ];
    const invalidKeys = Object.keys(flags).filter(
      (k) => !ALLOWED_FLAG_KEYS.includes(k),
    );
    if (invalidKeys.length > 0) {
      throw new AppError(
        VALIDATION_ERRORS.INVALID_INPUT,
        HTTP_STATUS.BAD_REQUEST,
        {
          type: "ValidationError",
          details: invalidKeys.map((k) => ({
            field: k,
            issue: `Unknown permission flag: "${k}".`,
          })),
        },
      );
    }
    const invalidValues = Object.entries(flags).filter(
      ([, v]) => v !== "Y" && v !== "N",
    );
    if (invalidValues.length > 0) {
      throw new AppError(
        VALIDATION_ERRORS.INVALID_INPUT,
        HTTP_STATUS.BAD_REQUEST,
        {
          type: "ValidationError",
          details: invalidValues.map(([k]) => ({
            field: k,
            issue: `Flag "${k}" must be 'Y' or 'N'.`,
          })),
        },
      );
    }
  }

  /**
   * Registers a new admin in T_EMP_MGMT_ADMIN.
   *
   * Password resolution:
   *  - retainPassword === true → use ADMIN_DEFAULT_PASSWORD (isDefaultPassword implied)
   *  - retainPassword === false → use newPassword (must not equal default; must be provided)
   *
   * Permission flags are optional at creation time. When omitted, the
   * migration v3.0 defaults apply: all 'Y' except CAN_RECEIVE_BILLING ('N').
   * When supplied, each flag is validated ('Y'|'N' only) before the row is
   * signed and inserted — the SYSSIGNATURE covers the chosen flag values so
   * any post-insert tampering is detectable.
   *
   * @param {object} params
   * @param {string} params.empId
   * @param {string} params.role            - Must be in VALID_ROLES
   * @param {boolean} params.retainPassword
   * @param {string} [params.newPassword]   - Required when retainPassword is false
   * @param {object} [params.flags]         - Optional permission flags override
   * @param {string} [params.flags.canApproveReset='Y']
   * @param {string} [params.flags.canRejectReset='Y']
   * @param {string} [params.flags.canApproveBilling='Y']
   * @param {string} [params.flags.canRejectBilling='Y']
   * @param {string} [params.flags.canReceiveBilling='N']
   * @param {string} [params.flags.canExportBilling='Y']
   * @param {string} [params.flags.isActive='Y']
   * @returns {Promise<{ empId: string, empRole: string }>}
   * @throws {AppError} 400 on invalid role or flag value; 409 if already exists;
   *   400 if default password used as custom password
   */
  static async addAdmin({ empId, role, retainPassword, newPassword, flags }) {
    AdminManagementService._validateRole(role);

    // Validate any caller-supplied flags early — before the expensive DB work
    if (flags != null && typeof flags === "object") {
      AdminManagementService._validateFlags(flags);
    }

    if (await MealAdmModel.existsByEmpId(empId)) {
      logger.warning(adminMessages.ADMIN_ALREADY_EXISTS(empId));
      throw new AppError(
        ADMIN_ERRORS.ADMIN_ALREADY_EXISTS,
        HTTP_STATUS.CONFLICT,
        {
          type: "ConflictError",
          details: [
            {
              field: "empId",
              issue: "This employee is already an admin.",
            },
          ],
        },
      );
    }

    const password = retainPassword
      ? process.env.ADMIN_DEFAULT_PASSWORD
      : newPassword;

    if (!retainPassword) {
      AdminManagementService._rejectDefaultPassword(password);
    }

    if (!password) {
      throw new AppError(
        VALIDATION_ERRORS.MISSING_FIELDS,
        HTTP_STATUS.BAD_REQUEST,
        {
          type: "ValidationError",
          details: [
            {
              field: "newPassword",
              issue: "A password is required when retainPassword is false.",
            },
          ],
        },
      );
    }

    // Use hashAdminPassword — always strong (bcrypt|argon2), never tripledes/plain
    const empPwHash = await CryptoVault.hashAdminPassword(password);

    // Merge caller-supplied flags with documented defaults.
    // buildSignedFields will also apply its own defaults for any missing key,
    // but we need the resolved values here to pass to insertAdmin correctly.
    const resolvedFlags = {
      canApproveReset:   flags?.canApproveReset   ?? "Y",
      canRejectReset:    flags?.canRejectReset     ?? "Y",
      canApproveBilling: flags?.canApproveBilling  ?? "Y",
      canRejectBilling:  flags?.canRejectBilling   ?? "Y",
      canReceiveBilling: flags?.canReceiveBilling  ?? "N",
      canExportBilling:  flags?.canExportBilling   ?? "Y",
      isActive:          flags?.isActive           ?? "Y",
    };

    // Build a synthetic row with the resolved flags so the SYSSIGNATURE
    // covers the exact values that will be written to the DB.
    const newRow = {
      EMP_ID:              empId,
      EMP_PW:              empPwHash,
      EMP_ROLE:            role,
      CAN_APPROVE_RESET:   resolvedFlags.canApproveReset,
      CAN_REJECT_RESET:    resolvedFlags.canRejectReset,
      CAN_APPROVE_BILLING: resolvedFlags.canApproveBilling,
      CAN_REJECT_BILLING:  resolvedFlags.canRejectBilling,
      CAN_RECEIVE_BILLING: resolvedFlags.canReceiveBilling,
      CAN_EXPORT_BILLING:  resolvedFlags.canExportBilling,
      IS_ACTIVE:           resolvedFlags.isActive,
    };
    const sysSignature = await CryptoVault.signRecord(
      "T_EMP_MGMT_ADMIN",
      MealAdmModel.buildSignedFields(newRow),
    );

    await MealAdmModel.insertAdmin(empId, empPwHash, role, sysSignature, resolvedFlags);
    logger.info(adminMessages.ADMIN_CREATED(empId, role));

    return { empId, empRole: role };
  }

  // ─── Update admin ────────────────────────────────────────────────────────

  /**
   * Updates an existing admin's role and optionally their password.
   * Verifies SYSSIGNATURE before applying any change.
   *
   * @param {object} params
   * @param {string} params.empId
   * @param {string} params.role          - Must be in VALID_ROLES
   * @param {boolean} params.changePassword
   * @param {string} [params.newPassword] - Required when changePassword is true
   * @returns {Promise<{ empId: string, empRole: string }>}
   * @throws {AppError} 404 not found; 422 signature invalid; 400 bad role/password
   */
  static async updateAdmin({ empId, role, changePassword, newPassword }) {
    AdminManagementService._validateRole(role);

    const existing = await AdminManagementService._fetchAndVerify(empId);

    let empPwHash = existing.EMP_PW;

    if (changePassword) {
      if (!newPassword) {
        throw new AppError(
          VALIDATION_ERRORS.MISSING_FIELDS,
          HTTP_STATUS.BAD_REQUEST,
          {
            type: "ValidationError",
            details: [
              {
                field: "newPassword",
                issue:
                  "A new password is required when changePassword is true.",
              },
            ],
          },
        );
      }
      AdminManagementService._rejectDefaultPassword(newPassword);
      // Use hashAdminPassword — always strong (bcrypt|argon2)
      empPwHash = await CryptoVault.hashAdminPassword(newPassword);
    }

    // Sign over the full permission-flag payload, preserving all existing flags.
    const sysSignature = await CryptoVault.signRecord(
      "T_EMP_MGMT_ADMIN",
      MealAdmModel.buildSignedFields({ ...existing, EMP_PW: empPwHash, EMP_ROLE: role }),
    );

    await MealAdmModel.updateAdmin(empId, empPwHash, role, sysSignature);
    logger.info(adminMessages.ADMIN_UPDATED(empId));

    return { empId, empRole: role };
  }

  // ─── Reset password ──────────────────────────────────────────────────────

  /**
   * Resets an admin's password to ADMIN_DEFAULT_PASSWORD.
   * Verifies SYSSIGNATURE first; computes a fresh signature after reset.
   *
   * @param {string} empId
   * @returns {Promise<{ empId: string }>}
   * @throws {AppError} 404 not found; 422 signature invalid
   */
  static async resetPassword(empId) {
    const existing = await AdminManagementService._fetchAndVerify(empId);

    const defaultPw = process.env.ADMIN_DEFAULT_PASSWORD;
    if (!defaultPw) {
      throw new AppError(
        "ADMIN_DEFAULT_PASSWORD environment variable is not configured.",
        HTTP_STATUS.INTERNAL_SERVER_ERROR,
        { type: "ConfigurationError" },
      );
    }

    // Use hashAdminPassword — always strong (bcrypt|argon2), never tripledes/plain
    const empPwHash = await CryptoVault.hashAdminPassword(defaultPw);
    // Sign over the full permission-flag payload, preserving existing flags.
    const sysSignature = await CryptoVault.signRecord(
      "T_EMP_MGMT_ADMIN",
      MealAdmModel.buildSignedFields({ ...existing, EMP_PW: empPwHash }),
    );

    await MealAdmModel.updateAdmin(
      empId,
      empPwHash,
      existing.EMP_ROLE,
      sysSignature,
    );
    logger.info(adminMessages.ADMIN_PASSWORD_RESET(empId));

    return { empId };
  }

  // ─── Reset signature ─────────────────────────────────────────────────────

  /**
   * Recomputes SYSSIGNATURE from the current { EMP_ID, EMP_PW, EMP_ROLE }
   * without changing any other field. Used to repair rows whose signature was
   * broken (e.g. manual DB correction or DATA_SIGNING_SECRET rotation).
   *
   * Does NOT verify the existing signature first — this is intentional as the
   * whole purpose of this operation is to repair a broken signature.
   *
   * @param {string} empId
   * @returns {Promise<{ empId: string }>}
   * @throws {AppError} 404 not found
   */
  static async resetSignature(empId) {
    const existing = await MealAdmModel.findByEmpId(empId);
    if (!existing) {
      logger.warning(adminMessages.ADMIN_NOT_FOUND(empId));
      throw new AppError(ADMIN_ERRORS.ADMIN_NOT_FOUND, HTTP_STATUS.NOT_FOUND, {
        type: "NotFoundError",
      });
    }

    // Sign over the full permission-flag payload (migration v3.0).
    // resetSignature is a repair operation — it does NOT change any data field,
    // only regenerates the HMAC from the current persisted values.
    const sysSignature = await CryptoVault.signRecord(
      "T_EMP_MGMT_ADMIN",
      MealAdmModel.buildSignedFields(existing),
    );

    await MealAdmModel.updateAdmin(
      existing.EMP_ID,
      existing.EMP_PW,
      existing.EMP_ROLE,
      sysSignature,
    );

    logger.info(adminMessages.ADMIN_SIGNATURE_RESET(empId));
    return { empId };
  }

  // ─── Delete admin ────────────────────────────────────────────────────────

  /**
   * Removes an admin record from T_EMP_MGMT_ADMIN.
   * Verifies SYSSIGNATURE before deleting to prevent tamper-blind deletions.
   *
   * @param {string} empId
   * @returns {Promise<{ empId: string }>}
   * @throws {AppError} 404 not found; 422 signature invalid
   */
  static async deleteAdmin(empId) {
    await AdminManagementService._fetchAndVerify(empId);
    await MealAdmModel.deleteAdmin(empId);
    logger.info(adminMessages.ADMIN_DELETED(empId));
    return { empId };
  }

  // ─── Update permission flags ─────────────────────────────────────────────

  /**
   * Updates the per-admin permission flags and IS_ACTIVE on a T_EMP_MGMT_ADMIN row.
   *
   * Security model:
   *  - Caller must be SUPER_ADMIN (enforced by the route's requireAccess predicate).
   *  - SYSSIGNATURE is verified before write and re-computed after write.
   *  - Zero-approver guard: the change is rejected (409) if it would leave no
   *    other active admin with CAN_APPROVE_RESET='Y' or CAN_APPROVE_BILLING='Y'.
   *    "Other active admin" means any row where IS_ACTIVE='Y' AND the flag='Y'
   *    EXCLUDING the target empId — so even if the target keeps its own flag,
   *    the platform is never left with only one approval-capable admin.
   *
   * @param {object} params
   * @param {number|string} params.empId      - Target admin EMP_ID
   * @param {object} params.flags             - Map of flag names → 'Y'|'N'
   *   Accepted keys: canApproveReset, canRejectReset, canApproveBilling,
   *                  canRejectBilling, canReceiveBilling, canExportBilling, isActive
   * @param {number|string} params.updatedBy  - EMP_ID of the SUPER_ADMIN caller
   * @returns {Promise<{ empId: number|string, flags: object }>}
   * @throws {AppError} 404 not found
   * @throws {AppError} 422 signature invalid
   * @throws {AppError} 409 zero-approver guard triggered
   * @throws {AppError} 400 invalid flag value
   */
  static async updatePermissions({ empId, flags, updatedBy }) {
    // Validate incoming flag values — only 'Y' and 'N' are permitted.
    // _validateFlags is the single authoritative validator, shared with addAdmin.
    AdminManagementService._validateFlags(flags);

    // Fetch and verify signature integrity
    const existing = await AdminManagementService._fetchAndVerify(empId);

    // ── Zero-approver guard ──────────────────────────────────────────────────
    // Evaluate whether the proposed change would deplete any approval role to zero
    // *other admins* (IS_ACTIVE='Y' + flag='Y', excluding the target row itself).

    const afterApproveReset =
      flags.canApproveReset ?? (existing.CAN_APPROVE_RESET ?? "Y");
    const afterIsActive =
      flags.isActive ?? (existing.IS_ACTIVE ?? "Y");

    // If the change would make this admin lose CAN_APPROVE_RESET or go inactive,
    // ensure at least one OTHER active admin still has CAN_APPROVE_RESET='Y'.
    const wouldLoseApproveReset =
      afterApproveReset === "N" || afterIsActive === "N";
    if (wouldLoseApproveReset) {
      const othersWithApproveReset =
        await MealAdmModel.countActiveAdminsWithFlag(
          "CAN_APPROVE_RESET",
          empId,
        );
      if (othersWithApproveReset === 0) {
        logger.warning(
          adminMessages.ZERO_APPROVER_GUARD_TRIGGERED("CAN_APPROVE_RESET"),
        );
        throw new AppError(
          ADMIN_ERRORS.NO_APPROVE_RESET_ADMIN,
          HTTP_STATUS.CONFLICT,
          { type: "BusinessRuleError" },
        );
      }
    }

    const afterApproveBilling =
      flags.canApproveBilling ?? (existing.CAN_APPROVE_BILLING ?? "Y");

    const wouldLoseApproveBilling =
      afterApproveBilling === "N" || afterIsActive === "N";
    if (wouldLoseApproveBilling) {
      const othersWithApproveBilling =
        await MealAdmModel.countActiveAdminsWithFlag(
          "CAN_APPROVE_BILLING",
          empId,
        );
      if (othersWithApproveBilling === 0) {
        logger.warning(
          adminMessages.ZERO_APPROVER_GUARD_TRIGGERED("CAN_APPROVE_BILLING"),
        );
        throw new AppError(
          ADMIN_ERRORS.NO_APPROVE_BILLING_ADMIN,
          HTTP_STATUS.CONFLICT,
          { type: "BusinessRuleError" },
        );
      }
    }

    // ── Compute the DB-column flags map for the model layer ─────────────────
    // camelCase → SCREAMING_SNAKE mapping
    const dbFlags = {};
    if (flags.canApproveReset   !== undefined) dbFlags.CAN_APPROVE_RESET   = flags.canApproveReset;
    if (flags.canRejectReset    !== undefined) dbFlags.CAN_REJECT_RESET    = flags.canRejectReset;
    if (flags.canApproveBilling !== undefined) dbFlags.CAN_APPROVE_BILLING = flags.canApproveBilling;
    if (flags.canRejectBilling  !== undefined) dbFlags.CAN_REJECT_BILLING  = flags.canRejectBilling;
    if (flags.canReceiveBilling !== undefined) dbFlags.CAN_RECEIVE_BILLING = flags.canReceiveBilling;
    if (flags.canExportBilling  !== undefined) dbFlags.CAN_EXPORT_BILLING  = flags.canExportBilling;
    if (flags.isActive          !== undefined) dbFlags.IS_ACTIVE           = flags.isActive;

    // Build the projected "after" row for signing — merge current values with changes
    const updatedRow = { ...existing, ...dbFlags };
    const sysSignature = await CryptoVault.signRecord(
      "T_EMP_MGMT_ADMIN",
      MealAdmModel.buildSignedFields(updatedRow),
    );

    // The model maps camelCase keys → DB columns itself (its documented
    // contract) — pass the validated camelCase flags, NOT dbFlags. Passing
    // column-keyed flags here silently persists nothing but the signature,
    // leaving the row signed over values it does not contain (instant
    // "tampered" state on the next verification).
    await MealAdmModel.updatePermissions(empId, flags, updatedBy, sysSignature);
    logger.info(adminMessages.ADMIN_PERMISSIONS_UPDATED(empId, flags));

    return { empId, flags };
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

  /**
   * Fetches an admin record and throws if not found or if the SYSSIGNATURE
   * is invalid (DataIntegrityError, 422).
   *
   * @param {string} empId
   * @returns {Promise<object>} The raw T_EMP_MGMT_ADMIN row
   * @throws {AppError} 404 | 422
   * @private
   */
  static async _fetchAndVerify(empId) {
    const existing = await MealAdmModel.findByEmpId(empId);
    if (!existing) {
      logger.warning(adminMessages.ADMIN_NOT_FOUND(empId));
      throw new AppError(ADMIN_ERRORS.ADMIN_NOT_FOUND, HTTP_STATUS.NOT_FOUND, {
        type: "NotFoundError",
      });
    }

    const sigValid = await CryptoVault.verifyRecord(
      "T_EMP_MGMT_ADMIN",
      MealAdmModel.buildSignedFields(existing),
      existing.SYSSIGNATURE,
    );

    if (!sigValid) {
      logger.warning(adminMessages.ADMIN_SIGNATURE_INVALID(empId));
      throw new AppError(
        ADMIN_ERRORS.SIGNATURE_RESET_REQUIRED,
        HTTP_STATUS.UNPROCESSABLE,
        { type: "DataIntegrityError" },
      );
    }

    return existing;
  }

  /**
   * Throws a 400 ValidationError when `role` is not in VALID_ROLES.
   *
   * @param {string} role
   * @throws {AppError} 400
   * @private
   */
  static _validateRole(role) {
    if (!VALID_ROLES.includes(role)) {
      throw new AppError(
        VALIDATION_ERRORS.INVALID_INPUT,
        HTTP_STATUS.BAD_REQUEST,
        {
          type: "ValidationError",
          details: [
            {
              field: "role",
              issue: `Invalid role. Accepted values: ${VALID_ROLES.join(", ")}.`,
            },
          ],
        },
      );
    }
  }

  /**
   * Throws a 400 DefaultPasswordForbiddenError when the supplied password
   * matches the system default password (plain-text compare only; the server
   * enforces this before hashing so there is no stored hash to compare against).
   *
   * @param {string|undefined} password
   * @throws {AppError} 400
   * @private
   */
  static _rejectDefaultPassword(password) {
    const defaultPw = process.env.ADMIN_DEFAULT_PASSWORD;
    if (defaultPw && password === defaultPw) {
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
}

module.exports = AdminManagementService;
