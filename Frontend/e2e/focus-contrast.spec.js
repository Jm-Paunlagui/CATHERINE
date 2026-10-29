/**
 * focus-contrast.spec.js — PROVES, in a real Chromium, whether the keyboard
 * focus state of every form control in src/components/forms/ (plus the real
 * Login page inputs) is visible in BOTH light and dark themes, across every
 * named Personalize palette.
 *
 * These tests assert the CORRECT behaviour. A red run is the evidence.
 *
 * ── Rules asserted (per component x theme x palette) ──────────────────────
 *  R1  WCAG 2.2 SC 1.4.11 Non-text Contrast: at least one focus indicator
 *      that APPEARS/CHANGES on focus reaches >= 3:1 against its adjacent
 *      colours.
 *        border  -> min(contrast vs outer surface, contrast vs control fill)
 *        ring    -> box-shadow ring (0 0 0 Npx) composited over the outer
 *                   surface, contrast vs outer surface
 *        outline -> outline colour vs outer surface. Chromium's `auto`
 *                   outline is a two-tone ring, so it is measured from real
 *                   rendered pixels instead of computed style.
 *  R2  Change of state (owner + WCAG 2.4.13-style): focused border vs
 *      unfocused border >= 3:1, OR an added ring/outline that itself meets
 *      3:1 against the outer surface ("clearly added ring").
 *  R0  Resting (unfocused) border: >= 3:1 (dark) / >= 1.4:1 (light, owner soft
 *      border) against BOTH the outer surface and
 *      the control fill (WCAG 1.4.11; added by owner after a report that the
 *      resting Login input border vanished in dark mode). Only evaluated when
 *      the measured element has a border; border-less controls (toggle, range)
 *      report r0 = "n/a".
 *  R3  Owner direction rule: the focused border (or, if the border does not
 *      change, the dominant added indicator) must be LIGHTER than the
 *      surface behind it in dark mode and DARKER in light mode
 *      (relative luminance compared).
 *
 * ── How colours are obtained ─────────────────────────────────────────────
 *  - border / box-shadow / outline colours: getComputedStyle, then resolved
 *    to sRGB by painting the computed string into a 1x1 canvas (handles
 *    oklab()/oklch()/color-mix() that Tailwind v4 emits for `/30` opacity).
 *  - outer surface: composite of the element stack under a point 6px outside
 *    the control (document.elementsFromPoint, alpha-composited bottom-up). If
 *    the stack contains an image or backdrop-filter (Login page), the
 *    computed composite is not trustworthy, so the rendered pixel at that
 *    point (unfocused screenshot) is used instead. Both are reported.
 *  - control fill: rendered pixel just inside the border (unfocused).
 *  - Relative luminance + contrast ratio per WCAG 2.x.
 *
 * ── Theme / palette switching ────────────────────────────────────────────
 *  The app does NOT use a `dark` class. ThemeProvider
 *  (src/contexts/theme/ThemeContext.jsx) reads localStorage
 *  `aumovio-personalize` = { mode, transparency, palette, customColor } and
 *  sets <html data-theme="light|dark">; Tailwind's dark variant is
 *  `[data-theme=dark]` (src/assets/styles/index.css @variant dark). Palettes
 *  are applied by applyPaletteVars() as inline CSS vars on <html>. We write
 *  that key via addInitScript before load AND emulate prefers-color-scheme,
 *  then assert data-theme actually matches.
 *
 * ── Mounting ─────────────────────────────────────────────────────────────
 *  No showcase route exists in the app. Components are mounted by a
 *  test-only Vite entry, e2e/fixtures/focus-harness.html, served by the
 *  normal dev server (never routed, never built). It mounts ONE control
 *  inside the real ThemeProvider and a real <Card>. The Login page is tested
 *  at its real route (/auth) with the CSRF bootstrap stubbed via page.route
 *  (no backend needed).
 *
 * ── Focus method ─────────────────────────────────────────────────────────
 *  Always KEYBOARD: page.keyboard.press("Tab") until the target is the
 *  activeElement (WCAG 2.4.7). Never click.
 *
 * ── Exemptions (owner decision) ──────────────────────────────────────────
 *  Inputs inside `.ai-ring-focus` (animated comet ring, index.css ~1935-1943)
 *  keep their current focus behaviour. They are MEASURED and REPORTED as
 *  "EXEMPT (owner)" but not asserted.
 *
 * Output: e2e/artifacts/focus-contrast-report.json + one focused-state
 * screenshot per case in e2e/artifacts/.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { PALETTES as ALL_PALETTES } from "../src/features/personalize/personalize.palettes.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = path.join(HERE, "artifacts");
const ROWS_DIR = path.join(ARTIFACTS, "focus-rows");
const REPORT = path.join(ARTIFACTS, "focus-contrast-report.json");
mkdirSync(ROWS_DIR, { recursive: true });

const HARNESS = "/e2e/fixtures/focus-harness.html";
const MIN_CONTRAST = 3;
// Design decision: light resting border is the soft grey-300 shared by every control.
const MIN_REST_LIGHT = 1.4;

const THEMES = ["light", "dark"];
// Every named Personalize palette; PALETTES=id1,id2 narrows a local run.
const PALETTES = process.env.PALETTES ? process.env.PALETTES.split(",") : ALL_PALETTES.filter((p) => p.colors).map((p) => p.id);

/**
 * target  — selector (inside [data-testid=mount]) that must receive keyboard focus
 * measure — which element carries the visual indicator:
 *           self | parent | next (nextElementSibling)
 */
