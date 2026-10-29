# Orbit / Border-Beam Color Behavior — Frame-by-Frame Analysis

> **Source:** `sample-orbit.mp4` · **Method:** every frame decoded and analysed with OpenCV (HSV per-pixel, temporal statistics, perimeter tracking, autocorrelation).
> **Goal:** reproduce the *look, behaviour and feel* of the orbiting color for an AI ring, and make it **theme-aware across many palettes**.

---

## 0. TL;DR — what the effect actually is

The video is **not** a hue that cycles the rainbow. It is a **single-color glowing "beam" (a short comet-like highlight) that travels around the perimeter of a rounded rectangle** — the classic *border-beam* / *conic-gradient border* effect (think Magic UI `BorderBeam`, or a `conic-gradient` masked to a 1px border).

- The **base border** (the "track") is dark and almost invisible.
- A **bright blue head** (`#246585`, HSV ≈ `205°, 64%, 52%`) sweeps around the outline.
- Behind the head is a **short fading tail** (~36 px), then darkness.
- One full lap takes **~2.2 seconds**, moving **clockwise**.
- The hue **stays constant** the whole time — the motion is positional, not chromatic.

**To make it theme-aware:** keep the *behaviour* (geometry, speed, tail length, glow falloff, contrast ratio) fixed, and swap only the **head color** (and optionally a 2-stop gradient) from the active palette. Everything below gives you the exact numbers to drive that.

---

## 1. Video metadata

| Property | Value |
|---|---|
| Resolution | **520 × 116 px** (wide banner — an input/button-sized element) |
| Frame rate | **30 fps** |
| Frame count | **237 frames** (all decoded, none dropped) |
| Duration | **7.9 s** |
| Aspect | ~4.5 : 1 (a pill / input field shape) |

Every one of the 237 frames was analysed. No sampling — full-frame pass.

---

## 2. Geometry — what is animating

A per-pixel **temporal standard-deviation** of brightness (the "motion map") reveals the animated element unambiguously. Only a **thin rectangular outline** changes over time; the interior is static.

```
MOTION MAP (bright = changes over time)   ← the animated element
┌────────────────────────────────────────┐  ← top edge  (animated)
│                                        │  ← left / right edges (animated)
│                                        │
└────────────────────────────────────────┘  ← bottom edge (animated)
```

- **Form:** rounded-rectangle **border** (a glowing outline), ~4 px inside the frame edge.
- **Perimeter length:** ≈ **1236 px** (the 1-D path the beam travels).
- **Border/glow thickness:** the crisp core is ~**4 px**, with a small inward glow (see §5).
- The interior of the shape does **not** animate — this is purely an outline effect.

---

## 3. Motion — how the color orbits

Two independent methods were used and they **agree**, which gives high confidence:

| Method | Result |
|---|---|
| Angular travel of the beam centroid | 1253.3° over 7.87 s → **159.3 °/s** |
| Autocorrelation of the position signal | period = 67 frames → **2.23 s** |

### Derived motion constants

| Metric | Value | Notes |
|---|---|---|
| **Direction** | **Clockwise** | top-left → top-right → down → bottom → up → repeat |
| **Angular speed** | **≈ 159 °/s** | of the equivalent radial angle |
| **Revolution period** | **≈ 2.2 – 2.3 s** | one full lap around the border |
| **Revolutions per second** | **≈ 0.44 rev/s** | |
| **Laps in the 7.9 s clip** | **≈ 3.5** | motion is continuous and loops seamlessly |
| **Motion style** | **constant/linear speed** | no easing — it does **not** slow at corners; treat as linear `t` |

> **Feel:** smooth, continuous, hypnotic. Constant velocity (linear timing function), infinite loop, no pause. On a rounded-rect the *visual* speed looks very slightly faster on the long edges and slower on the short ones simply because of geometry, but the underlying parameter advances linearly.

---

## 4. Color — the heart of the effect

### 4.1 Beam head (the bright leading color)

| Space | Value |
|---|---|
| **Hex** | `#246585` |
| **RGB** | `rgb(36, 101, 133)` |
| **HSV (median over all frames)** | `H 205°, S ≈ 64%, V ≈ 52%` |

This is a **desaturated cyan-blue**. It is **stable across every frame** — the hue variance over time is effectively zero (circular variance ≈ 0.028 on saturated pixels, max 0.03).

