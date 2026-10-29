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
 *   - Transparently re-sends an idempotent GET/HEAD/OPTIONS up to twice when the
 *     API sheds load with a 429 `PoolOverloadedError` (honours Retry-After)
 *   - Adds X-Client-Username header for server-side traceability
 *
 * Usage:
 *   import httpClient from '../../middleware/HttpClient';
 *   const response = await httpClient.get('users');
 *   const response = await httpClient.post('users', { name: 'John' });
 */

import axios from "axios";
import { API_BASE_URL as BASE_URL } from "../config/apiBase";
import { ERROR_PAGE_ROUTES, SERVER_SHUTTING_DOWN_TYPE, resolveStatusHandling } from "../constants/httpStatus";
import { SHED_RETRY_MAX, extractRetryAfter, isShedRetryable, shedRetryDelayMs, sleepUnlessAborted } from "../utils/retryAfter";
import { SERVER_STATUS_KIND, reportServerStatus } from "../utils/serverStatus";
import { stashErrorPagePayload } from "../utils/storage";
import AuthMiddleware from "./authentication/AuthMiddleware";
import CsrfMiddleware from "./security/CsrfMiddleware";

// CSRF is not required for these endpoints (they ARE the CSRF endpoints)
const CSRF_EXEMPT = ["csrf/token", "csrf/refresh", "csrf/status"];

// csrf/token is pre-auth (no user context yet); csrf/refresh is protected and should send identity
const TRACEABILITY_EXEMPT = ["csrf/token"];

// CSRF failures arrive as a 403 carrying a STRING `code` enum — a different
// contract from the AppError envelope's numeric `code`. These four are the only
// 403s the client retries; every other 403 is a business-rule denial and is
// handed to the caller untouched.
//
// ADVISORY ONLY — this list is broader than what the backend actually emits.
// The sole backend CSRF code that triggers refresh-and-retry is
// `CSRF_TOKEN_INVALID` (403). `NO_CSRF_SESSION` is a 400 and is intentionally
// not retried (the retry guard requires status === 403, so a 400 can never
// match regardless). The other names below (`CSRF_SECRET_MISSING`,
// `CSRF_TOKEN_MISSING`, `CSRF_TOKEN_EXPIRED`) are not emitted by the backend
// and are inert — kept only for documentation; they change no runtime behaviour.
const CSRF_ERROR_CODES = ["CSRF_SECRET_MISSING", "CSRF_TOKEN_MISSING", "CSRF_TOKEN_INVALID", "CSRF_TOKEN_EXPIRED"];

// Backend `error.type` for a session that must change its password first
// (AuthMiddleware's server-side gate), and the one screen that clears it.
const PASSWORD_CHANGE_REQUIRED_TYPE = "PasswordChangeRequiredError";
const CHANGE_PASSWORD_ROUTE = "/auth/change-password";

// Shed-retry rules (PoolOverloadedError, ServerShuttingDown) live in utils/retryAfter.js, shared with
// CsrfMiddleware. Only idempotent methods are re-sent — the API has no
// idempotency keys, so a mutating retry could double-write.
const SHED_RETRY_METHODS = ["get", "head", "options"];

class HttpClient {
    constructor() {
        this._client = axios.create({
            baseURL: BASE_URL,
            withCredentials: true,
            // Default request budget so a hung/slow backend surfaces a
            // synthetic timeout error instead of leaving the UI waiting
            // indefinitely (Axios's own default is 0 = unlimited). Endpoints
            // that are known to genuinely run long — binary exports
            // (responseType: 'arraybuffer'), Excel verify/save uploads —
            // set their own larger per-call override in their *.api.js file;
            // this value is only the floor for everything else.
            timeout: 30_000,
            headers: { "Content-Type": "application/json" },
        });

        this._setupRequestInterceptor();
        this._setupResponseInterceptor();
        this._initCsrf();
    }

    // ─── Navigation seam ──────────────────────────────────────────────────────

