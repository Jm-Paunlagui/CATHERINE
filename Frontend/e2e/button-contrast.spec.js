/**
 * button-contrast.spec.js — PROVES, in a real Chromium, whether buttons (and
 * the shared icon tiles) are legible and their states
 * distinguishable in light and dark themes across Personalize palettes.
 *
 * These tests assert the CORRECT behaviour. A red run is the evidence.
 *
 * ── Rules (per variant x theme x palette) ────────────────────────────────
 *  T1  WCAG 1.4.3: enabled label text vs the button fill (the surface, for
 *      transparent variants) >= 4.5:1, at rest AND on hover (page.hover).
 *      Label colour = computed `color` composited over the rendered fill pixel.
 *  B1  WCAG 1.4.11 + owner rule:
 *        boundary variants (ghost, outline, DetailButton) — border
 *          >= 3:1 vs the surface AND owner direction (dark -> border lighter
 *          than surface; light -> darker). Light ghost/DetailButton use the
 *          owner's soft neutral border: >= 1.4:1 instead of 3:1.
 *        link — text-link look: underline >= 3:1 vs surface, no border.
 *        filled / tinted variants — fill >= 3:1 vs surface ("fill") OR a
 *          border that is >= 3:1 vs surface with the owner direction
 *          ("border"). A label that only clears 4.5:1 is reported as
 *          "label-only" and FAILS (owner requires a visible boundary).
 *  F1  Keyboard focus-visible ring >= 3:1 vs the surface, and owner
 *      direction (dark -> lighter than surface; light -> darker). Focus is
 *      reached with real keys (Shift+Tab, Tab), never click.
 *  D1  Enabled must not look disabled: enabled label >= 4.5:1 (T1 rest) AND
 *      rendered enabled label vs rendered disabled label >= 1.5:1. Also
 *      records whether `disabled` differs from enabled by opacity only.
 *
 * ── Icon tiles (describe "icon tiles") ──────────────────────────────────
 *  I1  WCAG 1.4.11: tile fill vs surface >= 3:1 OR tile border vs surface
 *      >= 3:1 (reports which carries it). Light neutral tiles (--tile-border)
 *      use the owner's soft border: >= 1.4:1.
 *  I2  icon glyph vs tile fill >= 3:1.
 *  I3  owner direction for non-semantic (neutral / palette-accent) tiles:
 *      the carrying boundary is lighter than the surface in dark mode,
 *      darker in light mode. Semantic tiles (green/red/amber) report I3 but
 *      do not assert it.
 *
 * ── Colour sources ──────────────────────────────────────────────────────
 *  surface   rendered pixel 6px outside the element (Card / page surface)
 *  fill      rendered pixel just inside the border (left-middle and
 *            right-middle; the worse one is used)
 *  border    computed border-color composited over (bg over surface)
 *  label     computed color over fill (T1); D1 uses the rendered label
 *            "core" pixel (max contrast vs fill inside the text box), so
 *            opacity / grayscale on disabled is captured as painted.
 *  oklab()/color-mix() strings are resolved to sRGB via a 1x1 canvas.
 *
 * ── Theme / palette ─────────────────────────────────────────────────────
 *  Same mechanism as e2e/focus-contrast.spec.js: localStorage
 *  `aumovio-personalize` + `aumovio-theme` via addInitScript, emulateMedia,
 *  then assert <html data-theme>.
 *
 * ── Mounting ────────────────────────────────────────────────────────────
 *  Harness: e2e/fixtures/button-harness.html (test-only Vite entry).
 *
 * Output: e2e/artifacts/button-contrast-report.json + screenshots.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { PALETTES as ALL_PALETTES } from "../src/features/personalize/personalize.palettes.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = path.join(HERE, "artifacts");
const ROWS_DIR = path.join(ARTIFACTS, "button-rows");
const REPORT = path.join(ARTIFACTS, "button-contrast-report.json");
mkdirSync(ROWS_DIR, { recursive: true });

const HARNESS = "/e2e/fixtures/button-harness.html";
const TEXT_MIN = 4.5;
const NONTEXT_MIN = 3;
// Design decision: light-mode neutral border (--field-border grey-300) is soft, shared by every control.
const SOFT_BORDER_LIGHT_MIN = 1.4;
const SOFT_BORDER_KINDS = new Set(["ghost", "detail"]);
const D1_DIFF_MIN = 1.5;

const THEMES = ["light", "dark"];
const PALETTES = process.env.PALETTES ? process.env.PALETTES.split(",") : ALL_PALETTES.filter((p) => p.colors).map((p) => p.id);

// Variants from src/components/ui/Button.jsx VARIANTS (`warn` is an alias of
// `warning`, Button.jsx:64, so it is not measured twice).
const VARIANTS = ["primary", "accent", "danger", "success", "warning", "ghost", "outline", "link", "gradient"];
const BOUNDARY_VARIANTS = new Set(["ghost", "outline", "link", "detail"]);

// ─── WCAG colour math ─────────────────────────────────────────────────────

function channel(c) {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
function luminance([r, g, b]) {
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function contrast(a, b) {
    const la = luminance(a);
    const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
function over([r, g, b, a = 1], [br, bg, bb]) {
    return [Math.round(r * a + br * (1 - a)), Math.round(g * a + bg * (1 - a)), Math.round(b * a + bb * (1 - a))];
}
const hex = (c) => (c ? "#" + c.slice(0, 3).map((v) => v.toString(16).padStart(2, "0")).join("") : null);
const sameRgb = (a, b) => a.slice(0, 3).every((v, i) => Math.abs(v - b[i]) <= 2);
const r2 = (n) => (n === null || n === undefined || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);
const dirOk = (theme, color, surface) => (theme === "dark" ? luminance(color) > luminance(surface) : luminance(color) < luminance(surface));

// ─── In-page probe ────────────────────────────────────────────────────────

/** Runs in the page: computed style snapshot of `sel` (colours resolved to sRGB rgba). */
function probe(sel) {
    const cv = document.createElement("canvas");
    cv.width = cv.height = 1;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    const toRgba = (str) => {
        if (!str || str === "transparent") return [0, 0, 0, 0];
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = "rgba(0,0,0,0)";
        ctx.fillStyle = str;
        ctx.fillRect(0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        return [d[0], d[1], d[2], Math.round((d[3] / 255) * 1000) / 1000];
    };
    const splitTop = (s) => {
        const out = [];
        let depth = 0;
        let cur = "";
        for (const ch of s) {
            if (ch === "(") depth++;
            if (ch === ")") depth--;
            if (ch === "," && depth === 0) {
                out.push(cur.trim());
                cur = "";
            } else cur += ch;
        }
        if (cur.trim()) out.push(cur.trim());
        return out;
    };
    const parseShadows = (s) => {
        if (!s || s === "none") return [];
        return splitTop(s).map((part) => {
            const m = part.match(/(rgba?|oklab|oklch|lab|lch|color|hsla?|hwb)\([^)]*\)|#[0-9a-f]{3,8}\b|\btransparent\b/i);
            const color = m ? m[0] : "rgba(0,0,0,1)";
            const nums = (part.replace(color, "").match(/-?[\d.]+px/g) || []).map(parseFloat);
            const [x = 0, y = 0, blur = 0, spread = 0] = nums;
            return { color: toRgba(color), x, y, blur, spread, inset: /\binset\b/.test(part) };
        });
    };
    const el = document.querySelector(sel);
    if (!el) return { error: `not found: ${sel}` };
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();

    // Union rect of the visible text nodes (labels), ignoring icons/spinners.
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let tr = null;
    let label = "";
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.textContent.trim()) continue;
        label += n.textContent.trim() + " ";
        const range = document.createRange();
        range.selectNodeContents(n);
        const r = range.getBoundingClientRect();
        if (!r.width) continue;
        tr = tr ? { x: Math.min(tr.x, r.left), y: Math.min(tr.y, r.top), r: Math.max(tr.r, r.right), b: Math.max(tr.b, r.bottom) } : { x: r.left, y: r.top, r: r.right, b: r.bottom };
    }
    // Label colour comes from the element that actually holds the text.
    let textEl = el;
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
        if (n.textContent.trim()) {
            textEl = n.parentElement;
            break;
        }
    }
    const svg = el.querySelector("svg");
    return {
        tag: el.tagName.toLowerCase(),
        label: label.trim(),
        className: el.className?.toString?.() ?? "",
        disabled: el.disabled === true,
        disabledAttr: el.hasAttribute("disabled"),
        rect: { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
        textRect: tr ? { x: tr.x, y: tr.y, w: tr.r - tr.x, h: tr.b - tr.y } : null,
        color: toRgba(getComputedStyle(textEl).color),
        iconColor: svg ? toRgba(getComputedStyle(svg).color) : null,
        iconRect: svg ? (({ left, top, width, height }) => ({ x: left, y: top, w: width, h: height }))(svg.getBoundingClientRect()) : null,
        bg: toRgba(cs.backgroundColor),
        bgImage: cs.backgroundImage,
        borderWidth: parseFloat(cs.borderLeftWidth) || 0,
        borderStyle: cs.borderLeftStyle,
        borderColor: toRgba(cs.borderLeftColor),
        underline: cs.textDecorationLine.includes("underline"),
        underlineColor: toRgba(cs.textDecorationColor),
        opacity: parseFloat(cs.opacity),
        filter: cs.filter,
        cursor: cs.cursor,
        shadows: parseShadows(cs.boxShadow),
        outline: { style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) || 0, color: toRgba(cs.outlineColor), offset: parseFloat(cs.outlineOffset) || 0 },
        focused: document.activeElement === el,
        focusVisible: el.matches(":focus-visible"),
        dataTheme: document.documentElement.getAttribute("data-theme"),
    };
}

