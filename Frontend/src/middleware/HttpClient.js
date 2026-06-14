/**
 * HttpClient — Axios instance with automatic CSRF injection and request traceability.
 *
 * This is the ONLY place Axios is configured. Never import Axios directly
 * in feature files. Always use this module.
 *
 * What it does automatically:
 *   - Sends HttpOnly signed `accessToken` cookie automatically via withCredentials (browser handles this)
 *   - Injects x-csrf-token on POST/PUT/DELETE/PATCH via CsrfMiddleware
 *   - Retries once on CSRF 403 errors after token refresh
 *   - Adds X-Client-Username header for server-side traceability
 *
 * Usage:
 *   import httpClient from '../../middleware/HttpClient';
 *   const response = await httpClient.get('users');
 *   const response = await httpClient.post('users', { name: 'John' });
 */

import axios from "axios";
import AuthMiddleware from "./authentication/AuthMiddleware";
import CsrfMiddleware from "./security/CsrfMiddleware";

const BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:3000/api/v1/";

// CSRF is not required for these endpoints (they ARE the CSRF endpoints)
const CSRF_EXEMPT = ["csrf/token", "csrf/refresh", "csrf/status"];

// csrf/token is pre-auth (no user context yet); csrf/refresh is protected and should send identity
const TRACEABILITY_EXEMPT = ["csrf/token"];

class HttpClient {
    constructor() {
        this._client = axios.create({
            baseURL: BASE_URL,
            withCredentials: true,
            headers: { "Content-Type": "application/json" },
        });

        this._setupRequestInterceptor();
        this._setupResponseInterceptor();
        this._initCsrf();
    }

    // ─── Setup ────────────────────────────────────────────────────────────────

    async _initCsrf() {
        try {
            await CsrfMiddleware.initialize();
        } catch {
            // CSRF init failure is handled per-request in the interceptor
        }
    }

    _setupRequestInterceptor() {
        this._client.interceptors.request.use(
            async (config) => {
                // Let Axios auto-set Content-Type (with boundary) for FormData
                if (config.data instanceof FormData) {
                    delete config.headers["Content-Type"];
                }

                const isExemptAuth = TRACEABILITY_EXEMPT.some((p) => config.url?.includes(p));
                const isExemptCsrf = CSRF_EXEMPT.some((p) => config.url?.includes(p));
                const isMutating = ["POST", "PUT", "DELETE", "PATCH"].includes(config.method?.toUpperCase());

                // Client identity for server traceability
                if (!isExemptAuth) {
                    const userDisplay = AuthMiddleware.getLocalStorage("user_display");
                    const displayName = [userDisplay?.firstName, userDisplay?.lastName].filter(Boolean).join(" ") || userDisplay?.userId;
                    config.headers["X-Client-Username"] = displayName ? `${displayName}@${userDisplay.userId}` : "anonymous@unknown";
                }

                // CSRF header
                if (isMutating && !isExemptCsrf) {
                    try {
                        const csrfToken = await CsrfMiddleware.ensureTokenReady();
                        if (!csrfToken) throw new Error("No CSRF token available");
                        config.headers["x-csrf-token"] = csrfToken;
                    } catch {
                        return Promise.reject(new Error("CSRF token required but unavailable"));
                    }
                }

                return config;
            },
            (error) => Promise.reject(error),
        );
    }

    _setupResponseInterceptor() {
        this._client.interceptors.response.use(
            (response) => response,
            async (error) => {
                // 440 — Session timed out (JWT expired, normal lifecycle).
                // The SessionWarningModal handles the proactive case; this
                // is the fallback when a request is made after expiry.
                if (error.response?.status === 440) {
                    AuthMiddleware.signout();
                    CsrfMiddleware.clearToken();
                    window.location.replace("/login-timeout");
                    return Promise.reject(error);
                }

                // 498 — Invalid token (malformed / tampered). Redirect to /invalid-token.
                // This must run BEFORE the CSRF retry block so a bad token
                // is never mistaken for a CSRF failure.
                if (error.response?.status === 498) {
                    AuthMiddleware.signout();
                    CsrfMiddleware.clearToken();
                    window.location.replace("/invalid-token");
                    return Promise.reject(error);
                }

                const originalRequest = error.config;
                const errorCode = error.response?.data?.code;
                const requiresRefresh = error.response?.data?.requiresRefresh;

                const isCsrfError = error.response?.status === 403 && errorCode && ["CSRF_SECRET_MISSING", "CSRF_TOKEN_MISSING", "CSRF_TOKEN_INVALID", "CSRF_TOKEN_EXPIRED"].includes(errorCode);

                const isMutating = ["post", "put", "delete", "patch"].includes(originalRequest?.method?.toLowerCase());

                // Retry once on CSRF errors
                if ((isCsrfError || requiresRefresh) && isMutating && !originalRequest._retry) {
                    originalRequest._retry = true;
                    try {
                        const newToken = await CsrfMiddleware.forceRefresh();
                        if (newToken) {
                            originalRequest.headers["x-csrf-token"] = newToken;
                            return this._client(originalRequest);
                        }
                    } catch {
                        /* fall through */
                    }
                }

                return Promise.reject(error);
            },
        );
    }

    // ─── Public HTTP methods ──────────────────────────────────────────────────

    get(url, config) {
        return this._client.get(url, config);
    }

    post(url, data, config) {
        return this._client.post(url, data, config);
    }

    put(url, data, config) {
        return this._client.put(url, data, config);
    }

    patch(url, data, config) {
        return this._client.patch(url, data, config);
    }

    delete(url, config) {
        return this._client.delete(url, config);
    }

    /** Direct access to the Axios instance for edge cases */
    get axios() {
        return this._client;
    }
}

// Singleton export
const httpClient = new HttpClient();
export default httpClient;
export { HttpClient };
