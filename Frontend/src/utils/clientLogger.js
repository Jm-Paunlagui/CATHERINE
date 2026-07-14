/**
 * clientLogger.js
 * ───────────────
 * Forwards uncaught frontend errors (currently from ErrorBoundary) to the
 * backend `POST /client/errors` endpoint so they land in the central log
 * pipeline alongside server-side events.
 *
 * Why this exists:
 *   Production frontends must never reach the user with `console.error` traces
 *   (CWE-209). Render errors caught by an ErrorBoundary still need an audit
 *   trail, so we ship the diagnostics server-side and only surface the generic
 *   fallback UI to the user.
 *
 * Failure mode:
 *   The HTTP call uses `.catch(() => {})` to swallow network/CSRF/auth errors.
 *   `clientLogger.error()` must NEVER throw — a logger that itself crashes
 *   inside `componentDidCatch` would mask the original render error.
 *
 * Development mode:
 *   In `import.meta.env.DEV`, the error is also echoed to `console.error` so
 *   developers see the stack inline. Production builds skip this entirely.
 */

import httpClient from "../middleware/HttpClient";

const clientLogger = {
    /**
     * Reports a client-side error to the backend and returns the server-assigned
     * Request ID so the caller (ErrorBoundary) can display it for support tracing.
     *
     * @param {Error|string} message - Error instance (preferred) or string message.
     * @param {{ componentStack?: string }} [info] - React ErrorInfo (componentStack).
     * @returns {Promise<string|null>} The server-assigned Request ID, or null on failure.
     */
    async error(message, info) {
        const payload = {
            message: message instanceof Error ? message.message : String(message),
            stack: message instanceof Error ? message.stack : undefined,
            componentStack: info?.componentStack ?? undefined,
            url: window.location.href,
            userAgent: navigator.userAgent,
            timestamp: new Date().toISOString(),
        };

        let requestId = null;
        try {
            const res = await httpClient.post("client/errors", payload);
            requestId = res.data?.requestId ?? null;
        } catch {
            // Silently swallow — clientLogger must never throw
        }

        if (import.meta.env.DEV) {
            // eslint-disable-next-line no-console -- dev-only echo for developer ergonomics
            console.error("[ClientLogger]", message, info);
        }

        return requestId;
    },
};

export default clientLogger;