/**
 * Decode a PNG in-page. `points` -> rgb at each point. `cores` -> for each
 * {rect, ref}, the pixel inside rect with max contrast vs ref (label core).
 */
async function samplePng(page, png, points, cores = []) {
    return page.evaluate(
        async ({ b64, pts, cores }) => {
            const img = new Image();
            img.src = "data:image/png;base64," + b64;
            await img.decode();
            const c = document.createElement("canvas");
            c.width = img.width;
            c.height = img.height;
            const ctx = c.getContext("2d", { willReadFrequently: true });
            ctx.drawImage(img, 0, 0);
            const at = (x, y) => {
                const xi = Math.round(x);
                const yi = Math.round(y);
                if (xi < 0 || yi < 0 || xi >= c.width || yi >= c.height) return null;
                const d = ctx.getImageData(xi, yi, 1, 1).data;
                return [d[0], d[1], d[2]];
            };
            const ch = (v) => {
                const s = v / 255;
                return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
            };
            const L = ([r, g, b]) => 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
            const C = (a, b) => (Math.max(L(a), L(b)) + 0.05) / (Math.min(L(a), L(b)) + 0.05);
            const coreOut = cores.map(({ rect, ref }) => {
                if (!rect || !ref) return null;
                const x0 = Math.max(0, Math.floor(rect.x));
                const y0 = Math.max(0, Math.floor(rect.y));
                const w = Math.max(1, Math.min(c.width - x0, Math.ceil(rect.w)));
                const h = Math.max(1, Math.min(c.height - y0, Math.ceil(rect.h)));
                const d = ctx.getImageData(x0, y0, w, h).data;
                let best = null;
                let bestC = 0;
                for (let i = 0; i < d.length; i += 4) {
                    const p = [d[i], d[i + 1], d[i + 2]];
                    const k = C(p, ref);
                    if (k > bestC) {
                        bestC = k;
                        best = p;
                    }
                }
                return best;
            });
            return { points: pts.map(([x, y]) => at(x, y)), cores: coreOut };
        },
        { b64: png.toString("base64"), pts: points, cores },
    );
}