const COMPONENTS = [
    { id: "input", file: "Input.jsx", target: "input", measure: "self" },
    { id: "floating-label", file: "FloatingLabel.jsx", target: "input", measure: "self" },
    { id: "textarea", file: "Textarea.jsx", target: "textarea", measure: "self" },
    { id: "number-input", file: "NumberInput.jsx", target: 'input[type="number"]', measure: "parent" },
    { id: "phone-input", file: "PhoneInput.jsx", target: 'input[type="tel"]', measure: "parent" },
    { id: "search-input", file: "SearchInput.jsx", target: 'input[type="search"]', measure: "self" },
    { id: "select", file: "Select.jsx", target: "button[id]", measure: "self" },
    { id: "timepicker", file: "Timepicker.jsx", target: "button[aria-haspopup]", measure: "self" },
    { id: "checkbox", file: "Checkbox.jsx", target: 'input[type="checkbox"]', measure: "next" },
    { id: "radio", file: "Radio.jsx", target: 'input[type="radio"]', measure: "next" },
    { id: "toggle", file: "Toggle.jsx", target: 'button[role="switch"]', measure: "self" },
    { id: "range", file: "Range.jsx", target: 'input[type="range"]', measure: "self" },
    { id: "file-input", file: "FileInput.jsx", target: 'input[type="file"]', measure: "parent" },
];

// ─── WCAG colour math (node side) ─────────────────────────────────────────

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
/** Composite rgba [r,g,b,a(0..1)] over opaque rgb. */
function over([r, g, b, a], [br, bg, bb]) {
    return [Math.round(r * a + br * (1 - a)), Math.round(g * a + bg * (1 - a)), Math.round(b * a + bb * (1 - a))];
}
const hex = (c) => (c ? "#" + c.slice(0, 3).map((v) => v.toString(16).padStart(2, "0")).join("") : null);
const hexa = (c) => (c ? `${hex(c)}${c[3] !== undefined && c[3] < 1 ? `@${c[3].toFixed(2)}` : ""}` : null);
const r2 = (n) => (n === null || n === undefined ? null : Math.round(n * 100) / 100);
const sameColor = (a, b) => !!a && !!b && a.every((v, i) => Math.abs(v - b[i]) < (i === 3 ? 0.02 : 2));

// ─── In-page probes ───────────────────────────────────────────────────────

/**
 * Runs in the page. Resolves the target + measure element and returns the
 * computed indicator styles (colours resolved to sRGB rgba via canvas) and a
 * computed composite of the background stack just outside the control.
 */
