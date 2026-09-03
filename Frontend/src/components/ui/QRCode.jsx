/**
 * @fileoverview QRCode — soft-edged ("modern") QR renderer with a centre logo.
 *
 * Two renderers, ONE geometry source (`./qr/qrGeometry.js`), so a stub's code
 * looks identical wherever it appears:
 *
 *   <QRCode>    — SVG. Resolution independent; used for on-screen QR (gallery
 *                 thumbnail, zoom modal) and the "Download SVG" action.
 *   <QrCanvas>  — <canvas> with the same paths. Needed only where a caller must
 *                 call `.toDataURL()` on the DOM node (the EmailFailureModal PDF
 *                 export captures the canvas element by ref).
 *
 * WHAT CHANGED vs. the old implementation
 *   Previously this wrapped `qrcode.react`'s <QRCodeSVG>, which renders hard
 *   square modules and exposes no matrix, so the corners could not be softened.
 *   We now build our own path data — rounded modules, rounded finder eyes, and a
 *   rounded logo plate. See `qr/qrGeometry.js` for the scannability constraints
 *   that the rounding respects (in particular: a logo FORCES EC level "H").
 *
 * The centre logo defaults to the app mark and can be disabled per call with
 * `logo={null}` (do that for very small renders where the mark would just be
 * mud).
 *
 * @example
 *   <QRCode value={stub.qrCode} size={260} />          // logo, level H
 *   <QRCode value={token} size={64} logo={null} />     // bare, caller's level
 */

import { ArrowDownTrayIcon } from "@heroicons/react/24/outline";
import { useEffect, useMemo, useRef } from "react";

import appMark from "../../assets/img/android-chrome-192x192.png";
import Button from "./Button";
import { buildQrModel } from "./qr/qrGeometry";

/** Default centre mark. Pass `logo={null}` to render a bare code. */
const QR_DEFAULT_LOGO = appMark;

/* ── Logo preload ──────────────────────────────────────────────────────────
 * The canvas renderer cannot draw a logo it has not decoded yet, and the PDF
 * export may capture the canvas moments after mount. Decode once per URL and
 * hand every canvas the same cached HTMLImageElement.
 */
const _imageCache = new Map();

/**
 * Decodes an image URL once and caches the promise.
 * @param {string} src
 * @returns {Promise<HTMLImageElement>}
 */
function loadImage(src) {
    if (_imageCache.has(src)) return _imageCache.get(src);
    const p = new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
    });
    _imageCache.set(src, p);
    return p;
}

/**
 * Builds the geometry, swallowing encode failures so a bad token degrades to an
 * empty box instead of taking the view down with it.
 *
 * @param {string} value
 * @param {object} opts
 * @returns {import('./qr/qrGeometry').QrModel|null}
 */
function useQrModel(value, opts) {
    const { level, margin, smoothness, logo, logoScale } = opts;
    return useMemo(() => {
        try {
            return buildQrModel(value, { level, margin, smoothness, logo: Boolean(logo), logoScale });
        } catch {
            return null;
        }
    }, [value, level, margin, smoothness, logo, logoScale]);
}

/* ── SVG renderer ─────────────────────────────────────────────────────────── */

/**
 * QRCode — renders `value` as a rounded-module SVG QR code.
 *
 * @param {object} props
 * @param {string} props.value - Text/token to encode.
 * @param {number} [props.size=160] - Rendered edge length in px.
 * @param {'L'|'M'|'Q'|'H'} [props.level='M'] - EC level; ignored (forced to 'H') when a logo is drawn.
 * @param {string} [props.bgColor='#FFFFFF'] - Quiet-zone and logo-plate fill.
 * @param {string} [props.fgColor='#000000'] - Module fill.
 * @param {string} [props.eyeColor] - Finder-pattern fill; defaults to `fgColor`.
 * @param {string|null} [props.logo] - Centre logo URL; `null` disables it.
 * @param {number} [props.logoSize] - Legacy px logo size; converted to a scale.
 * @param {number} [props.logoScale=0.24] - Logo edge as a fraction of the code edge.
 * @param {number} [props.margin=2] - Quiet zone in modules.
 * @param {number} [props.smoothness=0.5] - Corner radius as a fraction of a module.
 * @param {boolean} [props.downloadable=false] - Render a "Download SVG" button.
 * @param {string} [props.title] - Caption above the code.
 * @param {string} [props.className] - Extra classes on the SVG's frame.
 * @returns {JSX.Element}
 */
