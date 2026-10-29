/**
 * systemMapTones.js — theme- and palette-aware colours for the system-map
 * diagrams.
 *
 * The API ships a hex `color` on every layer and edge kind (useful for the
 * standalone JSON), but the page never paints with it: a fixed hex ignores the
 * user's palette and has no contrast guarantee in either theme. Instead each
 * layer / edge kind gets a TONE by its position, drawn from the design
 * system's own tokens:
 *
 *   - the five palette-adaptive families first (orange = primary, blue,
 *     purple = secondary, turquoise, yellow) — `applyPaletteVars()` recomputes
 *     both their fill scale and their contrast-safe foreground per palette and
 *     per theme;
 *   - then the fixed semantic status tones (success, warning, danger, neutral).
 *
 * `text` is the contrast-safe foreground (≥ 4.5:1 on the surface) — use it for
 * text, edge strokes and anything that must read against the background.
 * `fill` is the family anchor — use it for dots, bars and tinted backgrounds
 * (at low opacity), never for text. `onFill` is the foreground for a SOLID fill.
 *
 * Past the end of the list tones repeat with `dashed: true`, so two edge kinds
 * that share a colour are still told apart by their stroke.
 */

export const TONES = Object.freeze([
    { name: "orange", fill: "var(--color-orange-400)", text: "var(--accent-foreground)", onFill: "var(--on-accent-text)" },
    { name: "blue", fill: "var(--color-blue-400)", text: "var(--blue-foreground)", onFill: "var(--on-blue-text)" },
    { name: "purple", fill: "var(--color-purple-400)", text: "var(--secondary-foreground)", onFill: "var(--on-secondary-text)" },
    { name: "turquoise", fill: "var(--color-turquoise-400)", text: "var(--turquoise-foreground)", onFill: "var(--on-turquoise-text)" },
    { name: "yellow", fill: "var(--color-yellow-400)", text: "var(--yellow-foreground)", onFill: "var(--on-yellow-text)" },
    { name: "success", fill: "var(--status-success-base)", text: "var(--status-success-text)", onFill: "#ffffff" },
    { name: "warning", fill: "var(--status-warning-base)", text: "var(--status-warning-text)", onFill: "#000000" },
    { name: "danger", fill: "var(--status-danger-base)", text: "var(--status-danger-text)", onFill: "#ffffff" },
    { name: "neutral", fill: "var(--status-neutral-base)", text: "var(--status-neutral-text)", onFill: "#ffffff" },
]);

/**
 * Tone for the i-th layer or edge kind.
 *
 * @param {number} index
 * @returns {{ name: string, fill: string, text: string, onFill: string, dashed: boolean }}
 */
export function toneAt(index) {
    const i = Math.max(0, Number(index) || 0);
    return { ...TONES[i % TONES.length], dashed: i >= TONES.length };
}

/**
 * id → tone for a list of ids, in the order the map gives them.
 *
 * @param {string[]} ids
 * @returns {Record<string, ReturnType<typeof toneAt>>}
 */
export function tonesById(ids) {
    return Object.fromEntries(ids.map((id, i) => [id, toneAt(i)]));
}