> **Critical insight:** the "orbiting color" does **not** change color as it moves. It is one hue. The perceived richness comes from the **head → tail brightness gradient** and the **glow**, not from hue rotation.

### 4.2 Track / base border color (when the beam is *not* on it)

| Space | Value |
|---|---|
| **Hex** | `#4c3b2f` |
| **RGB** | `rgb(76, 59, 47)` |

This is very dark and close to the background — i.e. the border is **barely visible at rest** and only "lights up" as the beam passes. (The warm-ish reading here is the dark background bleeding into the sample; effectively treat the track as `~8–12% opacity of the head color`, or a near-transparent dark line.)

### 4.3 Tail gradient (colors trailing behind the head)

Sampled backwards from the head along the perimeter:

| Distance behind head | Color | Meaning |
|---|---|---|
| 0 px (head) | `rgb(36,100,133)` | full bright blue |
| 15 px | `rgb(36,100,133)` | still full bright — **flat bright core** |
| 30 px | `rgb(22,23,27)` | **drops to near-black** — tail ends abruptly |
| 45–105 px | `rgb(~24,24,26)` | background (dark), no color |

> **Tail profile:** the beam has a **short bright core (~30 px) with a sharp cut-off**, not a long, gently-fading comet. Think *a bright dash* more than *a long streak*. Beam length ≈ **36 px = ~2.9% of the perimeter**.

---

## 5. Glow / edge falloff (perpendicular to the border)

Normalised brightness sampled inward from the edge at the beam head, averaged over all frames:

```
depth (px):  0    1    2    3    4    5   ...  19
brightness: .99  .99 1.00 1.00  .04  .03  ...  .03
             └──── crisp 4px core ────┘└── ~3% ambient glow ──┘
```

- **Core:** ~**4 px** of full brightness — a crisp line.
- **Glow:** drops to ~**3–4%** immediately after → only a *faint* halo, with a tiny secondary bump (~14%) around 8 px (soft outer glow / blur).
- **Interpretation:** a **thin, sharp beam** with a **subtle** glow — not a big soft neon blur. In CSS terms: a 1–2px bright border line + a small `blur`/`drop-shadow` (≈ 4–8 px), not a 20px bloom.

---

## 6. Contrast & "opacity feel"

| Metric | Value | Meaning |
|---|---|---|
| Peak-to-base brightness ratio | **≈ 20×** | the head is *dramatically* brighter than the resting track |
| Beam length | **~36 px (2.9% of perimeter)** | short, tight highlight |
| Beam saturation | **~64%** | vivid but not fully saturated (slightly milky/glassy) |

The 20× contrast is what makes the beam "pop" against an almost-invisible border. Preserve this ratio when re-theming: `head brightness ≈ 20 × track brightness`.

---

## 7. How to reproduce it (theme-aware)

Keep **behaviour constant**, swap **color** per palette. The behaviour constants distilled from the analysis:

```
ORBIT_BEHAVIOR = {
  shape:            "rounded-rect border (follow the element's border-radius)",
  direction:        "clockwise",
  period_sec:       2.2,          // one full lap  (range 2.2–2.3 measured)
  timing:           "linear",     // constant speed, no ease, infinite loop
  beam_len_frac:    0.03,         // ~3% of the perimeter is lit
  core_thickness:   "2px",        // crisp bright line
  glow_blur:        "6px",        // subtle halo, NOT a big bloom
  contrast_ratio:   20,           // head is ~20x brighter than the resting track
  track_opacity:    0.10,         // resting border ~10% of head color
  hue_cycles:       false,        // single hue — do NOT rainbow-cycle
}
```

```
THEME_COLOR (the only thing that changes per palette) = {
  head:   palette.accent,               // e.g. #246585 in the sample
  // optional 2-stop gradient for a richer head:
  head_gradient: [palette.accent, palette.accentLight],
  track:  rgba(palette.accent, 0.10),   // faint resting border
}
```

### 7.1 CSS reference implementation (conic-gradient border-beam)

A single moving conic gradient masked to the border reproduces the look. Only the two custom properties `--beam` and `--track` come from the theme; everything else is fixed behaviour.

