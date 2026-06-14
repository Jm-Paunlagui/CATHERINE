/**
 * changePassword.api.js — Change Password HTTP calls.
 *
 * HTTP layer only — no state, no React.
 *
 * Backend contract:
 *   PATCH auth/change-password { currentPassword, newPassword }
 *     → { data: { user } }   (server also sets fresh HTTP-only cookie tokens)
 */

import httpClient from "../../middleware/HttpClient";

export const changePasswordApi = {
    /**
     * Change the authenticated user's password.
     *
     * @param {{ currentPassword: string, newPassword: string }} data
     * @returns {Promise<import('axios').AxiosResponse>}
     */
    changePassword: (data) => httpClient.patch("auth/change-password", data),
};
