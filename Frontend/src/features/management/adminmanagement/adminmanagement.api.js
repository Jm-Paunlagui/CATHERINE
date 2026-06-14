/**
 * adminmanagement.api.js — Admin Management HTTP calls.
 *
 * HTTP layer only — no state, no React, no side effects.
 * All functions return the raw Axios response object.
 *
 * Backend contract:
 *   GET    admin-management/search?q=<query>  → { data: Array<employee & { isAdmin }> }
 *   GET    admin-management                   → { data: Array<enrichedAdmin> }
 *   POST   admin-management                   → { data: { empId, empRole } }
 *   PUT    admin-management/:empId            → { data: { empId, empRole } }
 *   PATCH  admin-management/:empId/reset-password   → { data: { empId } }
 *   PATCH  admin-management/:empId/reset-signature  → { data: { empId } }
 *   PATCH  admin-management/:empId/permissions      → { data: { empId } }
 *   DELETE admin-management/:empId            → { data: { empId } }
 */

import httpClient from "../../../middleware/HttpClient";

export const adminManagementApi = {
    /**
     * Search HRIS employees by USERID, FIRSTNAME, or LASTNAME.
     * Results include an `isAdmin` boolean flag.
     *
     * @param {string} q - Search term
     * @returns {Promise<import('axios').AxiosResponse>}
     */
    search: (q) => httpClient.get("admin-management/search", { params: { q } }),

    /**
     * Fetch all admin records enriched with HRIS profile data.
     *
     * @returns {Promise<import('axios').AxiosResponse>}
     */
    list: () => httpClient.get("admin-management"),

    /**
     * Create a new admin record.
     *
     * @param {{
     *   empId: string,
     *   role: string,
     *   retainPassword: boolean,
     *   newPassword?: string,
     *   flags?: {
     *     canApproveReset?:   'Y'|'N',
     *     canRejectReset?:    'Y'|'N',
     *     canApproveBilling?: 'Y'|'N',
     *     canRejectBilling?:  'Y'|'N',
     *     canReceiveBilling?: 'Y'|'N',
     *     canExportBilling?:  'Y'|'N',
     *     isActive?:          'Y'|'N',
     *   }
     * }} data
     * @returns {Promise<import('axios').AxiosResponse>}
     */
    create: (data) => httpClient.post("admin-management", data),

    /**
     * Update an existing admin's role and optionally their password.
     *
     * @param {string} empId
     * @param {{ role: string, changePassword: boolean, newPassword?: string }} data
     * @returns {Promise<import('axios').AxiosResponse>}
     */
    update: (empId, data) => httpClient.put(`admin-management/${empId}`, data),

    /**
     * Reset an admin's password to the system default.
     *
     * @param {string} empId
     * @returns {Promise<import('axios').AxiosResponse>}
     */
    resetPassword: (empId) => httpClient.patch(`admin-management/${empId}/reset-password`),

    /**
     * Recompute the SYSSIGNATURE for a tampered / broken admin record.
     *
     * @param {string} empId
     * @returns {Promise<import('axios').AxiosResponse>}
     */
    resetSignature: (empId) => httpClient.patch(`admin-management/${empId}/reset-signature`),

    /**
     * Delete an admin record.
     *
     * @param {string} empId
     * @returns {Promise<import('axios').AxiosResponse>}
     */
    remove: (empId) => httpClient.delete(`admin-management/${empId}`),

    /**
     * Update an admin's permission flags (SUPER_ADMIN only).
     * Backend enforces a zero-approver guard — if the change would leave no
     * active admin with CAN_APPROVE_RESET='Y' or CAN_APPROVE_BILLING='Y',
     * it returns a 4xx AppError whose message must be surfaced in a toast.
     *
     * @param {string} empId
     * @param {{
     *   canApproveReset:   'Y'|'N',
     *   canRejectReset:    'Y'|'N',
     *   canApproveBilling: 'Y'|'N',
     *   canRejectBilling:  'Y'|'N',
     *   canReceiveBilling: 'Y'|'N',
     *   canExportBilling:  'Y'|'N',
     *   isActive:          'Y'|'N',
     * }} flags
     * @returns {Promise<import('axios').AxiosResponse>}
     */
    updatePermissions: (empId, flags) =>
        httpClient.patch(`admin-management/${empId}/permissions`, { flags }),
};
