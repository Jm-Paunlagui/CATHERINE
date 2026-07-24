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

// Minimum time (ms) the LoadingScreen stays visible, regardless of how fast
// the CSRF token resolves. Keeps the screen from flickering on fast backends.
const MIN_LOADING_MS = 0;

// ─── CsrfGate ────────────────────────────────────────────────────────────────
function CsrfGate({ children }) {
    const { error, isInitialized } = useCsrf();
    const [minElapsed, setMinElapsed] = useState(false);

    useEffect(() => {
        const timer = setTimeout(() => setMinElapsed(true), MIN_LOADING_MS);
        return () => clearTimeout(timer);
    }, []);

    if (window.location.pathname.startsWith("/service-is-currently-unavailable")) return children;
    if (error && !isInitialized) {
        window.location.replace("/service-is-currently-unavailable");
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
