/**
 * ComingSoon.jsx — Under Construction / Coming Soon overlay.
 *
 * Reusable for any page or view in the Aumovio design system.
 * Drop it in as a full-page wrapper or an inline section overlay.
 *
 * Props:
 *   title        — string  (default: "Coming Soon")
 *   subtitle     — string  (default: generic copy)
 *   eta          — string  (optional ETA label, e.g. "Q3 2025")
 *   feature      — string  (feature/page name shown on the hard-hat badge)
 *   variant      — "page" | "overlay" | "inline"
 *                   page    = full viewport, used as a standalone route view
 *                   overlay = fixed overlay on top of existing content (z-50)
 *                   inline  = fills its parent container (relative, no fixed)
 *   showProgress — boolean (animated construction progress bar)
 *   progress     — 0–100 (only meaningful when showProgress=true)
 *   onBack       — () => void (optional back/nav action)
 *   backLabel    — string (default "Go back")
 *   className    — extra classes on the root element
 *
 * Usage:
 *
 *   // Full route swap — render it as the entire view
 *   <ComingSoon title="Analytics" feature="Dashboard Analytics" eta="Q3 2025" />
 *
 *   // Inline inside an existing view (e.g. a tab panel not yet ready)
 *   <ComingSoon variant="inline" title="Reports" showProgress progress={35} />
 *
 *   // Overlay on top of a blurred page
 *   <div className="relative">
 *     <ExistingPageContent />
 *     <ComingSoon variant="overlay" title="Premium Feature" />
 *   </div>
 */

import { useEffect, useRef, useState } from "react";
import { ANIMATE_FADE_IN_UP, ANIMATE_PAGE_ENTER, ANIMATE_PING, ANIM_DELAY_100, ANIM_DELAY_200, ANIM_DELAY_300, ANIM_DELAY_400, ANIM_DELAY_500 } from "../../assets/styles/pre-set-styles";
import Button from "../../components/ui/Button";

/* ─── Internal keyframe injection (construction-specific) ─────────────────── */
const KEYFRAMES = `
  @keyframes cs-scaffold { 0%,100%{transform:scaleY(1) translateY(0)} 50%{transform:scaleY(1.04) translateY(-2px)} }
  @keyframes cs-gear-a   { to { transform: rotate(360deg); } }
  @keyframes cs-gear-b   { to { transform: rotate(-360deg); } }
  @keyframes cs-brick    { 0%{opacity:0;transform:translateY(-6px)} 100%{opacity:1;transform:translateY(0)} }
  @keyframes cs-sweep    { 0%{transform:translateX(-100%)} 100%{transform:translateX(400%)} }
  @keyframes cs-hammer   { 0%,100%{transform:rotate(-20deg) translateY(0)} 50%{transform:rotate(10deg) translateY(4px)} }
  @keyframes cs-stripe   { 0%{background-position:0 0} 100%{background-position:40px 0} }
  @keyframes cs-cursor   { 0%,100%{opacity:1} 50%{opacity:0} }
  @keyframes cs-dot-1    { 0%,80%,100%{transform:scale(0.6);opacity:0.4} 40%{transform:scale(1);opacity:1} }
  @keyframes cs-dot-2    { 0%,20%,80%,100%{transform:scale(0.6);opacity:0.4} 60%{transform:scale(1);opacity:1} }
  @keyframes cs-dot-3    { 0%,40%,100%{transform:scale(0.6);opacity:0.4} 80%{transform:scale(1);opacity:1} }
  @keyframes cs-progress { from{width:0%} }
  @keyframes cs-tape     { 0%{background-position:0 0} 100%{background-position:60px 0} }
  @keyframes cs-bob-l    { 0%,100%{transform:translate(0,0) rotate(-8deg)} 50%{transform:translate(-4px,-10px) rotate(-12deg)} }
  @keyframes cs-bob-r    { 0%,100%{transform:translate(0,0) rotate(8deg)} 50%{transform:translate(4px,-10px) rotate(12deg)} }
`;

let _keyframesInjected = false;
function injectKeyframes() {
    if (_keyframesInjected) return;
    _keyframesInjected = true;
    const s = document.createElement("style");
    s.textContent = KEYFRAMES;
    document.head.appendChild(s);
}

