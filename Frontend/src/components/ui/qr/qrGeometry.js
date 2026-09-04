/**
 * @fileoverview QR geometry builder — turns a token into SVG path data for a
 * SOFT-EDGED ("modern") QR code with rounded finder eyes and an optional
 * centre logo plate.
 *
 * WHY THIS EXISTS
 * ---------------
 * `qrcode.react` only renders hard 1×1 square modules; it exposes no module
 * matrix, so there is no way to restyle its output. This module reads the raw
 * matrix from the `qrcode` package (`QRCodeLib.create`) and emits its own path
 * data, which both the SVG renderer (`<QRCode>`) and the canvas renderer
 * (`<QrCanvas>`) consume — so a QR on screen, in a PDF export and in an email
 * attachment all look identical.
 *
 * COORDINATE SPACE
 * ----------------
 * Everything is expressed in MODULE UNITS (1 unit = 1 QR module), origin at the
 * top-left of the quiet zone. The renderer supplies the pixel scale through the
 * SVG `viewBox` (or a canvas transform), so the same geometry is resolution
 * independent — a 70 px thumbnail and a 320 px PNG share one code path.
 *
 * SCANNABILITY NOTES (these are correctness constraints, not aesthetics)
 * ---------------------------------------------------------------------
 * 1. Rounding NEVER changes which modules are dark. A corner is rounded only
 *    when the module has no orthogonal neighbour on that side, so adjacent dark
 *    modules stay fused into one solid blob and the decoder still samples the
 *    module centre correctly.
 * 2. A centre logo covers modules, so `buildQrModel` FORCES error-correction
 *    level "H" (30 % recovery) whenever a logo is requested — overriding any
 *    caller-supplied level. A logo over level "M" is the classic unscannable-QR
 *    bug and is not a caller decision.
 * 3. The quiet zone is never dropped: `margin` defaults to 2 modules and is
 *    clamped to >= 1.
 */

import QRCodeLib from "qrcode";

/** Quiet-zone width, in modules. */
export const QR_MARGIN = 2;

/** Finder-pattern edge length, in modules (fixed by the QR spec). */
const FINDER_SIZE = 7;

/** Corner radius as a fraction of one module (0 = square, 0.5 = full circle). */
export const QR_SMOOTHNESS = 0.5;

/** Centre-logo edge length as a fraction of the code's edge length. */
export const QR_LOGO_SCALE = 0.24;

/** Trims float noise so path strings stay short and stable across renders. */
const n = (v) => Number(v.toFixed(3));

/**
 * Rounded-rectangle path in module units.
 *
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @param {number} r - Corner radius; clamped to half the shorter edge.
 * @returns {string} SVG path data.
 */
export function roundedRectPath(x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    if (rr === 0) return `M${n(x)} ${n(y)}H${n(x + w)}V${n(y + h)}H${n(x)}Z`;
    return (
        `M${n(x + rr)} ${n(y)}` +
        `H${n(x + w - rr)}` +
        `A${n(rr)} ${n(rr)} 0 0 1 ${n(x + w)} ${n(y + rr)}` +
        `V${n(y + h - rr)}` +
        `A${n(rr)} ${n(rr)} 0 0 1 ${n(x + w - rr)} ${n(y + h)}` +
        `H${n(x + rr)}` +
        `A${n(rr)} ${n(rr)} 0 0 1 ${n(x)} ${n(y + h - rr)}` +
        `V${n(y + rr)}` +
        `A${n(rr)} ${n(rr)} 0 0 1 ${n(x + rr)} ${n(y)}` +
        "Z"
    );
}

/**
 * One data module, rounded per corner. A radius of 0 emits a plain corner, so a
 * module fused to its neighbours renders as a square and the blob stays solid.
 *
 * @param {number} x - Left edge, module units.
 * @param {number} y - Top edge, module units.
 * @param {number} tl - Top-left radius.
 * @param {number} tr - Top-right radius.
 * @param {number} br - Bottom-right radius.
 * @param {number} bl - Bottom-left radius.
 * @returns {string} SVG path data (a single closed subpath).
 */
function modulePath(x, y, tl, tr, br, bl) {
    let d = `M${n(x + tl)} ${n(y)}H${n(x + 1 - tr)}`;
    if (tr) d += `A${n(tr)} ${n(tr)} 0 0 1 ${n(x + 1)} ${n(y + tr)}`;
    d += `V${n(y + 1 - br)}`;
    if (br) d += `A${n(br)} ${n(br)} 0 0 1 ${n(x + 1 - br)} ${n(y + 1)}`;
    d += `H${n(x + bl)}`;
    if (bl) d += `A${n(bl)} ${n(bl)} 0 0 1 ${n(x)} ${n(y + 1 - bl)}`;
    d += `V${n(y + tl)}`;
    if (tl) d += `A${n(tl)} ${n(tl)} 0 0 1 ${n(x + tl)} ${n(y)}`;
    return `${d}Z`;
}

/**
 * True when (row, col) falls inside one of the three finder patterns. Those are
 * drawn as dedicated rounded eyes, so they are excluded from the data pass.
 *
 * @param {number} size - Matrix edge length, in modules.
 * @param {number} r
 * @param {number} c
 * @returns {boolean}
 */
function isFinderCell(size, r, c) {
    const near = (v) => v < FINDER_SIZE;
    const far = (v) => v >= size - FINDER_SIZE;
    return (near(r) && near(c)) || (near(r) && far(c)) || (far(r) && near(c));
}

