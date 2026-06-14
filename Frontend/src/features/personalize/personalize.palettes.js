/**
 * personalize.palettes.js — Accent colour palette registry.
 *
 * Each palette defines FIVE anchor colours (one per design-system colour
 * family).  applyPaletteVars() generates full 11-shade scales from each anchor
 * and injects them as CSS custom property overrides on :root so every downstream
 * Tailwind utility (bg-orange-400, text-purple-400, …) picks up the new colour
 * without touching a single component.
 *
 * generateCustomColors(hex) derives 5 complementary colours from a single
 * user-picked hex using HSL rotation — deterministic so the same hex always
 * produces the same palette.
 */

// ── Colour math helpers ────────────────────────────────────────────────────────

/** @param {string} hex — "#rrggbb" */
function hexToRgb(hex) {
    const c = hex.replace("#", "");
    return {
        r: parseInt(c.slice(0, 2), 16),
        g: parseInt(c.slice(2, 4), 16),
        b: parseInt(c.slice(4, 6), 16),
    };
}

/** @returns {string} "#rrggbb" */
function rgbToHex(r, g, b) {
    return (
        "#" +
        [r, g, b]
            .map((v) =>
                Math.max(0, Math.min(255, Math.round(v)))
                    .toString(16)
                    .padStart(2, "0"),
            )
            .join("")
    );
}

/** Linear-interpolate between two hex colours.  t=0 → base, t=1 → target. */
function mix(baseHex, targetHex, t) {
    const a = hexToRgb(baseHex);
    const b = hexToRgb(targetHex);
    return rgbToHex(a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t);
}

function hexToHsl(hex) {
    let { r, g, b } = hexToRgb(hex);
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b),
        min = Math.min(r, g, b);
    let h = 0,
        s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r:
                h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
                break;
            case g:
                h = ((b - r) / d + 2) / 6;
                break;
            case b:
                h = ((r - g) / d + 4) / 6;
                break;
        }
    }
    return { h: h * 360, s: s * 100, l: l * 100 };
}

function hslToHex(h, s, l) {
    s /= 100;
    l /= 100;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => {
        const k = (n + h / 30) % 12;
        const c = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
        return Math.round(255 * c)
            .toString(16)
            .padStart(2, "0");
    };
    return `#${f(0)}${f(8)}${f(4)}`;
}

