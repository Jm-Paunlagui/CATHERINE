/**
 * useTheme.js — Theme context object + consumer hook.
 *
 * Split out of ThemeContext.jsx: react-refresh/only-export-components
 * requires a file to export EITHER components OR non-components, never both.
 * ThemeContext.jsx exports the `ThemeProvider` component, so the context
 * object and the `useTheme` hook (both non-components) live here instead —
 * mirrors the pre-set-styles.jsx / pre-set-styles.components.jsx split.
 * `.js` (no JSX) is deliberate, same reasoning as that precedent.
 */
import { createContext, useContext } from "react";

export const ThemeContext = createContext(null);

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

export default useTheme;