function probe({ scope, target, measure }) {
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
            const colorMatch = part.match(/(rgba?|oklab|oklch|lab|lch|color|hsla?|hwb)\([^)]*\)|#[0-9a-f]{3,8}\b|\btransparent\b/i);
            const color = colorMatch ? colorMatch[0] : "rgba(0,0,0,1)";
            const rest = part.replace(color, "");
            const nums = (rest.match(/-?[\d.]+px/g) || []).map(parseFloat);
            const [x = 0, y = 0, blur = 0, spread = 0] = nums;
            return { raw: part, color: toRgba(color), x, y, blur, spread, inset: /\binset\b/.test(part) };
        });
    };

    const root = document.querySelector(scope);
    const tgt = root?.querySelector(target);
    if (!tgt) return { error: `target not found: ${scope} ${target}` };
    const el = measure === "parent" ? tgt.parentElement : measure === "next" ? tgt.nextElementSibling : tgt;
    const cs = getComputedStyle(el);
    const ts = getComputedStyle(tgt);
    const rect = el.getBoundingClientRect();
    const trect = tgt.getBoundingClientRect();

    // Computed composite of whatever sits under a point 6px left of the control.
    const ox = rect.left - 6;
    const oy = rect.top + rect.height / 2;
    const stack = document.elementsFromPoint(ox, oy).filter((n) => n !== el && !el.contains(n));
    const layers = [];
    let unresolved = null;
    for (const n of stack) {
        const ns = getComputedStyle(n);
        if (n.tagName === "IMG" || n.tagName === "VIDEO" || n.tagName === "CANVAS") {
            unresolved = `${n.tagName.toLowerCase()} in stack`;
            break;
        }
        if (ns.backgroundImage && ns.backgroundImage !== "none") {
            unresolved = "background-image in stack";
            break;
        }
        if (ns.backdropFilter && ns.backdropFilter !== "none") unresolved = unresolved ?? "backdrop-filter in stack";
        const c = toRgba(ns.backgroundColor);
        if (c[3] > 0) layers.push({ c, tag: n.tagName.toLowerCase(), cls: (n.className?.toString?.() ?? "").slice(0, 80) });
        if (c[3] >= 1) break;
    }
    let outerComputed = null;
    if (!unresolved && !(layers.length && layers[layers.length - 1].c[3] >= 1)) unresolved = "no opaque layer in stack";
    if (!unresolved) {
        const work = layers.map((l) => l.c);
        outerComputed = work.pop().slice(0, 3);
        for (let i = work.length - 1; i >= 0; i--) {
            const [r, g, b, a] = work[i];
            outerComputed = [r * a + outerComputed[0] * (1 - a), g * a + outerComputed[1] * (1 - a), b * a + outerComputed[2] * (1 - a)].map(Math.round);
        }
    }

    return {
        tag: el.tagName.toLowerCase(),
        targetTag: tgt.tagName.toLowerCase(),
        isFocused: document.activeElement === tgt,
        focusVisible: tgt.matches(":focus-visible"),
        insideAiRingFocus: !!tgt.closest(".ai-ring-focus"),
        rect: { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
        targetRect: { x: trect.left, y: trect.top, w: trect.width, h: trect.height },
        borderWidth: parseFloat(cs.borderLeftWidth) || 0,
        borderStyle: cs.borderLeftStyle,
        borderColor: toRgba(cs.borderLeftColor),
        borderColorRaw: cs.borderLeftColor,
        bgColor: toRgba(cs.backgroundColor),
        shadows: parseShadows(cs.boxShadow),
        boxShadowRaw: cs.boxShadow,
        // outline lives on the FOCUSED element (target), which may be sr-only
        outline: { style: ts.outlineStyle, width: parseFloat(ts.outlineWidth) || 0, color: toRgba(ts.outlineColor), raw: ts.outlineColor, offset: parseFloat(ts.outlineOffset) || 0 },
        outerComputed,
        outerUnresolved: unresolved,
        outerStack: layers.map((l) => `${l.tag}(${l.c.join(",")})`).slice(0, 5),
        dataTheme: document.documentElement.getAttribute("data-theme"),
    };
}

/** Decode a PNG screenshot in-page and read rgb at the given viewport points. */
async function samplePixels(page, png, points) {
    return page.evaluate(
        async ({ b64, pts }) => {
            const img = new Image();
            img.src = "data:image/png;base64," + b64;
            await img.decode();
            const c = document.createElement("canvas");
            c.width = img.width;
            c.height = img.height;
            const ctx = c.getContext("2d", { willReadFrequently: true });
            ctx.drawImage(img, 0, 0);
            return pts.map(([x, y]) => {
                const xi = Math.round(x);
                const yi = Math.round(y);
                if (xi < 0 || yi < 0 || xi >= c.width || yi >= c.height) return null;
                const d = ctx.getImageData(xi, yi, 1, 1).data;
                return [d[0], d[1], d[2]];
            });
        },
        { b64: png.toString("base64"), pts: points },
    );
}