    /**
     * Performs the full-page navigation a takeover status requires.
     *
     * Exists as a method purely so the destination is assertable. jsdom's
     * `window.location` is [Unforgeable] — `replace` is non-writable and
     * non-configurable — so a test cannot observe the URL a redirect targets,
     * and every status-to-route mapping below would otherwise be untestable
     * (a gap `test/helpers/setup.js` documented but could not close). Spying on
     * this one prototype method restores that observability without exposing a
     * public setter that production code could repoint.
     *
     * A hard navigation, not a router push: dropping every in-memory store is
     * the point when a session ends or the origin goes away.
     *
     * @param {string} url Destination path.
     * @returns {void}
     */
    _navigate(url) {
        window.location.replace(url);
    }

    /**
     * Path + search of the current page, or null when the user is already on an error route.
     * @returns {string|null}
     */
    _currentReturnTo() {
        const { pathname, search } = window.location;
        return Object.values(ERROR_PAGE_ROUTES).some((r) => pathname === r || pathname.startsWith(`${r}/`)) ? null : `${pathname}${search}`;
    }

    /**
     * True when the current page IS `route` (exact path or a sub-path; query ignored).
     * @param {string} route Root-relative takeover route.
     * @returns {boolean}
     */
    _isOnRoute(route) {
        const { pathname } = window.location;
        return pathname === route || pathname.startsWith(`${route}/`);
    }

    /** @param {string|number|null|undefined} header Raw Retry-After. @returns {number} ms (see `shedRetryDelayMs`). */
    _shedRetryDelayMs(header) {
        return shedRetryDelayMs(header);
    }