// ─── Page setup ───────────────────────────────────────────────────────────

async function primeTheme(page, theme, palette, extra = {}) {
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript(
        ({ mode, pal, extra }) => {
            localStorage.setItem("aumovio-personalize", JSON.stringify({ mode, transparency: true, palette: pal, customColor: null }));
            localStorage.setItem("aumovio-theme", mode);
            for (const [k, v] of Object.entries(extra)) localStorage.setItem(k, v);
        },
        { mode: theme, pal: palette, extra },
    );
}

async function freezeTransitions(page) {
    await page.addStyleTag({ content: "*,*::before,*::after{transition:none!important}" });
}

/** Keyboard-only focus: put focus on the target, step away and back with real keys. */
async function keyboardFocus(page, sel) {
    await page.mouse.move(1, 1);
    await page.evaluate((s) => document.querySelector(s)?.focus(), sel);
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    let ok = await page.evaluate((s) => document.activeElement === document.querySelector(s), sel);
    if (!ok) {
        // Fallback: Tab forward until reached.
        await page.evaluate(() => document.activeElement?.blur?.());
        for (let i = 0; i < 80 && !ok; i++) {
            await page.keyboard.press("Tab");
            ok = await page.evaluate((s) => document.activeElement === document.querySelector(s), sel);
        }
    }
    await page.waitForTimeout(80);
    return ok;
}