/* ─── Scaffold SVG illustration ───────────────────────────────────────────── */
function ScaffoldIllustration({ feature = "" }) {
    return (
        <div className="relative flex items-end justify-center select-none" style={{ width: 320, height: 260 }}>
            {/* Back poles */}
            <svg viewBox="0 0 320 260" width="320" height="260" fill="none" className="absolute inset-0" style={{ zIndex: 0 }}>
                {/* Ground shadow */}
                <ellipse cx="160" cy="252" rx="120" ry="8" fill="currentColor" className="text-black/5 dark:text-white/5" />

                {/* Scaffold frame */}
                <rect x="40" y="20" width="8" height="230" rx="4" fill="var(--accent)" opacity="0.7" style={{ animation: "cs-scaffold 3s ease-in-out infinite" }} />
                <rect x="272" y="20" width="8" height="230" rx="4" fill="var(--accent)" opacity="0.7" style={{ animation: "cs-scaffold 3s 0.4s ease-in-out infinite" }} />
                <rect x="140" y="20" width="8" height="230" rx="4" fill="var(--accent)" opacity="0.5" style={{ animation: "cs-scaffold 3s 0.8s ease-in-out infinite" }} />

                {/* Horizontal planks */}
                <rect x="36" y="70" width="248" height="10" rx="3" fill="#c2440a" opacity="0.5" />
                <rect x="36" y="130" width="248" height="10" rx="3" fill="#c2440a" opacity="0.5" />
                <rect x="36" y="190" width="248" height="10" rx="3" fill="#c2440a" opacity="0.5" />

                {/* Diagonal braces */}
                <path d="M44 70 L144 130" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" opacity="0.3" />
                <path d="M144 70 L44 130" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" opacity="0.3" />
                <path d="M148 130 L276 190" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" opacity="0.3" />
                <path d="M276 130 L148 190" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" opacity="0.3" />

                {/* Warning stripe tape across base */}
                <rect
                    x="36"
                    y="236"
                    width="248"
                    height="12"
                    rx="3"
                    style={{
                        fill: "transparent",
                        backgroundImage: "repeating-linear-gradient(90deg,var(--accent) 0,var(--accent) 20px,#1a1a1a 20px,#1a1a1a 40px)",
                        backgroundSize: "40px 100%",
                        animation: "cs-tape 1.2s linear infinite",
                    }}
                />
                {/* SVG can't do bg-image, so overlay the tape via foreignObject pattern instead:
                    just draw alternating rects manually */}
                {Array.from({ length: 7 }, (_, i) => (
                    <rect key={i} x={36 + i * 36} y="236" width="18" height="12" rx={i === 0 ? "3 0 0 3" : i === 6 ? "0 3 3 0" : "0"} fill="var(--accent)" opacity="0.85" />
                ))}

                {/* Bricks being laid (animated stacking) */}
                {[
                    { x: 60, y: 200, delay: "0s" },
                    { x: 100, y: 200, delay: "0.2s" },
                    { x: 140, y: 200, delay: "0.4s" },
                    { x: 180, y: 200, delay: "0.6s" },
                    { x: 220, y: 200, delay: "0.8s" },
                    { x: 80, y: 216, delay: "1.0s" },
                    { x: 120, y: 216, delay: "1.2s" },
                    { x: 160, y: 216, delay: "1.4s" },
                    { x: 200, y: 216, delay: "1.6s" },
                ].map((b, i) => (
                    <rect
                        key={i}
                        x={b.x}
                        y={b.y}
                        width="34"
                        height="12"
                        rx="2"
                        fill="#4827AF"
                        opacity="0.6"
                        style={{
                            animation: `cs-brick 0.4s ${b.delay} ease-out both`,
                        }}
                    />
                ))}
            </svg>

            {/* Floating hard-hat */}
            <div
                className="absolute"
                style={{
                    top: 0,
                    left: "50%",
                    transform: "translateX(-50%)",
                    animation: "err-float 3s ease-in-out infinite",
                    zIndex: 10,
                }}
            >
                <div className="relative">
                    <svg width="90" height="70" viewBox="0 0 90 70" fill="none">
                        {/* Hat brim */}
                        <ellipse cx="45" cy="52" rx="44" ry="12" fill="var(--accent)" opacity="0.9" />
                        {/* Hat dome */}
                        <path d="M8 52 C8 28 20 8 45 6 C70 8 82 28 82 52Z" fill="var(--accent)" />
                        {/* Hat shine stripe */}
                        <path d="M20 28 L70 28" stroke="white" strokeWidth="3" strokeLinecap="round" opacity="0.4" />
                        {/* Vent holes */}
                        <circle cx="38" cy="18" r="3" fill="#da3806" opacity="0.6" />
                        <circle cx="52" cy="18" r="3" fill="#da3806" opacity="0.6" />
                    </svg>
                    {/* Feature label on hat */}
                    {feature && (
                        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded text-white font-aumovio-bold whitespace-nowrap" style={{ fontSize: 9, background: "rgba(0,0,0,0.35)", letterSpacing: "0.08em" }}>
                            {feature.length > 14 ? feature.slice(0, 13) + "…" : feature}
                        </div>
                    )}
                </div>
            </div>

            {/* Left gear */}
            <div
                className="absolute"
                style={{
                    left: 10,
                    bottom: 60,
                    animation: "cs-gear-a 8s linear infinite",
                    zIndex: 5,
                }}
            >
                <svg width="44" height="44" viewBox="0 0 44 44" fill="none">
                    <circle cx="22" cy="22" r="10" fill="#4827AF" opacity="0.5" />
                    <circle cx="22" cy="22" r="6" fill="#4827AF" opacity="0.8" />
                    {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => (
                        <rect key={deg} x="20" y="2" width="4" height="8" rx="2" fill="#4827AF" opacity="0.7" transform={`rotate(${deg} 22 22)`} />
                    ))}
                </svg>
            </div>

            {/* Right gear (counter) */}
            <div
                className="absolute"
                style={{
                    right: 12,
                    bottom: 56,
                    animation: "cs-gear-b 6s linear infinite",
                    zIndex: 5,
                }}
            >
                <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
                    <circle cx="18" cy="18" r="8" fill="var(--accent)" opacity="0.5" />
                    <circle cx="18" cy="18" r="5" fill="var(--accent)" opacity="0.8" />
                    {[0, 60, 120, 180, 240, 300].map((deg) => (
                        <rect key={deg} x="16" y="1" width="4" height="7" rx="2" fill="var(--accent)" opacity="0.7" transform={`rotate(${deg} 18 18)`} />
                    ))}
                </svg>
            </div>

            {/* Hammer swinging */}
            <div
                className="absolute"
                style={{
                    right: 50,
                    top: 60,
                    transformOrigin: "bottom left",
                    animation: "cs-hammer 1.4s ease-in-out infinite",
                    zIndex: 8,
                }}
            >
                <svg width="28" height="50" viewBox="0 0 28 50" fill="none">
                    {/* Handle */}
                    <rect x="12" y="18" width="5" height="32" rx="2" fill="#92400e" />
                    {/* Head */}
                    <rect x="4" y="8" width="20" height="14" rx="3" fill="#374151" />
                    <rect x="4" y="8" width="8" height="14" rx="3" fill="#4b5563" />
                </svg>
            </div>
        </div>
    );
}