    /**
     * Sleeps `ms`, rejecting with an Axios `CanceledError` if the request's
     * AbortController signal aborts first (or already has).
     *
     * @param {number} ms
     * @param {object} config Axios request config (reads `signal`).
     * @returns {Promise<void>}
     */
    _waitUnlessAborted(ms, config) {
        return sleepUnlessAborted(ms, config?.signal, () => new axios.CanceledError("canceled", config));
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
                // Send time, so an OK that left the server BEFORE a drain began
                // cannot clear the "restarting" banner (see utils/serverStatus).
                config._sentAt = Date.now();

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
                    } catch (csrfErr) {
                        // The token fetch is the first thing a save touches: if the server is
                        // unreachable it fails here, before Axios sends anything, so the response
                        // interceptor never sees it. Same rule as below: network failure only.
                        if (csrfErr?.networkFailure === true) reportServerStatus(SERVER_STATUS_KIND.NETWORK_FAILURE);
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
            (response) => {
                if (response.config?._serverStatusProbe) return response;
                if (response.status === 503 && response.data?.error?.type === SERVER_SHUTTING_DOWN_TYPE) {
                    reportServerStatus(SERVER_STATUS_KIND.SHUTDOWN);
                } else if (response.status < 500) {
                    reportServerStatus(SERVER_STATUS_KIND.OK, { sentAt: response.config?._sentAt });
                }
                return response;
            },
            async (error) => {
                // The readiness probe owns its own outcome: no report, no retry,
                // no takeover, no feedback loop into the banner it drives.
                if (error.config?._serverStatusProbe) return Promise.reject(error);

                // Attach the server-assigned Request ID to the error object so
                // every catch block can display it without parsing headers.
                if (error.response) {
                    error.requestId = error.response.data?.requestId ?? error.response.headers?.["x-request-id"] ?? null;
                }

                const originalRequest = error.config;
                const status = error.response?.status;
                const errorCode = error.response?.data?.code;
                const requiresRefresh = error.response?.data?.requiresRefresh;

                // ── Reachability report (drives <ServerStatusBanner>) ─────────
                // Only a genuine transport failure counts: timeouts (ECONNABORTED /
                // ETIMEDOUT), cancellations and the CSRF pre-flight Error are not
                // outages. SHUTDOWN is emitted BEFORE any shed wait so the banner
                // appears at once, not after the retries finish.
                const errType = error.response?.data?.error?.type;
                if (axios.isAxiosError(error) && error.code === "ERR_NETWORK") {
                    reportServerStatus(SERVER_STATUS_KIND.NETWORK_FAILURE);
                } else if (status === 503 && errType === SERVER_SHUTTING_DOWN_TYPE) {
                    reportServerStatus(SERVER_STATUS_KIND.SHUTDOWN);
                } else if (status < 500) {
                    reportServerStatus(SERVER_STATUS_KIND.OK, { sentAt: originalRequest?._sentAt });
                }

                // ── Load-shed retry (429 PoolOverloadedError / 503 ServerShuttingDown, idempotent only) ─
                // Runs BEFORE the status plan so a retried-then-successful
                // request never reaches the 429 takeover, and BEFORE the CSRF
                // retry below; it uses its own `_shedRetry` counter and never
                // touches `_retry`. Idempotent methods carry no CSRF token, so
                // the two paths cannot overlap. After SHED_RETRY_MAX attempts
                // the error falls through to the normal 429 handling.
                if (
                    isShedRetryable(status, errType) &&
                    originalRequest &&
                    SHED_RETRY_METHODS.includes(originalRequest.method?.toLowerCase()) &&
                    (originalRequest._shedRetry ?? 0) < SHED_RETRY_MAX
                ) {
                    originalRequest._shedRetry = (originalRequest._shedRetry ?? 0) + 1;
                    await this._waitUnlessAborted(this._shedRetryDelayMs(error.response?.headers?.["retry-after"]), originalRequest);
                    return this._client(originalRequest);
                }

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

                // A self-handled screen (sign-in) keeps an infrastructure outage inline, so the 523 page —
                // which normally starts the outage episode on mount — never loads. Start it here so the
                // global banner and its readiness probe still run on that screen.
                if (plan.outageCause && plan.mode !== "takeover") {
                    reportServerStatus(SERVER_STATUS_KIND.OUTAGE, { cause: plan.outageCause });
                }

                if (plan.endsSession) {
                    AuthMiddleware.signout();
                    CsrfMiddleware.clearToken();
                }

                if (plan.mode === "takeover") {
                    // Already on that screen: a replace() to the same URL is a full reload, and on the
                    // 523 page with the database down every boot request (e.g. VersionProvider's uncached
                    // changelog read) answers 503 again — a reload loop that never lets the page's own
                    // probe loop run. Stay put, keep the page's hand-off payload, let the caller see it.
                    if (this._isOnRoute(plan.route)) return Promise.reject(error);
                    // Carry the server's own words across the hard navigation.
                    // `window.location.replace` is a full document load, so
                    // router state does not survive it — without this hand-off
                    // every takeover screen falls back to hardcoded copy and
                    // tells the user the same thing whatever actually happened.
                    // `stashErrorPagePayload` never throws: a private-mode
                    // browser losing the message must not escalate into losing
                    // the error page too.
                    stashErrorPagePayload({
                        code: status ?? null,
                        title: body?.title ?? null,
                        message: body?.message ?? null,
                        requestId: error.requestId ?? null,
                        // 429 only — the limiter reports its own wait, in the
                        // body's details or the standard Retry-After header.
                        retryAfter: status === 429 ? extractRetryAfter(body, error.response?.headers?.["retry-after"]) : null,
                        // Where the user was, so the 523 page can offer "Continue where you left
                        // off". Never an error route (a second takeover while already on one would
                        // point the way back at the error page). The reader re-validates (CWE-601).
                        returnTo: this._currentReturnTo(),
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

                // A session opened with an emailed temporary password (or the
                // legacy default) is refused by every route except the
                // change-password ones — the server enforces it, so any page
                // that loads first would otherwise render a bare "forbidden".
                // Send the user to the one screen that can clear it.
                if (status === 403 && body?.error?.type === PASSWORD_CHANGE_REQUIRED_TYPE) {
                    if (!window.location.pathname.startsWith(CHANGE_PASSWORD_ROUTE)) {
                        this._navigate(CHANGE_PASSWORD_ROUTE);
                    }
                    return Promise.reject(error);
                }

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
