"use strict";

/**
 * @fileoverview Admin Management log message templates.
 * Used ONLY in logger calls — never thrown or sent to clients.
 */

const adminMessages = {
  ADMIN_SEARCH: (query) => `Employee search executed with query: "${query}".`,
  ADMIN_LIST_FETCHED: () =>
    "Admin list fetched and enriched with HRIS profile data.",
  ADMIN_CREATED: (empId, role) =>
    `Admin created — EMP_ID: ${empId}, ROLE: ${role}.`,
  ADMIN_UPDATED: (empId) => `Admin record updated — EMP_ID: ${empId}.`,
  ADMIN_DELETED: (empId) => `Admin removed — EMP_ID: ${empId}.`,
  ADMIN_PASSWORD_RESET: (empId) =>
    `Admin password reset to default — EMP_ID: ${empId}.`,
  ADMIN_SIGNATURE_RESET: (empId) =>
    `Admin SYSSIGNATURE recomputed — EMP_ID: ${empId}.`,
  ADMIN_SIGNATURE_INVALID: (empId) =>
    `SYSSIGNATURE mismatch detected for EMP_ID ${empId} — record may have been tampered with.`,
  ADMIN_ALREADY_EXISTS: (empId) =>
    `Admin creation rejected — EMP_ID ${empId} already exists in T_EMP_MGMT_ADMIN.`,
  ADMIN_NOT_FOUND: (empId) =>
    `Admin operation failed — EMP_ID ${empId} not found in T_EMP_MGMT_ADMIN.`,

  // ── Permission flags ──────────────────────────────────────────────────────
  /** @param {number|string} empId @param {object} flags */
  ADMIN_PERMISSIONS_UPDATED: (empId, flags) =>
    `Admin permission flags updated — EMP_ID: ${empId}, flags: ${JSON.stringify(flags)}.`,
  /** @param {number|string} empId @param {string} flag */
  ADMIN_PERMISSION_BLOCKED: (empId, flag) =>
    `Permission-flag gate denied — EMP_ID: ${empId} missing flag ${flag}.`,
  /** @param {number|string} empId */
  ADMIN_INACTIVE_LOGIN_BLOCKED: (empId) =>
    `Login blocked — admin EMP_ID: ${empId} has IS_ACTIVE='N'.`,
  /** @param {string} guardType — 'CAN_APPROVE_RESET' | 'CAN_APPROVE_BILLING' */
  ZERO_APPROVER_GUARD_TRIGGERED: (guardType) =>
    `Zero-approver guard triggered — removing last ${guardType}='Y' admin blocked.`,
};

module.exports = { adminMessages };
