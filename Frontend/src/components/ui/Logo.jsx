/**
 * Logo — Theme-aware Aumovio logo component.
 *
 * Props:
 *   variant   — 'auto'|'light'|'dark'|'white'
 *                auto = follows current theme
 *                light = orange mark + black text  (for light backgrounds)
 *                dark  = orange mark + white text  (for dark backgrounds)
 *                white = all-white                 (for coloured / gradient backgrounds)
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
    const src = variant === "auto" ? (isDark ? logoDark : logoLight) : (VARIANTS[variant] ?? logoLight);

    return <img src={src} alt={alt} className={className} />;
}