// ─── Measurement ──────────────────────────────────────────────────────────

/** Rest snapshot: computed + rendered surface, fill, border, label core. */
async function snapshot(page, sel) {
    // Late web-font swap reflows the harness row (buttons shift/wrap) between probe and screenshot.
    await page.evaluate(() => document.fonts.ready.then(() => true));
    let m;
    let png;
    let points;
    // Re-probe each attempt: if every fill sample equals the surface, the rect was stale (layout moved).
    for (let attempt = 0; attempt < 10; attempt++) {
        m = await page.evaluate(probe, sel);
        if (m.error) return m;
        const { x, y, w, h } = m.rect;
        const bw = m.borderWidth;
        const cy = y + h / 2;
        png = await page.screenshot();
        // Fill samples avoid the text box (left/right padding area).
        ({ points } = await samplePng(page, png, [
            [x - 6, cy],
            [x + bw + 2.5, cy],
            [x + w - bw - 2.5, cy],
            [x + w / 2, y + bw + 1.5],
        ]));
        const painted = m.bgImage !== "none" || m.bg[3] > 0.5;
        const [s, ...f] = points;
        if (!painted || !s || f.some((p) => p && !sameRgb(p, s))) break;
        await page.waitForTimeout(100);
    }
    const [surface, fillL, fillR, fillTop] = points;
    const fills = [fillL, fillR, fillTop].filter(Boolean);
    const { cores } = await samplePng(page, png, [], [
        { rect: m.textRect, ref: fillL },
        { rect: m.iconRect, ref: fillL },
    ]);
    return { ...m, surface, fills, fillL, labelCore: cores[0], iconCore: cores[1] };
}

function labelContrast(s) {
    // Worst case across fill samples; label = computed colour over that fill.
    return Math.min(...s.fills.map((f) => contrast(over(s.color, f), f)));
}

function borderRgb(s) {
    if (!(s.borderWidth > 0 && s.borderStyle !== "none" && s.borderColor[3] > 0)) return null;
    return over(s.borderColor, over(s.bg, s.surface));
}

function focusRing(f, surface) {
    const rings = f.shadows.filter((s) => !s.inset && s.x === 0 && s.y === 0 && s.blur === 0 && s.spread > 0 && s.color[3] > 0).sort((a, b) => b.spread - a.spread);
    const ring = rings[0] ?? null;
    const offset = rings[1] ?? null;
    if (!ring) return { ring: null, offset: null, ringC: 0, offsetC: 0, width: 0 };
    const ringRgb = over(ring.color, surface);
    const offRgb = offset ? over(offset.color, surface) : null;
    return {
        ring: ringRgb,
        offset: offRgb,
        ringC: contrast(ringRgb, surface),
        offsetC: offRgb ? contrast(offRgb, surface) : 0,
        width: ring.spread - (offset?.spread ?? 0),
    };
}

