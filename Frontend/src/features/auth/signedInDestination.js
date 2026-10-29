/**
 * signedInDestination.js — where a visitor who is ALREADY signed in belongs when they open "/" or "/auth".
 *
 * Returns the page they left off on (utils/lastLocation.js) or, failing that, their role landing page.
 * Without this a still-valid session was shown the login form (or the public board probe → /auth).
 *
 * Cost: no request at all when the `user_session` hint is absent (signed-out visitors keep the old
 * path untouched); otherwise one `auth/me`, served from AuthMiddleware's 5-minute cache when warm.
 */
import AuthMiddleware from "../../middleware/authentication/AuthMiddleware";
import { readLastLocation } from "../../utils/lastLocation";
import { storage } from "../../utils/storage";
import { getLandingPath } from "./roleRedirect";

/** @returns {boolean} True when there is a session hint worth verifying. */
export function hasSessionHint() {
    return storage.get("user_session") != null;
}

/**
 * @returns {Promise<string|null>} Destination for a verified session, or null when signed out.
 */
export async function resolveSignedInDestination() {
    if (!hasSessionHint()) return null;
    const user = await AuthMiddleware.isAuth();
    if (!user) return null;
    return readLastLocation() ?? getLandingPath(user.role);
}
