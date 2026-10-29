/**
 * lastLocation.js — the last in-app page a signed-in user was allowed onto.
 *
 * WHY: "Back to home" from an error page, and a signed-in user opening "/" or "/auth", should land
 * where that user left off — not on the login form while their session is still valid.
 *
 * STORAGE: sessionStorage (per tab, gone when the tab closes), bound to the `user_display.userId`
 * that login writes, so a stale entry from the previous person on a shared browser is ignored.
 * `AuthMiddleware.signout()` clears it as well (CWE-524).
 *
 * SECURITY: written and read through `sanitizeReturnTo` (CWE-601) — error pages, /auth*, logout,
 * protocol-relative and absolute URLs are never stored and never returned. "/" is not stored either:
 * it is the smart landing that reads this value, so storing it would loop.
 * Complexity: O(n) in path length.
 */
import { sanitizeReturnTo } from "./returnTo";
import { storage } from "./storage";

/** sessionStorage key. */
export const LAST_LOCATION_KEY = "app.lastLocation";

/** @returns {string|null} The signed-in user's id from the non-PII `user_display` hint. */
export function currentUserId() {
    // Through the never-throwing wrapper: a browser that blocks storage must not crash an error page.
    if (storage.get("user_session") == null) return null;
    const id = storage.get("user_display")?.userId;
    return id == null || id === "" ? null : String(id);
}

/**
 * @param {string} path      Path + search of the page the user is on.
 * @param {string|number|null} [userId] Owner; defaults to the current signed-in user.
 */
export function recordLastLocation(path, userId = currentUserId()) {
    const safe = sanitizeReturnTo(path);
    if (!safe || safe === "/" || safe.startsWith("/?") || userId == null) return;
    storage.session.set(LAST_LOCATION_KEY, { path: safe, userId: String(userId) });
}

/** @returns {string|null} The current user's last safe location, or null. */
export function readLastLocation() {
    const entry = storage.session.get(LAST_LOCATION_KEY);
    const owner = currentUserId();
    if (!entry || owner == null || String(entry.userId) !== owner) return null;
    return sanitizeReturnTo(entry.path);
}

export function clearLastLocation() {
    storage.session.remove(LAST_LOCATION_KEY);
}
