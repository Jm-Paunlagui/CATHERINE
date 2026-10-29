/**
 * roleRedirect.js — Role-based landing paths after authentication.
 *
 * Single source of truth for where each role lands after a successful
 * login or a forced password change. Unknown or missing roles fall back
 * to the USER landing page.
 */

/**
 * Landing path per role after successful authentication.
 *
 * @type {Record<string, string>}
 */
export const ROLE_LANDING_PATHS = {
    // Every role lands on the Dashboard — the one authenticated route the template
    // mounts for all roles. A project points each role at its own feature page here.
    USER: "/dashboard",
    ADMIN: "/dashboard",
    SUPER_ADMIN: "/dashboard",
};

/**
 * Resolve the post-login landing path for a role.
 *
 * @param {string|null|undefined} role - Role string from the auth response
 *   ("USER" | "ADMIN" | "SUPER_ADMIN").
 * @returns {string} Route path to navigate to after authentication.
 */
export const getLandingPath = (role) => ROLE_LANDING_PATHS[role] || ROLE_LANDING_PATHS.USER;