/** Perimeter sample points (border line + 4px band outside it) for rendered-change measurement. */
function perimeterPoints({ x, y, w, h }) {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const pts = [];
    for (let d = -4; d <= 0; d++) {
        pts.push([x + d + 0.5, cy], [x + w - 0.5 - d, cy], [cx, y + d + 0.5], [cx, y + h - 0.5 - d]);
    }
    return pts;
}

// ─── Page setup ───────────────────────────────────────────────────────────

async function primeTheme(page, theme, palette) {
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript(
        ({ mode, pal }) => {
            localStorage.setItem("aumovio-personalize", JSON.stringify({ mode, transparency: true, palette: pal, customColor: null }));
            localStorage.setItem("aumovio-theme", mode);
        },
        { mode: theme, pal: palette },
    );
}

async function freezeTransitions(page) {
    // Colour transitions (transition-colors-fast / transition-all) would let us
    // sample mid-tween. Kill transitions only; final colours are identical.
    await page.addStyleTag({ content: "*,*::before,*::after{transition:none!important}" });
}

/** Press Tab until the target is document.activeElement. Returns press count or -1. */
async function tabTo(page, scope, target, maxPresses = 25) {
    await page.evaluate(() => document.activeElement?.blur?.());
    for (let i = 1; i <= maxPresses; i++) {
        await page.keyboard.press("Tab");
        const hit = await page.evaluate(({ s, t }) => {
            const el = document.querySelector(s)?.querySelector(t);
            return !!el && document.activeElement === el;
        }, { s: scope, t: target });
        if (hit) return i;
    }
    return -1;
}

// ─── Evaluation ───────────────────────────────────────────────────────────

