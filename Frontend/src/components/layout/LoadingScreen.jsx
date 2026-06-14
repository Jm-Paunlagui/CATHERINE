import { memo, useEffect, useRef, useState } from "react";

// ─── Static constants ─────────────────────────────────────────────────────────
const RING_DELAYS = [0, 0.6, 1.2];
const BOUNCE_DOTS = [0, 0.18, 0.36, 0.54, 0.72];
const ORANGE = "#FF4208";
const PURPLE = "#4827AF";
const SLIDE_STYLE = { transition: "opacity 0.4s ease, transform 0.4s ease" };
const INTERVAL_MS = 1200;
const FADE_MS = 400;

// ─── Paired content ───────────────────────────────────────────────────────────
const TITLES = [
    { prefix: "Keeping", highlight: "you", suffix: "protected" },
    { prefix: "Guarding", highlight: "your", suffix: "session" },
    { prefix: "Making sure", highlight: "everything", suffix: "is secure" },
    { prefix: "Loading", highlight: "fast", suffix: "for you" },
    { prefix: "Optimizing", highlight: "your", suffix: "experience" },
    { prefix: "Getting", highlight: "everything", suffix: "up to speed" },
    { prefix: "Building", highlight: "a stable", suffix: "foundation" },
    { prefix: "Making", highlight: "everything", suffix: "rock solid" },
    { prefix: "Ensuring", highlight: "reliable", suffix: "uptime" },
    { prefix: "Keeping", highlight: "your data", suffix: "private" },
    { prefix: "Making sure", highlight: "your info", suffix: "stays yours" },
    { prefix: "Protecting", highlight: "your", suffix: "privacy" },
    { prefix: "Setting up", highlight: "your", suffix: "safe space" },
    { prefix: "Almost", highlight: "ready", suffix: "for you" },
    { prefix: "Putting", highlight: "the final", suffix: "touches" },
];

const SUBTITLES = [
    "Your session is being carefully secured. This will only take a moment.",
    "We're watching over your connection so nothing gets through uninvited.",
    "Running checks in the background to make sure everything is airtight.",
    "We're getting things ready as quickly as possible — almost there.",
    "Fine-tuning the experience so everything feels smooth from the start.",
    "Spinning up resources so you hit the ground running.",
    "Laying the groundwork so your session stays solid from start to finish.",
    "Making sure nothing wobbles — your session deserves a strong base.",
    "Checking that all systems are stable and ready to go.",
    "Your information stays with you — we make sure of that every time.",
    "We never share what's yours. Setting up with your privacy in mind.",
    "Everything you do here stays protected. That's a promise, not a feature.",
    "We're setting things up safely so you can work with confidence.",
    "Sit tight — we're putting the last pieces in place just for you.",
    "One last look to make sure everything is perfect before we let you in.",
];

// ─── Keyframes (injected once) ────────────────────────────────────────────────
const KEYFRAMES = `
  @keyframes bounceDot {
    0%, 100% { transform: translateY(0); opacity: 0.5; }
    30%       { transform: translateY(-8px); opacity: 1; }
    60%       { transform: translateY(0); opacity: 0.5; }
  }
  @keyframes rotateSlow {
    to { transform: rotate(360deg); }
  }
  @keyframes shieldPulse {
    0%, 100% { transform: scale(1); filter: drop-shadow(0 0 6px rgba(255,66,8,0.4)); }
    50%       { transform: scale(1.06); filter: drop-shadow(0 0 14px rgba(255,66,8,0.7)); }
  }
  @keyframes expandRing {
    0%   { opacity: 0.4; transform: translate(-50%, -50%) scale(0.7); }
    100% { opacity: 0;   transform: translate(-50%, -50%) scale(1.15); }
  }
`;

let keyframesInjected = false;
function injectKeyframes() {
    if (keyframesInjected) return;
    keyframesInjected = true;
    const style = document.createElement("style");
    style.textContent = KEYFRAMES;
    document.head.appendChild(style);
}