/** Full T1/B1/F1 measurement of one enabled button. */
async function measureButton(page, sel, { theme, kind, focusShot = null }) {
    await page.mouse.move(1, 1);
    await page.waitForTimeout(60);
    // Under parallel load a fixed wait can sample mid-transition (pixel lands off the button); wait until settled + painted.
    await page.waitForFunction((s) => {
        const el = document.querySelector(s);
        return !!el && el.getAnimations({ subtree: true }).every((a) => a.effect?.getTiming().iterations === Infinity);
    }, sel);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const rest = await snapshot(page, sel);
    if (rest.error) return { error: rest.error };
    const surface = rest.surface;
    const fill = rest.fillL;

    // Hover
    let hover = null;
    if (!rest.disabled) {
        await page.hover(sel);
        await page.waitForTimeout(120);
        hover = await snapshot(page, sel);
        hover.surface = surface; // hover shadows tint the outside; surface itself is unchanged
    }

    // Focus (keyboard)
    const reached = rest.disabled ? false : await keyboardFocus(page, sel);
    const focus = reached ? await page.evaluate(probe, sel) : null;
    let fr = focus ? focusRing(focus, surface) : null;
    if (focus && focusShot) {
        const { x, y, w, h } = focus.rect;
        await page.screenshot({ path: focusShot, clip: { x: Math.max(0, x - 12), y: Math.max(0, y - 12), width: w + 24, height: h + 24 } });
    }
    // No ring: fall back to the outline (UA `auto` outline is two-tone, so it
    // is measured from rendered pixels in a band just outside the element).
    if (focus && !fr.ring && focus.outline.style !== "none" && focus.outline.width > 0) {
        if (focus.outline.style === "auto") {
            const png = await page.screenshot();
            const { x, y, w, h } = focus.rect;
            const pts = [];
            // Chromium paints the auto ring straddling the border edge, so sample 4px out to 3px in.
            for (let d = -3; d <= 4; d++) pts.push([x - d, y + h / 2], [x + w + d - 1, y + h / 2], [x + w / 2, y - d], [x + w / 2, y + h + d - 1]);
            const { points } = await samplePng(page, png, pts);
            let best = null;
            let bestC = 0;
            for (const p of points.filter(Boolean)) {
                const c = contrast(p, surface);
                if (c > bestC) {
                    bestC = c;
                    best = p;
                }
            }
            fr = { ring: best, offset: null, ringC: bestC, offsetC: 0, width: focus.outline.width, kind: "outline(auto, rendered px)" };
        } else {
            const oc = over(focus.outline.color, surface);
            fr = { ring: oc, offset: null, ringC: contrast(oc, surface), offsetC: 0, width: focus.outline.width, kind: `outline(${focus.outline.style})` };
        }
    }

    const t1Rest = labelContrast(rest);
    const t1Hover = hover ? labelContrast(hover) : null;
    const fillVsSurface = Math.min(...rest.fills.map((f) => contrast(f, surface)));
    const border = borderRgb(rest);
    const borderVsSurface = border ? contrast(border, surface) : 0;
    const borderDir = border ? dirOk(theme, border, surface) : false;

    let b1Via;
    let b1;
    const underlineVsSurface = rest.underline && rest.underlineColor ? contrast(over(rest.underlineColor, surface), surface) : 0;
    if (kind === "link") {
        // Link buttons read as text links app-wide: the underline is the boundary, no border.
        b1 = underlineVsSurface >= NONTEXT_MIN;
        b1Via = b1 ? "underline" : rest.underline ? `underline ${r2(underlineVsSurface)}:1` : "no underline";
    } else if (BOUNDARY_VARIANTS.has(kind)) {
        const borderMin = theme === "light" && SOFT_BORDER_KINDS.has(kind) ? SOFT_BORDER_LIGHT_MIN : NONTEXT_MIN;
        b1 = borderVsSurface >= borderMin && borderDir;
        b1Via = b1 ? "border" : border ? `border ${r2(borderVsSurface)}:1${borderDir ? "" : " wrong-direction"}` : "no border";
    } else if (fillVsSurface >= NONTEXT_MIN) {
        b1 = true;
        b1Via = "fill";
    } else if (borderVsSurface >= NONTEXT_MIN && borderDir) {
        b1 = true;
        b1Via = "border";
    } else {
        b1 = false;
        b1Via = t1Rest >= TEXT_MIN ? "label-only (no >=3:1 fill or border)" : "none";
    }

    const f1Dir = fr?.ring ? dirOk(theme, fr.ring, surface) : false;
    const f1 = !!fr && fr.ringC >= NONTEXT_MIN && fr.width >= 1 && f1Dir;

    return {
        selector: sel,
        label: rest.label,
        disabled: rest.disabled,
        className: rest.className,
        surface: hex(surface),
        fill: hex(fill),
        labelColor: hex(over(rest.color, fill)),
        labelColorRaw: rest.color,
        labelCore: hex(rest.labelCore),
        border: hex(border),
        borderRaw: rest.borderColor,
        borderWidth: rest.borderWidth,
        t1Rest: r2(t1Rest),
        t1Hover: r2(t1Hover),
        hoverFill: hover ? hex(hover.fillL) : null,
        hoverLabel: hover ? hex(over(hover.color, hover.fillL)) : null,
        fillVsSurface: r2(fillVsSurface),
        borderVsSurface: r2(borderVsSurface),
        borderDirection: border ? (borderDir ? "ok" : "WRONG") : "n/a",
        b1,
        b1Via,
        focusReached: reached,
        focusVisible: focus?.focusVisible ?? false,
        ring: fr?.ring ? `${fr.kind ?? "ring"} ${hex(fr.ring)} (${r2(fr.ringC)}:1, ${fr.width}px)` : null,
        ringOffset: fr?.offset ? `${hex(fr.offset)} (${r2(fr.offsetC)}:1)` : null,
        f1RingC: r2(fr?.ringC ?? 0),
        f1Dir,
        f1,
        _rest: rest,
    };
}

