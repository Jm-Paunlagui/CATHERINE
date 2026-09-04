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
import { API_BASE_URL } from "../config/apiBase";
import { resolveStatusHandling } from "../constants/httpStatus";
import { stashErrorPagePayload } from "../utils/storage";
import AuthMiddleware from "./authentication/AuthMiddleware";
import CsrfMiddleware from "./security/CsrfMiddleware";

const BASE_URL = API_BASE_URL;

// CSRF is not required for these endpoints (they ARE the CSRF endpoints)
const CSRF_EXEMPT = ["csrf/token", "csrf/refresh", "csrf/status"];

// csrf/token is pre-auth (no user context yet); csrf/refresh is protected and should send identity
const TRACEABILITY_EXEMPT = ["csrf/token"];

// Only these server error codes justify a one-shot CSRF token refresh + retry.
// A blanket "retry any 403" would mask genuine authorization failures behind a
// second doomed request. This is an allow-list, not a catch-all.
const CSRF_ERROR_CODES = ["CSRF_SECRET_MISSING", "CSRF_TOKEN_MISSING", "CSRF_TOKEN_INVALID", "CSRF_TOKEN_EXPIRED"];

class HttpClient {
    constructor() {
        this._client = axios.create({
            baseURL: BASE_URL,
            withCredentials: true,
            timeout: 30_000,
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
                // Attach the server-assigned Request ID to the error object so
                // every catch block can display it without parsing headers.
                if (error.response) {
                    error.requestId = error.response.data?.requestId ?? error.response.headers?.["x-request-id"] ?? null;
                }

                const originalRequest = error.config;
                const status = error.response?.status;
                const errorCode = error.response?.data?.code;
                const requiresRefresh = error.response?.data?.requiresRefresh;

                // ── Status → UI reaction, resolved from ONE table ─────────────
                // `resolveStatusHandling` (src/constants/httpStatus.js) owns the
                // takeover-vs-inline decision for every code the API can return.
                // This block deliberately runs BEFORE the CSRF retry below for
                // two reasons: a dead/tampered token (440/498) must never be
                // mistaken for a CSRF failure, and a rate-limited request must
                // never be retried — the limiter counts every request in its
                // window, so a retry extends the very block it is escaping.
                const body = error.response?.data;
                const plan = resolveStatusHandling(status, {
                    url: originalRequest?.url ?? "",
                    errorType: body?.error?.type ?? null,
                    // An edge proxy or a dead origin answers with HTML or an
                    // empty body — no `status: "error"` field. That absence is
                    // itself the signal that no service handled the request.
                    hasEnvelope: body?.status === "error",
                });

                if (plan.endsSession) {
                    AuthMiddleware.signout();
                    CsrfMiddleware.clearToken();
                }

                if (plan.mode === "takeover") {
                    // Carry the server's own words across the hard navigation.
                    // `window.location.replace` is a full document load, so
                    // router state does not survive it — without this hand-off
                    // every takeover screen falls back to hardcoded copy and
                    // tells the user the same thing whatever actually happened.
                    // `stashErrorPagePayload` never throws: a private-mode
                    // browser losing the message must not escalate into losing
                    // the error page too.
                    const details = body?.error?.details ?? [];
                    stashErrorPagePayload({
                        code: status ?? null,
                        title: body?.title ?? null,
                        message: body?.message ?? null,
                        requestId: error.requestId ?? null,
                        // 429 only — the limiter reports its own wait, in the
                        // body's details or the standard Retry-After header.
                        retryAfter: status === 429 ? (details.find((d) => d?.field === "retryAfter")?.issue ?? error.response?.headers?.["retry-after"] ?? null) : null,
                    });
                    this._navigate(plan.route);
                    return Promise.reject(error);
                }

                // Invariant, not a live path: today every session-ending status
                // also has a takeover route, so this cannot be reached. It
                // stands so that adding a session-ending status WITHOUT a route
                // can never fall through into the retry below — re-sending a
                // request whose credential the server has just rejected is
                // never the right move.
                if (plan.endsSession) return Promise.reject(error);

                const isCsrfError = status === 403 && errorCode && CSRF_ERROR_CODES.includes(errorCode);

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

    /**
     * Hard navigation seam. Kept as its own method so tests can stub the one
     * side effect that a jsdom environment cannot perform (`window.location`
     * is not assignable there), without mocking the whole interceptor.
     * `replace` — not `assign` — so a takeover screen never becomes a Back-
     * button trap that returns the user to the failed request.
     */
    _navigate(url) {
        window.location.replace(url);
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