/* ─── Bouncing loading dots ───────────────────────────────────────────────── */
function LoadingDots() {
    return (
        <div className="flex items-center gap-1.5">
            {[{ anim: "cs-dot-1" }, { anim: "cs-dot-2" }, { anim: "cs-dot-3" }].map(({ anim }, i) => (
                <span key={i} className="w-2 h-2 rounded-full bg-(--accent)" style={{ display: "inline-block", animation: `${anim} 1.2s ease-in-out infinite` }} />
            ))}
        </div>
    );
}

/* ─── Construction progress bar ──────────────────────────────────────────── */
function ConstructionBar({ progress = 0 }) {
    return (
        <div className="w-full max-w-sm">
            <div className="flex justify-between mb-1.5 text-xs font-aumovio-bold text-black/50 dark:text-white/50">
                <span>Construction progress</span>
                <span className="text-(--accent-foreground)">{progress}%</span>
            </div>
            <div className="relative h-3 rounded-full overflow-hidden bg-grey-200 dark:bg-(--bg-surface-3)">
                {/* Stripe layer */}
                <div
                    className="absolute inset-0 opacity-20"
                    style={{
                        backgroundImage: "repeating-linear-gradient(-45deg, var(--accent) 0, var(--accent) 10px, transparent 10px, transparent 20px)",
                        backgroundSize: "28.28px 28.28px",
                        animation: "cs-stripe 0.8s linear infinite",
                    }}
                />
                {/* Fill */}
                <div
                    className="relative h-full rounded-full bg-(--accent) shadow-sm"
                    style={{
                        width: `${progress}%`,
                        animation: "cs-progress 1.2s ease-out both",
                        transition: "width 0.6s cubic-bezier(0.34, 1.56, 0.64, 1)",
                    }}
                >
                    {/* Shine sweep */}
                    <div className="absolute inset-y-0 w-8 bg-white/30 skew-x-12" style={{ animation: "cs-sweep 2s ease-in-out infinite" }} />
                </div>
            </div>
        </div>
    );
}

