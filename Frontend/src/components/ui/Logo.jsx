/**
 * Logo — Theme-aware Aumovio logo component.
 *
 * Props:
 *   variant   — 'auto'|'light'|'dark'|'white'|'chrome'
 *                auto   = follows current theme
 *                light  = orange mark + black text  (for light backgrounds)
 *                dark   = orange mark + white text  (for dark backgrounds)
 *                white  = all-white                 (for coloured / gradient backgrounds)
 *                chrome = zone-adaptive — renders BOTH marks and lets CSS (driven by
 *                         the `data-chrome-from` attribute computed by applyPaletteVars())
 *                         show the correct one for the sidebar-header chrome gradient's
 *                         left zone. Never hardcodes white — pale palettes make a raw
 *                         white mark invisible. Use for the desktop SidebarHeader logo.
 *   className — sizing & layout classes (default: "h-8 w-auto")
 *   alt       — alt text
 */
import { useTheme } from "../../contexts/theme/ThemeContext";

import logoLight from "../../assets/aumovio/AUMOVIO_Logo_orange_black_RGB.png";
import logoDark from "../../assets/aumovio/AUMOVIO_Logo_orange_white_RGB.png";
import logoWhite from "../../assets/aumovio/Aumovio_Logo_white_white_RGB.png";

const VARIANTS = { light: logoLight, dark: logoDark, white: logoWhite };

export default function Logo({ variant = "auto", className = "h-8 w-auto", alt = "Aumovio" }) {
    const { isDark } = useTheme();

    if (variant === "chrome") {
        return (
            <>
                <img src={logoWhite} alt={alt} className={`logo-on-chrome-dark ${className}`} />
                <img src={logoLight} alt={alt} className={`logo-on-chrome-light ${className}`} />
            </>
        );
    }

    const src = variant === "auto" ? (isDark ? logoDark : logoLight) : (VARIANTS[variant] ?? logoLight);

    return <img src={src} alt={alt} className={className} />;
}