/**
 * @typedef {object} QrPlate
 * @property {number} x      - Plate left edge, module units (quiet zone included).
 * @property {number} y      - Plate top edge, module units.
 * @property {number} size   - Plate edge length, module units.
 * @property {number} rx     - Plate corner radius, module units.
 * @property {number} logoX  - Logo left edge, module units.
 * @property {number} logoY  - Logo top edge, module units.
 * @property {number} logoSize - Logo edge length, module units.
 */

/**
 * @typedef {object} QrModel
 * @property {number} total       - Full canvas edge length in module units (code + both quiet zones).
 * @property {number} size        - Matrix edge length, in modules.
 * @property {number} margin      - Quiet zone, in modules.
 * @property {string} level       - Error-correction level actually used.
 * @property {string} dataPath    - Path data for every data module.
 * @property {string} eyeRingPath - Path data for the three finder rings (`fill-rule="evenodd"`).
 * @property {string} eyeDotPath  - Path data for the three finder centres.
 * @property {QrPlate|null} plate - Centre logo plate, or null when no logo.
 */

/**
 * Builds the full drawable model for a QR token.
 *
 * Time/space: O(size²) — one pass over the module matrix, one path string.
 *
 * @param {string} value - Token to encode.
 * @param {object} [opts]
 * @param {'L'|'M'|'Q'|'H'} [opts.level='M'] - Requested EC level; forced to 'H' when `logo` is set.
 * @param {number} [opts.margin=2] - Quiet zone in modules (clamped to >= 1).
 * @param {number} [opts.smoothness=0.5] - Corner radius as a fraction of a module.
 * @param {boolean} [opts.logo=false] - Reserve a centre plate for a logo.
 * @param {number} [opts.logoScale=0.24] - Logo edge as a fraction of the code edge.
 * @returns {QrModel}
 * @throws {Error} When `value` is empty or cannot be encoded (propagated from `qrcode`).
 * @example
 *   const model = buildQrModel(stub.qrCode, { logo: true });
 *   <path d={model.dataPath} fill="#111" />
 */
export function buildQrModel(value, opts = {}) {
    const { level = "M", margin = QR_MARGIN, smoothness = QR_SMOOTHNESS, logo = false, logoScale = QR_LOGO_SCALE } = opts;

    const text = String(value ?? "");
    if (!text) throw new Error("buildQrModel: empty value");

    // A logo occludes modules — level H is required, not preferred. See header.
    const effLevel = logo ? "H" : level;
    const quiet = Math.max(1, Math.round(margin));
    const radius = Math.max(0, Math.min(0.5, smoothness));

    const { modules } = QRCodeLib.create(text, { errorCorrectionLevel: effLevel });
    const size = modules.size;
    const bits = modules.data;
    const total = size + quiet * 2;

    // ── Centre plate ──────────────────────────────────────────────────────
    let plate = null;
    if (logo) {
        const logoSide = Math.max(3, Math.round(size * logoScale));
        const pad = Math.max(0.4, logoSide * 0.14);
        const plateSide = logoSide + pad * 2;
        const plateOrigin = quiet + (size - plateSide) / 2;
        const logoOrigin = quiet + (size - logoSide) / 2;
        plate = {
            x: n(plateOrigin),
            y: n(plateOrigin),
            size: n(plateSide),
            rx: n(plateSide * 0.26),
            logoX: n(logoOrigin),
            logoY: n(logoOrigin),
            logoSize: n(logoSide),
        };
    }

    /** Plate hit-test in module units — a module is dropped if it overlaps the plate. */
    const underPlate = (r, c) => {
        if (!plate) return false;
        const x = quiet + c;
        const y = quiet + r;
        return x + 1 > plate.x && x < plate.x + plate.size && y + 1 > plate.y && y < plate.y + plate.size;
    };

    /**
     * Dark-for-drawing test. Finder cells and plate-occluded cells read as
     * light so neighbouring blobs round off cleanly against them.
     */
    const dark = (r, c) => {
        if (r < 0 || c < 0 || r >= size || c >= size) return false;
        if (!bits[r * size + c]) return false;
        if (isFinderCell(size, r, c)) return false;
        if (underPlate(r, c)) return false;
        return true;
    };

    // ── Data modules ──────────────────────────────────────────────────────
    const parts = [];
    for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
            if (!dark(r, c)) continue;
            const up = dark(r - 1, c);
            const down = dark(r + 1, c);
            const left = dark(r, c - 1);
            const right = dark(r, c + 1);
            parts.push(
                modulePath(
                    quiet + c,
                    quiet + r,
                    !up && !left ? radius : 0,
                    !up && !right ? radius : 0,
                    !down && !right ? radius : 0,
                    !down && !left ? radius : 0,
                ),
            );
        }
    }

    // ── Finder eyes ───────────────────────────────────────────────────────
    const rings = [];
    const dots = [];
    const origins = [
        [0, 0],
        [0, size - FINDER_SIZE],
        [size - FINDER_SIZE, 0],
    ];
    for (const [r0, c0] of origins) {
        const x = quiet + c0;
        const y = quiet + r0;
        // Ring = outer rounded square minus the inner one (evenodd fill).
        rings.push(roundedRectPath(x, y, FINDER_SIZE, FINDER_SIZE, 2));
        rings.push(roundedRectPath(x + 1, y + 1, FINDER_SIZE - 2, FINDER_SIZE - 2, 1.35));
        dots.push(roundedRectPath(x + 2, y + 2, 3, 3, 1.05));
    }

    return {
        total,
        size,
        margin: quiet,
        level: effLevel,
        dataPath: parts.join(""),
        eyeRingPath: rings.join(""),
        eyeDotPath: dots.join(""),
        plate,
    };
}