/** Relative luminance of a hex colour per WCAG 2.1 */
function relativeLuminance(hex) {
    const { r, g, b } = hexToRgb(hex);
    const toLinear = (c) => {
        c /= 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/**
 * Return dark or white text depending on the average luminance of the gradient.
 * Used to auto-contrast gradient button labels against light-primary palettes.
 */
function getButtonTextColor(gradientFrom, gradientTo) {
    const avg = (relativeLuminance(gradientFrom) + relativeLuminance(gradientTo)) / 2;
    return avg > 0.5 ? "#1a1a1a" : "#ffffff";
}

/**
 * Generate a Tailwind-50-equivalent tint from any hex colour.
 * Uses HSL so the result has a genuine hue from the source colour,
 * not just a linear mix toward white.
 *
 * Red/pink hues (330°–30°) trigger "warning/error" associations on backgrounds
 * and receive extra desaturation. maxSaturation caps the chroma for palettes
 * that need a stricter ceiling.
 *
 * @param {string} hex
 * @param {number} [maxSaturation=8]
 * @returns {string}
 */
function generateTint50(hex, maxSaturation = 8) {
    const { h, s } = hexToHsl(hex);
    const tintSaturation = Math.min(s * 0.35, maxSaturation);
    const isRedZone = h >= 330 || h <= 30;
    const finalSaturation = isRedZone ? Math.min(tintSaturation, 5) : tintSaturation;
    return hslToHex(h, finalSaturation, 97);
}

/**
 * Lighter variant of tint-50 (98.5 % lightness) for alternating rows / subtle zones.
 * Applies the same red-zone desaturation as generateTint50 for consistency.
 * @param {string} hex
 * @returns {string}
 */
function generateTint30(hex) {
    const { h, s } = hexToHsl(hex);
    const tintSaturation = Math.min(s * 0.25, 6);
    const isRedZone = h >= 330 || h <= 30;
    const finalSaturation = isRedZone ? Math.min(tintSaturation, 4) : tintSaturation;
    return hslToHex(h, finalSaturation, 98.5);
}

// ── Accent colour helpers ─────────────────────────────────────────────────────

/**
 * Lighten a hex colour until its relative luminance reaches targetLuminance.
 * Used to derive --accent-on-dark values safe for display on dark surfaces.
 *
 * @param {string} hex
 * @param {number} [targetLuminance=0.3]
 * @returns {string}
 */
function lightenToLuminance(hex, targetLuminance = 0.3) {
    const { h, s, l } = hexToHsl(hex);
    for (let lv = Math.max(l, 50); lv <= 95; lv += 3) {
        if (relativeLuminance(hslToHex(h, s, lv)) >= targetLuminance) {
            return hslToHex(h, s, lv);
        }
    }
    return hslToHex(h, s, 90);
}

// ── WCAG contrast + lightness helpers ─────────────────────────────────────────

/** WCAG contrast ratio between two hex colours (returns 1–21). */
function getContrastRatio(hex1, hex2) {
    const l1 = relativeLuminance(hex1);
    const l2 = relativeLuminance(hex2);
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
}

/** Reduce lightness by `percent` relative to current lightness. */
function darken(hex, percent) {
    const { h, s, l } = hexToHsl(hex);
    return hslToHex(h, s, Math.max(0, l * (1 - percent / 100)));
}

/** Increase lightness by `percent` relative to gap to 100. */
function lighten(hex, percent) {
    const { h, s, l } = hexToHsl(hex);
    return hslToHex(h, s, Math.min(100, l + (100 - l) * (percent / 100)));
}

/** Iteratively darkens hex until contrast ratio against surfaceHex reaches targetRatio. Clamps at L=5. */
function darkenToContrast(hex, surfaceHex, targetRatio) {
    const { h, s, l } = hexToHsl(hex);
    for (let lv = l; lv >= 5; lv -= 2) {
        if (getContrastRatio(hslToHex(h, s, lv), surfaceHex) >= targetRatio) {
            return hslToHex(h, s, lv);
        }
    }
    return hslToHex(h, s, 5);
}

/** Iteratively lightens hex until contrast ratio against surfaceHex reaches targetRatio. Clamps at L=95. */
function lightenToContrast(hex, surfaceHex, targetRatio) {
    const { h, s, l } = hexToHsl(hex);
    for (let lv = l; lv <= 95; lv += 2) {
        if (getContrastRatio(hslToHex(h, s, lv), surfaceHex) >= targetRatio) {
            return hslToHex(h, s, lv);
        }
    }
    return hslToHex(h, s, 95);
}

/**
 * Compute palette-tinted light-mode text colours from the tint source hex.
 * Text carries a whisper of the palette hue — just enough to feel native,
 * not enough to look coloured.
 */
function computeLightTextColors(tintSourceHex) {
    const { h, s } = hexToHsl(tintSourceHex);
    const textSat = Math.min(s * 0.08, 8);
    return {
        primary: hslToHex(h, textSat, 13),
        secondary: hslToHex(h, textSat * 0.75, 38),
        tertiary: hslToHex(h, textSat * 0.5, 58),
    };
}

/**
 * Compute dark-mode secondary text from darkMuted.
 * darkMuted is designed for borders (low luminance) — must be lightened
 * to ~0.35 relative luminance to be readable as secondary text.
 */
function computeDarkSecondaryText(darkMuted) {
    return lightenToLuminance(darkMuted, 0.35);
}

/**
 * Return the accessible accent text colour on a given surface.
 * Uses palette primary if contrast ≥ 4.5:1, otherwise adjusts.
 */
function computeAccentText(accentHex, surfaceHex, mode) {
    if (getContrastRatio(accentHex, surfaceHex) >= 4.5) return accentHex;
    return mode === "light" ? darkenToContrast(accentHex, surfaceHex, 4.5) : lightenToContrast(accentHex, surfaceHex, 4.5);
}

/**
 * Compute the active navigation state colour for a given surface.
 * In dark mode: boosts the palette primary to ≥0.25 relative luminance
 * and ≥3.5:1 contrast against the chrome surface.
 * In light mode: ensures the primary has ≥4.5:1 contrast.
 *
 * @param {string} primaryHex
 * @param {string} surfaceHex
 * @param {'light'|'dark'} mode
 * @returns {{ text: string, bg: string, border: string, dot: string }}
 */
function computeActiveState(primaryHex, surfaceHex, mode) {
    const { h, s, l } = hexToHsl(primaryHex);

    if (mode === "dark") {
        const activeSat = Math.max(s, 35);
        let activeL = l;
        let activeHex = hslToHex(h, activeSat, activeL);

        while (relativeLuminance(activeHex) < 0.25 && activeL < 85) {
            activeL += 2;
            activeHex = hslToHex(h, activeSat, activeL);
        }
        let contrast = getContrastRatio(activeHex, surfaceHex);
        while (contrast < 3.5 && activeL < 85) {
            activeL += 2;
            activeHex = hslToHex(h, activeSat, activeL);
            contrast = getContrastRatio(activeHex, surfaceHex);
        }
        return {
            text: activeHex,
            bg: `${activeHex}20`,
            border: activeHex,
            dot: activeHex,
        };
    } else {
        let activeHex = primaryHex;
        if (getContrastRatio(activeHex, surfaceHex) < 4.5) {
            activeHex = darkenToContrast(primaryHex, surfaceHex, 4.5);
        }
        return {
            text: activeHex,
            bg: `${activeHex}14`,
            border: activeHex,
            dot: activeHex,
        };
    }
}

const STATUS_HUES = {
    success: { hue: 145, saturation: 60 },
    warning: { hue: 38, saturation: 75 },
    danger: { hue: 0, saturation: 70 },
    info: { hue: 210, saturation: 60 },
    neutral: { hue: 0, saturation: 0 },
};

/**
 * Compute all 3 intensity levels for a semantic status colour,
 * adaptive to the current mode and surface. Includes hue collision
 * detection to prevent status colours blending into palette identity.
 *
 * @param {number} hue
 * @param {number} saturation
 * @param {string} surfaceHex
 * @param {'light'|'dark'} mode
 * @returns {{ bg: string, base: string, text: string }}
 */
function computeStatusColor(hue, saturation, surfaceHex, mode) {
    const { h: surfH } = hexToHsl(surfaceHex);
    let adjustedHue = hue;
    const hueDiff = Math.abs(hue - surfH);
    const wrappedDiff = Math.min(hueDiff, 360 - hueDiff);
    if (wrappedDiff < 25) {
        adjustedHue = (hue + (hue > surfH ? 15 : -15) + 360) % 360;
    }

    if (mode === "light") {
        return {
            bg: hslToHex(adjustedHue, Math.min(saturation * 0.6, 40), 95),
            base: hslToHex(adjustedHue, saturation, 46),
            text: hslToHex(adjustedHue, saturation * 0.8, 30),
        };
    } else {
        return {
            bg: hslToHex(adjustedHue, Math.min(saturation * 0.35, 25), 16),
            base: hslToHex(adjustedHue, saturation, 60),
            text: hslToHex(adjustedHue, saturation * 0.7, 76),
        };
    }
}

/**
 * Generate the 5-level dark mode elevation ladder from a base darkSurface hex.
 * Each step lightens the hue/saturation slightly, creating perceptible depth.
 * @param {string} darkSurfaceHex
 * @param {number[]} [steps]
 * @returns {string[]} 5 hex values, darkest (content) to lightest (floating)
 */
function generateDarkElevation(darkSurfaceHex, steps = [0, 4, 8, 12, 16]) {
    const { h, s, l } = hexToHsl(darkSurfaceHex);
    return steps.map((step) => {
        const newL = Math.min(l + step, 25);
        const newS = Math.min(s + step / 4, s + 5);
        return hslToHex(h, newS, newL);
    });
}

/**
 * Generate the 5-level light mode elevation ladder from a tint source hex.
 * Content area is lightest (96% L), navbar most tinted (90% L).
 * Level 4 (floating) is pure white for maximum pop.
 * @param {string} tintSourceHex
 * @param {number[]} [lightness]
 * @returns {string[]} 5 hex values
 */
function generateLightElevation(tintSourceHex, lightness = [96, 94, 92, 90, 100]) {
    const { h, s } = hexToHsl(tintSourceHex);
    const baseSat = Math.max(Math.min(s * 0.5, 18), 6);
    const isRedZone = h >= 330 || h <= 30;
    const finalBaseSat = isRedZone ? Math.min(baseSat, 10) : baseSat;
    return lightness.map((l) => {
        if (l === 100) return "#ffffff";
        const satBoost = (96 - l) * 0.4;
        const sat = Math.min(finalBaseSat + satBoost, 22);
        return hslToHex(h, sat, l);
    });
}

/**
 * Compute the border colour used at elevation boundaries.
 * Dark mode: subtle white. Light mode: palette hue at low opacity.
 * @param {boolean} isDark
 * @param {string} tintSourceHex
 * @returns {string} CSS colour value
 */
function computeElevationBorder(isDark, tintSourceHex) {
    if (isDark) return "rgba(255, 255, 255, 0.06)";
    const { h, s } = hexToHsl(tintSourceHex);
    const borderSat = Math.min(s * 0.3, 15);
    return `hsla(${Math.round(h)}, ${borderSat.toFixed(1)}%, 50%, 0.10)`;
}

/**
 * Return dark or white text for text placed ON a coloured background.
 * Threshold 0.36 (human eye perceives light-on-dark as slightly more readable).
 */
function getTextOnGradient(fromHex, toHex) {
    const avgLum = (relativeLuminance(fromHex) + relativeLuminance(toHex)) / 2;
    return avgLum > 0.36 ? "#1a1a1a" : "#ffffff";
}

// ── Tint source overrides ─────────────────────────────────────────────────────

/**
 * Maps palette ids to the color key that should supply the light-mode tint
 * source instead of `primary`. These overrides fix palettes whose primary
 * colour produces aggressive, invisible, or emotionally dissonant backgrounds.
 */
const TINT_SOURCE_OVERRIDES = {
    "too-much": "turquoise", // mauve primary → warm understated tint
    "cheap-motel": "turquoise", // hot pink primary → calming teal tint
    bloodlust: "blue", // near-black primary → warm parchment tint
    always: "yellow", // coral/red primary → calm teal-blue tint
    "just-leave": "yellow", // vivid gold primary → neutral warm grey tint
    "set-me-free": "secondary", // near-white primary → cool navy tint
    "past-times": "turquoise", // old-paper gold → fresh green tint
    "rough-sex": "blue", // baby pink primary → warm burgundy tint (mature)
    heartache: "blue", // baby pink primary → dusty rose tint (sophisticated)
    overboard: "yellow", // near-white blush → deep plum → subtle purple tint
    "i-see-you": "blue", // warm sand primary → subtle cool plum tint
};

/**
 * Return the hex colour to use as the tint source for light-mode surfaces.
 * Consults TINT_SOURCE_OVERRIDES first; falls back to primary if no override
 * is defined or the override key is absent from colors.
 *
 * @param {string|null} paletteId
 * @param {{ primary, secondary, blue, turquoise, yellow }} colors
 * @returns {string}
 */
function getTintSource(paletteId, colors) {
    if (paletteId) {
        const key = TINT_SOURCE_OVERRIDES[paletteId];
        if (key && colors[key]) return colors[key];
    }
    return colors.primary;
}

// ── Scale generation ──────────────────────────────────────────────────────────

const WHITE = "#ffffff";
const BLACK = "#000000";

/**
 * Generate an 11-shade scale from a single base colour (the "400" anchor).
 * Deterministic — same baseHex always returns the same object.
 *
 * @param {string} baseHex — e.g. "#ff4208"
 * @returns {{ "50":string, "100":string, …, "950":string }}
 */
export function generateScale(baseHex) {
    const hex = baseHex.toLowerCase();
    return {
        50: mix(hex, WHITE, 0.96),
        100: mix(hex, WHITE, 0.82),
        200: mix(hex, WHITE, 0.64),
        300: mix(hex, WHITE, 0.4),
        400: hex,
        500: mix(hex, BLACK, 0.14),
        600: mix(hex, BLACK, 0.3),
        700: mix(hex, BLACK, 0.46),
        800: mix(hex, BLACK, 0.62),
        900: mix(hex, BLACK, 0.77),
        950: mix(hex, BLACK, 0.87),
    };
}

// ── Custom palette derivation ─────────────────────────────────────────────────

/**
 * Derive a complete, self-contained palette from a single picked hex.
 *
 * Returns the five light-mode anchors (deterministic HSL hue rotation) PLUS the
 * three dark-mode anchors (darkSurface / darkText / darkMuted) so the custom
 * palette generates its own dark theme exactly like the named palettes do —
 * instead of inheriting the dark surfaces of whichever named palette was
 * selected before it. The dark anchors are derived from the primary hue so the
 * dark background carries a whisper of the chosen colour.
 *
 * @param {string} primaryHex
 * @returns {{ primary, secondary, blue, turquoise, yellow, darkSurface, darkText, darkMuted }}
 */
export function generateCustomColors(primaryHex) {
    const { h, s, l } = hexToHsl(primaryHex.toLowerCase());
    const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
    const sat = clamp(s, 35, 90);
    const lit = clamp(l, 30, 62);
    return {
        primary: primaryHex.toLowerCase(),
        secondary: hslToHex((h + 240) % 360, clamp(sat * 1.05, 35, 90), clamp(lit * 0.88, 25, 55)),
        blue: hslToHex((h + 205) % 360, clamp(sat * 0.95, 35, 85), clamp(lit * 0.95, 28, 58)),
        turquoise: hslToHex((h + 170) % 360, clamp(sat * 0.9, 30, 80), clamp(lit * 1.05, 30, 62)),
        yellow: hslToHex((h + 50) % 360, clamp(sat * 0.8, 30, 75), clamp(lit * 1.15, 35, 68)),
        // Dark-mode anchors — mirror the structure of the named palettes:
        //   darkSurface = very dark, lightly hue-tinted background (L ~7)
        //   darkText    = near-white, faintly tinted body text (L ~88)
        //   darkMuted   = mid-tone border / secondary colour (L ~34)
        darkSurface: hslToHex(h, clamp(s * 0.25, 8, 22), 7),
        darkText: hslToHex(h, clamp(s * 0.15, 4, 14), 88),
        darkMuted: hslToHex(h, clamp(s * 0.4, 12, 38), 34),
    };
}

// ── Runtime CSS variable application ─────────────────────────────────────────

const SHADES = ["50", "100", "200", "300", "400", "500", "600", "700", "800", "900", "950"];

/**
 * Override all five colour families on :root.
 * Affects every Tailwind utility that references these CSS variables
 * (bg-orange-400, text-purple-400, border-blue-300, …).
 *
 * For named palettes (those supplying darkSurface/darkText/darkMuted), also
 * injects --surface, --text, and --text-muted keyed to the current colour
 * scheme. Brand and custom palettes lack those keys; the variables are cleared
 * so CSS dark: variants take over unchanged.
 *
 * @param {{ primary, secondary, blue, turquoise, yellow, darkSurface?, darkText?, darkMuted? }} colors
 * @param {boolean} [isDark=false]
 * @param {string|null} [paletteId=null]
 */
export function applyPaletteVars(colors, isDark = false, paletteId = null) {
    const { primary, secondary, blue, turquoise, yellow, darkSurface, darkText, darkMuted } = colors;
    const root = document.documentElement;

    function applyFamily(famNames, anchor) {
        const scale = generateScale(anchor);
        for (const shade of SHADES) {
            for (const fam of famNames) {
                root.style.setProperty(`--color-${fam}-${shade}`, scale[shade]);
            }
        }
        const { r, g, b } = hexToRgb(anchor);
        return { r, g, b };
    }

    const pRgb = applyFamily(["orange", "primary"], primary);
    const sRgb = applyFamily(["purple", "secondary"], secondary);
    const bRgb = applyFamily(["blue"], blue);
    applyFamily(["turquoise"], turquoise);
    applyFamily(["yellow"], yellow);

    root.style.setProperty("--glow-orange", `0 8px 28px rgba(${pRgb.r}, ${pRgb.g}, ${pRgb.b}, 0.3)`);
    root.style.setProperty("--glow-purple", `0 8px 28px rgba(${sRgb.r}, ${sRgb.g}, ${sRgb.b}, 0.28)`);
    root.style.setProperty("--glow-blue", `0 8px 28px rgba(${bRgb.r}, ${bRgb.g}, ${bRgb.b}, 0.28)`);

    // ── Gradient button tokens ────────────────────────────────────────────────
    root.style.setProperty("--color-gradient-from", primary);
    root.style.setProperty("--color-gradient-to", secondary);
    root.style.setProperty("--color-gradient-text", getButtonTextColor(primary, secondary));

    // ── Derived interaction tokens ────────────────────────────────────────────
    // These are computed here so all consumers can reference CSS variables
    // instead of hard-coding rgba(palette.primary, ...) in component classes.
    root.style.setProperty("--accent", primary);
    root.style.setProperty("--accent-subtle", `rgba(${pRgb.r},${pRgb.g},${pRgb.b},0.08)`);
    root.style.setProperty("--accent-muted", `rgba(${pRgb.r},${pRgb.g},${pRgb.b},0.40)`);
    root.style.setProperty("--accent-on-dark", lightenToLuminance(primary));
    root.style.setProperty("--shadow-tint", `rgba(${pRgb.r},${pRgb.g},${pRgb.b},0.04)`);
    root.style.setProperty("--text-on-accent", getTextOnGradient(primary, secondary));
    if (isDark && darkMuted) {
        const { r: mr, g: mg, b: mb } = hexToRgb(darkMuted);
        root.style.setProperty("--border-subtle", `rgba(${mr},${mg},${mb},0.25)`);
    } else {
        root.style.setProperty("--border-subtle", "rgba(0,0,0,0.08)");
    }

    // ── Palette-aware tint source ─────────────────────────────────────────────
    // Named palettes with problematic primaries (screaming pink, near-black,
    // near-white, dingy yellow) use an alternate colour from their palette as
    // the tint source so the light-mode background feels intentional and calm.
    const tintSource = getTintSource(paletteId, colors);
    const tintHex = generateTint50(tintSource);
    const tintHexAlt = generateTint30(tintSource);

    // ── Surface elevation ladder ──────────────────────────────────────────────
    const isBrand = ["aumovio-orange", "aumovio-purple"].includes(paletteId);
    const BRAND_DARK = ["#0d0d14", "#141520", "#1a1d2c", "#222538", "#2a2d44"];
    const BRAND_LIGHT = ["#ffffff", "#fafafa", "#f5f5f5", "#f0f0f0", "#ffffff"];
    let surfaceLevels = null;

    if (isDark) {
        if (darkSurface) {
            surfaceLevels = generateDarkElevation(darkSurface);
            root.style.setProperty("--surface-0", surfaceLevels[0]);
            root.style.setProperty("--surface-1", surfaceLevels[1]);
            root.style.setProperty("--surface-2", surfaceLevels[2]);
            root.style.setProperty("--surface-3", surfaceLevels[3]);
            root.style.setProperty("--surface-4", surfaceLevels[4]);
        }
    } else {
        if (!isBrand) {
            surfaceLevels = generateLightElevation(tintSource);
            root.style.setProperty("--surface-0", surfaceLevels[0]);
            root.style.setProperty("--surface-1", surfaceLevels[1]);
            root.style.setProperty("--surface-2", surfaceLevels[2]);
            root.style.setProperty("--surface-3", surfaceLevels[3]);
            root.style.setProperty("--surface-4", surfaceLevels[4]);
        }
    }
    root.style.setProperty("--border-elevation", computeElevationBorder(isDark, tintSource));

    // Surface level fallbacks (brand palette uses CSS defaults, not JS-injected)
    const levels = surfaceLevels ?? (isDark ? BRAND_DARK : BRAND_LIGHT);
    const mode = isDark ? "dark" : "light";

    // ── Card surface border token — Fix 1 (QA) ───────────────────────────────
    // Provides a visible delineating border for tinted card surfaces that are
    // indistinguishable from the page background in washed-out palettes.
    // When surface-to-white contrast < 1.25:1, opacity is raised to 0.22 so
    // cards are clearly separated from the page; otherwise stays at 0.04 (subtle).
    if (!isDark && surfaceLevels) {
        const surfaceVsWhite = getContrastRatio(surfaceLevels[1], "#ffffff");
        const opacity = surfaceVsWhite < 1.25 ? 0.22 : 0.04;
        root.style.setProperty("--color-card-surface-border", `rgba(${pRgb.r},${pRgb.g},${pRgb.b},${opacity})`);
    } else {
        root.style.setProperty("--color-card-surface-border", isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.04)");
    }

    // ── Active state tokens ───────────────────────────────────────────────────
    const navActive = computeActiveState(primary, levels[3], mode);
    const sideActive = computeActiveState(primary, levels[2], mode);

    // Fix 3 (QA): Dark mode hover must use a guaranteed-visible white tint (10%)
    // rather than a low-opacity accent tint (~5%) which blends into dark surfaces
    // for low-chroma palettes. 28 of 36 palettes failed this check in QA.
    const hoverBg = isDark ? "rgba(255,255,255,0.10)" : `${navActive.text}0A`;
    // Fix 3: Left border indicator on hover — palette-independent positional cue.
    // Half-opacity active border ensures hover is visually subordinate to active.
    const hoverBorder = isDark ? `${navActive.border}80` : "transparent";

    // Fix 2+4 (QA): Foreground accent guaranteed ≥ 4.5:1 contrast on the surface.
    // Use text-(--accent-foreground) for breadcrumbs, icons, inline accent text
    // instead of text-orange-400 which is the raw palette anchor (may be too light).
    const surfaceForContrast = isDark ? levels[2] : "#ffffff";
    const accentForeground = isDark ? lightenToContrast(primary, surfaceForContrast, 4.5) : darkenToContrast(primary, surfaceForContrast, 4.5);

    // Fix 4 (QA): Icon-specific accent with relaxed 3:1 threshold (WCAG non-text minimum).
    // Preserves more hue character than accentForeground while ensuring visibility.
    const accentIcon = isDark ? lightenToContrast(primary, surfaceForContrast, 3.0) : darkenToContrast(primary, surfaceForContrast, 3.0);

    root.style.setProperty("--nav-active-text", navActive.text);
    root.style.setProperty("--nav-active-bg", navActive.bg);
    root.style.setProperty("--nav-active-border", navActive.border);
    root.style.setProperty("--side-active-text", sideActive.text);
    root.style.setProperty("--side-active-bg", sideActive.bg);
    root.style.setProperty("--side-active-border", sideActive.border);
    root.style.setProperty("--nav-hover-bg", hoverBg);
    root.style.setProperty("--side-hover-bg", hoverBg);
    root.style.setProperty("--nav-hover-border", hoverBorder);
    root.style.setProperty("--side-hover-border", hoverBorder);
    root.style.setProperty("--accent-foreground", accentForeground);
    root.style.setProperty("--accent-icon", accentIcon);

    // Fix (QA — dark-mode nav legibility): per-group palette families.
    // The sidebar gives each nav group its own hue (Finance=yellow, Records=blue,
    // Management=purple/secondary, …). Those GROUP_COLOR_MAP entries previously
    // used the raw -400 anchor for dots and active text, which is invisible in
    // dark mode when a palette's family anchor is near-black (e.g. The Divine
    // yellow #3a2824, secondary #42342f → invisible Finance/Management dots and
    // an unreadable active item). Compute contrast-safe per-family colours against
    // the sidebar surface, mirroring the primary (--side-active-*). Palette-agnostic.
    const sidebarSurface = levels[2];
    const navGroupFamilies = { purple: secondary, blue, yellow, turquoise };
    for (const [fam, anchor] of Object.entries(navGroupFamilies)) {
        const fa = computeActiveState(anchor, sidebarSurface, mode);
        root.style.setProperty(`--side-${fam}-text`, fa.text);
        root.style.setProperty(`--side-${fam}-bg`, fa.bg);
    }

    // ── Status colour tokens ──────────────────────────────────────────────────
    // Computed against surface-0 (content area — where most statuses appear).
    const statusSurface = levels[0];
    Object.entries(STATUS_HUES).forEach(([status, { hue, saturation }]) => {
        const sc = computeStatusColor(hue, saturation, statusSurface, mode);
        root.style.setProperty(`--status-${status}-bg`, sc.bg);
        root.style.setProperty(`--status-${status}-base`, sc.base);
        root.style.setProperty(`--status-${status}-text`, sc.text);
    });

    // ── Palette-aware surface colours ─────────────────────────────────────────
    // Dark surfaces are tinted with the secondary colour's hue at dramatically
    // reduced saturation so the background feels cohesive without being garish.
    // Cool hues (teal, blue, purple — H 170-300) get a visible tint; warm hues
    // (red, orange, pink — outside that range) stay near-neutral.
    const { h: sh, s: ss } = hexToHsl(secondary);
    const warmFactor = sh >= 170 && sh <= 300 ? 1.0 : sh > 300 || sh < 30 ? 0.25 : 0.55;
    const dSat = Math.min(ss * warmFactor * 0.24, 20);
    root.style.setProperty("--palette-surface-dark", hslToHex(sh, dSat, 5));
    root.style.setProperty("--palette-surface-2-dark", hslToHex(sh, dSat * 1.25, 10));
    root.style.setProperty("--palette-surface-3-dark", hslToHex(sh, dSat * 1.5, 15));

    // Light surfaces: use the tint source (override-aware) so the page
    // background is always comfortable — never a screaming pink or muddy yellow.
    root.style.setProperty("--palette-surface-light", tintHex);
    root.style.setProperty("--palette-surface-2-light", mix(tintHex, "#f0f0f0", 0.35));
    root.style.setProperty("--palette-surface-3-light", "#f0f0f0");

    // ── Semantic dark-mode overrides ──────────────────────────────────────────
    // Set when a named palette supplies explicit dark-mode anchors so that
    // --bg-surface, --bg-surface-2, --text-primary, and --text-muted in the
    // [data-theme=dark] CSS block resolve to palette-specific values instead
    // of the brand defaults.  Brand palettes (no dark keys) and the custom
    // palette clear these variables so the existing fallback chain in
    // index.css takes over unchanged.
    //
    // In light mode, named palettes also receive HSL-derived tints so every
    // surface has a whisper of the palette's primary colour instead of plain
    // white.
    if (darkSurface && darkText && darkMuted) {
        if (isDark) {
            root.style.setProperty("--color-dark-surface", darkSurface);
            root.style.setProperty("--color-dark-text", darkText);
            root.style.setProperty("--color-dark-muted", darkMuted);
            // Elevated surface (navbar/sidebar header): 6 % lighter than darkSurface
            const { h: dh, s: ds, l: dl } = hexToHsl(darkSurface);
            root.style.setProperty("--color-dark-surface-elevated", hslToHex(dh, ds, Math.min(dl + 6, 28)));
            root.style.removeProperty("--color-light-surface");
            root.style.removeProperty("--color-light-surface-alt");
        } else {
            root.style.removeProperty("--color-dark-surface");
            root.style.removeProperty("--color-dark-text");
            root.style.removeProperty("--color-dark-muted");
            root.style.removeProperty("--color-dark-surface-elevated");
            root.style.setProperty("--color-light-surface", tintHex);
            root.style.setProperty("--color-light-surface-alt", tintHexAlt);
        }
    } else {
        root.style.removeProperty("--color-dark-surface");
        root.style.removeProperty("--color-dark-text");
        root.style.removeProperty("--color-dark-muted");
        root.style.removeProperty("--color-dark-surface-elevated");
        root.style.removeProperty("--color-light-surface");
        root.style.removeProperty("--color-light-surface-alt");
    }

    // ── Palette-aware text colour tokens ──────────────────────────────────────
    // tintSource and tintHex are computed earlier in this function — reuse them.
    if (isDark) {
        if (darkSurface && darkText && darkMuted) {
            root.style.setProperty("--text-primary", darkText);
            root.style.setProperty("--text-secondary", computeDarkSecondaryText(darkMuted));
            root.style.removeProperty("--text-tertiary"); // CSS uses opacity on darkMuted
            const accentTxt = computeAccentText(primary, darkSurface, "dark");
            root.style.setProperty("--text-accent", accentTxt);
            root.style.setProperty("--text-accent-hover", lighten(accentTxt, 12));
        } else {
            // Brand/custom palette — clear overrides so CSS [data-theme=dark] defaults take over
            root.style.removeProperty("--text-primary");
            root.style.removeProperty("--text-secondary");
            root.style.removeProperty("--text-tertiary");
            root.style.removeProperty("--text-accent");
            root.style.removeProperty("--text-accent-hover");
        }
    } else {
        const lt = computeLightTextColors(tintSource);
        root.style.setProperty("--text-primary", lt.primary);
        root.style.setProperty("--text-secondary", lt.secondary);
        root.style.setProperty("--text-tertiary", lt.tertiary);
        const accentTxt = computeAccentText(primary, tintHex, "light");
        root.style.setProperty("--text-accent", accentTxt);
        root.style.setProperty("--text-accent-hover", darken(accentTxt, 12));
    }
}

/** Remove all inline overrides, restoring the @theme stylesheet values. */
export function clearPaletteVars() {
    const root = document.documentElement;
    const families = ["orange", "primary", "purple", "secondary", "blue", "turquoise", "yellow"];
    for (const fam of families) {
        for (const shade of SHADES) {
            root.style.removeProperty(`--color-${fam}-${shade}`);
        }
    }
    root.style.removeProperty("--glow-orange");
    root.style.removeProperty("--glow-purple");
    root.style.removeProperty("--glow-blue");
    root.style.removeProperty("--color-gradient-from");
    root.style.removeProperty("--color-gradient-to");
    root.style.removeProperty("--color-gradient-text");
    root.style.removeProperty("--palette-surface-dark");
    root.style.removeProperty("--palette-surface-2-dark");
    root.style.removeProperty("--palette-surface-3-dark");
    root.style.removeProperty("--palette-surface-light");
    root.style.removeProperty("--palette-surface-2-light");
    root.style.removeProperty("--palette-surface-3-light");
    root.style.removeProperty("--color-dark-surface");
    root.style.removeProperty("--color-dark-text");
    root.style.removeProperty("--color-dark-muted");
    root.style.removeProperty("--color-dark-surface-elevated");
    root.style.removeProperty("--color-light-surface");
    root.style.removeProperty("--color-light-surface-alt");
    root.style.removeProperty("--accent");
    root.style.removeProperty("--accent-subtle");
    root.style.removeProperty("--accent-muted");
    root.style.removeProperty("--accent-on-dark");
    root.style.removeProperty("--shadow-tint");
    root.style.removeProperty("--border-subtle");
    root.style.removeProperty("--text-on-accent");
    root.style.removeProperty("--text-primary");
    root.style.removeProperty("--text-secondary");
    root.style.removeProperty("--text-tertiary");
    root.style.removeProperty("--text-accent");
    root.style.removeProperty("--text-accent-hover");
    // ── Surface elevation ─────────────────────────────────────────────────────
    for (let i = 0; i <= 4; i++) root.style.removeProperty(`--surface-${i}`);
    root.style.removeProperty("--border-elevation");

    // ── Active state tokens ───────────────────────────────────────────────────
    [
        "--nav-active-text",
        "--nav-active-bg",
        "--nav-active-border",
        "--side-active-text",
        "--side-active-bg",
        "--side-active-border",
        "--nav-hover-bg",
        "--side-hover-bg",
        "--nav-hover-border",
        "--side-hover-border",
        "--accent-foreground",
        "--accent-icon",
        "--color-card-surface-border",
        "--side-purple-text",
        "--side-purple-bg",
        "--side-blue-text",
        "--side-blue-bg",
        "--side-yellow-text",
        "--side-yellow-bg",
        "--side-turquoise-text",
        "--side-turquoise-bg",
    ].forEach((v) => root.style.removeProperty(v));

    // ── Status colour tokens ──────────────────────────────────────────────────
    ["success", "warning", "danger", "info", "neutral"].forEach((s) => {
        ["bg", "base", "text"].forEach((l) => root.style.removeProperty(`--status-${s}-${l}`));
    });
}

// ── Palette registry ──────────────────────────────────────────────────────────

/**
 * @typedef {{ primary:string, secondary:string, blue:string, turquoise:string, yellow:string }} PaletteColors
 * @typedef {{ id:string, name:string, colors:PaletteColors|null }} Palette
 */

/** @type {Palette[]} */
export const PALETTES = [
    // ── Brand ─────────────────────────────────────────────────────────────────
    {
        id: "aumovio-orange",
        name: "Aumovio Orange",
        colors: {
            primary: "#ff4208",
            secondary: "#4827af",
            blue: "#18a9e7",
            turquoise: "#12caae",
            yellow: "#cec43a",
        },
    },
    {
        id: "aumovio-purple",
        name: "Aumovio Purple",
        colors: {
            primary: "#4827af",
            secondary: "#ff4208",
            blue: "#7c3aed",
            turquoise: "#a78bfa",
            yellow: "#e879f9",
        },
    },

    // ── Named (dark-mode-extended) ────────────────────────────────────────────

    {
        id: "skydive",
        name: "Skydive",
        colors: {
            primary: "#434645",
            secondary: "#4c7a82",
            blue: "#1c6870",
            turquoise: "#114751",
            yellow: "#112328",
            darkSurface: "#0a1214",
            darkText: "#c2d8dc",
            darkMuted: "#3a5a62",
        },
    },
    {
        id: "the-divine",
        name: "The Divine",
        colors: {
            primary: "#7b5235",
            secondary: "#42342f",
            blue: "#fbc27b",
            turquoise: "#cbdbe2",
            yellow: "#3a2824",
            darkSurface: "#1a120d",
            darkText: "#f0dcc8",
            darkMuted: "#6b4d38",
        },
    },
    {
        id: "too-much",
        name: "Too Much",
        colors: {
            primary: "#ab648f",
            secondary: "#e41144",
            blue: "#9b122e",
            turquoise: "#75122e",
            yellow: "#260b18",
            darkSurface: "#140610",
            darkText: "#f0c2d8",
            darkMuted: "#6e3050",
        },
    },
    {
        id: "through-the-window",
        name: "Through the Window",
        colors: {
            primary: "#171f24",
            secondary: "#466271",
            blue: "#667a86",
            turquoise: "#74868e",
            yellow: "#bad0d5",
            darkSurface: "#0c1115",
            darkText: "#d4e4e8",
            darkMuted: "#3a5060",
        },
    },
    {
        id: "bloodlust",
        name: "Bloodlust",
        colors: {
            primary: "#3b080f",
            secondary: "#7c121c",
            blue: "#c2a08d",
            turquoise: "#6f6e69",
            yellow: "#3e3f3d",
            darkSurface: "#1a0408",
            darkText: "#e8c8b8",
            darkMuted: "#5c2028",
        },
    },
    {
        id: "muted",
        name: "Muted",
        colors: {
            primary: "#985a5f",
            secondary: "#ae9fa3",
            blue: "#c3d6de",
            turquoise: "#7d9cb2",
            yellow: "#50708f",
            darkSurface: "#141218",
            darkText: "#dce4ea",
            darkMuted: "#5a4850",
        },
    },
    {
        id: "not-enough",
        name: "Not Enough",
        colors: {
            primary: "#4a5435",
            secondary: "#263138",
            blue: "#eae1e4",
            turquoise: "#67677a",
            yellow: "#df8435",
            darkSurface: "#111610",
            darkText: "#e4ddd0",
            darkMuted: "#485038",
        },
    },
    {
        id: "desperate-touch",
        name: "Desperate Touch",
        colors: {
            primary: "#ca92a6",
            secondary: "#ec86a3",
            blue: "#a46781",
            turquoise: "#547ca5",
            yellow: "#847c94",
            darkSurface: "#160d14",
            darkText: "#f2d4e0",
            darkMuted: "#6a4058",
        },
    },
    {
        id: "high-standards",
        name: "High Standards",
        colors: {
            primary: "#ae8d30",
            secondary: "#5b4a3a",
            blue: "#2b492b",
            turquoise: "#1e3b23",
            yellow: "#47453d",
            darkSurface: "#0e0d08",
            darkText: "#ddd0a0",
            darkMuted: "#5c5428",
        },
    },
    {
        id: "fade-away",
        name: "Fade Away",
        colors: {
            primary: "#323e48",
            secondary: "#5f6067",
            blue: "#5e4d58",
            turquoise: "#505c54",
            yellow: "#808f87",
            darkSurface: "#0e1216",
            darkText: "#c4ccd2",
            darkMuted: "#3e484e",
        },
    },
    {
        id: "office",
        name: "Office",
        colors: {
            primary: "#8f6a0a",
            secondary: "#94906f",
            blue: "#dedbc4",
            turquoise: "#92a197",
            yellow: "#4e5142",
            darkSurface: "#12110a",
            darkText: "#e8e0c4",
            darkMuted: "#5c5830",
        },
    },
    {
        id: "cigarette-smoke",
        name: "Cigarette Smoke",
        colors: {
            primary: "#435061",
            secondary: "#2a3a50",
            blue: "#5f6e7c",
            turquoise: "#153034",
            yellow: "#101e1d",
            darkSurface: "#080e12",
            darkText: "#b8c8d4",
            darkMuted: "#2e4050",
        },
    },
    {
        id: "horizon",
        name: "Horizon",
        colors: {
            primary: "#6f7a6f",
            secondary: "#0e4a42",
            blue: "#205c54",
            turquoise: "#a5847e",
            yellow: "#e37a6f",
            darkSurface: "#0a1210",
            darkText: "#d4dcd0",
            darkMuted: "#3c5a4e",
        },
    },
    {
        id: "never-again",
        name: "Never Again",
        colors: {
            primary: "#ccdcc4",
            secondary: "#979a78",
            blue: "#525c3c",
            turquoise: "#34150c",
            yellow: "#1f0b09",
            darkSurface: "#0e0806",
            darkText: "#e4ecd8",
            darkMuted: "#504830",
        },
    },
    {
        id: "star",
        name: "Star",
        colors: {
            primary: "#1d333a",
            secondary: "#52747d",
            blue: "#a4ccd4",
            turquoise: "#2d5e56",
            yellow: "#16322b",
            darkSurface: "#0a1418",
            darkText: "#c8e4ea",
            darkMuted: "#2e5058",
        },
    },
    {
        id: "just-leave",
        name: "Just Leave",
        colors: {
            primary: "#ffc525",
            secondary: "#ff8a27",
            blue: "#be7b47",
            turquoise: "#fbf0ea",
            yellow: "#353130",
            darkSurface: "#161210",
            darkText: "#fce8c4",
            darkMuted: "#6e4c20",
        },
    },
    {
        id: "i-see-you",
        name: "I See You",
        colors: {
            primary: "#d8aa8d",
            secondary: "#6b403d",
            blue: "#3b2c40",
            turquoise: "#272844",
            yellow: "#0e101f",
            darkSurface: "#0a0a14",
            darkText: "#e8ccb8",
            darkMuted: "#4a3040",
        },
    },
    {
        id: "past-times",
        name: "Past Times",
        colors: {
            primary: "#dab123",
            secondary: "#5a3f1b",
            blue: "#e65922",
            turquoise: "#c0e59c",
            yellow: "#ebd475",
            darkSurface: "#141006",
            darkText: "#f4e4b0",
            darkMuted: "#6e5018",
        },
    },
    {
        id: "rough-sex",
        name: "Rough Sex",
        colors: {
            primary: "#ffc0cb",
            secondary: "#ccc1b5",
            blue: "#92272c",
            turquoise: "#60161a",
            yellow: "#270409",
            darkSurface: "#120306",
            darkText: "#f4d4da",
            darkMuted: "#5c2028",
        },
    },
    {
        id: "cheap-motel",
        name: "Cheap Motel",
        colors: {
            primary: "#ff0066",
            secondary: "#6a2141",
            blue: "#3c0f24",
            turquoise: "#008b8b",
            yellow: "#8fa382",
            darkSurface: "#10060e",
            darkText: "#f8c0d8",
            darkMuted: "#5c1838",
        },
    },
    {
        id: "crybaby",
        name: "Crybaby",
        colors: {
            primary: "#ade4eb",
            secondary: "#59a5cb",
            blue: "#3075b4",
            turquoise: "#003bd2",
            yellow: "#0b1242",
            darkSurface: "#060a18",
            darkText: "#c8e8f0",
            darkMuted: "#1e3868",
        },
    },
    {
        id: "wave",
        name: "Wave",
        colors: {
            primary: "#cbdcd6",
            secondary: "#59c3ad",
            blue: "#009f8c",
            turquoise: "#07594a",
            yellow: "#072d24",
            darkSurface: "#04140f",
            darkText: "#d4ece4",
            darkMuted: "#1e5040",
        },
    },
    {
        id: "set-me-free",
        name: "Set Me Free",
        colors: {
            primary: "#e0e3ff",
            secondary: "#3c4774",
            blue: "#41010a",
            turquoise: "#d52229",
            yellow: "#ffd0d3",
            darkSurface: "#0e0408",
            darkText: "#f0e8f4",
            darkMuted: "#4c2030",
        },
    },
    {
        id: "choking",
        name: "Choking",
        colors: {
            primary: "#a1ee9e",
            secondary: "#b4cfc5",
            blue: "#7e5f80",
            turquoise: "#47324c",
            yellow: "#1b0b1a",
            darkSurface: "#0c060c",
            darkText: "#d4f0d0",
            darkMuted: "#3e4840",
        },
    },
    {
        id: "overboard",
        name: "Overboard",
        colors: {
            primary: "#e7d5d8",
            secondary: "#ff4171",
            blue: "#a29f42",
            turquoise: "#ba2d54",
            yellow: "#2f0a3a",
            darkSurface: "#14060e",
            darkText: "#f4dce0",
            darkMuted: "#6a2040",
        },
    },
    {
        id: "bruised",
        name: "Bruised",
        colors: {
            primary: "#3b5866",
            secondary: "#4a1c5d",
            blue: "#f89ad4",
            turquoise: "#937ca8",
            yellow: "#0a0b52",
            darkSurface: "#08061a",
            darkText: "#d8c0ec",
            darkMuted: "#3c2858",
        },
    },
    {
        id: "broken",
        name: "Broken",
        colors: {
            primary: "#f0faff",
            secondary: "#a7efff",
            blue: "#3ee2ff",
            turquoise: "#00a2ff",
            yellow: "#3036ff",
            darkSurface: "#040a14",
            darkText: "#d8f0fc",
            darkMuted: "#184060",
        },
    },
    {
        id: "calm",
        name: "Calm",
        colors: {
            primary: "#795138",
            secondary: "#e1af88",
            blue: "#e4ca9e",
            turquoise: "#ede0bc",
            yellow: "#fffee1",
            darkSurface: "#120c08",
            darkText: "#f4e4d0",
            darkMuted: "#5a4028",
        },
    },
    {
        id: "crackle",
        name: "Crackle",
        colors: {
            primary: "#fff7db",
            secondary: "#87541b",
            blue: "#461413",
            turquoise: "#2a0005",
            yellow: "#00c2b2",
            darkSurface: "#100804",
            darkText: "#f8ecd0",
            darkMuted: "#5c3818",
        },
    },
    {
        id: "always",
        name: "Always",
        colors: {
            primary: "#ff466e",
            secondary: "#e04675",
            blue: "#70597d",
            turquoise: "#505c7c",
            yellow: "#176383",
            darkSurface: "#0e0810",
            darkText: "#f0c4d4",
            darkMuted: "#583048",
        },
    },
    {
        id: "fighting-on",
        name: "Fighting On",
        colors: {
            primary: "#5d52e6",
            secondary: "#998ee6",
            blue: "#cfcbf6",
            turquoise: "#fffbb8",
            yellow: "#d9c44c",
            darkSurface: "#0a0818",
            darkText: "#e0dcf8",
            darkMuted: "#342e6e",
        },
    },
    {
        id: "heartache",
        name: "Heartache",
        colors: {
            primary: "#ffc2cc",
            secondary: "#cd8492",
            blue: "#a55667",
            turquoise: "#752535",
            yellow: "#4b0d18",
            darkSurface: "#14060a",
            darkText: "#f8d4dc",
            darkMuted: "#5c2030",
        },
    },
    {
        id: "eternity",
        name: "Eternity",
        colors: {
            primary: "#fdf8ff",
            secondary: "#e1c7f9",
            blue: "#9b6fc4",
            turquoise: "#67106d",
            yellow: "#13101b",
            darkSurface: "#0c0810",
            darkText: "#f0e4f8",
            darkMuted: "#402858",
        },
    },
    {
        id: "never",
        name: "Never",
        colors: {
            primary: "#cb624f",
            secondary: "#bfe4af",
            blue: "#999583",
            turquoise: "#5a4f5c",
            yellow: "#331b26",
            darkSurface: "#120a0e",
            darkText: "#e4d4c8",
            darkMuted: "#4e3840",
        },
    },
    {
        id: "wildfire",
        name: "Wildfire",
        colors: {
            primary: "#297475",
            secondary: "#fbc674",
            blue: "#f6613c",
            turquoise: "#e52327",
            yellow: "#a91823",
            darkSurface: "#0e0804",
            darkText: "#f8dcc0",
            darkMuted: "#5c3018",
        },
    },
    {
        id: "soft-boy",
        name: "Soft Boy",
        colors: {
            primary: "#335e7d",
            secondary: "#6c5c8f",
            blue: "#ff5c77",
            turquoise: "#fca881",
            yellow: "#f7caaa",
            darkSurface: "#0c0a14",
            darkText: "#e8d4e4",
            darkMuted: "#3e2c58",
        },
    },
    {
        id: "corporate",
        name: "Corporate",
        colors: {
            primary: "#455a64",
            secondary: "#263238",
            blue: "#546e7a",
            turquoise: "#607d8b",
            yellow: "#90a4ae",
            darkSurface: "#0c1014",
            darkText: "#c8d8e0",
            darkMuted: "#2e4450",
        },
    },

    // ── Custom (user-picked primary, rest derived) ─────────────────────────────
    { id: "custom", name: "Custom", colors: null },
];

/** Return a palette entry by id, or the first entry as fallback. */
export function findPalette(id) {
    return PALETTES.find((p) => p.id === id) ?? PALETTES[0];
}
