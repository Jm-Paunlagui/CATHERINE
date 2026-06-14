/**
 * AuthMiddleware — Authentication helpers.
 *
 * Static class providing cookie/localStorage helpers and the isAuth()
 * check with a 5-minute cache. Mirrors the express-template's AuthMiddleware
 * philosophy: ships a mechanism, not domain-specific logic.
 *
 * Usage:
 *   import AuthMiddleware from '../../middleware/authentication/AuthMiddleware';
 *
 *   const user = await AuthMiddleware.isAuth();
 *   AuthMiddleware.authenticate({ firstName, lastName, userId }, () => navigate('/dashboard'));
 *   AuthMiddleware.signout();
 */

import cookie from "js-cookie";
import httpClient from "../HttpClient";

// Cache config — avoid redundant /verify calls
let _authCache = null;
let _authCacheTimestamp = null;
let _pendingAuthRequest = null;
let _lastAuthError = null; // last server error from isAuth(); consumed by ProtectedRoute
const AUTH_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

class AuthMiddleware {
    // ─── Cookie helpers ───────────────────────────────────────────────────────

    static setCookie(key, value, options = {}) {
        if (typeof window === "undefined") return;
        cookie.set(key, value, {
            domain: window.location.hostname,
            sameSite: "Strict",
            path: "/",
            ...options,
        });
    }

    static getCookie(key) {
        if (typeof window === "undefined") return null;
        return cookie.get(key) ?? null;
    }

    static removeCookie(key) {
        if (typeof window === "undefined") return;
        cookie.remove(key, {
            domain: window.location.hostname,
            path: "/",
            sameSite: "strict",
        });
    }

    // ─── LocalStorage helpers ─────────────────────────────────────────────────

    static setLocalStorage(key, value) {
        if (typeof window === "undefined") return;
        localStorage.setItem(key, JSON.stringify(value));
    }

    static getLocalStorage(key) {
        if (typeof window === "undefined") return null;
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        try {
            return JSON.parse(raw);
        } catch {
            return null;
        }
    }

    static removeLocalStorage(key) {
        if (typeof window === "undefined") return;
        localStorage.removeItem(key);
    }

    // ─── Auth lifecycle ───────────────────────────────────────────────────────

    /**
     * Clear auth cache and call next() — call after successful login.
     * Token cookie is set server-side (HTTP-only) — no client cookie needed.
     * Sets the non-PII session hint so isAuth() fast-fails are bypassed on the
     * first ProtectedRoute check immediately after navigation.
     *
     * Writes a minimal traceability identity to "user_display" so that
     * HttpClient can populate the X-Client-Username header on every request
     * without reading the full "user" object (which belongs to useSessionWarning).
     *
     * @param {{ firstName?: string, lastName?: string, userId?: string } | null} [userDisplay]
     * @param {Function} [next]
     */
    static authenticate(userDisplay, next) {
        AuthMiddleware.clearAuthCache();
        localStorage.setItem("user_session", "1");
        if (userDisplay && typeof userDisplay === "object") {
            AuthMiddleware.setLocalStorage("user_display", {
                firstName: userDisplay.firstName ?? null,
                lastName: userDisplay.lastName ?? null,
                userId: userDisplay.userId ?? null,
            });
        }
        if (typeof next === "function") next();
    }

    /**
     * Sign out — clear all auth state client-side.
     * Does NOT call the logout endpoint (that's the feature's job).
     */
    static signout() {
        AuthMiddleware.clearAuthCache();
        AuthMiddleware.removeCookie("token"); // cleanup stale plain cookie from older sessions
        AuthMiddleware.removeLocalStorage("user_session");
        AuthMiddleware.removeLocalStorage("user_display");
        AuthMiddleware.removeLocalStorage("user"); // remove legacy key from older sessions
    }

    /**
     * Clear the auth cache — call after login, logout, or token refresh.
     * Note: _lastAuthError is deliberately excluded — it is a one-shot store
     * consumed by ProtectedRoute via consumeLastError(), not part of the cache.
     */
    static clearAuthCache() {
        _authCache = null;
        _authCacheTimestamp = null;
        _pendingAuthRequest = null;
    }

    /**
     * Returns the server error payload from the most recent failed isAuth() check,
     * then clears it so stale errors never leak across navigations.
     *
     * Shape mirrors the standard API error response:
     *   { status, code, message, error: { type, hint? } }
     *
     * @returns {object|null}
     */
    static consumeLastError() {
        const err = _lastAuthError;
        _lastAuthError = null;
        return err;
    }

    /**
     * Check if the user is authenticated.
     *
     * 1. No "user_session" flag in localStorage → not logged in, return false immediately.
     *    The flag is a non-sensitive "1" value — it contains no PII (CWE-312).
     * 2. In-memory cache still valid (5 min) → return cached user
     *    (cache is module-scoped and cleared on every page refresh)
     * 3. Otherwise call GET auth/me — HTTP-only cookie is sent automatically
     *    via withCredentials:true; 401 → clear state and return false.
     *
     * The localStorage entry is only used as a session-exists signal (step 1).
     * All user data (role, GID, PII) lives exclusively in _authCache (memory).
     * The actual session validity is always decided by the server cookie check (step 3).
     *
     * @returns {Object|false} user object or false
     */
    static async isAuth() {
        if (typeof window === "undefined") return false;

        // "user_session" is a non-sensitive flag (value "1") — stores no PII.
        // It signals that a session cookie may exist so we attempt a verify call.
        // The actual user payload lives only in the module-scoped _authCache (memory).
        const hasSessionHint = localStorage.getItem("user_session");
        if (!hasSessionHint) {
            AuthMiddleware.clearAuthCache();
            return false;
        }

        // Return from in-memory cache — safe because this is module-scoped memory
        // that is cleared on every page refresh, so a deleted cookie is always
        // caught on the next page load.
        if (_authCache && _authCacheTimestamp && Date.now() - _authCacheTimestamp < AUTH_CACHE_DURATION) {
            return _authCache;
        }

        // Deduplicate concurrent calls
        if (_pendingAuthRequest) return _pendingAuthRequest;

        // Verify with backend — HTTP-only cookie is sent automatically
        _pendingAuthRequest = (async () => {
            try {
                const response = await httpClient.get("auth/me");
                const user = response.data?.data;

                if (user) {
                    _authCache = user;
                    _authCacheTimestamp = Date.now();
                    _pendingAuthRequest = null;
                    // Store only a non-sensitive flag — never PII (CWE-312, CWE-200).
                    // The user payload stays in module memory (_authCache) only.
                    localStorage.setItem("user_session", "1");
                    return user;
                }

                AuthMiddleware.clearAuthCache();
                localStorage.removeItem("user_session");
                return false;
            } catch (err) {
                const status = err?.response?.status;
                if (status === 498 || status === 440) {
                    // HttpClient interceptor handles signout + hard navigation
                    // (498 → /invalid-token, 440 → /login-timeout).
                    // Return a never-resolving promise so ProtectedRoute stays
                    // on the spinner instead of flashing <Navigate />.
                    return new Promise(() => {});
                }
                // Store the server error payload so ProtectedRoute can pass it as
                // navigation state to the error page for dynamic title/subtitle rendering.
                _lastAuthError = err.response?.data ?? null;
                AuthMiddleware.clearAuthCache();
                localStorage.removeItem("user_session");
                return false;
            }
        })();

        return _pendingAuthRequest;
    }
}

export default AuthMiddleware;
export { AuthMiddleware };