function writeRow(row) {
    const key = `${row.group}__${row.subject}__${row.theme}__${row.palette}`.replace(/[^\w.-]+/g, "_");
    writeFileSync(path.join(ROWS_DIR, `${key}.json`), JSON.stringify(row, null, 2));
}

const strip = ({ _rest, ...o }) => o;

test.beforeAll(() => {
    // Fresh rows each run so the report never mixes runs.
    if (test.info().workerIndex === 0) {
        for (const f of readdirSync(ROWS_DIR)) if (f.endsWith(".json")) rmSync(path.join(ROWS_DIR, f));
    }
});

test.afterAll(() => {
    const rows = readdirSync(ROWS_DIR)
        .filter((f) => f.endsWith(".json"))
        .map((f) => JSON.parse(readFileSync(path.join(ROWS_DIR, f), "utf8")))
        .sort((a, b) => `${a.group}${a.subject}${a.theme}${a.palette}`.localeCompare(`${b.group}${b.subject}${b.theme}${b.palette}`));
    writeFileSync(
        REPORT,
        JSON.stringify(
            {
                generatedAt: new Date().toISOString(),
                rules: {
                    T1: "WCAG 1.4.3 enabled label vs fill >= 4.5:1 at rest and hover",
                    B1: "WCAG 1.4.11 boundary: ghost/outline/detail border >= 3:1 (light ghost/detail >= 1.4:1) + owner direction; link underline >= 3:1; filled: fill >= 3:1 OR border >= 3:1 + direction",
                    F1: "keyboard focus ring >= 3:1 vs surface + owner direction (dark lighter / light darker)",
                    D1: "enabled label >= 4.5:1 AND rendered enabled vs disabled label >= 1.5:1",
                    I1: "tile fill or tile border >= 3:1 vs surface",
                    I2: "icon glyph vs tile fill >= 3:1",
                    I3: "owner direction on the tile boundary (non-semantic tiles asserted)",
                },
                rows,
            },
            null,
            2,
        ),
    );
});

// ─── Harness: every Button variant x theme x palette ──────────────────────

