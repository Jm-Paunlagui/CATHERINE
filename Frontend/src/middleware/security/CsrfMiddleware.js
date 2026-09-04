/**
 * CsrfMiddleware — CSRF token lifecycle manager.
 *
 * Singleton class that handles fetching, caching, rotating, and
 * auto-refreshing the CSRF token. Uses the csrf-csrf library convention.
 *
 * Backend contract (csrf-csrf):
 *   GET  /csrf/token   → { success, token, expiresIn, expiresAt, refreshIn }
 *   POST /csrf/refresh → { success, token, expiresIn, expiresAt, refreshIn }
 *   GET  /csrf/status  → { success, isValid, expiresAt }
 *
 * Token is stored in memory only — never localStorage or cookies.
 * Backend manages the HTTP-only secret cookie automatically (csrf-csrf).
 */

import { API_BASE_URL } from "../../config/apiBase";

class CsrfMiddleware {
    constructor() {
        this._token = null;
        this._tokenExpiry = null;
        this._tokenExpiresAt = null;
        this._lastFetchTime = null;
        this._isInitialized = false;

        // Promise guards — prevent concurrent init/refresh
        this._initPromise = null;
        this._refreshPromise = null;
        this._fetchPromise = null;
        this._refreshTimer = null;

        // Retry config
        this._maxRetries = 3;
        this._retryDelay = 1000;
        this._retryCount = 0;

        // Refresh buffer — refresh 10s before expiry
        this._refreshBeforeExpiry = 10 * 1000;

        // Token TTL — 5 minutes, matching the backend CSRF token lifetime
        this._tokenMaxAge = 300000;

        // Per-request timeout for the three CSRF endpoints. `fetch()` has NO
        // default timeout: a backend that accepts the TCP connection but never
        // responds (stalled thread pool, half-open connection after a network
        // blip) leaves the promise pending forever — it neither resolves nor
        // rejects, so the retry/backoff loop below never fires either. That
        // strands main.jsx's CsrfGate on <LoadingScreen /> permanently, because
        // it only leaves that state on `isInitialized` or `error`, and a
        // pending promise produces neither. Mirrors HttpClient's 30s Axios
        // timeout, but shorter — this runs on the boot path where the user is
        // staring at a spinner with nothing else on screen.
        this._requestTimeout = 10000;

        // Event listeners
        this._listeners = new Set();
    }

