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
import LoadingScreen from "./components/layout/LoadingScreen";
import { LayoutProvider } from "./contexts/layout/LayoutContext";
import { CsrfProvider, useCsrf } from "./contexts/security/CsrfContext";
import { ThemeProvider } from "./contexts/theme/ThemeContext";
import { VersionProvider } from "./contexts/version/VersionContext";

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
                                <App />
                            </VersionProvider>
                        </LayoutProvider>
                    </CsrfGate>
                </CsrfProvider>
            </ThemeProvider>
        </BrowserRouter>
    </StrictMode>,
);