function evaluateCase({ theme, rest, focus, outerBg, innerBg, pxRest, pxFocus }) {
    const notes = [];
    const indicators = [];

    // Border
    const borderOf = (m) => (m.borderWidth > 0 && m.borderStyle !== "none" && m.borderColor[3] > 0 ? over(m.borderColor, innerBg) : null);
    const bRest = borderOf(rest);
    const bFocus = borderOf(focus);
    const borderChanged = !!bFocus && (!bRest || contrast(bFocus, bRest) > 1.05 || !sameColor(rest.borderColor, focus.borderColor));
    if (borderChanged) {
        const vsOuter = contrast(bFocus, outerBg);
        const vsInner = contrast(bFocus, innerBg);
        indicators.push({ kind: "border", color: bFocus, c311: Math.min(vsOuter, vsInner), vsOuter, vsInner, change: bRest ? contrast(bFocus, bRest) : vsOuter });
    }

    // Ring (Tailwind ring-* = 0 0 0 Npx box-shadow)
    const rings = (m) => m.shadows.filter((s) => !s.inset && s.x === 0 && s.y === 0 && s.blur === 0 && s.spread > 0 && s.color[3] > 0).sort((a, b) => b.spread - a.spread);
    const rf = rings(focus);
    const rr = rings(rest);
    const ring = rf[0] ?? null;
    const ringOffset = rf[1] ?? null;
    const ringAdded = !!ring && !rr.some((r) => r.spread === ring.spread && sameColor(r.color, ring.color));
    let ringRgb = null;
    if (ring) {
        ringRgb = over(ring.color, outerBg);
        const visibleWidth = ring.spread - (ringOffset?.spread ?? 0);
        if (ringAdded && visibleWidth >= 1) {
            const c = contrast(ringRgb, outerBg);
            indicators.push({ kind: "ring", color: ringRgb, c311: c, vsOuter: c, change: c, width: visibleWidth });
        }
        if (ringOffset) {
            // Tailwind ring-offset-* paints a solid gap ring (default #fff)
            // between the control and the ring. In dark mode that gap is a
            // bright halo and IS the visible indicator, so it counts.
            const offRgb = over(ringOffset.color, outerBg);
            const c = contrast(offRgb, outerBg);
            notes.push(`ring-offset ${hexa(ringOffset.color)} ${ringOffset.spread}px (${r2(c)}:1 vs surface)`);
            if (ringAdded) indicators.push({ kind: "ring-offset", color: offRgb, c311: c, vsOuter: c, change: c, width: ringOffset.spread });
        }
    }

    // Outline (on the focused element; invisible if that element is sr-only)
    const tVisible = focus.targetRect.w > 2 && focus.targetRect.h > 2;
    if (!tVisible) notes.push(`keyboard focus lands on a visually hidden (sr-only, ${focus.targetRect.w}x${focus.targetRect.h}px) element`);
    const outlineOn = (m) => m.outline.style !== "none" && m.outline.width > 0;
    if (outlineOn(focus) && !outlineOn(rest)) {
        if (!tVisible) notes.push("outline on sr-only element (invisible)");
        else if (focus.outline.style === "auto") {
            // Chromium draws a two-tone ring; measure what was actually painted.
            const best = Math.max(...pxFocus.filter(Boolean).map((p) => contrast(p, outerBg)));
            const chg = Math.max(...pxFocus.map((p, i) => (p && pxRest[i] ? contrast(p, pxRest[i]) : 1)));
            indicators.push({ kind: "outline(auto,px)", color: null, c311: best, vsOuter: best, change: chg });
        } else {
            const oc = over(focus.outline.color, outerBg);
            const c = contrast(oc, outerBg);
            indicators.push({ kind: "outline", color: oc, c311: c, vsOuter: c, change: c });
        }
    }

    const pxChange = Math.max(1, ...pxFocus.map((p, i) => (p && pxRest[i] ? contrast(p, pxRest[i]) : 1)));

    const best311 = indicators.length ? Math.max(...indicators.map((i) => i.c311)) : 0;
    const bestChange = indicators.length ? Math.max(...indicators.map((i) => i.change)) : 0;
    const dominant = indicators.find((i) => i.kind === "border") ?? [...indicators].sort((a, b) => b.c311 - a.c311)[0] ?? null;

    let direction = false;
    let directionNote = "no indicator";
    if (dominant?.color) {
        const li = luminance(dominant.color);
        const lb = luminance(outerBg);
        direction = theme === "dark" ? li > lb : li < lb;
        directionNote = `${dominant.kind} L=${li.toFixed(3)} vs surface L=${lb.toFixed(3)}`;
    } else if (dominant) {
        // auto outline: dual-tone, direction satisfied by construction if it passes contrast
        direction = dominant.c311 >= MIN_CONTRAST;
        directionNote = `${dominant.kind}: UA dual-tone ring`;
    }

    return {
        indicators,
        bRest,
        bFocus,
        ring,
        ringRgb,
        pxChange,
        r1: best311 >= MIN_CONTRAST,
        r2: bestChange >= MIN_CONTRAST,
        r3: direction,
        best311,
        bestChange,
        dominant,
        directionNote,
        notes,
    };
}

function writeRow(row) {
    const key = `${row.component}__${row.theme}__${row.palette}`.replace(/[^\w.-]+/g, "_");
    writeFileSync(path.join(ROWS_DIR, `${key}.json`), JSON.stringify(row, null, 2));
}

test.afterAll(() => {
    const rows = readdirSync(ROWS_DIR)
        .filter((f) => f.endsWith(".json"))
        .map((f) => JSON.parse(readFileSync(path.join(ROWS_DIR, f), "utf8")))
        .sort((a, b) => `${a.component}${a.theme}${a.palette}`.localeCompare(`${b.component}${b.theme}${b.palette}`));
    writeFileSync(
        REPORT,
        JSON.stringify(
            {
                generatedAt: new Date().toISOString(),
                rules: {
                    R0: "resting border >= 3:1 (dark) / >= 1.4:1 (light) vs surface and fill (n/a when no border)",
                    R1: "WCAG 2.2 SC 1.4.11: changed focus indicator >= 3:1 vs adjacent colours",
                    R2: "focused vs unfocused border >= 3:1, or an added ring/outline >= 3:1 vs surface",
                    R3: "owner direction: dark -> indicator lighter than surface; light -> darker",
                },
                rows,
            },
            null,
            2,
        ),
    );
    console.table(
        rows.map((r) => ({
            component: r.component,
            theme: r.theme,
            palette: r.palette,
            focus: r.focusMethod,
            unfocBorder: r.unfocusedBorder,
            focBorder: r.focusedBorder,
            ring: r.ring,
            surface: r.outerBg,
            fill: r.innerBg,
            r0: r.r0Ratio,
            "1.4.11": r.contrast.best311,
            change: r.contrast.bestChange,
            pxChg: r.contrast.renderedChange,
            dir: r.r3 ? "ok" : "BAD",
            result: r.result,
        })),
    );
});