    /**
     * `fetch` with a hard timeout. Aborts the request once `_requestTimeout`
     * elapses so the caller gets a rejection it can retry or surface, instead
     * of a promise that never settles.
     *
     * @param {string} url
     * @param {RequestInit} [options]
     * @returns {Promise<Response>}
     * @throws {Error} `CSRF request timed out after Nms` on abort.
     */
    async _fetchWithTimeout(url, options = {}) {
        // `AbortSignal.timeout` in preference to AbortController + setTimeout:
        // it self-cleans (no timer to clear, so a fast response cannot leak a
        // pending handle) and, unlike setTimeout, it is NOT replaced by
        // Vitest's fake timers — a suite that calls
        // `vi.useFakeTimers({ shouldAdvanceTime: true })` and then advances the
        // clock past the timeout would otherwise abort a request the test never
        // intended to abort. Falls back to a manual controller on any engine
        // without the static (pre-Chrome 103 / Safari 16).
        const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(this._requestTimeout) : undefined;

        let controller = null;
        let timer = null;
        if (!signal) {
            controller = new AbortController();
            timer = setTimeout(() => controller.abort(), this._requestTimeout);
        }

        try {
            return await fetch(url, { ...options, signal: signal ?? controller.signal });
        } catch (err) {
            // AbortSignal.timeout rejects with TimeoutError; controller.abort() with AbortError.
            if (err?.name === "TimeoutError" || err?.name === "AbortError") {
                throw new Error(`CSRF request timed out after ${this._requestTimeout}ms: ${url}`);
            }
            throw err;
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    // ─── Public API ───────────────────────────────────────────────────────────

    /**
     * Initialize CSRF token — called once on app startup by CsrfContext.
     * Idempotent: multiple calls return the same promise.
     */
    async initialize() {
        if (this._isInitialized && this._token) return this._token;
        if (this._initPromise) return this._initPromise;

        this._initPromise = this._initInternal();
        try {
            return await this._initPromise;
        } finally {
            this._initPromise = null;
        }
    }

    /**
     * Get current token from memory. Returns null if expired or not set.
     */
    getToken() {
        if (!this._token) return null;
        if (this._tokenExpiry && Date.now() > this._tokenExpiry) {
            this._token = null;
            return null;
        }
        return this._token;
    }

    /**
     * Ensure a valid token is available. Used by HttpClient before every
     * state-changing request. Initializes or refreshes as needed.
     */
    async ensureTokenReady() {
        // Handle page refresh scenario
        if (!this._isInitialized) {
            const token = await this._fetchToken();
            if (token) {
                this._token = token;
                this._isInitialized = true;
                this._notifyListeners();
                return token;
            }
        }

        const current = this.getToken();
        if (current) return current;

        return this.initialize();
    }

    /**
     * Force a token refresh via the dedicated /csrf/refresh endpoint.
     * Use after login or when the server rejects a token.
     */
    async forceRefresh() {
        if (this._refreshTimer) {
            clearTimeout(this._refreshTimer);
            this._refreshTimer = null;
        }
        try {
            return await this._refreshToken();
        } catch {
            // Refresh POST failed (token already invalid) — fall back to GET
            return this._fetchToken();
        }
    }

    /**
     * Query the backend /csrf/status endpoint.
     * Returns { success, isValid, expiresAt } or throws.
     */
    async getStatus() {
        const response = await this._fetchWithTimeout(`${API_BASE_URL}csrf/status`, {
            method: "GET",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        return response.json();
    }

    /**
     * Clear token from memory (e.g., on logout).
     * Does NOT clear the backend's HTTP-only secret cookie.
     */
    clearToken() {
        if (this._refreshTimer) {
            clearTimeout(this._refreshTimer);
            this._refreshTimer = null;
        }
        this._token = null;
        this._tokenExpiry = null;
        this._tokenExpiresAt = null;
        this._lastFetchTime = null;
        this._isInitialized = false;
        this._initPromise = null;
        this._refreshPromise = null;
        this._notifyListeners();
    }

    /**
     * Register a listener for token changes.
     * Returns an unsubscribe function.
     */
    addListener(callback) {
        this._listeners.add(callback);
        return () => this._listeners.delete(callback);
    }

    /**
     * Debug snapshot — useful for CsrfContext and debug UIs.
     */
    getDebugInfo() {
        const timeUntilExpiry = this._tokenExpiresAt ? new Date(this._tokenExpiresAt).getTime() - Date.now() : null;
        return {
            hasToken: !!this._token,
            tokenPreview: this._token ? `${this._token.substring(0, 8)}...` : null,
            isInitialized: this._isInitialized,
            tokenExpiresAt: this._tokenExpiresAt,
            timeUntilExpirySeconds: timeUntilExpiry ? Math.floor(timeUntilExpiry / 1000) : null,
            hasRefreshTimer: !!this._refreshTimer,
            retryCount: this._retryCount,
        };
    }

    get isInitialized() {
        return this._isInitialized;
    }

    // ─── Private methods ──────────────────────────────────────────────────────

    async _initInternal() {
        try {
            const token = await this._fetchToken();
            this._token = token;
            this._isInitialized = true;
            this._notifyListeners();
            return token;
        } catch (err) {
            this._isInitialized = false;
            throw err;
        }
    }

    async _fetchToken() {
        if (this._fetchPromise) return this._fetchPromise;

        this._fetchPromise = this._fetchWithRetry();
        try {
            return await this._fetchPromise;
        } finally {
            this._fetchPromise = null;
        }
    }

    async _fetchWithRetry() {
        for (let attempt = 0; attempt <= this._maxRetries; attempt++) {
            try {
                const response = await this._fetchWithTimeout(`${API_BASE_URL}csrf/token`, {
                    method: "GET",
                    credentials: "include",
                    headers: { "Content-Type": "application/json" },
                });

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }

                const data = await response.json();
                if (!data.success || !data.token) {
                    throw new Error(data.message || "No token in response");
                }

                this._token = data.token;
                this._lastFetchTime = Date.now();
                this._retryCount = 0;

                if (data.expiresIn) this._tokenExpiry = Date.now() + data.expiresIn;
                if (data.expiresAt) this._tokenExpiresAt = data.expiresAt;

                if (data.refreshIn && data.refreshIn > 0) {
                    this._scheduleRefresh(data.refreshIn);
                } else if (data.expiresIn) {
                    this._scheduleRefresh(Math.max(0, data.expiresIn - this._refreshBeforeExpiry));
                }

                return data.token;
            } catch (err) {
                this._retryCount = attempt + 1;
                if (attempt === this._maxRetries) {
                    throw new Error(`CSRF fetch failed after ${this._maxRetries + 1} attempts: ${err.message}`);
                }
                await this._sleep(this._retryDelay * Math.pow(2, attempt));
            }
        }
    }

    _getTraceabilityHeader() {
        try {
            const raw = localStorage.getItem("user_display");
            if (!raw) return "anonymous@unknown";
            const u = JSON.parse(raw);
            const name = [u?.firstName, u?.lastName].filter(Boolean).join(" ") || u?.userId;
            return name ? `${name}@${u.userId}` : "anonymous@unknown";
        } catch {
            return "anonymous@unknown";
        }
    }

    async _refreshToken() {
        if (this._refreshPromise) return this._refreshPromise;

        this._refreshPromise = (async () => {
            const headers = { "Content-Type": "application/json" };
            if (this._token) headers["x-csrf-token"] = this._token;
            headers["X-Client-Username"] = this._getTraceabilityHeader();

            const response = await this._fetchWithTimeout(`${API_BASE_URL}csrf/refresh`, {
                method: "POST",
                credentials: "include",
                headers,
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();
            if (!data.success || !data.token) {
                throw new Error(data.message || "Refresh returned no token");
            }

            this._token = data.token;
            this._lastFetchTime = Date.now();

            if (data.expiresIn) this._tokenExpiry = Date.now() + data.expiresIn;
            if (data.expiresAt) this._tokenExpiresAt = data.expiresAt;

            if (data.refreshIn && data.refreshIn > 0) {
                this._scheduleRefresh(data.refreshIn);
            } else if (data.expiresIn) {
                this._scheduleRefresh(Math.max(0, data.expiresIn - this._refreshBeforeExpiry));
            }

            this._notifyListeners();
            return this._token;
        })();

        try {
            return await this._refreshPromise;
        } finally {
            this._refreshPromise = null;
        }
    }

    _scheduleRefresh(delayMs) {
        if (this._refreshTimer) {
            clearTimeout(this._refreshTimer);
            this._refreshTimer = null;
        }
        const safeDelay = Math.max(0, delayMs);
        this._refreshTimer = setTimeout(async () => {
            try {
                await this._refreshToken();
            } catch {
                // Retry in 30s if auto-refresh fails
                setTimeout(() => this._refreshToken().catch(() => {}), 30000);
            }
        }, safeDelay);
    }

    _notifyListeners() {
        this._listeners.forEach((cb) => {
            try {
                cb(this._token);
            } catch {
                /* ignore listener errors */
            }
        });
    }

    _sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

// Singleton export
const csrfMiddleware = new CsrfMiddleware();
export default csrfMiddleware;
export { CsrfMiddleware };
