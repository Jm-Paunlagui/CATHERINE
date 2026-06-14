/**
 * ClientErrorResponses.jsx — Playful, creative HTTP error pages.
 *
 * Each error has its own:
 *   - Unique SVG illustration with animations
 *   - Distinctive color mood (matching Aumovio brand)
 *   - Personality-driven copy
 *   - Rich thematic left & right side decorations (lg+ screens)
 *   - Light & dark mode support
 *
 * Exports: Unauthorized, BadRequest, PageNotFound,
 *          LoginTimeOut, InvalidToken, ServiceUnavailable
 */

import { useEffect } from "react";
import { NavLink, useLocation } from "react-router-dom";
import Button from "../../components/ui/Button";
import Divider from "../../components/ui/typography/Divider";
import { H2 } from "../../components/ui/typography/Heading";
import Paragraph from "../../components/ui/typography/Paragraph";
import Text from "../../components/ui/typography/Text";
import AuthMiddleware from "../../middleware/authentication/AuthMiddleware";
import CsrfMiddleware from "../../middleware/security/CsrfMiddleware";

/* ─── Shared keyframe injection ─────────────────────────────────────────────── */
const KEYFRAMES = `
  @keyframes err-float    { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-14px)} }
  @keyframes err-floatxs  { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-6px)} }
  @keyframes err-spin-slow{ to{transform:rotate(360deg)} }
  @keyframes err-spin-rev { to{transform:rotate(-360deg)} }
  @keyframes err-blink    { 0%,100%{opacity:1} 49%{opacity:1} 50%,99%{opacity:0} }
  @keyframes err-glitch   { 0%,100%{clip-path:inset(0)} 10%{clip-path:inset(20% 0 60% 0)} 20%{clip-path:inset(70% 0 5% 0)} 30%{clip-path:inset(40% 0 40% 0)} 40%{clip-path:inset(0)} }
  @keyframes err-shake    { 0%,100%{transform:rotate(-1deg)} 50%{transform:rotate(1deg)} }
  @keyframes err-pulse-op { 0%,100%{opacity:.35} 50%{opacity:.9} }
  @keyframes err-drift-l  { 0%,100%{transform:translateX(0)} 50%{transform:translateX(-8px)} }
  @keyframes err-drift-r  { 0%,100%{transform:translateX(0)} 50%{transform:translateX(8px)} }
  @keyframes err-drop     { 0%{transform:translateY(-6px);opacity:0} 100%{transform:translateY(0);opacity:1} }
  @keyframes err-slide-up { from{transform:translateY(30px);opacity:0} to{transform:translateY(0);opacity:1} }
  @keyframes err-zzz      { 0%{opacity:0;transform:translate(0,0) scale(.6)} 20%{opacity:1} 80%{opacity:1} 100%{opacity:0;transform:translate(12px,-20px) scale(1)} }
  @keyframes err-tick     { 0%,100%{transform:rotate(0deg)} 50%{transform:rotate(8deg)} }
  @keyframes err-sand     { 0%{transform:scaleY(1) translateY(0)} 100%{transform:scaleY(0) translateY(10px)} }
  @keyframes err-orbit    { from{transform:rotate(0deg) translateX(60px) rotate(0deg)} to{transform:rotate(360deg) translateX(60px) rotate(-360deg)} }
  @keyframes err-wander   { 0%,100%{transform:translate(0,0) rotate(0deg)} 25%{transform:translate(12px,-8px) rotate(5deg)} 75%{transform:translate(-8px,6px) rotate(-3deg)} }
  @keyframes err-static   { 0%,100%{opacity:.7} 25%{opacity:.3} 50%{opacity:1} 75%{opacity:.4} }
  @keyframes err-spark    { 0%,100%{transform:scale(1);opacity:.6} 50%{transform:scale(1.4);opacity:1} }
  @keyframes err-twinkle  { 0%,100%{opacity:.1;transform:scale(0.6)} 50%{opacity:1;transform:scale(1.4)} }
  @keyframes err-shoot    { 0%{transform:translate(0,0);opacity:1} 70%{opacity:.8} 100%{transform:translate(160px,160px);opacity:0} }
  @keyframes err-fly      { 0%,100%{transform:translate(0,0) rotate(-12deg)} 50%{transform:translate(8px,-18px) rotate(-6deg)} }
  @keyframes err-laser    { 0%,100%{opacity:.08} 50%{opacity:.5} }
  @keyframes err-code-fall{ 0%{transform:translateY(-30px);opacity:0} 15%{opacity:.6} 85%{opacity:.6} 100%{transform:translateY(320px);opacity:0} }
  @keyframes err-bob      { 0%,100%{transform:translateY(0) rotate(-3deg)} 50%{transform:translateY(-12px) rotate(3deg)} }
  @keyframes err-flicker  { 0%,100%{opacity:.8} 30%{opacity:.2} 60%{opacity:.9} 80%{opacity:.3} }
  @keyframes err-hexfall  { 0%{transform:translateY(-10px);opacity:.8} 100%{transform:translateY(240px);opacity:0} }
  @keyframes err-thunder  { 0%,100%{opacity:.5} 10%{opacity:1} 20%{opacity:.2} 35%{opacity:.9} 50%{opacity:.3} }
  @keyframes err-hand-sec { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
  @keyframes err-hand-min { from{transform:rotate(180deg)} to{transform:rotate(540deg)} }
  @keyframes err-page-fall{ 0%{transform:translateY(0) rotate(-5deg);opacity:1} 100%{transform:translateY(140px) rotate(25deg);opacity:0} }
  @keyframes err-circuit  { 0%{stroke-dashoffset:200} 100%{stroke-dashoffset:0} }
  @keyframes err-corrupt  { 0%,100%{transform:scaleX(1) translateX(0)} 25%{transform:scaleX(1.08) translateX(2px)} 50%{transform:scaleX(0.96) translateX(-3px)} 75%{transform:scaleX(1.04) translateX(1px)} }
  @keyframes err-scaffold { 0%,100%{opacity:.7} 50%{opacity:1} }
`;

let injected = false;
function injectKeyframes() {
    if (injected) return;
    injected = true;
    const s = document.createElement("style");
    s.textContent = KEYFRAMES;
    document.head.appendChild(s);
}

/* ─── Dynamic override resolution ───────────────────────────────────────────
 * Priority (highest → lowest):
 *   1. location.state.title / location.state.subtitle  — explicit caller override
 *   2. location.state._serverError.message             — server message via nav state
 *   3. titleProp / subtitleProp                        — route-level prop override
 *   4. defaultTitle / defaultSubtitle                  — component hardcoded copy
 */
function useErrorOverrides(defaultTitle, defaultSubtitle, titleProp, subtitleProp) {
    const { state } = useLocation();
    const title = state?.title ?? state?._serverError?.title ?? titleProp ?? defaultTitle;
    const subtitle = state?.subtitle ?? state?._serverError?.message ?? subtitleProp ?? defaultSubtitle;
    return { title, subtitle };
}

/* ─── Shared layout wrapper ──────────────────────────────────────────────────── */
function ErrorLayout({ code, title, subtitle, linkTo, linkLabel, accentClass, bgClass, illustration, leftDecor, rightDecor, children }) {
    useEffect(() => {
        injectKeyframes();
    }, []);

    return (
        <div className={`relative flex items-center justify-center min-h-screen overflow-hidden font-aumovio px-6 py-16 ${bgClass}`}>
            {/* Soft radial backdrop blob */}
            <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
                <div
                    className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full top-1/2 left-1/2 w-150 h-150 opacity-20 dark:opacity-10"
                    style={{
                        background: "radial-gradient(ellipse, currentColor 0%, transparent 70%)",
                    }}
                />
            </div>

            {/* ── Left side decoration (lg+ only) ── */}
            {leftDecor && (
                <div className="absolute top-0 bottom-0 left-0 hidden overflow-hidden pointer-events-none w-72 lg:block" aria-hidden="true">
                    {leftDecor}
                </div>
            )}

            {/* ── Right side decoration (lg+ only) ── */}
            {rightDecor && (
                <div className="absolute top-0 bottom-0 right-0 hidden overflow-hidden pointer-events-none w-72 lg:block" aria-hidden="true">
                    {rightDecor}
                </div>
            )}

            {/*
             * ── CENTER PIECE ──
             *
             * Mobile/tablet: single column, everything stacked + centered (same as before)
             * lg+: two-column grid — code on the left, content on the right
             */}
            <div className="relative z-10 grid grid-cols-1 gap-8 lg:grid-cols-2 lg:gap-0 lg:divide-x lg:divide-black/10 dark:lg:divide-white/10">
                {/* ── LEFT CELL — illustration + error code ── */}
                <div className="flex flex-col items-center justify-center lg:items-end lg:pr-12">
                    {/* Illustration */}
                    <div className="mb-6 drop-shadow-2xl" style={{ animation: "err-drop .6s ease both" }}>
                        {illustration}
                    </div>

                    {/* Error code — cinematic oversized display */}
                    <div style={{ animation: "err-slide-up .5s .1s ease both", opacity: 0 }}>
                        <Text variant="small" className="block mb-1 tracking-widest text-right uppercase opacity-50 lg:pr-1">
                            Error
                        </Text>
                        <h1 className={`font-aumovio-bold tracking-tight leading-none select-none text-right ${accentClass}`} style={{ fontSize: "clamp(5rem,12vw,9rem)" }}>
                            {code}
                        </h1>
                    </div>
                </div>

                {/* ── RIGHT CELL — title, subtitle, children, cta ── */}
                <div className="flex flex-col items-center justify-center gap-4 lg:items-start lg:pl-12 lg:max-w-10/12">
                    {/* Title — gradient shimmer for that magical touch */}
                    <div style={{ animation: "err-slide-up .5s .2s ease both", opacity: 0 }}>
                        <H2 size="h3" gradient align="center" className="lg:text-left">
                            {title}
                        </H2>
                    </div>

                    {/* Subtitle — cinematic lead paragraph */}
                    <div style={{ animation: "err-slide-up .5s .3s ease both", opacity: 0 }}>
                        <Paragraph lead className="max-w-sm text-center lg:text-left">
                            {subtitle}
                        </Paragraph>
                    </div>

                    {/* Gradient divider — visual breathing room */}
                    <div className="w-full max-w-sm" style={{ animation: "err-slide-up .5s .33s ease both", opacity: 0 }}>
                        <Divider variant="gradient" spacing="sm" />
                    </div>

                    {children && (
                        <div
                            className="w-full max-w-sm text-center lg:text-left"
                            style={{
                                animation: "err-slide-up .5s .35s ease both",
                                opacity: 0,
                            }}
                        >
                            {children}
                        </div>
                    )}

                    <div
                        style={{
                            animation: "err-slide-up .5s .4s ease both",
                            opacity: 0,
                        }}
                    >
                        <NavLink to={linkTo}>
                            <Button variant="primary" size="lg" rounded>
                                {linkLabel}
                            </Button>
                        </NavLink>
                    </div>
                </div>
            </div>
        </div>
    );
}

/* ══════════════════════════════════════════════════════════════════════════════
   SPACE DECORS  (404)
   ══════════════════════════════════════════════════════════════════════════════ */
function SpaceLeftDecor() {
    const stars = [
        [22, "8%"],
        [68, "14%"],
        [12, "28%"],
        [88, "22%"],
        [45, "42%"],
        [80, "50%"],
        [30, "63%"],
        [92, "70%"],
        [18, "85%"],
        [70, "90%"],
        [50, "96%"],
    ];
    return (
        <div className="absolute inset-0">
            {/* Large ringed planet (Saturn-like) */}
            <div
                className="absolute"
                style={{
                    left: -30,
                    top: "12%",
                    animation: "err-float 7s ease-in-out infinite",
                }}
            >
                <svg width="180" height="160" viewBox="0 0 180 160" fill="none">
                    <defs>
                        <radialGradient id="sp-planet" cx="35%" cy="32%">
                            <stop offset="0%" stopColor="#818cf8" />
                            <stop offset="55%" stopColor="#4827AF" />
                            <stop offset="100%" stopColor="#1e0a4a" />
                        </radialGradient>
                        <linearGradient id="sp-ring1" x1="0%" y1="0%" x2="100%" y2="0%">
                            <stop offset="0%" stopColor="#a78bfa" stopOpacity="0" />
                            <stop offset="25%" stopColor="#a78bfa" stopOpacity="0.7" />
                            <stop offset="75%" stopColor="#c084fc" stopOpacity="0.7" />
                            <stop offset="100%" stopColor="#c084fc" stopOpacity="0" />
                        </linearGradient>
                        <linearGradient id="sp-ring2" x1="0%" y1="0%" x2="100%" y2="0%">
                            <stop offset="0%" stopColor="#e879f9" stopOpacity="0" />
                            <stop offset="50%" stopColor="#e879f9" stopOpacity="0.4" />
                            <stop offset="100%" stopColor="#e879f9" stopOpacity="0" />
                        </linearGradient>
                    </defs>
                    {/* Ring shadow behind planet */}
                    <ellipse cx="90" cy="80" rx="86" ry="20" fill="none" stroke="#4827AF" strokeWidth="10" opacity="0.3" />
                    {/* Planet body */}
                    <circle cx="90" cy="80" r="56" fill="url(#sp-planet)" opacity="0.9" />
                    {/* Surface bands */}
                    <ellipse cx="74" cy="64" rx="20" ry="9" fill="rgba(139,92,246,0.25)" />
                    <ellipse cx="100" cy="96" rx="26" ry="8" fill="rgba(99,102,241,0.2)" />
                    {/* Highlight */}
                    <ellipse cx="70" cy="58" rx="16" ry="10" fill="rgba(255,255,255,0.12)" />
                    {/* Rings in front */}
                    <ellipse cx="90" cy="80" rx="86" ry="20" fill="none" stroke="url(#sp-ring1)" strokeWidth="7" />
                    <ellipse cx="90" cy="80" rx="74" ry="16" fill="none" stroke="url(#sp-ring2)" strokeWidth="3.5" />
                </svg>
            </div>

            {/* Constellation */}
            <svg className="absolute" style={{ left: 60, top: "48%" }} width="130" height="110" viewBox="0 0 130 110" fill="none">
                {[
                    [12, 22],
                    [54, 10],
                    [84, 42],
                    [62, 74],
                    [18, 62],
                    [96, 82],
                    [48, 48],
                ].map(([x, y], i) => (
                    <circle
                        key={i}
                        cx={x}
                        cy={y}
                        r={i === 2 || i === 4 ? 3 : 2}
                        fill="#93c5fd"
                        style={{
                            animation: `err-twinkle ${1.4 + i * 0.45}s ${i * 0.28}s ease-in-out infinite`,
                        }}
                    />
                ))}
                <path d="M12 22 L54 10 L84 42 L96 82 M84 42 L62 74 L18 62 L12 22 M54 10 L48 48 L62 74" stroke="#93c5fd" strokeWidth="0.8" strokeDasharray="3 3" opacity="0.3" />
            </svg>

            {/* Asteroid 1 */}
            <div
                className="absolute"
                style={{
                    left: 35,
                    top: "72%",
                    animation: "err-wander 8s ease-in-out infinite",
                }}
            >
                <svg width="38" height="26" viewBox="0 0 38 26" fill="none">
                    <path d="M4 13 C4 8 8 3 16 2 C24 1 34 6 36 13 C38 20 32 24 22 25 C12 26 4 18 4 13Z" fill="#78716c" opacity="0.7" />
                    <circle cx="10" cy="10" r="2.5" fill="#57534e" opacity="0.8" />
                    <circle cx="24" cy="16" r="2" fill="#57534e" opacity="0.7" />
                    <circle cx="18" cy="8" r="1.5" fill="#57534e" opacity="0.6" />
                </svg>
            </div>

            {/* Asteroid 2 */}
            <div
                className="absolute"
                style={{
                    left: 8,
                    top: "83%",
                    animation: "err-wander 5.5s 1.5s ease-in-out infinite",
                }}
            >
                <svg width="24" height="16" viewBox="0 0 24 16" fill="none">
                    <path d="M2 8 C2 4 5 1 12 1 C19 1 22 5 22 8 C22 11 19 15 12 15 C5 15 2 12 2 8Z" fill="#78716c" opacity="0.55" />
                    <circle cx="7" cy="6" r="1.5" fill="#57534e" opacity="0.7" />
                </svg>
            </div>

            {/* Nebula wisp top-left */}
            <div className="absolute" style={{ left: -10, top: "35%" }}>
                <svg width="120" height="70" viewBox="0 0 120 70" fill="none" opacity="0.15">
                    <defs>
                        <radialGradient id="sp-neb1">
                            <stop offset="0%" stopColor="#818cf8" stopOpacity="0.9" />
                            <stop offset="100%" stopColor="#c084fc" stopOpacity="0" />
                        </radialGradient>
                    </defs>
                    <ellipse cx="60" cy="35" rx="58" ry="30" fill="url(#sp-neb1)" />
                </svg>
            </div>

            {/* Satellite */}
            <div
                className="absolute"
                style={{
                    left: 60,
                    top: "30%",
                    animation: "err-wander 9s 1s ease-in-out infinite",
                }}
            >
                <svg width="70" height="50" viewBox="0 0 70 50" fill="none" opacity="0.7">
                    {/* Solar panels */}
                    <rect x="0" y="16" width="22" height="18" rx="2" fill="none" stroke="#60a5fa" strokeWidth="1.5" />
                    {[0, 1, 2].map((i) => (
                        <line key={i} x1={7 + i * 7} y1="16" x2={7 + i * 7} y2="34" stroke="#60a5fa" strokeWidth="0.8" opacity="0.5" />
                    ))}
                    <rect x="48" y="16" width="22" height="18" rx="2" fill="none" stroke="#60a5fa" strokeWidth="1.5" />
                    {[0, 1, 2].map((i) => (
                        <line key={i} x1={55 + i * 7} y1="16" x2={55 + i * 7} y2="34" stroke="#60a5fa" strokeWidth="0.8" opacity="0.5" />
                    ))}
                    {/* Body */}
                    <rect x="22" y="18" width="26" height="14" rx="3" fill="#1e293b" stroke="#60a5fa" strokeWidth="1.5" />
                    {/* Connector arms */}
                    <line x1="22" y1="25" x2="0" y2="25" stroke="#60a5fa" strokeWidth="1.5" />
                    <line x1="48" y1="25" x2="70" y2="25" stroke="#60a5fa" strokeWidth="1.5" />
                    {/* Antenna */}
                    <line x1="35" y1="18" x2="35" y2="8" stroke="#93c5fd" strokeWidth="1.2" />
                    <circle
                        cx="35"
                        cy="6"
                        r="2.5"
                        fill="#93c5fd"
                        style={{
                            animation: "err-pulse-op 1.5s ease-in-out infinite",
                        }}
                    />
                </svg>
            </div>

            {/* Comet */}
            <div
                className="absolute"
                style={{
                    left: 5,
                    top: "56%",
                    animation: "err-drift-r 4s 2s ease-in-out infinite",
                }}
            >
                <svg width="100" height="20" viewBox="0 0 100 20" fill="none">
                    <defs>
                        <linearGradient id="sp-comet-l" x1="100%" y1="0%" x2="0%" y2="0%">
                            <stop offset="0%" stopColor="white" />
                            <stop offset="100%" stopColor="white" stopOpacity="0" />
                        </linearGradient>
                    </defs>
                    <path d="M100 10 L0 10" stroke="url(#sp-comet-l)" strokeWidth="2" opacity="0.5" />
                    <circle cx="98" cy="10" r="4" fill="white" opacity="0.9" />
                    <ellipse cx="94" cy="10" rx="6" ry="3" fill="white" opacity="0.2" />
                </svg>
            </div>

            {/* Space debris / small rocks */}
            {[
                [14, "95%", 8],
                [55, "97%", 5],
                [80, "93%", 6],
            ].map(([left, top, size], i) => (
                <div
                    key={i}
                    className="absolute"
                    style={{
                        left,
                        top,
                        animation: `err-wander ${4 + i * 1.5}s ${i}s ease-in-out infinite`,
                    }}
                >
                    <svg width={size * 2} height={size * 1.4} viewBox={`0 0 ${size * 2} ${size * 1.4}`} fill="none">
                        <ellipse cx={size} cy={size * 0.7} rx={size * 0.9} ry={size * 0.6} fill="#78716c" opacity="0.55" />
                    </svg>
                </div>
            ))}

            {/* Twinkling stars */}
            {stars.map(([left, top], i) => (
                <div
                    key={i}
                    className="absolute bg-white rounded-full"
                    style={{
                        left,
                        top,
                        width: i % 4 === 0 ? 3 : i % 3 === 0 ? 2 : 1.5,
                        height: i % 4 === 0 ? 3 : i % 3 === 0 ? 2 : 1.5,
                        animation: `err-twinkle ${1.2 + i * 0.4}s ${i * 0.18}s ease-in-out infinite`,
                    }}
                />
            ))}

            {/* Deep space dust lane */}
            <div className="absolute" style={{ left: -20, top: "20%" }}>
                <svg width="140" height="180" viewBox="0 0 140 180" fill="none" opacity="0.08">
                    <defs>
                        <radialGradient id="sp-dust-l">
                            <stop offset="0%" stopColor="#a5b4fc" stopOpacity="1" />
                            <stop offset="100%" stopColor="#a5b4fc" stopOpacity="0" />
                        </radialGradient>
                    </defs>
                    <ellipse cx="70" cy="90" rx="70" ry="88" fill="url(#sp-dust-l)" />
                </svg>
            </div>
        </div>
    );
}

