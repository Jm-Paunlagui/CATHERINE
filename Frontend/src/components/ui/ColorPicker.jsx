/**
 * ColorPicker — Aumovio design-system colour picker.
 *
 * A self-contained HSV picker that matches the component library (rounded
 * surfaces, design-token borders, accent focus rings, full dark-mode support).
 * Replaces the bare native `<input type="color">`.
 *
 * Features
 * ────────
 *   • 2-D saturation / value field with a draggable thumb
 *   • Hue slider
 *   • Hex text input (typed values are validated + normalised)
 *   • Live preview swatch
 *   • Optional quick-pick preset swatches
 *   • Pointer drag (with pointer capture) AND keyboard control (arrow keys on
 *     the SV field and hue slider) for accessibility
 *
 * Controlled component — pass `value` (hex) and `onChange(hex)`.
 *
 * Props:
 *   value      — "#rrggbb" current colour
 *   onChange   — (hex: string) => void
 *   presets    — string[] of hex values shown as quick-pick swatches
 *   label      — optional field label
 *   className  — extra classes on the root
 */
import { useCallback, useId, useRef, useState } from "react";

import { TRANSITION_COLORS } from "../../assets/styles/pre-set-styles";

// ── Colour maths (self-contained — no external palette deps) ───────────────────

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

function hexToRgb(hex) {
    const c = hex.replace("#", "");
    return {
        r: parseInt(c.slice(0, 2), 16),
        g: parseInt(c.slice(2, 4), 16),
        b: parseInt(c.slice(4, 6), 16),
    };
}

function rgbToHex(r, g, b) {
    return "#" + [r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0")).join("");
}

/** @returns {{ h:0-360, s:0-1, v:0-1 }} */
function rgbToHsv({ r, g, b }) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d !== 0) {
        switch (max) {
            case r:
                h = ((g - b) / d) % 6;
                break;
            case g:
                h = (b - r) / d + 2;
                break;
            default:
                h = (r - g) / d + 4;
                break;
        }
        h *= 60;
        if (h < 0) h += 360;
    }
    const s = max === 0 ? 0 : d / max;
    return { h, s, v: max };
}