// ─── Hooks ────────────────────────────────────────────────────────────────────
function shuffle(length) {
    const arr = Array.from({ length }, (_, i) => i);
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function useShuffleIndices(titleLen, subtitleLen) {
    const tQueue = useRef(shuffle(titleLen));
    const tPos = useRef(0);
    const sQueue = useRef(shuffle(subtitleLen));
    const sPos = useRef(0);

    const [titleIdx, setTitleIdx] = useState(() => tQueue.current[0]);
    const [subtitleIdx, setSubtitleIdx] = useState(() => sQueue.current[0]);
    const [visible, setVisible] = useState(true);

    useEffect(() => {
        const timer = setInterval(() => {
            setVisible(false);
            setTimeout(() => {
                tPos.current += 1;
                if (tPos.current >= titleLen) {
                    tQueue.current = shuffle(titleLen);
                    tPos.current = 0;
                }
                sPos.current += 1;
                if (sPos.current >= subtitleLen) {
                    sQueue.current = shuffle(subtitleLen);
                    sPos.current = 0;
                }
                setTitleIdx(tQueue.current[tPos.current]);
                setSubtitleIdx(sQueue.current[sPos.current]);
                setVisible(true);
            }, FADE_MS);
        }, INTERVAL_MS);

        return () => clearInterval(timer);
    }, [titleLen, subtitleLen]);

    return { titleIdx, subtitleIdx, visible };
}

// ─── Sub-components ───────────────────────────────────────────────────────────
const ShieldCheck = memo(() => (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 2L4 5v6c0 5.25 3.5 10.15 8 11.35C16.5 21.15 20 16.25 20 11V5l-8-3z" fill={ORANGE} />
        <path d="M9 12l2 2 4-4" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
));
ShieldCheck.displayName = "ShieldCheck";

const OrbitingShield = memo(() => (
    <div className="relative mb-10" style={{ width: 88, height: 88 }}>
        {RING_DELAYS.map((delay, i) => (
            <div
                key={delay}
                style={{
                    position: "absolute",
                    top: "50%",
                    left: "50%",
                    width: 88 + i * 60,
                    height: 88 + i * 60,
                    borderRadius: "50%",
                    border: `1px solid rgba(255,66,8,${0.12 - i * 0.03})`,
                    transform: "translate(-50%, -50%)",
                    animation: `expandRing 3.5s ${delay}s ease-out infinite`,
                    pointerEvents: "none",
                }}
            />
        ))}
        <div
            style={{
                position: "absolute",
                inset: 0,
                borderRadius: "50%",
                border: "1.5px solid rgba(72,39,175,0.5)",
                animation: "rotateSlow 8s linear infinite",
            }}
        >
            <div
                style={{
                    position: "absolute",
                    top: -4,
                    left: "50%",
                    transform: "translateX(-50%)",
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: ORANGE,
                    boxShadow: "0 0 8px rgba(255,66,8,0.8)",
                }}
            />
        </div>
        <div
            className="absolute inset-0 flex items-center justify-center"
            style={{
                margin: 12,
                borderRadius: "50%",
                background: "rgba(72,39,175,0.15)",
                border: "1px solid rgba(72,39,175,0.35)",
                animation: "shieldPulse 2.4s ease-in-out infinite",
            }}
        >
            <ShieldCheck />
        </div>
    </div>
));
OrbitingShield.displayName = "OrbitingShield";

// ─── Main Component ───────────────────────────────────────────────────────────
const LoadingScreen = memo(() => {
    useEffect(() => {
        injectKeyframes();
    }, []);

    const { titleIdx, subtitleIdx, visible } = useShuffleIndices(TITLES.length, SUBTITLES.length);
    const { prefix, highlight, suffix } = TITLES[titleIdx];

    const fadeStyle = {
        ...SLIDE_STYLE,
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(6px)",
    };

    return (
        <div className="flex justify-center min-h-screen overflow-hidden font-aumovio animate-fade-in" style={{ background: "linear-gradient(135deg, #0f0c1a 0%, #1a1030 50%, #0d0d14 100%)", color: "#FFFFFF" }}>
            <div className="flex flex-col items-center justify-center text-center animate-scale-in-center">
                <OrbitingShield />

                {/* Title */}
                <p className="mb-16 text-3xl font-extrabold xl:text-6xl drop-shadow-lg" style={{ ...fadeStyle, minHeight: "4.5rem", display: "flex", alignItems: "center", justifyContent: "center", gap: "0.35em" }}>
                    {prefix} <span style={{ color: ORANGE }}>{highlight}</span> {suffix}
                </p>

                {/* Subtitle */}
                <p className="mb-8 text-base xl:text-xl font-aumovio" style={{ ...fadeStyle, maxWidth: 440, color: "rgba(255,255,255,0.55)", minHeight: "3rem" }}>
                    {SUBTITLES[subtitleIdx]}
                </p>

                <div
                    className="mb-8 rounded-full"
                    style={{
                        width: 160,
                        height: 2,
                        background: `linear-gradient(to right, ${ORANGE}, ${PURPLE})`,
                        opacity: 0.7,
                    }}
                />

                <div className="flex gap-2 mt-2">
                    {BOUNCE_DOTS.map((delay, i) => (
                        <div
                            key={delay}
                            style={{
                                width: 8,
                                height: 8,
                                borderRadius: "50%",
                                background: i % 2 === 0 ? ORANGE : PURPLE,
                                animation: `bounceDot 1.2s ${delay}s infinite`,
                            }}
                        />
                    ))}
                </div>
            </div>
        </div>
    );
});
LoadingScreen.displayName = "LoadingScreen";

export default LoadingScreen;