// ─── Core runner ──────────────────────────────────────────────────────────

async function runCase(page, { component, file, theme, palette, scope, target, measure, screenshotName, exempt }) {
    const rest = await page.evaluate(probe, { scope, target, measure });
    expect(rest.error, rest.error).toBeUndefined();
    expect(rest.dataTheme, "ThemeProvider did not apply requested theme").toBe(theme);

    const restPng = await page.screenshot();
    const { x, y, w, h } = rest.rect;
    const perim = perimeterPoints(rest.rect);
    const [outerPx, innerPx, ...pxRest] = await samplePixels(page, restPng, [
        [x - 6, y + h / 2],
        [x + Math.max(rest.borderWidth, 0) + 3, y + h / 2],
        ...perim,
    ]);

    const presses = await tabTo(page, scope, target);
    const reachable = presses > 0;
    await page.waitForTimeout(120);

    const focus = await page.evaluate(probe, { scope, target, measure });
    const focusPng = await page.screenshot();
    const pxFocus = await samplePixels(page, focusPng, perim);

    const shotPath = path.join(ARTIFACTS, screenshotName);
    await page.screenshot({ path: shotPath, clip: { x: Math.max(0, x - 24), y: Math.max(0, y - 24), width: w + 48, height: h + 48 } });

    const outerBg = rest.outerComputed ?? outerPx;
    const outerSource = rest.outerComputed ? "computed" : `pixel (${rest.outerUnresolved})`;
    const innerBg = innerPx ?? outerBg;
    const ev = evaluateCase({ theme, rest, focus, outerBg, innerBg, pxRest, pxFocus });

    const isExempt = exempt || focus.insideAiRingFocus;
    const restBorder = rest.borderWidth > 0 && rest.borderStyle !== "none" && rest.borderColor[3] > 0 ? over(rest.borderColor, innerBg) : null;
    const r0Ratio = restBorder ? Math.min(contrast(restBorder, outerBg), contrast(restBorder, innerBg)) : null;
    const r0Min = theme === "light" ? MIN_REST_LIGHT : MIN_CONTRAST;
    const r0 = r0Ratio === null ? true : r0Ratio >= r0Min;
    const pass = reachable && r0 && ev.r1 && ev.r2 && ev.r3;
    const row = {
        component,
        file,
        theme,
        palette,
        focusMethod: reachable ? `keyboard Tab x${presses}` : "keyboard Tab: NOT REACHED",
        focusVisible: focus.focusVisible,
        measuredElement: `${focus.tag}${measure === "self" ? "" : ` (${measure} of ${focus.targetTag})`}`,
        unfocusedBorder: hexa(rest.borderWidth > 0 ? rest.borderColor : null),
        focusedBorder: hexa(focus.borderWidth > 0 ? focus.borderColor : null),
        borderWidthPx: focus.borderWidth,
        ring: ev.ring ? `${hexa(ev.ring.color)} ${ev.ring.spread}px -> ${hex(ev.ringRgb)}` : null,
        outline: focus.outline.style !== "none" && focus.outline.width > 0 ? `${focus.outline.style} ${focus.outline.width}px ${focus.outline.raw}` : null,
        outerBg: hex(outerBg),
        outerBgSource: outerSource,
        outerBgPixel: hex(outerPx),
        innerBg: hex(innerBg),
        indicators: ev.indicators.map((i) => ({ kind: i.kind, color: hex(i.color), c311: r2(i.c311), vsOuter: r2(i.vsOuter), vsInner: r2(i.vsInner), change: r2(i.change) })),
        contrast: { best311: r2(ev.best311), bestChange: r2(ev.bestChange), renderedChange: r2(ev.pxChange) },
        direction: ev.directionNote,
        r0: r0Ratio === null ? "n/a (no border)" : r0,
        r0Ratio: r2(r0Ratio),
        r1: ev.r1,
        r2: ev.r2,
        r3: ev.r3,
        reachable,
        notes: ev.notes,
        boxShadowFocused: focus.boxShadowRaw,
        screenshot: path.relative(path.join(HERE, ".."), shotPath).replaceAll("\\", "/"),
        result: isExempt ? "EXEMPT (owner)" : pass ? "PASS" : "FAIL",
    };
    writeRow(row);

    if (isExempt) {
        test.info().annotations.push({ type: "exempt", description: "inside .ai-ring-focus — owner keeps current focus behaviour" });
        return;
    }

    const ctx = `${component} | ${theme} | ${palette}`;
    expect.soft(reachable, `${ctx}: control is not reachable with the Tab key (WCAG 2.1.1 / 2.4.7)`).toBe(true);
    if (r0Ratio !== null) expect.soft(r0Ratio, `${ctx}: R0 resting border ${r2(r0Ratio)}:1 (< ${r0Min}:1) vs surface ${row.outerBg} / fill ${row.innerBg}; border ${row.unfocusedBorder}`).toBeGreaterThanOrEqual(r0Min);
    expect.soft(ev.best311, `${ctx}: R1 WCAG 1.4.11 — best changed focus indicator contrast ${r2(ev.best311)}:1 (< 3:1). Indicators: ${JSON.stringify(row.indicators)} surface ${row.outerBg} fill ${row.innerBg}`).toBeGreaterThanOrEqual(MIN_CONTRAST);
    expect.soft(ev.bestChange, `${ctx}: R2 change-of-state — focused vs rest ${r2(ev.bestChange)}:1 (< 3:1). unfocused border ${row.unfocusedBorder} -> focused ${row.focusedBorder}, ring ${row.ring}`).toBeGreaterThanOrEqual(MIN_CONTRAST);
    expect.soft(ev.r3, `${ctx}: R3 owner direction rule (${theme === "dark" ? "must be LIGHTER than surface" : "must be DARKER than surface"}) — ${ev.directionNote}`).toBe(true);
}

