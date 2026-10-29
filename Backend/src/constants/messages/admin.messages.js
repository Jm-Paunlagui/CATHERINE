"use strict";

/**
 * @fileoverview Admin Management log message templates.
 * Used ONLY in logger calls — never thrown or sent to clients.
 */

const adminMessages = {
  ADMIN_SEARCH: (query) => `Account search executed with query: "${query}".`,
  ADMIN_LIST_FETCHED: () =>
    "Admin list fetched and enriched with user profile data.",
  ADMIN_CREATED: (username, role) =>
    `Admin created — USERNAME: ${username}, ROLE: ${role}.`,
  ADMIN_UPDATED: (username) => `Admin record updated — USERNAME: ${username}.`,
  ADMIN_DELETED: (username) => `Admin removed — USERNAME: ${username}.`,
  ADMIN_PASSWORD_RESET: (username) =>
    `Admin password reset to a new temporary password — USERNAME: ${username}.`,

  // ── Temporary-password delivery ──
  // Never interpolate the address or the password — USERNAME, source and outcome only.
  /** @param {string} username @param {'granted'|'reset'} kind @param {string} source */
  TEMP_PASSWORD_EMAIL_SENT: (username, kind, source) =>
    `Temporary password email sent (${kind}) — USERNAME: ${username}, recipient source: ${source}.`,
  /** @param {string} username @param {'granted'|'reset'} kind @param {string} cause */
  TEMP_PASSWORD_EMAIL_FAILED: (username, kind, cause) =>
    `Temporary password email NOT delivered (${kind}) — USERNAME: ${username}. The account holds an unclaimed temporary password; use Reset Password to send a new one. Cause: ${cause}`,
  /** @param {string} username @param {string} reason */
  TEMP_PASSWORD_RECIPIENT_REFUSED: (username, reason) =>
    `Temporary password not issued — USERNAME: ${username}, recipient refused: ${reason}. Nothing was written.`,
  /** @param {string} username @param {string} cause */
  TEMP_PASSWORD_RECIPIENT_LOOKUP_FAILED: (username, cause) =>
    `Recipient email lookup failed — USERNAME: ${username}. Nothing was written. Cause: ${cause}`,
  /**
   * Role-policy refusal. Both identifiers carry the `USERNAME:` label so
   * logRedaction can pseudonymise numeric usernames.
   * @param {string} callerUsername @param {string|null} callerRole
   * @param {string} action @param {string|null} targetUsername
   */
  ROLE_POLICY_DENIED: (callerUsername, callerRole, action, targetUsername) =>
    `Access Control refused — USERNAME: ${callerUsername} (${callerRole ?? "no role"}) may not ${action}` +
    (targetUsername != null ? ` on USERNAME: ${targetUsername}.` : "."),
  /** @param {string} username */
  TEMP_PASSWORD_LEGACY_FIELDS_REFUSED: (username) =>
    `Admin creation refused — USERNAME: ${username}; the request carried retainPassword/newPassword, which the server no longer accepts.`,
  ADMIN_SIGNATURE_RESET: (username) =>
    `Admin SYSSIGNATURE recomputed — USERNAME: ${username}.`,
  ADMIN_SIGNATURE_INVALID: (username) =>
    `SYSSIGNATURE mismatch detected for USERNAME: ${username} — record may have been tampered with.`,
  ADMIN_ALREADY_EXISTS: (username) =>
    `Admin creation rejected — USERNAME: ${username} already exists in T_ADMINS_DEV.`,
  ADMIN_NOT_FOUND: (username) =>
    `Admin operation failed — USERNAME: ${username} not found in T_ADMINS_DEV.`,

  // ── Permission flags ──────────────────────────────────────────────────────
  /** @param {string} username @param {object} flags */
  ADMIN_PERMISSIONS_UPDATED: (username, flags) =>
    `Admin permission flags updated — USERNAME: ${username}, flags: ${JSON.stringify(flags)}.`,
  /** @param {string} username */
  ADMIN_INACTIVE_LOGIN_BLOCKED: (username) =>
    `Login blocked — admin USERNAME: ${username} has IS_ACTIVE='N'.`,

  // ── Access Control revoke ───────────────────────────────────────────────────
  // Every identifier carries a label — logRedaction only matches prefixed ids.
  /** @param {string} username - target admin @param {number|string} adminId - issuing admin (T_ADMINS_DEV.ID) */
  ADMIN_REVOKE_BACKUP_ISSUED: (username, adminId) =>
    `Revoke-backup archive issued — target USERNAME: ${username}, issued to ADMIN_ID: ${adminId}.`,
  /** @param {string} username @param {string} reason */
  ADMIN_REVOKE_TOKEN_REJECTED: (username, reason) =>
    `Admin revoke/delete rejected — USERNAME: ${username}, backup token invalid: ${reason}.`,
  /** @param {string} username @param {string} updatedBy */
  ADMIN_REVOKED: (username, updatedBy) =>
    `Admin access revoked (deactivated, all CAN_* flags cleared, SYSSIGNATURE re-signed) — USERNAME: ${username}, by USERNAME: ${updatedBy}.`,
  /** @param {string} username */
  ADMIN_REVOKE_SELF_BLOCKED: (username) =>
    `Admin revoke rejected — USERNAME: ${username} attempted to revoke their own account.`,
  /** @param {string} username */
  ADMIN_DELETE_SELF_BLOCKED: (username) =>
    `Admin delete rejected — USERNAME: ${username} attempted to delete their own account.`,
  /** @param {number|string} adminId - T_ADMINS_DEV.ID */
  ADMIN_LAST_SUPER_ADMIN_BLOCKED: (adminId) =>
    `Admin action rejected — ADMIN_ID: ${adminId} is the last active SUPER_ADMIN.`,
};

module.exports = { adminMessages };