export function QRCode({
    value = "",
    size = 160,
    level = "M",
    bgColor = "#FFFFFF",
    fgColor = "#000000",
    eyeColor,
    logo = QR_DEFAULT_LOGO,
    logoSize,
    logoScale = 0.24,
    margin = 2,
    smoothness = 0.5,
    downloadable = false,
    title,
    className = "",
}) {
    const ref = useRef(null);
    // Legacy prop bridge: callers used to pass an absolute px logo size.
    const effScale = logoSize ? Math.max(0.1, Math.min(0.32, logoSize / size)) : logoScale;
    const model = useQrModel(value, { level, margin, smoothness, logo, logoScale: effScale });

    /**
     * Exports the rendered SVG. The logo is inlined as a data URI first — a
     * bundled asset URL is relative to the app and would resolve to nothing once
     * the file leaves the browser.
     */
    const download = async () => {
        const svg = ref.current?.querySelector("svg");
        if (!svg) return;
        const clone = svg.cloneNode(true);
        const img = clone.querySelector("image");
        if (img && logo) {
            try {
                const res = await fetch(logo);
                const blob = await res.blob();
                const dataUrl = await new Promise((resolve) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result);
                    reader.readAsDataURL(blob);
                });
                img.setAttribute("href", dataUrl);
            } catch {
                // Logo unavailable — export the code without it rather than fail.
                img.remove();
            }
        }
        clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
        const blob = new Blob([clone.outerHTML], { type: "image/svg+xml" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "qrcode.svg";
        a.click();
        URL.revokeObjectURL(url);
    };

    return (
        <div className="inline-flex flex-col items-center gap-3 font-aumovio">
            {title && <p className="text-sm font-aumovio-bold text-black/70 dark:text-white/70">{title}</p>}
            <div ref={ref} className={`p-3 bg-white border shadow-lg rounded-2xl border-grey-200 dark:border-grey-700 ${className}`}>
                {model ? (
                    <svg width={size} height={size} viewBox={`0 0 ${model.total} ${model.total}`} role="img" aria-label={title ? `QR code — ${title}` : "QR code"} shapeRendering="geometricPrecision">
                        <rect width={model.total} height={model.total} rx={1.5} fill={bgColor} />
                        <path d={model.dataPath} fill={fgColor} />
                        <path d={model.eyeRingPath} fill={eyeColor ?? fgColor} fillRule="evenodd" />
                        <path d={model.eyeDotPath} fill={eyeColor ?? fgColor} />
                        {model.plate && (
                            <>
                                <rect x={model.plate.x} y={model.plate.y} width={model.plate.size} height={model.plate.size} rx={model.plate.rx} fill={bgColor} />
                                <image href={logo} x={model.plate.logoX} y={model.plate.logoY} width={model.plate.logoSize} height={model.plate.logoSize} preserveAspectRatio="xMidYMid meet" />
                            </>
                        )}
                    </svg>
                ) : (
                    <div style={{ width: size, height: size }} className="flex items-center justify-center text-[10px] text-grey-400" role="img" aria-label="QR code unavailable">
                        QR unavailable
                    </div>
                )}
            </div>
            {downloadable && (
                <Button variant="ghost" size="sm" leftIcon={ArrowDownTrayIcon} onClick={download}>
                    Download SVG
                </Button>
            )}
        </div>
    );
}

/* ── Canvas renderer ──────────────────────────────────────────────────────── */

