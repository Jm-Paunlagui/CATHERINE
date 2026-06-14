import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { applyPaletteVars, clearPaletteVars, findPalette, generateCustomColors } from "../../features/personalize/personalize.palettes";

const ThemeContext = createContext(null);

const PERSONALIZE_KEY = "aumovio-personalize";
const LEGACY_KEY = "aumovio-theme";

function getSystemTheme() {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function loadPrefs() {
    try {
        const raw = localStorage.getItem(PERSONALIZE_KEY);
        if (raw) {
            const p = JSON.parse(raw);
            return {
                mode: ["light", "dark", "system"].includes(p.mode) ? p.mode : "system",
                transparency: p.transparency !== false,
                palette: typeof p.palette === "string" ? p.palette : "aumovio-orange",
                customColor: typeof p.customColor === "string" ? p.customColor : null,
            };
        }
    } catch {}
    const legacy = localStorage.getItem(LEGACY_KEY);
    return {
        mode: ["light", "dark", "system"].includes(legacy) ? legacy : import.meta.env.VITE_THEME || "system",
        transparency: true,
        palette: "aumovio-orange",
        customColor: null,
    };
}

export function ThemeProvider({ children }) {
    const init = useMemo(loadPrefs, []);

    const [mode, setMode] = useState(init.mode);
    const [transparency, setTransparency] = useState(init.transparency);
    const [palette, setPaletteState] = useState(init.palette);
    const [customColor, setCustomColorState] = useState(init.customColor);

    const [resolved, setResolved] = useState(() => (mode === "system" ? getSystemTheme() : mode));

    // OS dark-mode listener
    useEffect(() => {
        if (mode !== "system") {
            setResolved(mode);
            return;
        }
        setResolved(getSystemTheme());
        const mql = window.matchMedia("(prefers-color-scheme: dark)");
        const handler = (e) => setResolved(e.matches ? "dark" : "light");
        mql.addEventListener("change", handler);
        return () => mql.removeEventListener("change", handler);
    }, [mode]);

    // Apply theme to DOM + persist all prefs
    useEffect(() => {
        document.documentElement.setAttribute("data-theme", resolved);
        try {
            localStorage.setItem(PERSONALIZE_KEY, JSON.stringify({ mode, transparency, palette, customColor }));
            localStorage.setItem(LEGACY_KEY, mode);
        } catch {}
    }, [mode, resolved, transparency, palette, customColor]);

    // Transparency — set data-transparency attribute on <html>.
    // CSS in index.css targets html[data-transparency="off"] to disable all
    // backdrop-filter effects. useLayoutEffect runs before paint so there is
    // no flash when the stored preference is "off" on initial load.
    useLayoutEffect(() => {
        document.documentElement.setAttribute("data-transparency", transparency ? "on" : "off");
    }, [transparency]);

    // Palette CSS variable overrides.
    // `resolved` is a dep so dark-mode toggles immediately re-inject the correct
    // --surface / --text / --text-muted values for named palettes.
    useEffect(() => {
        if (palette === "aumovio-orange") {
            clearPaletteVars();
            return;
        }
        if (palette === "custom") {
            if (customColor) applyPaletteVars(generateCustomColors(customColor), resolved === "dark", "custom");
            return;
        }
        const entry = findPalette(palette);
        if (entry?.colors) applyPaletteVars(entry.colors, resolved === "dark", entry.id);
    }, [palette, customColor, resolved]);

    const toggle = useCallback(() => setMode((m) => (m === "system" ? "light" : m === "light" ? "dark" : "system")), []);
    const setPalette = useCallback((id) => setPaletteState(id), []);
    const setCustomColor = useCallback((hex) => setCustomColorState(hex), []);

    const value = useMemo(
        () => ({
            mode,
            theme: resolved,
            isDark: resolved === "dark",
            setMode,
            toggle,
            transparency,
            setTransparency,
            palette,
            setPalette,
            customColor,
            setCustomColor,
        }),
        [mode, resolved, toggle, transparency, palette, customColor, setPalette, setCustomColor],
    );

    return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * @returns {{ mode, theme, isDark, setMode, toggle,
 *             transparency, setTransparency,
 *             palette, setPalette, customColor, setCustomColor }}
 */
export function useTheme() {
    const ctx = useContext(ThemeContext);
    if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
    return ctx;
}
