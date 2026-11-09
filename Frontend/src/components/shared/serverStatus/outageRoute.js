/**
 * outageRoute.js — The one route that owns the "service is unavailable" screen.
 *
 * Shared by the banner (silent there), the server lock (never locks there) and the outage
 * redirect (never redirects from there). Pure; no React.
 */

import { ERROR_PAGE_ROUTES } from "../../../constants/httpStatus";

/** Root-relative path of the 523 page. */
export const OUTAGE_ROUTE = ERROR_PAGE_ROUTES[523];

/**
 * @param {string} pathname `location.pathname`.
 * @returns {boolean} True on the outage route itself or any sub-path (query is not part of a pathname).
 */
export function isOutageRoute(pathname) {
    return pathname === OUTAGE_ROUTE || pathname.startsWith(`${OUTAGE_ROUTE}/`);
}