function SpaceRightDecor() {
    const stars = [
        [25, "6%"],
        [62, "12%"],
        [18, "26%"],
        [78, "20%"],
        [40, "38%"],
        [85, "48%"],
        [22, "60%"],
        [60, "68%"],
        [10, "80%"],
        [75, "88%"],
        [45, "94%"],
    ];
    return (
        <div className="absolute inset-0">
            {/* Rocket ship */}
            <div
                className="absolute"
                style={{
                    right: 30,
                    top: "8%",
                    animation: "err-fly 5s ease-in-out infinite",
                }}
            >
                <svg width="58" height="130" viewBox="0 0 58 130" fill="none">
                    <defs>
                        <linearGradient id="sp-rocket-body" x1="0%" y1="0%" x2="100%" y2="0%">
                            <stop offset="0%" stopColor="#cbd5e1" />
                            <stop offset="100%" stopColor="#e2e8f0" />
                        </linearGradient>
                    </defs>
                    {/* Body */}
                    <path d="M29 4 C18 28 14 52 14 72 L44 72 C44 52 40 28 29 4Z" fill="url(#sp-rocket-body)" stroke="#94a3b8" strokeWidth="1" />
                    {/* Nose */}
                    <path d="M29 4 C22 18 18 30 18 38 L40 38 C40 30 36 18 29 4Z" fill="#f97316" />
                    {/* Window */}
                    <circle cx="29" cy="54" r="9" fill="#bfdbfe" stroke="#93c5fd" strokeWidth="2" />
                    <circle cx="29" cy="54" r="5.5" fill="#3b82f6" opacity="0.6" />
                    <circle cx="27" cy="52" r="2" fill="white" opacity="0.4" />
                    {/* Left fin */}
                    <path d="M14 72 L2 95 L14 88Z" fill="#f97316" />
                    {/* Right fin */}
                    <path d="M44 72 L56 95 L44 88Z" fill="#f97316" />
                    {/* Exhaust */}
                    <path
                        d="M18 72 C21 88 25 100 29 112 C33 100 37 88 40 72Z"
                        fill="#fb923c"
                        opacity="0.85"
                        style={{
                            animation: "err-pulse-op .35s ease-in-out infinite",
                        }}
                    />
                    <path
                        d="M22 76 C25 90 27 102 29 112 C31 102 33 90 36 76Z"
                        fill="#fde68a"
                        opacity="0.95"
                        style={{
                            animation: "err-pulse-op .28s .08s ease-in-out infinite",
                        }}
                    />
                    <path
                        d="M25 80 C27 92 28 104 29 112 C30 104 31 92 33 80Z"
                        fill="white"
                        opacity="0.6"
                        style={{
                            animation: "err-pulse-op .22s .05s ease-in-out infinite",
                        }}
                    />
                </svg>
            </div>

            {/* Galaxy spiral */}
            <div
                className="absolute"
                style={{
                    right: 5,
                    top: "38%",
                    animation: "err-spin-slow 40s linear infinite",
                    opacity: 0.35,
                }}
            >
                <svg width="110" height="110" viewBox="0 0 110 110" fill="none">
                    <defs>
                        <linearGradient id="sp-galaxy" x1="0%" y1="0%" x2="100%" y2="100%">
                            <stop offset="0%" stopColor="#818cf8" />
                            <stop offset="50%" stopColor="#c084fc" />
                            <stop offset="100%" stopColor="#f472b6" />
                        </linearGradient>
                    </defs>
                    <path d="M55 55 C62 42 76 36 84 48 C92 60 78 74 64 76 C44 80 26 64 30 46 C34 28 56 16 74 24 C92 32 102 56 94 74 C86 92 60 102 42 94" stroke="url(#sp-galaxy)" strokeWidth="3.5" fill="none" strokeLinecap="round" opacity="0.8" />
                    <circle cx="55" cy="55" r="5" fill="white" opacity="0.9" />
                    <circle cx="55" cy="55" r="10" fill="url(#sp-galaxy)" opacity="0.3" />
                    {[0, 60, 120, 180, 240, 300].map((deg, i) => (
                        <circle key={i} cx={55 + 18 * Math.cos((deg * Math.PI) / 180)} cy={55 + 18 * Math.sin((deg * Math.PI) / 180)} r="1.5" fill="white" opacity={0.4 + i * 0.08} />
                    ))}
                </svg>
            </div>

            {/* Orange planet (Mars-like) */}
            <div
                className="absolute"
                style={{
                    right: 55,
                    top: "28%",
                    animation: "err-floatxs 4s ease-in-out infinite",
                }}
            >
                <svg width="42" height="42" viewBox="0 0 42 42" fill="none">
                    <defs>
                        <radialGradient id="sp-mars" cx="35%" cy="32%">
                            <stop offset="0%" stopColor="#fb923c" />
                            <stop offset="100%" stopColor="#9a3412" />
                        </radialGradient>
                    </defs>
                    <circle cx="21" cy="21" r="19" fill="url(#sp-mars)" />
                    <ellipse cx="15" cy="14" rx="6" ry="4" fill="rgba(255,255,255,0.1)" />
                    <ellipse cx="26" cy="26" rx="8" ry="3" fill="rgba(0,0,0,0.15)" />
                </svg>
            </div>

            {/* Small teal planet */}
            <div
                className="absolute"
                style={{
                    right: 18,
                    top: "60%",
                    animation: "err-float 6s 2s ease-in-out infinite",
                }}
            >
                <svg width="30" height="30" viewBox="0 0 30 30" fill="none">
                    <defs>
                        <radialGradient id="sp-teal" cx="35%" cy="32%">
                            <stop offset="0%" stopColor="#34d399" />
                            <stop offset="100%" stopColor="#064e3b" />
                        </radialGradient>
                    </defs>
                    <circle cx="15" cy="15" r="13" fill="url(#sp-teal)" />
                    <ellipse cx="10" cy="10" rx="4" ry="3" fill="rgba(255,255,255,0.12)" />
                </svg>
            </div>

            {/* Shooting star */}
            <div
                className="absolute"
                style={{
                    right: 80,
                    top: "18%",
                    animation: "err-shoot 4s 1.5s ease-in-out infinite",
                }}
            >
                <svg width="50" height="12" viewBox="0 0 50 12" fill="none">
                    <defs>
                        <linearGradient id="sp-shoot" x1="100%" y1="0%" x2="0%" y2="0%">
                            <stop offset="0%" stopColor="white" />
                            <stop offset="100%" stopColor="white" stopOpacity="0" />
                        </linearGradient>
                    </defs>
                    <path d="M50 6 L0 6" stroke="url(#sp-shoot)" strokeWidth="1.5" />
                    <circle cx="50" cy="6" r="3.5" fill="white" style={{ filter: "blur(1px)" }} />
                </svg>
            </div>

            {/* Second shooting star */}
            <div
                className="absolute"
                style={{
                    right: 40,
                    top: "72%",
                    animation: "err-shoot 5.5s 3s ease-in-out infinite",
                }}
            >
                <svg width="35" height="8" viewBox="0 0 35 8" fill="none">
                    <defs>
                        <linearGradient id="sp-shoot2" x1="100%" y1="0%" x2="0%" y2="0%">
                            <stop offset="0%" stopColor="#93c5fd" />
                            <stop offset="100%" stopColor="#93c5fd" stopOpacity="0" />
                        </linearGradient>
                    </defs>
                    <path d="M35 4 L0 4" stroke="url(#sp-shoot2)" strokeWidth="1.2" />
                    <circle cx="35" cy="4" r="2.5" fill="#93c5fd" />
                </svg>
            </div>

            {/* Nebula bottom-right */}
            <div className="absolute" style={{ right: -20, top: "78%" }}>
                <svg width="150" height="90" viewBox="0 0 150 90" fill="none" opacity="0.18">
                    <defs>
                        <radialGradient id="sp-neb2">
                            <stop offset="0%" stopColor="#6366f1" stopOpacity="0.9" />
                            <stop offset="100%" stopColor="#a855f7" stopOpacity="0" />
                        </radialGradient>
                    </defs>
                    <ellipse cx="75" cy="45" rx="72" ry="38" fill="url(#sp-neb2)" />
                </svg>
            </div>

            {/* Stars */}
            {stars.map(([right, top], i) => (
                <div
                    key={i}
                    className="absolute bg-white rounded-full"
                    style={{
                        right,
                        top,
                        width: i % 4 === 0 ? 3 : i % 3 === 0 ? 2 : 1.5,
                        height: i % 4 === 0 ? 3 : i % 3 === 0 ? 2 : 1.5,
                        animation: `err-twinkle ${1.3 + i * 0.38}s ${i * 0.22}s ease-in-out infinite`,
                    }}
                />
            ))}

            {/* Alien planet bottom-right */}
            <div
                className="absolute"
                style={{
                    right: -20,
                    top: "85%",
                    animation: "err-floatxs 7s 1s ease-in-out infinite",
                }}
            >
                <svg width="110" height="80" viewBox="0 0 110 80" fill="none">
                    <defs>
                        <radialGradient id="sp-alien" cx="35%" cy="32%">
                            <stop offset="0%" stopColor="#4ade80" />
                            <stop offset="100%" stopColor="#14532d" />
                        </radialGradient>
                        <linearGradient id="sp-alien-ring" x1="0%" y1="0%" x2="100%" y2="0%">
                            <stop offset="0%" stopColor="#86efac" stopOpacity="0" />
                            <stop offset="50%" stopColor="#86efac" stopOpacity="0.6" />
                            <stop offset="100%" stopColor="#86efac" stopOpacity="0" />
                        </linearGradient>
                    </defs>
                    <ellipse cx="55" cy="45" rx="50" ry="12" fill="none" stroke="url(#sp-alien-ring)" strokeWidth="5" opacity="0.7" />
                    <circle cx="55" cy="45" r="34" fill="url(#sp-alien)" opacity="0.85" />
                    <ellipse cx="44" cy="36" rx="10" ry="7" fill="rgba(255,255,255,0.1)" />
                    <ellipse cx="62" cy="52" rx="14" ry="5" fill="rgba(0,0,0,0.15)" />
                    <ellipse cx="55" cy="45" rx="50" ry="12" fill="none" stroke="url(#sp-alien-ring)" strokeWidth="3" opacity="0.4" />
                </svg>
            </div>

            {/* Space telescope */}
            <div
                className="absolute"
                style={{
                    right: 48,
                    top: "52%",
                    animation: "err-wander 11s 2s ease-in-out infinite",
                }}
            >
                <svg width="55" height="70" viewBox="0 0 55 70" fill="none" opacity="0.65">
                    {/* Main tube */}
                    <rect x="18" y="10" width="20" height="45" rx="3" fill="#334155" stroke="#60a5fa" strokeWidth="1.2" />
                    {/* Aperture */}
                    <ellipse cx="28" cy="10" rx="12" ry="5" fill="#1e3a5f" stroke="#60a5fa" strokeWidth="1.2" />
                    {/* Solar panel */}
                    <rect x="0" y="22" width="15" height="22" rx="2" fill="none" stroke="#818cf8" strokeWidth="1.2" />
                    {[0, 1, 2].map((i) => (
                        <line key={i} x1={5 + i * 5} y1="22" x2={5 + i * 5} y2="44" stroke="#818cf8" strokeWidth="0.7" opacity="0.5" />
                    ))}
                    <line x1="15" y1="33" x2="18" y2="33" stroke="#818cf8" strokeWidth="1" />
                    {/* Thruster */}
                    <path
                        d="M24 55 L20 65 L28 62 L36 65 L32 55Z"
                        fill="#f97316"
                        opacity="0.5"
                        style={{
                            animation: "err-pulse-op .4s ease-in-out infinite",
                        }}
                    />
                </svg>
            </div>

            {/* Star cluster */}
            <div className="absolute" style={{ right: 5, top: "80%" }}>
                <svg width="90" height="50" viewBox="0 0 90 50" fill="none">
                    {[
                        [15, 25, 4],
                        [30, 10, 3],
                        [50, 30, 5],
                        [65, 15, 3],
                        [75, 38, 4],
                        [40, 42, 3],
                        [10, 40, 2],
                    ].map(([cx, cy, r], i) => (
                        <circle
                            key={i}
                            cx={cx}
                            cy={cy}
                            r={r}
                            fill="white"
                            opacity={0.3 + i * 0.08}
                            style={{
                                animation: `err-twinkle ${1.2 + i * 0.4}s ${i * 0.2}s ease-in-out infinite`,
                            }}
                        />
                    ))}
                    {/* Cluster glow */}
                    <ellipse cx="44" cy="26" rx="40" ry="22" fill="white" opacity="0.04" />
                </svg>
            </div>

            {/* Space station ring */}
            <div
                className="absolute"
                style={{
                    right: 15,
                    top: "42%",
                    animation: "err-spin-slow 25s linear infinite",
                }}
            >
                <svg width="50" height="50" viewBox="0 0 50 50" fill="none" opacity="0.4">
                    <circle cx="25" cy="25" r="20" fill="none" stroke="#93c5fd" strokeWidth="2" strokeDasharray="6 4" />
                    <circle cx="25" cy="5" r="4" fill="#60a5fa" />
                    <circle cx="25" cy="45" r="4" fill="#60a5fa" />
                    <circle cx="5" cy="25" r="4" fill="#60a5fa" />
                    <circle cx="45" cy="25" r="4" fill="#60a5fa" />
                    <circle cx="25" cy="25" r="5" fill="#1e40af" stroke="#60a5fa" strokeWidth="1.5" />
                </svg>
            </div>
        </div>
    );
}

/* ══════════════════════════════════════════════════════════════════════════════
   TERMINAL DECORS  (400)
   ══════════════════════════════════════════════════════════════════════════════ */