test.describe("buttons", () => {
    for (const variant of VARIANTS) {
        for (const theme of THEMES) {
            for (const palette of PALETTES) {
                test(`button: ${variant} | ${theme} | ${palette}`, async ({ page }) => {
                    await primeTheme(page, theme, palette);
                    await page.goto(`${HARNESS}?mode=button&v=${variant}`, { waitUntil: "domcontentloaded" });
                    await page.locator('[data-testid="btn-md"]').waitFor();
                    await freezeTransitions(page);
                    await page.waitForTimeout(150);
                    expect(await page.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBe(theme);

                    const md = await measureButton(page, '[data-testid="btn-md"]', { theme, kind: variant });
                    expect(md.error, md.error).toBeUndefined();

                    // Other sizes: rest label contrast only (colours are size-independent; verified, not assumed).
                    await page.mouse.move(1, 1);
                    const sizes = {};
                    for (const s of ["xs", "sm", "lg", "xl"]) {
                        const snap = await snapshot(page, `[data-testid="btn-${s}"]`);
                        sizes[s] = r2(labelContrast(snap));
                    }

                    // Disabled + loading
                    await page.mouse.move(1, 1);
                    const dis = await snapshot(page, '[data-testid="btn-disabled"]');
                    const load = await snapshot(page, '[data-testid="btn-loading"]');
                    const enabledLabel = md._rest.labelCore;
                    const disabledLabel = dis.labelCore;
                    const d1Diff = enabledLabel && disabledLabel ? contrast(enabledLabel, disabledLabel) : 0;
                    const sameExceptOpacity =
                        JSON.stringify(dis.color) === JSON.stringify(md._rest.color) &&
                        JSON.stringify(dis.bg) === JSON.stringify(md._rest.bg) &&
                        JSON.stringify(dis.borderColor) === JSON.stringify(md._rest.borderColor) &&
                        dis.opacity !== md._rest.opacity;
                    const disabledMechanism = `${sameExceptOpacity ? "opacity-only" : "opacity+colour"} (opacity ${dis.opacity}${dis.filter && dis.filter !== "none" ? `, filter ${dis.filter}` : ""}, cursor ${dis.cursor})`;
                    const d1 = md.t1Rest >= TEXT_MIN && d1Diff >= D1_DIFF_MIN;

                    await page.mouse.move(1, 1);
                    await page.evaluate(() => document.activeElement?.blur?.());
                    const shot = path.join(ARTIFACTS, `button-${variant}-${theme}-${palette}.png`);
                    await page.locator('[data-testid="mount"]').screenshot({ path: shot });

                    const pass = md.t1Rest >= TEXT_MIN && md.t1Hover >= TEXT_MIN && md.b1 && md.f1 && d1;
                    writeRow({
                        group: "button",
                        subject: variant,
                        theme,
                        palette,
                        ...strip(md),
                        t1Sizes: sizes,
                        disabled: {
                            attr: dis.disabledAttr,
                            labelCore: hex(disabledLabel),
                            fill: hex(dis.fillL),
                            labelVsFill: r2(disabledLabel && dis.fillL ? contrast(disabledLabel, dis.fillL) : null),
                            mechanism: disabledMechanism,
                        },
                        loading: { attr: load.disabledAttr, opacity: load.opacity },
                        d1EnabledVsDisabled: r2(d1Diff),
                        d1,
                        screenshot: path.relative(path.join(HERE, ".."), shot).replaceAll("\\", "/"),
                        result: pass ? "PASS" : "FAIL",
                    });

                    const ctx = `${variant} | ${theme} | ${palette}`;
                    expect.soft(md.t1Rest, `${ctx}: T1 rest label ${md.labelColor} on ${md.fill} = ${md.t1Rest}:1 (< 4.5)`).toBeGreaterThanOrEqual(TEXT_MIN);
                    expect.soft(md.t1Hover, `${ctx}: T1 hover label ${md.hoverLabel} on ${md.hoverFill} = ${md.t1Hover}:1 (< 4.5)`).toBeGreaterThanOrEqual(TEXT_MIN);
                    for (const [s, c] of Object.entries(sizes)) expect.soft(c, `${ctx}: T1 rest size ${s} = ${c}:1`).toBeGreaterThanOrEqual(TEXT_MIN);
                    expect.soft(md.b1, `${ctx}: B1 boundary — ${md.b1Via}; fill ${md.fill} vs surface ${md.surface} = ${md.fillVsSurface}:1, border ${md.border} = ${md.borderVsSurface}:1 dir ${md.borderDirection}`).toBe(true);
                    expect.soft(md.focusReached, `${ctx}: not reachable by keyboard`).toBe(true);
                    expect.soft(md.f1, `${ctx}: F1 focus ring ${md.ring} vs surface ${md.surface}, direction ${md.f1Dir ? "ok" : "WRONG"}`).toBe(true);
                    expect.soft(d1, `${ctx}: D1 enabled label ${md.t1Rest}:1, enabled-vs-disabled label ${r2(d1Diff)}:1 (need >= 1.5)`).toBe(true);
                    expect.soft(load.disabledAttr, `${ctx}: loading instance must be disabled`).toBe(true);
                });
            }
        }
    }

    // Real DetailButton ("View Details") in the harness surface — see page check too.
});

// ─── Icon tiles (harness) ─────────────────────────────────────────────────

const TILE_KEYS = ["header", "orange", "blue", "green", "purple", "red", "amber", "grey"];
const SEMANTIC_TILES = new Set(["green", "red", "amber"]);

async function measureTile(page, sel, theme) {
    const s = await snapshot(page, sel);
    if (s.error) return { error: s.error };
    const surface = s.surface;
    // Tile fill: pixel just inside the left border (glyph is centred).
    const fill = s.fillL;
    const fillVsSurface = contrast(fill, surface);
    const border = borderRgb(s);
    const borderVsSurface = border ? contrast(border, surface) : 0;
    let via = null;
    const borderMin = theme === "light" && s.className.includes("--tile-border") ? SOFT_BORDER_LIGHT_MIN : NONTEXT_MIN;
    if (fillVsSurface >= NONTEXT_MIN) via = "fill";
    else if (borderVsSurface >= borderMin) via = "border";
    const carrier = via === "fill" ? fill : via === "border" ? border : borderVsSurface >= fillVsSurface ? border : fill;
    const i3 = carrier ? dirOk(theme, carrier, surface) : false;
    const glyph = s.iconColor ? over(s.iconColor, fill) : null;
    const i2c = glyph ? contrast(glyph, fill) : 0;
    return {
        className: s.className,
        surface: hex(surface),
        fill: hex(fill),
        border: hex(border),
        borderRaw: s.borderColor,
        glyph: hex(glyph),
        fillVsSurface: r2(fillVsSurface),
        borderVsSurface: r2(borderVsSurface),
        i1: !!via,
        i1Via: via ?? `none (fill ${r2(fillVsSurface)}:1, border ${r2(borderVsSurface)}:1)`,
        i2: i2c >= NONTEXT_MIN,
        i2c: r2(i2c),
        i3,
        i3Note: carrier ? `${via ?? "best"} L=${luminance(carrier).toFixed(3)} vs surface L=${luminance(surface).toFixed(3)}` : "no carrier",
    };
}

test.describe("icon tiles", () => {
    for (const theme of THEMES) {
        for (const palette of PALETTES) {
            test(`icon tiles: harness | ${theme} | ${palette}`, async ({ page }) => {
                await primeTheme(page, theme, palette);
                await page.goto(`${HARNESS}?mode=tiles`, { waitUntil: "domcontentloaded" });
                await page.locator('[data-testid="tile-header"]').waitFor();
                await freezeTransitions(page);
                await page.waitForTimeout(150);
                expect(await page.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBe(theme);

                const shot = path.join(ARTIFACTS, `icontile-harness-${theme}-${palette}.png`);
                await page.locator('[data-testid="mount"]').screenshot({ path: shot });

                for (const key of TILE_KEYS) {
                    const t = await measureTile(page, `[data-testid="tile-${key}"]`, theme);
                    expect(t.error, t.error).toBeUndefined();
                    const semantic = SEMANTIC_TILES.has(key);
                    const pass = t.i1 && t.i2 && (semantic || t.i3);
                    writeRow({ group: "icontile", subject: key, theme, palette, semantic, ...t, screenshot: path.relative(path.join(HERE, ".."), shot).replaceAll("\\", "/"), result: pass ? "PASS" : "FAIL" });
                    const ctx = `tile ${key} | ${theme} | ${palette}`;
                    expect.soft(t.i1, `${ctx}: I1 boundary — ${t.i1Via}; fill ${t.fill} border ${t.border} surface ${t.surface}`).toBe(true);
                    expect.soft(t.i2, `${ctx}: I2 glyph ${t.glyph} vs fill ${t.fill} = ${t.i2c}:1`).toBe(true);
                    if (!semantic) expect.soft(t.i3, `${ctx}: I3 owner direction — ${t.i3Note}`).toBe(true);
                }
            });
        }
    }
});
