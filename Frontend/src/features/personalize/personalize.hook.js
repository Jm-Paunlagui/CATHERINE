import { useLayout } from "../../contexts/layout/LayoutContext";
import { useTheme } from "../../contexts/theme/ThemeContext";

/**
 * usePersonalize — hook for the Personalize modal.
 *
 * Composes useTheme + useLayout, surfacing exactly the state and setters
 * the modal needs.
 *
 * @returns {{ mode, setMode, isDark, transparency, setTransparency,
 *             palette, setPalette, customColor, setCustomColor,
 *             layout, setLayout }}
 */
export function usePersonalize() {
    const { mode, setMode, isDark, transparency, setTransparency, palette, setPalette, customColor, setCustomColor } =
        useTheme();
    const { layout, setLayout } = useLayout();

    return { mode, setMode, isDark, transparency, setTransparency, palette, setPalette, customColor, setCustomColor, layout, setLayout };
}
