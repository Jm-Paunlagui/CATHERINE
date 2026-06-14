/**
 * LayoutContext — Controls the application shell layout.
 *
 * Two modes:
 *   "top"     → Traditional sticky top navbar
 *   "sidebar" → Collapsible left sidebar + slim top bar
 *
 * User preference is persisted to localStorage under LAYOUT_KEY.
 * Falls back to VITE_LAYOUT_MODE env var, then "sidebar".
 */

import { createContext, useCallback, useContext, useEffect, useState } from "react";

/* eslint-disable react-refresh/only-export-components */

const LayoutContext = createContext(null);

const LAYOUT_KEY = "aumovio-layout";
const ENV_DEFAULT = import.meta.env.VITE_LAYOUT_MODE === "top" ? "top" : "sidebar";

function loadLayout() {
    try {
        const stored = localStorage.getItem(LAYOUT_KEY);
        if (stored === "top" || stored === "sidebar") return stored;
    } catch {}
    return ENV_DEFAULT;
}

export function LayoutProvider({ children }) {
    const [layout, setLayoutState] = useState(loadLayout);
    const [sidebarOpen, setSidebarOpen] = useState(true);

    useEffect(() => {
        try { localStorage.setItem(LAYOUT_KEY, layout); } catch {}
    }, [layout]);

    const setLayout = useCallback((mode) => {
        if (mode === "top" || mode === "sidebar") setLayoutState(mode);
    }, []);

    const toggleSidebar = useCallback(() => setSidebarOpen((o) => !o), []);
    const toggleLayout = useCallback(() => setLayoutState((l) => (l === "top" ? "sidebar" : "top")), []);

    return (
        <LayoutContext.Provider
            value={{
                layout,
                setLayout,
                sidebarOpen,
                setSidebarOpen,
                toggleSidebar,
                toggleLayout,
            }}
        >
            {children}
        </LayoutContext.Provider>
    );
}

export function useLayout() {
    const ctx = useContext(LayoutContext);
    if (!ctx) throw new Error("useLayout must be used within LayoutProvider");
    return ctx;
}