function TerminalLeftDecor() {
    const codeLines = ["01001000 01100101", "NaN !== NaN", "undefined.map()", "{ ¿¿id¿¿: null }", "0x00 0xFF 0xAA", "¡¿syntax error?!", "null.toString()", "⟨◆☒⟩: undefined"];
    return (
        <div className="absolute inset-0">
            {/* Broken monitor */}
            <div
                className="absolute"
                style={{
                    left: 8,
                    top: "10%",
                    animation: "err-shake 3s ease-in-out infinite",
                }}
            >
                <svg width="150" height="110" viewBox="0 0 150 110" fill="none">
                    <rect x="4" y="4" width="142" height="92" rx="6" fill="#111827" stroke="#374151" strokeWidth="2" />
                    <rect x="10" y="10" width="130" height="80" rx="3" fill="#0f172a" />
                    {/* Crack lines on screen */}
                    <path d="M60 10 L45 45 L80 90" stroke="#fbbf24" strokeWidth="1.5" opacity="0.6" strokeLinecap="round" />
                    <path d="M45 45 L20 70" stroke="#fbbf24" strokeWidth="1" opacity="0.4" strokeLinecap="round" />
                    {/* Screen content */}
                    <text
                        x="16"
                        y="28"
                        fontFamily="monospace"
                        fontSize="7"
                        fill="#ef4444"
                        style={{
                            animation: "err-glitch 4s ease-in-out infinite",
                        }}
                    >
                        ERROR: Malformed request body
                    </text>
                    <text x="16" y="40" fontFamily="monospace" fontSize="7" fill="#fbbf24" opacity="0.7">
                        at parseJSON (utils.js:42)
                    </text>
                    <text x="16" y="52" fontFamily="monospace" fontSize="7" fill="#fbbf24" opacity="0.5">
                        at Request.handle (app.js:18)
                    </text>
                    <text x="16" y="68" fontFamily="monospace" fontSize="7" fill="#ef4444">
                        ▌
                    </text>
                    {/* Monitor stand */}
                    <rect x="65" y="96" width="20" height="8" rx="2" fill="#374151" />
                    <rect x="55" y="104" width="40" height="4" rx="2" fill="#374151" />
                </svg>
            </div>

            {/* Falling binary columns */}
            {[0, 1, 2].map((col) => (
                <div
                    key={col}
                    className="absolute overflow-hidden font-mono text-xs leading-5 text-warn-400/50"
                    style={{
                        left: 16 + col * 28,
                        top: "38%",
                        height: 200,
                        animation: `err-code-fall ${3 + col * 0.8}s ${col * 0.6}s linear infinite`,
                    }}
                >
                    {["1", "0", "1", "1", "0", "0", "1", "0", "1", "0", "1"].map((b, i) => (
                        <div key={i} style={{ opacity: 0.3 + (i % 3) * 0.25 }}>
                            {b}
                        </div>
                    ))}
                </div>
            ))}

            {/* Floating error tags */}
            {["NaN", "null", "???", "!err"].map((tag, i) => (
                <div
                    key={i}
                    className="absolute font-mono text-xs font-bold text-warn-500 bg-warn-100/20 border border-warn-400/30 rounded px-2 py-0.5"
                    style={{
                        left: 10 + (i % 2) * 55,
                        top: `${60 + i * 8}%`,
                        animation: `err-drift-${i % 2 === 0 ? "l" : "r"} ${2.5 + i * 0.4}s ${i * 0.3}s ease-in-out infinite`,
                    }}
                >
                    {tag}
                </div>
            ))}

            {/* Warning triangle cluster bottom */}
            <div
                className="absolute"
                style={{
                    left: 20,
                    top: "88%",
                    animation: "err-floatxs 3s ease-in-out infinite",
                }}
            >
                <svg width="100" height="40" viewBox="0 0 100 40" fill="none" opacity="0.5">
                    {[
                        [10, 35, 30],
                        [50, 35, 22],
                        [80, 38, 16],
                    ].map(([cx, cy, r], i) => (
                        <path
                            key={i}
                            d={`M${cx} ${cy - r * 1.1} L${cx - r} ${cy + r * 0.6} L${cx + r} ${cy + r * 0.6}Z`}
                            fill="none"
                            stroke="#f59e0b"
                            strokeWidth="1.8"
                            style={{
                                animation: `err-pulse-op ${1.5 + i * 0.5}s ${i * 0.3}s ease-in-out infinite`,
                            }}
                        />
                    ))}
                </svg>
            </div>

            {/* Cascading error scrollback */}
            <div className="absolute overflow-hidden" style={{ left: 8, top: "52%", width: 160, height: 130 }}>
                {["  WARN: body undefined", "  ERR: schema mismatch", "  FATAL: parse failed", "  at Router.handle", "  at Layer.handle", "  at next (/app)", "  {status: 400}"].map((line, i) => (
                    <div
                        key={i}
                        className="font-mono text-xs leading-5 whitespace-nowrap"
                        style={{
                            color: i === 2 ? "#ef4444" : i === 0 ? "#f59e0b" : "#6b7280",
                            opacity: 0.5 + (i % 3) * 0.15,
                            animation: `err-drift-l ${3 + i * 0.3}s ${i * 0.2}s ease-in-out infinite`,
                        }}
                    >
                        {line}
                    </div>
                ))}
            </div>

            {/* Glitching progress bar */}
            <div className="absolute" style={{ left: 10, top: "79%" }}>
                <svg width="140" height="20" viewBox="0 0 140 20" fill="none" opacity="0.5">
                    <rect x="0" y="6" width="140" height="8" rx="4" fill="#1f2937" stroke="#374151" strokeWidth="1" />
                    <rect
                        x="0"
                        y="6"
                        width="72"
                        height="8"
                        rx="4"
                        fill="#ef4444"
                        style={{
                            animation: "err-static 1.2s ease-in-out infinite",
                        }}
                    />
                    <rect
                        x="72"
                        y="6"
                        width="24"
                        height="8"
                        rx="0"
                        fill="#f59e0b"
                        opacity="0.6"
                        style={{
                            animation: "err-static 0.9s 0.3s ease-in-out infinite",
                        }}
                    />
                    <text x="5" y="16" fontFamily="monospace" fontSize="6" fill="#9ca3af">
                        PROCESSING... ERR
                    </text>
                </svg>
            </div>

            {/* USB / connector plug */}
            <div
                className="absolute"
                style={{
                    left: 30,
                    top: "95%",
                    animation: "err-bob 5s ease-in-out infinite",
                }}
            >
                <svg width="60" height="30" viewBox="0 0 60 30" fill="none" opacity="0.5">
                    <rect x="0" y="10" width="35" height="10" rx="2" fill="#374151" stroke="#6b7280" strokeWidth="1" />
                    <rect x="35" y="6" width="20" height="18" rx="2" fill="#1f2937" stroke="#4b5563" strokeWidth="1" />
                    <rect x="38" y="10" width="4" height="5" rx="1" fill="#6b7280" />
                    <rect x="46" y="10" width="4" height="5" rx="1" fill="#6b7280" />
                    <line x1="55" y1="15" x2="60" y2="15" stroke="#6b7280" strokeWidth="1.5" />
                </svg>
            </div>
        </div>
    );
}

function TerminalRightDecor() {
    const errors = ["undefined", "TypeError", "RangeError", "SyntaxErr", "¿¿¿???"];
    return (
        <div className="absolute inset-0">
            {/* Floating error label cards */}
            {errors.map((label, i) => (
                <div
                    key={i}
                    className="absolute font-mono text-xs font-bold"
                    style={{
                        right: 12 + (i % 2) * 40,
                        top: `${8 + i * 15}%`,
                        animation: `err-drift-${i % 2 === 0 ? "r" : "l"} ${2 + i * 0.5}s ${i * 0.25}s ease-in-out infinite`,
                        color: i === 0 ? "#ef4444" : i === 2 ? "#f59e0b" : "#fbbf24",
                        opacity: 0.5 + (i % 3) * 0.2,
                    }}
                >
                    <span className="bg-grey-900/80 dark:bg-black/60 border border-warn-400/20 rounded px-2 py-0.5">{label}</span>
                </div>
            ))}

            {/* Large glitch block decoration */}
            <div
                className="absolute"
                style={{
                    right: 5,
                    top: "35%",
                    animation: "err-glitch 3s ease-in-out infinite",
                }}
            >
                <svg width="130" height="80" viewBox="0 0 130 80" fill="none" opacity="0.3">
                    <rect x="0" y="10" width="130" height="12" rx="2" fill="#f59e0b" />
                    <rect x="15" y="30" width="100" height="8" rx="2" fill="#fbbf24" />
                    <rect x="5" y="46" width="120" height="10" rx="2" fill="#f59e0b" opacity="0.6" />
                    <rect x="30" y="62" width="80" height="6" rx="2" fill="#fbbf24" opacity="0.4" />
                    {/* Glitch slices */}
                    <rect
                        x="0"
                        y="10"
                        width="40"
                        height="4"
                        rx="0"
                        fill="#ef4444"
                        opacity="0.5"
                        style={{
                            animation: "err-static 1s ease-in-out infinite",
                        }}
                    />
                    <rect
                        x="80"
                        y="30"
                        width="50"
                        height="4"
                        rx="0"
                        fill="#ef4444"
                        opacity="0.4"
                        style={{
                            animation: "err-static 1.3s 0.2s ease-in-out infinite",
                        }}
                    />
                </svg>
            </div>

            {/* Confused robot/computer face */}
            <div
                className="absolute"
                style={{
                    right: 20,
                    top: "60%",
                    animation: "err-bob 4s ease-in-out infinite",
                }}
            >
                <svg width="80" height="90" viewBox="0 0 80 90" fill="none">
                    {/* Head */}
                    <rect x="10" y="10" width="60" height="55" rx="8" fill="#1f2937" stroke="#374151" strokeWidth="2" />
                    {/* Antenna */}
                    <line x1="40" y1="10" x2="40" y2="2" stroke="#6b7280" strokeWidth="2" />
                    <circle
                        cx="40"
                        cy="2"
                        r="3"
                        fill="#ef4444"
                        style={{
                            animation: "err-pulse-op 1s ease-in-out infinite",
                        }}
                    />
                    {/* X eyes */}
                    <text x="17" y="38" fontFamily="monospace" fontSize="14" fill="#ef4444" fontWeight="bold">
                        X
                    </text>
                    <text x="44" y="38" fontFamily="monospace" fontSize="14" fill="#ef4444" fontWeight="bold">
                        X
                    </text>
                    {/* Squiggly mouth */}
                    <path d="M22 50 C27 46 33 54 40 50 C47 46 53 54 58 50" stroke="#6b7280" strokeWidth="2" fill="none" strokeLinecap="round" />
                    {/* Body */}
                    <rect x="22" y="65" width="36" height="22" rx="4" fill="#1f2937" stroke="#374151" strokeWidth="1.5" />
                    {/* Body lights */}
                    <circle
                        cx="30"
                        cy="74"
                        r="3"
                        fill="#ef4444"
                        style={{
                            animation: "err-flicker 1.5s ease-in-out infinite",
                        }}
                    />
                    <circle cx="40" cy="74" r="3" fill="#6b7280" />
                    <circle
                        cx="50"
                        cy="74"
                        r="3"
                        fill="#f59e0b"
                        style={{
                            animation: "err-pulse-op 2s ease-in-out infinite",
                        }}
                    />
                    {/* Legs */}
                    <rect x="26" y="87" width="10" height="3" rx="1.5" fill="#374151" />
                    <rect x="44" y="87" width="10" height="3" rx="1.5" fill="#374151" />
                </svg>
            </div>

            {/* Stack trace waterfall */}
            <div
                className="absolute"
                style={{
                    right: 8,
                    top: "82%",
                    animation: "err-drift-r 3.5s ease-in-out infinite",
                }}
            >
                <svg width="150" height="60" viewBox="0 0 150 60" fill="none" opacity="0.4">
                    {["TypeError: Cannot read", "  at Object.<anon>", "  at Module._compile", "  at Object.Module"].map((t, i) => (
                        <text key={i} x={4 + i * 3} y={10 + i * 13} fontFamily="monospace" fontSize="7" fill={i === 0 ? "#ef4444" : "#6b7280"}>
                            {t}
                        </text>
                    ))}
                </svg>
            </div>

            {/* Binary static bottom */}
            <div className="absolute" style={{ right: 0, top: "92%" }}>
                <svg width="160" height="32" viewBox="0 0 160 32" fill="none" opacity="0.3">
                    {Array.from({ length: 20 }, (_, i) => (
                        <text
                            key={i}
                            x={i * 8}
                            y={12 + (i % 2) * 12}
                            fontFamily="monospace"
                            fontSize="9"
                            fill={i % 3 === 0 ? "#f59e0b" : "#374151"}
                            style={{
                                animation: `err-static ${1 + i * 0.1}s ${i * 0.05}s ease-in-out infinite`,
                            }}
                        >
                            {i % 2 === 0 ? "1" : "0"}
                        </text>
                    ))}
                </svg>
            </div>

            {/* Network status panel */}
            <div
                className="absolute"
                style={{
                    right: 10,
                    top: "46%",
                    animation: "err-floatxs 4s 1s ease-in-out infinite",
                }}
            >
                <svg width="100" height="55" viewBox="0 0 100 55" fill="none" opacity="0.5">
                    <rect x="0" y="0" width="100" height="55" rx="5" fill="#111827" stroke="#374151" strokeWidth="1" />
                    <text x="6" y="13" fontFamily="monospace" fontSize="7" fill="#6b7280">
                        NETWORK STATUS
                    </text>
                    <line x1="0" y1="17" x2="100" y2="17" stroke="#374151" strokeWidth="0.8" />
                    {[
                        ["REQ", "400", "#ef4444"],
                        ["BODY", "BAD", "#f59e0b"],
                        ["AUTH", "N/A", "#6b7280"],
                    ].map(([k, v, c], i) => (
                        <g key={i}>
                            <text x="6" y={30 + i * 10} fontFamily="monospace" fontSize="7" fill="#6b7280">
                                {k}
                            </text>
                            <text x="50" y={30 + i * 10} fontFamily="monospace" fontSize="7" fill={c}>
                                {v}
                            </text>
                        </g>
                    ))}
                </svg>
            </div>
        </div>
    );
}

/* ══════════════════════════════════════════════════════════════════════════════
   VAULT DECORS  (401)
   ══════════════════════════════════════════════════════════════════════════════ */
function VaultLeftDecor() {
    return (
        <div className="absolute inset-0">
            {/* CCTV Camera on bracket */}
            <div
                className="absolute"
                style={{
                    left: 30,
                    top: "12%",
                    animation: "err-shake 5s ease-in-out infinite",
                }}
            >
                <svg width="100" height="80" viewBox="0 0 100 80" fill="none">
                    {/* Wall bracket */}
                    <rect x="40" y="0" width="6" height="30" rx="3" fill="#374151" />
                    <path d="M46 22 L70 28" stroke="#374151" strokeWidth="4" strokeLinecap="round" />
                    {/* Camera body */}
                    <rect x="60" y="20" width="35" height="20" rx="4" fill="#1f2937" stroke="#4b5563" strokeWidth="1.5" />
                    {/* Lens */}
                    <circle cx="64" cy="30" r="8" fill="#111827" stroke="#374151" strokeWidth="1.5" />
                    <circle cx="64" cy="30" r="5" fill="#030712" />
                    <circle cx="64" cy="30" r="3" fill="#1d4ed8" opacity="0.6" />
                    <circle cx="66" cy="28" r="1.5" fill="white" opacity="0.3" />
                    {/* Record light */}
                    <circle
                        cx="90"
                        cy="26"
                        r="3"
                        fill="#ef4444"
                        style={{
                            animation: "err-blink 1s ease-in-out infinite",
                        }}
                    />
                    {/* Scan beam */}
                    <path
                        d="M64 30 L5 60 L5 80 L64 80Z"
                        fill="#a855f7"
                        opacity="0.04"
                        style={{
                            animation: "err-laser 2s ease-in-out infinite",
                        }}
                    />
                </svg>
            </div>

            {/* Laser beam lines */}
            {[25, 40, 55].map((topPct, i) => (
                <div key={i} className="absolute left-0 right-0" style={{ top: `${topPct}%` }}>
                    <svg
                        width="260"
                        height="6"
                        viewBox="0 0 260 6"
                        fill="none"
                        style={{
                            animation: `err-laser ${1.8 + i * 0.4}s ${i * 0.5}s ease-in-out infinite`,
                        }}
                    >
                        <line x1="0" y1="3" x2="260" y2="3" stroke="#ef4444" strokeWidth="1.5" opacity="0.4" strokeDasharray="6 4" />
                    </svg>
                </div>
            ))}

            {/* Keypad / security panel */}
            <div
                className="absolute"
                style={{
                    left: 14,
                    top: "62%",
                    animation: "err-floatxs 4s ease-in-out infinite",
                }}
            >
                <svg width="90" height="120" viewBox="0 0 90 120" fill="none">
                    <rect x="5" y="5" width="80" height="110" rx="6" fill="#111827" stroke="#374151" strokeWidth="1.5" />
                    {/* Screen */}
                    <rect x="12" y="12" width="66" height="26" rx="3" fill="#0f172a" stroke="#1e293b" strokeWidth="1" />
                    <text x="18" y="26" fontFamily="monospace" fontSize="8" fill="#ef4444">
                        ACCESS DENIED
                    </text>
                    {/* Keypad buttons */}
                    {[
                        [1, 2, 3],
                        [4, 5, 6],
                        [7, 8, 9],
                        ["*", 0, "#"],
                    ].map((row, ri) =>
                        row.map((btn, ci) => (
                            <g key={`${ri}-${ci}`}>
                                <rect x={14 + ci * 24} y={46 + ri * 18} width="18" height="13" rx="3" fill={btn === "#" ? "#991b1b" : "#1e293b"} stroke="#374151" strokeWidth="0.8" />
                                <text x={20 + ci * 24} y={56 + ri * 18} fontFamily="monospace" fontSize="7" fill={btn === "#" ? "#fca5a5" : "#9ca3af"} textAnchor="middle">
                                    {btn}
                                </text>
                            </g>
                        )),
                    )}
                </svg>
            </div>

            {/* Tripwire laser grid */}
            <div className="absolute" style={{ left: 0, top: "35%" }}>
                <svg width="280" height="120" viewBox="0 0 280 120" fill="none" opacity="0.15" style={{ animation: "err-laser 2.5s ease-in-out infinite" }}>
                    {[0, 1, 2, 3, 4].map((i) => (
                        <line key={i} x1="0" y1={12 + i * 24} x2="280" y2={12 + i * 24} stroke="#ef4444" strokeWidth="1" strokeDasharray="8 5" />
                    ))}
                    {[0, 1, 2, 3].map((i) => (
                        <line key={i} x1={35 + i * 70} y1="0" x2={35 + i * 70} y2="120" stroke="#ef4444" strokeWidth="0.8" strokeDasharray="6 6" />
                    ))}
                </svg>
            </div>

            {/* Warning tape strip */}
            <div className="absolute" style={{ left: 0, top: "56%", width: 260, overflow: "hidden" }}>
                <svg width="260" height="22" viewBox="0 0 260 22" fill="none">
                    {Array.from({ length: 14 }, (_, i) => (
                        <rect key={i} x={i * 18} y="0" width="10" height="22" rx="0" fill={i % 2 === 0 ? "#fbbf24" : "#1c1917"} opacity="0.55" />
                    ))}
                    <text x="30" y="15" fontFamily="monospace" fontSize="9" fill="#111827" fontWeight="bold" opacity="0.7">
                        ⚠ RESTRICTED ZONE ⚠
                    </text>
                </svg>
            </div>

            {/* Footprint detector dots */}
            <div className="absolute" style={{ left: 8, top: "75%" }}>
                <svg width="80" height="50" viewBox="0 0 80 50" fill="none" opacity="0.4">
                    {[
                        [10, 40, 5],
                        [22, 28, 4],
                        [32, 38, 5],
                        [45, 24, 4],
                        [56, 36, 5],
                        [68, 22, 4],
                    ].map(([x, y, r], i) => (
                        <circle
                            key={i}
                            cx={x}
                            cy={y}
                            r={r}
                            fill="none"
                            stroke="#a855f7"
                            strokeWidth="1.2"
                            style={{
                                animation: `err-pulse-op ${1.5 + i * 0.3}s ${i * 0.2}s ease-in-out infinite`,
                            }}
                        />
                    ))}
                </svg>
            </div>

            {/* ID Badge bottom */}
            <div
                className="absolute"
                style={{
                    left: 22,
                    top: "90%",
                    animation: "err-bob 4s ease-in-out infinite",
                }}
            >
                <svg width="80" height="50" viewBox="0 0 80 50" fill="none" opacity="0.55">
                    <rect x="0" y="0" width="80" height="50" rx="5" fill="#111827" stroke="#374151" strokeWidth="1.5" />
                    <rect x="10" y="8" width="20" height="20" rx="2" fill="#1f2937" stroke="#4b5563" strokeWidth="1" />
                    <circle cx="20" cy="15" r="5" fill="#374151" />
                    <rect x="10" y="29" width="20" height="3" rx="1" fill="#374151" />
                    <rect x="36" y="10" width="36" height="4" rx="1" fill="#ef4444" opacity="0.6" />
                    <text x="36" y="23" fontFamily="monospace" fontSize="6" fill="#6b7280">
                        ID: ███████
                    </text>
                    <text x="36" y="34" fontFamily="monospace" fontSize="6" fill="#ef4444">
                        REVOKED
                    </text>
                    {/* Lanyard hole */}
                    <circle cx="40" cy="2" r="3" fill="#374151" stroke="#4b5563" strokeWidth="1" />
                </svg>
            </div>
        </div>
    );
}

