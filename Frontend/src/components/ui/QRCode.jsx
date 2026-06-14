/**
 * QRCode — Generates and renders a QR code.
 *
 * Props:
 *   value     — string (URL or text to encode)
 *   size      — number (px, default 160)
 *   level     — 'L'|'M'|'Q'|'H'
 *   bgColor   — string (default '#FFFFFF')
 *   fgColor   — string (default '#000000')
 *   logo      — string (URL for center logo)
 *   logoSize  — number (default 32)
 *   downloadable — boolean
 *   title     — string
 */
import { ArrowDownTrayIcon } from "@heroicons/react/24/outline";
import { QRCodeSVG } from "qrcode.react";
import { useRef } from "react";
import Button from "./Button";

export function QRCode({ value = "", size = 160, level = "M", bgColor = "#FFFFFF", fgColor = "#000000", logo, logoSize = 32, downloadable = false, title }) {
    const ref = useRef(null);

    const download = () => {
        const svg = ref.current?.querySelector("svg");
        if (!svg) return;
        const blob = new Blob([svg.outerHTML], { type: "image/svg+xml" });
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
            <div ref={ref} className="p-3 bg-white border shadow-lg rounded-xl border-grey-200 dark:border-grey-700">
                <QRCodeSVG
                    value={value || "https://aumovio.com"}
                    size={size}
                    level={level}
                    bgColor={bgColor}
                    fgColor={fgColor}
                    imageSettings={
                        logo
                            ? {
                                  src: logo,
                                  x: undefined,
                                  y: undefined,
                                  height: logoSize,
                                  width: logoSize,
                                  excavate: true,
                              }
                            : undefined
                    }
                />
            </div>
            {downloadable && (
                <Button variant="ghost" size="sm" leftIcon={ArrowDownTrayIcon} onClick={download}>
                    Download SVG
                </Button>
            )}
        </div>
    );
}

export default QRCode;
