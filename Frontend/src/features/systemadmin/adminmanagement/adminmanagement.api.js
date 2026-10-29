/**
 * adminmanagement.api.js — Admin Management HTTP calls.
 *
 * HTTP layer only — no state, no React, no side effects.
 * All functions return the raw Axios response object.
 *
 * Backend contract:
 *   GET    admin-management/search?q=<query>  → { data: Array<account & { isAdmin, emailOnFile, emailHint }> }
 *   GET    admin-management                   → { data: Array<enrichedAdmin & { emailOnFile, emailHint, tempPasswordExpiresAt }> }
 *   POST   admin-management      body { username, role, flags?, overrideEmail? }
 *                                            → { data: TempPasswordIssue & { role } }
 *   PUT    admin-management/:username  body { role }  → { data: { username, role } } (SUPER_ADMIN only)
 *   PATCH  admin-management/:username/reset-password   body { overrideEmail? } → { data: TempPasswordIssue }
 *
 *   TempPasswordIssue = { username, emailDelivered, recipientSource: 'PROFILE'|'OVERRIDE',
 *                         recipientHint: 'j***@corp.com', tempPasswordExpiresAt }
 *   The server generates the temporary password and emails it; it is never in
 *   a response. `overrideEmail` is accepted only when the account profile has
 *   no usable address (400 otherwise; 422 when it is needed and missing).
 *   PATCH  admin-management/:username/reset-signature  → { data: { username } }
 *   PATCH  admin-management/:username/permissions      → { data: { username } }
 *   POST   admin-management/:username/revoke-backup    → binary .zip; X-Backup-Token /
 *                                                      X-Backup-Token-Expires-At response headers
 *   POST   admin-management/:username/revoke     body { backupToken } → { data: { username, isActive } }
 *   DELETE admin-management/:username            body { backupToken } → { data: { username } }
 *
 * Revoke reuses the same signed backup-token machinery as Data Purge &
 * Restore's `/backup` — the SAME token authorises either `/revoke` or
 * `DELETE`, so one backup download covers both.
 */

import httpClient from "../../../middleware/HttpClient";

/**
 * @typedef {{
 *   canReceiveSrvCrit?: 'Y'|'N',
 *   canReceiveSrvDeps?: 'Y'|'N',
 *   canReceiveSrvRed?:  'Y'|'N',
 *   canReceiveSrvSys?:  'Y'|'N',
 *   isActive?:          'Y'|'N',
 * }} AdminFlags
 */

export const adminManagementApi = {
    /**
     * Search accounts by username, first name, or last name.
     * Results include an `isAdmin` boolean flag.
     *
     * @param {string} q - Search term
     * @returns {Promise<import('axios').AxiosResponse>}
     */
    search: (q) => httpClient.get("admin-management/search", { params: { q } }),

    /**
     * Fetch all admin records enriched with profile data.
     *
     * @returns {Promise<import('axios').AxiosResponse>}
     */
    list: () => httpClient.get("admin-management"),

    /**
     * Create a new admin record. The server emails the account holder a
     * temporary password — there is no password field.
     *
     * @param {{ username: string, role: string, overrideEmail?: string, flags?: AdminFlags }} data
     * @returns {Promise<import('axios').AxiosResponse>}
     */
    create: (data) => httpClient.post("admin-management", data),

    /**
     * Change an admin's role (Super Admin only). Edit never sets a password —
     * the API refuses `changePassword`/`newPassword`; use `resetPassword`.
     *
     * @param {string} username
     * @param {{ role: string }} data
     * @returns {Promise<import('axios').AxiosResponse>}
     */
    update: (username, data) => httpClient.put(`admin-management/${username}`, data),

    /**
     * Issue and email a new temporary password (valid 72 hours, only for
     * setting a new password). Any previous password stops working.
     *
     * @param {string} username
     * @param {{ overrideEmail?: string }} [body] - only when the profile has no email for this account
     * @returns {Promise<import('axios').AxiosResponse>}
     */
    resetPassword: (username, body = {}) => httpClient.patch(`admin-management/${username}/reset-password`, body),

    /**
     * Recompute the SYSSIGNATURE for a tampered / broken admin record.
     *
     * @param {string} username
     * @returns {Promise<import('axios').AxiosResponse>}
     */
    resetSignature: (username) => httpClient.patch(`admin-management/${username}/reset-signature`),

    /**
     * Stream the revoke backup archive for one admin (ENTITY-kind — their
     * admin row, audit-log rows and alert acknowledgements). Response is
     * binary; read the `X-Backup-Token` / `X-Backup-Token-Expires-At` response
     * headers to continue the revoke/delete flow.
     *
     * ⚠️ The archive contains the password hash and SYSSIGNATURE — credential
     * material. Never log, email, or upload it anywhere except back into Data
     * Purge & Restore's restore flow.
     *
     * @param {string} username
     * @returns {Promise<import('axios').AxiosResponse<Blob>>}
     */
    revokeBackup: (username) =>
        // `{}`, never `null`: HttpClient sends Content-Type application/json,
        // so Axios would serialise null to the string "null", which the API's
        // strict JSON parser rejects with 400 before the route runs.
        httpClient.post(`admin-management/${username}/revoke-backup`, {}, {
            responseType: "blob",
            // A backup archive can take longer than HttpClient's global 30s budget.
            timeout: 120_000,
        }),

    /**
     * Revoke access — the DEFAULT, non-destructive way access is removed.
     * Deactivates the admin (`IS_ACTIVE='N'` + every notification flag 'N') and
     * re-signs SYSSIGNATURE.
     *
     * @param {string} username
     * @param {string} backupToken - Issued by `revokeBackup(username)`.
     * @returns {Promise<import('axios').AxiosResponse>}
     */
    revoke: (username, backupToken) => httpClient.post(`admin-management/${username}/revoke`, { backupToken }),

    /**
     * Permanently delete an admin record.
     *
     * @param {string} username
     * @param {string} backupToken - Issued by `revokeBackup(username)`.
     * @returns {Promise<import('axios').AxiosResponse>}
     */
    remove: (username, backupToken) => httpClient.delete(`admin-management/${username}`, { data: { backupToken } }),

    /**
     * Update an admin's permission flags (SUPER_ADMIN only).
     *
     * @param {string} username
     * @param {AdminFlags} flags
     * @returns {Promise<import('axios').AxiosResponse>}
     */
    updatePermissions: (username, flags) => httpClient.patch(`admin-management/${username}/permissions`, { flags }),
};