// ─── Tests: every form control x theme x palette (harness) ────────────────

for (const c of COMPONENTS) {
    for (const theme of THEMES) {
        for (const palette of PALETTES) {
            test(`focus contrast: ${c.id} | ${theme} | ${palette}`, async ({ page }) => {
                await primeTheme(page, theme, palette);
                await page.goto(`${HARNESS}?c=${c.id}`, { waitUntil: "domcontentloaded" });
                await page.locator(`[data-testid="mount"] ${c.target}`).first().waitFor({ state: "attached" });
                await freezeTransitions(page);
                await page.waitForTimeout(150);
                await runCase(page, {
                    component: c.id,
                    file: `src/components/forms/${c.file}`,
                    theme,
                    palette,
                    scope: '[data-testid="mount"]',
                    target: c.target,
                    measure: c.measure,
                    screenshotName: `focus-${c.id}-${theme}-${palette}.png`,
                });
            });
        }
    }
}

// ─── Tests: real Login page (/auth), the owner's report ───────────────────

const LOGIN_FIELDS = [
    { id: "login-password", target: 'input[name="password"]' },
    { id: "login-username", target: 'input[name="username"]' },
];

async function stubBackend(page) {
    // CsrfGate blocks render until GET csrf/token succeeds. No backend is
    // needed for a styling assertion, so stub every API call.
    await page.route(/\/csrf\/(token|refresh)/, (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, token: "e2e-focus-token", expiresIn: 3_600_000 }) }),
    );
    await page.route(/\/api\/v1\/(?!csrf\/)/, (route) => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ status: "error", code: 401, message: "unauthenticated" }) }));
}

for (const f of LOGIN_FIELDS) {
    for (const theme of THEMES) {
        for (const palette of PALETTES) {
            test(`focus contrast: ${f.id} | ${theme} | ${palette}`, async ({ page }) => {
                await stubBackend(page);
                await primeTheme(page, theme, palette);
                await page.goto("/auth", { waitUntil: "domcontentloaded" });
                const field = page.locator(f.target);
                await expect(field, "Login form did not render at /auth (CSRF stub or redirect?)").toBeVisible({ timeout: 15_000 });
                await freezeTransitions(page);
                await page.waitForTimeout(1200); // fade-in-up entrance animations settle
                await runCase(page, {
                    component: f.id,
                    file: "src/features/auth/Login.view.jsx -> src/components/forms/Input.jsx",
                    theme,
                    palette,
                    scope: "form",
                    target: f.target,
                    measure: "self",
                    screenshotName: `focus-${f.id}-${theme}-${palette}.png`,
                });
            });
        }
    }
}