/**
 * QrCanvas — same code, drawn into a `<canvas>` so callers can capture it with
 * `.toDataURL()`. Used by the EmailFailureModal PDF export; prefer `<QRCode>`
 * anywhere a canvas is not strictly required.
 *
 * The element is rendered at devicePixelRatio so the captured PNG stays crisp
 * when jsPDF scales it into a page.
 *
 * @param {object} props
 * @param {string} props.value
 * @param {number} [props.size=200] - CSS edge length in px.
 * @param {'L'|'M'|'Q'|'H'} [props.level='M']
 * @param {string} [props.bgColor='#FFFFFF']
 * @param {string} [props.fgColor='#000000']
 * @param {string|null} [props.logo] - Centre logo URL; `null` disables it.
 * @param {number} [props.logoScale=0.24]
 * @param {number} [props.margin=2]
 * @param {number} [props.smoothness=0.5]
 * @param {string} [props.className]
 * @param {React.Ref<HTMLCanvasElement>} [props.ref] - Receives the canvas element.
 * @returns {JSX.Element}
 */
export function QrCanvas({ value = "", size = 200, level = "M", bgColor = "#FFFFFF", fgColor = "#000000", logo = QR_DEFAULT_LOGO, logoScale = 0.24, margin = 2, smoothness = 0.5, className = "", ref }) {
    const innerRef = useRef(null);
    const model = useQrModel(value, { level, margin, smoothness, logo, logoScale });

    useEffect(() => {
        const canvas = innerRef.current;
        if (!canvas || !model) return;
        // jsdom implements neither a 2D context nor Path2D (and logs a noisy
        // "not implemented" for getContext) — bail out quietly instead.
        let ctx = null;
        try {
            ctx = typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
        } catch {
            ctx = null;
        }
        if (!ctx || typeof Path2D === "undefined") return;

        const dpr = typeof window !== "undefined" && window.devicePixelRatio ? window.devicePixelRatio : 1;
        const px = Math.round(size * dpr);
        canvas.width = px;
        canvas.height = px;
        canvas.style.width = `${size}px`;
        canvas.style.height = `${size}px`;

        let cancelled = false;

        const paint = (logoImg) => {
            const scale = px / model.total;
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, px, px);
            ctx.setTransform(scale, 0, 0, scale, 0, 0);

            ctx.fillStyle = bgColor;
            ctx.fillRect(0, 0, model.total, model.total);

            ctx.fillStyle = fgColor;
            ctx.fill(new Path2D(model.dataPath));
            ctx.fill(new Path2D(model.eyeRingPath), "evenodd");
            ctx.fill(new Path2D(model.eyeDotPath));

            if (model.plate) {
                ctx.fillStyle = bgColor;
                ctx.beginPath();
                const p = model.plate;
                // roundRect is available in every browser this app targets; the
                // plain rect keeps the excavation valid if it is not.
                if (typeof ctx.roundRect === "function") {
                    ctx.roundRect(p.x, p.y, p.size, p.size, p.rx);
                } else {
                    ctx.rect(p.x, p.y, p.size, p.size);
                }
                ctx.fill();
                if (logoImg) ctx.drawImage(logoImg, p.logoX, p.logoY, p.logoSize, p.logoSize);
            }
            ctx.setTransform(1, 0, 0, 1, 0, 0);
        };

        // Paint immediately so a capture that races the logo decode still gets a
        // valid (logo-less) code, then repaint once the mark is available.
        paint(null);
        if (model.plate && logo) {
            loadImage(logo)
                .then((img) => {
                    if (!cancelled) paint(img);
                })
                .catch(() => {
                    /* keep the logo-less code */
                });
        }

        return () => {
            cancelled = true;
        };
    }, [model, size, bgColor, fgColor, logo]);

    const setRefs = (node) => {
        innerRef.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
    };

    return <canvas ref={setRefs} className={className} aria-label="QR code" role="img" />;
}

export default QRCode;
