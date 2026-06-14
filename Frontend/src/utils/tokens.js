/**
 * @fileoverview JS mirror of the Aumovio Design System v3.1 brand-anchor colours.
 *
 * WHY THIS FILE EXISTS
 *   ApexCharts options are a plain JavaScript object built before render, so they
 *   cannot consume CSS custom properties (`var(--color-*)`) the way Tailwind
 *   utilities do. `chartDefaults.js` needs concrete hex strings for its `colors[]`
 *   palette, so this file mirrors the `@theme` brand anchors defined in
 *   `src/assets/styles/index.css`. These five anchors are the ONLY hard-coded hex
 *   values permitted in JS land — every other surface must use design tokens.
 *
 *   Keep in sync with index.css: each value below is the `*-400` brand anchor.
 */

/**
 * Brand-anchor colours (the `*-400` step of each scale in index.css `@theme`).
 * @type {{ primary: string, secondary: string, blue: string, turquoise: string, success: string, danger: string, warn: string }}
 */
export const TOKENS = {
    primary:   "#ff4208", // --color-orange-400 / --color-primary-400 (brand anchor)
    secondary: "#4827af", // --color-purple-400 / --color-secondary-400 (brand anchor)
    blue:      "#18a9e7", // --color-blue-400
    turquoise: "#12caae", // --color-turquoise-400
    success:   "#32cb70", // --color-success-400
    danger:    "#d82822", // --color-danger-400
    warn:      "#ffd600", // --color-warn-400
};

export default TOKENS;