function VaultRightDecor() {
    return (
        <div className="absolute inset-0">
            {/* Giant cracked padlock */}
            <div
                className="absolute"
                style={{
                    right: 10,
                    top: "8%",
                    animation: "err-float 5s ease-in-out infinite",
                }}
            >
                <svg width="110" height="140" viewBox="0 0 110 140" fill="none">
                    <defs>
                        <linearGradient id="vlt-lock" x1="0%" y1="0%" x2="100%" y2="100%">
                            <stop offset="0%" stopColor="#4b5563" />
                            <stop offset="100%" stopColor="#1f2937" />
                        </linearGradient>
                    </defs>
                    {/* Shackle */}
                    <path d="M30 60 L30 30 C30 12 80 12 80 30 L80 60" fill="none" stroke="url(#vlt-lock)" strokeWidth="14" strokeLinecap="round" />
                    {/* Body */}
                    <rect x="10" y="55" width="90" height="72" rx="10" fill="url(#vlt-lock)" stroke="#374151" strokeWidth="2" />
                    {/* Keyhole */}
                    <circle cx="55" cy="84" r="12" fill="#0f172a" stroke="#4b5563" strokeWidth="1.5" />
                    <path d="M50 84 L60 84 L57 106 L53 106Z" fill="#0f172a" />
                    {/* Crack through lock */}
                    <path
                        d="M55 60 L48 80 L60 95 L50 127"
                        stroke="#ef4444"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        opacity="0.8"
                        style={{
                            animation: "err-pulse-op 2s ease-in-out infinite",
                        }}
                    />
                    <path d="M48 80 L35 90" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round" opacity="0.5" />
                    <path d="M60 95 L72 105" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round" opacity="0.5" />
                    {/* Rivet details */}
                    {[
                        [20, 65],
                        [90, 65],
                        [20, 118],
                        [90, 118],
                    ].map(([cx, cy], i) => (
                        <circle key={i} cx={cx} cy={cy} r="4" fill="#374151" stroke="#4b5563" strokeWidth="1" />
                    ))}
                </svg>
            </div>

            {/* Fingerprint scan */}
            <div
                className="absolute"
                style={{
                    right: 25,
                    top: "48%",
                    animation: "err-pulse-op 2.5s ease-in-out infinite",
                }}
            >
                <svg width="80" height="80" viewBox="0 0 80 80" fill="none" opacity="0.5">
                    {[8, 14, 20, 26, 32, 38].map((r, i) => (
                        <circle
                            key={i}
                            cx="40"
                            cy="40"
                            r={r}
                            fill="none"
                            stroke="#a855f7"
                            strokeWidth="1.5"
                            strokeDasharray={i % 2 === 0 ? "4 3" : "6 2"}
                            style={{
                                animation: `err-twinkle ${1.5 + i * 0.3}s ${i * 0.2}s ease-in-out infinite`,
                            }}
                        />
                    ))}
                    <circle cx="40" cy="40" r="4" fill="#a855f7" opacity="0.8" />
                    {/* Scan line */}
                    <line
                        x1="2"
                        y1="40"
                        x2="78"
                        y2="40"
                        stroke="#a855f7"
                        strokeWidth="1.5"
                        opacity="0.6"
                        style={{
                            animation: "err-laser 1.5s ease-in-out infinite",
                        }}
                    />
                </svg>
            </div>

            {/* CLASSIFIED stamps */}
            {[
                ["DENIED", "68%", 18],
                ["REVOKED", "78%", 28],
            ].map(([text, top, right], i) => (
                <div
                    key={i}
                    className="absolute font-mono font-black text-xs border-2 border-danger-400/60 text-danger-400/60 px-2 py-0.5 rounded"
                    style={{
                        right,
                        top,
                        transform: `rotate(${-8 + i * 12}deg)`,
                        animation: `err-pulse-op ${2 + i * 0.5}s ${i * 0.4}s ease-in-out infinite`,
                    }}
                >
                    {text}
                </div>
            ))}

            {/* Warning triangles */}
            <div className="absolute" style={{ right: 15, top: "88%" }}>
                <svg width="120" height="50" viewBox="0 0 120 50" fill="none">
                    {[
                        [15, 45, 20],
                        [55, 45, 16],
                        [90, 45, 12],
                    ].map(([cx, cy, r], i) => (
                        <g key={i}>
                            <path
                                d={`M${cx} ${cy - r * 1.1} L${cx - r} ${cy + r * 0.6} L${cx + r} ${cy + r * 0.6}Z`}
                                fill="none"
                                stroke="#a855f7"
                                strokeWidth="1.8"
                                style={{
                                    animation: `err-pulse-op ${1.5 + i * 0.4}s ${i * 0.3}s ease-in-out infinite`,
                                }}
                            />
                            <text x={cx} y={cy + 1} textAnchor="middle" fontSize="8" fill="#a855f7" fontWeight="bold">
                                !
                            </text>
                        </g>
                    ))}
                </svg>
            </div>

            {/* Retinal scan eye */}
            <div
                className="absolute"
                style={{
                    right: 20,
                    top: "38%",
                    animation: "err-pulse-op 2s ease-in-out infinite",
                }}
            >
                <svg width="90" height="55" viewBox="0 0 90 55" fill="none" opacity="0.55">
                    <path d="M5 27 C20 5 70 5 85 27 C70 50 20 50 5 27Z" fill="none" stroke="#a855f7" strokeWidth="1.5" />
                    <circle cx="45" cy="27" r="14" fill="none" stroke="#a855f7" strokeWidth="1.5" />
                    <circle cx="45" cy="27" r="8" fill="#4c1d95" opacity="0.5" />
                    <circle
                        cx="45"
                        cy="27"
                        r="4"
                        fill="#7c3aed"
                        style={{
                            animation: "err-pulse-op 1.5s ease-in-out infinite",
                        }}
                    />
                    {/* Scan lines */}
                    <line x1="5" y1="20" x2="85" y2="20" stroke="#a855f7" strokeWidth="0.8" opacity="0.3" />
                    <line
                        x1="5"
                        y1="27"
                        x2="85"
                        y2="27"
                        stroke="#a855f7"
                        strokeWidth="1"
                        opacity="0.5"
                        style={{
                            animation: "err-laser 1.8s ease-in-out infinite",
                        }}
                    />
                    <line x1="5" y1="34" x2="85" y2="34" stroke="#a855f7" strokeWidth="0.8" opacity="0.3" />
                </svg>
            </div>

            {/* Guard tower silhouette */}
            <div className="absolute" style={{ right: 5, top: "58%" }}>
                <svg width="70" height="90" viewBox="0 0 70 90" fill="none" opacity="0.3">
                    <rect x="25" y="40" width="20" height="50" fill="#1f2937" />
                    <rect x="10" y="25" width="50" height="20" rx="2" fill="#111827" stroke="#374151" strokeWidth="1" />
                    {/* Battlement */}
                    {[0, 1, 2, 3, 4].map((i) => (
                        <rect key={i} x={10 + i * 10} y="15" width="7" height="12" rx="1" fill="#1f2937" stroke="#374151" strokeWidth="1" />
                    ))}
                    {/* Search light beam */}
                    <path
                        d="M35 30 L5 90 L25 90Z"
                        fill="#fbbf24"
                        opacity="0.08"
                        style={{
                            animation: "err-laser 2.5s ease-in-out infinite",
                        }}
                    />
                    {/* Light source */}
                    <circle
                        cx="35"
                        cy="30"
                        r="5"
                        fill="#fbbf24"
                        opacity="0.4"
                        style={{
                            animation: "err-pulse-op 1s ease-in-out infinite",
                        }}
                    />
                    {/* Window */}
                    <rect
                        x="30"
                        y="56"
                        width="10"
                        height="14"
                        rx="1"
                        fill="#fbbf24"
                        opacity="0.3"
                        style={{
                            animation: "err-blink 2s ease-in-out infinite",
                        }}
                    />
                </svg>
            </div>

            {/* Electronic fence */}
            <div className="absolute" style={{ right: 0, top: "74%" }}>
                <svg width="140" height="40" viewBox="0 0 140 40" fill="none" opacity="0.35">
                    <line x1="0" y1="15" x2="140" y2="15" stroke="#4b5563" strokeWidth="2" />
                    <line x1="0" y1="28" x2="140" y2="28" stroke="#4b5563" strokeWidth="1.5" />
                    {[0, 1, 2, 3, 4, 5, 6].map((i) => (
                        <g key={i}>
                            <line x1={20 + i * 20} y1="5" x2={20 + i * 20} y2="38" stroke="#4b5563" strokeWidth="2" />
                            <path
                                d={`M${14 + i * 20} 5 L${20 + i * 20} 2 L${26 + i * 20} 5`}
                                fill="none"
                                stroke="#ef4444"
                                strokeWidth="1"
                                style={{
                                    animation: `err-spark ${1.5 + i * 0.2}s ${i * 0.15}s ease-in-out infinite`,
                                }}
                            />
                        </g>
                    ))}
                    <text x="4" y="38" fontFamily="monospace" fontSize="6" fill="#ef4444" opacity="0.6">
                        HIGH VOLTAGE
                    </text>
                </svg>
            </div>
        </div>
    );
}

/* ══════════════════════════════════════════════════════════════════════════════
   TIME DECORS  (440)
   ══════════════════════════════════════════════════════════════════════════════ */
function TimeLeftDecor() {
    return (
        <div className="absolute inset-0">
            {/* Large ornate clock */}
            <div
                className="absolute"
                style={{
                    left: 8,
                    top: "6%",
                    animation: "err-floatxs 5s ease-in-out infinite",
                }}
            >
                <svg width="170" height="170" viewBox="0 0 170 170" fill="none">
                    <defs>
                        <radialGradient id="tm-clock-face" cx="50%" cy="40%">
                            <stop offset="0%" stopColor="#fff7ed" />
                            <stop offset="100%" stopColor="#fed7aa" />
                        </radialGradient>
                    </defs>
                    {/* Outer bezel */}
                    <circle cx="85" cy="85" r="80" fill="none" stroke="#f97316" strokeWidth="5" opacity="0.5" />
                    <circle cx="85" cy="85" r="74" fill="url(#tm-clock-face)" stroke="#fdba74" strokeWidth="2" opacity="0.9" />
                    {/* Hour markers */}
                    {Array.from({ length: 12 }, (_, i) => {
                        const angle = i * 30 - 90;
                        const r1 = 62,
                            r2 = 70;
                        const x1 = 85 + r1 * Math.cos((angle * Math.PI) / 180);
                        const y1 = 85 + r1 * Math.sin((angle * Math.PI) / 180);
                        const x2 = 85 + r2 * Math.cos((angle * Math.PI) / 180);
                        const y2 = 85 + r2 * Math.sin((angle * Math.PI) / 180);
                        return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#ea580c" strokeWidth={i % 3 === 0 ? 3 : 1.5} />;
                    })}
                    {/* Hour hand (stopped) */}
                    <line
                        x1="85"
                        y1="85"
                        x2="85"
                        y2="42"
                        stroke="#c2410c"
                        strokeWidth="5"
                        strokeLinecap="round"
                        style={{
                            transformOrigin: "85px 85px",
                            animation: "err-hand-min 60s linear infinite",
                        }}
                    />
                    {/* Minute hand */}
                    <line
                        x1="85"
                        y1="85"
                        x2="115"
                        y2="65"
                        stroke="#ea580c"
                        strokeWidth="3"
                        strokeLinecap="round"
                        style={{
                            transformOrigin: "85px 85px",
                            animation: "err-hand-sec 8s linear infinite",
                        }}
                    />
                    {/* Second hand (red) */}
                    <line
                        x1="85"
                        y1="85"
                        x2="85"
                        y2="25"
                        stroke="#ef4444"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        style={{
                            transformOrigin: "85px 85px",
                            animation: "err-hand-sec 4s linear infinite",
                        }}
                    />
                    <circle cx="85" cy="85" r="5" fill="#c2410c" />
                    {/* Melting drip bottom */}
                    <path d="M65 159 C65 168 72 173 80 168 C85 173 90 168 95 173 C103 168 108 159 105 159" fill="#fdba74" stroke="#f97316" strokeWidth="1.5" opacity="0.6" />
                </svg>
            </div>

            {/* Falling calendar pages */}
            {[0, 1, 2].map((i) => (
                <div
                    key={i}
                    className="absolute"
                    style={{
                        left: 20 + i * 30,
                        top: `${52 + i * 10}%`,
                        animation: `err-page-fall ${3 + i * 0.8}s ${i * 0.7}s ease-in infinite`,
                    }}
                >
                    <svg width="40" height="44" viewBox="0 0 40 44" fill="none">
                        <rect x="2" y="8" width="36" height="34" rx="3" fill="white" stroke="#fdba74" strokeWidth="1.5" opacity="0.8" />
                        <rect x="2" y="8" width="36" height="12" rx="3" fill="#f97316" opacity="0.7" />
                        {/* Rings */}
                        <circle cx="14" cy="8" r="3" fill="none" stroke="#c2410c" strokeWidth="2" />
                        <circle cx="26" cy="8" r="3" fill="none" stroke="#c2410c" strokeWidth="2" />
                        <text x="20" y="31" textAnchor="middle" fontSize="12" fill="#92400e" fontWeight="bold">
                            {["31", "01", "30"][i]}
                        </text>
                    </svg>
                </div>
            ))}

            {/* Alarm clock bottom */}
            <div
                className="absolute"
                style={{
                    left: 20,
                    top: "84%",
                    animation: "err-shake 1.5s ease-in-out infinite",
                }}
            >
                <svg width="70" height="70" viewBox="0 0 70 70" fill="none">
                    <circle cx="35" cy="38" r="26" fill="#1f2937" stroke="#f97316" strokeWidth="2.5" />
                    <circle cx="35" cy="38" r="20" fill="#111827" />
                    {/* Bell ears */}
                    <path d="M12 20 C8 12 20 8 22 16" fill="none" stroke="#f97316" strokeWidth="3" strokeLinecap="round" />
                    <path d="M58 20 C62 12 50 8 48 16" fill="none" stroke="#f97316" strokeWidth="3" strokeLinecap="round" />
                    {/* Hands */}
                    <line
                        x1="35"
                        y1="38"
                        x2="35"
                        y2="24"
                        stroke="#f97316"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        style={{
                            transformOrigin: "35px 38px",
                            animation: "err-hand-min 30s linear infinite",
                        }}
                    />
                    <line
                        x1="35"
                        y1="38"
                        x2="48"
                        y2="32"
                        stroke="#fdba74"
                        strokeWidth="2"
                        strokeLinecap="round"
                        style={{
                            transformOrigin: "35px 38px",
                            animation: "err-hand-sec 6s linear infinite",
                        }}
                    />
                    <circle cx="35" cy="38" r="3" fill="#f97316" />
                    {/* Feet */}
                    <circle cx="25" cy="62" r="5" fill="#374151" stroke="#f97316" strokeWidth="1.5" />
                    <circle cx="45" cy="62" r="5" fill="#374151" stroke="#f97316" strokeWidth="1.5" />
                </svg>
            </div>

            {/* Pocket watch chain */}
            <div
                className="absolute"
                style={{
                    left: 55,
                    top: "5%",
                    animation: "err-floatxs 6s ease-in-out infinite",
                }}
            >
                <svg width="80" height="130" viewBox="0 0 80 130" fill="none" opacity="0.6">
                    {/* Chain links */}
                    {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
                        <ellipse key={i} cx="40" cy={10 + i * 14} rx={i % 2 === 0 ? 6 : 4} ry={i % 2 === 0 ? 4 : 6} fill="none" stroke="#f97316" strokeWidth="1.5" opacity="0.7" />
                    ))}
                    {/* Watch face */}
                    <circle cx="40" cy="118" r="12" fill="#1f2937" stroke="#f97316" strokeWidth="2" />
                    <circle cx="40" cy="118" r="9" fill="#111827" />
                    <line
                        x1="40"
                        y1="118"
                        x2="40"
                        y2="111"
                        stroke="#fdba74"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        style={{
                            transformOrigin: "40px 118px",
                            animation: "err-hand-min 20s linear infinite",
                        }}
                    />
                    <line
                        x1="40"
                        y1="118"
                        x2="46"
                        y2="116"
                        stroke="#f97316"
                        strokeWidth="1"
                        strokeLinecap="round"
                        style={{
                            transformOrigin: "40px 118px",
                            animation: "err-hand-sec 5s linear infinite",
                        }}
                    />
                    <circle cx="40" cy="118" r="2" fill="#f97316" />
                </svg>
            </div>

            {/* Scattered clock numbers */}
            {["1", "2", "3", "4", "5", "6"].map((n, i) => (
                <div
                    key={i}
                    className="absolute select-none font-aumovio-bold text-orange-400/20"
                    style={{
                        fontSize: [28, 18, 32, 20, 24, 16][i],
                        left: [8, 60, 15, 90, 40, 100][i],
                        top: [`${72 + i * 3}%`, `${65 + i * 2}%`, `${70 + i * 4}%`, `${68 + i * 2}%`, `${74 + i * 2}%`, `${66 + i * 3}%`][i],
                        animation: `err-drift-${i % 2 === 0 ? "l" : "r"} ${3 + i * 0.5}s ${i * 0.3}s ease-in-out infinite`,
                        transform: `rotate(${-20 + i * 8}deg)`,
                    }}
                >
                    {n}
                </div>
            ))}

            {/* Sundial */}
            <div
                className="absolute"
                style={{
                    left: 10,
                    top: "44%",
                    animation: "err-floatxs 5s 2s ease-in-out infinite",
                }}
            >
                <svg width="80" height="55" viewBox="0 0 80 55" fill="none" opacity="0.45">
                    {/* Base ellipse */}
                    <ellipse cx="40" cy="45" rx="36" ry="9" fill="#92400e" stroke="#f97316" strokeWidth="1.5" />
                    {/* Shadow rays */}
                    {[0, 20, 40, 60, 80, 100, 120, 140, 160].map((deg, i) => (
                        <line key={i} x1="40" y1="45" x2={40 + 32 * Math.cos(((deg - 90) * Math.PI) / 180)} y2={45 + 8 * Math.sin(((deg - 90) * Math.PI) / 180)} stroke="#f97316" strokeWidth="0.8" opacity={0.2 + i * 0.06} />
                    ))}
                    {/* Gnomon */}
                    <path d="M40 8 L40 45 L70 45" fill="none" stroke="#fbbf24" strokeWidth="2" strokeLinecap="round" />
                </svg>
            </div>
        </div>
    );
}

