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
    // Every authenticated role lands on the Dashboard — the one authenticated
    // route the template mounts for USER / ADMIN / SUPER_ADMIN (and, via its
    // shared guard set, the other admin roles). This keeps the boilerplate's
    // post-login destination valid regardless of which feature routes a
    // downstream project later adds.
    USER: "/dashboard",
    ADMIN: "/dashboard",
    SUPER_ADMIN: "/dashboard",
    APPROVER: "/dashboard",
    VIEWER: "/dashboard",
    // ROBOT is an RPA/automation account. It deliberately does NOT land on
    // "/auth": Login.view.jsx has no authenticated-visitor redirect, so sending
    // a just-authenticated ROBOT back to the login form would strand the
    // automation on a page it has already cleared. Dashboard is a safe default.
    ROBOT: "/dashboard",
};

/**
 * Resolve the post-login landing path for a role.
 *
 * @param {string|null|undefined} role - Role string from the auth response
 *   ("USER" | "ADMIN" | "SUPER_ADMIN" | "APPROVER" | "VIEWER" | "ROBOT").
 * @returns {string} Route path to navigate to after authentication.
 */
export const getLandingPath = (role) => ROLE_LANDING_PATHS[role] || ROLE_LANDING_PATHS.USER;