/* ─── Terminal-style typing text ─────────────────────────────────────────── */
function TerminalLine({ text = "Building something great..." }) {
    const [displayed, setDisplayed] = useState("");
    const [idx, setIdx] = useState(0);

    useEffect(() => {
        if (idx >= text.length) return;
        const t = setTimeout(
            () => {
                setDisplayed((d) => d + text[idx]);
                setIdx((i) => i + 1);
            },
            38 + Math.random() * 22,
        );
        return () => clearTimeout(t);
    }, [idx, text]);

    return (
        <div className="flex items-center gap-2 font-mono text-sm text-black/50 dark:text-white/40">
            <span className="text-(--accent-foreground) select-none">$</span>
            <span>{displayed}</span>
            <span className="inline-block w-2 h-4 bg-(--accent) align-middle" style={{ animation: "cs-cursor 1s step-end infinite" }} />
        </div>
    );
}

/* ─── Main component ──────────────────────────────────────────────────────── */
export function ComingSoon({ title = "Coming Soon", subtitle = "We're laying the groundwork for something great. This page is currently under construction.", eta = "", feature = "", variant = "page", showProgress = false, progress = 0, onBack = null, backLabel = "Go back", className = "" }) {
    const containerRef = useRef(null);

    useEffect(() => {
        injectKeyframes();
    }, []);

    /* ── Wrapper classes per variant ── */
    const wrapperCls =
        {
            page: "min-h-screen w-full flex flex-col items-center justify-center px-6 py-16",
            overlay: "fixed inset-0 z-50 flex flex-col items-center justify-center px-6 py-16 backdrop-blur-sm",
            inline: "relative w-full flex flex-col items-center justify-center px-6 py-20",
        }[variant] ?? "min-h-screen w-full flex flex-col items-center justify-center px-6 py-16";

    const bgCls = variant === "overlay" ? "bg-white/90 dark:bg-(--bg-surface)/92" : "bg-(--bg-surface)";

    return (
        <div ref={containerRef} className={`${wrapperCls} ${bgCls} ${ANIMATE_PAGE_ENTER} ${className} font-aumovio overflow-hidden`}>
            {/* Background decoration — faint grid */}
            <div className="absolute inset-0 pointer-events-none select-none" aria-hidden="true" style={{ zIndex: 0 }}>
                {/* Corner tape strips */}
                <div
                    className="absolute top-0 left-0 w-full h-2"
                    style={{
                        backgroundImage: "repeating-linear-gradient(90deg,var(--accent) 0,var(--accent) 20px,#1a1a1a 20px,#1a1a1a 40px)",
                        backgroundSize: "40px 100%",
                        animation: "cs-tape 1s linear infinite",
                        opacity: 0.7,
                    }}
                />
                <div
                    className="absolute bottom-0 left-0 w-full h-2"
                    style={{
                        backgroundImage: "repeating-linear-gradient(90deg,var(--accent) 0,var(--accent) 20px,#1a1a1a 20px,#1a1a1a 40px)",
                        backgroundSize: "40px 100%",
                        animation: "cs-tape 1s linear infinite reverse",
                        opacity: 0.7,
                    }}
                />
                {/* Faint dot-grid pattern */}
                <div
                    className="absolute inset-0 opacity-30 dark:opacity-15"
                    style={{
                        backgroundImage: "radial-gradient(circle, var(--accent) 1px, transparent 1px)",
                        backgroundSize: "40px 40px",
                    }}
                />
                {/* Radial vignette */}
                <div
                    className="absolute inset-0"
                    style={{
                        background: "radial-gradient(ellipse 80% 60% at 50% 50%, transparent 40%, rgba(255,255,255,0.6) 100%)",
                    }}
                />
                <div
                    className="absolute inset-0 dark:block hidden"
                    style={{
                        background: "radial-gradient(ellipse 80% 60% at 50% 50%, transparent 40%, rgba(13,13,20,0.7) 100%)",
                    }}
                />

                {/* Floating left gear ambient */}
                <div className="absolute top-1/4 left-8 opacity-5 dark:opacity-10" style={{ animation: "cs-gear-a 20s linear infinite" }}>
                    <svg width="120" height="120" viewBox="0 0 120 120" fill="none">
                        <circle cx="60" cy="60" r="28" fill="var(--accent)" />
                        {[0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].map((deg) => (
                            <rect key={deg} x="56" y="4" width="8" height="18" rx="4" fill="var(--accent)" transform={`rotate(${deg} 60 60)`} />
                        ))}
                    </svg>
                </div>
                {/* Floating right gear ambient */}
                <div className="absolute bottom-1/4 right-8 opacity-5 dark:opacity-10" style={{ animation: "cs-gear-b 15s linear infinite" }}>
                    <svg width="90" height="90" viewBox="0 0 90 90" fill="none">
                        <circle cx="45" cy="45" r="20" fill="#4827AF" />
                        {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => (
                            <rect key={deg} x="42" y="3" width="6" height="14" rx="3" fill="#4827AF" transform={`rotate(${deg} 45 45)`} />
                        ))}
                    </svg>
                </div>
            </div>

            {/* ── Content ── */}
            <div className="relative flex flex-col items-center gap-6 w-full max-w-lg text-center" style={{ zIndex: 1 }}>
                {/* Illustration */}
                <div className={`${ANIMATE_FADE_IN_UP} ${ANIM_DELAY_100}`}>
                    <ScaffoldIllustration feature={feature || title} />
                </div>

                {/* Badge */}
                <div
                    className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full border font-aumovio-bold text-xs tracking-widest uppercase
                        bg-orange-400/10 dark:bg-orange-400/20 border-orange-400/25 text-(--accent-foreground)
                        ${ANIMATE_FADE_IN_UP} ${ANIM_DELAY_200}`}
                >
                    {/* Animated dot */}
                    <span className="relative flex h-2 w-2">
                        <span className={`absolute inline-flex h-full w-full rounded-full bg-(--accent) ${ANIMATE_PING}`} />
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-(--accent)" />
                    </span>
                    Under Construction
                </div>

                {/* Title */}
                <div className={`${ANIMATE_FADE_IN_UP} ${ANIM_DELAY_300}`}>
                    <h1 className="font-aumovio-bold tracking-tight leading-tight text-black dark:text-white" style={{ fontSize: "clamp(2rem, 6vw, 3.5rem)" }}>
                        {title}
                    </h1>
                </div>

                {/* Subtitle */}
                <p
                    className={`text-base leading-relaxed text-black/55 dark:text-white/55 max-w-sm font-aumovio
                        ${ANIMATE_FADE_IN_UP} ${ANIM_DELAY_400}`}
                >
                    {subtitle}
                </p>

                {/* Terminal line */}
                <div className={`${ANIMATE_FADE_IN_UP} ${ANIM_DELAY_500}`}>
                    <TerminalLine text={feature ? `npm run build -- --feature="${feature}"` : "npm run build -- --env=production"} />
                </div>

                {/* Progress bar */}
                {showProgress && (
                    <div className={`w-full ${ANIMATE_FADE_IN_UP} ${ANIM_DELAY_500}`}>
                        <ConstructionBar progress={progress} />
                    </div>
                )}

                {/* ETA chip */}
                {eta && (
                    <div
                        className={`flex items-center gap-2 px-4 py-2 rounded-xl border font-aumovio
                            bg-purple-400/8 dark:bg-purple-400/15 border-purple-400/20 dark:border-purple-400/30
                            text-purple-500 dark:text-purple-300 text-sm
                            ${ANIMATE_FADE_IN_UP} ${ANIM_DELAY_500}`}
                    >
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="shrink-0">
                            <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.5" />
                            <path d="M7 4v3.5l2 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                        </svg>
                        <span className="font-aumovio-bold">Expected:</span>
                        <span>{eta}</span>
                    </div>
                )}

                {/* Loading dots */}
                <div className={ANIMATE_FADE_IN_UP}>
                    <LoadingDots />
                </div>

                {/* Back button */}
                {onBack && (
                    <div className={`mt-2 ${ANIMATE_FADE_IN_UP}`}>
                        <Button variant="ghost" size="sm" onClick={onBack}>
                            ← {backLabel}
                        </Button>
                    </div>
                )}
            </div>
        </div>
    );
}

export default ComingSoon;