function TimeRightDecor() {
    const moonStars = [
        [30, "5%"],
        [55, "12%"],
        [20, "22%"],
        [70, "18%"],
        [45, "32%"],
        [80, "38%"],
        [15, "50%"],
    ];
    return (
        <div className="absolute inset-0">
            {/* Crescent moon */}
            <div
                className="absolute"
                style={{
                    right: 20,
                    top: "5%",
                    animation: "err-floatxs 6s ease-in-out infinite",
                }}
            >
                <svg width="90" height="90" viewBox="0 0 90 90" fill="none">
                    <path d="M55 10 C30 15 12 35 15 58 C18 80 38 92 62 86 C38 85 22 66 24 46 C26 26 42 12 55 10Z" fill="#fde68a" stroke="#f59e0b" strokeWidth="1.5" opacity="0.8" />
                </svg>
            </div>

            {/* Stars around moon */}
            {moonStars.map(([right, top], i) => (
                <div
                    key={i}
                    className="absolute"
                    style={{
                        right,
                        top,
                        animation: `err-twinkle ${1.4 + i * 0.5}s ${i * 0.22}s ease-in-out infinite`,
                    }}
                >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                        <path d="M6 1 L7 5 L11 5 L8 7.5 L9 11 L6 9 L3 11 L4 7.5 L1 5 L5 5Z" fill="#fde68a" opacity="0.7" />
                    </svg>
                </div>
            ))}

            {/* Hourglass tilted */}
            <div
                className="absolute"
                style={{
                    right: 15,
                    top: "38%",
                    animation: "err-bob 5s ease-in-out infinite",
                    transform: "rotate(15deg)",
                }}
            >
                <svg width="70" height="110" viewBox="0 0 70 110" fill="none">
                    <rect x="5" y="0" width="60" height="8" rx="4" fill="#f97316" />
                    <rect x="5" y="102" width="60" height="8" rx="4" fill="#f97316" />
                    {/* Glass shape top */}
                    <path d="M10 8 L60 8 L38 54 L38 56 L32 56 L32 54Z" fill="#fff7ed" stroke="#fdba74" strokeWidth="1.5" opacity="0.8" />
                    {/* Glass shape bottom */}
                    <path d="M32 56 L38 56 L60 102 L10 102Z" fill="#fff7ed" stroke="#fdba74" strokeWidth="1.5" opacity="0.8" />
                    {/* Sand (nearly empty top) */}
                    <path d="M10 8 L60 8 L42 38 L28 38Z" fill="#f97316" opacity="0.4" />
                    {/* Sand (full bottom) */}
                    <path d="M35 58 L58 102 L12 102Z" fill="#f97316" opacity="0.7" />
                    {/* Sand grain falling */}
                    <circle
                        cx="35"
                        cy="56"
                        r="1.5"
                        fill="#f97316"
                        style={{
                            animation: "err-drop .6s ease-in-out infinite",
                        }}
                    />
                </svg>
            </div>

            {/* EXPIRED badges */}
            {[
                ["EXPIRED", "68%", 25, -6],
                ["TIMED OUT", "78%", 10, 4],
            ].map(([text, top, right, rot], i) => (
                <div
                    key={i}
                    className="absolute font-mono font-black text-xs border-2 rounded px-2 py-0.5"
                    style={{
                        right,
                        top,
                        transform: `rotate(${rot}deg)`,
                        borderColor: "#f97316",
                        color: "#f97316",
                        opacity: 0.5,
                        animation: `err-pulse-op ${2 + i * 0.6}s ${i * 0.4}s ease-in-out infinite`,
                    }}
                >
                    {text}
                </div>
            ))}

            {/* Floating clock numbers */}
            {["12", "3", "6", "9"].map((n, i) => (
                <div
                    key={i}
                    className="absolute text-2xl select-none font-aumovio-bold text-orange-400/25"
                    style={{
                        right: [40, 10, 40, 70][i],
                        top: ["88%", "88%", "93%", "88%"][i],
                        animation: `err-drift-${i % 2 === 0 ? "l" : "r"} ${3 + i * 0.4}s ${i * 0.3}s ease-in-out infinite`,
                    }}
                >
                    {n}
                </div>
            ))}

            {/* Timer countdown display */}
            <div
                className="absolute"
                style={{
                    right: 12,
                    top: "55%",
                    animation: "err-floatxs 4s ease-in-out infinite",
                }}
            >
                <svg width="110" height="50" viewBox="0 0 110 50" fill="none" opacity="0.55">
                    <rect x="0" y="0" width="110" height="50" rx="6" fill="#111827" stroke="#f97316" strokeWidth="1.5" />
                    <text x="10" y="30" fontFamily="monospace" fontSize="22" fontWeight="bold" fill="#f97316" style={{ animation: "err-blink 1s step-end infinite" }}>
                        00:00
                    </text>
                    <text x="75" y="18" fontFamily="monospace" fontSize="8" fill="#6b7280">
                        SESSION
                    </text>
                    <text x="75" y="30" fontFamily="monospace" fontSize="8" fill="#ef4444">
                        EXPIRED
                    </text>
                </svg>
            </div>

            {/* Wristwatch */}
            <div
                className="absolute"
                style={{
                    right: 18,
                    top: "26%",
                    animation: "err-bob 6s 1s ease-in-out infinite",
                }}
            >
                <svg width="60" height="90" viewBox="0 0 60 90" fill="none" opacity="0.6">
                    {/* Band top */}
                    <rect x="20" y="0" width="20" height="22" rx="3" fill="#374151" />
                    {[4, 10, 16].map((y) => (
                        <line key={y} x1="20" y1={y} x2="40" y2={y} stroke="#4b5563" strokeWidth="0.8" />
                    ))}
                    {/* Watch face */}
                    <circle cx="30" cy="42" r="22" fill="#1f2937" stroke="#f97316" strokeWidth="2" />
                    <circle cx="30" cy="42" r="18" fill="#111827" />
                    {Array.from({ length: 12 }, (_, i) => {
                        const a = ((i * 30 - 90) * Math.PI) / 180;
                        return <circle key={i} cx={30 + 15 * Math.cos(a)} cy={42 + 15 * Math.sin(a)} r={i % 3 === 0 ? 2 : 1} fill="#f97316" opacity={i % 3 === 0 ? 0.8 : 0.4} />;
                    })}
                    <line
                        x1="30"
                        y1="42"
                        x2="30"
                        y2="30"
                        stroke="#fdba74"
                        strokeWidth="2"
                        strokeLinecap="round"
                        style={{
                            transformOrigin: "30px 42px",
                            animation: "err-hand-min 20s linear infinite",
                        }}
                    />
                    <line
                        x1="30"
                        y1="42"
                        x2="40"
                        y2="42"
                        stroke="#f97316"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        style={{
                            transformOrigin: "30px 42px",
                            animation: "err-hand-sec 5s linear infinite",
                        }}
                    />
                    <circle cx="30" cy="42" r="2.5" fill="#f97316" />
                    {/* Band bottom */}
                    <rect x="20" y="64" width="20" height="26" rx="3" fill="#374151" />
                    {[68, 74, 80].map((y) => (
                        <line key={y} x1="20" y1={y} x2="40" y2={y} stroke="#4b5563" strokeWidth="0.8" />
                    ))}
                    {/* Buckle */}
                    <rect x="22" y="76" width="16" height="8" rx="2" fill="none" stroke="#6b7280" strokeWidth="1.2" />
                    <line x1="30" y1="76" x2="30" y2="84" stroke="#6b7280" strokeWidth="1" />
                </svg>
            </div>

            {/* Sand timer silhouettes scatter */}
            <div
                className="absolute"
                style={{
                    right: 40,
                    top: "73%",
                    animation: "err-floatxs 5s 2s ease-in-out infinite",
                    transform: "rotate(20deg)",
                }}
            >
                <svg width="28" height="44" viewBox="0 0 28 44" fill="none" opacity="0.35">
                    <rect x="2" y="0" width="24" height="4" rx="2" fill="#f97316" />
                    <rect x="2" y="40" width="24" height="4" rx="2" fill="#f97316" />
                    <path d="M4 4 L24 4 L16 22 L16 22 L14 22 L14 22Z" fill="#f97316" opacity="0.4" />
                    <path d="M14 22 L24 40 L4 40Z" fill="#f97316" opacity="0.7" />
                </svg>
            </div>
        </div>
    );
}

/* ══════════════════════════════════════════════════════════════════════════════
   CIRCUIT DECORS  (498)
   ══════════════════════════════════════════════════════════════════════════════ */
function CircuitLeftDecor() {
    return (
        <div className="absolute inset-0">
            {/* PCB circuit board traces */}
            <div className="absolute" style={{ left: 5, top: "5%" }}>
                <svg width="200" height="300" viewBox="0 0 200 300" fill="none" opacity="0.45">
                    {/* Horizontal traces */}
                    <path d="M0 40 L80 40 L80 80 L160 80 L160 120 L200 120" stroke="#22c55e" strokeWidth="2" strokeLinecap="round" />
                    <path d="M0 100 L50 100 L50 140 L130 140 L130 100 L200 100" stroke="#22c55e" strokeWidth="1.5" strokeDasharray="6 3" />
                    <path d="M0 200 L40 200 L40 160 L100 160 L100 200 L200 200" stroke="#22c55e" strokeWidth="2" />
                    <path d="M0 260 L70 260 L70 220 L150 220 L150 260 L200 260" stroke="#22c55e" strokeWidth="1.5" strokeDasharray="4 4" />
                    {/* Broken segment (red) */}
                    <path
                        d="M160 80 L160 120"
                        stroke="#ef4444"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        style={{
                            animation: "err-flicker 1.5s ease-in-out infinite",
                        }}
                    />
                    {/* Component pads */}
                    {[
                        [80, 40],
                        [160, 80],
                        [50, 140],
                        [100, 160],
                        [70, 260],
                        [150, 220],
                    ].map(([x, y], i) => (
                        <rect key={i} x={x - 5} y={y - 5} width="10" height="10" rx="2" fill={i === 1 || i === 5 ? "#ef4444" : "#16a34a"} opacity={i === 1 || i === 5 ? 0.8 : 0.6} />
                    ))}
                    {/* IC chip */}
                    <rect x="100" y="180" width="50" height="32" rx="3" fill="none" stroke="#15803d" strokeWidth="2" />
                    {[0, 1, 2, 3, 4].map((i) => (
                        <g key={i}>
                            <line x1={100} y1={184 + i * 5} x2={92} y2={184 + i * 5} stroke="#22c55e" strokeWidth="1.5" />
                            <line x1={150} y1={184 + i * 5} x2={158} y2={184 + i * 5} stroke="#22c55e" strokeWidth="1.5" />
                        </g>
                    ))}
                    {/* Broken X on chip */}
                    <path
                        d="M110 188 L140 208 M140 188 L110 208"
                        stroke="#ef4444"
                        strokeWidth="1.5"
                        style={{
                            animation: "err-pulse-op 1.5s ease-in-out infinite",
                        }}
                    />
                </svg>
            </div>

            {/* Floating hex codes */}
            {["0xA3B2", "FF:EE:00", "0x??", "NUL\x00"].map((hex, i) => (
                <div
                    key={i}
                    className="absolute font-mono text-xs text-danger-400/50"
                    style={{
                        left: 10 + (i % 2) * 45,
                        top: `${62 + i * 8}%`,
                        animation: `err-hexfall ${4 + i * 0.5}s ${i * 0.6}s linear infinite`,
                    }}
                >
                    {hex}
                </div>
            ))}

            {/* Corrupted block cluster */}
            <div
                className="absolute"
                style={{
                    left: 20,
                    top: "87%",
                    animation: "err-corrupt 2s ease-in-out infinite",
                }}
            >
                <svg width="120" height="30" viewBox="0 0 120 30" fill="none">
                    {[
                        [0, "#ef4444", 0.7],
                        [12, "#991b1b", 0.5],
                        [22, "#ef4444", 0.8],
                        [36, "#7f1d1d", 0.4],
                        [44, "#ef4444", 0.6],
                        [56, "#991b1b", 0.7],
                        [66, "#ef4444", 0.5],
                        [80, "#7f1d1d", 0.6],
                        [90, "#ef4444", 0.4],
                        [102, "#991b1b", 0.7],
                    ].map(([x, col, op], i) => (
                        <rect key={i} x={x} y={5 + (i % 3) * 7} width={8 + (i % 4) * 2} height={10 + (i % 2) * 5} rx="1" fill={col} opacity={op} />
                    ))}
                </svg>
            </div>

            {/* DNA / data helix */}
            <div
                className="absolute"
                style={{
                    left: 50,
                    top: "35%",
                    animation: "err-floatxs 4s ease-in-out infinite",
                }}
            >
                <svg width="60" height="130" viewBox="0 0 60 130" fill="none" opacity="0.5">
                    {Array.from({ length: 9 }, (_, i) => {
                        const y = 8 + i * 14;
                        const x1 = 8 + Math.sin(i * 0.8) * 22;
                        const x2 = 52 - Math.sin(i * 0.8) * 22;
                        return (
                            <g key={i}>
                                <circle cx={x1} cy={y} r="4" fill={i % 2 === 0 ? "#ef4444" : "#991b1b"} opacity="0.8" />
                                <circle cx={x2} cy={y} r="4" fill={i % 2 === 0 ? "#991b1b" : "#ef4444"} opacity="0.8" />
                                <line x1={x1} y1={y} x2={x2} y2={y} stroke="#ef4444" strokeWidth="1" opacity="0.4" />
                            </g>
                        );
                    })}
                </svg>
            </div>

            {/* Token chip schematic */}
            <div
                className="absolute"
                style={{
                    left: 5,
                    top: "58%",
                    animation: "err-floatxs 5s 1s ease-in-out infinite",
                }}
            >
                <svg width="130" height="80" viewBox="0 0 130 80" fill="none" opacity="0.45">
                    <rect x="35" y="20" width="60" height="40" rx="5" fill="#1f2937" stroke="#ef4444" strokeWidth="1.5" />
                    {/* Pins left */}
                    {[0, 1, 2, 3].map((i) => (
                        <g key={i}>
                            <line x1="10" y1={27 + i * 8} x2="35" y2={27 + i * 8} stroke="#22c55e" strokeWidth="1.5" />
                            <rect x="5" y={24 + i * 8} width="6" height="5" rx="1" fill="#16a34a" />
                        </g>
                    ))}
                    {/* Pins right */}
                    {[0, 1, 2, 3].map((i) => (
                        <g key={i}>
                            <line x1="95" y1={27 + i * 8} x2="120" y2={27 + i * 8} stroke="#22c55e" strokeWidth="1.5" />
                            <rect x="119" y={24 + i * 8} width="6" height="5" rx="1" fill="#16a34a" />
                        </g>
                    ))}
                    {/* Inner broken X */}
                    <path
                        d="M48 28 L82 52 M82 28 L48 52"
                        stroke="#ef4444"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        style={{
                            animation: "err-pulse-op 1.5s ease-in-out infinite",
                        }}
                    />
                    <text x="52" y="44" fontFamily="monospace" fontSize="8" fill="#ef4444" opacity="0.8">
                        VOID
                    </text>
                </svg>
            </div>

            {/* Error count badge cascade */}
            {["ERR 0x01", "ERR 0xFF", "ERR 0x??"].map((label, i) => (
                <div
                    key={i}
                    className="absolute font-mono text-xs border rounded px-1.5 py-0.5"
                    style={{
                        left: 8 + i * 12,
                        top: `${74 + i * 5}%`,
                        borderColor: "#ef4444",
                        color: "#ef4444",
                        opacity: 0.4,
                        transform: `rotate(${-3 + i * 6}deg)`,
                        animation: `err-drift-l ${2.5 + i * 0.4}s ${i * 0.3}s ease-in-out infinite`,
                    }}
                >
                    {label}
                </div>
            ))}
        </div>
    );
}