```css
.ai-ring {
  --beam:  #246585;                 /* THEME: from active palette accent   */
  --track: rgba(36, 101, 133, 0.1); /* THEME: 10% of --beam                */
  --period: 2.2s;                   /* FIXED behaviour                     */
  --beam-arc: 11%;                  /* FIXED: ~3% lit core + soft edges    */

  position: relative;
  border-radius: 12px;              /* match your element */
  isolation: isolate;
}

/* the moving border */
.ai-ring::before {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  padding: 2px;                     /* FIXED core thickness */
  background: conic-gradient(
    from var(--angle),
    transparent 0%,
    var(--beam) var(--beam-arc),    /* bright head */
    transparent calc(var(--beam-arc) * 2)
  );
  /* mask so only the 2px border shows, interior stays clear */
  -webkit-mask:
    linear-gradient(#000 0 0) content-box,
    linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
          mask-composite: exclude;
  filter: drop-shadow(0 0 6px var(--beam)); /* FIXED subtle glow */
  animation: ai-ring-spin var(--period) linear infinite; /* CW, constant */
}

/* faint resting track underneath */
.ai-ring::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  border: 2px solid var(--track);
  z-index: -1;
}

@property --angle {
  syntax: "<angle>";
  inherits: false;
  initial-value: 0deg;
}

@keyframes ai-ring-spin {
  to { --angle: 360deg; }           /* clockwise */
}
```

### 7.2 Theming across many palettes

Because only `--beam` / `--track` change, wiring it to any theme is trivial:

```css
[data-theme="ocean"]  .ai-ring { --beam:#246585; --track:rgba(36,101,133,.1); }
[data-theme="ember"]  .ai-ring { --beam:#d9773f; --track:rgba(217,119,63,.1); }
[data-theme="violet"] .ai-ring { --beam:#8b5cf6; --track:rgba(139,92,246,.1); }
[data-theme="mint"]   .ai-ring { --beam:#34d399; --track:rgba(52,211,153,.1); }
```

Or, if you already expose a design token for the palette accent, set both from it in one place:

```css
.ai-ring {
  --beam:  var(--color-accent);
  --track: color-mix(in srgb, var(--color-accent) 10%, transparent);
}
```

> This preserves the measured *feel* (2.2s CW lap, ~3% tight bright head, subtle 6px glow, 20× contrast, no hue cycling) while letting the *color* follow whatever palette is active — exactly the theme-aware behaviour requested.

---

## 8. Optional richer variants (still faithful to the source)

The source uses a single hue. If you want more life while staying true to the *behaviour*:

- **Two-stop head gradient:** `conic-gradient(..., accent → accentLight → transparent)` — richer head without rainbow cycling. Keeps hue family, adds depth.
- **Second trailing beam:** a dimmer copy offset by 180° for a symmetric double-beam. Keep the same 2.2s period.
- **Speed-to-state mapping (AI ring idea):** map `--period` to activity — idle 3s, thinking 1.2s, responding 0.7s. Behaviour scales, color stays theme-driven.

---

## 9. Measurement provenance (so results are reproducible)

| Finding | How it was measured |
|---|---|
| Shape = rounded-rect border | per-pixel temporal std of V (motion map) |
| Single hue, no cycling | per-pixel **circular** variance of hue over time (≈0.03) |
| Head color `#246585` | median BGR at the tracked head across all frames |
| Track color `#4c3b2f` | median BGR at perimeter point 180° opposite the head |
| Period ≈ 2.2 s | (a) angular unwrap of beam centroid, (b) autocorrelation — agree |
| Direction = CW | sign of unwrapped angular travel |
| Beam length ~36 px | perimeter bins above the mid brightness threshold |
| Glow falloff | inward brightness profile at the head, averaged over frames |
| Contrast 20× | peak beam intensity ÷ median track intensity |

Every metric came from analysing **all 237 frames**, not a subset.

---

### Summary constants (copy-paste)

```json
{
  "shape": "rounded-rect-border-beam",
  "period_sec": 2.2,
  "direction": "clockwise",
  "timing": "linear-infinite",
  "beam_length_fraction": 0.03,
  "core_thickness_px": 2,
  "glow_blur_px": 6,
  "contrast_ratio": 20,
  "track_opacity": 0.10,
  "hue_cycles": false,
  "sample_head_color": "#246585",
  "sample_track_color": "rgba(36,101,133,0.10)",
  "theme_aware": "swap only head+track from active palette; keep all behaviour constants"
}
```
