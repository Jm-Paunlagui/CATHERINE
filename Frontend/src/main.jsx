/**
 * main.jsx — Entry point.
 *
 * Provider chain (outermost → innermost):
 *   BrowserRouter → CsrfProvider → LayoutProvider → VersionProvider → App
 *
 * Rules:
 * - All providers live here, never in App.jsx
 * - App.jsx contains only Routes
 */

import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { ErrorBoundary } from "./components/feedback/ErrorBoundary";
import LoadingScreen from "./components/layout/LoadingScreen";
import { LayoutProvider } from "./contexts/layout/LayoutContext";
import { CsrfProvider, useCsrf } from "./contexts/security/CsrfContext";
import { ThemeProvider } from "./contexts/theme/ThemeContext";
import { VersionProvider } from "./contexts/version/VersionContext";
import { API_BASE_URL } from "./config/apiBase";
import { ERROR_PAGE_ROUTES } from "./constants/httpStatus";
import { frontendMetrics } from "./utils/frontendMetrics";
import { initWebVitals } from "./utils/webVitals";

// ─── Frontend observability bootstrap ───────────────────────────────────────────
// Start telemetry as early as possible — before auth/CSRF, even on the login page.
// Web Vitals + uncaught errors flow to POST /api/v1/metrics/frontend (no auth) and
// surface in the Observability dashboard's Frontend Vitals panel. frontendMetrics
// uses keepalive fetch, so events survive page unloads.
frontendMetrics.init(API_BASE_URL);
initWebVitals(({ name, value, rating }) => frontendMetrics.recordVital(name, value, rating));
window.addEventListener("error", (e) => frontendMetrics.recordError(e.error || e.message, { page: window.location.pathname, source: "window.error" }));
window.addEventListener("unhandledrejection", (e) => frontendMetrics.recordError(e.reason || "Unhandled promise rejection", { page: window.location.pathname, source: "unhandledrejection" }));

// ─── Stale-chunk recovery (deployment-only failure mode) ───────────────
// Every route in App.jsx is `lazy(() => import(...))`, and Vite emits one
// content-hashed chunk per view. A redeploy replaces every hash, so a client
// that still has the OLD index.html open (a tab left open overnight, a Windows
// kiosk that never reloads) requests a chunk filename that no longer exists on
// IIS. Web.config's SPA rewrite deliberately excludes /assets/, so that request
// honestly 404s — React's `lazy()` then re-throws the rejected import() as a
// render error. Without this handler that is an unrecoverable blank page: the
// only ErrorBoundary that could have caught it lives INSIDE the chunk that
// failed to load.
//
// Vite fires `vite:preloadError` for exactly this case. Reload once to pick up
// the new index.html and its new hashes. The timestamp guard makes it
// self-limiting — if a reload does not fix it (the asset is genuinely gone, or
// IIS is serving a broken deploy) the second failure within the window falls
// through to the root ErrorBoundary instead of looping forever.
const CHUNK_RELOAD_KEY = "app:chunk-reload-at";
const CHUNK_RELOAD_COOLDOWN_MS = 60_000;
window.addEventListener("vite:preloadError", (event) => {
    frontendMetrics.recordError(event.payload || "Chunk preload failed", { page: window.location.pathname, source: "vite:preloadError" });
    const lastReload = Number(sessionStorage.getItem(CHUNK_RELOAD_KEY) || 0);
    if (Date.now() - lastReload < CHUNK_RELOAD_COOLDOWN_MS) return; // already retried — let the boundary render
    sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()));
    event.preventDefault(); // suppress the throw; we are handling it by reloading
    window.location.reload();
});

// Minimum time (ms) the LoadingScreen stays visible, regardless of how fast
// the CSRF token resolves. Keeps the screen from flickering on fast backends.
const MIN_LOADING_MS = 0;

// ─── CsrfGate ────────────────────────────────────────────────────────────────
// Disabled rather than split into a sibling file: main.jsx's own header comment
// states the deliberate rule "All providers live here, never in App.jsx".
// CsrfGate exists solely to gate rendering on this file's own CsrfProvider until
// CSRF init resolves, is used exactly once below, and is never imported. main.jsx
// itself has zero exports (it is the entrypoint script), which is what actually
// trips this rule — splitting the gate out would not change that.
// eslint-disable-next-line react-refresh/only-export-components
function CsrfGate({ children }) {
    const { error, isInitialized } = useCsrf();
    const [minElapsed, setMinElapsed] = useState(false);

    useEffect(() => {
        const timer = setTimeout(() => setMinElapsed(true), MIN_LOADING_MS);
        return () => clearTimeout(timer);
    }, []);

    // Routes read from the shared status map (src/constants/httpStatus.js) so
    // the boot-time gate and HttpClient's response interceptor can never send
    // the same failure to two different screens.
    const OUTAGE_ROUTE = ERROR_PAGE_ROUTES[523];
    const THROTTLED_ROUTE = ERROR_PAGE_ROUTES[429];

    if (window.location.pathname.startsWith(OUTAGE_ROUTE)) return children;
    if (window.location.pathname.startsWith(THROTTLED_ROUTE)) return children;
    if (error && !isInitialized) {
        // Branch on STATUS, never treat every CSRF-init failure as an outage.
        // A 429 is a healthy server refusing a burst — routing it to the 523
        // "server is napping" screen was both wrong and harmful: that screen
        // invites a retry, and the backend limiter counts every request in its
        // window, so each retry extended the block the user was trying to
        // escape. The 429 view counts down instead and never auto-retries.
        if (error?.response?.status === 429) {
            window.location.replace(THROTTLED_ROUTE);
            return null;
        }
        // Everything else at boot IS an outage by construction: CSRF init is
        // the first call the app makes, so a failure means the origin never
        // answered. This is the one place a bare 5xx needs no type check.
        window.location.replace(OUTAGE_ROUTE);
        return null;
    }
    if (!isInitialized || !minElapsed) return <LoadingScreen />;

    return children;
}

createRoot(document.getElementById("root")).render(
    <StrictMode>
        <BrowserRouter>
            <ThemeProvider>
                <CsrfProvider>
                    <CsrfGate>
                        <LayoutProvider>
                            <VersionProvider>
                                <ErrorBoundary>
                                    <App />
                                </ErrorBoundary>
                            </VersionProvider>
                        </LayoutProvider>
                    </CsrfGate>
                </CsrfProvider>
            </ThemeProvider>
        </BrowserRouter>
    </StrictMode>,
);