function CircuitRightDecor() {
    return (
        <div className="absolute inset-0">
            {/* Falling hex rain */}
            {["3F", "A9", "00", "FF", "B2", "7C", "E1", "44"].map((hex, i) => (
                <div
                    key={i}
                    className="absolute font-mono text-xs font-bold text-danger-400/60"
                    style={{
                        right: 8 + (i % 4) * 18,
                        top: `${i * 12}%`,
                        animation: `err-hexfall ${3 + i * 0.6}s ${i * 0.4}s linear infinite`,
                    }}
                >
                    {hex}
                </div>
            ))}

            {/* Broken barcode */}
            <div
                className="absolute"
                style={{
                    right: 10,
                    top: "30%",
                    animation: "err-static 1.2s ease-in-out infinite",
                }}
            >
                <svg width="120" height="70" viewBox="0 0 120 70" fill="none">
                    {Array.from({ length: 25 }, (_, i) => (
                        <rect key={i} x={i * 4.5} y={8} width={i % 4 === 0 ? 3 : 1.5} height={i === 12 ? 40 : 50} rx="0.5" fill={i === 12 ? "#ef4444" : i % 5 === 0 ? "#991b1b" : "#1f2937"} opacity={i === 12 ? 0.8 : 0.6} />
                    ))}
                    <text x="8" y="66" fontFamily="monospace" fontSize="7" fill="#9ca3af">
                        4 8 0 ??? 2 2 X X
                    </text>
                    {/* Glitch slash */}
                    <path d="M0 0 L120 70" stroke="#ef4444" strokeWidth="2" opacity="0.4" />
                </svg>
            </div>

            {/* Error matrix grid */}
            <div
                className="absolute"
                style={{
                    right: 5,
                    top: "55%",
                    animation: "err-corrupt 3s ease-in-out infinite",
                }}
            >
                <svg width="130" height="100" viewBox="0 0 130 100" fill="none">
                    {Array.from({ length: 6 }, (_, row) =>
                        Array.from({ length: 8 }, (_, col) => {
                            const isErr = (row + col) % 3 === 0;
                            return <rect key={`${row}-${col}`} x={col * 16 + 2} y={row * 15 + 2} width="13" height="12" rx="2" fill={isErr ? "#991b1b" : "#1f2937"} opacity={isErr ? 0.7 : 0.3} stroke={isErr ? "#ef4444" : "none"} strokeWidth="0.8" />;
                        }),
                    )}
                    {/* Scanning line */}
                    <line
                        x1="0"
                        y1="50"
                        x2="130"
                        y2="50"
                        stroke="#ef4444"
                        strokeWidth="1.5"
                        opacity="0.5"
                        style={{
                            animation: "err-laser 2s ease-in-out infinite",
                        }}
                    />
                </svg>
            </div>

            {/* Warning labels */}
            {["CORRUPTED", "INVALID"].map((label, i) => (
                <div
                    key={i}
                    className="absolute font-mono font-black text-xs border-2 rounded px-2 py-0.5"
                    style={{
                        right: 10 + i * 15,
                        top: `${80 + i * 6}%`,
                        borderColor: "#ef4444",
                        color: "#ef4444",
                        opacity: 0.4,
                        transform: `rotate(${-5 + i * 10}deg)`,
                        animation: `err-pulse-op ${2 + i * 0.5}s ${i * 0.4}s ease-in-out infinite`,
                    }}
                >
                    {label}
                </div>
            ))}

            {/* JWT decode panel */}
            <div
                className="absolute"
                style={{
                    right: 5,
                    top: "42%",
                    animation: "err-floatxs 4s 2s ease-in-out infinite",
                }}
            >
                <svg width="140" height="75" viewBox="0 0 140 75" fill="none" opacity="0.5">
                    <rect x="0" y="0" width="140" height="75" rx="5" fill="#111827" stroke="#374151" strokeWidth="1" />
                    <rect x="0" y="0" width="140" height="16" rx="5" fill="#1f2937" />
                    <text x="6" y="11" fontFamily="monospace" fontSize="7" fill="#6b7280">
                        JWT PAYLOAD
                    </text>
                    <text x="6" y="25" fontFamily="monospace" fontSize="6" fill="#ef4444">
                        {"{"}
                    </text>
                    <text x="12" y="35" fontFamily="monospace" fontSize="6" fill="#f59e0b">
                        "sub": "███████",
                    </text>
                    <text x="12" y="44" fontFamily="monospace" fontSize="6" fill="#f59e0b">
                        "exp": <tspan fill="#ef4444">INVALID</tspan>,
                    </text>
                    <text x="12" y="53" fontFamily="monospace" fontSize="6" fill="#f59e0b">
                        "sig": "???",
                    </text>
                    <text x="6" y="62" fontFamily="monospace" fontSize="6" fill="#ef4444">
                        {"}"} ← TAMPERED
                    </text>
                    <line x1="0" y1="67" x2="140" y2="67" stroke="#374151" strokeWidth="0.8" />
                    <text x="5" y="73" fontFamily="monospace" fontSize="6" fill="#ef4444">
                        SIGNATURE MISMATCH
                    </text>
                </svg>
            </div>

            {/* Falling crypto symbols */}
            {["🔑", "🔐", "🔒", "⚠️"].map((sym, i) => (
                <div
                    key={i}
                    className="absolute text-sm select-none"
                    style={{
                        right: 8 + i * 22,
                        top: `${10 + i * 8}%`,
                        opacity: 0.25 + i * 0.08,
                        animation: `err-hexfall ${4 + i * 0.7}s ${i * 0.5}s linear infinite`,
                    }}
                >
                    {sym}
                </div>
            ))}

            {/* Network packet loss visual */}
            <div className="absolute" style={{ right: 8, top: "68%" }}>
                <svg width="130" height="35" viewBox="0 0 130 35" fill="none" opacity="0.45">
                    {/* Packet flow with gaps */}
                    {[0, 1, 2, 3, 4, 5, 6].map((i) => (
                        <rect key={i} x={i * 18} y="10" width="12" height="14" rx="2" fill={i === 2 || i === 4 ? "#ef4444" : "#1f2937"} stroke={i === 2 || i === 4 ? "#ef4444" : "#374151"} strokeWidth="1" opacity={i === 2 || i === 4 ? 0.3 : 0.7} />
                    ))}
                    <text x="0" y="32" fontFamily="monospace" fontSize="6" fill="#6b7280">
                        PKT LOSS: 28.5%
                    </text>
                    {/* Arrow */}
                    <path d="M125 17 L130 17 M128 14 L130 17 L128 20" stroke="#6b7280" strokeWidth="1" fill="none" />
                </svg>
            </div>
        </div>
    );
}

/* ══════════════════════════════════════════════════════════════════════════════
   SERVER DECORS  (523)
   ══════════════════════════════════════════════════════════════════════════════ */
function ServerLeftDecor() {
    return (
        <div className="absolute inset-0">
            {/* Construction scaffolding */}
            <div className="absolute" style={{ left: 0, top: "0%" }}>
                <svg width="180" height="260" viewBox="0 0 180 260" fill="none" opacity="0.55">
                    {/* Vertical poles */}
                    <line x1="30" y1="0" x2="30" y2="260" stroke="#92400e" strokeWidth="6" strokeLinecap="round" />
                    <line x1="140" y1="0" x2="140" y2="260" stroke="#92400e" strokeWidth="6" strokeLinecap="round" />
                    {/* Horizontal crossbars */}
                    {[30, 90, 150, 210].map((y) => (
                        <line key={y} x1="30" y1={y} x2="140" y2={y} stroke="#92400e" strokeWidth="5" strokeLinecap="round" />
                    ))}
                    {/* Diagonal braces */}
                    <line x1="30" y1="30" x2="140" y2="90" stroke="#a16207" strokeWidth="3" opacity="0.7" />
                    <line x1="140" y1="90" x2="30" y2="150" stroke="#a16207" strokeWidth="3" opacity="0.7" />
                    <line x1="30" y1="150" x2="140" y2="210" stroke="#a16207" strokeWidth="3" opacity="0.7" />
                    {/* Warning stripe bars */}
                    {[30, 90, 150].map((y, i) => (
                        <g key={i}>
                            {Array.from({ length: 8 }, (_, j) => (
                                <rect key={j} x={30 + j * 14} y={y - 3} width="7" height="8" fill={j % 2 === 0 ? "#fbbf24" : "#1c1917"} opacity="0.8" />
                            ))}
                        </g>
                    ))}
                </svg>
            </div>

            {/* Hard hat */}
            <div
                className="absolute"
                style={{
                    left: 28,
                    top: "52%",
                    animation: "err-bob 4s ease-in-out infinite",
                }}
            >
                <svg width="80" height="58" viewBox="0 0 80 58" fill="none">
                    <path d="M8 38 C8 20 16 6 40 4 C64 6 72 20 72 38Z" fill="#fbbf24" stroke="#f59e0b" strokeWidth="2" />
                    <rect x="4" y="36" width="72" height="14" rx="7" fill="#fbbf24" stroke="#f59e0b" strokeWidth="2" />
                    {/* Stripe */}
                    <path d="M14 22 L66 22" stroke="white" strokeWidth="3" strokeLinecap="round" opacity="0.6" />
                    {/* Vent holes */}
                    <circle cx="35" cy="14" r="3" fill="#f59e0b" opacity="0.5" />
                    <circle cx="45" cy="14" r="3" fill="#f59e0b" opacity="0.5" />
                </svg>
            </div>

            {/* Floating tools */}
            {/* Wrench */}
            <div
                className="absolute"
                style={{
                    left: 15,
                    top: "70%",
                    animation: "err-wander 5s ease-in-out infinite",
                }}
            >
                <svg width="50" height="50" viewBox="0 0 50 50" fill="none">
                    <path d="M35 6 C42 6 46 12 44 18 L28 34 L20 42 C16 46 10 46 6 42 C2 38 2 32 6 28 L14 20 L30 4 C31 5 33 6 35 6Z" fill="#4b5563" stroke="#6b7280" strokeWidth="1.5" />
                    <circle cx="10" cy="38" r="5" fill="#374151" stroke="#6b7280" strokeWidth="1.5" />
                    <circle cx="38" cy="10" r="5" fill="#374151" stroke="#6b7280" strokeWidth="1.5" />
                </svg>
            </div>

            {/* Warning cone */}
            <div
                className="absolute"
                style={{
                    left: 45,
                    top: "82%",
                    animation: "err-shake 3s ease-in-out infinite",
                }}
            >
                <svg width="50" height="60" viewBox="0 0 50 60" fill="none">
                    <path d="M25 4 L44 55 H6Z" fill="#f97316" stroke="#ea580c" strokeWidth="2" />
                    <rect x="6" y="43" width="38" height="7" rx="3" fill="#f97316" stroke="#ea580c" strokeWidth="1.5" />
                    {/* White stripes */}
                    <path d="M14 30 L36 30" stroke="white" strokeWidth="4" strokeLinecap="round" opacity="0.7" />
                </svg>
            </div>

            {/* Blueprint scroll */}
            <div
                className="absolute"
                style={{
                    left: 5,
                    top: "36%",
                    animation: "err-floatxs 5s 1s ease-in-out infinite",
                }}
            >
                <svg width="130" height="90" viewBox="0 0 130 90" fill="none" opacity="0.5">
                    {/* Paper */}
                    <rect x="10" y="5" width="110" height="78" rx="3" fill="#1e3a5f" stroke="#3b82f6" strokeWidth="1.5" />
                    {/* Grid lines */}
                    {[0, 1, 2, 3, 4, 5].map((i) => (
                        <line key={`h${i}`} x1="10" y1={18 + i * 12} x2="120" y2={18 + i * 12} stroke="#3b82f6" strokeWidth="0.5" opacity="0.3" />
                    ))}
                    {[0, 1, 2, 3, 4, 5, 6].map((i) => (
                        <line key={`v${i}`} x1={22 + i * 16} y1="5" x2={22 + i * 16} y2="83" stroke="#3b82f6" strokeWidth="0.5" opacity="0.3" />
                    ))}
                    {/* Server drawing */}
                    <rect x="30" y="25" width="50" height="35" rx="2" fill="none" stroke="#60a5fa" strokeWidth="1.5" />
                    {[0, 1, 2].map((i) => (
                        <rect key={i} x="34" y={29 + i * 10} width="42" height="7" rx="1" fill="none" stroke="#60a5fa" strokeWidth="1" />
                    ))}
                    <text x="15" y="14" fontFamily="monospace" fontSize="7" fill="#60a5fa">
                        SERVER BLUEPRINT
                    </text>
                    {/* X through it */}
                    <path d="M30 25 L80 60 M80 25 L30 60" stroke="#ef4444" strokeWidth="2" opacity="0.5" />
                    {/* Roll */}
                    <ellipse cx="10" cy="44" rx="5" ry="39" fill="#1e3a5f" stroke="#3b82f6" strokeWidth="1.5" />
                    <ellipse cx="120" cy="44" rx="5" ry="39" fill="#1e3a5f" stroke="#3b82f6" strokeWidth="1.5" />
                </svg>
            </div>

            {/* Danger stripes bottom */}
            <div className="absolute" style={{ left: 0, top: "94%", overflow: "hidden", width: 180 }}>
                <svg width="180" height="18" viewBox="0 0 180 18" fill="none">
                    {Array.from({ length: 12 }, (_, i) => (
                        <rect key={i} x={i * 15} y="0" width="9" height="18" rx="0" fill={i % 2 === 0 ? "#fbbf24" : "#111827"} opacity="0.6" />
                    ))}
                </svg>
            </div>
        </div>
    );
}

function ServerRightDecor() {
    return (
        <div className="absolute inset-0">
            {/* Storm cloud with lightning */}
            <div
                className="absolute"
                style={{
                    right: 10,
                    top: "5%",
                    animation: "err-floatxs 4s ease-in-out infinite",
                }}
            >
                <svg width="150" height="110" viewBox="0 0 150 110" fill="none">
                    {/* Cloud body */}
                    <ellipse cx="75" cy="55" rx="64" ry="34" fill="#374151" opacity="0.8" />
                    <circle cx="45" cy="45" r="22" fill="#4b5563" opacity="0.8" />
                    <circle cx="80" cy="38" r="26" fill="#6b7280" opacity="0.8" />
                    <circle cx="110" cy="46" r="20" fill="#4b5563" opacity="0.8" />
                    {/* Lightning bolts */}
                    <path
                        d="M65 65 L55 82 L62 82 L52 100"
                        stroke="#fbbf24"
                        strokeWidth="3.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        style={{
                            animation: "err-thunder 2s ease-in-out infinite",
                        }}
                    />
                    <path
                        d="M90 62 L82 76 L88 76 L80 92"
                        stroke="#fbbf24"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        style={{
                            animation: "err-thunder 2s 0.5s ease-in-out infinite",
                        }}
                    />
                    {/* Rain drops */}
                    {[
                        [60, 96],
                        [72, 102],
                        [84, 98],
                        [96, 104],
                        [45, 100],
                    ].map(([x, y], i) => (
                        <line
                            key={i}
                            x1={x}
                            y1={y}
                            x2={x - 3}
                            y2={y + 10}
                            stroke="#93c5fd"
                            strokeWidth="1.5"
                            opacity="0.5"
                            style={{
                                animation: `err-drop ${0.8 + i * 0.2}s ${i * 0.15}s ease-in-out infinite`,
                            }}
                        />
                    ))}
                </svg>
            </div>

            {/* Sleeping server tower */}
            <div
                className="absolute"
                style={{
                    right: 20,
                    top: "42%",
                    animation: "err-floatxs 5s ease-in-out infinite",
                }}
            >
                <svg width="90" height="130" viewBox="0 0 90 130" fill="none">
                    <rect x="10" y="5" width="70" height="110" rx="6" fill="#111827" stroke="#374151" strokeWidth="2" />
                    {/* Server rack units */}
                    {[0, 1, 2, 3, 4].map((i) => (
                        <g key={i}>
                            <rect x="16" y={14 + i * 20} width="58" height="15" rx="2" fill="#1f2937" stroke="#374151" strokeWidth="1" />
                            {/* Error/off lights */}
                            <circle
                                cx="22"
                                cy={21 + i * 20}
                                r="3"
                                fill={i === 0 ? "#ef4444" : "#374151"}
                                style={
                                    i === 0
                                        ? {
                                              animation: "err-pulse-op 1.5s ease-in-out infinite",
                                          }
                                        : {}
                                }
                            />
                            <circle cx="30" cy={21 + i * 20} r="2.5" fill="#374151" />
                            {/* Bar */}
                            <rect x="36" y={18 + i * 20} width="32" height="5" rx="2" fill="#0f172a" opacity="0.8" />
                        </g>
                    ))}
                    {/* Zzz sleep indicators */}
                    {[
                        { x: 58, y: 20, sz: 10, d: "0s" },
                        { x: 65, y: 12, sz: 12, d: ".5s" },
                        { x: 74, y: 4, sz: 15, d: "1s" },
                    ].map(({ x, y, sz, d }, i) => (
                        <text
                            key={i}
                            x={x}
                            y={y}
                            fontSize={sz}
                            fill="#6b7280"
                            fontWeight="bold"
                            fontFamily="sans-serif"
                            style={{
                                animation: `err-zzz 2.5s ${d} ease-in-out infinite`,
                            }}
                        >
                            z
                        </text>
                    ))}
                    {/* Stand */}
                    <rect x="25" y="115" width="40" height="8" rx="3" fill="#374151" />
                    <rect x="15" y="123" width="60" height="5" rx="2.5" fill="#374151" />
                </svg>
            </div>

            {/* Screwdriver */}
            <div
                className="absolute"
                style={{
                    right: 15,
                    top: "72%",
                    animation: "err-wander 6s 1s ease-in-out infinite",
                }}
            >
                <svg width="24" height="80" viewBox="0 0 24 80" fill="none" style={{ transform: "rotate(20deg)" }}>
                    <rect x="9" y="0" width="6" height="50" rx="3" fill="#6b7280" />
                    <rect x="10" y="50" width="4" height="25" rx="2" fill="#9ca3af" />
                    <path d="M8 74 L12 80 L16 74Z" fill="#4b5563" />
                    {/* Handle grip lines */}
                    {[8, 16, 24, 32].map((y) => (
                        <line key={y} x1="9" y1={y} x2="15" y2={y} stroke="#4b5563" strokeWidth="1.5" />
                    ))}
                </svg>
            </div>

            {/* Under maintenance banner */}
            <div
                className="absolute font-mono text-xs font-black border-2 rounded px-2 py-0.5"
                style={{
                    right: 5,
                    top: "88%",
                    borderColor: "#f59e0b",
                    color: "#f59e0b",
                    opacity: 0.5,
                    transform: "rotate(-4deg)",
                    animation: "err-pulse-op 2s ease-in-out infinite",
                    whiteSpace: "nowrap",
                }}
            >
                UNDER MAINTENANCE
            </div>
        </div>
    );
}

/* ══════════════════════════════════════════════════════════════════════════════
   400 — Bad Request
   ══════════════════════════════════════════════════════════════════════════════ */
export function BadRequest({ title: titleProp, subtitle: subtitleProp } = {}) {
    const { title, subtitle } = useErrorOverrides("You said what now?", "The request arrived garbled beyond comprehension. Even the server looked twice.", titleProp, subtitleProp);
    return (
        <ErrorLayout
            code="400"
            title={title}
            subtitle={subtitle}
            linkTo="/"
            linkLabel="Start fresh"
            accentClass="text-warn-500 dark:text-warn-400"
            bgClass="bg-gradient-to-br from-white via-warn-50/30 to-yellow-50/20 dark:from-[var(--bg-surface)] dark:via-[var(--bg-surface-2)] dark:to-[var(--bg-surface)]"
            illustration={<BadRequestIllustration />}
            leftDecor={<TerminalLeftDecor />}
            rightDecor={<TerminalRightDecor />}
        />
    );
}