function hsvToRgb(h, s, v) {
    const c = v * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = v - c;
    let r = 0,
        g = 0,
        b = 0;
    if (h < 60) {
        r = c;
        g = x;
        b = 0;
    } else if (h < 120) {
        r = x;
        g = c;
        b = 0;
    } else if (h < 180) {
        r = 0;
        g = c;
        b = x;
    } else if (h < 240) {
        r = 0;
        g = x;
        b = c;
    } else if (h < 300) {
        r = x;
        g = 0;
        b = c;
    } else {
        r = c;
        g = 0;
        b = x;
    }
    return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

/** Accepts "#rgb" / "rgb" / "#rrggbb" / "rrggbb" → "#rrggbb", or null if invalid. */
function normalizeHex(input) {
    if (typeof input !== "string") return null;
    let c = input.trim().replace(/^#/, "").toLowerCase();
    if (/^[0-9a-f]{3}$/.test(c))
        c = c
            .split("")
            .map((ch) => ch + ch)
            .join("");
    if (/^[0-9a-f]{6}$/.test(c)) return `#${c}`;
    return null;
}

const hsvToHex = (h, s, v) => {
    const { r, g, b } = hsvToRgb(h, s, v);
    return rgbToHex(r, g, b);
};

// ── Component ──────────────────────────────────────────────────────────────────

export function ColorPicker({ value, onChange, presets = [], label, className = "" }) {
    const safe = normalizeHex(value) || "#ff4208";
    const [hsv, setHsv] = useState(() => rgbToHsv(hexToRgb(safe)));
    const [hexText, setHexText] = useState(safe);
    const [prevValue, setPrevValue] = useState(value);
    const [lastEmit, setLastEmit] = useState(safe); // guards against re-syncing our own emitted value

    const svRef = useRef(null);
    const hueRef = useRef(null);
    const draggingSv = useRef(false);
    const draggingHue = useRef(false);
    const fieldId = useId();

    // Re-sync internal HSV when the controlled value changes from the outside
    // (e.g. a preset chosen elsewhere). Uses React's "adjust state during render"
    // pattern and skips values we emitted ourselves so dragging never fights with
    // the parent state round-trip.
    if (value !== prevValue) {
        setPrevValue(value);
        const n = normalizeHex(value);
        if (n && n !== lastEmit) {
            setHsv(rgbToHsv(hexToRgb(n)));
            setHexText(n);
        }
    }

    const currentHex = hsvToHex(hsv.h, hsv.s, hsv.v);

    const emit = useCallback(
        (next) => {
            setHsv(next);
            const hex = hsvToHex(next.h, next.s, next.v);
            setLastEmit(hex);
            setHexText(hex);
            onChange?.(hex);
        },
        [onChange],
    );

    // ── Saturation / Value field ──────────────────────────────────────────────
    const applySvFromEvent = useCallback(
        (clientX, clientY) => {
            const el = svRef.current;
            if (!el) return;
            const r = el.getBoundingClientRect();
            const s = clamp((clientX - r.left) / r.width, 0, 1);
            const v = clamp(1 - (clientY - r.top) / r.height, 0, 1);
            emit({ h: hsv.h, s, v });
        },
        [emit, hsv.h],
    );

    const onSvPointerDown = (e) => {
        e.currentTarget.setPointerCapture?.(e.pointerId);
        draggingSv.current = true;
        applySvFromEvent(e.clientX, e.clientY);
    };
    const onSvPointerMove = (e) => {
        if (draggingSv.current) applySvFromEvent(e.clientX, e.clientY);
    };
    const onSvPointerUp = (e) => {
        draggingSv.current = false;
        try {
            e.currentTarget.releasePointerCapture?.(e.pointerId);
        } catch {
            /* noop */
        }
    };
    const onSvKeyDown = (e) => {
        const step = e.shiftKey ? 0.1 : 0.02;
        let { s, v } = hsv;
        if (e.key === "ArrowLeft") s -= step;
        else if (e.key === "ArrowRight") s += step;
        else if (e.key === "ArrowUp") v += step;
        else if (e.key === "ArrowDown") v -= step;
        else return;
        e.preventDefault();
        emit({ h: hsv.h, s: clamp(s, 0, 1), v: clamp(v, 0, 1) });
    };

    // ── Hue slider ────────────────────────────────────────────────────────────
    const applyHueFromEvent = useCallback(
        (clientX) => {
            const el = hueRef.current;
            if (!el) return;
            const r = el.getBoundingClientRect();
            const h = clamp((clientX - r.left) / r.width, 0, 1) * 360;
            emit({ h, s: hsv.s, v: hsv.v });
        },
        [emit, hsv.s, hsv.v],
    );

    const onHuePointerDown = (e) => {
        e.currentTarget.setPointerCapture?.(e.pointerId);
        draggingHue.current = true;
        applyHueFromEvent(e.clientX);
    };
    const onHuePointerMove = (e) => {
        if (draggingHue.current) applyHueFromEvent(e.clientX);
    };
    const onHuePointerUp = (e) => {
        draggingHue.current = false;
        try {
            e.currentTarget.releasePointerCapture?.(e.pointerId);
        } catch {
            /* noop */
        }
    };
    const onHueKeyDown = (e) => {
        const step = e.shiftKey ? 15 : 3;
        let h = hsv.h;
        if (e.key === "ArrowLeft" || e.key === "ArrowDown") h -= step;
        else if (e.key === "ArrowRight" || e.key === "ArrowUp") h += step;
        else return;
        e.preventDefault();
        emit({ h: (h + 360) % 360, s: hsv.s, v: hsv.v });
    };

    // ── Hex input ─────────────────────────────────────────────────────────────
    const onHexChange = (e) => {
        const raw = e.target.value;
        setHexText(raw);
        const n = normalizeHex(raw);
        if (n) {
            setLastEmit(n);
            setHsv(rgbToHsv(hexToRgb(n)));
            onChange?.(n);
        }
    };
    const onHexBlur = () => {
        if (!normalizeHex(hexText)) setHexText(currentHex);
    };

    const hueColor = `hsl(${Math.round(hsv.h)} 100% 50%)`;

    return (
        <div className={`flex flex-col gap-3 ${className}`}>
            {label && (
                <label htmlFor={`${fieldId}-hex`} className="text-[11px] font-aumovio-bold uppercase tracking-widest text-grey-400 dark:text-grey-500">
                    {label}
                </label>
            )}

            {/* Saturation / Value field */}
            <div
                ref={svRef}
                role="slider"
                tabIndex={0}
                aria-label="Saturation and brightness"
                aria-valuetext={`Saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`}
                onPointerDown={onSvPointerDown}
                onPointerMove={onSvPointerMove}
                onPointerUp={onSvPointerUp}
                onKeyDown={onSvKeyDown}
                className="relative w-full h-36 rounded-xl overflow-hidden cursor-crosshair touch-none select-none ring-1 ring-black/10 dark:ring-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent)"
                style={{ backgroundColor: hueColor }}
            >
                <div className="absolute inset-0" style={{ background: "linear-gradient(to right, #fff, rgba(255,255,255,0))" }} />
                <div className="absolute inset-0" style={{ background: "linear-gradient(to top, #000, rgba(0,0,0,0))" }} />
                <span className="absolute w-4 h-4 -ml-2 -mt-2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.4)] pointer-events-none" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, backgroundColor: currentHex }} />
            </div>

            {/* Hue slider */}
            <div
                ref={hueRef}
                role="slider"
                tabIndex={0}
                aria-label="Hue"
                aria-valuemin={0}
                aria-valuemax={360}
                aria-valuenow={Math.round(hsv.h)}
                onPointerDown={onHuePointerDown}
                onPointerMove={onHuePointerMove}
                onPointerUp={onHuePointerUp}
                onKeyDown={onHueKeyDown}
                className="relative w-full h-4 rounded-full cursor-pointer touch-none select-none ring-1 ring-black/10 dark:ring-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent)"
                style={{ background: "linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)" }}
            >
                <span className="absolute top-1/2 w-4 h-4 -ml-2 -mt-2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.4)] pointer-events-none" style={{ left: `${(hsv.h / 360) * 100}%`, backgroundColor: hueColor }} />
            </div>

            {/* Preview + hex input */}
            <div className="flex items-center gap-2">
                <span className="w-9 h-9 rounded-lg shrink-0 ring-1 ring-black/10 dark:ring-white/15" style={{ backgroundColor: currentHex }} aria-hidden="true" />
                <div className="relative flex-1">
                    <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-grey-400 dark:text-grey-500 text-sm font-mono select-none">#</span>
                    <input
                        id={`${fieldId}-hex`}
                        type="text"
                        inputMode="text"
                        spellCheck={false}
                        maxLength={7}
                        value={hexText.replace(/^#/, "").toUpperCase()}
                        onChange={(e) => onHexChange({ target: { value: `#${e.target.value}` } })}
                        onBlur={onHexBlur}
                        aria-label="Hex colour value"
                        className={`w-full pl-6 pr-2.5 py-2 rounded-lg text-sm font-mono uppercase
                            bg-white dark:bg-white/5 text-black/85 dark:text-white/85
                            border border-grey-200 dark:border-grey-700 ${TRANSITION_COLORS}
                            focus:outline-none focus:border-(--accent) focus:ring-2 focus:ring-(--accent)/30`}
                    />
                </div>
            </div>

            {/* Quick-pick presets */}
            {presets.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                    {presets.map((p) => {
                        const hex = normalizeHex(p) || "#000000";
                        const selected = hex === currentHex;
                        return (
                            <button
                                key={hex}
                                type="button"
                                onClick={() => {
                                    setLastEmit(hex);
                                    setHexText(hex);
                                    setHsv(rgbToHsv(hexToRgb(hex)));
                                    onChange?.(hex);
                                }}
                                title={hex.toUpperCase()}
                                aria-label={`Use ${hex.toUpperCase()}`}
                                aria-pressed={selected}
                                className={`w-6 h-6 rounded-md shrink-0 ${TRANSITION_COLORS}
                                    ${selected ? "ring-2 ring-offset-1 ring-(--accent) ring-offset-(--bg-surface-2)" : "ring-1 ring-black/10 dark:ring-white/15 hover:scale-110"}`}
                                style={{ backgroundColor: hex }}
                            />
                        );
                    })}
                </div>
            )}
        </div>
    );
}

export default ColorPicker;
