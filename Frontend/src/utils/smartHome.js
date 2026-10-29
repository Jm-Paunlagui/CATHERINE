/**
 * smartHome.js — where "home" / "Try again" / "continue" should take the user.
 *
 * Resolution (6-case matrix: session valid|invalid x returnTo safe|absent|unsafe):
 *   signed in  → sanitized returnTo ?? last location ?? SIGNED_IN_HOME (the shared role landing)
 *   signed out → sanitized returnTo when it is a PUBLIC page, otherwise "/"
 *
 * "Signed in" is the synchronous client hint (`user_session` + `user_display.userId`). No request is
 * made here on purpose: these links render on the 429 page, where every extra request extends the
 * block. The destination's own ProtectedRoute verifies with the server; a stale hint is cleared
 * there and the next "home" resolves to "/", so it converges instead of looping.
 *
 * SECURITY: every candidate passes `sanitizeReturnTo` (CWE-601). Complexity: O(n) in path length.
 */
import { readLastLocation, currentUserId } from "./lastLocation";
import { sanitizeReturnTo } from "./returnTo";

/** Routes a signed-out visitor may be returned to (App.jsx mounts these without ProtectedRoute). */
export const PUBLIC_RETURN_PATHS = Object.freeze(["/", "/home", "/about"]);

/** Where a signed-in user lands with no better hint — every role's landing (features/auth/roleRedirect.js). */
export const SIGNED_IN_HOME = "/dashboard";

function isPublicPath(value) {
    const pathname = value.split(/[?#]/, 1)[0].replace(/\/+$/, "") || "/";
    return PUBLIC_RETURN_PATHS.some((p) => pathname === p || (p !== "/" && pathname.startsWith(`${p}/`)));
}

/**
 * @param {unknown} returnTo Raw "where was the user" hint (e.g. a stashed error-page payload field).
 * @returns {string} A safe root-relative destination (path + search).
 */
export function resolveHomeHref(returnTo) {
    const safe = sanitizeReturnTo(returnTo);
    if (currentUserId() != null) return safe ?? readLastLocation() ?? SIGNED_IN_HOME;
    return safe && isPublicPath(safe) ? safe : "/";
}

/** The PATH part only — what may be written into a DOM href (queries can carry ids/tokens; CWE-598). */
export function hrefPath(value) {
    return value.split(/[?#]/, 1)[0] || "/";
}

/**
 * Hard-navigation seam (a fresh document drops any in-memory state left by the error). An object so
 * tests can spy on it — jsdom's `location` is unforgeable. Never repoint it from production code.
 */
export const homeNavigation = {
    /** @param {string} url Already-resolved root-relative path. */
    go(url) {
        window.location.replace(url);
    },
};