function BadRequestIllustration() {
    const lines = [
        { text: "POST /api/v1/????", y: 54, glitch: true },
        { text: "Content-Type: ␃␄⏎⌂", y: 74 },
        { text: "{ ¿¿id¿¿: NaN,", y: 94 },
        { text: '  name: "⟨◆☒⟩",', y: 114, glitch: true },
        { text: "  payload: undefined", y: 134 },
        { text: "  ██████: ░░░▓▓▓ }", y: 154 },
    ];

    return (
        <div className="relative" style={{ width: 280, height: 200 }}>
            <div
                className="overflow-hidden border rounded-xl border-warn-400/30 dark:border-warn-400/20 bg-grey-900 dark:bg-black/70"
                style={{
                    width: 280,
                    animation: "err-shake 2.4s ease-in-out infinite",
                }}
            >
                <div className="flex items-center gap-1.5 px-3 py-2 bg-grey-800/80">
                    <span className="w-3 h-3 rounded-full bg-danger-400" />
                    <span className="w-3 h-3 rounded-full bg-warn-400" />
                    <span className="w-3 h-3 rounded-full bg-success-400" />
                    <span className="ml-2 font-mono text-xs text-grey-500">request.json</span>
                </div>
                <div className="px-4 py-3 font-mono text-xs space-y-0.5">
                    {lines.map((l, i) => (
                        <div
                            key={i}
                            className="text-warn-300"
                            style={
                                l.glitch
                                    ? {
                                          animation: `err-glitch 3s ${i * 0.4}s infinite`,
                                      }
                                    : {}
                            }
                        >
                            <span className="mr-2 text-grey-600">{i + 1}</span>
                            {l.text}
                        </div>
                    ))}
                </div>
                <div className="px-4 pb-3 font-mono text-xs text-warn-400" style={{ animation: "err-blink 1s step-end infinite" }}>
                    ▌
                </div>
            </div>
            <div className="absolute px-2 py-1 text-xs text-black rounded-full shadow-lg -top-3 -right-3 bg-warn-400 font-aumovio-bold" style={{ animation: "err-spark 1.5s ease-in-out infinite" }}>
                MALFORMED
            </div>
        </div>
    );
}

/* ══════════════════════════════════════════════════════════════════════════════
   401 — Unauthorized
   ══════════════════════════════════════════════════════════════════════════════ */
export function Unauthorized({ title: titleProp, subtitle: subtitleProp } = {}) {
    const { title, subtitle } = useErrorOverrides("Access denied.", "You don't have clearance for this zone. Credentials, please.", titleProp, subtitleProp);
    return <ErrorLayout code="401" title={title} subtitle={subtitle} linkTo="/" linkLabel="Return to safety" accentClass="text-purple-400" bgClass="bg-gradient-to-br from-white via-purple-50/20 to-white dark:from-[var(--bg-surface)] dark:via-purple-950/30 dark:to-[var(--bg-surface)]" illustration={<UnauthorizedIllustration />} leftDecor={<VaultLeftDecor />} rightDecor={<VaultRightDecor />} />;
}

function UnauthorizedIllustration() {
    return (
        <div className="relative flex items-center justify-center" style={{ width: 200, height: 200 }}>
            <div
                className="absolute border-2 border-dashed rounded-full border-purple-400/30"
                style={{
                    width: 196,
                    height: 196,
                    animation: "err-spin-slow 12s linear infinite",
                }}
            />
            <div
                className="absolute border rounded-full border-purple-400/20"
                style={{
                    width: 160,
                    height: 160,
                    animation: "err-spin-rev 8s linear infinite",
                }}
            >
                {[0, 60, 120, 180, 240, 300].map((deg) => (
                    <div
                        key={deg}
                        className="absolute w-2 h-2 rounded-full bg-purple-400/50"
                        style={{
                            top: "50%",
                            left: "50%",
                            transform: `rotate(${deg}deg) translateX(78px) translateY(-50%)`,
                        }}
                    />
                ))}
            </div>
            <div
                className="relative flex items-center justify-center border-4 border-purple-400 rounded-full bg-grey-100 dark:bg-(--bg-surface-3)"
                style={{
                    width: 120,
                    height: 120,
                    animation: "err-float 3.5s ease-in-out infinite",
                }}
            >
                {[0, 45, 90, 135].map((deg) => (
                    <div
                        key={deg}
                        className="absolute bg-purple-400/60"
                        style={{
                            width: 3,
                            height: 52,
                            borderRadius: 2,
                            transform: `rotate(${deg}deg)`,
                            transformOrigin: "50% 50%",
                        }}
                    />
                ))}
                <div className="absolute z-10 flex items-center justify-center w-10 h-10 bg-purple-400 rounded-full shadow-lg shadow-purple-400/40">
                    <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
                        <circle cx="11" cy="8" r="4" fill="white" />
                        <path d="M8 8 L7 18 H15 L14 8" fill="white" />
                    </svg>
                </div>
            </div>
            <div className="absolute bottom-0 px-3 py-1 text-xs text-white -translate-x-1/2 rounded-full left-1/2 bg-danger-400 font-aumovio-bold" style={{ animation: "err-pulse-op 2s ease-in-out infinite" }}>
                REJECTED
            </div>
        </div>
    );
}

/* ══════════════════════════════════════════════════════════════════════════════
   404 — Page Not Found
   ══════════════════════════════════════════════════════════════════════════════ */
export function PageNotFound({ title: titleProp, subtitle: subtitleProp } = {}) {
    const { title, subtitle } = useErrorOverrides("Lost in the void.", "This page packed its bags and went exploring. We have no idea where it ended up.", titleProp, subtitleProp);
    return <ErrorLayout code="404" title={title} subtitle={subtitle} linkTo="/" linkLabel="Beam me home" accentClass="text-blue-400" bgClass="bg-gradient-to-br from-white via-blue-50/20 to-white dark:from-[#06080F] dark:via-[#0a1020] dark:to-[#06080F]" illustration={<PageNotFoundIllustration />} leftDecor={<SpaceLeftDecor />} rightDecor={<SpaceRightDecor />} />;
}

function PageNotFoundIllustration() {
    return (
        <div className="relative flex items-center justify-center" style={{ width: 220, height: 220 }}>
            {[
                [20, 30],
                [180, 20],
                [40, 160],
                [190, 150],
                [100, 10],
                [160, 90],
            ].map(([cx, cy], i) => (
                <div
                    key={i}
                    className="absolute bg-blue-400 rounded-full"
                    style={{
                        width: i % 2 ? 3 : 2,
                        height: i % 2 ? 3 : 2,
                        left: cx,
                        top: cy,
                        animation: `err-pulse-op ${1 + i * 0.3}s ${i * 0.2}s ease-in-out infinite`,
                    }}
                />
            ))}
            <div className="absolute border border-dashed rounded-full border-blue-400/20" style={{ width: 180, height: 180 }} />
            <div
                className="absolute"
                style={{
                    width: 180,
                    height: 180,
                    animation: "err-orbit 6s linear infinite",
                }}
            >
                <div className="w-5 h-5 rounded-full bg-orange-400 shadow-lg shadow-orange-400/40 -mt-2.5" />
            </div>
            <div
                className="relative border-2 rounded-full bg-linear-to-br from-blue-300 to-blue-500 dark:from-blue-700 dark:to-blue-900 border-blue-400/40"
                style={{
                    width: 90,
                    height: 90,
                    animation: "err-float 4s ease-in-out infinite",
                }}
            >
                <div className="absolute w-5 h-5 border rounded-full border-blue-400/30 dark:border-blue-300/20" style={{ top: 16, left: 14 }} />
                <div className="absolute w-3 h-3 border rounded-full border-blue-400/30 dark:border-blue-300/20" style={{ top: 44, left: 52 }} />
                <div className="absolute inset-0 flex items-center justify-center text-2xl text-white font-aumovio-bold">?</div>
            </div>
            <div
                className="absolute"
                style={{
                    right: 8,
                    top: 30,
                    animation: "err-wander 5s ease-in-out infinite",
                }}
            >
                <div className="relative">
                    <div className="flex items-center justify-center w-10 h-10 border-2 rounded-full bg-grey-200 dark:bg-grey-700 border-grey-300 dark:border-grey-600">
                        <div className="w-6 h-6 bg-blue-100 border border-blue-300 rounded-full dark:bg-blue-900 dark:border-blue-600" />
                    </div>
                    <div className="w-8 mx-auto -mt-1 border-2 rounded-b-lg h-9 bg-grey-200 dark:bg-grey-700 border-grey-300 dark:border-grey-600" />
                    <div className="absolute w-3 h-2 border rounded-full bg-grey-200 dark:bg-grey-700 border-grey-300 dark:border-grey-600 -left-3 top-10" style={{ transform: "rotate(-20deg)" }} />
                    <div className="absolute w-3 h-2 border rounded-full bg-grey-200 dark:bg-grey-700 border-grey-300 dark:border-grey-600 -right-3 top-10" style={{ transform: "rotate(20deg)" }} />
                </div>
            </div>
        </div>
    );
}

/* ══════════════════════════════════════════════════════════════════════════════
   440 — Login Timeout
   ══════════════════════════════════════════════════════════════════════════════ */
export function LoginTimeOut({ title: titleProp, subtitle: subtitleProp } = {}) {
    const { title, subtitle } = useErrorOverrides("Time stole your session.", "You were gone a little too long. Your session slipped away while you were distracted.", titleProp, subtitleProp);

    useEffect(() => {
        import.meta.env.VITE_ENV === "development" ? "" : AuthMiddleware.signout();
        CsrfMiddleware.clearToken();
    }, []);

    return <ErrorLayout code="440" title={title} subtitle={subtitle} linkTo="/auth" linkLabel="Sign in again" accentClass="text-orange-400" bgClass="bg-gradient-to-br from-white via-orange-50/20 to-white dark:from-[var(--bg-surface)] dark:via-[#180a00] dark:to-[var(--bg-surface)]" illustration={<LoginTimeOutIllustration />} leftDecor={<TimeLeftDecor />} rightDecor={<TimeRightDecor />} />;
}

function LoginTimeOutIllustration() {
    return (
        <div className="relative flex items-center justify-center" style={{ width: 200, height: 220 }}>
            <div className="relative flex flex-col items-center" style={{ animation: "err-float 3s ease-in-out infinite" }}>
                <div className="w-24 h-3 bg-orange-400 rounded-t-lg" />
                <div
                    className="relative overflow-hidden border-l-2 border-r-2 bg-orange-50 dark:bg-orange-950/40 border-orange-400/50"
                    style={{
                        width: 96,
                        height: 72,
                        clipPath: "polygon(0 0, 100% 0, 50% 100%, 50% 100%)",
                    }}
                >
                    <div
                        className="absolute bottom-0 left-0 right-0 bg-orange-400"
                        style={{
                            height: "30%",
                            animation: "err-sand 2s ease-in-out infinite alternate",
                        }}
                    />
                </div>
                <div className="flex flex-col items-center">
                    <div className="w-1 h-4 bg-orange-400/60" />
                    <div
                        className="w-2 h-2 bg-orange-400 rounded-full"
                        style={{
                            animation: "err-drop .8s ease-in-out infinite",
                        }}
                    />
                </div>
                <div
                    className="relative overflow-hidden border-l-2 border-r-2 bg-orange-50 dark:bg-orange-950/40 border-orange-400/50"
                    style={{
                        width: 96,
                        height: 72,
                        clipPath: "polygon(50% 0, 50% 0, 100% 100%, 0 100%)",
                    }}
                >
                    <div className="absolute bottom-0 left-0 right-0 bg-orange-400 rounded-b" style={{ height: "65%" }} />
                </div>
                <div className="w-24 h-3 bg-orange-400 rounded-b-lg" />
            </div>
            <div
                className="absolute border border-dashed rounded-full border-orange-400/25"
                style={{
                    width: 190,
                    height: 190,
                    animation: "err-spin-slow 20s linear infinite",
                }}
            />
            {[0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].map((deg, i) => (
                <div
                    key={deg}
                    className="absolute text-xs font-aumovio-bold text-orange-400/40"
                    style={{
                        width: 190,
                        height: 190,
                        top: 0,
                        left: 0,
                        display: "flex",
                        alignItems: "flex-start",
                        justifyContent: "center",
                        transform: `rotate(${deg}deg)`,
                        transformOrigin: "center center",
                        position: "absolute",
                        paddingTop: 4,
                    }}
                >
                    {i % 3 === 0 ? "—" : "·"}
                </div>
            ))}
            <div className="absolute px-3 py-1 text-xs text-white bg-orange-400 rounded-full -bottom-2 font-aumovio-bold" style={{ animation: "err-pulse-op 1.5s ease-in-out infinite" }}>
                SESSION EXPIRED
            </div>
        </div>
    );
}

/* ══════════════════════════════════════════════════════════════════════════════
   498 — Invalid Token
   ══════════════════════════════════════════════════════════════════════════════ */
export function InvalidToken({ title: titleProp, subtitle: subtitleProp } = {}) {
    const { title, subtitle } = useErrorOverrides("Token corrupted.", "Your access token arrived in pieces. Someone's been tampering — or time ate it.", titleProp, subtitleProp);

    useEffect(() => {
        import.meta.env.VITE_ENV === "development" ? "" : AuthMiddleware.signout();
        CsrfMiddleware.clearToken();
    }, []);

    return (
        <ErrorLayout code="498" title={title} subtitle={subtitle} linkTo="/auth" linkLabel="Get a fresh token" accentClass="text-danger-400" bgClass="bg-gradient-to-br from-white via-danger-50/20 to-white dark:from-[var(--bg-surface)] dark:via-[#160606] dark:to-[var(--bg-surface)]" illustration={<InvalidTokenIllustration />} leftDecor={<CircuitLeftDecor />} rightDecor={<CircuitRightDecor />} />
    );
}

function InvalidTokenIllustration() {
    return (
        <div className="relative flex items-center justify-center" style={{ width: 220, height: 200 }}>
            <div
                className="absolute"
                style={{
                    left: 30,
                    top: 30,
                    animation: "err-drift-l 2.5s ease-in-out infinite",
                }}
            >
                <svg width="70" height="70" viewBox="0 0 70 70" fill="none">
                    <circle cx="35" cy="35" r="24" stroke="#D82822" strokeWidth="5" strokeDasharray="8 3" opacity=".8" />
                    <circle cx="35" cy="35" r="14" stroke="#D82822" strokeWidth="3" opacity=".4" />
                    <path d="M35 11 L32 25 L38 35 L30 50" stroke="#D82822" strokeWidth="2" strokeLinecap="round" opacity=".9" />
                </svg>
            </div>
            <div
                className="absolute"
                style={{
                    right: 20,
                    bottom: 30,
                    animation: "err-drift-r 3s ease-in-out infinite",
                }}
            >
                <svg width="100" height="50" viewBox="0 0 100 50" fill="none">
                    <rect x="0" y="20" width="60" height="10" rx="2" fill="#D82822" opacity=".7" />
                    <rect x="12" y="12" width="8" height="8" rx="1" fill="#D82822" opacity=".8" />
                    <rect x="28" y="12" width="8" height="8" rx="1" fill="#D82822" opacity=".6" />
                    <rect x="42" y="12" width="8" height="8" rx="1" fill="#D82822" opacity=".7" />
                    <path d="M60 18 L68 22 L63 26 L72 30" stroke="#D82822" strokeWidth="2" strokeLinecap="round" opacity=".6" />
                    <rect
                        x="72"
                        y="16"
                        width="22"
                        height="14"
                        rx="2"
                        fill="#D82822"
                        opacity=".3"
                        style={{
                            animation: "err-static 1.5s ease-in-out infinite",
                        }}
                    />
                </svg>
            </div>
            <div
                className="absolute border rounded-full bg-danger-400/15 border-danger-400/30"
                style={{
                    width: 90,
                    height: 90,
                    animation: "err-pulse-op 1.8s ease-in-out infinite",
                }}
            >
                <div
                    className="absolute border rounded-full inset-4 bg-danger-400/20 border-danger-400/40"
                    style={{
                        animation: "err-pulse-op 1.8s .4s ease-in-out infinite",
                    }}
                />
            </div>
            {["0xA3", "FF", "??", "NaN", "err"].map((t, i) => (
                <div
                    key={i}
                    className="absolute font-mono text-xs text-danger-400/60 font-aumovio-bold"
                    style={{
                        top: [10, 60, 140, 20, 160][i],
                        left: [120, 160, 140, 60, 40][i],
                        animation: `err-${i % 2 ? "drift-l" : "drift-r"} ${2 + i * 0.3}s ${i * 0.2}s ease-in-out infinite`,
                        transform: `rotate(${[-15, 20, -10, 25, -5][i]}deg)`,
                    }}
                >
                    {t}
                </div>
            ))}
            <div className="absolute bottom-0 px-3 py-1 text-xs -translate-x-1/2 border rounded-md left-1/2 bg-danger-100 dark:bg-danger-400/15 border-danger-400/30 text-danger-400 font-aumovio-bold whitespace-nowrap">VERIFICATION FAILED</div>
        </div>
    );
}

/* ══════════════════════════════════════════════════════════════════════════════
   523 — Service Unavailable
   ══════════════════════════════════════════════════════════════════════════════ */
export function ServiceUnavailable({ title: titleProp, subtitle: subtitleProp } = {}) {
    const { title, subtitle } = useErrorOverrides("The server is napping.", "This is usually caused by a temporary network issue, server restart, or the application service being unavailable.", titleProp, subtitleProp);
    return (
        <ErrorLayout
            code="523"
            title={title}
            subtitle={subtitle}
            linkTo="/"
            linkLabel="Try the home page"
            accentClass="text-purple-400 dark:text-purple-300"
            bgClass="bg-gradient-to-br from-white via-purple-50/20 to-white dark:from-[var(--bg-surface)] dark:via-[#120a1e] dark:to-[var(--bg-surface)]"
            illustration={<ServiceUnavailableIllustration />}
            leftDecor={<ServerLeftDecor />}
            rightDecor={<ServerRightDecor />}
        >
            <div className="p-4 mt-4 text-sm text-left border bg-white/60 dark:bg-white/5 border-purple-400/20 rounded-xl text-grey-600 dark:text-grey-400 font-aumovio">
                <p className="mb-2 font-aumovio-bold text-black/70 dark:text-white/70">If this keeps happening, note:</p>
                <ul className="space-y-1 list-disc list-inside">
                    <li>The time it occurred</li>
                    <li>What you were doing when it happened</li>
                    <li>Any error messages you saw</li>
                </ul>
            </div>
        </ErrorLayout>
    );
}

function ServiceUnavailableIllustration() {
    return (
        <div className="relative flex items-center justify-center" style={{ width: 220, height: 220 }}>
            <div className="relative" style={{ animation: "err-float 4s ease-in-out infinite" }}>
                <div className="relative overflow-hidden border-2 bg-grey-100 dark:bg-(--bg-surface-3) border-grey-300 dark:border-grey-600 rounded-xl" style={{ width: 110, height: 130 }}>
                    {[0, 1, 2, 3].map((i) => (
                        <div key={i} className="flex items-center gap-2 px-3 py-2 border-b border-grey-200 dark:border-grey-700">
                            <div
                                className={`w-2 h-2 rounded-full ${i === 1 ? "bg-danger-400" : "bg-grey-400 dark:bg-grey-600"}`}
                                style={
                                    i === 1
                                        ? {
                                              animation: "err-pulse-op 1.5s ease-in-out infinite",
                                          }
                                        : {}
                                }
                            />
                            <div className="flex-1 h-1.5 rounded-full bg-grey-200 dark:bg-grey-700" />
                        </div>
                    ))}
                    <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                        <div className="flex gap-4 mb-2">
                            <svg width="14" height="8" viewBox="0 0 14 8">
                                <path d="M1 1 Q7 8 13 1" stroke="#9ca3af" strokeWidth="2" fill="none" strokeLinecap="round" />
                            </svg>
                            <svg width="14" height="8" viewBox="0 0 14 8">
                                <path d="M1 1 Q7 8 13 1" stroke="#9ca3af" strokeWidth="2" fill="none" strokeLinecap="round" />
                            </svg>
                        </div>
                        <svg width="20" height="10" viewBox="0 0 20 10">
                            <path d="M2 2 Q10 10 18 2" stroke="#9ca3af" strokeWidth="2" fill="none" strokeLinecap="round" />
                        </svg>
                    </div>
                </div>
                <div className="w-full h-4 border-b-2 rounded-b-lg bg-grey-200 dark:bg-grey-700 border-x-2 border-grey-300 dark:border-grey-600" />
            </div>
            {[
                {
                    text: "z",
                    size: 16,
                    style: { left: 140, top: 80, animationDelay: "0s" },
                },
                {
                    text: "Z",
                    size: 20,
                    style: { left: 158, top: 55, animationDelay: ".5s" },
                },
                {
                    text: "Z",
                    size: 26,
                    style: { left: 172, top: 24, animationDelay: "1s" },
                },
            ].map(({ text, size, style }, i) => (
                <div
                    key={i}
                    className="absolute text-purple-400 font-aumovio-bold"
                    style={{
                        fontSize: size,
                        animation: `err-zzz 2.5s ${style.animationDelay} ease-in-out infinite`,
                        ...style,
                    }}
                >
                    {text}
                </div>
            ))}
            <div className="absolute bottom-4 left-8" style={{ animation: "err-shake 2s ease-in-out infinite" }}>
                <svg width="28" height="32" viewBox="0 0 28 32" fill="none">
                    <path d="M14 2L26 30H2L14 2Z" fill="#FFD600" stroke="#B39600" strokeWidth="1.5" />
                    <rect x="2" y="24" width="24" height="4" rx="2" fill="#FFD600" stroke="#B39600" strokeWidth="1" />
                    <path d="M13 10V18M13 22V23" stroke="#B39600" strokeWidth="2" strokeLinecap="round" />
                </svg>
            </div>
        </div>
    );
}

/* ══════════════════════════════════════════════════════════════════════════════
   FINGERPRINT / SEAL DECORS  (422)
   ══════════════════════════════════════════════════════════════════════════════ */
function SealLeftDecor() {
    const dotPositions = [
        [18, "8%"],
        [62, "16%"],
        [28, "30%"],
        [80, "24%"],
        [44, "42%"],
        [75, "52%"],
        [20, "64%"],
        [58, "70%"],
        [10, "82%"],
        [72, "88%"],
        [40, "94%"],
    ];

    return (
        <div className="absolute inset-0">
            {/* Wax seal stamp */}
            <div className="absolute" style={{ left: 8, top: "8%", animation: "err-floatxs 5s ease-in-out infinite" }}>
                <svg width="150" height="150" viewBox="0 0 150 150" fill="none">
                    <defs>
                        <radialGradient id="seal-grad" cx="40%" cy="35%">
                            <stop offset="0%" stopColor="#D85A30" />
                            <stop offset="100%" stopColor="#7f2810" />
                        </radialGradient>
                    </defs>
                    {/* Wax blob */}
                    <path d="M75 10 C110 12 142 38 140 75 C138 112 110 142 75 140 C40 138 10 108 10 75 C10 42 40 8 75 10Z" fill="url(#seal-grad)" opacity="0.85" />
                    {/* Embossed pattern rings */}
                    <circle cx="75" cy="75" r="50" fill="none" stroke="#f97316" strokeWidth="1.5" opacity="0.4" />
                    <circle cx="75" cy="75" r="38" fill="none" stroke="#f97316" strokeWidth="1" opacity="0.3" />
                    {/* X mark — tampered */}
                    <path d="M55 55 L95 95 M95 55 L55 95" stroke="#fca5a5" strokeWidth="4" strokeLinecap="round" style={{ animation: "err-pulse-op 2s ease-in-out infinite" }} />
                    {/* Wax edge texture */}
                    {[0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].map((deg, i) => (
                        <ellipse key={i} cx={75 + 62 * Math.cos((deg * Math.PI) / 180)} cy={75 + 62 * Math.sin((deg * Math.PI) / 180)} rx="5" ry="3" fill="#b83c15" opacity="0.6" transform={`rotate(${deg}, ${75 + 62 * Math.cos((deg * Math.PI) / 180)}, ${75 + 62 * Math.sin((deg * Math.PI) / 180)})`} />
                    ))}
                </svg>
            </div>

            {/* Hash stream left side */}
            {["a3f9·2c18", "INVALID→", "c42a·0d??", "sig≠hash", "b81d·5e90"].map((label, i) => (
                <div
                    key={i}
                    className="absolute font-mono text-xs"
                    style={{
                        left: 10 + (i % 2) * 40,
                        top: `${46 + i * 9}%`,
                        color: i % 2 === 0 ? "#c04828" : "#6b7280",
                        opacity: 0.45 + (i % 3) * 0.1,
                        animation: `err-drift-${i % 2 === 0 ? "l" : "r"} ${2.5 + i * 0.3}s ${i * 0.2}s ease-in-out infinite`,
                    }}
                >
                    {label}
                </div>
            ))}

            {/* Broken chain links */}
            <div className="absolute" style={{ left: 20, top: "75%", animation: "err-bob 4s ease-in-out infinite" }}>
                <svg width="110" height="50" viewBox="0 0 110 50" fill="none" opacity="0.5">
                    {/* Link 1 */}
                    <ellipse cx="18" cy="25" rx="14" ry="9" fill="none" stroke="#6b7280" strokeWidth="3" />
                    {/* Break gap */}
                    <line x1="32" y1="20" x2="44" y2="20" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" opacity="0.7" />
                    <line x1="32" y1="30" x2="44" y2="30" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" opacity="0.5" />
                    {/* Link 2 */}
                    <ellipse cx="62" cy="25" rx="14" ry="9" fill="none" stroke="#6b7280" strokeWidth="3" />
                    <line x1="76" y1="20" x2="88" y2="20" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" opacity="0.7" />
                    <line x1="76" y1="30" x2="88" y2="30" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" opacity="0.5" />
                    {/* Link 3 — floating away */}
                    <ellipse cx="102" cy="22" rx="8" ry="6" fill="none" stroke="#6b7280" strokeWidth="2.5" opacity="0.6" style={{ animation: "err-floatxs 2.5s ease-in-out infinite" }} />
                </svg>
            </div>

            {/* Scattered dots (redacted / corrupted data) */}
            {dotPositions.map(([left, top], i) => (
                <div
                    key={i}
                    className="absolute rounded-full bg-orange-400"
                    style={{
                        left,
                        top,
                        width: i % 4 === 0 ? 3 : 2,
                        height: i % 4 === 0 ? 3 : 2,
                        opacity: 0.2 + (i % 3) * 0.12,
                        animation: `err-twinkle ${1.3 + i * 0.35}s ${i * 0.15}s ease-in-out infinite`,
                    }}
                />
            ))}

            {/* Warning: REJECTED stamp */}
            <div
                className="absolute font-mono font-black text-xs border-2 rounded px-2 py-0.5"
                style={{
                    left: 18,
                    top: "91%",
                    borderColor: "#D85A30",
                    color: "#D85A30",
                    opacity: 0.5,
                    transform: "rotate(-5deg)",
                    animation: "err-pulse-op 2.5s ease-in-out infinite",
                }}
            >
                SIG INVALID
            </div>
        </div>
    );
}

function SealRightDecor() {
    return (
        <div className="absolute inset-0">
            {/* Signature slip / envelope */}
            <div className="absolute" style={{ right: 10, top: "6%", animation: "err-floatxs 5s 1s ease-in-out infinite" }}>
                <svg width="140" height="100" viewBox="0 0 140 100" fill="none">
                    <rect x="4" y="4" width="132" height="92" rx="6" fill="#111827" stroke="#374151" strokeWidth="1.5" />
                    {/* Envelope flap */}
                    <path d="M4 4 L70 52 L136 4Z" fill="#1f2937" stroke="#374151" strokeWidth="1" />
                    {/* Contents — hash lines */}
                    <text x="14" y="68" fontFamily="monospace" fontSize="7" fill="#6b7280">
                        HMAC-SHA256
                    </text>
                    <rect x="14" y="74" width="80" height="4" rx="1" fill="#374151" />
                    <rect x="14" y="81" width="100" height="4" rx="1" fill="#374151" />
                    {/* Red X corner stamp */}
                    <path d="M112 60 L130 80 M130 60 L112 80" stroke="#ef4444" strokeWidth="2.5" strokeLinecap="round" style={{ animation: "err-pulse-op 1.5s ease-in-out infinite" }} />
                </svg>
            </div>

            {/* Compare panel — two columns */}
            <div className="absolute" style={{ right: 6, top: "32%", animation: "err-floatxs 4s ease-in-out infinite" }}>
                <svg width="150" height="110" viewBox="0 0 150 110" fill="none" opacity="0.6">
                    <rect x="0" y="0" width="150" height="110" rx="5" fill="#111827" stroke="#374151" strokeWidth="1" />
                    <rect x="0" y="0" width="150" height="16" rx="5" fill="#1f2937" />
                    <text x="8" y="11" fontFamily="monospace" fontSize="7" fill="#6b7280">
                        SIGNATURE COMPARE
                    </text>
                    <line x1="75" y1="0" x2="75" y2="110" stroke="#374151" strokeWidth="0.8" />
                    <text x="10" y="28" fontFamily="monospace" fontSize="6" fill="#22c55e">
                        Expected
                    </text>
                    <text x="82" y="28" fontFamily="monospace" fontSize="6" fill="#ef4444">
                        Received
                    </text>
                    {[
                        ["a3f9", "a3f9", true],
                        ["2c18", "2c18", true],
                        ["e047", "e047", true],
                        ["b81d", "b81d", true],
                        ["c42a", "d99f", false],
                        ["9e51", "3b7a", false],
                    ].map(([exp, got, match], i) => (
                        <g key={i}>
                            <text x="10" y={40 + i * 11} fontFamily="monospace" fontSize="6.5" fill={match ? "#22c55e" : "#6b7280"}>
                                {exp}
                            </text>
                            <text x="82" y={40 + i * 11} fontFamily="monospace" fontSize="6.5" fill={match ? "#22c55e" : "#ef4444"} style={!match ? { animation: "err-static 1.2s ease-in-out infinite" } : {}}>
                                {got}
                            </text>
                            {!match && (
                                <text x="60" y={40 + i * 11} fontFamily="monospace" fontSize="8" fill="#ef4444">
                                    ≠
                                </text>
                            )}
                        </g>
                    ))}
                </svg>
            </div>

            {/* Floating tamper badges */}
            {["TAMPERED", "REPLAY?", "BAD KEY"].map((label, i) => (
                <div
                    key={i}
                    className="absolute font-mono font-black text-xs border rounded px-2 py-0.5"
                    style={{
                        right: 12 + i * 8,
                        top: `${72 + i * 6}%`,
                        borderColor: "#D85A30",
                        color: "#D85A30",
                        opacity: 0.35 + i * 0.08,
                        transform: `rotate(${-6 + i * 7}deg)`,
                        animation: `err-pulse-op ${2 + i * 0.5}s ${i * 0.3}s ease-in-out infinite`,
                    }}
                >
                    {label}
                </div>
            ))}

            {/* Key icon — wrong/broken */}
            <div className="absolute" style={{ right: 25, top: "55%", animation: "err-wander 6s 2s ease-in-out infinite" }}>
                <svg width="60" height="60" viewBox="0 0 60 60" fill="none" opacity="0.5">
                    <circle cx="22" cy="22" r="14" fill="none" stroke="#6b7280" strokeWidth="3" />
                    <circle cx="22" cy="22" r="7" fill="none" stroke="#6b7280" strokeWidth="2" />
                    <line x1="32" y1="32" x2="54" y2="54" stroke="#6b7280" strokeWidth="3" strokeLinecap="round" />
                    <line x1="44" y1="42" x2="50" y2="38" stroke="#6b7280" strokeWidth="2.5" strokeLinecap="round" />
                    {/* Red X through key */}
                    <path d="M10 10 L34 34 M34 10 L10 34" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" opacity="0.6" style={{ animation: "err-flicker 2s ease-in-out infinite" }} />
                </svg>
            </div>

            {/* Hex corruption bottom */}
            <div className="absolute" style={{ right: 0, top: "90%" }}>
                <svg width="160" height="30" viewBox="0 0 160 30" fill="none" opacity="0.3">
                    {["3F", "??", "C4", "XX", "A9", "00", "??", "B2", "FF", "!!"].map((h, i) => (
                        <text key={i} x={i * 16 + 2} y={12 + (i % 2) * 10} fontFamily="monospace" fontSize="9" fill={["??", "XX", "!!"].includes(h) ? "#ef4444" : "#374151"} style={{ animation: `err-static ${1 + i * 0.12}s ${i * 0.06}s ease-in-out infinite` }}>
                            {h}
                        </text>
                    ))}
                </svg>
            </div>
        </div>
    );
}

/* ══════════════════════════════════════════════════════════════════════════════
   422 — Unprocessable Entity (Signature Mismatch)
   ══════════════════════════════════════════════════════════════════════════════ */
export function SignatureMismatch() {
    return (
        <ErrorLayout
            code="422"
            title="The seal has been broken."
            subtitle="Your request arrived intact — but the signature doesn't match. The payload may have been altered in transit, or the wrong signing key was used."
            linkTo="/"
            linkLabel="Start over"
            accentClass="text-orange-400"
            bgClass="bg-gradient-to-br from-white via-orange-50/20 to-white dark:from-[var(--bg-surface)] dark:via-[#180a00] dark:to-[var(--bg-surface)]"
            illustration={<SignatureMismatchIllustration />}
            leftDecor={<SealLeftDecor />}
            rightDecor={<SealRightDecor />}
        >
            <div className="p-4 mt-2 text-sm text-left border bg-white/60 dark:bg-white/5 border-orange-400/20 rounded-xl text-grey-600 dark:text-grey-400 font-aumovio space-y-1">
                <p className="font-aumovio-bold text-black/70 dark:text-white/70 mb-2">Common causes:</p>
                <ul className="space-y-1 list-disc list-inside">
                    <li>Payload was modified after signing</li>
                    <li>Signing key mismatch or rotation</li>
                    <li>Replay with an expired or reused token</li>
                    <li>Missing or extra fields in the body</li>
                </ul>
            </div>
        </ErrorLayout>
    );
}

function SignatureMismatchIllustration() {
    return (
        <div className="relative flex items-center justify-center" style={{ width: 240, height: 210 }}>
            {/* Outer spinning dashed ring */}
            <div className="absolute border-2 border-dashed rounded-full border-orange-400/25" style={{ width: 200, height: 200, animation: "err-spin-slow 18s linear infinite" }} />
            {/* Inner counter-ring */}
            <div className="absolute border rounded-full border-danger-400/20" style={{ width: 160, height: 160, animation: "err-spin-rev 12s linear infinite" }}>
                {[0, 72, 144, 216, 288].map((deg) => (
                    <div
                        key={deg}
                        className="absolute w-2 h-2 rounded-full bg-danger-400/40"
                        style={{
                            top: "50%",
                            left: "50%",
                            transform: `rotate(${deg}deg) translateX(78px) translateY(-50%)`,
                        }}
                    />
                ))}
            </div>

            {/* Core shield */}
            <div className="relative flex items-center justify-center border-4 border-orange-400 rounded-full bg-grey-100 dark:bg-(--bg-surface-3)" style={{ width: 110, height: 110, animation: "err-float 3.5s ease-in-out infinite" }}>
                {/* Hash-grid lines behind icon */}
                {[0, 45, 90, 135].map((deg) => (
                    <div key={deg} className="absolute bg-orange-400/30" style={{ width: 2, height: 48, borderRadius: 2, transform: `rotate(${deg}deg)`, transformOrigin: "50% 50%" }} />
                ))}
                {/* Shield + X icon */}
                <div className="absolute z-10 flex items-center justify-center w-12 h-12 bg-danger-400 rounded-full shadow-lg shadow-danger-400/30">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                        <path d="M12 2L4 5v6c0 5.25 3.5 10.15 8 11.35C16.5 21.15 20 16.25 20 11V5l-8-3z" fill="white" opacity="0.2" />
                        <path d="M8 8 L16 16 M16 8 L8 16" stroke="white" strokeWidth="2.5" strokeLinecap="round" />
                    </svg>
                </div>
            </div>

            {/* Left label: Expected */}
            <div className="absolute left-0 flex flex-col items-center" style={{ top: "50%", transform: "translateY(-60%)", animation: "err-drift-l 2.5s ease-in-out infinite" }}>
                <div className="px-2 py-1 text-xs font-mono rounded bg-success-400/10 border border-success-400/30 text-success-500 dark:text-success-400 font-aumovio-bold whitespace-nowrap">a3f9·c42a</div>
                <div className="mt-1 text-xs text-grey-400 font-aumovio">expected</div>
            </div>

            {/* Right label: Received */}
            <div className="absolute right-0 flex flex-col items-center" style={{ top: "50%", transform: "translateY(-60%)", animation: "err-drift-r 2.5s ease-in-out infinite" }}>
                <div className="px-2 py-1 text-xs font-mono rounded bg-danger-400/10 border border-danger-400/30 text-danger-400 font-aumovio-bold whitespace-nowrap">a3f9·d99f</div>
                <div className="mt-1 text-xs text-grey-400 font-aumovio">received</div>
            </div>

            {/* Bottom label */}
            <div className="absolute bottom-0 px-3 py-1 text-xs text-white bg-danger-400 rounded-full font-aumovio-bold" style={{ animation: "err-pulse-op 1.5s ease-in-out infinite" }}>
                SIGNATURE MISMATCH
            </div>
        </div>
    );
}

/* ─── Default exports (named) ─── */
export default {
    Unauthorized,
    BadRequest,
    PageNotFound,
    LoginTimeOut,
    InvalidToken,
    ServiceUnavailable,
    SignatureMismatch,
};
